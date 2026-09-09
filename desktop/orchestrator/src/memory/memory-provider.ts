import type { ChatMessageRecord } from '../chat/chat-store.ts';
import type { IngestionDocument } from './ingestion/ingestion-source.ts';

export type MemoryBackend = 'lexical';

export type MemoryRuntimeState = 'idle' | 'disabled' | 'ready' | 'error';

export interface MemoryProviderCapabilities {
  search: true;
  getPage: boolean;
  bridgeWrites: boolean;
}

export interface MemoryDiagnostics {
  enabled: boolean;
  state: MemoryRuntimeState;
  backend: MemoryBackend;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface MemorySearchResult {
  slug: string | null;
  title: string | null;
  score?: number;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchScope {
  source?: string;
  stream?: string;
}

export interface MemoryPage {
  slug: string | null;
  title?: string | null;
  content?: string | null;
  [key: string]: unknown;
}

export interface MemoryProvider {
  readonly backend: MemoryBackend;
  readonly capabilities: MemoryProviderCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  getState(): MemoryRuntimeState;
  diagnostics(): MemoryDiagnostics;

  /**
   * Stable id of the physical store instance; changes only when the underlying
   * store is recreated (fresh file, path change, manual wipe). Null when the
   * store isn't ready. Lets ingestion detect a reset and rebuild the corpus.
   */
  instanceToken?(): string | null;

  search(query: string, limit: number, scope?: MemorySearchScope): Promise<MemorySearchResult[]>;
  getPage?(slug: string): Promise<MemoryPage | null>;

  ingestChatSegment(segment: {
    sourceRef: string;
    sessionId: string;
    title: string;
    messages: Array<Pick<ChatMessageRecord, 'role' | 'content' | 'createdAt'>>;
    occurredAt?: string;
  }): Promise<void>;

  ingestSourceBatch(batch: {
    source: string;
    stream: string;
    items: IngestionDocument[];
  }): Promise<void>;

  /** Delete passive documents for one connected source. Curated pages are never affected. */
  deleteSourceDocuments?(source: string): Promise<{ source: string; documentsDeleted: number }>;
  /** Delete one passive document by its stable source identity. */
  deleteDocument?(source: string, sourceRef: string): Promise<boolean>;
}

export interface MemoryWriteProvider extends MemoryProvider {
  capabilities: { search: true; getPage: true; bridgeWrites: true };
  putPage(slug: string, content: string): Promise<unknown>;
}
