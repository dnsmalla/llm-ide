import Foundation

/// The server's `workspace_trust` stream notice (API 95): the turn's project
/// folder is not trusted, so what it carries that could run was not loaded.
/// Names only; the server never sends a command line or environment.
///
/// Lives in Core because ClaudeLink decodes it, Chat shows the banner and
/// Extensions shows the folder list, and those may not name each other.
public struct ChatWorkspaceTrustNotice: Equatable, Sendable {
    public struct Skipped: Equatable, Sendable {
        /// `mcp-stdio`, `mcp-remote`, `mcp-uninspected`, `hooks`, `plugin` or `skill-scripts`.
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
    /// The banner text: what was not loaded and how to change that.
    static func bannerText(_ n: ChatWorkspaceTrustNotice) -> String {
        let folder = displayName(n.path)
        let held = withheld(n)
        if held.isEmpty {
            return "\(folder) is not a trusted folder. It carries config that is never loaded here (hooks and plugins from a project folder are not loaded at all)."
        }
        var s = "\(folder) is not a trusted folder, so its own MCP servers were not started."
        let sentences = effectSentences(held)
        if !sentences.isEmpty { s += " " + sentences.joined(separator: " ") }
        return s
    }

    /// The MCP entries that trusting would start or connect: stdio servers, remote (http/sse)
    /// servers, and a `.mcp.json` that could not be read (what it starts is unknown).
    static func withheld(_ n: ChatWorkspaceTrustNotice) -> [ChatWorkspaceTrustNotice.Skipped] {
        n.skipped.filter { $0.withheld && $0.kind.hasPrefix("mcp-") }
    }

    private static func nameList(_ items: [ChatWorkspaceTrustNotice.Skipped]) -> String {
        let names = items.prefix(4).map(\.name).joined(separator: ", ")
        return items.count > 4 ? "\(names) and \(items.count - 4) more" : names
    }

    /// One sentence per kind present; the program sentence appears only when a stdio server is listed.
    private static func effectSentences(_ held: [ChatWorkspaceTrustNotice.Skipped]) -> [String] {
        let stdio = held.filter { $0.kind == "mcp-stdio" }
        let remote = held.filter { $0.kind == "mcp-remote" }
        let unread = held.filter { $0.kind == "mcp-uninspected" }
        var out: [String] = []
        if !stdio.isEmpty { out.append("Each of these runs a program on this Mac: \(nameList(stdio)).") }
        if !remote.isEmpty { out.append("Each of these connects to a remote endpoint: \(nameList(remote)).") }
        if !unread.isEmpty { out.append("Its .mcp.json could not be read, so what it starts is unknown.") }
        return out
    }

    /// The confirmation shown before an explicit trust: what will run, by name.
    static func confirmationText(_ n: ChatWorkspaceTrustNotice) -> String {
        confirmation(path: n.path, held: withheld(n))
    }

    /// Path-only form (the Settings list has no notice): says what trusting means in general.
    static func confirmationText(path: String, servers: [String]) -> String {
        var s = "Trust \(path)?\n\nFrom now on, chats in this folder start the MCP servers its .mcp.json file defines"
        if servers.isEmpty {
            s += "; a server it defines can run a program on this Mac with your permissions or connect to a remote endpoint."
        } else {
            s += ", each of which runs a program on this Mac with your permissions: \(servers.joined(separator: ", "))."
        }
        return s + tail
    }

    private static let tail = "\n\nHooks and plugins inside a project folder are not loaded either way. Only trust folders whose contents you wrote or have read. You can turn this off again in Settings."

    private static func confirmation(path: String, held: [ChatWorkspaceTrustNotice.Skipped]) -> String {
        var s = "Trust \(path)?\n\nFrom now on, chats in this folder start the MCP servers its .mcp.json file defines."
        let sentences = effectSentences(held)
        if sentences.isEmpty {
            s += " A server it defines can run a program on this Mac with your permissions or connect to a remote endpoint."
        } else {
            s += " " + sentences.joined(separator: " ") + " They run with your permissions."
        }
        return s + tail
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
            if let m = serverMessage, !m.isEmpty { return m }
            return "The folder path was not accepted by the server."
        default:
            if let m = serverMessage, !m.isEmpty { return m }
            return "The trust setting could not be saved. Check that the backend is running and try again."
        }
    }

    static func kindText(_ kind: String) -> String {
        switch kind {
        case "mcp-stdio": return "MCP server"
        case "mcp-remote": return "remote MCP server"
        case "mcp-uninspected": return "MCP file that could not be read"
        case "hooks": return "hooks"
        case "plugin": return "plugin"
        case "skill-scripts": return "skill with scripts"
        default: return kind
        }
    }
}
