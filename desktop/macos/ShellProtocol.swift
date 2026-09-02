import Foundation

/// Transient command pushed from Swift to the chat WebView.
enum ShellCommand: Equatable {
    case openCatalog
    case closeCatalog
    case openSkillsCatalog
    case closeSkillsCatalog
    case openCron(id: String)
    case openSettings
    case focusChat
}

/// Product action sent from the chat WebView to the native shell.
enum ShellAction: Equatable {
    case selectSession(id: String?)
    case createSession
    case archiveSession(id: String)
    case unarchiveSession(id: String)
    case renameSession(id: String, title: String)
    case sessionMutated(id: String)
    case sessionStreaming(id: String, streaming: Bool)
    case sessionUnread(id: String, unread: Bool)
    case cronsChanged
    case connectionsChanged
    case skillsChanged
    case openExternalUrl(url: String)
    case signOut
    case catalogClosed
    case skillsCatalogClosed
    case settingsVisibility(open: Bool)
}

/// Strict decoder for the untyped WKScriptMessage boundary. Required fields
/// fail closed so malformed web messages never become partial native actions.
enum ShellActionDecoder {
    static func decode(_ payload: [String: Any]) -> ShellAction? {
        guard let kind = payload["kind"] as? String else { return nil }
        switch kind {
        case "select-session":
            guard let rawID = payload["id"] else { return nil }
            if rawID is NSNull { return .selectSession(id: nil) }
            guard let id = rawID as? String else { return nil }
            return .selectSession(id: id)
        case "create-session":
            return .createSession
        case "archive-session":
            guard let id = payload["id"] as? String else { return nil }
            return .archiveSession(id: id)
        case "unarchive-session":
            guard let id = payload["id"] as? String else { return nil }
            return .unarchiveSession(id: id)
        case "rename-session":
            guard let id = payload["id"] as? String,
                  let title = payload["title"] as? String else { return nil }
            return .renameSession(id: id, title: title)
        case "session-mutated":
            guard let id = payload["id"] as? String else { return nil }
            return .sessionMutated(id: id)
        case "session-streaming":
            guard let id = payload["id"] as? String,
                  let streaming = payload["streaming"] as? Bool else { return nil }
            return .sessionStreaming(id: id, streaming: streaming)
        case "session-unread":
            guard let id = payload["id"] as? String,
                  let unread = payload["unread"] as? Bool else { return nil }
            return .sessionUnread(id: id, unread: unread)
        case "crons-changed":
            return .cronsChanged
        case "connections-changed":
            return .connectionsChanged
        case "skills-changed":
            return .skillsChanged
        case "open-external-url":
            guard let url = payload["url"] as? String else { return nil }
            return .openExternalUrl(url: url)
        case "sign-out":
            return .signOut
        case "catalog-closed":
            return .catalogClosed
        case "skills-catalog-closed":
            return .skillsCatalogClosed
        case "settings-visibility":
            guard let open = payload["open"] as? Bool else { return nil }
            return .settingsVisibility(open: open)
        default:
            return nil
        }
    }
}
