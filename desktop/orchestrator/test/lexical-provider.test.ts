import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { EmbedderLike, EmbedderState } from '../src/http/embedder.ts';
import { buildFtsMatchExpression, isChatCaptureEnabled, LexicalMemoryProvider } from '../src/http/lexical-provider.ts';
import { buildMemoryRoutes } from '../src/http/memory-routes.ts';
import type { Route } from '../src/http/router.ts';

let tempRoot = '';
let provider: LexicalMemoryProvider;

beforeEach(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-lexical-test-'));
  provider = new LexicalMemoryProvider({
    enabled: true,
    dbPath: path.join(tempRoot, 'memory', 'verso-memory.db'),
  });
  await provider.start();
});

afterEach(async () => {
  await provider.stop();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('LexicalMemoryProvider pages', () => {
  it('roundtrips put/get and derives the title from the first heading', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nMet at the conference.');

    const page = await provider.getPage('people/jane-doe');
    expect(page).toMatchObject({
      slug: 'people/jane-doe',
      title: 'Jane Doe',
      content: '# Jane Doe\n\nMet at the conference.',
    });
  });

  it('upsert updates content and updated_at but keeps created_at', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nv1');
    const first = await provider.getPage('people/jane-doe');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nv2');
    const second = await provider.getPage('people/jane-doe');

    expect(second!.content).toContain('v2');
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(String(second!.updatedAt) >= String(first!.updatedAt)).toBe(true);
  });

  it('falls back to fuzzy slug lookup', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe');

    expect((await provider.getPage('People/Jane Doe'))?.slug).toBe('people/jane-doe');
    expect((await provider.getPage('jane-doe'))?.slug).toBe('people/jane-doe');
    expect(await provider.getPage('nobody-here')).toBeNull();
  });
});

describe('LexicalMemoryProvider ingestion', () => {
  const segment = {
    sourceRef: 'verso-chat-sess1-42',
    sessionId: 'sess1',
    title: 'Acme kickoff',
    messages: [
      { role: 'user' as const, content: 'I met Sarah Chen from Acme Corp today.', createdAt: '2026-07-01T10:00:00.000Z' },
      { role: 'assistant' as const, content: 'Noted — Acme Corp is evaluating Verso.', createdAt: '2026-07-01T10:00:05.000Z' },
    ],
  };

  it('indexes chat segments and finds them via search', async () => {
    await provider.ingestChatSegment(segment);

    const results = await provider.search('Sarah Chen Acme', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toMatch(/^doc:\d+$/);
    expect(results[0].snippet).toContain('Sarah Chen');
  });

  it('does not duplicate re-ingested chat segments', async () => {
    await provider.ingestChatSegment(segment);
    await provider.ingestChatSegment(segment);

    expect(provider.diagnostics().documents).toBe(1);
  });

  it('dedups source batches on (source, source_ref)', async () => {
    const batch = {
      source: 'gmail',
      stream: '',
      items: [
        { sourceRef: 'm_1', occurredAt: '2026-07-01T09:00:00.000Z', content: 'Subject: Renewal\n\nAcme renewal terms attached.' },
        { sourceRef: 'm_2', occurredAt: '2026-07-02T09:00:00.000Z', content: 'Subject: Lunch\n\nSee you at noon.' },
      ],
    };
    await provider.ingestSourceBatch(batch);
    await provider.ingestSourceBatch(batch);

    expect(provider.diagnostics().documents).toBe(2);
    const results = await provider.search('Acme renewal', 5);
    expect(results).toHaveLength(1);
  });

  it('keeps newest-first provider pages chronological when requested', async () => {
    const base = { source: 'teams', stream: '' };
    await provider.ingestSourceBatch({
      ...base,
      items: [
        { sourceRef: 'chat:one#2026-07-01', content: '[10:20] Alice: later', merge: true, mergeOrder: 'chronological' },
        { sourceRef: 'chat:one#2026-07-01', content: '[10:10] Bob: middle', merge: true, mergeOrder: 'chronological' },
      ],
    });
    await provider.ingestSourceBatch({
      ...base,
      items: [
        { sourceRef: 'chat:one#2026-07-01', content: '[09:40] Alice: earlier', merge: true, mergeOrder: 'chronological' },
        { sourceRef: 'chat:one#2026-07-01', content: '[10:30] Bob: newest', merge: true, mergeOrder: 'chronological' },
      ],
    });

    const [hit] = await provider.search('earlier middle later newest', 1);
    const page = await provider.getPage(hit.slug!);
    expect(page?.content).toBe([
      '[09:40] Alice: earlier',
      '[10:10] Bob: middle',
      '[10:20] Alice: later',
      '[10:30] Bob: newest',
    ].join('\n'));
  });

  it('reads raw documents via doc:<id> slugs', async () => {
    await provider.ingestChatSegment(segment);
    const [hit] = await provider.search('Sarah Chen', 1);

    const page = await provider.getPage(hit.slug!);
    expect(page).toMatchObject({ slug: hit.slug, source: 'chat', stream: 'sess1' });
    expect(page!.content).toContain('Sarah Chen');
  });
});

describe('LexicalMemoryProvider search ranking', () => {
  it('ranks a curated page above a raw document for the same terms', async () => {
    await provider.ingestChatSegment({
      sourceRef: 'seg-1',
      sessionId: 'sess1',
      title: 'chat',
      messages: [{ role: 'user', content: 'Project Atlas deadline is in March.', createdAt: '2026-07-01T10:00:00.000Z' }],
    });
    await provider.putPage('projects/atlas', '# Project Atlas\n\nDeadline: March. Owner: Jane.');

    const results = await provider.search('Project Atlas deadline', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].slug).toBe('projects/atlas');
  });

  it('caps results at the requested limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await provider.putPage(`notes/note-${i}`, `# Note ${i}\n\nkiwi banana ${i}`);
    }
    expect(await provider.search('kiwi banana', 3)).toHaveLength(3);
  });
});

