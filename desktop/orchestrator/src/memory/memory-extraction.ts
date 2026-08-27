import {
  ChatStore,
  type ChatMessageRecord,
  type MemoryExtractionDiagnostics,
} from '../chat/chat-store.ts';
import type { MemoryProvider } from './memory-provider.ts';

const DEFAULT_IDLE_THRESHOLD_MS = 2 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_STALE_RUNNING_MS = 10 * 60 * 1000;
const MAX_EXTRACTION_MESSAGES = 80;

export class MemoryExtractionScheduler {
  private readonly store: ChatStore;
  private readonly provider: MemoryProvider;
  private readonly idleThresholdMs: number;
  private readonly pollIntervalMs: number;
  private readonly staleRunningMs: number;
  private readonly extractionGate: () => boolean;
  private readonly enabledFn: () => boolean;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    store: ChatStore,
    provider: MemoryProvider,
    opts: {
      idleThresholdMs?: number;
      pollIntervalMs?: number;
      staleRunningMs?: number;
      /**
       * When false, due sessions stay pending instead of being claimed —
       * claiming while the provider can't accept writes would burn the
       * attempt instead of just waiting.
       */
      extractionGate?: () => boolean;
      enabled?: () => boolean;
    } = {},
  ) {
    this.store = store;
    this.provider = provider;
    this.extractionGate = opts.extractionGate ?? (() => true);
    this.enabledFn = opts.enabled ?? (() => this.provider.diagnostics().enabled);
    this.idleThresholdMs = opts.idleThresholdMs ?? readDurationEnv(
      'VERSO_MEMORY_IDLE_MS',
      DEFAULT_IDLE_THRESHOLD_MS,
    );
    this.pollIntervalMs = opts.pollIntervalMs ?? readDurationEnv(
      'VERSO_MEMORY_POLL_MS',
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.staleRunningMs = opts.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  }

  get enabled(): boolean {
    return this.enabledFn();
  }

  markPending(sessionId: string): void {
    if (!this.enabled) return;
    this.store.markMemoryExtractionPending(sessionId);
    this.start();
  }

  start(): void {
    if (!this.enabled || this.interval) return;
    this.store.resetStaleRunningMemoryExtractions(this.staleRunningMs);
    this.interval = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.warn(`[memory] extraction scheduler failed: ${formatError(error)}`);
      });
    }, this.pollIntervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  diagnostics(): MemoryExtractionDiagnostics {
    return this.store.getMemoryExtractionDiagnostics(this.enabled, this.idleThresholdMs);
  }

  async tick(now = new Date()): Promise<void> {
    if (!this.enabled || this.running) return;
    if (!this.extractionGate()) return;
    this.running = true;
    try {
      const claim = this.store.claimDueMemoryExtraction(this.idleThresholdMs, now);
      if (!claim) return;

      const messages = this.store.getMessagesForMemoryExtraction(
        claim.session.id,
        claim.state.lastExtractedMessageId,
      );
      if (messages.length === 0) {
        this.store.failMemoryExtraction(claim.session.id, 'No unextracted messages found for claimed session.');
        return;
      }

      const segment = messages.slice(-MAX_EXTRACTION_MESSAGES);
      const lastMessage = segment.at(-1);
      if (!lastMessage) return;

      try {
        await this.provider.ingestChatSegment({
          sourceRef: `verso-chat-${claim.session.id}-${lastMessage.id}`,
          sessionId: claim.session.id,
          title: claim.session.title,
          messages: toSignalMessages(segment),
          occurredAt: lastMessage.createdAt,
        });
        this.store.completeMemoryExtraction(claim.session.id, lastMessage.id);
      } catch (error: unknown) {
        this.store.failMemoryExtraction(claim.session.id, formatError(error));
        console.warn(`[memory] chat ingestion failed for session ${claim.session.id}: ${formatError(error)}`);
      }
    } finally {
      this.running = false;
    }
  }
}

function toSignalMessages(
  messages: ChatMessageRecord[],
): Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }));
}

function readDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
