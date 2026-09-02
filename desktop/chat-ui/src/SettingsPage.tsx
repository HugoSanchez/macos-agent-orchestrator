import { useEffect, useState, type ReactElement } from 'react';
import {
  connectAnthropic,
  connectCustomModel,
  discoverCustomModels,
  disconnectAnthropic,
  disconnectCodex,
  disconnectCustomModel,
  getAgentBrowserStatus,
  getAnthropicStatus,
  getCodexStatus,
  getCustomModelStatus,
  getIngestionSources,
  getSidecarPort,
  openAgentBrowser,
  resetAgentBrowser,
  sidecarFetch,
  toggleIngestionSource,
  type AgentBrowserStatus,
  type AnthropicStatus,
  type CodexStatus,
  type CustomModelStatus,
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
  /** Panel to show on open; deep-links (e.g. the provider nudge) use this. */
  initialPanel?: SettingsPanelId;
}

export type SettingsPanelId = 'account' | 'models' | 'memory' | 'browser';
type PanelId = SettingsPanelId;

const PANELS: Array<{ id: PanelId; label: string; icon: () => ReactElement }> = [
  { id: 'account', label: 'Account', icon: AccountIcon },
  { id: 'models', label: 'Model providers', icon: ModelsIcon },
  { id: 'memory', label: 'App memory', icon: MemoryIcon },
  { id: 'browser', label: 'Agent browser', icon: BrowserIcon },
];

