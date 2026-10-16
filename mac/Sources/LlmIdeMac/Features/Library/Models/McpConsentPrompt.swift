import Foundation

/// What the user is shown before consenting to an MCP server from the sidebar
/// row. Consent is the gate that lets the server process run with this user's
/// session, and the row itself only shows a one-line, truncated endpoint — so
/// granting it from there must spell out exactly what would run: the full
/// command and every argument (or the URL for a hosted server) plus the NAMES
/// of the environment variables and headers it is given. Values are never
/// shown: env values can be secrets, and header values arrive redacted anyway.
///
/// Revoking stays one click — it only takes power away.
struct McpConsentPrompt: Identifiable, Equatable {
    let pluginId: String
    let name: String
    let isHosted: Bool
    let command: String?
    let args: [String]
    let url: String?
    let envNames: [String]
    let headerNames: [String]

    var id: String { "mcpConsent:\(pluginId)" }

    init(pluginId: String, name: String, isHosted: Bool, command: String?, args: [String],
         url: String?, envNames: [String], headerNames: [String]) {
        self.pluginId = pluginId
        self.name = name
        self.isHosted = isHosted
        self.command = command
        self.args = args
        self.url = url
        self.envNames = envNames.sorted()
        self.headerNames = headerNames.sorted()
    }

    init(plugin: LlmIdeAPIClient.McpPluginInfo) {
        self.init(pluginId: plugin.id, name: plugin.name, isHosted: plugin.isHosted,
                  command: plugin.command, args: plugin.args, url: plugin.url,
                  envNames: Array((plugin.env ?? [:]).keys),
                  headerNames: Array((plugin.headers ?? [:]).keys))
    }

    var dialogTitle: String { "Allow “\(name)” to run?" }

    var confirmLabel: String { "Consent" }

    var message: String {
        var lines: [String] = []
        if isHosted {
            lines.append("Connects to: \(url ?? "(no url)")")
        } else {
            lines.append("Runs on this Mac: \(command ?? "(no command)")")
            if args.isEmpty {
                lines.append("Arguments: none")
            } else {
                // One argument per line, quoted, so an argument containing
                // spaces cannot be mistaken for two and nothing hides at the
                // end of a long line.
                lines.append("Arguments:")
                lines += args.map { "  “\($0)”" }
            }
        }
        lines.append("Environment variables: "
            + (envNames.isEmpty ? "none" : envNames.joined(separator: ", ")))
        if !headerNames.isEmpty {
            lines.append("Headers: " + headerNames.joined(separator: ", "))
        }
        lines.append("")
        lines.append("Once consented and enabled, the agent may start this server and call its tools.")
        return lines.joined(separator: "\n")
    }
}
