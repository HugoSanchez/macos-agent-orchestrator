import XCTest
import Combine

final class SidecarManagedSessionPolicyTests: XCTestCase {
    func testStoppedSidecarStartsOnlyWhenSessionIsPresent() {
        XCTAssertEqual(
            SidecarManagedSessionPolicy.action(
                isSidecarRunning: false,
                previousUserId: nil,
                nextUserId: "user-1"
            ),
            .start
        )
        XCTAssertEqual(
            SidecarManagedSessionPolicy.action(
                isSidecarRunning: false,
                previousUserId: "user-1",
                nextUserId: nil
            ),
            .clearLocal
        )
    }

    func testRunningSidecarSynchronizesSameIdentity() {
        XCTAssertEqual(
            SidecarManagedSessionPolicy.action(
                isSidecarRunning: true,
                previousUserId: "user-1",
                nextUserId: "user-1"
            ),
            .synchronize
        )
    }

    func testRunningSidecarRestartsAcrossIdentityBoundary() {
        let transitions: [(String?, String?)] = [
            (nil, "user-1"),
            ("user-1", nil),
            ("user-1", "user-2"),
        ]
        for transition in transitions {
            XCTAssertEqual(
                SidecarManagedSessionPolicy.action(
                    isSidecarRunning: true,
                    previousUserId: transition.0,
                    nextUserId: transition.1
                ),
                .restart
            )
        }
    }

    @MainActor
    func testValidPersistedSessionCompletesRestorationWithOneIdentity() async {
        let restored = managedSession(userId: "restored-user", expiresAt: "2099-01-01T00:00:00Z")
        let store = ManagedSessionStore(persistence: .init(
            load: { restored },
            write: { _ in },
            delete: {}
        ))

        await waitUntilRestored(store)

        XCTAssertFalse(store.isRestoringPersistedSession)
        XCTAssertEqual(store.currentSession, restored)
    }

    @MainActor
    func testMissingPersistedSessionCompletesSignedOut() async {
        let store = ManagedSessionStore(persistence: .init(
            load: { nil },
            write: { _ in },
            delete: {}
        ))

        await waitUntilRestored(store)

        XCTAssertFalse(store.isRestoringPersistedSession)
        XCTAssertNil(store.currentSession)
    }

    @MainActor
    func testExpiredPersistedSessionWithoutBackendKeepsRefreshCredentials() async {
        let recorder = ManagedSessionPersistenceRecorder()
        let expired = managedSession(userId: "expired-user", expiresAt: "2000-01-01T00:00:00Z")
        let store = ManagedSessionStore(persistence: .init(
            load: {
                try? await Task.sleep(nanoseconds: 1_000_000)
                return expired
            },
            write: { _ in },
            delete: { recorder.deleteCount += 1 }
        ))
        var publishedUserIds: [String] = []
        let cancellable = store.$currentSession
            .compactMap { $0?.userId }
            .sink { publishedUserIds.append($0) }

        await waitUntilRestored(store)

        XCTAssertEqual(store.currentSession, expired)
        XCTAssertEqual(publishedUserIds, [expired.userId])
        XCTAssertEqual(recorder.deleteCount, 0)
        _ = cancellable
    }

