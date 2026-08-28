import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/memory/ingestion/ingestion-store.ts';

describe('IngestionStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempStore(): IngestionStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-ingestion-'));
    tempDirs.push(dir);
    return new IngestionStore(path.join(dir, 'ingestion.sqlite'));
  }

  const t0 = new Date('2026-06-17T10:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const MIN = 60 * 1000;

  // --- seeding & enable/disable ---------------------------------------------

  it('seeds the cursor and makes the source due immediately on enable', () => {
    const store = tempStore();
    store.ensureIngestionSource('gmail', '', 15 * MIN, t0);

    const disabled = store.getSource('gmail', '');
    expect(disabled).toMatchObject({ enabled: false, cursor: null, nextDueAt: null });

    const enabled = store.enableSource('gmail', '', { seedCursor: '2026-06-10T00:00:00.000Z' }, t0);
    expect(enabled).toMatchObject({
      enabled: true,
      status: 'idle',
      cursor: '2026-06-10T00:00:00.000Z',
      nextDueAt: t0.toISOString(),
    });
  });

  it('refuses to enable without an existing or seeded cursor (no unbounded fetch)', () => {
    const store = tempStore();
    store.ensureIngestionSource('gmail', '', 15 * MIN, t0);
    expect(() => store.enableSource('gmail', '', {}, t0)).toThrow(/without a seeded cursor/);
    // Row remains disabled with a null cursor.
    expect(store.getSource('gmail', '')).toMatchObject({ enabled: false, cursor: null });
  });

  it('retains the cursor across disable and resumes on re-enable without a seed', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);
    store.completeIngestion('gmail', '', 'c2', at(15 * MIN).toISOString(), at(MIN));

    store.disableSource('gmail', '', at(2 * MIN));
    expect(store.getSource('gmail', '')).toMatchObject({ enabled: false, cursor: 'c2' });

    // Re-enable with no seed: resumes from the retained cursor.
    const reEnabled = store.enableSource('gmail', '', {}, at(3 * MIN));
    expect(reEnabled).toMatchObject({ enabled: true, cursor: 'c2', nextDueAt: at(3 * MIN).toISOString() });
  });

  // --- claim ----------------------------------------------------------------

  it('claims a due source and flips it to running; ignores not-due and disabled', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);

    // Not due yet.
    expect(store.claimDueIngestionSource(at(-MIN))).toBeNull();

    const claimed = store.claimDueIngestionSource(at(MIN));
    expect(claimed).toMatchObject({ source: 'gmail', status: 'running', runningStartedAt: at(MIN).toISOString() });

    // Already running -> not claimable again.
    expect(store.claimDueIngestionSource(at(2 * MIN))).toBeNull();

    // Disabled sources are never claimed.
    store.completeIngestion('gmail', '', 'c2', at(-MIN).toISOString(), at(2 * MIN));
    store.disableSource('gmail', '', at(2 * MIN));
    expect(store.claimDueIngestionSource(at(3 * MIN))).toBeNull();
  });

  it('claims the oldest-due source first', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'g' }, t0);
    store.enableSource('slack', 'C1', { seedCursor: 's' }, t0);
    // Push gmail further into the future; slack stays due now.
    store.completeIngestion('gmail', '', 'g', at(10 * MIN).toISOString(), t0);

    const claimed = store.claimDueIngestionSource(at(MIN));
    expect(claimed?.source).toBe('slack');
  });

  // --- complete / fail / backoff --------------------------------------------

  it('advances the cursor and clears failure state on complete', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);
    store.failIngestion('gmail', '', 'boom', at(MIN).toISOString(), t0);

    const done = store.completeIngestion('gmail', '', 'c2', at(20 * MIN).toISOString(), at(2 * MIN));
    expect(done).toMatchObject({
      status: 'idle',
      cursor: 'c2',
      failCount: 0,
      lastError: null,
      nextDueAt: at(20 * MIN).toISOString(),
    });
  });

  it('keeps the cursor and backs off on failure, then re-claims when due', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);
    store.claimDueIngestionSource(at(MIN));

    const failed = store.failIngestion('gmail', '', 'rate limited', at(30 * MIN).toISOString(), at(2 * MIN));
    expect(failed).toMatchObject({ status: 'failed', cursor: 'c1', failCount: 1 });

    // Before backoff elapses -> not claimable.
    expect(store.claimDueIngestionSource(at(10 * MIN))).toBeNull();
    // After backoff -> a failed row is claimable again.
    expect(store.claimDueIngestionSource(at(31 * MIN))?.status).toBe('running');
  });

  it('resets stale running rows back to idle + due now, leaving fresh runs alone', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'g' }, t0);
    store.enableSource('slack', 'C1', { seedCursor: 's' }, t0);
    store.claimDueIngestionSource(t0);             // claims gmail (oldest), running_started_at = t0
    store.claimDueIngestionSource(at(20 * MIN));   // claims slack, running_started_at = t0 + 20m

    // 10-minute stale threshold, evaluated at t0 + 21m: only gmail (21m old) is stale.
    const reset = store.resetStaleRunningIngestion(10 * MIN, at(21 * MIN));
    expect(reset).toBe(1);
    expect(store.getSource('gmail', '')).toMatchObject({ status: 'idle', nextDueAt: at(21 * MIN).toISOString() });
    expect(store.getSource('slack', 'C1')?.status).toBe('running');
  });

  // --- item-level dedup & poison --------------------------------------------

  it('filters out already-processed and poisoned refs (boundary dedup)', () => {
    const store = tempStore();
    store.recordPendingItems('gmail', '', ['m1', 'm2'], t0);
    store.markItemsProcessed('gmail', '', ['m1'], at(MIN));
    store.markItemPoisoned('gmail', '', 'm3', 'bad payload', at(MIN));

    // m1 processed, m3 poisoned -> dropped; m2 (pending) and m4 (new) kept.
    expect(store.filterNewRefs('gmail', '', ['m1', 'm2', 'm3', 'm4']).sort()).toEqual(['m2', 'm4']);
  });

  it('does not let a poisoned item block cursor progress', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);
    store.claimDueIngestionSource(at(MIN));

    // One item poisons; the rest of the batch still completes and the cursor advances.
    store.markItemPoisoned('gmail', '', 'm_bad', 'always fails', at(MIN));
    store.markItemsProcessed('gmail', '', ['m_good'], at(MIN));
    const done = store.completeIngestion('gmail', '', 'c2', at(15 * MIN).toISOString(), at(2 * MIN));

    expect(done).toMatchObject({ status: 'idle', cursor: 'c2' });
    expect(store.getItem('gmail', '', 'm_bad')?.status).toBe('poisoned');
  });

  it('bumps attempts on repeated pending records but preserves terminal statuses', () => {
    const store = tempStore();
    store.recordPendingItems('gmail', '', ['m1'], t0);
    store.recordPendingItems('gmail', '', ['m1'], at(MIN));
    expect(store.getItem('gmail', '', 'm1')).toMatchObject({ status: 'pending', attempts: 2 });

    store.markItemsProcessed('gmail', '', ['m1'], at(2 * MIN));
    store.recordPendingItems('gmail', '', ['m1'], at(3 * MIN)); // must not revert to pending
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('processed');
  });

  // --- stream isolation -----------------------------------------------------

  it('keeps per-stream cursors independent (slack channels)', () => {
    const store = tempStore();
    store.enableSource('slack', 'C1', { seedCursor: 'a1' }, t0);
    store.enableSource('slack', 'C2', { seedCursor: 'b1' }, t0);

    store.completeIngestion('slack', 'C1', 'a2', at(15 * MIN).toISOString(), at(MIN));
    expect(store.getSource('slack', 'C1')?.cursor).toBe('a2');
    expect(store.getSource('slack', 'C2')?.cursor).toBe('b1');

    store.recordPendingItems('slack', 'C1', ['x'], t0);
    expect(store.filterNewRefs('slack', 'C2', ['x'])).toEqual(['x']); // C1's items don't shadow C2
  });

  it('defers without advancing the cursor or counting a failure', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);
    store.claimDueIngestionSource(at(MIN));

    const deferred = store.deferIngestion('gmail', '', at(20 * MIN).toISOString(), at(2 * MIN));
    expect(deferred).toMatchObject({
      status: 'idle',
      cursor: 'c1',          // unchanged
      failCount: 0,          // not counted as a failure
      lastError: null,
      nextDueAt: at(20 * MIN).toISOString(),
    });
  });

  it('counts processed items per source across streams', () => {
    const store = tempStore();
    store.markItemsProcessed('slack', 'C1', ['a', 'b'], t0);
    store.markItemsProcessed('slack', 'C2', ['c'], t0);
    store.markItemPoisoned('slack', 'C1', 'd', 'bad', t0);
    store.recordPendingItems('slack', 'C1', ['e'], t0);
    expect(store.countProcessedItems('slack')).toBe(3); // a, b, c — poisoned/pending excluded
    expect(store.countProcessedItems('gmail')).toBe(0);
  });

  it('reports diagnostics counts', () => {
    const store = tempStore();
    store.enableSource('gmail', '', { seedCursor: 'c1' }, t0);
    store.enableSource('slack', 'C1', { seedCursor: 's1' }, t0);
    store.failIngestion('slack', 'C1', 'boom', at(MIN).toISOString(), t0);
    store.markItemsProcessed('gmail', '', ['m1', 'm2'], t0);
    store.markItemPoisoned('gmail', '', 'm3', 'bad', t0);

    const diag = store.getIngestionDiagnostics();
    expect(diag.sourceCounts).toMatchObject({ idle: 1, failed: 1 });
    expect(diag.itemCounts).toMatchObject({ processed: 2, poisoned: 1 });
    expect(diag.sources).toHaveLength(2);
  });
});
