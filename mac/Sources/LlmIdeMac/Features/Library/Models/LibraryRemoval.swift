import Foundation

/// One destructive Library action that must be confirmed before it runs, with
/// the words shown in the confirmation. The row context menus and the detail
/// panes' Remove buttons both ask for the same dialog, so the consequence is
/// described once and cannot differ between the two ways to reach it.
///
/// What each sentence says is a fact about the server:
/// - removing a connector only un-selects its card (ConnectorDetailView);
/// - disconnecting Email / Slack / Box deletes the vault credentials, which
///   for an OAuth connection means signing in through the browser again.
///
/// Plugin, MCP-server and LLM-source removals are `ExtensionRemoval`
/// (`Features/Extensions/`).
enum LibraryRemoval: Identifiable, Equatable {
    case connector(id: String, name: String)
    case sourceDisconnect(SourceLinkStore.SourceKind)

    var id: String {
        switch self {
        case .connector(let id, _): return "connector:\(id)"
        case .sourceDisconnect(let kind): return "disconnect:\(Self.sourceName(kind))"
        }
    }

    var dialogTitle: String {
        switch self {
        case .connector(_, let name): return "Remove “\(name)”?"
        case .sourceDisconnect(let kind): return "Disconnect \(Self.sourceName(kind))?"
        }
    }

    var message: String {
        switch self {
        case .connector:
            return "Its card is hidden here. Files, notes and credentials it already produced are kept."
        case .sourceDisconnect(let kind):
            switch kind {
            case .email:
                return "The source is removed and its app password and Google sign-in are deleted from the vault. Reconnecting means signing in again. Notes already imported are kept."
            case .slack:
                return "The source is removed and its Slack tokens are deleted from the vault. Reconnecting means approving LLM-IDE in Slack again. Notes already imported are kept."
            case .box:
                return "The source is removed and its client secret is deleted from the vault. Reconnecting means pasting the secret again. Notes already imported are kept."
            }
        }
    }

    var confirmLabel: String {
        switch self {
        case .connector: return "Remove"
        case .sourceDisconnect: return "Disconnect"
        }
    }

    private static func sourceName(_ kind: SourceLinkStore.SourceKind) -> String {
        switch kind {
        case .email: return "Email"
        case .slack: return "Slack"
        case .box: return "Box"
        }
    }
}
