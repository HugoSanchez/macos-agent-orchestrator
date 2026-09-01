import SwiftUI
import WebKit
import AppKit

extension Notification.Name {
    static let versoRestoreKeyboardFocus = Notification.Name("verso.restoreKeyboardFocus")
}

private final class FocusableWKWebView: WKWebView {
    // Rectangles the user can press to drag the window, minus any holes that
    // must stay clickable. Kept in sync from JS via the `windowDragRegions`
    // bridge message. Coordinates are top-left CSS points (matching
    // getBoundingClientRect), which map 1:1 onto this view's AppKit points.
    // The WKWebView otherwise swallows the mouse events that
    // `NSWindow.isMovableByWindowBackground` would use, so dragging the window
    // from web content (e.g. the chat header) needs this explicit handoff.
    var windowDragRects: [CGRect] = []
    var windowNoDragRects: [CGRect] = []

    override var acceptsFirstResponder: Bool {
        true
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    private func isInWindowDragRegion(_ event: NSEvent) -> Bool {
        guard !windowDragRects.isEmpty else { return false }
        let local = convert(event.locationInWindow, from: nil)
        // getBoundingClientRect measures y from the top; AppKit points measure
        // from the bottom unless the view is flipped. Normalise to top-left.
        let point = isFlipped ? local : CGPoint(x: local.x, y: bounds.height - local.y)
        guard windowDragRects.contains(where: { $0.contains(point) }) else { return false }
        return !windowNoDragRects.contains(where: { $0.contains(point) })
    }

    override func mouseDown(with event: NSEvent) {
        if isInWindowDragRegion(event) {
            // Hand the press straight to the window manager so the drag tracks
            // exactly like a native title bar (and never selects text).
            window?.performDrag(with: event)
            return
        }
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let window = self.window,
                  window.isVisible,
                  NSApp.isActive || window.isKeyWindow else { return }
            window.makeFirstResponder(self)
        }
    }
}

// MARK: - Shell protocol
//
// Single wire format between the Swift shell and the chat-ui WebView. All
// product-level IPC is consolidated into three channels:
//
//   • Swift → JS: `verso:shell-state` carrying a full `ShellState` snapshot
//     of everything the chat-ui needs to render (sessions list, selection).
//   • Swift → JS: `verso:shell-command` for transient commands (open
//     overlays, navigate to a cron, etc.).
//   • JS → Swift: `chatBridge.postMessage({type: "action", action})` with a
//     single discriminated `ShellAction` payload.
//
// `desktop/chat-ui/src/shell-protocol.ts` contains the matching TS side.

/// Snapshot of everything the chat-ui's UI derives from. Last write wins;
/// pushed from Swift after every mutation that affects what the chat-ui
/// should render.
struct ShellState: Codable, Equatable {
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
}

