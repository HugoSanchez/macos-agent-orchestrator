import { useEffect, useRef, useState } from 'react';
import { getConnections, requestJson } from './chat';
import { displayToolkitName } from './display-names';
import { postShellAction } from './shell-bridge';
import type { ConnectionView } from './types';

export function ConnectedAccounts() {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const currentRevision = ++revision.current;
      try {
        const result = await getConnections();
        if (!cancelled && revision.current === currentRevision) { setConnections(result.connections); setError(null); }
      } catch (err) {
        if (!cancelled && revision.current === currentRevision) setError(err instanceof Error ? err.message : 'Could not load connected accounts.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('focus', refresh); };
  }, []);

  async function remove(connection: ConnectionView) {
    if (removing) return;
    setRemoving(connection.connectedAccountId);
    setError(null);
    setNotice(null);
    try {
      const result = await requestJson<{ disconnect: { providerRevocation: string } }>(
        `/connections/${encodeURIComponent(connection.connectedAccountId)}`,
        'Could not remove this account. Try again.', { method: 'DELETE' },
      );
      revision.current += 1;
      setConnections((current) => current.filter((item) => item.connectedAccountId !== connection.connectedAccountId));
      setConfirmation(null);
      postShellAction({ kind: 'connections-changed' });
      if (result.disconnect.providerRevocation === 'manual_action_required') {
        setNotice('Account removed from Verso. To fully revoke access, remove Composio in the app’s security settings.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove this account.');
    } finally { setRemoving(null); }
  }

  const apps = new Map<string, ConnectionView[]>();
  for (const connection of connections) {
    const accounts = apps.get(connection.toolkitSlug) ?? [];
    accounts.push(connection);
    apps.set(connection.toolkitSlug, accounts);
  }
  return (
    <div className="settings-group connected-accounts">
      {loading ? <p className="settings-loading">Loading accounts…</p> : null}
      {error ? <p className="settings-footnote codex-error" role="alert">{error}</p> : null}
      {notice ? <p className="settings-footnote" role="status">{notice}</p> : null}
      {!loading && !error && connections.length === 0 ? <p className="settings-footnote">No connected accounts. Add an app from the sidebar.</p> : null}
      {[...apps].sort(([, a], [, b]) => a[0].toolkitName.localeCompare(b[0].toolkitName)).map(([slug, accounts]) => (
        <div key={slug} className="connected-accounts-app">
          <p className="settings-kicker">{displayToolkitName(accounts[0].toolkitName)}</p>
          <hr className="settings-rule" />
          {accounts.map((account) => (
            <div className="connected-account-row" key={account.connectedAccountId}>
              <div className="connected-account-identity">
                <div className="settings-row-label">{account.accountLabel || `Account ${account.connectedAccountId}`}</div>
                <div className="settings-footnote">{account.status === 'active' ? 'Connected' : 'Needs reconnection'}</div>
              </div>
              {confirmation === account.connectedAccountId ? (
                <div className="connected-account-actions">
                  <span className="settings-footnote">Remove this account?</span>
                  <button className="settings-button" disabled={!!removing} onClick={() => setConfirmation(null)}>Cancel</button>
                  <button className="settings-button" disabled={!!removing} onClick={() => void remove(account)}>{removing === account.connectedAccountId ? 'Removing…' : 'Confirm removal'}</button>
                </div>
              ) : <button className="settings-button" disabled={!!removing} onClick={() => setConfirmation(account.connectedAccountId)} aria-label={`Remove ${account.accountLabel || account.connectedAccountId}`}>Remove</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