describe('FTS5 query sanitization', () => {
  it.each([
    '"quoted phrase"',
    '-dash -leading',
    "who's asking?",
    'NEAR AND OR NOT',
    'emoji 🚀 query',
    'unbalanced "quote',
    'colon:value AND (parens)',
  ])('never throws for %s', async (query) => {
    await provider.putPage('misc/test', '# Test\n\nquoted phrase who asking near emoji query colon value parens');
    await expect(provider.search(query, 5)).resolves.toBeDefined();
  });

  it('returns no results (not an error) for symbol-only queries', async () => {
    expect(buildFtsMatchExpression('!!! ???')).toBeNull();
    expect(await provider.search('!!! ???', 5)).toEqual([]);
  });
});

/**
 * Deterministic fake embedder: maps texts onto a tiny concept space so
 * "TPS" and "throughput" land on the same axis without any real model.
 * Vectors are unit-normalized like the real embedder's.
 */
function fakeEmbedder(opts: { ready?: boolean; failQueries?: boolean } = {}): EmbedderLike & { embedCalls: string[][] } {
  const CONCEPTS: Record<string, number> = {
    tps: 0, throughput: 0, speed: 0,
    lunch: 1, restaurant: 1, comida: 1,
    atlas: 2,
  };
  const embed = (text: string): Float32Array => {
    const v = new Float32Array(3);
    for (const token of text.toLowerCase().match(/[a-zá-ú]+/g) ?? []) {
      if (token in CONCEPTS) v[CONCEPTS[token]] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm) as Float32Array;
  };
  const ready = opts.ready ?? true;
  return {
    modelId: 'fake-e5',
    embedCalls: [],
    start: async () => undefined,
    isReady: () => ready,
    getState: (): EmbedderState => (ready ? 'ready' : 'loading'),
    diagnostics: () => ({ state: ready ? 'ready' : 'loading', modelId: 'fake-e5' }),
    async embedQuery(text) {
      if (opts.failQueries) throw new Error('embed boom');
      return embed(text);
    },
    async embedPassages(texts) {
      this.embedCalls.push(texts);
      return texts.map(embed);
    },
  };
}

