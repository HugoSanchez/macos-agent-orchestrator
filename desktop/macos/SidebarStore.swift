import Combine
import Foundation

@MainActor
final class SidebarStore: ObservableObject {
    typealias ErrorReporter = (_ error: Error, _ context: String) -> Void

    @Published private(set) var sessions: [SidebarChatSession] = []
    @Published private(set) var selectedSessionId: String?
    @Published private(set) var streamingSessionIds: Set<String> = []
    @Published private(set) var unreadSessionIds: Set<String> = []
    @Published private(set) var isLoadingSessions = false
    @Published private(set) var hasLoadedInitialData = false
    @Published private(set) var sessionError: String?
    @Published private(set) var connections: [SidebarConnection] = []
    @Published private(set) var customConnectors: [SidebarCustomConnector] = []
    @Published private(set) var skills: [SidebarSkill] = []
    @Published private(set) var crons: [SidebarCron] = []

    var needsCustomConnectorRefresh: Bool {
        customConnectors.contains {
            $0.status.state == "pending_auth" || $0.status.cached == true
        }
    }

    private let reportError: ErrorReporter
    private var client: (any SidebarAPIClientProtocol)?
    private var generation = 0
    private var accountId: String?
    private var hasCompletedInitialSelection = false
    private var sessionRefreshSequence = 0
    private var connectionRefreshSequence = 0
    private var skillRefreshSequence = 0
    private var cronRefreshSequence = 0

    init(reportError: @escaping ErrorReporter = { _, _ in }) {
        self.reportError = reportError
    }

    func activate(
        baseURL: URL?,
        authToken: String?,
        accountId: String?
    ) {
        let nextClient: (any SidebarAPIClientProtocol)?
        if let baseURL, let authToken {
            nextClient = SidebarAPIClient(baseURL: baseURL, authToken: authToken)
        } else {
            nextClient = nil
        }
        activate(client: nextClient, accountId: accountId)
    }

    func activate(client: (any SidebarAPIClientProtocol)?, accountId: String?) {
        generation += 1
        self.client = client
        isLoadingSessions = false

        guard self.accountId != accountId else { return }
        self.accountId = accountId
        clearContent()
    }

    func prepareForAccountChange(accountId: String?) {
        // The identity-driven task and SwiftUI's onChange callback may arrive
        // in either order. If activation already installed the new account's
        // client, this must be a no-op rather than clearing that fresh client.
        guard self.accountId != accountId else { return }
        generation += 1
        client = nil
        self.accountId = accountId
        clearContent()
    }

    func loadInitialData() async {
        guard client != nil else { return }
        let loadGeneration = generation

        // These sections are independent. Fetching them together preserves the
        // existing fast first paint without letting an obsolete sidecar/account
        // generation overwrite the current one.
        async let sessionsLoad: Void = refreshSessions()
        async let connectionsLoad: Void = refreshConnections()
        async let skillsLoad: Void = refreshSkills()
        async let cronsLoad: Void = refreshCrons()
        _ = await (sessionsLoad, connectionsLoad, skillsLoad, cronsLoad)

        guard loadGeneration == generation, !Task.isCancelled else { return }
        hasLoadedInitialData = true
    }

    func refreshSessions(preferredSelection: String? = nil) async {
        guard let context = requestContext() else {
            isLoadingSessions = false
            return
        }
        sessionRefreshSequence += 1
        let refreshSequence = sessionRefreshSequence

        isLoadingSessions = true
        defer {
            if context.generation == generation && refreshSequence == sessionRefreshSequence {
                isLoadingSessions = false
            }
        }

        do {
            let fetched = try await context.client.fetchSessions()
            guard accepts(context), refreshSequence == sessionRefreshSequence else { return }
            let nextSessions = sortSessions(fetched)
            sessions = nextSessions

            if let resolved = resolveSelectedSessionId(
                in: nextSessions,
                preferredSelection: preferredSelection
            ) {
                selectedSessionId = resolved
            } else if preferredSelection != nil
                        || selectedSessionId != nil
                        || !hasCompletedInitialSelection {
                selectedSessionId = nil
            }
            hasCompletedInitialSelection = true
            sessionError = nil
        } catch {
            guard accepts(context),
                  refreshSequence == sessionRefreshSequence,
                  !isCancellation(error) else { return }
            sessionError = error.localizedDescription
            reportError(error, "load-sessions")
        }
    }

