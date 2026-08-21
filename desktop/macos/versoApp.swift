import SwiftUI
import AppKit
import Combine
import Sparkle

@main
struct versoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
        .commands {
            CommandGroup(replacing: .appSettings) { }
            CommandGroup(after: .appInfo) {
                if appDelegate.runtimeConfiguration.enablesUpdates {
                    CheckForUpdatesView(updater: appDelegate.updater)
                }
            }
            #if DEBUG
            if appDelegate.runtimeConfiguration.enablesTelemetry {
                CommandMenu("Debug") {
                    Button("Send Test Event to Sentry") {
                        let testError = NSError(
                            domain: "verso.SentrySmokeTest",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Test event from Debug menu"]
                        )
                        Telemetry.reportError(testError, context: "sentry-smoke-test")
                    }
                }
            }
            #endif
        }
    }
}

private final class VersoMainWindow: NSWindow {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

private final class CheckForUpdatesViewModel: ObservableObject {
    @Published var canCheckForUpdates = false

    init(updater: SPUUpdater) {
        updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }
}

private struct CheckForUpdatesView: View {
    @ObservedObject private var viewModel: CheckForUpdatesViewModel
    private let updater: SPUUpdater

    init(updater: SPUUpdater) {
        self.updater = updater
        self.viewModel = CheckForUpdatesViewModel(updater: updater)
    }

    var body: some View {
        Button("Check for Updates…") {
            updater.checkForUpdates()
        }
            .disabled(!viewModel.canCheckForUpdates)
    }
}

private struct RootView: View {
    @ObservedObject var sidecar: SidecarManager
    @ObservedObject var managedSessionStore: ManagedSessionStore
    let runtimeConfiguration: VersoRuntimeConfiguration

    var body: some View {
        switch AppStartupPolicy.destination(
            configuration: runtimeConfiguration,
            isRestoringManagedSession: managedSessionStore.isRestoringPersistedSession,
            managedSession: managedSessionStore.currentSession
        ) {
        case .restoringManagedSession:
            ManagedSessionRestoringView()
        case .content:
            ContentView(sidecar: sidecar, managedSessionStore: managedSessionStore)
        case .managedSignIn:
            SignInView(
                managedSessionStore: managedSessionStore,
                frontendURL: runtimeConfiguration.managedFrontendURL
            )
        }
    }
}

private struct ManagedSessionRestoringView: View {
    @AppStorage("isDarkMode") private var isDarkMode = true

    private var theme: ConductorThemePalette {
        isDarkMode ? ConductorThemes.dark : ConductorThemes.light
    }

    var body: some View {
        ZStack {
            theme.mainCanvas.ignoresSafeArea()
            VStack(spacing: 14) {
                Text("verso.")
                    .font(.custom("IBM Plex Sans SemiBold", size: 13))
                    .foregroundStyle(theme.ink)
                ProgressView()
                    .controlSize(.small)
                    .tint(theme.inkDim)
            }
        }
        .preferredColorScheme(isDarkMode ? .dark : .light)
    }
}

private struct MainWindowContentView: View {
    @ObservedObject var sidecar: SidecarManager
    @ObservedObject var managedSessionStore: ManagedSessionStore
    @ObservedObject var updateUserDriver: VersoUpdateUserDriver
    let runtimeConfiguration: VersoRuntimeConfiguration