describe('hybrid retrieval (embeddings)', () => {
  async function hybridProvider(opts: Parameters<typeof fakeEmbedder>[0] = {}) {
    const embedder = fakeEmbedder(opts);
    const p = new LexicalMemoryProvider(
      { enabled: true, dbPath: path.join(tempRoot, 'hybrid.db') },
      { embedder },
    );
    await p.start();
    return { p, embedder };
  }

  it('finds paraphrases BM25 misses once vectors are backfilled', async () => {
    const { p } = await hybridProvider();
    await p.putPage('projects/proving-tps', '# Proving TPS\n\nWe need higher TPS on the prover.');
    await p.putPage('places/lunch-spot', '# Lunch spot\n\nGreat restaurant nearby.');
    await p.runEmbeddingBackfill();

    // "throughput" appears in neither page — BM25 alone returns nothing.
    const results = await p.search('throughput speed', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('projects/proving-tps');
    // Vector-only hits still carry display data.
    expect(results[0].title).toBe('Proving TPS');
    expect(results[0].snippet).toContain('Proving TPS');
    await p.stop();
  });

  it('fuses BM25 and vector ranks (exact term match still wins)', async () => {
    const { p } = await hybridProvider();
    await p.putPage('projects/atlas', '# Atlas\n\nProject Atlas kickoff notes.');
    await p.putPage('projects/proving-tps', '# Proving TPS\n\nHigher TPS.');
    await p.runEmbeddingBackfill();

    const results = await p.search('atlas', 5);
    expect(results[0].slug).toBe('projects/atlas');
    await p.stop();
  });

  it('re-embeds a page after its content changes', async () => {
    const { p, embedder } = await hybridProvider();
    await p.putPage('a/b', '# B\n\nfirst version');
    expect(await p.runEmbeddingBackfill()).toBe(1);
    expect(await p.runEmbeddingBackfill()).toBe(0); // stable — nothing stale

    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct updated_at stamp
    await p.putPage('a/b', '# B\n\nsecond version');
    expect(await p.runEmbeddingBackfill()).toBe(1); // stamp changed → re-embed
    expect(embedder.embedCalls).toHaveLength(2);
    await p.stop();
  });

  it('embeds ingested documents too, and re-embeds after an upsert', async () => {
    const { p } = await hybridProvider();
    const batch = (content: string) => ({
      source: 'gdrive',
      stream: '',
      items: [{ sourceRef: 'file-1', occurredAt: '2026-07-01T00:00:00.000Z', title: 'Doc', content }],
    });
    await p.ingestSourceBatch(batch('v1 throughput'));
    expect(await p.runEmbeddingBackfill()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct updated_at stamp
    await p.ingestSourceBatch(batch('v2 throughput'));
    expect(await p.runEmbeddingBackfill()).toBe(1);
    expect(p.diagnostics()).toMatchObject({ documents: 1, embeddedRows: 1 });
    await p.stop();
  });

  it('is BM25-only while the embedder is not ready — never blocks', async () => {
    const { p } = await hybridProvider({ ready: false });
    await p.putPage('projects/proving-tps', '# Proving TPS\n\nHigher TPS.');
    expect(await p.runEmbeddingBackfill()).toBe(0); // no-op, not an error

    expect((await p.search('tps', 5))[0].slug).toBe('projects/proving-tps'); // exact term works
    expect(await p.search('throughput', 5)).toEqual([]); // paraphrase miss expected
    await p.stop();
  });

  it('falls back to BM25 when query embedding fails', async () => {
    const { p } = await hybridProvider({ failQueries: true });
    await p.putPage('projects/proving-tps', '# Proving TPS\n\nHigher TPS.');
    await p.runEmbeddingBackfill();

    const results = await p.search('tps', 5);
    expect(results[0].slug).toBe('projects/proving-tps');
    await p.stop();
  });

  it('chunks long content into multiple vectors', async () => {
    const { p, embedder } = await hybridProvider();
    await p.putPage('long/page', `# Long\n\n${'atlas '.repeat(1200)}`); // ~7k chars
    await p.runEmbeddingBackfill();

    expect(embedder.embedCalls[0].length).toBeGreaterThan(1);
    const results = await p.search('atlas', 5);
    expect(results[0].slug).toBe('long/page'); // best-chunk-per-row, no duplicates
    expect(results).toHaveLength(1);
    await p.stop();
  });
});

describe('lifecycle & diagnostics', () => {
  it('reports disabled when memory is off', async () => {
    const off = new LexicalMemoryProvider({ enabled: false, dbPath: path.join(tempRoot, 'off.db') });
    await off.start();
    expect(off.getState()).toBe('disabled');
    expect(off.isReady()).toBe(false);
    expect(off.diagnostics()).toMatchObject({ enabled: false, backend: 'lexical' });
  });

  it('persists across a stop/start cycle', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nDurable.');
    await provider.stop();
    await provider.start();

    expect((await provider.getPage('people/jane-doe'))?.content).toContain('Durable');
  });

  it('counts pages and documents in diagnostics', async () => {
    await provider.putPage('a/b', '# B');
    await provider.ingestSourceBatch({
      source: 'slack',
      stream: 's',
      items: [{ sourceRef: 'r1', content: 'hello' }],
    });

    expect(provider.diagnostics()).toMatchObject({
      enabled: true,
      state: 'ready',
      backend: 'lexical',
      pages: 1,
      documents: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Routes against the real provider
// ---------------------------------------------------------------------------

interface FakeResponse {
  status: number | null;
  body: unknown;
}

function fakeRes(): { res: ServerResponse; out: FakeResponse } {
  const out: FakeResponse = { status: null, body: null };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body?: string) {
      out.body = body ? JSON.parse(body) : null;
    },
    setHeader() { /* noop */ },
  } as unknown as ServerResponse;
  return { res, out };
}

async function callRoute(routes: Route[], method: string, routePath: string, body: unknown): Promise<FakeResponse> {
  const matched = routes.find((r) => r.method === method && r.pattern.test(routePath));
  if (!matched) throw new Error(`No route for ${method} ${routePath}`);
  const { res, out } = fakeRes();
  await matched.handler({} as never, res, {}, body);
  return out;
}

describe('memory routes', () => {
  it('GET /memory/status reports diagnostics and capabilities', async () => {
    const out = await callRoute(buildMemoryRoutes(provider), 'GET', '/memory/status', null);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      state: 'ready',
      enabled: true,
      backend: 'lexical',
      capabilities: { search: true, getPage: true, bridgeWrites: true },
    });
  });

  it('POST /memory/write-page then /memory/search then /memory/page roundtrip', async () => {
    const routes = buildMemoryRoutes(provider);

    const write = await callRoute(routes, 'POST', '/memory/write-page', {
      slug: 'people/jane-doe',
      content: '# Jane Doe\n\nMet at the conference.',
    });
    expect(write.status).toBe(200);

    const search = await callRoute(routes, 'POST', '/memory/search', { query: 'Jane conference' });
    expect(search.status).toBe(200);
    const results = (search.body as { results: Array<{ slug: string }> }).results;
    expect(results[0].slug).toBe('people/jane-doe');

    const page = await callRoute(routes, 'POST', '/memory/page', { slug: 'people/jane-doe' });
    expect(page.status).toBe(200);
    expect((page.body as { page: { content: string } }).page.content).toContain('conference');
  });

  it('validates required fields', async () => {
    const routes = buildMemoryRoutes(provider);
    expect((await callRoute(routes, 'POST', '/memory/search', { limit: 3 })).status).toBe(400);
    expect((await callRoute(routes, 'POST', '/memory/page', {})).status).toBe(400);
    expect((await callRoute(routes, 'POST', '/memory/write-page', { slug: 'x' })).status).toBe(400);
  });

  it('returns 503 while the provider is not ready', async () => {
    const cold = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(tempRoot, 'cold.db') });
    const out = await callRoute(buildMemoryRoutes(cold), 'POST', '/memory/search', { query: 'x' });

    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: 'memory_unavailable' });
  });

  it('does not register the retired link/timeline/ingest-log routes', () => {
    const routes = buildMemoryRoutes(provider);
    for (const retired of ['/memory/link', '/memory/timeline', '/memory/ingest-log']) {
      expect(routes.find((r) => r.pattern.test(retired))).toBeUndefined();
    }
  });
});

