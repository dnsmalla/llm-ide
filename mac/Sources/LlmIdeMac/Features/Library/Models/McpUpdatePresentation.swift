import Foundation

/// Wording and gating for MCP server version display and update / re-sync.
/// Pure, so the strings are testable without a view.
enum McpUpdatePresentation {
    /// The server exposes version routes from this API version on.
    static let minApiVersion = 62

    static func isSupported(serverApiVersion: Int?) -> Bool {
        (serverApiVersion ?? 0) >= minApiVersion
    }

    /// Where a server came from, as the detail subtitle says it.
    static func sourceLabel(source: String) -> String {
        switch source {
        case "catalog": return "Catalog"
        case "claude": return "Imported from Claude Code"
        case "codex": return "Imported from Codex"
        case "plugin": return "From plugin"
        default: return "Manually registered"
        }
    }

    /// `v1.2.3`, "unpinned" (runs whatever the registry serves), or nil for a
    /// server that is not version-managed.
    static func versionText(package: LlmIdeAPIClient.McpPackageSpec?) -> String? {
        guard let package else { return nil }
        if let version = package.version, !version.isEmpty { return "v\(version)" }
        return "unpinned"
    }

    /// The button label for a check result, or nil when there is nothing to do.
    static func actionTitle(status: String, latest: String?) -> String? {
        guard let latest, !latest.isEmpty else { return nil }
        switch status {
        case "update-available": return "Update to \(latest)"
        case "unpinned": return "Pin to \(latest)"
        default: return nil
        }
    }

    /// Shown after an update / re-sync: the server revokes every user's consent.
    static let afterChangeMessage = "Consent was reset — approve again to use it."

    /// Fields a re-sync would change, for the drift line.
    static func driftText(changes: [String]) -> String {
        "Differs from its source: \(changes.joined(separator: ", "))"
    }
}
