import Foundation

struct SidecarManagedAccountSnapshot: Equatable, Decodable {
    struct Backend: Equatable, Decodable {
        let configured: Bool
        let baseUrl: String?
    }

    struct Session: Equatable, Decodable {
        let present: Bool
        let userId: String?
        let email: String?
        let displayName: String?
        let expiresAt: String?
        let receivedAt: String?
        let expired: Bool
    }

    struct User: Equatable, Decodable {
        let id: String
        let workosUserId: String
        let email: String?
        let displayName: String?
    }

    struct Device: Equatable, Decodable {
        let id: String
        let label: String
        let platform: String
        let lastSeenAt: String
    }

    struct AuthSession: Equatable, Decodable {
        let id: String
        let issuedAt: String
        let expiresAt: String
    }

    struct Entitlement: Equatable, Decodable {
        let id: String
        let mode: String
        let status: String
        let allowedModels: [String]
        let monthlyUsdLimit: Double?
        let dailyUsdLimit: Double?
    }

    struct Account: Equatable, Decodable {
        let state: String
        let error: String?
        let user: User?
        let device: Device?
        let session: AuthSession?
        let entitlements: [Entitlement]
    }

    let backend: Backend
    let session: Session
    let account: Account
}

protocol SidecarHTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: SidecarHTTPTransport {}

struct SidecarHTTPClient {
    private let baseURL: URL
    private let authToken: String
    private let transport: any SidecarHTTPTransport

    init(
        baseURL: URL,
        authToken: String,
        transport: any SidecarHTTPTransport = URLSession.shared
    ) {
        self.baseURL = baseURL
        self.authToken = authToken
        self.transport = transport
    }

    func fetchManagedAccount() async throws -> SidecarManagedAccountSnapshot {
        let request = makeRequest(path: "managed/account")
        let data = try await send(request)
        return try JSONDecoder().decode(SidecarManagedAccountSnapshot.self, from: data)
    }

    func setManagedSession<Value: Encodable>(_ session: Value) async throws {
        var request = makeRequest(path: "managed/session")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(session)
        _ = try await send(request)
    }

    func clearManagedSession() async throws {
        try await perform(path: "managed/session", method: "DELETE")
    }

    func decode<Response: Decodable>(
        _ type: Response.Type,
        path: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> Response {
        let data = try await perform(path: path, method: method, body: body)
        return try JSONDecoder().decode(type, from: data)
    }

    @discardableResult
    func perform(
        path: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> Data {
        var request = makeRequest(path: path)
        request.httpMethod = method
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request)
    }

    private func makeRequest(path: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue(authToken, forHTTPHeaderField: "X-Verso-Sidecar-Token")
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw SidecarHTTPError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw SidecarHTTPError.httpStatus(response.statusCode)
        }
        return data
    }
}

enum SidecarHTTPError: LocalizedError, Equatable {
    case invalidResponse
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The sidecar returned an invalid HTTP response."
        case .httpStatus(let statusCode):
            return "The sidecar request failed with HTTP \(statusCode)."
        }
    }
}
