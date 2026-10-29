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

    /// The short capsule on a list row. A plugin-declared server must not read
    /// as "manual": it is not hand-registered and cannot be removed by hand.
    static func sourceBadge(source: String) -> String {
        switch source {
        case "catalog", "claude", "codex", "plugin": return source
        default: return "manual"
        }
    }

    /// Result line for a user-requested check. The server answers a forced
    /// check from its cache when it declines to force, so the line states the
    /// server's own `checkedAt` instead of claiming a fresh lookup.
    static func checkedText(checkedAt: String?, upToDate: Bool) -> String {
        let head = checkedAt.flatMap(Self.timeText).map { "Checked at \($0)" } ?? "Checked (cached)"
        return upToDate ? "\(head) — up to date." : "\(head)."
    }

    private static func timeText(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) ?? plain.date(from: iso) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
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
