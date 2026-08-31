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
    func testExpiredPersistedSessionIsDeletedWithoutPublishingItsIdentity() async {
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

        XCTAssertNil(store.currentSession)
        XCTAssertEqual(publishedUserIds, [])
        XCTAssertEqual(recorder.deleteCount, 1)
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
