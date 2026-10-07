import { resolveSidecarUrl } from './chat';
import { formatRelativeTime } from './session-format';
import type { ChatSessionSummary, ConnectionView, CustomConnectorView } from './types';

export interface BrowserSidebarProps {
  activeSessions: ChatSessionSummary[];
  archivedSessions: ChatSessionSummary[];
  connected: boolean;
  connections: ConnectionView[];
  connectingApps: ReadonlySet<string>;
  onAddAccount: (slug: string) => void;
  customConnectors: CustomConnectorView[];
  isHydratingSession: boolean;
  isLoadingSessions: boolean;
  onDisconnectConnector: (id: string) => void;
  onNewChat: () => void;
  onRetryConnector: (id: string) => void;
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
  sessionError: string | null;
}

export function BrowserSidebar(props: BrowserSidebarProps) {
  return (
    <aside className="session-sidebar">
      <div className="session-sidebar-head">
        <div>
          <div className="session-sidebar-label">Sessions</div>
          <div className="session-sidebar-caption">
            {!props.connected
              ? 'Offline'
              : props.isLoadingSessions
                ? 'Refreshing'
                : `${props.activeSessions.length} active`}
          </div>
        </div>
        <button
          className="sidebar-primary-button"
          type="button"
          onClick={props.onNewChat}
          disabled={!props.connected || props.isHydratingSession}
        >
          New Chat
        </button>
      </div>

      {props.sessionError && <div className="session-sidebar-error">{props.sessionError}</div>}

      <SessionSection
        title="Recent"
        sessions={props.activeSessions}
        selectedSessionId={props.selectedSessionId}
        disabled={props.isHydratingSession}
        onSelect={props.onSelectSession}
        emptyText={props.connected
          ? 'No active sessions yet.'
          : 'Sessions will appear once the sidecar is ready.'}
      />

      {props.archivedSessions.length > 0 && (
        <SessionSection
          title="Archived"
          sessions={props.archivedSessions}
          selectedSessionId={props.selectedSessionId}
          disabled={props.isHydratingSession}
          onSelect={props.onSelectSession}
          emptyText="No archived sessions."
        />
      )}

      {props.connections.length > 0 && <section className="session-section">
        <div className="session-section-title">Connected apps</div>
        {[...new Map(props.connections.map((connection) => [connection.toolkitSlug, connection])).values()].map((app) => (
          <div className="sidebar-connected-app" key={app.toolkitSlug}>
            <span>{app.toolkitName}</span>
            <button type="button" className="sidebar-add-account"
              title={`Add another ${app.toolkitName} account`} aria-label={`Add another ${app.toolkitName} account`}
              disabled={props.connectingApps.has(app.toolkitSlug)} onClick={() => props.onAddAccount(app.toolkitSlug)}>
              {props.connectingApps.has(app.toolkitSlug) ? '…' : '+'}
            </button>
          </div>
        ))}
      </section>}

      <CustomConnectorSection
        connectors={props.customConnectors}
        onSignIn={props.onRetryConnector}
        onDisconnect={props.onDisconnectConnector}
      />
    </aside>
  );
}

function SessionSection({
  title,
  sessions,
  selectedSessionId,
  disabled,
  onSelect,
  emptyText,
}: {
  title: string;
  sessions: ChatSessionSummary[];
  selectedSessionId: string | null;
  disabled: boolean;
  onSelect: (sessionId: string) => void;
  emptyText: string;
}) {
  return (
    <section className="session-section">
      <div className="session-section-title">{title}</div>
      {sessions.length === 0 ? (
        <div className="session-section-empty">{emptyText}</div>
      ) : (
        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-list-item${session.id === selectedSessionId ? ' is-active' : ''}`}
              onClick={() => onSelect(session.id)}
              disabled={disabled}
            >
              <div className="session-list-item-head">
                <span className="session-list-item-title">{session.title}</span>
                <span className="session-list-item-time">
                  {formatRelativeTime(session.archivedAt ?? session.updatedAt)}
                </span>
              </div>
              <div className="session-list-item-preview">
                {session.lastMessagePreview || 'No messages yet'}
              </div>
              <div className="session-list-item-meta">
                {session.messageCount === 0 ? 'Empty' : `${session.messageCount} messages`}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function CustomConnectorSection({
  connectors,
  onSignIn,
  onDisconnect,
}: {
  connectors: CustomConnectorView[];
  onSignIn: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  if (connectors.length === 0) return null;
  return (
    <section className="session-section">
      <div className="session-section-title">Custom</div>
      <div className="custom-connector-list">
        {connectors.map((connector) => (
          <div className="custom-connector-row" key={connector.id}>
            {connector.logoUrl ? (
              <img
                className="custom-connector-logo"
                src={resolveSidecarUrl(connector.logoUrl) ?? connector.logoUrl}
                alt=""
                aria-hidden="true"
              />
            ) : (
              <span className="custom-connector-logo is-fallback" aria-hidden="true">
                {connector.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="custom-connector-main">
              <div className="custom-connector-name">
                <span className={`custom-connector-dot is-${connector.status.state}`}
                  role={connector.status.state === 'connecting' ? 'status' : undefined}
                  aria-label={connector.status.state === 'connecting' ? `Connecting to ${connector.name}` : undefined}
                  title={connector.status.state === 'connecting' ? 'Connecting…' : undefined} />
                <span>{connector.name}</span>
                <span className="custom-connector-tag">custom</span>
              </div>
              {connector.status.state !== 'connected' && connector.status.state !== 'connecting' && (
                <div className="custom-connector-status">{customConnectorStatusText(connector)}</div>
              )}
            </div>
            <div className="custom-connector-actions">
              {connector.status.state !== 'connected' && connector.status.state !== 'connecting' && (
                <button
                  type="button"
                  onClick={() => onSignIn(connector.id)}
                  aria-label={`Sign in to ${connector.name}`}
                >
                  Sign in
                </button>
              )}
              <button
                type="button"
                onClick={() => onDisconnect(connector.id)}
                aria-label={`Disconnect ${connector.name}`}
              >
                Disconnect
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function customConnectorStatusText(connector: CustomConnectorView): string {
  if (connector.status.state === 'connecting') return 'Connecting…';
  if (connector.status.state === 'pending_auth') return 'Waiting for sign-in';
  if (connector.status.state === 'connected') return 'Connected';
  return connector.status.reason;
}
