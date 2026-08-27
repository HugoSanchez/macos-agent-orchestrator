import { describe, expect, it } from 'vitest';
import { MemoryExtractionScheduler } from '../src/memory/memory-extraction.ts';
import type { ChatStore } from '../src/chat/chat-store.ts';
import type { MemoryProvider } from '../src/memory/memory-provider.ts';

/**
 * The extraction gate defers claiming while the provider can't accept writes
 * (e.g. the store hasn't opened yet). Deferred sessions stay pending and are
 * claimed on a later tick once the gate opens.
 */
describe('MemoryExtractionScheduler extraction gate', () => {
  function makeStore(): { store: ChatStore; claims: number } {
    const counter = { store: null as unknown as ChatStore, claims: 0 };
    counter.store = {
      claimDueMemoryExtraction: () => {
        counter.claims += 1;
        return null; // nothing due — we only care whether claiming was attempted
      },
    } as unknown as ChatStore;
    return counter;
  }

  function fakeProvider(): MemoryProvider {
    return {
      backend: 'lexical',
      capabilities: { search: true, getPage: true, bridgeWrites: true },
      start: async () => undefined,
      stop: async () => undefined,
      isReady: () => true,
      getState: () => 'ready',
      diagnostics: () => ({ enabled: true, state: 'ready', backend: 'lexical' }),
      search: async () => [],
      getPage: async () => null,
      ingestChatSegment: async () => undefined,
      ingestSourceBatch: async () => undefined,
    };
  }

  it('does not claim while the gate is closed', async () => {
    const counter = makeStore();
    let gateOpen = false;
    const scheduler = new MemoryExtractionScheduler(
      counter.store,
      fakeProvider(),
      { extractionGate: () => gateOpen },
    );

    await scheduler.tick();
    expect(counter.claims).toBe(0);

    gateOpen = true;
    await scheduler.tick();
    expect(counter.claims).toBe(1);
  });

  it('claims by default when no gate is provided', async () => {
    const counter = makeStore();
    const scheduler = new MemoryExtractionScheduler(counter.store, fakeProvider());

    await scheduler.tick();
    expect(counter.claims).toBe(1);
  });
});
