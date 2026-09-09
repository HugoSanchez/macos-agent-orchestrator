// Narrow host bridge for OS file selection. Workspace import needs real
// filesystem paths (the sidecar copies the files server-side), which web
// file inputs cannot provide — so the native host shows its open panel and
// reports the chosen paths back via a `verso:native-files-chosen` event.
//
// This is a platform capability, not a product action, so it bypasses the
// ShellAction channel the same way `windowDragRegions` does. A future
// Electron host replaces the postMessage/event transport with an
// ipcRenderer round-trip; callers only ever see the Promise API.

let nextRequestId = 0;

export function canPickNativeFiles(): boolean {
  return typeof window.webkit?.messageHandlers?.chatBridge?.postMessage === 'function';
}

/** Resolves with the chosen absolute paths, or [] when the user cancels. */
export function pickNativeFiles(options: { prompt: string; message: string }): Promise<string[]> {
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  if (!bridge) return Promise.resolve([]);

  const requestId = `pick-${++nextRequestId}`;
  return new Promise((resolve) => {
    const onChosen = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: unknown; paths?: unknown }>).detail;
      if (detail?.requestId !== requestId) return;
      window.removeEventListener('verso:native-files-chosen', onChosen as EventListener);
      resolve(Array.isArray(detail.paths)
        ? detail.paths.filter((path): path is string => typeof path === 'string')
        : []);
    };
    window.addEventListener('verso:native-files-chosen', onChosen as EventListener);
    bridge.postMessage({ type: 'chooseFiles', requestId, ...options });
  });
}
