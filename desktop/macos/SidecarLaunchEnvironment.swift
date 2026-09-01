import Foundation

struct SidecarManagedSessionSeed: Equatable {
    let expiresAt: String
    let userId: String
    let deviceId: String
}

struct SidecarLaunchEnvironment {
    static func make(
        baseEnvironment: [String: String],
        runtimeConfiguration: VersoRuntimeConfiguration,
        homeDirectory: String,
        bundleRoot: String?,
        hermesHomeOverride: String?,
        managedSession: SidecarManagedSessionSeed?,
        authToken: String,
        draftApprovalTokenSha256: String = "",
        parentProcessIdentifier: Int32
    ) -> [String: String] {
        var environment = baseEnvironment
        let extraPaths = [
            "\(homeDirectory)/.local/bin",
            "\(homeDirectory)/.hermes/hermes-agent/venv/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
        ]
        let currentPath = environment["PATH"] ?? ""
        environment["PATH"] = (extraPaths + [currentPath]).joined(separator: ":")

        environment["VERSO_RUNTIME_MODE"] = runtimeConfiguration.mode.rawValue
        environment["VERSO_BACKEND_URL"] = runtimeConfiguration.mode.usesManagedServices
            ? (runtimeConfiguration.managedBackendURL ?? "off")
            : "off"

        let resolvedHermesHomeOverride: String?
        if let hermesHomeOverride, !hermesHomeOverride.isEmpty {
            resolvedHermesHomeOverride = hermesHomeOverride
        } else if runtimeConfiguration.mode.usesManagedServices {
            resolvedHermesHomeOverride = nil
        } else {
            resolvedHermesHomeOverride = "\(homeDirectory)/Library/Application Support/Verso/runtime/\(runtimeConfiguration.mode.rawValue)/hermes-home"
        }

        SidecarRuntimeResolver.applyBundledRuntimeEnvironment(
            &environment,
            bundleRoot: bundleRoot,
            homeDirectory: homeDirectory,
            hermesHomeOverride: resolvedHermesHomeOverride
        )

        // The managed bearer is pushed over authenticated loopback IPC after
        // launch and held only in orchestrator memory. Never place it in a
        // process environment: same-user processes can inspect one another's
        // environment on macOS. Non-secret identity metadata is still needed
        // here to select the account-scoped local state root at startup.
        environment.removeValue(forKey: "VERSO_MANAGED_SESSION_TOKEN")
        if runtimeConfiguration.mode.usesManagedServices, let managedSession {
            environment["VERSO_MANAGED_SESSION_EXPIRES_AT"] = managedSession.expiresAt
            environment["VERSO_MANAGED_USER_ID"] = managedSession.userId
            environment["VERSO_MANAGED_DEVICE_ID"] = managedSession.deviceId
        } else {
            // Never allow a stale shell/Xcode identity to leak into a launch
            // that intentionally has no active managed session.
            environment.removeValue(forKey: "VERSO_MANAGED_SESSION_EXPIRES_AT")
            environment.removeValue(forKey: "VERSO_MANAGED_USER_ID")
            environment.removeValue(forKey: "VERSO_MANAGED_DEVICE_ID")
        }

        environment["VERSO_SIDECAR_AUTH_SECRET"] = authToken
        if draftApprovalTokenSha256.isEmpty {
            environment.removeValue(forKey: "VERSO_DRAFT_APPROVAL_TOKEN_SHA256")
        } else {
            // Only the verifier enters the sidecar process environment. The
            // native WebView retains the random preimage used on Send clicks.
            environment["VERSO_DRAFT_APPROVAL_TOKEN_SHA256"] = draftApprovalTokenSha256
        }
        // The orchestrator self-exits if the native parent crashes or is
        // force-quit, preventing a re-parented sidecar from living forever.
        environment["VERSO_PARENT_PID"] = String(parentProcessIdentifier)
        return environment
    }
}
