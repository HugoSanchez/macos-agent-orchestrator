import Foundation
import XCTest

final class ShellProtocolTests: XCTestCase {
    func testDecodesEveryShellAction() {
        let fixtures: [([String: Any], ShellAction)] = [
            (["kind": "select-session", "id": "session-1"], .selectSession(id: "session-1")),
            (["kind": "select-session", "id": NSNull()], .selectSession(id: nil)),
            (["kind": "create-session"], .createSession),
            (["kind": "archive-session", "id": "session-1"], .archiveSession(id: "session-1")),
            (["kind": "unarchive-session", "id": "session-1"], .unarchiveSession(id: "session-1")),
            (
                ["kind": "rename-session", "id": "session-1", "title": "New title"],
                .renameSession(id: "session-1", title: "New title")
            ),
            (["kind": "session-mutated", "id": "session-1"], .sessionMutated(id: "session-1")),
            (
                ["kind": "session-streaming", "id": "session-1", "streaming": true],
                .sessionStreaming(id: "session-1", streaming: true)
            ),
            (
                ["kind": "session-unread", "id": "session-1", "unread": false],
                .sessionUnread(id: "session-1", unread: false)
            ),
            (["kind": "crons-changed"], .cronsChanged),
            (["kind": "connections-changed"], .connectionsChanged),
            (["kind": "skills-changed"], .skillsChanged),
            (
                ["kind": "open-external-url", "url": "https://verso.example"],
                .openExternalUrl(url: "https://verso.example")
            ),
            (["kind": "sign-out"], .signOut),
            (["kind": "catalog-closed"], .catalogClosed),
            (["kind": "skills-catalog-closed"], .skillsCatalogClosed),
            (["kind": "settings-visibility", "open": true], .settingsVisibility(open: true)),
            (["kind": "settings-visibility", "open": false], .settingsVisibility(open: false)),
        ]

        for (payload, expected) in fixtures {
            XCTAssertEqual(ShellActionDecoder.decode(payload), expected)
        }
    }

    func testRejectsUnknownAndMalformedActions() {
        XCTAssertNil(ShellActionDecoder.decode([:]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "unknown-action"]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "select-session"]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "select-session", "id": 42]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "archive-session"]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "rename-session", "id": "session-1"]))
        XCTAssertNil(ShellActionDecoder.decode([
            "kind": "session-streaming",
            "id": "session-1",
            "streaming": "yes",
        ]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "open-external-url"]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "settings-visibility"]))
        XCTAssertNil(ShellActionDecoder.decode(["kind": "settings-visibility", "open": "yes"]))
    }
}
