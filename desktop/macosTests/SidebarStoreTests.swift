import Foundation
import XCTest

@MainActor
final class SidebarStoreTests: XCTestCase {
    func testInitialLoadPopulatesIndependentSectionsAndStableSessionOrder() async {
        let client = StubSidebarAPIClient()
        client.sessions = [
            session(id: "older", createdAt: "2026-08-18T10:00:00Z"),
            session(id: "newer", createdAt: "2026-08-19T10:00:00Z"),
            session(id: "archived", createdAt: "2026-08-20T10:00:00Z", archivedAt: "2026-08-20T12:00:00Z"),
        ]
        client.connections = [connection(id: "gmail")]
        client.customConnectors = [connector(id: "notion", state: "connected")]
        client.skills = [skill(slug: "writer")]
        client.crons = [cron(id: "daily")]
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")

        await store.loadInitialData()

        XCTAssertTrue(store.hasLoadedInitialData)
        XCTAssertEqual(store.sessions.map(\.id), ["newer", "older", "archived"])
        XCTAssertEqual(store.connections.map(\.id), ["gmail"])
        XCTAssertEqual(store.customConnectors.map(\.id), ["notion"])
        XCTAssertEqual(store.skills.map(\.id), ["writer"])
        XCTAssertEqual(store.crons.map(\.id), ["daily"])
    }

    func testOldAccountResponseCannotOverwriteNewAccountState() async {
        let gate = SidebarTestGate()
        let oldClient = StubSidebarAPIClient()
        oldClient.fetchSessionsHandler = {
            await gate.wait()
            return [self.session(id: "old-account")]
        }
        let newClient = StubSidebarAPIClient()
        newClient.sessions = [session(id: "new-account")]
        let store = SidebarStore()
        store.activate(client: oldClient, accountId: "old-user")

        let oldRefresh = Task { await store.refreshSessions() }
        while !oldClient.didStartFetchingSessions {
            await Task.yield()
        }
        store.activate(client: newClient, accountId: "new-user")
        await store.refreshSessions()
        await gate.open()
        await oldRefresh.value

        XCTAssertEqual(store.sessions.map(\.id), ["new-account"])
    }

    func testOlderRefreshCannotOverwriteNewerRefreshInSameAccount() async {
        let gate = SidebarTestGate()
        let client = StubSidebarAPIClient()
        var requestCount = 0
        client.fetchSessionsHandler = {
            requestCount += 1
            if requestCount == 1 {
                await gate.wait()
                return [self.session(id: "older-response")]
            }
            return [self.session(id: "newer-response")]
        }
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")

        let olderRefresh = Task { await store.refreshSessions() }
        while requestCount == 0 {
            await Task.yield()
        }
        await store.refreshSessions()
        await gate.open()
        await olderRefresh.value

        XCTAssertEqual(store.sessions.map(\.id), ["newer-response"])
        XCTAssertFalse(store.isLoadingSessions)
    }

    func testStreamingAndUnreadMarkersRemainSessionScoped() {
        let store = SidebarStore()

        store.setStreaming(true, sessionId: "a")
        store.setStreaming(true, sessionId: "b")
        store.setUnread(true, sessionId: "b")
        store.setStreaming(false, sessionId: "a")

        XCTAssertEqual(store.streamingSessionIds, ["b"])
        XCTAssertEqual(store.unreadSessionIds, ["b"])
    }

    func testArchivingSelectedSessionUsesCanonicalResponseAndClearsSelection() async {
        let client = StubSidebarAPIClient()
        client.sessions = [session(id: "active")]
        client.archiveSessionResult = session(
            id: "active",
            archivedAt: "2026-08-19T11:00:00Z"
        )
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")
        await store.refreshSessions()
        store.setSelectedSession("active")

        let succeeded = await store.archiveSession(id: "active")

        XCTAssertTrue(succeeded)
        XCTAssertNil(store.selectedSessionId)
        XCTAssertEqual(store.sessions.first?.archivedAt, "2026-08-19T11:00:00Z")
    }

    func testAccountPreparationDoesNotClearAlreadyActivatedClient() async {
        let client = StubSidebarAPIClient()
        client.sessions = [session(id: "current")]
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")

        store.prepareForAccountChange(accountId: "user-1")
        await store.refreshSessions()

        XCTAssertEqual(store.sessions.map(\.id), ["current"])
    }

    func testConfirmedRevocationRemovesRow() async {
        let client = StubSidebarAPIClient()
        client.connections = [connection(id: "ca_gmail")]
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")
        await store.refreshConnections()
        client.connections = []

        await store.disconnectConnection(id: "ca_gmail")

        XCTAssertTrue(store.connections.isEmpty)
    }

    func testAlreadyAbsentRevocationRemovesRow() async {
        let client = StubSidebarAPIClient()
        client.connections = [connection(id: "ca_gmail")]
        client.disconnectRevocation = .alreadyAbsent
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")
        await store.refreshConnections()
        client.connections = []

        await store.disconnectConnection(id: "ca_gmail")

        XCTAssertTrue(store.connections.isEmpty)
    }