    var body: some View {
        RootView(
            sidecar: sidecar,
            managedSessionStore: managedSessionStore,
            runtimeConfiguration: runtimeConfiguration
        )
            .overlay(alignment: .bottomTrailing) {
                VersoUpdateToastOverlay(driver: updateUserDriver)
                    .padding(.trailing, 20)
                    .padding(.bottom, 20)
            }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Shared reference for code that can't reach the delegate via
    /// `NSApp.delegate` — SwiftUI's `@NSApplicationDelegateAdaptor` wraps our
    /// instance inside an internal `SwiftUI.AppDelegate`, so the usual cast
    /// returns nil. ChatWebView's bridge handler uses this to call into us.
    static private(set) weak var shared: AppDelegate?

    let updater: SPUUpdater
    let runtimeConfiguration: VersoRuntimeConfiguration

    private let sidecar: SidecarManager
    private let managedSessionStore: ManagedSessionStore
    private let updateUserDriver: VersoUpdateUserDriver
    private var cancellables: Set<AnyCancellable> = []
    private var didScheduleLaunchUpdateCheck = false

    /// Number of chat responses that completed while the app was in the
    /// background. Drives the dock badge; cleared whenever the user brings
    /// the app back to the foreground.
    private var pendingResponseCount = 0
    private weak var mainWindow: NSWindow?
    private var mainWindowController: NSWindowController?
    var registeredMainWindow: NSWindow? { mainWindow }

    override init() {
        let runtimeConfiguration = VersoRuntimeConfiguration.resolve()
        self.runtimeConfiguration = runtimeConfiguration
        self.sidecar = SidecarManager(runtimeConfiguration: runtimeConfiguration)
        self.managedSessionStore = ManagedSessionStore(
            isEnabled: runtimeConfiguration.requiresManagedSession
        )
        Telemetry.configure(configuration: runtimeConfiguration)

        let updateUserDriver = VersoUpdateUserDriver()
        self.updateUserDriver = updateUserDriver
        self.updater = SPUUpdater(
            hostBundle: Bundle.main,
            applicationBundle: Bundle.main,
            userDriver: updateUserDriver,
            delegate: nil
        )

        super.init()
        AppDelegate.shared = self

        if runtimeConfiguration.enablesUpdates {
            do {
                try updater.start()
            } catch {
                NSLog("Failed to start Sparkle updater: \(error.localizedDescription)")
                Telemetry.reportError(error, context: "sparkle-start")
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installStateObservers()
        createMainWindow()
        // ManagedSessionStore is the sole startup trigger. Its publisher emits
        // the restored session after the non-interactive Keychain lookup, so
        // the sidecar launches once with the correct account identity instead
        // of launching signed out and immediately restarting.
        if AppStartupPolicy.shouldStartSidecarAtLaunch(configuration: runtimeConfiguration) {
            sidecar.start()
        }
        scheduleLaunchUpdateCheckIfReady()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        pendingResponseCount = 0
        NSApp.dockTile.badgeLabel = nil
    }

    /// Called by ChatWebView when a chat stream finishes. Only nudges the
    /// user when they're in another app — silent when verso is frontmost.
    func notifyResponseReady() {
        guard !NSApp.isActive else { return }
        pendingResponseCount += 1
        NSApp.dockTile.badgeLabel = String(pendingResponseCount)
        NSSound(named: "Tink")?.play()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Belt to the orchestrator's parent-pid watcher's suspenders: if the
        // app is quitting normally, kill the child outright instead of waiting
        // for the watcher's 2s polling cycle.
        sidecar.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Quit when the last window closes so the sidecar exits with us.
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard runtimeConfiguration.requiresManagedSession else { return }
        guard !urls.isEmpty else { return }

        NSApp.activate(ignoringOtherApps: true)
        createMainWindow()
        mainWindow?.makeKeyAndOrderFront(nil)

        for url in urls {
            managedSessionStore.handleCallbackURL(url)
        }
    }

    private func installStateObservers() {
        sidecar.$state
            .sink { [weak self] _ in
                self?.scheduleLaunchUpdateCheckIfReady()
            }
            .store(in: &cancellables)

        if runtimeConfiguration.requiresManagedSession {
            managedSessionStore.$currentSession
                .removeDuplicates()
                .sink { [weak self] session in
                    self?.sidecar.updateManagedSession(session)
                }
                .store(in: &cancellables)
        }
    }

    private func createMainWindow() {
        if let mainWindow {
            mainWindow.makeKeyAndOrderFront(nil)
            return
        }

        let contentRect = NSRect(x: 0, y: 0, width: 1200, height: 750)
        let window = VersoMainWindow(
            contentRect: contentRect,
            styleMask: [.borderless, .resizable, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )

        let rootView = MainWindowContentView(
            sidecar: sidecar,
            managedSessionStore: managedSessionStore,
            updateUserDriver: updateUserDriver,
            runtimeConfiguration: runtimeConfiguration
        )
        let hostingView = NSHostingView(rootView: rootView)
        hostingView.frame = NSRect(origin: .zero, size: contentRect.size)
        hostingView.autoresizingMask = [.width, .height]
        window.contentView = hostingView

        configureWindow(window)
        window.center()
        window.isReleasedWhenClosed = false

        let windowController = NSWindowController(window: window)
        mainWindow = window
        mainWindowController = windowController
        windowController.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
    }

    private func configureWindow(_ window: NSWindow) {
        window.styleMask.insert(.resizable)
        window.styleMask.insert(.closable)
        window.styleMask.insert(.miniaturizable)
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.hasShadow = true
        window.backgroundColor = .clear

        // Match Conductor's subtle rounded window corners.
        if let contentView = window.contentView {
            contentView.wantsLayer = true
            contentView.layer?.cornerRadius = 10
            contentView.layer?.cornerCurve = .continuous
            contentView.layer?.masksToBounds = true
        }
    }

    private func scheduleLaunchUpdateCheckIfReady() {
        guard runtimeConfiguration.enablesUpdates else { return }
        guard !didScheduleLaunchUpdateCheck else { return }
        guard case .running = sidecar.state else { return }

        didScheduleLaunchUpdateCheck = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) {
            guard case .running = self.sidecar.state,
                  self.updater.automaticallyChecksForUpdates,
                  !self.updater.sessionInProgress else { return }
            self.updater.checkForUpdatesInBackground()
        }
    }
}
