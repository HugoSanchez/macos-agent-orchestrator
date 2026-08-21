import { useEffect, useState } from 'react';
import {
  connectAnthropic,
  disconnectAnthropic,
  disconnectCodex,
  getAgentBrowserStatus,
  getAnthropicStatus,
  getCodexStatus,
  getIngestionSources,
  getSidecarPort,
  openAgentBrowser,
  resetAgentBrowser,
  sidecarFetch,
  toggleIngestionSource,
  type AgentBrowserStatus,
  type AnthropicStatus,
  type CodexStatus,
  type IngestionSourceView,
} from './chat';
import { CodexMark, CodexConnectFlow, useCodexConnect } from './CodexConnect';
import { postShellAction } from './shell-bridge';

interface ManagedAccountView {
  runtimeMode: 'local' | 'byo' | 'managed';
  capabilities: {
    managedAccount: boolean;
    remoteConnections: boolean;
  };
  backend: {
    configured: boolean;
    baseUrl: string | null;
  };
  session: {
    present: boolean;
    userId: string | null;
    email: string | null;
    displayName: string | null;
    expiresAt: string | null;
    receivedAt: string | null;
    expired: boolean;
  };
  account: {
    state: string;
    error: string | null;
    user: {
      id: string;
      email: string | null;
      displayName: string | null;
    } | null;
    entitlements: Array<{
      id: string;
      mode: string;
      status: string;
    }>;
  };
}

interface Props {
  onBack: () => void;
}

