import Foundation
import LocalAuthentication
import Security
import SwiftUI

struct ManagedAppSession: Codable, Equatable {
    /// Short-lived WorkOS access token. The historical property name is kept
    /// because the sidecar's in-memory session protocol already calls it token.
    let token: String
    let refreshToken: String
    let expiresAt: String
    let userId: String
    let deviceId: String
    let email: String?
    let displayName: String?
    let receivedAt: String

    var identityLabel: String {
        if let email, !email.isEmpty { return email }
        if let displayName, !displayName.isEmpty { return displayName }
        return userId
    }

    var isExpired: Bool {
        guard let date = expirationDate else { return true }
        return date <= Date()
    }

    var needsRefresh: Bool {
        guard let date = expirationDate else { return true }
        return date <= Date().addingTimeInterval(5 * 60)
    }

    var expirationDate: Date? {
        Self.iso8601.date(from: expiresAt) ?? Self.iso8601Fractional.date(from: expiresAt)
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

enum ManagedAuthError: LocalizedError, Equatable {
    case backendNotConfigured
    case invalidResponse
    case rejected(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .backendNotConfigured:
            return "Sign-in is not configured."
        case .invalidResponse:
            return "The sign-in service returned an invalid response."
        case .rejected(_, let message):
            return message
        }
    }
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

    struct HTTPTransport {
        let data: (URLRequest) async throws -> (Data, URLResponse)

        static var urlSession: HTTPTransport {
            HTTPTransport(data: { request in
                try await URLSession.shared.data(for: request)
            })
        }
    }

    nonisolated private static let keychainService = "com.verso.managed-session"
    nonisolated private static let keychainAccount = "current"
    nonisolated private static let keychainQueue = DispatchQueue(
        label: "com.verso.managed-session.keychain",
        qos: .utility
    )
    nonisolated private static let keychainDisabled =
        ProcessInfo.processInfo.environment["VERSO_SKIP_MANAGED_SESSION_KEYCHAIN"] == "1"

    @Published private(set) var currentSession: ManagedAppSession?
    @Published private(set) var latestEvent: ManagedSessionEvent?
    @Published private(set) var isRestoringPersistedSession: Bool
    private var sessionLoadGeneration = 0
    private var refreshTask: Task<Void, Never>?
    private let persistence: Persistence
    private let transport: HTTPTransport
    private let backendURL: URL?
    private let isEnabled: Bool

    init(
        persistence: Persistence = .keychain,
        transport: HTTPTransport = .urlSession,
        backendURL: String? = nil,
        isEnabled: Bool = true
    ) {
        self.persistence = persistence
        self.transport = transport
        self.backendURL = backendURL.flatMap(URL.init(string:))
        self.isEnabled = isEnabled
        self.currentSession = nil
        self.isRestoringPersistedSession = isEnabled
        if isEnabled {
            restorePersistedSession()
        }
    }

    func requestMagicCode(email: String) async throws {
        let body = try JSONEncoder().encode(MagicCodeRequest(email: normalizedEmail(email)))
        _ = try await send(path: "v1/auth/magic/start", body: body)
    }

    func verifyMagicCode(email: String, code: String) async throws {
        let body = try JSONEncoder().encode(MagicCodeVerificationRequest(
            email: normalizedEmail(email),
            code: code.trimmingCharacters(in: .whitespacesAndNewlines),
            deviceLabel: Host.current().localizedName ?? "verso for macOS",
            platform: "macos"
        ))
        let data = try await send(path: "v1/auth/magic/verify", body: body)
        let response = try JSONDecoder().decode(AuthResponse.self, from: data)
        adopt(response.managedSession, message: "Signed in as \(response.managedSession.identityLabel).")
    }

    func refreshCurrentSession() async throws {
        guard let currentSession else { return }
        let refreshed = try await refresh(currentSession)
        guard refreshed.userId == currentSession.userId else {
            throw ManagedAuthError.invalidResponse
        }
        adopt(refreshed, message: nil)
    }

    func clearSession(notify: Bool = true) {
        guard isEnabled else { return }
        refreshTask?.cancel()
        refreshTask = nil
        sessionLoadGeneration += 1
        currentSession = nil
        completeInitialRestoration()
        persistence.delete()
        if notify {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Signed out.", isError: false)
        }
    }

    private func adopt(_ session: ManagedAppSession, message: String?) {
        sessionLoadGeneration += 1
        currentSession = session
        completeInitialRestoration()
        persist(session)
        scheduleRefresh(for: session)
        if let message {
            latestEvent = ManagedSessionEvent(id: UUID(), message: message, isError: false)
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
            guard let restored else {
                self.completeInitialRestoration()
                return
            }

            if restored.needsRefresh, self.backendURL != nil {
                do {
                    let refreshed = try await self.refresh(restored)
                    guard refreshed.userId == restored.userId else {
                        throw ManagedAuthError.invalidResponse
                    }
                    self.adopt(refreshed, message: nil)
                    return
                } catch {
                    if restored.isExpired {
                        persistence.delete()
                        self.latestEvent = ManagedSessionEvent(
                            id: UUID(),
                            message: "Your session expired. Please sign in again.",
                            isError: true
                        )
                        self.completeInitialRestoration()
                        return
                    }
                }
            }

            guard !restored.isExpired else {
                persistence.delete()
                self.latestEvent = ManagedSessionEvent(
                    id: UUID(),
                    message: "Your session expired. Please sign in again.",
                    isError: true
                )
                self.completeInitialRestoration()
                return
            }

            self.currentSession = restored
            self.scheduleRefresh(for: restored)
            self.completeInitialRestoration()
        }
    }

    private func scheduleRefresh(for session: ManagedAppSession, retryAfter: TimeInterval? = nil) {
        refreshTask?.cancel()
        guard let expirationDate = session.expirationDate else {
            clearSession(notify: false)
            return
        }
        let delay = retryAfter ?? max(0, expirationDate.timeIntervalSinceNow - 5 * 60)
        refreshTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled, self.currentSession == session else { return }
                try await self.refreshCurrentSession()
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.currentSession == session else { return }
                if session.isExpired {
                    self.clearSession(notify: false)
                    self.latestEvent = ManagedSessionEvent(
                        id: UUID(),
                        message: "Your session expired. Please sign in again.",
                        isError: true
                    )
                } else {
                    self.scheduleRefresh(for: session, retryAfter: 60)
                }
            }
        }
    }

    private func refresh(_ session: ManagedAppSession) async throws -> ManagedAppSession {
        let body = try JSONEncoder().encode(RefreshRequest(
            refreshToken: session.refreshToken,
            deviceId: session.deviceId
        ))
        let data = try await send(path: "v1/auth/refresh", body: body)
        return try JSONDecoder().decode(AuthResponse.self, from: data).managedSession
    }

    private func send(path: String, body: Data) async throws -> Data {
        guard let backendURL else { throw ManagedAuthError.backendNotConfigured }
        var request = URLRequest(url: backendURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try await transport.data(request)
        guard let response = response as? HTTPURLResponse else {
            throw ManagedAuthError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).message)
                ?? "Sign-in failed. Please try again."
            throw ManagedAuthError.rejected(statusCode: response.statusCode, message: message)
        }
        return data
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
        let authenticationContext = LAContext()
        authenticationContext.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = authenticationContext

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        guard let session = try? JSONDecoder().decode(ManagedAppSession.self, from: data) else {
            // Old Privy/Verso sessions do not contain a refresh token or device
            // binding. Remove them instead of accidentally treating them as valid.
            deleteFromKeychain()
            return nil
        }
        return session
    }

    nonisolated private static func loadFromKeychainAsync() async -> ManagedAppSession? {
        await withCheckedContinuation { continuation in
            keychainQueue.async {
                continuation.resume(returning: loadFromKeychain())
            }
        }
    }

    nonisolated private static func writeToKeychainAsync(data: Data) {
        keychainQueue.async {
            writeToKeychain(data: data)
        }
    }

    nonisolated private static func deleteFromKeychainAsync() {
        keychainQueue.async {
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

    private func normalizedEmail(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

}

private func managedSessionTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

private struct MagicCodeRequest: Encodable {
    let email: String
}

private struct MagicCodeVerificationRequest: Encodable {
    let email: String
    let code: String
    let deviceLabel: String
    let platform: String
}

private struct RefreshRequest: Encodable {
    let refreshToken: String
    let deviceId: String
}

private struct AuthResponse: Decodable {
    struct Session: Decodable {
        let accessToken: String
        let refreshToken: String
        let expiresAt: String
    }

    struct User: Decodable {
        let id: String
        let email: String?
        let displayName: String?
    }

    struct Device: Decodable {
        let id: String
    }

    let session: Session
    let user: User
    let device: Device

    var managedSession: ManagedAppSession {
        ManagedAppSession(
            token: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: session.expiresAt,
            userId: user.id,
            deviceId: device.id,
            email: user.email,
            displayName: user.displayName,
            receivedAt: managedSessionTimestamp()
        )
    }
}

private struct ErrorResponse: Decodable {
    let message: String
}