    func refreshConnections() async {
        guard let context = requestContext() else { return }
        connectionRefreshSequence += 1
        let refreshSequence = connectionRefreshSequence

        do {
            let fetched = try await context.client.fetchConnections()
            guard accepts(context), refreshSequence == connectionRefreshSequence else { return }
            connections = fetched
        } catch {
            // Keep the last known list during a transient sidecar failure.
        }

        guard accepts(context), refreshSequence == connectionRefreshSequence else { return }
        do {
            let fetched = try await context.client.fetchCustomConnectors()
            guard accepts(context), refreshSequence == connectionRefreshSequence else { return }
            customConnectors = fetched
        } catch {
            // Keep the last known list during a transient sidecar failure.
        }
    }

    func refreshSkills() async {
        guard let context = requestContext() else { return }
        skillRefreshSequence += 1
        let refreshSequence = skillRefreshSequence
        do {
            let fetched = try await context.client.fetchSkills()
            guard accepts(context), refreshSequence == skillRefreshSequence else { return }
            skills = fetched
        } catch {
            // Best-effort sidebar snapshot.
        }
    }

    func refreshCrons() async {
        guard let context = requestContext() else { return }
        cronRefreshSequence += 1
        let refreshSequence = cronRefreshSequence
        do {
            let fetched = try await context.client.fetchCrons()
            guard accepts(context), refreshSequence == cronRefreshSequence else { return }
            crons = fetched
        } catch {
            // Best-effort sidebar snapshot.
        }
    }

    func createSession() async {
        guard let context = requestContext() else { return }
        do {
            let session = try await context.client.createSession()
            guard accepts(context) else { return }
            sessions = sortSessions(replacing(session, in: sessions))
            selectedSessionId = session.id
            sessionError = nil
        } catch {
            guard accepts(context), !isCancellation(error) else { return }
            sessionError = error.localizedDescription
            reportError(error, "create-session")
        }
    }

    @discardableResult
    func archiveSession(id: String) async -> Bool {
        guard let context = requestContext() else { return false }
        do {
            let session = try await context.client.archiveSession(id: id)
            guard accepts(context) else { return false }
            sessions = sortSessions(replacing(session, in: sessions))
            if selectedSessionId == session.id {
                selectedSessionId = nil
            }
            sessionError = nil
            return true
        } catch {
            guard accepts(context), !isCancellation(error) else { return false }
            sessionError = error.localizedDescription
            reportError(error, "archive-session")
            return false
        }
    }

    func renameSession(id: String, title: String) async {
        guard let context = requestContext() else { return }
        do {
            let session = try await context.client.renameSession(id: id, title: title)
            guard accepts(context) else { return }
            sessions = sortSessions(replacing(session, in: sessions))
            sessionError = nil
        } catch {
            guard accepts(context), !isCancellation(error) else { return }
            sessionError = error.localizedDescription
            reportError(error, "rename-session")
        }
    }

    func unarchiveSession(id: String) async {
        guard let context = requestContext() else { return }
        do {
            let session = try await context.client.unarchiveSession(id: id)
            guard accepts(context) else { return }
            sessions = sortSessions(replacing(session, in: sessions))
            selectedSessionId = session.id
            sessionError = nil
        } catch {
            guard accepts(context), !isCancellation(error) else { return }
            sessionError = error.localizedDescription
            reportError(error, "resume-archived-session")
        }
    }

