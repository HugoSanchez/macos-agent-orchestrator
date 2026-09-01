import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createConnectionRequest,
  disconnectCustomConnector,
  getAnthropicStatus,
  getCodexStatus,
  getConnectionRequest,
  getConnections,
  getCustomConnectors,
  getSidecarPort,
  getToolkits,
  openConnectionRequest,
  openCustomConnectorAuth,
  retryCustomConnector,
  setSidecarAuthToken,
  setDraftApprovalToken,
  setSidecarPort,
} from './chat';
import { postShellAction } from './shell-bridge';
import type {
  ConnectionRequestView,
  ConnectionView,
  CustomConnectorView,
  ToolkitView,
} from './types';

export interface UseSidecarResourcesOptions {
  onError: (message: string) => void;
}

export function useSidecarResources({ onError }: UseSidecarResourcesOptions) {
  const [connected, setConnected] = useState(false);
  const [codexConnected, setCodexConnected] = useState<boolean | null>(null);
  const [anthropicConnected, setAnthropicConnected] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [customConnectors, setCustomConnectors] = useState<CustomConnectorView[]>([]);
  const [toolkitCatalog, setToolkitCatalog] = useState<ToolkitView[]>([]);
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);
  const [connectingToolkitSlugs, setConnectingToolkitSlugs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const connectingToolkitSlugsRef = useRef<Set<string>>(new Set());
  const connectionPollers = useRef<Map<string, number>>(new Map());

  const bumpCatalogRefresh = useCallback(() => {
    setCatalogRefreshToken((value) => value + 1);
  }, []);

  const refreshConnections = useCallback(async (opts: { fast?: boolean } = {}) => {
    if (!getSidecarPort()) return;
    try {
      const result = await getConnections(opts);
      setConnections(result.connections);
      setCustomConnectors(await getCustomConnectors());
    } catch {
      // Best-effort: retain the last good snapshot during a sidecar restart.
    }
  }, []);

  const refreshModelStatus = useCallback(async () => {
    if (!getSidecarPort()) return;
    try {
      const next = await getCodexStatus();
      setCodexConnected(next.connected);
    } catch {
      // Unknown is safer than turning a transient failure into a send block.
    }
    try {
      const anthropic = await getAnthropicStatus();
      setAnthropicConnected(anthropic.connected);
    } catch {
      // Same best-effort stance as Codex.
    }
  }, []);

  const refreshToolkitCatalog = useCallback(async () => {
    if (!getSidecarPort()) return;
    try {
      const collected: ToolkitView[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await getToolkits({
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...result.toolkits);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      setToolkitCatalog(collected);
    } catch {
      // Tool rows fall back to initial-letter badges.
    }
  }, []);

  const pollConnectionRequest = useCallback((
    requestId: string,
    onUpdate?: (request: ConnectionRequestView) => void,
    onSettled?: () => void,
  ) => {
    const existing = connectionPollers.current.get(requestId);
    if (existing) window.clearInterval(existing);

    const poller = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getConnectionRequest(requestId);
          onUpdate?.(next);
          if (next.status === 'pending') return;

          window.clearInterval(poller);
          connectionPollers.current.delete(requestId);
          await refreshConnections();
          bumpCatalogRefresh();
          postShellAction({ kind: 'connections-changed' });
        } catch {
          window.clearInterval(poller);
          connectionPollers.current.delete(requestId);
        } finally {
          if (!connectionPollers.current.has(requestId)) onSettled?.();
        }
      })();
    }, 1500);

    connectionPollers.current.set(requestId, poller);
  }, [bumpCatalogRefresh, refreshConnections]);

  const connectToolkit = useCallback((toolkit: { slug: string }) => {
    const toolkitSlug = toolkit.slug;
    if (connectingToolkitSlugsRef.current.has(toolkitSlug)) return;

    connectingToolkitSlugsRef.current.add(toolkitSlug);
    setConnectingToolkitSlugs(new Set(connectingToolkitSlugsRef.current));

    const finishConnecting = () => {
      connectingToolkitSlugsRef.current.delete(toolkitSlug);
      setConnectingToolkitSlugs(new Set(connectingToolkitSlugsRef.current));
    };

    void (async () => {
      try {
        const request = await createConnectionRequest(toolkitSlug);
        bumpCatalogRefresh();
        if (request.status === 'pending') {
          openConnectionRequest(request.id);
          pollConnectionRequest(request.id, undefined, finishConnecting);
          return;
        }
        await refreshConnections();
        bumpCatalogRefresh();
        postShellAction({ kind: 'connections-changed' });
        finishConnecting();
      } catch (error: unknown) {
        finishConnecting();
        onError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [bumpCatalogRefresh, onError, pollConnectionRequest, refreshConnections]);

  const retryConnector = useCallback((id: string) => {
    void retryCustomConnector(id)
      .then((connector) => {
        if (connector.status.state === 'pending_auth') openCustomConnectorAuth(connector.id);
      })
      .catch(() => {})
      .then(() => refreshConnections());
  }, [refreshConnections]);

  const disconnectConnector = useCallback((id: string) => {
    setCustomConnectors((current) => current.filter((connector) => connector.id !== id));
    void disconnectCustomConnector(id)
      .catch(() => {})
      .then(() => refreshConnections());
  }, [refreshConnections]);

  useEffect(() => {
    const clearConnectionPollers = () => {
      for (const handle of connectionPollers.current.values()) window.clearInterval(handle);
      connectionPollers.current.clear();
      connectingToolkitSlugsRef.current.clear();
      setConnectingToolkitSlugs(new Set());
    };
    window.addEventListener('verso:system-sleep', clearConnectionPollers);
    return () => window.removeEventListener('verso:system-sleep', clearConnectionPollers);
  }, []);

  useEffect(() => {
    if (!connected) return;
    const awaitingLiveStatus = customConnectors.some((connector) => (
      connector.status.state === 'pending_auth'
      || (connector.status.state === 'connected' && connector.status.cached === true)
    ));
    if (!awaitingLiveStatus) return;
    const timer = window.setInterval(() => { void refreshConnections(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [connected, customConnectors, refreshConnections]);

  useEffect(() => {
    const onModelAuthChanged = () => { void refreshModelStatus(); };
    window.addEventListener('verso:model-auth-changed', onModelAuthChanged);
    return () => window.removeEventListener('verso:model-auth-changed', onModelAuthChanged);
  }, [refreshModelStatus]);

  useEffect(() => {
    const applyPort = (port: number) => {
      setSidecarPort(port);
      setSidecarAuthToken(window.__versoSidecarToken);
      setDraftApprovalToken(window.__versoDraftApprovalToken);
      setConnected(true);
      void refreshConnections({ fast: true }).then(() => refreshConnections());
      void refreshToolkitCatalog();
      void refreshModelStatus();
      window.dispatchEvent(new CustomEvent('verso:sidecar-port-ready', { detail: { port } }));
    };

    window.setSidecarPort = (port: number) => {
      window.__versoSidecarPort = port;
      applyPort(port);
    };

    if (typeof window.__versoSidecarPort === 'number' && window.__versoSidecarPort > 0) {
      applyPort(window.__versoSidecarPort);
    }

    const onPortEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        port?: unknown;
        token?: unknown;
        draftApprovalToken?: unknown;
      }>).detail;
      const port = typeof detail?.port === 'number' ? detail.port : Number(detail?.port);
      if (!Number.isFinite(port) || port <= 0) return;
      if (typeof detail?.token === 'string') window.__versoSidecarToken = detail.token;
      if (typeof detail?.draftApprovalToken === 'string') {
        window.__versoDraftApprovalToken = detail.draftApprovalToken;
      }
      window.__versoSidecarPort = port;
      applyPort(port);
    };
    window.addEventListener('verso:sidecar-port', onPortEvent as EventListener);

    const devPort = new URLSearchParams(window.location.search).get('port');
    if (devPort) {
      const parsed = Number.parseInt(devPort, 10);
      if (Number.isFinite(parsed) && parsed > 0) applyPort(parsed);
    }

    return () => {
      window.removeEventListener('verso:sidecar-port', onPortEvent as EventListener);
      window.setSidecarPort = undefined;
      for (const poller of connectionPollers.current.values()) window.clearInterval(poller);
      connectionPollers.current.clear();
    };
  }, [refreshConnections, refreshModelStatus, refreshToolkitCatalog]);

  return {
    connected,
    codexConnected,
    anthropicConnected,
    connections,
    customConnectors,
    toolkitCatalog,
    catalogRefreshToken,
    connectingToolkitSlugs,
    setCodexConnected,
    refreshConnections,
    refreshModelStatus,
    bumpCatalogRefresh,
    pollConnectionRequest,
    connectToolkit,
    retryConnector,
    disconnectConnector,
  };
}
