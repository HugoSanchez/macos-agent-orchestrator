import Foundation

struct SidebarCron: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let scheduleDisplay: String?
    let nextRunAt: String?
    let lastStatus: String?
    let lastError: String?
    let state: String
    let enabled: Bool
    let running: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case scheduleDisplay = "schedule_display"
        case nextRunAt = "next_run_at"
        case lastStatus = "last_status"
        case lastError = "last_error"
        case state
        case enabled
        case running
    }
}

struct SidebarSkill: Decodable, Identifiable, Equatable {
    let slug: String
    let name: String
    let description: String
    let category: String?
    let tags: [String]
    let prerequisites: [String]
    let platforms: [String]
    let enabled: Bool
    let pinned: Bool

    var id: String { slug }
}

struct SidebarConnection: Decodable, Identifiable, Equatable {
    let connectedAccountId: String
    let toolkitSlug: String
    let toolkitName: String
    let logoUrl: String?
    let status: String

    var id: String { connectedAccountId }
    var displayToolkitName: String { sidebarDisplayToolkitName(toolkitName) }
}

struct SidebarCustomConnector: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let slug: String
    let url: String
    let transport: String
    let auth: String
    var logoUrl: String?
    let status: SidebarCustomConnectorStatus

    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? slug : trimmed
    }

    var statusText: String {
        switch status.state {
        case "connected":
            return "Connected"
        case "pending_auth":
            return "Waiting for sign-in"
        default:
            return status.reason ?? "No tools registered"
        }
    }
}

struct SidebarCustomConnectorStatus: Decodable, Equatable {
    let state: String
    let toolCount: Int?
    let reason: String?
    let cached: Bool?
}

enum SidebarProviderRevocation: String, Decodable, Equatable {
    case revoked
    case alreadyAbsent = "already_absent"
    case manualActionRequired = "manual_action_required"

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // An unknown status must never be reported internally as fully revoked,
        // so it degrades conservatively instead of failing the decode.
        self = SidebarProviderRevocation(rawValue: raw) ?? .manualActionRequired
    }
}

struct SidebarDisconnectResult: Decodable, Equatable {
    let connectedAccountId: String
    let composioAccountDeleted: Bool
    let providerRevocation: SidebarProviderRevocation
}

// Internal so ChatWebView's shell snapshot can carry the same session model.
struct SidebarChatSession: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
    let model: String?
    let messageCount: Int
    let lastMessagePreview: String?
}

private struct SidebarCronsResponse: Decodable {
    let crons: [SidebarCron]
}

private struct SidebarSkillsResponse: Decodable {
    let skills: [SidebarSkill]
}

private struct SidebarConnectionsResponse: Decodable {
    let connections: [SidebarConnection]
}

private struct SidebarCustomConnectorsResponse: Decodable {
    let connectors: [SidebarCustomConnector]
}

private struct SidebarCustomConnectorResponse: Decodable {
    let connector: SidebarCustomConnector
}

private struct SidebarChatSessionsResponse: Decodable {
    let sessions: [SidebarChatSession]
}

private struct SidebarChatSessionEnvelope: Decodable {
    let session: SidebarChatSession
}

private struct SidebarDisconnectResponse: Decodable {
    let disconnect: SidebarDisconnectResult
}

private struct SidebarRenameSessionRequest: Encodable {
    let title: String
}

protocol SidebarAPIClientProtocol {
    func fetchSessions() async throws -> [SidebarChatSession]
    func fetchConnections() async throws -> [SidebarConnection]
    func fetchCustomConnectors() async throws -> [SidebarCustomConnector]
    func fetchSkills() async throws -> [SidebarSkill]
    func fetchCrons() async throws -> [SidebarCron]
    func createSession() async throws -> SidebarChatSession
    func archiveSession(id: String) async throws -> SidebarChatSession
    func renameSession(id: String, title: String) async throws -> SidebarChatSession
    func unarchiveSession(id: String) async throws -> SidebarChatSession
    func disconnectConnection(id: String) async throws -> SidebarDisconnectResult
    func retryCustomConnector(id: String) async throws -> URL?
    func disconnectCustomConnector(id: String) async throws
    func deleteCron(id: String) async throws
}

