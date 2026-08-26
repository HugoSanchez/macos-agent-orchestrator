import Foundation
import os

enum VersoRuntimeMode: String, CaseIterable, Equatable {
    case local
    case byo
    case managed

    var usesManagedServices: Bool { self == .managed }
}

struct VersoRuntimeConfiguration: Equatable {
    private static let logger = Logger(subsystem: "com.verso.app", category: "RuntimeConfiguration")
    static let defaultModeInfoKey = "VersoDefaultRuntimeMode"
    static let managedBackendURLInfoKey = "VersoManagedBackendURL"
    static let managedFrontendURLInfoKey = "VersoManagedFrontendURL"

    let mode: VersoRuntimeMode
    let managedBackendURL: String?
    let managedFrontendURL: String?
    let sentryDSN: String?
    let sparkleFeedURL: String?
    let sparklePublicKey: String?

    var requiresManagedSession: Bool { mode.usesManagedServices }
    var enablesTelemetry: Bool { mode.usesManagedServices && sentryDSN != nil }
    var enablesUpdates: Bool {
        mode.usesManagedServices && sparkleFeedURL != nil && sparklePublicKey != nil
    }

    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:]
    ) -> VersoRuntimeConfiguration {
        let mode = resolveMode(environment: environment, infoDictionary: infoDictionary)
        let environmentBackendURL = normalized(environment["VERSO_BACKEND_URL"])
        let environmentFrontendURL = normalized(environment["VERSO_FRONTEND_URL"])

        return VersoRuntimeConfiguration(
            mode: mode,
            managedBackendURL: environmentBackendURL
                ?? normalized(infoDictionary[managedBackendURLInfoKey] as? String),
            managedFrontendURL: environmentFrontendURL
                ?? normalized(infoDictionary[managedFrontendURLInfoKey] as? String),
            sentryDSN: normalizedHTTPURL(infoDictionary["SentryDSN"] as? String),
            sparkleFeedURL: normalizedHTTPURL(infoDictionary["SUFeedURL"] as? String),
            sparklePublicKey: normalized(infoDictionary["SUPublicEDKey"] as? String)
        )
    }

    private static func resolveMode(
        environment: [String: String],
        infoDictionary: [String: Any]
    ) -> VersoRuntimeMode {
        if let rawEnvironmentMode = environment["VERSO_RUNTIME_MODE"] {
            guard let mode = parseMode(rawEnvironmentMode) else {
                logger.warning("Invalid VERSO_RUNTIME_MODE; using local")
                return .local
            }
            return mode
        }
        if let rawBundleMode = infoDictionary[defaultModeInfoKey] as? String {
            guard let mode = parseMode(rawBundleMode) else {
                logger.warning("Invalid VersoDefaultRuntimeMode; using local")
                return .local
            }
            return mode
        }
        return .local
    }

    private static func parseMode(_ raw: String) -> VersoRuntimeMode? {
        VersoRuntimeMode(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    private static func normalized(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private static func normalizedHTTPURL(_ raw: String?) -> String? {
        guard let value = normalized(raw),
              let components = URLComponents(string: value),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.host != nil else { return nil }
        return value
    }
}

enum AppStartupDestination: Equatable {
    case restoringManagedSession
    case managedSignIn
    case content
}

struct AppStartupPolicy {
    static func destination(
        configuration: VersoRuntimeConfiguration,
        isRestoringManagedSession: Bool,
        managedSession: ManagedAppSession?
    ) -> AppStartupDestination {
        guard configuration.requiresManagedSession else { return .content }
        if isRestoringManagedSession { return .restoringManagedSession }
        if let managedSession, !managedSession.isExpired { return .content }
        return .managedSignIn
    }

    static func shouldStartSidecarAtLaunch(configuration: VersoRuntimeConfiguration) -> Bool {
        !configuration.requiresManagedSession
    }
}
