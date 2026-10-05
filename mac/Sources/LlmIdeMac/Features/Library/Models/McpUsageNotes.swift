import Foundation

/// What enabling an MCP server actually costs and where it works — one source
/// for the Library rows, the detail pane and the section header, so the three
/// cannot describe different rules.
///
/// The facts come from the server: `buildUserMcpServers(userId, mode)` returns
/// nothing for a restricted mode (plan, assist_plan, review, document) and mounts
/// every enabled + consented server otherwise, and the tool definitions ride on
/// every model call. The size is deliberately a range statement: the only
/// measurement is one user's two servers (about 6.7k tokens on Haiku, 8.8k on
/// Sonnet 5 per call), not a per-server figure.
enum McpUsageNotes {
    /// Where an enabled server is available.
    static let modeNote = "Available in Ask and Execute. Plan, Assist Plan, Review and Document never get MCP tools."

    /// What it costs while it is enabled.
    static let costNote = "While enabled, its tool definitions are added to every model call — typically a few thousand tokens per server, repeated on each step of a turn. Keep it off until you need it."

    /// One line for the section header: how many servers are costing tokens now.
    /// - Parameter enabledCount: servers that are both consented and enabled.
    static func sectionSummary(enabledCount: Int) -> String {
        guard enabledCount > 0 else {
            return "None enabled — MCP adds no tokens to your chats."
        }
        let noun = enabledCount == 1 ? "server" : "servers"
        return "\(enabledCount) \(noun) enabled — each adds its tool definitions to every Ask and Execute call."
    }
}
