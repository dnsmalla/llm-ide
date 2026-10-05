import Foundation

/// What the Library says about a plugin update — the tier → badge / button
/// mapping and the result messages, kept free of SwiftUI so it is testable.
enum PluginUpdatePresentation {
    /// The server API version that serves the tiered check and
    /// `POST /auth/me/claude-plugins/update`. Below it, the Library keeps the
    /// re-import path (an older server has neither).
    static let oneClickUpdateApiVersion = 60

    /// nil (not probed yet) counts as old: the re-import path is safe on any
    /// server, the new endpoint is not.
    static func supportsOneClickUpdate(serverApiVersion: Int?) -> Bool {
        (serverApiVersion ?? 0) >= oneClickUpdateApiVersion
    }

    /// The name llm-ide stores a Claude Code plugin under — the server's rule
    /// (extension/plugins/claude-adapter.mjs): "claude-" is added only when
    /// the name does not already carry it.
    static func claudeImportName(for claudeName: String) -> String {
        claudeName.hasPrefix("claude-") ? claudeName : "claude-" + claudeName
    }

    /// Sidebar badge text, or nil for no badge.
    static func badge(for tier: String?) -> String? {
        isKnownTier(tier) ? "Update" : nil
    }

    /// The detail pane's primary button. With no reported tier the update is
    /// still one click away: it re-fetches and says "already latest" when
    /// nothing changed.
    static func buttonTitle(tier: String?) -> String {
        isKnownTier(tier) ? "Update" : "Update (re-fetch)"
    }

    private static func isKnownTier(_ tier: String?) -> Bool {
        tier == "reimport" || tier == "upstream"
    }

    /// Detail-pane status line for a reported update.
    static func availabilityText(_ entry: PluginUpdateEntry) -> String {
        let target = entry.targetVersion.map { " v\($0)" } ?? ""
        switch entry.tier {
        case "reimport": return "Claude Code already has\(target) — llm-ide's copy is behind."
        default: return "A newer version\(target) is available."
        }
    }

    /// The message for one finished update (nil for `.needsConfirmation`,
    /// which opens the confirmation sheet instead of saying anything).
    static func message(name: String, outcome: PluginUpdateOutcome) -> String? {
        switch outcome {
        case let .updated(from, to, trustReset):
            return updatedMessage(name: name, from: from, to: to, trustReset: trustReset)
        case .needsConfirmation:
            return nil
        case .inProgress:
            return "Another plugin update is running. Try again when it finishes."
        case .busy:
            return "A chat turn is running. Update \(name) once it finishes."
        case let .cliFailed(detail):
            return "Claude Code could not update \(name)\(detailSuffix(detail)). Nothing was changed."
        case let .reimportFailed(detail):
            return "Claude Code updated \(name), but llm-ide could not import it\(detailSuffix(detail)). "
                + "The previous copy is kept; try the update again."
        case .notFound:
            return "\(name) is not installed in Claude Code any more."
        }
    }

    private static func updatedMessage(name: String, from: String?, to: String?, trustReset: Bool) -> String {
        var lines: [String] = []
        let unchanged: Bool = from != nil && from == to
        if unchanged, let to {
            // A re-fetch of the same version can still change executables
            // (same version string, new contents); the trust notice must stay.
            lines.append("\(name) is already the latest version (v\(to)).")
        } else if let from, let to {
            lines.append("Updated \(name) from v\(from) to v\(to).")
        } else if let to {
            lines.append("Updated \(name) to v\(to).")
        } else {
            lines.append("Updated \(name).")
        }
        if trustReset {
            lines.append("Hooks/MCP of \(name) changed — review and re-approve them.")
        }
        // Claude Code's install did not move when the version is unchanged.
        if !unchanged {
            lines.append("Restart Claude Code to use the new version there.")
        }
        return lines.joined(separator: "\n")
    }

    /// The Library alert after "Update all": counts, each failure's own
    /// message, each trust reset, and the restart note when Claude moved.
    static func updateAllSummary(succeeded: Int, failures: [(name: String, message: String)],
                                 trustResets: [String], claudeUpdated: Bool) -> String {
        var lines: [String] = []
        if failures.isEmpty {
            let plural: String = succeeded == 1 ? "" : "s"
            lines.append("Updated \(succeeded) plugin\(plural).")
        } else {
            lines.append("Updated \(succeeded) of \(succeeded + failures.count).")
            for failure in failures {
                lines.append(failure.message.isEmpty ? "\(failure.name) failed." : failure.message)
            }
        }
        for name in trustResets {
            lines.append("Hooks/MCP of \(name) changed — review and re-approve them.")
        }
        if claudeUpdated { lines.append("Restart Claude Code to use the new version there.") }
        return lines.joined(separator: "\n")
    }

    private static func detailSuffix(_ detail: String) -> String {
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "" : ": \(trimmed)"
    }
}

/// A marketplace-declared command the user must see before an update runs.
struct PluginUpdateConfirmation: Identifiable, Equatable {
    let pluginName: String
    let command: String
    let sha256: String
    var id: String { pluginName + "@" + sha256 }
}
