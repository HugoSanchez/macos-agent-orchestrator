import { describe, expect, it } from 'vitest';
import { ChatRequestRegistry } from '../src/chat/chat-request-registry.ts';

describe('ChatRequestRegistry', () => {
  it('atomically reserves one request per session while allowing other sessions', () => {
    const registry = new ChatRequestRegistry();
    const first = registry.begin('session-1', 'http://hermes-1');

    expect(first).not.toBeNull();
    expect(registry.begin('session-1', 'http://hermes-2')).toBeNull();
    expect(registry.begin('session-2', 'http://hermes-1')).not.toBeNull();
    expect(registry.sessionIds()).toEqual(['session-1', 'session-2']);
  });

  it('keeps a cancelled request reserved until its owner finishes unwinding', () => {
    const registry = new ChatRequestRegistry();
    const request = registry.begin('session-1', 'http://hermes');
    expect(request).not.toBeNull();

    expect(registry.cancel('session-1')).toBe(true);
    expect(request?.signal.aborted).toBe(true);
    expect(registry.has('session-1')).toBe(true);
    expect(registry.begin('session-1', 'http://hermes')).toBeNull();

    registry.finish(request!);
    expect(registry.has('session-1')).toBe(false);
    expect(registry.begin('session-1', 'http://hermes')).not.toBeNull();
  });

  it('does not let an older request release a newer reservation', () => {
    const registry = new ChatRequestRegistry();
    const older = registry.begin('session-1', 'http://hermes')!;
    registry.finish(older);
    const newer = registry.begin('session-1', 'http://hermes')!;

    registry.finish(older);

    expect(registry.has('session-1')).toBe(true);
    expect(registry.snapshots()[0]).toMatchObject({ sessionId: 'session-1' });
    registry.finish(newer);
  });

  it('aborts every request during sidecar shutdown', () => {
    const registry = new ChatRequestRegistry();
    const first = registry.begin('session-1', 'http://hermes')!;
    const second = registry.begin('session-2', 'http://hermes')!;

    registry.cancelAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
