export interface ActiveChatRequestSnapshot {
  sessionId: string;
  responseId: string | null;
  gatewayUrl: string;
  startedAt: number;
}

export interface ActiveChatRequest extends ActiveChatRequestSnapshot {
  readonly signal: AbortSignal;
  close: () => void;
}

/** Owns the in-flight request for each session within one sidecar server. */
export class ChatRequestRegistry {
  private readonly active = new Map<string, ActiveChatRequest>();

  begin(sessionId: string, gatewayUrl: string): ActiveChatRequest | null {
    if (this.active.has(sessionId)) return null;

    const controller = new AbortController();
    const request: ActiveChatRequest = {
      sessionId,
      responseId: null,
      gatewayUrl,
      startedAt: Date.now(),
      signal: controller.signal,
      close: () => controller.abort(),
    };
    this.active.set(sessionId, request);
    return request;
  }

  finish(request: ActiveChatRequest): void {
    if (this.active.get(request.sessionId) === request) {
      this.active.delete(request.sessionId);
    }
  }

  cancel(sessionId: string): boolean {
    const request = this.active.get(sessionId);
    if (!request) return false;
    request.close();
    return true;
  }

  cancelAll(): void {
    for (const request of this.active.values()) request.close();
  }

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  get size(): number {
    return this.active.size;
  }

  sessionIds(): string[] {
    return Array.from(this.active.keys());
  }

  snapshots(): ActiveChatRequestSnapshot[] {
    return Array.from(this.active.values()).map((request) => ({
      sessionId: request.sessionId,
      responseId: request.responseId,
      gatewayUrl: request.gatewayUrl,
      startedAt: request.startedAt,
    }));
  }
}
