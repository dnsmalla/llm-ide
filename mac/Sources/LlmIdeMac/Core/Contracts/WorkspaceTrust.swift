import Foundation

/// The server's `workspace_trust` stream notice (API 95): the turn's project
/// folder is not trusted, so what it carries that could run was not loaded.
/// Names only; the server never sends a command line or environment.
///
/// Lives in Core because ClaudeLink decodes it, Chat shows the banner and
/// Extensions shows the folder list, and those may not name each other.
public struct ChatWorkspaceTrustNotice: Equatable, Sendable {
    public struct Skipped: Equatable, Sendable {
        /// `mcp-stdio`, `hooks`, `plugin` or `skill-scripts`.
        public let kind: String
        public let name: String
        public let file: String
        /// True when it would have been loaded had the folder been trusted.
        public let withheld: Bool
        public init(kind: String, name: String, file: String, withheld: Bool) {
            self.kind = kind; self.name = name; self.file = file; self.withheld = withheld
        }
    }
    public let path: String
    public let text: String
    public let skipped: [Skipped]
    public init(path: String, text: String, skipped: [Skipped]) {
        self.path = path; self.text = text; self.skipped = skipped
    }
}

/// Wording shared by the Chat banner and the Settings folder list. Pure.
public enum WorkspaceTrustPresentation {
    /// The banner's one sentence: what was not loaded and how to change that.
    static func bannerText(_ n: ChatWorkspaceTrustNotice) -> String {
        let folder = displayName(n.path)
        if withheld(n).isEmpty {
            return "\(folder) is not a trusted folder. It carries config that is never loaded here (hooks and plugins from a project folder are not loaded at all)."
        }
        let names = withheld(n).prefix(4).map(\.name).joined(separator: ", ")
        let more = withheld(n).count > 4 ? " and \(withheld(n).count - 4) more" : ""
        return "\(folder) is not a trusted folder, so its own MCP servers were not started: \(names)\(more)."
    }

    /// The servers that trusting would start (stdio MCP servers named by the folder's `.mcp.json`).
    static func withheld(_ n: ChatWorkspaceTrustNotice) -> [ChatWorkspaceTrustNotice.Skipped] {
        n.skipped.filter { $0.withheld && $0.kind == "mcp-stdio" }
    }

    /// The confirmation shown before an explicit trust: what will run, by name.
    static func confirmationText(_ n: ChatWorkspaceTrustNotice) -> String {
        confirmationText(path: n.path, servers: withheld(n).map(\.name))
    }

    static func confirmationText(path: String, servers: [String]) -> String {
        var s = "Trust \(path)?\n\nFrom now on, chats in this folder start the MCP servers its .mcp.json file defines"
        if servers.isEmpty {
            s += "; each one runs a program on this Mac with your permissions."
        } else {
            s += ", each of which runs a program on this Mac with your permissions: \(servers.joined(separator: ", "))."
        }
        s += "\n\nHooks and plugins inside a project folder are not loaded either way. Only trust folders whose contents you wrote or have read. You can turn this off again in Settings."
        return s
    }

    static func displayName(_ path: String) -> String {
        let last = (path as NSString).lastPathComponent
        return last.isEmpty ? path : last
    }

    /// A plain sentence for a failed trust change.
    static func message(forCode code: String?, serverMessage: String?) -> String {
        switch code {
        case "INVALID_PATH":
            return "That folder is too broad to trust as one project. Choose the project folder itself."
        case "NOT_FOUND":
            return "That folder no longer exists, so it cannot be trusted."
        case "VALIDATION_FAILED":
            return "The folder path was not accepted by the server."
        default:
            if let m = serverMessage, !m.isEmpty { return m }
            return "The trust setting could not be saved. Check that the backend is running and try again."
        }
    }

    static func kindText(_ kind: String) -> String {
        switch kind {
        case "mcp-stdio": return "MCP server"
        case "hooks": return "hooks"
        case "plugin": return "plugin"
        case "skill-scripts": return "skill with scripts"
        default: return kind
        }
    }
}
