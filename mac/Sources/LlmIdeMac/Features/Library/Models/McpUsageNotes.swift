import Foundation

/// What enabling an MCP server actually costs and where it works — one source
/// for the Library rows, the detail pane and the section header, so the three
/// cannot describe different rules.
///
/// The facts come from the server: `buildUserMcpServers(userId, mode)` returns
/// nothing for a restricted mode — every mode in `MODE_CONFIG`: plan,
/// assist_plan, review, document AND ask — so only Execute (including an Auto
/// turn the classifier sends to Execute) mounts the effective servers. The quick
/// chat surfaces (menu bar, chat sheet, iPhone) are clamped to Ask, so they
/// never get MCP either. The tool definitions ride on every model call. The size is deliberately a range statement: the only
/// measurement is one user's two servers (about 6.7k tokens on Haiku, 8.8k on
/// Sonnet 5 per call), not a per-server figure.
enum McpUsageNotes {
    /// Where an enabled server is available.
    static let modeNote = "Available in Execute mode only (Auto counts when it picks Execute). Plan, Assist Plan, Review, Document and Ask — and the menu bar, chat sheet and phone — never get MCP tools."

    /// What it costs while it is enabled.
    static let costNote = "While enabled, its tool definitions are added to every model call — typically a few thousand tokens per server, repeated on each step of a turn. Keep it off until you need it."

    /// One line for the section header: how many servers are costing tokens now.
    /// - Parameter enabledCount: servers that are both consented and enabled.
    static func sectionSummary(enabledCount: Int) -> String {
        guard enabledCount > 0 else {
            return "None enabled — MCP adds no tokens to your chats."
        }
        let noun = enabledCount == 1 ? "server" : "servers"
        return "\(enabledCount) \(noun) enabled — each adds its tool definitions to every Execute call."
    }
}