export function SettingsPage({ onBack }: Props) {
  const [account, setAccount] = useState<ManagedAccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const port = getSidecarPort();
      if (!port) {
        if (!cancelled) {
          setError('Orchestrator is not ready yet — try again in a moment.');
          setIsLoading(false);
        }
        return;
      }
      try {
        const res = await sidecarFetch(`http://127.0.0.1:${port}/managed/account`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(
            (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
              ? body.message
              : `Failed to load account (HTTP ${res.status}).`,
          );
        } else {
          setAccount(body as ManagedAccountView);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const port = getSidecarPort();
    if (port) {
      // Tell the orchestrator to clear local session + call backend revoke.
      // We don't await success: the macOS shell separately clears Keychain
      // and the chat-ui will be torn down when the app reverts to SignInView.
      try {
        await sidecarFetch(`http://127.0.0.1:${port}/managed/session`, { method: 'DELETE' });
      } catch {
        // best-effort — the app shell handles the rest
      }
    }
    // Notify the macOS shell so it clears Keychain and switches to SignInView.
    postShellAction({ kind: 'sign-out' });
    setIsSigningOut(false);
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button type="button" className="settings-back" onClick={onBack}>
          ← Back
        </button>
      </div>

      {isLoading ? (
        <div className="settings-loading">Loading…</div>
      ) : error ? (
        <div className="settings-error">
          <p>{error}</p>
          <button type="button" className="settings-button" onClick={() => { setError(null); setIsLoading(true); window.location.reload(); }}>
            Retry
          </button>
        </div>
      ) : account ? (
        <div className="settings-body">
          {account.capabilities.managedAccount ? (
            <section className="settings-section">
              <h2>Account</h2>
              <div className="settings-row">
                <span className="settings-label">Signed in as</span>
                <span className="settings-value">
                  {account.account.user?.email
                    || account.account.user?.displayName
                    || account.session.email
                    || account.session.displayName
                    || account.session.userId
                    || 'Not signed in'}
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Status</span>
                <span className="settings-value">{titleCase(account.account.state.replace(/_/g, ' '))}</span>
              </div>
              {account.account.entitlements[0] ? (
                <div className="settings-row">
                  <span className="settings-label">Mode</span>
                  <span className="settings-value">{titleCase(account.account.entitlements[0].mode)}</span>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="settings-section">
              <h2>Runtime</h2>
              <div className="settings-row">
                <span className="settings-label">Mode</span>
                <span className="settings-value">{titleCase(account.runtimeMode)}</span>
              </div>
              <p className="settings-footnote">Verso managed services are disabled in this mode.</p>
            </section>
          )}

          <CodexSection />

          <AnthropicSection />

          <IngestionSection />

          <AgentBrowserSection />

          {account.capabilities.managedAccount ? (
            <section className="settings-section settings-section-signout">
              <div className="settings-row">
                <span className="settings-label">Session</span>
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  onClick={handleSignOut}
                  disabled={isSigningOut}
                >
                  {isSigningOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sourceStatus(source: IngestionSourceView): string | null {
  if (!source.enabled) return null;
  if (source.status === 'running') return 'syncing…';
  if (source.lastError) return 'last sync failed';
  if (source.lastCompletedAt) {
    return `synced ${timeAgo(source.lastCompletedAt)} · ${source.itemCount} ${source.itemCount === 1 ? 'item' : 'items'}`;
  }
  return 'waiting to sync…';
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function IngestionSection() {
  const [sources, setSources] = useState<IngestionSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // Poll while Settings is open so the per-source status updates live.
    const id = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function refresh() {
    try {
      setSources(await getIngestionSources());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggle(source: IngestionSourceView) {
    if (pending) return;
    if (!source.enabled && !source.connected) {
      setError(`${source.displayName} is not connected. Connect it first.`);
      return;
    }
    setPending(source.source);
    try {
      const updated = await toggleIngestionSource(source.source, !source.enabled);
      setSources((prev) => (prev ? prev.map((s) => (s.source === updated.source ? updated : s)) : prev));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Still loading and nothing to report yet — don't flash an empty section.
  if (sources === null && !error) return null;
  if (sources !== null && sources.length === 0) return null;

  return (
    <section className="settings-section">
      <div className="ingestion-header">
        <h2>Ingestion</h2>
        <p className="settings-footnote">Let Verso automatically remember from your connected apps.</p>
      </div>
      {error ? <p className="settings-footnote codex-error">{error}</p> : null}
      {sources?.map((source) => {
        const on = source.enabled;
        return (
          <div className="settings-row" key={source.source}>
            <span className="settings-label ingestion-source">
              {source.logoUrl ? (
                <img className="catalog-row-logo" src={source.logoUrl} alt="" aria-hidden="true" />
              ) : (
                <span className="catalog-row-logo-fallback" aria-hidden="true">{source.displayName.charAt(0)}</span>
              )}
              <span className="ingestion-source-text">
                <span>
                  {source.displayName}
                  {!source.connected ? <span className="settings-value"> · not connected</span> : null}
                </span>
                {sourceStatus(source) ? (
                  <span className="ingestion-source-status">{sourceStatus(source)}</span>
                ) : null}
              </span>
            </span>
            <span
              className={`skill-row-toggle is-${on ? 'on' : 'off'}`}
              role="switch"
              aria-checked={on}
              aria-disabled={pending === source.source || (!source.enabled && !source.connected)}
              onClick={() => handleToggle(source)}
            >
              <span className="skill-row-toggle-thumb" />
            </span>
          </div>
        );
      })}
    </section>
  );
}

function AgentBrowserSection() {
  const [status, setStatus] = useState<AgentBrowserStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'open' | 'reset' | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function refresh() {
    try {
      setStatus(await getAgentBrowserStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function run(op: 'open' | 'reset', action: () => Promise<unknown>) {
    if (pending) return;
    setPending(op);
    try {
      await action();
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  function handleReset() {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setConfirmingReset(false);
    void run('reset', () => resetAgentBrowser());
  }

  if (status === null && !error) return null;

  return (
    <section className="settings-section">
      <div className="ingestion-header">
        <h2>Agent browser</h2>
        <p className="settings-footnote">
          A dedicated browser the assistant can operate. Open it to sign in to a
          site yourself — the assistant reuses the session but never sees your
          passwords.
        </p>
      </div>
      {error ? <p className="settings-footnote codex-error">{error}</p> : null}
      {status && !status.supported ? (
        <p className="settings-footnote">Install Google Chrome (or Chromium, Brave, Edge) to use browser automation.</p>
      ) : null}
      <div className="settings-row">
        <span className="settings-label">Browser</span>
        <button
          type="button"
          className="settings-button settings-button-primary"
          onClick={() => { void run('open', () => openAgentBrowser()); }}
          disabled={pending !== null || status?.supported === false}
        >
          {pending === 'open' ? 'Opening…' : 'Open browser'}
        </button>
      </div>
      {status?.enabled ? (
        <div className="settings-row">
          <span className="settings-label">Browsing data</span>
          <button
            type="button"
            className="settings-link settings-link-danger"
            onClick={handleReset}
            onBlur={() => setConfirmingReset(false)}
            disabled={pending !== null}
          >
            {pending === 'reset' ? 'Clearing…' : confirmingReset ? 'Confirm — signs out of all sites' : 'Clear browsing data'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

// Tells App (listening on window) that provider auth changed so the model
// selector's availability updates immediately — without waiting for the
// user to leave Settings.
function notifyModelAuthChanged(): void {
  window.dispatchEvent(new CustomEvent('verso:model-auth-changed'));
}

// Anthropic is an API-key provider (no OAuth device flow like Codex): the
// user pastes a key, the orchestrator validates it against the Anthropic API
// before storing it in the Hermes profile, and Claude models appear in the
// chat-input model selector.
function AnthropicSection() {
  const [status, setStatus] = useState<AnthropicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => { void refreshStatus(); }, []);

  async function refreshStatus() {
    try {
      setStatus(await getAnthropicStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConnect() {
    const key = keyDraft.trim();
    if (!key || isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      await connectAnthropic(key);
      setKeyDraft('');
      await refreshStatus();
      notifyModelAuthChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDisconnect() {
    if (isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      await disconnectAnthropic();
      await refreshStatus();
      notifyModelAuthChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h2>Anthropic</h2>

      {error ? (
        <p className="settings-footnote codex-error">{error}</p>
      ) : null}

      {status === null ? null : status.connected ? (
        <div className="settings-row">
          <span className="settings-label">API key</span>
          <input
            type="password"
            className="settings-key-input settings-key-input-saved"
            value="saved-anthropic-api-key"
            aria-label="Saved Anthropic API key"
            autoComplete="off"
            spellCheck={false}
            readOnly
            disabled
          />
          <button
            type="button"
            className="settings-button settings-button-primary"
            onClick={handleDisconnect}
            disabled={isBusy}
          >
            {isBusy ? 'Removing…' : 'Remove key'}
          </button>
        </div>
      ) : (
        <>
          <div className="settings-row">
            <input
              type="password"
              className="settings-key-input"
              placeholder="sk-ant-…"
              value={keyDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleConnect(); }}
              disabled={isBusy}
            />
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={handleConnect}
              disabled={isBusy || keyDraft.trim().length === 0}
            >
              {isBusy ? 'Verifying…' : 'Connect'}
            </button>
          </div>
          <p className="settings-footnote">
            Paste an Anthropic API key to use Claude models. The key is verified,
            then stored locally with your Hermes profile.
          </p>
        </>
      )}
    </section>
  );
}

function CodexSection() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const { phase, start, cancel, reset } = useCodexConnect({
    onConnected: () => { void refreshStatus(); notifyModelAuthChanged(); },
  });

  useEffect(() => { void refreshStatus(); }, []);

  async function refreshStatus() {
    try {
      const next = await getCodexStatus();
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDisconnect() {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      await disconnectCodex();
      await refreshStatus();
      notifyModelAuthChanged();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDisconnecting(false);
    }
  }

  const showConnectionRow = status !== null && (phase.kind === 'idle' || phase.kind === 'connected');
  const isConnected = status?.connected === true || phase.kind === 'connected';

  return (
    <section className="settings-section">
      <h2>Codex</h2>

      {statusError ? (
        <p className="settings-footnote codex-error">{statusError}</p>
      ) : null}

      {showConnectionRow ? (
        <div className="settings-row">
          <span className="settings-label">Connection</span>
          {isConnected ? (
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
            >
              <CodexMark />
              <span>{isDisconnecting ? 'Disconnecting…' : 'Disconnect'}</span>
            </button>
          ) : (
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={start}
            >
              <CodexMark />
              <span>Connect Codex</span>
            </button>
          )}
        </div>
      ) : null}

      <CodexConnectFlow phase={phase} onRetry={start} onCancel={phase.kind === 'error' ? reset : cancel} />
    </section>
  );
}
