import Foundation
import os
import Security
import CryptoKit

/// Manages the local Node.js sidecar process lifecycle.
@MainActor
final class SidecarManager: ObservableObject {
    typealias ManagedAccountSnapshot = SidecarManagedAccountSnapshot

    enum State: Equatable {
        case idle
        case starting
        case running(port: Int)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var managedSession: ManagedAppSession?
    @Published private(set) var managedAccount: ManagedAccountSnapshot?
    @Published private(set) var authToken: String?
    @Published private(set) var draftApprovalToken: String?

    private var activityToken: NSObjectProtocol?
    private var stopRequested = false
    private var launchGeneration = 0
    private var restartTask: Task<Void, Never>?
    private var restartAttempts = 0
    private let restartPolicy = SidecarRestartPolicy.standard
    private let processController: SidecarProcessController
    private let httpTransport: any SidecarHTTPTransport
    private let runtimeConfiguration: VersoRuntimeConfiguration
    private let logger = Logger(subsystem: "com.verso.app", category: "Sidecar")

    init(
        runtimeConfiguration: VersoRuntimeConfiguration = .resolve(),
        processController: SidecarProcessController? = nil,
        httpTransport: any SidecarHTTPTransport = URLSession.shared
    ) {
        self.runtimeConfiguration = runtimeConfiguration
        self.processController = processController ?? SidecarProcessController(
            logFileURL: SidecarProcessController.defaultLogFileURL
        )
        self.httpTransport = httpTransport
    }

    /// Path to the on-disk sidecar log. Returned even before the sidecar
    /// starts so the UI can offer a "reveal in Finder" affordance.
    static var logFileURL: URL {
        SidecarProcessController.defaultLogFileURL
    }

    var port: Int? {
        if case .running(let port) = state {
            return port
        }
        return nil
    }

    var baseURL: URL? {
        port.map { URL(string: "http://127.0.0.1:\($0)")! }
    }

    func updateManagedSession(_ session: ManagedAppSession?) {
        guard runtimeConfiguration.requiresManagedSession else {
            managedSession = nil
            managedAccount = nil
            return
        }
        let previousUserId = managedSession?.userId
        managedSession = session
        if let session {
            logger.info("Managed backend session updated for user \(session.userId, privacy: .public)")
        } else {
            logger.info("Managed backend session cleared")
        }
        switch SidecarManagedSessionPolicy.action(
            isSidecarRunning: port != nil,
            previousUserId: previousUserId,
            nextUserId: session?.userId
        ) {
        case .restart:
            Task {
                await clearManagedSessionBeforeRestart()
                restart()
            }
        case .synchronize:
            Task {
                await pushManagedSession(session)
                await refreshManagedAccount()
            }
        case .clearLocal:
            managedAccount = nil
        case .start:
            start()
        }
    }

    func start() {
        guard state == .idle || {
            if case .failed = state { return true }
            return false
        }() else { return }

        stopRequested = false
        launchGeneration += 1
        let generation = launchGeneration
        let launchManagedSession = managedSession
        beginActivityIfNeeded()
        state = .starting

        Task {
            do {
                let launchAuthToken = try Self.generateAuthToken()
                let launchDraftApprovalToken = try Self.generateAuthToken()
                self.authToken = launchAuthToken
                self.draftApprovalToken = launchDraftApprovalToken
                let detectedPort = try await launchProcess(managedSession: launchManagedSession)
                guard generation == launchGeneration, !stopRequested else { return }
                state = .running(port: detectedPort)
                restartAttempts = 0
                logger.info("Sidecar running on port \(detectedPort)")

                // A callback, token refresh, or sign-out can still arrive
                // while the process is starting. Do not let that launch keep
                // running under an obsolete identity. A same-user token
                // refresh can be applied live; an identity change requires a
                // serialized restart so all local state remains isolated.
                if SidecarManagedSessionPolicy.requiresRestart(
                    previousUserId: launchManagedSession?.userId,
                    nextUserId: managedSession?.userId
                ) {
                    restart()
                    return
                }
                // The managed bearer is intentionally absent from the child
                // environment. Seed it into orchestrator memory only after
                // the authenticated loopback server is ready.
                await pushManagedSession(managedSession)
                await refreshManagedAccount()
            } catch {
                guard generation == launchGeneration, !stopRequested else { return }
                authToken = nil
                draftApprovalToken = nil
                state = .failed(error.localizedDescription)
                logger.error("Sidecar failed: \(error.localizedDescription)")
                Telemetry.reportError(error, context: "sidecar-launch")
                scheduleRestart()
            }
        }
    }