/// SwiftUI wrapper around WKWebView that hosts the React chat app.
/// Passes the sidecar port to JS via `window.setSidecarPort(port)`.
struct ChatWebView: NSViewRepresentable {
    let sidecarPort: Int?
    let sidecarAuthToken: String?
    let draftApprovalToken: String?
    let isDarkMode: Bool
    let isCatalogOpen: Bool
    let isSkillsCatalogOpen: Bool
    let pendingCronOpen: CronOpenRequest?
    let pendingSettingsOpen: SettingsOpenRequest?
    // One-shot: dismiss any open page (settings/skill/cron) and return to the
    // chat surface. Fired when the active session is re-tapped in the leftbar.
    let pendingChatFocus: ChatFocusRequest?
    // Full shell-state snapshot pushed to JS on every change. The chat-ui
    // derives its session list + selection off this; Swift-side mutations
    // that change either bump the snapshot automatically via SwiftUI's
    // re-render. (Replaces the older nonced-token `sessionsChangedToken`
    // and per-mutation injection channels.)
    let shellState: ShellState?
    /// The single JS→Swift channel. All product actions cross this typed
    /// boundary; platform-only messages such as drag regions stay internal to
    /// the WebView coordinator.
    let onShellAction: ((ShellAction) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(onShellAction: onShellAction)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Allow fetch to localhost from file:// origin. With this enabled,
        // WebKit sends `Origin: file://` on sidecar requests — the exact value
        // the orchestrator's CORS allowlist expects (router.ts ALLOWED_ORIGINS).
        // Removing it changes the origin to "null" and breaks every chat fetch.
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(context.coordinator, name: "chatBridge")
        config.userContentController.addUserScript(WKUserScript(
            source: """
            (function() {
              if (window.__versoBridgeInstalled) return;
              window.__versoBridgeInstalled = true;
              window.__versoPendingSidecarPort = null;
              var assignedHandler = null;

              Object.defineProperty(window, 'setSidecarPort', {
                configurable: true,
                enumerable: true,
                get: function() { return assignedHandler; },
                set: function(fn) {
                  assignedHandler = fn;
                  var pending = window.__versoPendingSidecarPort;
                  if (typeof pending === 'number' && typeof assignedHandler === 'function') {
                    try { assignedHandler(pending); } catch (_) {}
                  }
                }
              });

              window.__versoApplySidecarPort = function(port, token) {
                window.__versoPendingSidecarPort = port;
                if (typeof token === 'string') {
                  window.__versoSidecarToken = token;
                }
              if (typeof assignedHandler === 'function') {
                try { assignedHandler(port); } catch (_) {}
              }
              };

              window.__versoShellMode = 'native';

              window.__versoPendingShellCommands = [];
              window.__versoShellCommandReady = false;
              window.__versoApplyShellCommand = function(command) {
                if (window.__versoShellCommandReady) {
                  window.dispatchEvent(new CustomEvent('verso:shell-command', { detail: command }));
                } else {
                  window.__versoPendingShellCommands.push(command);
                }
              };

              // Full snapshot from Swift. Swift pushes a fresh `ShellState`
              // after every durable shell mutation.
              window.__versoPendingShellState = null;
              window.__versoApplyShellState = function(state) {
                window.__versoPendingShellState = state || null;
                window.dispatchEvent(new CustomEvent('verso:shell-state', {
                  detail: window.__versoPendingShellState
                }));
              };
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let webView = FocusableWKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        // Load the bundled chat-ui
        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "chat-ui") {
            let dirURL = indexURL.deletingLastPathComponent()
            webView.loadFileURL(indexURL, allowingReadAccessTo: dirURL)
        } else {
            print("[ChatWebView] chat-ui/index.html not found in bundle")
            // Debug: list bundle resources
            if let resourcePath = Bundle.main.resourcePath {
                if let contents = try? FileManager.default.contentsOfDirectory(atPath: resourcePath) {
                    print("[ChatWebView] Bundle resources: \(contents)")
                } else {
                    print("[ChatWebView] Bundle resources could not be listed")
                }
            }
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // When sidecar port becomes available, inject it into JS
        if let port = sidecarPort,
           let authToken = sidecarAuthToken,
           let draftApprovalToken,
           port != context.coordinator.lastInjectedPort
            || authToken != context.coordinator.lastInjectedAuthToken
            || draftApprovalToken != context.coordinator.lastInjectedDraftApprovalToken {
            context.coordinator.pendingPort = port
            context.coordinator.pendingAuthToken = authToken
            context.coordinator.pendingDraftApprovalToken = draftApprovalToken
            if context.coordinator.pageLoaded {
                context.coordinator.injectSidecar(
                    port: port,
                    authToken: authToken,
                    draftApprovalToken: draftApprovalToken
                )
            }
        }

        if isCatalogOpen != context.coordinator.lastInjectedCatalogOpen {
            context.coordinator.pendingCatalogOpen = isCatalogOpen
            if context.coordinator.pageLoaded {
                context.coordinator.injectCatalogState(isCatalogOpen)
            }
        }

        if isSkillsCatalogOpen != context.coordinator.lastInjectedSkillsCatalogOpen {
            context.coordinator.pendingSkillsCatalogOpen = isSkillsCatalogOpen
            if context.coordinator.pageLoaded {
                context.coordinator.injectSkillsCatalogState(isSkillsCatalogOpen)
            }
        }

        // Cron-open requests are nonced (UUID per click) so re-clicking the
        // same cron after navigating away still re-fires the JS event.
        if let request = pendingCronOpen, request.token != context.coordinator.lastInjectedCronToken {
            context.coordinator.pendingCronOpen = request
            if context.coordinator.pageLoaded {
                context.coordinator.injectOpenCron(request)
            }
        }

        // Settings-open requests follow the same nonced-token pattern so
        // clicking the gear after leaving Settings still re-opens it.
        if let request = pendingSettingsOpen, request.token != context.coordinator.lastInjectedSettingsToken {
            context.coordinator.pendingSettingsOpen = request
            if context.coordinator.pageLoaded {
                context.coordinator.injectOpenSettings(request)
            }
        }

        // Chat-focus requests are nonced too, so re-tapping the active session
        // re-fires even when nothing about the selection changed.
        if let request = pendingChatFocus, request.token != context.coordinator.lastInjectedChatFocusToken {
            context.coordinator.pendingChatFocus = request
            if context.coordinator.pageLoaded {
                context.coordinator.injectFocusChat(request)
            }
        }

        // Shell-state snapshot. Pushed on every change so the chat-ui renders
        // from one durable source of truth.
        if let state = shellState, state != context.coordinator.lastInjectedShellState {
            context.coordinator.pendingShellState = state
            if context.coordinator.pageLoaded {
                context.coordinator.injectShellState(state)
            }
        }

        // Update color scheme
        if isDarkMode != context.coordinator.lastDarkMode {
            context.coordinator.lastDarkMode = isDarkMode
            let scheme = isDarkMode ? "dark" : "light"
            webView.evaluateJavaScript(
                "document.documentElement.style.colorScheme = '\(scheme)';",
                completionHandler: nil
            )
        }
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onShellAction: ((ShellAction) -> Void)?
        weak var webView: WKWebView?
        var lastInjectedPort: Int?
        var pendingPort: Int?
        var lastInjectedAuthToken: String?
        var pendingAuthToken: String?
        var lastInjectedDraftApprovalToken: String?
        var pendingDraftApprovalToken: String?
        var lastInjectedCatalogOpen: Bool?
        var pendingCatalogOpen: Bool = false
        var lastInjectedSkillsCatalogOpen: Bool?
        var pendingSkillsCatalogOpen: Bool = false
        var lastInjectedCronToken: UUID?
        var pendingCronOpen: CronOpenRequest?
        var lastInjectedSettingsToken: UUID?
        var pendingSettingsOpen: SettingsOpenRequest?
        var lastInjectedChatFocusToken: UUID?
        var pendingChatFocus: ChatFocusRequest?
        var lastInjectedShellState: ShellState?
        var pendingShellState: ShellState?
        var lastDarkMode: Bool?
        var pageLoaded = false

        init(onShellAction: ((ShellAction) -> Void)?) {
            self.onShellAction = onShellAction
            super.init()
            // When the system is about to sleep we tell the webview's JS to
            // stop its polling intervals. Resume on wake. NSWorkspace fires
            // these for lid-close and idle-sleep alike, which is exactly the
            // PowerNap window where we want zero CPU activity.
            let center = NSWorkspace.shared.notificationCenter
            center.addObserver(
                self,
                selector: #selector(handleSystemSleep),
                name: NSWorkspace.willSleepNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(handleSystemWake),
                name: NSWorkspace.didWakeNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleAppDidBecomeActive),
                name: NSApplication.didBecomeActiveNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleRestoreKeyboardFocus),
                name: .versoRestoreKeyboardFocus,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleWindowDidBecomeKeyOrMain(_:)),
                name: NSWindow.didBecomeKeyNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleWindowDidBecomeKeyOrMain(_:)),
                name: NSWindow.didBecomeMainNotification,
                object: nil
            )
        }

        deinit {
            NSWorkspace.shared.notificationCenter.removeObserver(self)
            NotificationCenter.default.removeObserver(self)
        }

        @objc private func handleSystemSleep() {
            injectSystemSleep()
        }

        @objc private func handleSystemWake() {
            injectSystemWake()
            recoverKeyboardFocus()
        }

        @objc private func handleAppDidBecomeActive() {
            recoverKeyboardFocus()
        }

        @objc private func handleRestoreKeyboardFocus() {
            recoverKeyboardFocus(after: 0.05)
        }

        @objc private func handleWindowDidBecomeKeyOrMain(_ notification: Notification) {
            guard let webView,
                  let window = notification.object as? NSWindow,
                  window === webView.window else { return }
            recoverKeyboardFocus(after: 0.05)
        }

        func injectSystemSleep() {
            guard let webView, pageLoaded else { return }
            webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('verso:system-sleep'));",
                completionHandler: nil
            )
        }

        func injectSystemWake() {
            guard let webView, pageLoaded else { return }
            webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('verso:system-wake'));",
                completionHandler: nil
            )
        }

        private func recoverKeyboardFocus(after delay: TimeInterval = 0.25) {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self,
                      let webView = self.webView,
                      self.pageLoaded,
                      let window = webView.window,
                      window.isVisible else { return }

                if NSApp.isActive || window.isKeyWindow {
                    if NSApp.isActive && !window.isKeyWindow {
                        window.makeKey()
                    }
                    window.makeFirstResponder(webView)
                }

                webView.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('verso:restore-chat-focus'));",
                    completionHandler: nil
                )
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageLoaded = true
            if let port = pendingPort ?? lastInjectedPort,
               let authToken = pendingAuthToken ?? lastInjectedAuthToken,
               let draftApprovalToken = pendingDraftApprovalToken ?? lastInjectedDraftApprovalToken {
                injectSidecar(
                    port: port,
                    authToken: authToken,
                    draftApprovalToken: draftApprovalToken
                )
            }
            injectCatalogState(pendingCatalogOpen)
            injectSkillsCatalogState(pendingSkillsCatalogOpen)
            if let request = pendingCronOpen {
                injectOpenCron(request)
            }
            if let request = pendingSettingsOpen {
                injectOpenSettings(request)
            }
            if let request = pendingChatFocus {
                injectFocusChat(request)
            }
            if let state = pendingShellState {
                injectShellState(state)
            }
            recoverKeyboardFocus()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[ChatWebView] Navigation failed: \(error)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[ChatWebView] Provisional navigation failed: \(error)")
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            let scheme = url.scheme?.lowercased()
            let isExternalWebURL = scheme == "http" || scheme == "https"
            let isMainFrameNavigation = navigationAction.targetFrame?.isMainFrame ?? true

            if isExternalWebURL && isMainFrameNavigation {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            decisionHandler(.allow)
        }

        func injectSidecar(port: Int, authToken: String, draftApprovalToken: String) {
            guard let webView else { return }
            guard let tokenLiteral = Self.javascriptStringLiteral(authToken) else { return }
            guard let draftApprovalTokenLiteral = Self.javascriptStringLiteral(draftApprovalToken) else { return }
            let js = """
            (function() {
              window.__versoSidecarPort = \(port);
              window.__versoSidecarToken = \(tokenLiteral);
              window.__versoDraftApprovalToken = \(draftApprovalTokenLiteral);
              if (typeof window.__versoApplySidecarPort === 'function') {
                window.__versoApplySidecarPort(\(port), \(tokenLiteral));
              }
              if (typeof window.setSidecarPort === 'function') {
                window.setSidecarPort(\(port));
              }
              window.dispatchEvent(new CustomEvent('verso:sidecar-port', { detail: {
                port: \(port),
                token: \(tokenLiteral),
                draftApprovalToken: \(draftApprovalTokenLiteral)
              } }));
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject sidecar credentials: \(error.localizedDescription)")
                }
            }
            lastInjectedPort = port
            lastInjectedAuthToken = authToken
            lastInjectedDraftApprovalToken = draftApprovalToken
            pendingPort = port
            pendingAuthToken = authToken
            pendingDraftApprovalToken = draftApprovalToken
        }

        private static func javascriptStringLiteral(_ value: String) -> String? {
            guard let data = try? JSONSerialization.data(withJSONObject: [value]),
                  let json = String(data: data, encoding: .utf8),
                  json.count >= 2 else { return nil }
            return String(json.dropFirst().dropLast())
        }

        func injectCatalogState(_ open: Bool) {
            injectShellCommand(open ? .openCatalog : .closeCatalog)
            pendingCatalogOpen = open
            lastInjectedCatalogOpen = open
        }

        func injectOpenCron(_ request: CronOpenRequest) {
            injectShellCommand(.openCron(id: request.id))
            lastInjectedCronToken = request.token
        }

        func injectShellState(_ state: ShellState) {
            guard let webView else { return }
            // ShellState is `Codable`; the resulting JSON is a valid JS
            // expression so we can splice it directly into the call.
            let encoder = JSONEncoder()
            // Stable key ordering keeps the equality check upstream cheap
            // (string compare of last-injected JSON, if we ever want it).
            encoder.outputFormatting = [.sortedKeys]
            guard let data = try? encoder.encode(state),
                  let json = String(data: data, encoding: .utf8) else {
                print("[ChatWebView] Failed to encode ShellState")
                return
            }
            let js = """
            (function() {
              if (typeof window.__versoApplyShellState === 'function') {
                window.__versoApplyShellState(\(json));
              } else {
                window.__versoPendingShellState = \(json);
              }
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject shell state: \(error.localizedDescription)")
                }
            }
            pendingShellState = state
            lastInjectedShellState = state
        }

        func injectOpenSettings(_ request: SettingsOpenRequest) {
            injectShellCommand(.openSettings)
            lastInjectedSettingsToken = request.token
        }

        func injectFocusChat(_ request: ChatFocusRequest) {
            injectShellCommand(.focusChat)
            lastInjectedChatFocusToken = request.token
        }

        func injectSkillsCatalogState(_ open: Bool) {
            injectShellCommand(open ? .openSkillsCatalog : .closeSkillsCatalog)
            pendingSkillsCatalogOpen = open
            lastInjectedSkillsCatalogOpen = open
        }

        private func injectShellCommand(_ command: ShellCommand) {
            guard let webView else { return }
            let payload: [String: Any]
            switch command {
            case .openCatalog: payload = ["kind": "open-catalog"]
            case .closeCatalog: payload = ["kind": "close-catalog"]
            case .openSkillsCatalog: payload = ["kind": "open-skills-catalog"]
            case .closeSkillsCatalog: payload = ["kind": "close-skills-catalog"]
            case .openCron(let id): payload = ["kind": "open-cron", "id": id]
            case .openSettings: payload = ["kind": "open-settings"]
            case .focusChat: payload = ["kind": "focus-chat"]
            }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            let js = """
            (function() {
              if (typeof window.__versoApplyShellCommand === 'function') {
                window.__versoApplyShellCommand(\(json));
              } else {
                window.dispatchEvent(new CustomEvent('verso:shell-command', { detail: \(json) }));
              }
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject shell command: \(error.localizedDescription)")
                }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "chatBridge",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                return
            }

            if type == "windowDragRegions" {
                // Runs on the main thread (WKScriptMessageHandler callback), so
                // it's safe to mutate the view's drag rects directly.
                if let webView = webView as? FocusableWKWebView {
                    webView.windowDragRects = Coordinator.parseRects(body["drag"])
                    webView.windowNoDragRects = Coordinator.parseRects(body["noDrag"])
                }
                return
            }

            if type == "notifyResponseReady" {
                DispatchQueue.main.async {
                    AppDelegate.shared?.notifyResponseReady()
                }
                return
            }

            // Consolidated JS→Swift product-action channel.
            if type == "action",
               let payload = body["action"] as? [String: Any],
               let action = ShellActionDecoder.decode(payload) {
                DispatchQueue.main.async { [onShellAction] in
                    onShellAction?(action)
                }
                return
            }
        }

        /// Decodes an array of `{x, y, width, height}` objects (JS numbers
        /// arrive as `NSNumber`) into `CGRect`s. Malformed entries are skipped.
        static func parseRects(_ raw: Any?) -> [CGRect] {
            guard let array = raw as? [[String: Any]] else { return [] }
            return array.compactMap { dict in
                guard let x = (dict["x"] as? NSNumber)?.doubleValue,
                      let y = (dict["y"] as? NSNumber)?.doubleValue,
                      let width = (dict["width"] as? NSNumber)?.doubleValue,
                      let height = (dict["height"] as? NSNumber)?.doubleValue else {
                    return nil
                }
                return CGRect(x: x, y: y, width: width, height: height)
            }
        }

    }
}

private extension String {
    var jsEscaped: String {
        self
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
    }
}