    func testManualActionRequiredRemainsAnInternalOutcomeAndRemovesRow() async {
        let client = StubSidebarAPIClient()
        client.connections = [connection(id: "ca_gmail")]
        client.disconnectRevocation = .manualActionRequired
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")
        await store.refreshConnections()
        client.connections = []

        await store.disconnectConnection(id: "ca_gmail")

        XCTAssertTrue(store.connections.isEmpty)
    }

    func testTransientDisconnectFailureRestoresOptimisticallyRemovedRow() async {
        let client = StubSidebarAPIClient()
        client.connections = [connection(id: "ca_gmail")]
        client.disconnectError = SidebarStubError.missingFixture
        let store = SidebarStore()
        store.activate(client: client, accountId: "user-1")
        await store.refreshConnections()

        await store.disconnectConnection(id: "ca_gmail")

        XCTAssertEqual(store.connections.map(\.id), ["ca_gmail"])
    }

    private func session(
        id: String,
        createdAt: String = "2026-08-19T10:00:00Z",
        archivedAt: String? = nil
    ) -> SidebarChatSession {
        SidebarChatSession(
            id: id,
            title: id,
            createdAt: createdAt,
            updatedAt: createdAt,
            archivedAt: archivedAt,
            model: nil,
            messageCount: 0,
            lastMessagePreview: nil
        )
    }

    private func connection(id: String) -> SidebarConnection {
        SidebarConnection(
            connectedAccountId: id,
            toolkitSlug: id,
            toolkitName: id,
            logoUrl: nil,
            status: "connected"
        )
    }

    private func connector(id: String, state: String) -> SidebarCustomConnector {
        SidebarCustomConnector(
            id: id,
            name: id,
            slug: id,
            url: "https://example.com",
            transport: "sse",
            auth: "oauth",
            logoUrl: nil,
            status: SidebarCustomConnectorStatus(
                state: state,
                toolCount: nil,
                reason: nil,
                cached: false
            )
        )
    }

    private func skill(slug: String) -> SidebarSkill {
        SidebarSkill(
            slug: slug,
            name: slug,
            description: "",
            category: nil,
            tags: [],
            prerequisites: [],
            platforms: [],
            enabled: true,
            pinned: false
        )
    }

    private func cron(id: String) -> SidebarCron {
        SidebarCron(
            id: id,
            name: id,
            scheduleDisplay: nil,
            nextRunAt: nil,
            lastStatus: nil,
            lastError: nil,
            state: "active",
            enabled: true,
            running: nil
        )
    }
}

private actor SidebarTestGate {
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func open() {
        continuation?.resume()
        continuation = nil
    }
}

private final class StubSidebarAPIClient: SidebarAPIClientProtocol {
    var sessions: [SidebarChatSession] = []
    var connections: [SidebarConnection] = []
    var customConnectors: [SidebarCustomConnector] = []
    var skills: [SidebarSkill] = []
    var crons: [SidebarCron] = []
    var fetchSessionsHandler: (() async throws -> [SidebarChatSession])?
    var archiveSessionResult: SidebarChatSession?
    private(set) var didStartFetchingSessions = false

    func fetchSessions() async throws -> [SidebarChatSession] {
        didStartFetchingSessions = true
        return try await fetchSessionsHandler?() ?? sessions
    }

    func fetchConnections() async throws -> [SidebarConnection] { connections }
    func fetchCustomConnectors() async throws -> [SidebarCustomConnector] { customConnectors }
    func fetchSkills() async throws -> [SidebarSkill] { skills }
    func fetchCrons() async throws -> [SidebarCron] { crons }
    func createSession() async throws -> SidebarChatSession { try missingFixture() }
    func archiveSession(id: String) async throws -> SidebarChatSession {
        guard let archiveSessionResult else { return try missingFixture() }
        return archiveSessionResult
    }
    func renameSession(id: String, title: String) async throws -> SidebarChatSession { try missingFixture() }
    func unarchiveSession(id: String) async throws -> SidebarChatSession { try missingFixture() }
    var disconnectRevocation: SidebarProviderRevocation = .revoked
    var disconnectError: Error?

    func disconnectConnection(id: String) async throws -> SidebarDisconnectResult {
        if let disconnectError { throw disconnectError }
        return SidebarDisconnectResult(
            connectedAccountId: id,
            composioAccountDeleted: true,
            providerRevocation: disconnectRevocation
        )
    }
    func retryCustomConnector(id: String) async throws -> URL? { nil }
    func disconnectCustomConnector(id: String) async throws {}
    func deleteCron(id: String) async throws {}

    private func missingFixture<T>() throws -> T {
        throw SidebarStubError.missingFixture
    }
}

private enum SidebarStubError: Error {
    case missingFixture
}
