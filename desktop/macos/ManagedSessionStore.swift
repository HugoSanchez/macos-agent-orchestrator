import Foundation
import LocalAuthentication
import Security
import SwiftUI

struct ManagedAppSession: Codable, Equatable {
    let token: String
    let expiresAt: String
    let userId: String
    let email: String?
    let displayName: String?
    let receivedAt: String

    var identityLabel: String {
        if let email, !email.isEmpty { return email }
        if let displayName, !displayName.isEmpty { return displayName }
        return userId
    }

    var isExpired: Bool {
        guard let date = Self.iso8601.date(from: expiresAt) ?? Self.iso8601Fractional.date(from: expiresAt) else {
            return false
        }
        return date <= Date()
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct ManagedSessionEvent: Equatable {
    let id: UUID
    let message: String
    let isError: Bool
}

@MainActor
final class ManagedSessionStore: ObservableObject {
    struct Persistence {
        let load: () async -> ManagedAppSession?
        let write: (Data) -> Void
        let delete: () -> Void

        static var keychain: Persistence {
            Persistence(
                load: { await ManagedSessionStore.loadFromKeychainAsync() },
                write: { ManagedSessionStore.writeToKeychainAsync(data: $0) },
                delete: { ManagedSessionStore.deleteFromKeychainAsync() }
            )
        }
    }

    nonisolated private static let keychainService = "com.verso.managed-session"
    nonisolated private static let keychainAccount = "current"
    // Tests may explicitly opt out of Keychain access. Normal Debug and
    // Conductor launches retain their managed session, but never synchronously
    // block application startup on a Keychain interaction.
    nonisolated private static let keychainDisabled =
        ProcessInfo.processInfo.environment["VERSO_SKIP_MANAGED_SESSION_KEYCHAIN"] == "1"
    private static let supportedCallbackSchemes: Set<String> = ["verso", "verso-dev"]

    @Published private(set) var currentSession: ManagedAppSession?
    @Published private(set) var latestEvent: ManagedSessionEvent?
    @Published private(set) var isRestoringPersistedSession: Bool
    private var sessionLoadGeneration = 0
    private let persistence: Persistence
    private let isEnabled: Bool

    init(persistence: Persistence = .keychain, isEnabled: Bool = true) {
        self.persistence = persistence
        self.isEnabled = isEnabled
        self.currentSession = nil
        self.isRestoringPersistedSession = isEnabled
        if isEnabled {
            restorePersistedSession()
        }
    }

    func handleCallbackURL(_ url: URL) {
        guard isEnabled else { return }
        guard Self.supportedCallbackSchemes.contains(url.scheme?.lowercased() ?? "") else { return }
        guard url.host?.lowercased() == "auth", url.path == "/callback" else {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Ignored unsupported auth callback URL.", isError: true)
            return
        }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItemValue(named: "session_token"),
              let expiresAt = components.queryItemValue(named: "expires_at"),
              let userId = components.queryItemValue(named: "user_id") else {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Auth callback is missing required session parameters.", isError: true)
            return
        }

        let session = ManagedAppSession(
            token: token,
            expiresAt: expiresAt,
            userId: userId,
            email: components.queryItemValue(named: "email"),
            displayName: components.queryItemValue(named: "display_name"),
            receivedAt: Self.timestamp()
        )

        sessionLoadGeneration += 1
        currentSession = session
        completeInitialRestoration()
        persist(session)
        latestEvent = ManagedSessionEvent(id: UUID(), message: "Signed in as \(session.identityLabel).", isError: false)
    }

    func clearSession(notify: Bool = true) {
        guard isEnabled else { return }
        sessionLoadGeneration += 1
        currentSession = nil
        completeInitialRestoration()
        persistence.delete()
        if notify {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Signed out.", isError: false)
        }
    }

    private func persist(_ session: ManagedAppSession) {
        guard isEnabled else { return }
        guard let data = try? JSONEncoder().encode(session) else { return }
        persistence.write(data)
    }

    private func restorePersistedSession() {
        let generation = sessionLoadGeneration
        let persistence = persistence
        Task { [weak self] in
            let restored = await persistence.load()
            guard let self, self.sessionLoadGeneration == generation else { return }
            if let restored, restored.isExpired {
                // Never publish an expired identity: doing so would start the
                // sidecar and immediately force a second account-bound launch.
                persistence.delete()
                self.currentSession = nil
            } else {
                self.currentSession = restored
            }
            self.completeInitialRestoration()
        }
    }

    private func completeInitialRestoration() {
        guard isRestoringPersistedSession else { return }
        isRestoringPersistedSession = false
    }

    nonisolated private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
    }

    nonisolated private static func loadFromKeychain() -> ManagedAppSession? {
        guard !keychainDisabled else { return nil }
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        // A stale Debug signing identity can require an interactive Keychain
        // prompt. Never present or wait for that prompt while restoring a
        // session; the app remains usable and can show sign-in immediately.
        let authenticationContext = LAContext()
        authenticationContext.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = authenticationContext

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(ManagedAppSession.self, from: data)
    }

    nonisolated private static func loadFromKeychainAsync() async -> ManagedAppSession? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: loadFromKeychain())
            }
        }
    }

    nonisolated private static func writeToKeychainAsync(data: Data) {
        DispatchQueue.global(qos: .utility).async {
            writeToKeychain(data: data)
        }
    }

    nonisolated private static func deleteFromKeychainAsync() {
        DispatchQueue.global(qos: .utility).async {
            deleteFromKeychain()
        }
    }

    nonisolated private static func writeToKeychain(data: Data) {
        guard !keychainDisabled else { return }
        let query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    nonisolated private static func deleteFromKeychain() {
        guard !keychainDisabled else { return }
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

private extension URLComponents {
    func queryItemValue(named name: String) -> String? {
        queryItems?.first(where: { $0.name == name })?.value
    }
}