    func stop() {
        restartTask?.cancel()
        restartTask = nil
        stopRequested = true
        launchGeneration += 1
        if processController.isRunning {
            logger.info("Sidecar stopped")
        }
        processController.stopImmediately()
        endActivityIfNeeded()
        managedAccount = nil
        authToken = nil
        draftApprovalToken = nil
        state = .idle
    }

    private func restart() {
        guard restartTask == nil else { return }
        restartTask = Task { [weak self] in
            guard let self else { return }
            defer { self.restartTask = nil }

            let stopped = await self.stopCurrentProcessForRestart()
            guard stopped, !Task.isCancelled else { return }

            self.stopRequested = false
            self.state = .idle
            self.start()
        }
    }

    /// Stop the complete sidecar-owned process tree before starting its
    /// replacement. The sidecar awaits Hermes shutdown, so its exit is the
    /// ownership boundary that guarantees the stable gateway port has been
    /// released. Starting immediately after `Process.terminate()` used to
    /// overlap two Hermes gateways whenever Keychain session restoration
    /// completed shortly after app launch.
    private func stopCurrentProcessForRestart() async -> Bool {
        stopRequested = true
        launchGeneration += 1
        state = .starting

        if processController.isRunning {
            logger.info("Stopping sidecar before restart")
        }
        guard await processController.stopGracefully() else {
            authToken = nil
            draftApprovalToken = nil
            state = .failed("The previous sidecar process did not stop. Quit and reopen Verso before retrying.")
            logger.error("Sidecar process did not exit before restart")
            return false
        }
        managedAccount = nil
        authToken = nil
        draftApprovalToken = nil
        return true
    }

    func refreshManagedAccount() async {
        guard runtimeConfiguration.requiresManagedSession else {
            managedAccount = nil
            return
        }
        guard let baseURL, let authToken else {
            managedAccount = nil
            return
        }
        do {
            let client = SidecarHTTPClient(
                baseURL: baseURL,
                authToken: authToken,
                transport: httpTransport
            )
            managedAccount = try await client.fetchManagedAccount()
        } catch {
            logger.error("Managed account refresh failed: \(error.localizedDescription, privacy: .public)")
            Telemetry.reportError(error, context: "managed-account-refresh")
        }
    }

    /// Push the current managed session into the orchestrator's in-memory store
    /// over loopback IPC. The orchestrator never persists the bearer token; on
    /// sidecar restart we re-seed via env vars in `launchProcess`.
    private func pushManagedSession(_ session: ManagedAppSession?) async {
        guard runtimeConfiguration.requiresManagedSession else { return }
        guard let baseURL, let authToken else { return }
        do {
            let client = SidecarHTTPClient(
                baseURL: baseURL,
                authToken: authToken,
                transport: httpTransport
            )
            if let session {
                try await client.setManagedSession(session)
            } else {
                try await client.clearManagedSession()
            }
        } catch {
            logger.error("Managed session push failed: \(error.localizedDescription, privacy: .public)")
            Telemetry.reportError(error, context: "managed-session-push")
        }
    }

    private func clearManagedSessionBeforeRestart() async {
        guard baseURL != nil else { return }
        await pushManagedSession(nil)
    }

    /// Tell macOS this app is doing a long-running, user-initiated task so
    /// App Nap / RunningBoard don't aggressively reap our child Node process.
    /// We don't disable system sleep — only App Nap & sudden/automatic
    /// termination. Symptom this addresses: sidebar going empty after a
    /// minute of idle while the app is in the background, because macOS
    /// SIGTERM'd the orchestrator.
    private func beginActivityIfNeeded() {
        guard activityToken == nil else { return }
        activityToken = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "verso orchestrator must run continuously to serve the chat UI"
        )
    }

    private func endActivityIfNeeded() {
        if let activityToken {
            ProcessInfo.processInfo.endActivity(activityToken)
        }
        activityToken = nil
    }

