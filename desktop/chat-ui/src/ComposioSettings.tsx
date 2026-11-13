import { useEffect, useState } from 'react';
import { ConnectedAccounts } from './ConnectedAccounts';
import { jsonInit, requestJson } from './chat';

interface ProjectStatus {
  provider: 'managed' | 'user';
  editable: boolean;
  saved: boolean;
  active: boolean;
  restartRequired: boolean;
  userId: string | null;
}

export function ComposioSettings() {
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void requestJson<ProjectStatus>('/settings/composio', 'Could not load connection settings')
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  async function change(remove: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await requestJson<ProjectStatus>('/settings/composio', 'Could not update connection settings',
        remove ? { method: 'DELETE' } : jsonInit('PUT', { apiKey: key }));
      setStatus(next);
      setKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update connection settings.');
    } finally { setBusy(false); }
  }

  return (
    <section>
      <h2 className="settings-panel-title">Connected apps</h2>
      <p className="settings-panel-sub">Manage the accounts connected to your apps.</p>
      <ConnectedAccounts />
      {error ? <p className="settings-footnote codex-error" role="alert">{error}</p> : null}
      {!status && !error ? <p className="settings-loading">Loading…</p> : null}
      {status?.provider === 'managed' ? (
        <p className="settings-footnote">Your connections use Verso’s managed service and Composio. Local builds can use a Composio project you own, without a Verso account.</p>
      ) : status ? (
        <>
          <div className="settings-group">
            <p className="settings-kicker">Your Composio project</p>
            <hr className="settings-rule" />
            <p className="settings-footnote">Use a project API key from your Composio dashboard. The key is stored in macOS Keychain. Connections use your project directly, without Verso’s servers.</p>
            <form className="settings-connect-form" onSubmit={(event) => { event.preventDefault(); void change(false); }}>
              <label htmlFor="composio-project-key" className="settings-row-label">Project API key</label>
              <input id="composio-project-key" type="password" className="settings-key-input"
                value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off"
                spellCheck={false} disabled={busy} placeholder={status.saved ? 'Enter a replacement key' : 'Paste your project key'} />
              <div className="settings-connect-form-actions">
                <button type="submit" className="settings-button settings-button-primary" disabled={busy || !key.trim()}>
                  {busy ? 'Updating…' : 'Verify & save'}
                </button>
                {status.saved ? <button type="button" className="settings-button" disabled={busy} onClick={() => void change(true)}>Remove key</button> : null}
              </div>
            </form>
            <p className="settings-footnote" role="status">
              {status.restartRequired ? 'Saved. Quit and reopen Verso to use this project, then connect your apps.'
                : status.active ? 'Your project is active. Connect apps from the sidebar, then enable their memory sources in App memory.'
                  : 'No project is active. Local memory and custom MCP connectors remain available.'}
            </p>
          </div>
          <p className="settings-footnote">Composio still processes connected-app requests and may retain their contents according to your project settings. Your Composio usage is billed to your project.</p>
          <p className="settings-footnote">Changing keys pauses connected apps until restart and starts a separate ingestion history. Existing memories stay on this Mac. Removing the key stops access here; disconnect individual apps first if you also want to revoke their access.</p>
          {status.userId ? <p className="settings-footnote">Composio user ID: {status.userId}</p> : null}
        </>
      ) : null}
    </section>
  );
}
