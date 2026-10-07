/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAccounts } from './ConnectedAccounts';

const { getConnections, requestJson, postShellAction } = vi.hoisted(() => ({ getConnections: vi.fn(), requestJson: vi.fn(), postShellAction: vi.fn() }));
vi.mock('./chat', () => ({ getConnections, requestJson }));
vi.mock('./shell-bridge', () => ({ postShellAction }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  getConnections.mockResolvedValue({ connections: ['work', 'personal'].map((id) => ({
    connectedAccountId: id, accountLabel: `${id}@example.com`, toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'active', logoUrl: null,
  })) });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;

describe('connected account management', () => {
  it('groups accounts by app and removes only the confirmed account', async () => {
    requestJson.mockResolvedValue({ disconnect: { providerRevocation: 'revoked' } });
    await act(async () => root.render(<ConnectedAccounts />));
    expect(container.querySelectorAll('.connected-accounts-app')).toHaveLength(1);
    expect(container.textContent).toContain('work@example.com');
    expect(container.textContent).toContain('personal@example.com');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove personal@example.com"]')!.click());
    expect(requestJson).not.toHaveBeenCalled();
    await act(async () => button('Confirm removal').click());
    expect(requestJson).toHaveBeenCalledWith('/connections/personal', expect.any(String), { method: 'DELETE' });
    expect(container.textContent).toContain('work@example.com');
    expect(container.textContent).not.toContain('personal@example.com');
    expect(postShellAction).toHaveBeenCalledWith({ kind: 'connections-changed' });
  });

  it('keeps the account when removal fails and explains manual revocation after retry', async () => {
    requestJson.mockRejectedValueOnce(new Error('Please retry')).mockResolvedValueOnce({ disconnect: { providerRevocation: 'manual_action_required' } });
    await act(async () => root.render(<ConnectedAccounts />));
    await act(async () => button('Remove').click());
    await act(async () => button('Confirm removal').click());
    expect(container.textContent).toContain('work@example.com');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Please retry');
    expect(postShellAction).not.toHaveBeenCalled();
    await act(async () => button('Confirm removal').click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('security settings');
  });
});