    @MainActor
    func testVerifiedMagicCodeSupersedesLateKeychainRestoration() async throws {
        let stale = managedSession(userId: "stale-user", expiresAt: "2099-01-01T00:00:00Z")
        let store = ManagedSessionStore(persistence: .init(
            load: {
                try? await Task.sleep(nanoseconds: 30_000_000)
                return stale
            },
            write: { _ in },
            delete: {}
        ), transport: .init(data: { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            ))
            let body = """
            {
              "session": {
                "accessToken": "fresh-token",
                "refreshToken": "fresh-refresh",
                "expiresAt": "2099-01-01T00:00:00Z"
              },
              "user": {"id": "fresh-user", "email": "owner@example.com", "displayName": null},
              "device": {"id": "fresh-device"}
            }
            """
            return (Data(body.utf8), response)
        }), backendURL: "https://backend.example")

        try await store.verifyMagicCode(email: "owner@example.com", code: "123456")
        await waitUntilRestored(store)
        try await Task.sleep(nanoseconds: 60_000_000)

        XCTAssertEqual(store.currentSession?.userId, "fresh-user")
        XCTAssertEqual(store.currentSession?.token, "fresh-token")
    }

    @MainActor
    func testDisabledStoreNeverTouchesManagedPersistence() async throws {
        let recorder = ManagedSessionPersistenceRecorder()
        let store = ManagedSessionStore(persistence: .init(
            load: {
                recorder.loadCount += 1
                return nil
            },
            write: { _ in recorder.writeCount += 1 },
            delete: { recorder.deleteCount += 1 }
        ), isEnabled: false)

        store.clearSession()
        await Task.yield()

        XCTAssertFalse(store.isRestoringPersistedSession)
        XCTAssertNil(store.currentSession)
        XCTAssertEqual(recorder.loadCount, 0)
        XCTAssertEqual(recorder.writeCount, 0)
        XCTAssertEqual(recorder.deleteCount, 0)
    }

    @MainActor
    func testExpiredSessionSurvivesOfflineStartupAndAutomaticallyRecovers() async throws {
        let expired = managedSession(userId: "owner", expiresAt: "2000-01-01T00:00:00Z")
        let recorder = ManagedSessionPersistenceRecorder()
        let recovered = expectation(description: "Refresh retried after network recovery")
        var requests = 0
        let store = ManagedSessionStore(persistence: .init(
            load: { expired },
            write: { data in
                recorder.writeCount += 1
                XCTAssertEqual(try? JSONDecoder().decode(ManagedAppSession.self, from: data).refreshToken, "rotated-refresh")
                recovered.fulfill()
            },
            delete: { recorder.deleteCount += 1 }
        ), transport: .init(data: { request in
            requests += 1
            if requests == 1 { throw URLError(.notConnectedToInternet) }
            return self.refreshResponse(request, session: expired)
        }), backendURL: "https://backend.example", refreshRetryDelay: 0.05)

        await waitUntilRestored(store)
        XCTAssertEqual(store.currentSession, expired)
        XCTAssertEqual(recorder.deleteCount, 0)
        let configuration = VersoRuntimeConfiguration.resolve(
            environment: ["VERSO_RUNTIME_MODE": "managed"], infoDictionary: [:]
        )
        XCTAssertEqual(AppStartupPolicy.destination(
            configuration: configuration, isRestoringManagedSession: false,
            managedSession: store.currentSession
        ), .content)
        await fulfillment(of: [recovered], timeout: 2)
        XCTAssertEqual(requests, 2)
        XCTAssertEqual(store.currentSession?.token, "renewed-access")
        XCTAssertEqual(recorder.deleteCount, 0)
    }

    @MainActor
    func testTemporaryRefreshErrorsKeepExpiredCredentialsButRejectionSignsOut() async throws {
        for status in [429, 500, 502, 503, 401] {
            let expired = managedSession(userId: "owner", expiresAt: "2000-01-01T00:00:00Z")
            let recorder = ManagedSessionPersistenceRecorder()
            let store = ManagedSessionStore(persistence: .init(
                load: { expired }, write: { _ in }, delete: { recorder.deleteCount += 1 }
            ), transport: .init(data: { request in
                (Data("{\"message\":\"Refresh failed\"}".utf8), HTTPURLResponse(
                    url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
                )!)
            }), backendURL: "https://backend.example")
            await waitUntilRestored(store)
            XCTAssertEqual(store.currentSession, status == 401 ? nil : expired, "HTTP \(status)")
            XCTAssertEqual(recorder.deleteCount, status == 401 ? 1 : 0, "HTTP \(status)")
        }
    }

    @MainActor
    func testWakeRetriesExpiredSessionBeforeBackgroundRetryIsDue() async throws {
        let expired = managedSession(userId: "owner", expiresAt: "2000-01-01T00:00:00Z")
        var requests = 0
        let store = ManagedSessionStore(persistence: .init(
            load: { expired }, write: { _ in }, delete: { XCTFail("Must retain credentials") }
        ), transport: .init(data: { request in
            requests += 1
            if requests == 1 { throw URLError(.timedOut) }
            return self.refreshResponse(request, session: expired)
        }), backendURL: "https://backend.example")
        await waitUntilRestored(store)
        XCTAssertEqual(requests, 1)
        await store.refreshAfterWake()
        XCTAssertEqual(requests, 2)
        XCTAssertEqual(store.currentSession?.token, "renewed-access")
        await store.refreshAfterWake()
        XCTAssertEqual(requests, 2, "An unexpired session does not need another exchange")
    }

    @MainActor
    func testConcurrentRefreshesExchangeRotatingTokenOnlyOnce() async throws {
        let session = managedSession(userId: "owner", expiresAt: "2099-01-01T00:00:00Z")
        var requests = 0
        var resume: CheckedContinuation<Void, Never>?
        let store = ManagedSessionStore(persistence: .init(
            load: { session }, write: { _ in }, delete: {}
        ), transport: .init(data: { request in
            requests += 1
            await withCheckedContinuation { resume = $0 }
            return self.refreshResponse(request, session: session)
        }), backendURL: "https://backend.example")
        await waitUntilRestored(store)
        let first = Task { try await store.refreshCurrentSession() }
        while resume == nil { await Task.yield() }
        let second = Task { try await store.refreshCurrentSession() }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(requests, 1)
        resume?.resume()
        try await first.value
        try await second.value
        XCTAssertEqual(store.currentSession?.refreshToken, "rotated-refresh")
    }

    @MainActor
    func testSignOutDuringStartupRefreshCannotRestoreOrPersistSession() async throws {
        let expired = managedSession(userId: "owner", expiresAt: "2000-01-01T00:00:00Z")
        let recorder = ManagedSessionPersistenceRecorder()
        var resume: CheckedContinuation<Void, Never>?
        let returned = expectation(description: "Late response returned")
        let store = ManagedSessionStore(persistence: .init(
            load: { expired }, write: { _ in recorder.writeCount += 1 },
            delete: { recorder.deleteCount += 1 }
        ), transport: .init(data: { request in
            await withCheckedContinuation { resume = $0 }
            returned.fulfill()
            return self.refreshResponse(request, session: expired)
        }), backendURL: "https://backend.example")
        while resume == nil { await Task.yield() }
        store.clearSession()
        resume?.resume()
        await fulfillment(of: [returned], timeout: 2)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNil(store.currentSession)
        XCTAssertEqual(recorder.writeCount, 0)
        XCTAssertEqual(recorder.deleteCount, 1)
    }

    private func refreshResponse(_ request: URLRequest, session: ManagedAppSession) -> (Data, URLResponse) {
        let body: [String: Any] = [
            "session": ["accessToken": "renewed-access", "refreshToken": "rotated-refresh", "expiresAt": "2099-01-01T00:00:00Z"],
            "user": ["id": session.userId], "device": ["id": session.deviceId],
        ]
        return (try! JSONSerialization.data(withJSONObject: body), HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
        )!)
    }

    private func managedSession(userId: String, expiresAt: String) -> ManagedAppSession {
        ManagedAppSession(
            token: "token-\(userId)",
            refreshToken: "refresh-\(userId)",
            expiresAt: expiresAt,
            userId: userId,
            deviceId: "device-\(userId)",
            email: nil,
            displayName: nil,
            receivedAt: "2026-08-18T00:00:00Z"
        )
    }

    @MainActor
    private func waitUntilRestored(_ store: ManagedSessionStore) async {
        if !store.isRestoringPersistedSession { return }
        for await isRestoring in store.$isRestoringPersistedSession.values where !isRestoring {
            return
        }
    }
}

private final class ManagedSessionPersistenceRecorder {
    var loadCount = 0
    var writeCount = 0
    var deleteCount = 0
}
