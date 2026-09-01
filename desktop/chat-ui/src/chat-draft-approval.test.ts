import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendDraft,
  setDraftApprovalToken,
  setSidecarAuthToken,
  setSidecarPort,
  sidecarFetch,
} from './chat';

describe('native draft approval capability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setDraftApprovalToken(null);
    setSidecarAuthToken(null);
  });

  it('attaches the capability only to reviewed draft sends', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setSidecarPort(1234);
    setSidecarAuthToken('sidecar-token');
    setDraftApprovalToken('native-approval-token');

    await sendDraft('draft_1', 'session_1', {
      channel: 'gmail',
      to: 'recipient@example.com',
      body: 'Reviewed body',
    });
    await sidecarFetch('http://127.0.0.1:1234/health');

    const sendHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sendHeaders.get('X-Verso-Sidecar-Token')).toBe('sidecar-token');
    expect(sendHeaders.get('X-Verso-Draft-Approval-Token')).toBe('native-approval-token');

    const ordinaryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(ordinaryHeaders.get('X-Verso-Sidecar-Token')).toBe('sidecar-token');
    expect(ordinaryHeaders.has('X-Verso-Draft-Approval-Token')).toBe(false);
  });
});