export function SettingsPage({ onBack, initialPanel }: Props) {
  const [panel, setPanel] = useState<PanelId>(initialPanel ?? 'account');
  const [account, setAccount] = useState<ManagedAccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  return (
    <div className="settings-page">
      <nav className="settings-rail">
        <button type="button" className="settings-back" onClick={onBack}>
          ← Back
        </button>
        <h1 className="settings-rail-title">Settings</h1>
        {PANELS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`settings-rail-item${panel === id ? ' is-active' : ''}`}
            onClick={() => setPanel(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
        <div className="settings-rail-spacer" />
      </nav>

      <main className="settings-pane">
        <div className="settings-pane-inner">
          {panel === 'account' ? (
            isLoading ? (
              <div className="settings-loading">Loading…</div>
            ) : error ? (
              <div className="settings-error">
                <p>{error}</p>
                <button type="button" className="settings-button" onClick={() => { setError(null); setIsLoading(true); window.location.reload(); }}>
                  Retry
                </button>
              </div>
            ) : account ? (
              <AccountPanel account={account} />
            ) : null
          ) : panel === 'models' ? (
            <ModelsPanel />
          ) : panel === 'memory' ? (
            <MemoryPanel />
          ) : (
            <BrowserPanel />
          )}
        </div>
      </main>
    </div>
  );
}

function AccountPanel({ account }: { account: ManagedAccountView }) {
  const [isSigningOut, setIsSigningOut] = useState(false);

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

  if (!account.capabilities.managedAccount) {
    return (
      <section>
        <h2 className="settings-panel-title">Account</h2>
        <p className="settings-panel-sub">Your Verso account and session.</p>
        <div className="settings-group">
          <p className="settings-kicker">runtime</p>
          <hr className="settings-rule" />
          <div className="settings-row">
            <span className="settings-row-label">Mode</span>
            <span className="settings-row-value is-dim">{titleCase(account.runtimeMode)}</span>
          </div>
        </div>
        <p className="settings-footnote">Verso managed services are disabled in this mode.</p>
      </section>
    );
  }

  const stateLabel = titleCase(account.account.state.replace(/_/g, ' '));
  return (
    <section>
      <h2 className="settings-panel-title">Account</h2>
      <p className="settings-panel-sub">Your Verso account and session.</p>

      <div className="settings-group">
        <p className="settings-kicker">profile</p>
        <hr className="settings-rule" />
        <div className="settings-row">
          <span className="settings-row-label">Signed in as</span>
          <span className="settings-row-value">
            {account.account.user?.email
              || account.account.user?.displayName
              || account.session.email
              || account.session.displayName
              || account.session.userId
              || 'Not signed in'}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Status</span>
          <span className="settings-status-inline">
            <span className={`settings-dot ${account.account.state === 'authenticated' ? 'is-on' : 'is-warn'}`} />
            {stateLabel}
          </span>
        </div>
        {account.account.entitlements[0] ? (
          <div className="settings-row">
            <span className="settings-row-label">Mode</span>
            <span className="settings-row-value is-dim">{titleCase(account.account.entitlements[0].mode)}</span>
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <p className="settings-kicker">session</p>
        <hr className="settings-rule" />
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Sign out</span>
            <span className="settings-row-detail">Ends your session on this Mac.</span>
          </div>
          <button
            type="button"
            className="settings-button settings-button-danger"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </section>
  );
}

// Tells App (listening on window) that provider auth changed so the model
// selector's availability updates immediately — without waiting for the
// user to leave Settings.
function notifyModelAuthChanged(): void {
  window.dispatchEvent(new CustomEvent('verso:model-auth-changed'));
}

// One panel for all three providers, grouped by connection state so the
// resting view reads "what's live" at a glance. Connect forms expand inline
// under their row and collapse again on success or cancel.
function ModelsPanel() {
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [anthropic, setAnthropic] = useState<AnthropicStatus | null>(null);
  const [custom, setCustom] = useState<CustomModelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { phase, start, cancel, reset } = useCodexConnect({
    onConnected: () => { void refreshCodex(); notifyModelAuthChanged(); },
  });

  useEffect(() => {
    void refreshCodex();
    void refreshAnthropic();
    void refreshCustom();
  }, []);

  async function refreshCodex() {
    try { setCodex(await getCodexStatus()); } catch (err) { setError(errText(err)); }
  }
  async function refreshAnthropic() {
    try { setAnthropic(await getAnthropicStatus()); } catch (err) { setError(errText(err)); }
  }
  async function refreshCustom() {
    try { setCustom(await getCustomModelStatus()); } catch (err) { setError(errText(err)); }
  }

  const codexConnected = codex?.connected === true || phase.kind === 'connected';
  const codexFlowActive = phase.kind !== 'idle' && phase.kind !== 'connected';

  const rows = [
    { key: 'codex', connected: codexConnected },
    { key: 'anthropic', connected: anthropic?.connected === true },
    { key: 'custom', connected: custom?.connected === true },
  ];
  const connectedKeys = rows.filter((r) => r.connected).map((r) => r.key);
  const availableKeys = rows.filter((r) => !r.connected).map((r) => r.key);

  function renderProvider(key: string) {
    if (key === 'codex') {
      return (
        <CodexRow
          key={key}
          connected={codexConnected}
          flowActive={codexFlowActive}
          phase={phase}
          onStart={start}
          onCancel={phase.kind === 'error' ? reset : cancel}
          onRetry={start}
          onDisconnected={() => { void refreshCodex(); }}
          onError={setError}
        />
      );
    }
    if (key === 'anthropic') {
      return (
        <AnthropicRow
          key={key}
          connected={anthropic?.connected === true}
          onChanged={() => { void refreshAnthropic(); }}
          onError={setError}
        />
      );
    }
    return (
      <CustomRow
        key={key}
        status={custom}
        onChanged={() => { void refreshCustom(); }}
        onError={setError}
      />
    );
  }

  return (
    <section>
      <h2 className="settings-panel-title">Model providers</h2>
      <p className="settings-panel-sub">Connect a provider to use its models from the chat model selector.</p>

      {error ? <p className="settings-footnote codex-error">{error}</p> : null}

      {connectedKeys.length > 0 ? (
        <div className="settings-group">
          <p className="settings-kicker">connected</p>
          <hr className="settings-rule" />
          {connectedKeys.map(renderProvider)}
        </div>
      ) : null}

      {availableKeys.length > 0 ? (
        <div className="settings-group">
          <p className="settings-kicker">available</p>
          <hr className="settings-rule" />
          {availableKeys.map(renderProvider)}
        </div>
      ) : null}
    </section>
  );
}

function CodexRow({ connected, flowActive, phase, onStart, onCancel, onRetry, onDisconnected, onError }: {
  connected: boolean;
  flowActive: boolean;
  phase: Parameters<typeof CodexConnectFlow>[0]['phase'];
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDisconnected: () => void;
  onError: (message: string) => void;
}) {
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      await disconnectCodex();
      onDisconnected();
      notifyModelAuthChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setIsDisconnecting(false);
    }
  }

  return (
    <>
      <div className={`settings-row${flowActive ? ' is-expanded' : ''}`}>
        <div className="settings-row-main">
          <span className="settings-mark is-mono"><CodexMark /></span>
          <div className="settings-row-text">
            <span className="settings-row-label">Codex</span>
            <span className="settings-row-detail">
              {connected ? (
                <span className="settings-status-inline"><span className="settings-dot is-on" />Connected</span>
              ) : (
                'Codex models via your ChatGPT account.'
              )}
            </span>
          </div>
        </div>
        {flowActive ? null : connected ? (
          <button type="button" className="settings-button" onClick={handleDisconnect} disabled={isDisconnecting}>
            {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : (
          <button type="button" className="settings-button settings-button-primary" onClick={onStart}>
            Connect
          </button>
        )}
      </div>
      {flowActive ? (
        <div className="settings-connect-form">
          <CodexConnectFlow phase={phase} onRetry={onRetry} onCancel={onCancel} />
        </div>
      ) : null}
    </>
  );
}

// Anthropic is an API-key provider (no OAuth device flow like Codex): the
// user pastes a key, the orchestrator validates it against the Anthropic API
// before storing it in the Hermes profile, and Claude models appear in the
// chat-input model selector.
function AnthropicRow({ connected, onChanged, onError }: {
  connected: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  async function handleConnect() {
    const key = keyDraft.trim();
    if (!key || isBusy) return;
    setIsBusy(true);
    try {
      await connectAnthropic(key);
      setKeyDraft('');
      setIsOpen(false);
      onChanged();
      notifyModelAuthChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDisconnect() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await disconnectAnthropic();
      onChanged();
      notifyModelAuthChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <>
      <div className={`settings-row${isOpen ? ' is-expanded' : ''}`}>
        <div className="settings-row-main">
          <span className="settings-mark"><ClaudeMark /></span>
          <div className="settings-row-text">
            <span className="settings-row-label">Anthropic</span>
            <span className="settings-row-detail">
              {connected ? (
                <span className="settings-status-inline"><span className="settings-dot is-on" />Connected · API key</span>
              ) : (
                'Claude models via your API key.'
              )}
            </span>
          </div>
        </div>
        {connected ? (
          <button type="button" className="settings-button" onClick={handleDisconnect} disabled={isBusy}>
            {isBusy ? 'Removing…' : 'Remove key'}
          </button>
        ) : isOpen ? null : (
          <button type="button" className="settings-button settings-button-primary" onClick={() => setIsOpen(true)}>
            Connect
          </button>
        )}
      </div>
      {isOpen && !connected ? (
        <div className="settings-connect-form">
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
          <div className="settings-connect-form-actions">
            <p className="settings-footnote">The key is verified, then stored locally with your Hermes profile.</p>
            <button type="button" className="settings-link" onClick={() => { setIsOpen(false); setKeyDraft(''); }} disabled={isBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={handleConnect}
              disabled={isBusy || keyDraft.trim().length === 0}
            >
              {isBusy ? 'Verifying…' : 'Verify & connect'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CustomRow({ status, onChanged, onError }: {
  status: CustomModelStatus | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const connected = status?.connected === true;

  function resetForm() {
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setModel('');
    setDiscoveryAttempted(false);
  }

  async function handleDiscover() {
    if (isBusy || !baseUrl.trim()) return;
    setIsBusy(true);
    try {
      const discovered = await discoverCustomModels(baseUrl.trim(), apiKey.trim());
      setModels(discovered);
      setDiscoveryAttempted(true);
      setModel(discovered[0] ?? '');
    } catch (err) {
      onError(errText(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConnect() {
    if (isBusy || !model.trim()) return;
    setIsBusy(true);
    try {
      await connectCustomModel(baseUrl.trim(), apiKey.trim(), model.trim());
      resetForm();
      setIsOpen(false);
      onChanged();
      notifyModelAuthChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDisconnect() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await disconnectCustomModel();
      resetForm();
      onChanged();
      notifyModelAuthChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <>
      <div className={`settings-row${isOpen ? ' is-expanded' : ''}`}>
        <div className="settings-row-main">
          <span className="settings-mark is-mono"><AsteriskMark /></span>
          <div className="settings-row-text">
            <span className="settings-row-label">Custom provider</span>
            <span className="settings-row-detail">
              {connected ? (
                <span className="settings-status-inline">
                  <span className="settings-dot is-on" />
                  {status?.model} · {status?.baseUrl}
                </span>
              ) : (
                'Any OpenAI-compatible endpoint.'
              )}
            </span>
          </div>
        </div>
        {connected ? (
          <button type="button" className="settings-button" onClick={handleDisconnect} disabled={isBusy}>
            {isBusy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : isOpen ? null : (
          <button type="button" className="settings-button" onClick={() => setIsOpen(true)}>
            Set up
          </button>
        )}
      </div>
      {isOpen && !connected ? (
        <div className="settings-connect-form">
          <input
            type="url"
            className="settings-key-input"
            placeholder="https://example.modal.direct"
            aria-label="Custom provider base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            disabled={isBusy}
          />
          <input
            type="password"
            className="settings-key-input"
            placeholder="API key or proxy token (optional)"
            aria-label="Custom provider API key"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={isBusy}
          />
          {models.length > 0 ? (
            <select
              className="settings-key-input"
              aria-label="Custom provider model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={isBusy}
            >
              {models.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          ) : discoveryAttempted && models.length === 0 ? (
            <input
              type="text"
              className="settings-key-input"
              placeholder="Model ID"
              aria-label="Custom provider model ID"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={isBusy}
            />
          ) : null}
          <div className="settings-connect-form-actions">
            <p className="settings-footnote">
              {discoveryAttempted && models.length === 0
                ? 'This endpoint does not advertise its models. Enter the model ID supplied by the provider.'
                : 'Verso discovers available models. Modal dashboard URLs automatically use /v1; paste the combined proxy token or its full Bearer header.'}
            </p>
            <button type="button" className="settings-link" onClick={() => { setIsOpen(false); resetForm(); }} disabled={isBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={discoveryAttempted ? handleConnect : handleDiscover}
              disabled={isBusy
                || !baseUrl.trim()
                || (discoveryAttempted && !model.trim())}
            >
              {isBusy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function MemoryPanel() {
  const [sources, setSources] = useState<IngestionSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // Poll while the panel is open so the per-source status updates live.
    const id = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function refresh() {
    try {
      setSources(await getIngestionSources());
      setError(null);
    } catch (err) {
      setError(errText(err));
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
      setError(errText(err));
    } finally {
      setPending(null);
    }
  }

  const connectedSources = sources?.filter((source) => source.connected) ?? null;

  return (
    <section>
      <h2 className="settings-panel-title">App memory</h2>
      <p className="settings-panel-sub">Choose which connected apps Verso remembers from.</p>

      {error ? <p className="settings-footnote codex-error">{error}</p> : null}

      {connectedSources !== null && connectedSources.length > 0 ? (
        <div className="settings-group">
          <p className="settings-kicker">sources</p>
          <hr className="settings-rule" />
          {connectedSources.map((source) => {
            const on = source.enabled;
            return (
              <div className="settings-row" key={source.source}>
                <div className="settings-row-main">
                  <span className="settings-mark">
                    {source.logoUrl ? (
                      <img src={source.logoUrl} alt="" aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true">{source.displayName.charAt(0)}</span>
                    )}
                  </span>
                  <div className="settings-row-text">
                    <span className="settings-row-label">{source.displayName}</span>
                    <span className="settings-row-detail">
                      {on && source.status !== 'running' && source.lastError ? (
                        <span className="settings-status-inline"><span className="settings-dot is-warn" />last sync failed</span>
                      ) : (
                        sourceStatus(source)
                      )}
                    </span>
                  </div>
                </div>
                <span
                  className={`skill-row-toggle is-${on ? 'on' : 'off'}`}
                  role="switch"
                  aria-checked={on}
                  aria-disabled={pending === source.source}
                  onClick={() => handleToggle(source)}
                >
                  <span className="skill-row-toggle-thumb" />
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <p className="settings-footnote">Sources appear here once connected in the app catalog.</p>
    </section>
  );
}

function BrowserPanel() {
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
      setError(errText(err));
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
      setError(errText(err));
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

  return (
    <section>
      <h2 className="settings-panel-title">Agent browser</h2>
      <p className="settings-panel-sub">
        A dedicated browser the assistant can operate. Open it to sign in to a
        site yourself — the assistant reuses the session but never sees your
        passwords.
      </p>

      {error ? <p className="settings-footnote codex-error">{error}</p> : null}
      {status && !status.supported ? (
        <p className="settings-footnote">Install Google Chrome (or Chromium, Brave, Edge) to use browser automation.</p>
      ) : null}

      <div className="settings-group">
        <p className="settings-kicker">browser</p>
        <hr className="settings-rule" />
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Open browser</span>
            <span className="settings-row-detail">Sign in to sites the assistant should be able to use.</span>
          </div>
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
            <div className="settings-row-text">
              <span className="settings-row-label">Browsing data</span>
              <span className="settings-row-detail">Removes cookies and sessions — signs out of all sites.</span>
            </div>
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
      </div>
    </section>
  );
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourceStatus(source: IngestionSourceView): string {
  if (!source.enabled) return 'off';
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

/* ---- Marks & rail icons (inline vector art; colors allowlisted) ---- */

function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" fill="#D97757" aria-hidden="true" focusable="false">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function AsteriskMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 3.5v17M4.64 7.75l14.72 8.5M4.64 16.25l14.72-8.5" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.8 13.5c.9-2.4 2.9-3.6 5.2-3.6s4.3 1.2 5.2 3.6" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.5" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
      <ellipse cx="8" cy="4" rx="5.3" ry="2.2" />
      <path d="M2.7 4v8c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2V4" />
      <path d="M2.7 8c0 1.2 2.4 2.2 5.3 2.2S13.3 9.2 13.3 8" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.7 1.6 2.5 3.6 2.5 5.8S9.7 12.2 8 13.8C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2.2z" />
    </svg>
  );
}
