import { dirname, join } from 'node:path';

/**
 * Local text embedder for hybrid memory retrieval, via transformers.js
 * (ONNX runtime, in-process — no child process, no server). The model is
 * downloaded once from the HF hub into a cache dir that survives app
 * updates, then loads from disk.
 *
 * Cardinal rule: embeddings must NEVER gate memory reads or writes. This
 * runtime therefore never throws from
 * start(), and callers treat "not ready" as "BM25-only for now".
 *
 * Default model: multilingual-e5-small — 384 dims, strong Spanish↔English
 * paraphrase recall (the two known BM25 blind spots), ~120MB quantized.
 * E5 models expect "query: " / "passage: " prefixes; embedQuery/embedPassages
 * apply them.
 */

export type EmbedderState = 'idle' | 'disabled' | 'loading' | 'ready' | 'error';

export interface EmbedderConfig {
  enabled: boolean;
  modelId: string;
  cacheDir: string;
}

/** The slice the memory provider needs; tests inject a deterministic fake. */
export interface EmbedderLike {
  readonly modelId: string;
  start(): Promise<void>;
  isReady(): boolean;
  getState(): EmbedderState;
  diagnostics(): Record<string, unknown>;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
}

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';

export function resolveEmbedderConfig(
  hermesHome: string,
  env: NodeJS.ProcessEnv = process.env,
): EmbedderConfig {
  const raw = env.VERSO_EMBEDDINGS_ENABLED?.trim().toLowerCase();
  const enabled = raw ? !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') : true;
  return {
    enabled,
    modelId: env.VERSO_EMBEDDINGS_MODEL?.trim() || DEFAULT_MODEL,
    // Sibling of the Hermes home, same convention as the memory DB.
    cacheDir: env.VERSO_EMBEDDINGS_CACHE_DIR?.trim()
      || join(dirname(hermesHome), 'models', 'transformers-cache'),
  };
}

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>;

export class LocalEmbedder implements EmbedderLike {
  readonly modelId: string;

  private readonly config: EmbedderConfig;
  private state: EmbedderState = 'idle';
  private lastError: string | null = null;
  private extractor: FeatureExtractor | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(config: EmbedderConfig) {
    this.config = config;
    this.modelId = config.modelId;
  }

  /** Idempotent background start; never throws. First run downloads the model. */
  start(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      return Promise.resolve();
    }
    if (this.extractor) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.state = 'loading';
    this.startPromise = this.startInner()
      .catch((error: unknown) => {
        this.state = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[memory] embedder failed to load (${this.modelId}): ${this.lastError}`);
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  private async startInner(): Promise<void> {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = this.config.cacheDir;
    const extractor = await pipeline('feature-extraction', this.modelId, { dtype: 'q8' });
    this.extractor = extractor as unknown as FeatureExtractor;
    this.state = 'ready';
    console.log(`[memory] embedder ready (${this.modelId})`);
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  getState(): EmbedderState {
    return this.state;
  }

  diagnostics(): Record<string, unknown> {
    return {
      state: this.state,
      modelId: this.modelId,
      cacheDir: this.config.cacheDir,
      lastError: this.lastError,
    };
  }

  embedQuery(text: string): Promise<Float32Array> {
    return this.embed([`query: ${text}`]).then((vectors) => vectors[0]);
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts.map((text) => `passage: ${text}`));
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) {
      throw new Error(`Embedder is not ready (state: ${this.state})`);
    }
    if (texts.length === 0) return [];
    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });
    const [rows, dims] = [output.dims[0], output.dims[output.dims.length - 1]];
    const vectors: Float32Array[] = [];
    for (let i = 0; i < rows; i += 1) {
      vectors.push(output.data.slice(i * dims, (i + 1) * dims));
    }
    return vectors;
  }
}
