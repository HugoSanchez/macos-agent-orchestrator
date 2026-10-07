import { useCallback, useEffect, useRef, useState } from 'react';
import { addCustomConnector, getCustomConnectorOAuthSettings, getToolkits, openCustomConnectorAuth, resolveSidecarUrl } from './chat';
import { displayToolkitName } from './display-names';
import type { CustomConnectorView, ToolkitView } from './types';

interface Props {
  isOpen: boolean;
  refreshToken: number;
  connectingToolkitSlugs: ReadonlySet<string>;
  onClose: () => void;
  onConnect: (toolkit: ToolkitView) => void;
  onCustomConnectorAdded?: (connector: CustomConnectorView) => void;
}

const DEFAULT_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 250;
const SCROLL_THRESHOLD_PX = 240;
const MIN_SEARCH_CHARS = 3;

export function CatalogOverlay({
  isOpen,
  refreshToken,
  connectingToolkitSlugs,
  onClose,
  onConnect,
  onCustomConnectorAdded,
}: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [toolkits, setToolkits] = useState<ToolkitView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customToken, setCustomToken] = useState('');
  const [customOAuth, setCustomOAuth] = useState(false);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [redirectCopied, setRedirectCopied] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  const fetchTokenRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const activePageSize = searchQuery ? SEARCH_PAGE_SIZE : DEFAULT_PAGE_SIZE;
  const canFetchMore = Boolean(searchQuery);

  useEffect(() => {
    if (!isOpen || !showCustomForm || !customOAuth) return;
    let active = true;
    void getCustomConnectorOAuthSettings()
      .then((settings) => { if (active) setRedirectUri(settings.redirectUri); })
      .catch((err: unknown) => { if (active) setCustomError(friendlyError(err)); });
    return () => { active = false; };
  }, [isOpen, showCustomForm, customOAuth]);

  // Debounce search input -> search query. Composio requires queries to be
  // at least MIN_SEARCH_CHARS long; shorter inputs fall back to the default
  // popular list rather than firing a request.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const trimmed = searchInput.trim();
      setSearchQuery(trimmed.length >= MIN_SEARCH_CHARS ? trimmed : '');
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // Reset and load page 1 when open or query changes.
  useEffect(() => {
    if (!isOpen) return;
    const token = ++fetchTokenRef.current;
    setIsLoading(true);
    setError(null);
    setToolkits([]);
    setNextCursor(null);

    void getToolkits({
      query: searchQuery || undefined,
      limit: activePageSize,
    })
      .then((result) => {
        if (token !== fetchTokenRef.current) return;
        setToolkits(result.toolkits);
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (token !== fetchTokenRef.current) return;
        setError(friendlyError(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setIsLoading(false);
        if (listRef.current) listRef.current.scrollTop = 0;
      });
  }, [isOpen, refreshToken, searchQuery, activePageSize]);

  const fetchMore = useCallback(() => {
    if (!canFetchMore || !nextCursor || isFetchingMore || isLoading) return;
    const token = fetchTokenRef.current;
    setIsFetchingMore(true);
    void getToolkits({
      query: searchQuery || undefined,
      cursor: nextCursor,
      limit: activePageSize,
    })
      .then((result) => {
        if (token !== fetchTokenRef.current) return;
        setToolkits((prev) => {
          const seen = new Set(prev.map((item) => item.slug));
          const additions = result.toolkits.filter((item) => !seen.has(item.slug));
          return prev.concat(additions);
        });
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (token !== fetchTokenRef.current) return;
        setError(friendlyError(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setIsFetchingMore(false);
      });
  }, [nextCursor, isFetchingMore, isLoading, searchQuery, activePageSize, canFetchMore]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight);
      if (distanceFromBottom < SCROLL_THRESHOLD_PX) fetchMore();
    },
    [fetchMore],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const submitCustomConnector = () => {
    if (customBusy) return;
    setCustomBusy(true);
    setCustomError(null);
    void addCustomConnector({
      name: customName.trim(),
      url: customUrl.trim(),
      ...(customOAuth
        ? { oauth: { clientId: customClientId.trim(), clientSecret: customClientSecret } }
        : customToken ? { token: customToken } : {}),
    })
      .then((connector) => {
        onCustomConnectorAdded?.(connector);
        if (connector.status.state === 'pending_auth') {
          openCustomConnectorAuth(connector.id);
        }
        setCustomName('');
        setCustomUrl('');
        setCustomToken('');
        setCustomOAuth(false);
        setCustomClientId('');
        setCustomClientSecret('');
        setRedirectCopied(false);
        setShowCustomForm(false);
      })
      .catch((err: unknown) => setCustomError(friendlyError(err)))
      .finally(() => setCustomBusy(false));
  };

  return (
    <div
      className="catalog-overlay-backdrop"
      data-no-window-drag
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="catalog-overlay" role="dialog" aria-label="Available connections">
        <header className="catalog-overlay-head">
          <div className="catalog-overlay-title">Available</div>
          <button
            className="catalog-overlay-close"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M1 1 L9 9 M9 1 L1 9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="catalog-overlay-search">
          <input
            type="text"
            className="catalog-overlay-search-input"
            placeholder="Search toolkits"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>

        {error && <div className="catalog-overlay-error">{error}</div>}

        <div
          className="catalog-overlay-list"
          ref={listRef}
          onScroll={handleScroll}
        >
          {isLoading && toolkits.length === 0 && (
            <div className="catalog-overlay-empty">Loading…</div>
          )}
          {!isLoading && !error && toolkits.length === 0 && (
            <div className="catalog-overlay-empty">
              {searchQuery ? `No toolkits matching “${searchQuery}”.` : 'No toolkits available.'}
              <button type="button" className="catalog-overlay-link" onClick={() => setShowCustomForm(true)}>
                Add a custom connector
              </button>
            </div>
          )}
          {toolkits.map((toolkit) => (
            <CatalogRow
              key={toolkit.slug}
              toolkit={toolkit}
              isConnecting={connectingToolkitSlugs.has(toolkit.slug)}
              onConnect={onConnect}
            />
          ))}
          {canFetchMore && isFetchingMore && (
            <div className="catalog-overlay-loading-more">Loading more…</div>
          )}
        </div>
        <footer className="catalog-custom">
          {!showCustomForm ? (
            <button type="button" className="catalog-custom-trigger" onClick={() => setShowCustomForm(true)}>
              Add a custom connector
            </button>
          ) : (
            <div className="catalog-custom-form">
              <input
                className="catalog-overlay-search-input"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="Name"
              />
              <input
                className="catalog-overlay-search-input"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                autoCapitalize="off"
              />
              {!customOAuth && <input
                className="catalog-overlay-search-input"
                value={customToken}
                onChange={(event) => setCustomToken(event.target.value)}
                placeholder="API token — leave empty for OAuth or public servers"
                type="password"
              />}
              <button type="button" className="catalog-custom-trigger" aria-expanded={customOAuth}
                disabled={customBusy} onClick={() => { setCustomOAuth(!customOAuth); setCustomError(null); }}>
                {customOAuth ? 'Hide OAuth settings' : 'OAuth settings (optional)'}
              </button>
              {customOAuth && <div className="catalog-custom-oauth">
                <p>For servers such as HubSpot that require you to register an OAuth app.</p>
                <label htmlFor="custom-oauth-redirect">Redirect URL</label>
                <div className="catalog-custom-redirect">
                  <input id="custom-oauth-redirect" className="catalog-overlay-search-input" readOnly
                    value={redirectUri} placeholder="Loading…" onFocus={(event) => event.target.select()} />
                  <button type="button" className="catalog-overlay-link" disabled={!redirectUri}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(redirectUri);
                        setRedirectCopied(true);
                      } catch {
                        setCustomError('Select the redirect URL and copy it with ⌘C.');
                      }
                    }}>{redirectCopied ? 'Copied' : 'Copy'}</button>
                </div>
                <p>Copy this URL into your provider’s OAuth app, then enter its credentials below.</p>
                <label htmlFor="custom-oauth-client-id">Client ID</label>
                <input id="custom-oauth-client-id" className="catalog-overlay-search-input"
                  value={customClientId} onChange={(event) => setCustomClientId(event.target.value)}
                  spellCheck={false} autoCapitalize="off" autoComplete="off" />
                <label htmlFor="custom-oauth-client-secret">Client secret</label>
                <input id="custom-oauth-client-secret" className="catalog-overlay-search-input" type="password"
                  value={customClientSecret} onChange={(event) => setCustomClientSecret(event.target.value)}
                  placeholder="If required by your provider" autoComplete="off" />
              </div>}
              {customError && <div className="catalog-overlay-error">{customError}</div>}
              <div className="catalog-custom-actions">
                <button type="button" className="catalog-row-pill is-connected" disabled={customBusy || !customName.trim() || !customUrl.trim() || (customOAuth && (!customClientId.trim() || !redirectUri))} onClick={submitCustomConnector}>
                  {customBusy ? 'Connecting…' : 'Connect'}
                </button>
                <button type="button" className="catalog-row-pill is-pending" disabled={customBusy} onClick={() => {
                  setShowCustomForm(false); setCustomToken(''); setCustomClientSecret('');
                }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The orchestrator forwards Composio's error envelope inline; strip JSON noise
  // so we surface a single human sentence rather than a raw payload.
  const jsonStart = raw.indexOf('{');
  if (jsonStart > -1) {
    return raw.slice(0, jsonStart).replace(/\(\d+\)/, '').replace(/[:\s]+$/, '').trim()
      || 'Failed to load toolkits.';
  }
  return raw || 'Failed to load toolkits.';
}

function CatalogRow({
  toolkit,
  isConnecting,
  onConnect,
}: {
  toolkit: ToolkitView;
  isConnecting: boolean;
  onConnect: (toolkit: ToolkitView) => void;
}) {
  const displayName = displayToolkitName(toolkit.name);

  return (
    <div className="catalog-row">
      {toolkit.logoUrl ? (
        <img
          className="catalog-row-logo"
          src={resolveSidecarUrl(toolkit.logoUrl) ?? toolkit.logoUrl}
          alt=""
          aria-hidden="true"
        />
      ) : (
        <div className="catalog-row-logo-fallback" aria-hidden="true">
          {displayName.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="catalog-row-name">{displayName}</div>
      <button
        type="button"
        className={`catalog-row-pill is-${toolkit.connected ? 'connected' : isConnecting ? 'connecting' : 'pending'}`}
        disabled={toolkit.connected || isConnecting}
        aria-busy={isConnecting}
        onClick={() => {
          if (!toolkit.connected && !isConnecting) onConnect(toolkit);
        }}
      >
        {toolkit.connected ? 'Connected' : isConnecting ? 'Connecting' : 'Connect'}
      </button>
    </div>
  );
}