struct SidebarAPIClient: SidebarAPIClientProtocol {
    private let baseURL: URL
    private let http: SidecarHTTPClient

    init(
        baseURL: URL,
        authToken: String,
        transport: any SidecarHTTPTransport = URLSession.shared
    ) {
        self.baseURL = baseURL
        self.http = SidecarHTTPClient(
            baseURL: baseURL,
            authToken: authToken,
            transport: transport
        )
    }

    func fetchSessions() async throws -> [SidebarChatSession] {
        try await http.decode(SidebarChatSessionsResponse.self, path: "chat/sessions").sessions
    }

    func fetchConnections() async throws -> [SidebarConnection] {
        try await http.decode(SidebarConnectionsResponse.self, path: "connections").connections
    }

    func fetchCustomConnectors() async throws -> [SidebarCustomConnector] {
        let connectors = try await http.decode(
            SidebarCustomConnectorsResponse.self,
            path: "connectors/custom"
        ).connectors
        return connectors.map { connector in
            var connector = connector
            if let logoURL = connector.logoUrl,
               logoURL.hasPrefix("/"),
               let resolved = URL(string: logoURL, relativeTo: baseURL) {
                connector.logoUrl = resolved.absoluteURL.absoluteString
            }
            return connector
        }
    }

    func fetchSkills() async throws -> [SidebarSkill] {
        try await http.decode(SidebarSkillsResponse.self, path: "skills").skills
    }

    func fetchCrons() async throws -> [SidebarCron] {
        try await http.decode(SidebarCronsResponse.self, path: "crons").crons
    }

    func createSession() async throws -> SidebarChatSession {
        try await http.decode(
            SidebarChatSessionEnvelope.self,
            path: "chat/sessions",
            method: "POST",
            body: Data("{}".utf8)
        ).session
    }

    func archiveSession(id: String) async throws -> SidebarChatSession {
        try await sessionMutation(path: "chat/sessions/\(id)/archive")
    }

    func renameSession(id: String, title: String) async throws -> SidebarChatSession {
        try await sessionMutation(
            path: "chat/sessions/\(id)/rename",
            body: try JSONEncoder().encode(SidebarRenameSessionRequest(title: title))
        )
    }

    func unarchiveSession(id: String) async throws -> SidebarChatSession {
        try await sessionMutation(path: "chat/sessions/\(id)/unarchive")
    }

    func disconnectConnection(id: String) async throws -> SidebarDisconnectResult {
        try await http.decode(
            SidebarDisconnectResponse.self,
            path: "connections/\(id)",
            method: "DELETE"
        ).disconnect
    }

    func retryCustomConnector(id: String) async throws -> URL? {
        let connector = try await http.decode(
            SidebarCustomConnectorResponse.self,
            path: "connectors/custom/\(id)/retry",
            method: "POST"
        ).connector
        guard connector.status.state == "pending_auth" else { return nil }
        return baseURL.appendingPathComponent("connectors/custom/\(id)/open")
    }

    func disconnectCustomConnector(id: String) async throws {
        try await http.perform(path: "connectors/custom/\(id)", method: "DELETE")
    }

    func deleteCron(id: String) async throws {
        try await http.perform(path: "crons/\(id)", method: "DELETE")
    }

    private func sessionMutation(path: String, body: Data? = nil) async throws -> SidebarChatSession {
        try await http.decode(
            SidebarChatSessionEnvelope.self,
            path: path,
            method: "POST",
            body: body
        ).session
    }
}

func sidebarDisplayToolkitName(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = trimmed.lowercased().replacingOccurrences(of: "_", with: " ")
    switch normalized {
    case "google calendar", "googlecalendar":
        return "Calendar"
    case "google docs", "googledocs":
        return "Docs"
    case "google drive", "googledrive":
        return "Drive"
    case "google sheets", "googlesheets":
        return "Sheets"
    case "granola mcp":
        return "Granola"
    default:
        if normalized.hasPrefix("google ") {
            return String(trimmed.dropFirst("Google ".count))
        }
        if normalized.hasSuffix(" mcp") {
            return String(trimmed.dropLast(" MCP".count))
        }
        return trimmed.isEmpty ? name : trimmed
    }
}