    /// Auto-restart on unexpected exit. Backs off exponentially up to a cap;
    /// resets the counter on a successful start. If `stop()` was called
    /// explicitly, we never restart.
    private func scheduleRestart() {
        guard !stopRequested else { return }
        guard restartAttempts < restartPolicy.maximumAttempts else {
            logger.error("Sidecar restart attempts exhausted (\(self.restartPolicy.maximumAttempts)). Giving up.")
            return
        }
        restartAttempts += 1
        guard let delay = restartPolicy.delay(forAttempt: restartAttempts) else { return }
        logger.info("Restarting sidecar (attempt \(self.restartAttempts)) in \(delay, format: .fixed(precision: 2))s")
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.stopRequested else { return }
            // Force re-entry: start() requires .idle or .failed; we're in
            // .failed now, so the guard passes.
            self.start()
        }
    }

    private func launchProcess(managedSession launchManagedSession: ManagedAppSession?) async throws -> Int {
        let environment = ProcessInfo.processInfo.environment
        let serverDirectory = SidecarRuntimeResolver.orchestratorPath(
            environment: environment,
            bundleResourcePath: Bundle.main.resourcePath,
            currentDirectory: FileManager.default.currentDirectoryPath,
            sourceFilePath: #filePath
        )
        guard FileManager.default.fileExists(atPath: serverDirectory) else {
            throw SidecarError.directoryNotFound(serverDirectory)
        }

        guard let nodePath = SidecarRuntimeResolver.nodePath(
            bundleResourcePath: Bundle.main.resourcePath
        ) else {
            throw SidecarError.executableNotFound("node")
        }

        let tsxPath = (serverDirectory as NSString)
            .appendingPathComponent("node_modules/.bin/tsx")
        guard FileManager.default.isExecutableFile(atPath: tsxPath) else {
            throw SidecarError.executableNotFound("tsx (run npm install in the sidecar package)")
        }
        guard let authToken, let draftApprovalToken else {
            throw SidecarError.authTokenUnavailable
        }

        #if DEBUG
        let allowDevelopmentRuntime = true
        #else
        let allowDevelopmentRuntime = false
        #endif
        let bundleRoot = SidecarRuntimeResolver.bundleRoot(
            bundleResourcePath: Bundle.main.resourcePath,
            sourceFilePath: #filePath,
            allowDevelopmentFallback: allowDevelopmentRuntime
        )
        let managedSessionSeed = launchManagedSession.flatMap { session in
            session.isExpired ? nil : SidecarManagedSessionSeed(
                expiresAt: session.expiresAt,
                userId: session.userId,
                deviceId: session.deviceId
            )
        }
        let launchEnvironment = SidecarLaunchEnvironment.make(
            baseEnvironment: environment,
            runtimeConfiguration: runtimeConfiguration,
            homeDirectory: NSHomeDirectory(),
            bundleRoot: bundleRoot,
            hermesHomeOverride: environment["VERSO_HERMES_HOME"],
            managedSession: managedSessionSeed,
            authToken: authToken,
            draftApprovalTokenSha256: Self.sha256Hex(draftApprovalToken),
            parentProcessIdentifier: ProcessInfo.processInfo.processIdentifier
        )
        let configuration = SidecarProcessConfiguration(
            executableURL: URL(fileURLWithPath: nodePath),
            arguments: [tsxPath, "src/http/server.ts"],
            currentDirectoryURL: URL(fileURLWithPath: serverDirectory),
            environment: launchEnvironment
        )

        logger.info("Launching sidecar: \(nodePath) \(tsxPath) src/http/server.ts")
        logger.info("Working directory: \(serverDirectory)")
        if let command = launchEnvironment["VERSO_HERMES_COMMAND"], !command.isEmpty {
            logger.info("Agent runtime launch mode: managed command \(command)")
        } else {
            logger.info("Agent runtime launch mode: auto-detect installed CLI")
        }

        return try await processController.launch(configuration: configuration) { [weak self] reason in
            guard let self else { return }
            if case .running = self.state {
                self.state = .failed("Sidecar exited: \(reason)")
                self.logger.error(
                    "Sidecar exited unexpectedly: \(reason, privacy: .public). Log: \(Self.logFileURL.path, privacy: .public)"
                )
                self.scheduleRestart()
            }
        }
    }

    nonisolated private static func generateAuthToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw SidecarError.authTokenUnavailable
        }
        return Data(bytes).base64EncodedString()
    }

    nonisolated private static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

enum SidecarError: LocalizedError {
    case executableNotFound(String)
    case directoryNotFound(String)
    case authTokenUnavailable

    var errorDescription: String? {
        switch self {
        case .executableNotFound(let name):
            return "\(name) not found in PATH"
        case .directoryNotFound(let path):
            return "sidecar package not found at \(path)"
        case .authTokenUnavailable:
            return "failed to create sidecar authentication token"
        }
    }
}