describe('LexicalMemoryProvider instance token', () => {
  it('is stable across reopens of the same file but differs for a fresh file', async () => {
    const token = provider.instanceToken();
    expect(token).toBeTruthy();

    // Closed store has no token.
    await provider.stop();
    expect(provider.instanceToken()).toBeNull();

    // Reopening the same file recovers the same token.
    const reopened = new LexicalMemoryProvider({
      enabled: true,
      dbPath: path.join(tempRoot, 'memory', 'verso-memory.db'),
    });
    await reopened.start();
    expect(reopened.instanceToken()).toBe(token);
    await reopened.stop();

    // A different file mints a different token — this is what signals a reset.
    const fresh = new LexicalMemoryProvider({
      enabled: true,
      dbPath: path.join(tempRoot, 'memory2', 'verso-memory.db'),
    });
    await fresh.start();
    expect(fresh.instanceToken()).toBeTruthy();
    expect(fresh.instanceToken()).not.toBe(token);
    await fresh.stop();
  });
});

describe('LexicalMemoryProvider merge-on-upsert (grouped sources)', () => {
  it('appends merge items into one shared row and advances occurredAt', async () => {
    await provider.ingestSourceBatch({
      source: 'slack',
      stream: 'C1',
      items: [{
        sourceRef: 'C1#2026-07-01',
        occurredAt: '2026-07-01T09:00:00.000Z',
        title: '#gtm 2026-07-01',
        content: '[09:00] Alice: morning',
        merge: true,
      }],
    });
    await provider.ingestSourceBatch({
      source: 'slack',
      stream: 'C1',
      items: [{
        sourceRef: 'C1#2026-07-01',
        occurredAt: '2026-07-01T10:30:00.000Z',
        title: '#gtm 2026-07-01',
        content: '[10:30] Bob: reply',
        merge: true,
      }],
    });

    const page = await provider.getPage('doc:1');
    expect(page?.content).toBe('[09:00] Alice: morning\n[10:30] Bob: reply');
    expect(page?.occurredAt).toBe('2026-07-01T10:30:00.000Z'); // later message wins
    expect(provider.diagnostics()).toMatchObject({ documents: 1 });
  });

  it('merged rows are searchable across appended lines', async () => {
    await provider.ingestSourceBatch({
      source: 'slack',
      stream: 'C1',
      items: [
        { sourceRef: 'C1#2026-07-01', occurredAt: '2026-07-01T09:00:00.000Z', content: '[09:00] Alice: kicking off Plasma', merge: true },
        { sourceRef: 'C1#2026-07-01', occurredAt: '2026-07-01T10:30:00.000Z', content: '[10:30] Bob: validium proposal', merge: true },
      ],
    });
    // A term from the second appended line still finds the single grouped row.
    const hits = await provider.search('validium', 5);
    expect(hits.map((h) => h.slug)).toContain('doc:1');
  });

  it('leaves non-merge upserts replacing content (default unchanged)', async () => {
    await provider.ingestSourceBatch({ source: 'gdrive', stream: '', items: [{ sourceRef: 'file-1', title: 'Doc', content: 'v1' }] });
    await provider.ingestSourceBatch({ source: 'gdrive', stream: '', items: [{ sourceRef: 'file-1', title: 'Doc', content: 'v2' }] });
    const page = await provider.getPage('doc:1');
    expect(page?.content).toBe('v2');
  });

  it('deletes passive documents for one source without touching other sources or pages', async () => {
    await provider.putPage('people/ada', '# Ada');
    await provider.ingestSourceBatch({
      source: 'clickup',
      stream: '',
      items: [{ sourceRef: 'comment-1', content: 'private ClickUp nuance' }],
    });
    await provider.ingestSourceBatch({
      source: 'slack',
      stream: '',
      items: [{ sourceRef: 'msg-1', content: 'Slack context' }],
    });

    const result = await provider.deleteSourceDocuments('clickup');

    expect(result).toEqual({ source: 'clickup', documentsDeleted: 1 });
    expect((await provider.search('private ClickUp nuance', 5))).toHaveLength(0);
    expect((await provider.search('Slack context', 5))).toHaveLength(1);
    expect(await provider.getPage('people/ada')).toMatchObject({ slug: 'people/ada' });
  });
});

describe('isChatCaptureEnabled', () => {
  it('defaults on, with an explicit falsy env as a kill switch', () => {
    expect(isChatCaptureEnabled({})).toBe(true);
    expect(isChatCaptureEnabled({ VERSO_MEMORY_CHAT_CAPTURE: '' })).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      expect(isChatCaptureEnabled({ VERSO_MEMORY_CHAT_CAPTURE: off })).toBe(false);
    }
    for (const on of ['1', 'true', 'yes', 'on', 'anything']) {
      expect(isChatCaptureEnabled({ VERSO_MEMORY_CHAT_CAPTURE: on })).toBe(true);
    }
  });
});
