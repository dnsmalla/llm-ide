import Foundation

/// One destructive Library action that must be confirmed before it runs, with
/// the words shown in the confirmation. The row context menus and the detail
/// panes' Remove buttons both ask for the same dialog, so the consequence is
/// described once and cannot differ between the two ways to reach it.
///
/// What each sentence says is a fact about the server:
/// - uninstalling a plugin deletes its files and prunes its enable / trust
///   state (`pruneOrphans`), so reinstalling asks for trust again;
/// - the MCP registry is ONE file shared by every user of the machine
///   (`mcp/state.mjs`), so a removed server disappears for all of them;
/// - removing a connector only un-selects its card (ConnectorDetailView).
enum LibraryRemoval: Identifiable, Equatable {
    case plugin(name: String, title: String)
    case mcpServer(id: String, name: String)
    case connector(id: String, name: String)

    var id: String {
        switch self {
        case .plugin(let name, _): return "plugin:\(name)"
        case .mcpServer(let id, _): return "mcp:\(id)"
        case .connector(let id, _): return "connector:\(id)"
        }
    }

    var dialogTitle: String {
        switch self {
        case .plugin(_, let title): return "Uninstall “\(title)”?"
        case .mcpServer(_, let name): return "Remove “\(name)”?"
        case .connector(_, let name): return "Remove “\(name)”?"
        }
    }

    var message: String {
        switch self {
        case .plugin:
            return "Its files are deleted, along with any trust you gave it. You can reinstall it later, but you will have to trust it again."
        case .mcpServer:
            return "The server leaves the shared MCP registry, so it disappears for every user of this Mac, and its consent and enable settings are dropped."
        case .connector:
            return "Its card is hidden here. Files, notes and credentials it already produced are kept."
        }
    }

    var confirmLabel: String {
        switch self {
        case .plugin: return "Uninstall"
        case .mcpServer, .connector: return "Remove"
        }
    }
}

/// The confirmation shown before TURNING ON hook trust, which authorizes the
/// plugin's code to run with the same access as the app. Turning it off needs
/// none: taking a grant back must always be one click.
enum PluginTrustConfirmation {
    static func title(_ plugin: PluginInfo) -> String {
        "Trust “\(plugin.title)”?"
    }

    /// The same explanation the toggle shows, so the dialog cannot promise less
    /// (or more) than the page does.
    static func message(_ plugin: PluginInfo) -> String {
        PluginTrustPresentation.trustExplanation(plugin)
    }

    static let confirmLabel = "Trust"
}