    func disconnectConnection(id: String) async {
        guard let context = requestContext() else { return }
        let original = connections
        connections.removeAll { $0.connectedAccountId == id }
        do {
            _ = try await context.client.disconnectConnection(id: id)
        } catch {
            guard accepts(context) else { return }
            connections = original
        }
        guard accepts(context) else { return }
        await refreshConnections()
    }

    func retryCustomConnector(id: String) async -> URL? {
        guard let context = requestContext() else { return nil }
        let authURL: URL?
        do {
            authURL = try await context.client.retryCustomConnector(id: id)
        } catch {
            guard accepts(context) else { return nil }
            await refreshConnections()
            return nil
        }
        guard accepts(context) else { return nil }
        await refreshConnections()
        return authURL
    }

    func disconnectCustomConnector(id: String) async {
        guard let context = requestContext() else { return }
        let original = customConnectors
        customConnectors.removeAll { $0.id == id }
        do {
            try await context.client.disconnectCustomConnector(id: id)
        } catch {
            guard accepts(context) else { return }
            customConnectors = original
        }
        guard accepts(context) else { return }
        await refreshConnections()
    }

    func deleteCron(id: String) async {
        guard let context = requestContext() else { return }
        let original = crons
        crons.removeAll { $0.id == id }
        do {
            try await context.client.deleteCron(id: id)
        } catch {
            guard accepts(context) else { return }
            crons = original
        }
        guard accepts(context) else { return }
        await refreshCrons()
    }

    func setSelectedSession(_ id: String?) {
        selectedSessionId = id
        sessionError = nil
    }

    func setStreaming(_ streaming: Bool, sessionId: String) {
        if streaming {
            streamingSessionIds.insert(sessionId)
        } else {
            streamingSessionIds.remove(sessionId)
        }
    }

    func setUnread(_ unread: Bool, sessionId: String) {
        if unread {
            unreadSessionIds.insert(sessionId)
        } else {
            unreadSessionIds.remove(sessionId)
        }
    }

    private func clearContent() {
        sessions = []
        selectedSessionId = nil
        streamingSessionIds = []
        unreadSessionIds = []
        isLoadingSessions = false
        hasLoadedInitialData = false
        sessionError = nil
        connections = []
        customConnectors = []
        skills = []
        crons = []
        hasCompletedInitialSelection = false
        sessionRefreshSequence += 1
        connectionRefreshSequence += 1
        skillRefreshSequence += 1
        cronRefreshSequence += 1
    }

    private func resolveSelectedSessionId(
        in sessions: [SidebarChatSession],
        preferredSelection: String?
    ) -> String? {
        for candidate in [preferredSelection, selectedSessionId] {
            guard let candidate,
                  sessions.contains(where: { $0.id == candidate }) else { continue }
            return candidate
        }
        return nil
    }

    private func isCancellation(_ error: Error) -> Bool {
        if Task.isCancelled || error is CancellationError {
            return true
        }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    private func requestContext() -> RequestContext? {
        guard let client else { return nil }
        return RequestContext(client: client, generation: generation)
    }

    private func accepts(_ context: RequestContext) -> Bool {
        context.generation == generation && !Task.isCancelled
    }
}

private struct RequestContext {
    let client: any SidebarAPIClientProtocol
    let generation: Int
}

func replacing(_ session: SidebarChatSession, in sessions: [SidebarChatSession]) -> [SidebarChatSession] {
    let filtered = sessions.filter { $0.id != session.id }
    return [session] + filtered
}

func sortSessions(_ sessions: [SidebarChatSession]) -> [SidebarChatSession] {
    sessions.sorted { left, right in
        if (left.archivedAt == nil) != (right.archivedAt == nil) {
            return left.archivedAt == nil
        }

        // Active sessions keep a stable spatial position. Activity still
        // updates metadata, but concurrent responses never reshuffle rows.
        let leftKey = left.archivedAt ?? left.createdAt
        let rightKey = right.archivedAt ?? right.createdAt
        if leftKey != rightKey { return leftKey > rightKey }
        return left.id > right.id
    }
}
