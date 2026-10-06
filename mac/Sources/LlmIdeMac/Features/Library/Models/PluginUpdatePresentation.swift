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

    /// How the Library updates one plugin.
    enum UpdateAction: Equatable {
        /// Claude Code's own update, then a re-import (v60+ server).
        case claudeOneClick
        case reimportClaude
        case reimportCodex
        /// Clone the recorded git URL / ref again and replace.
        case gitReinstall
        /// Fetch the recorded marketplace again and replace its entry.
        case marketplaceReinstall
        /// Installed from a file: only the user can pick the newer one.
        case replaceFromFile
        case none
    }

    static func action(for info: PluginInfo, entry: PluginUpdateEntry?, oneClick: Bool) -> UpdateAction {
        action(name: info.name, origin: info.origin, installSource: info.installSource,
               entry: entry, oneClick: oneClick)
    }

    /// The recorded install source wins over the vendor origin and over the
    /// name: a zip that happens to be named `claude-x` was not imported, and
    /// re-importing it would pull a different package from Claude Code.
    ///
    /// With neither a source nor an origin (a server predating both), the
    /// `claude-` / `codex-` prefix is the only sign of an import left; anything
    /// else came from a file.
    static func action(name: String, origin: String?, installSource: PluginInstallSource?,
                       entry: PluginUpdateEntry?, oneClick: Bool) -> UpdateAction {
        switch installSource?.kind {
        case "git": return .gitReinstall
        case "marketplace": return .marketplaceReinstall
        case "zip": return .replaceFromFile
        default: break
        }
        var vendor = origin
        if vendor == nil && installSource == nil {
            if name.hasPrefix("claude-") {
                vendor = "claude"
            } else if name.hasPrefix("codex-") {
                vendor = "codex"
            } else {
                return .replaceFromFile
            }
        }
        switch vendor {
        case "claude":
            // A row the check answered from the local scan (no CLI) has no
            // pluginId: the one-click route needs Claude's plugin id.
            let localRow = entry.map { $0.pluginId == nil } ?? false
            return oneClick && !localRow ? .claudeOneClick : .reimportClaude
        case "codex":
            return .reimportCodex
        default:
            return .none
        }
    }

    /// The detail header's "where it came from" line, or nil when unrecorded.
    static func sourceDescription(_ source: PluginInstallSource) -> String? {
        switch source.kind {
        case "git":
            guard let url = source.url else { return nil }
            let ref = source.ref.map { " @ \($0)" } ?? ""
            let commit = source.commit.map { " (\($0.prefix(7)))" } ?? ""
            return "From git: \(url)\(ref)\(commit)"
        case "marketplace":
            guard let url = source.url else { return nil }
            let entry = source.entry.map { "\($0) from " } ?? ""
            let version = source.version.map { " · v\($0)" } ?? ""
            return "Marketplace: \(entry)\(url)\(version)"
        case "zip":
            return source.fileName.map { "Installed from file \($0)" }
        default:
            return nil
        }
    }

    /// Detail-pane status line for an update found at a git / marketplace source.
    static func sourceAvailabilityText(kind: String, latest: String?) -> String {
        if kind == "git" { return "The git source has a newer commit." }
        let target = latest.map { " v\($0)" } ?? ""
        return "The marketplace has a newer version\(target)."
    }

    /// A source check that could not answer for one plugin.
    static func sourceCheckFailedMessage(name: String, reason: String) -> String {
        "Could not check \(name) for updates: \(reason)."
    }

    /// After a git / marketplace re-install. The source may now hold a plugin
    /// under another name: then that one was installed and `name` is unchanged.
    static func reinstalledMessage(name: String, installedName: String, version: String,
                                   trustReset: Bool) -> String {
        var lines: [String] = []
        if installedName == name {
            lines.append("Updated \(name) to v\(version).")
        } else {
            lines.append("The source of \(name) now provides \(installedName) v\(version); "
                + "it was installed under that name and \(name) is unchanged.")
        }
        if trustReset { lines.append("Hooks/MCP of \(installedName) were reset and need re-approval.") }
        return lines.joined(separator: "\n")
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

    /// After a plugin was replaced from a zip, git or a marketplace: the new
    /// version, and — when the server cleared hook trust / MCP consents — that
    /// they must be approved again.
    static func replacedMessage(name: String, version: String, trustReset: Bool) -> String {
        var text = "Replaced \(name) — now v\(version)."
        if trustReset { text += "\nHooks/MCP of \(name) were reset and need re-approval." }
        return text
    }

    /// The message for one finished update (nil for `.needsConfirmation`,
    /// which opens the confirmation sheet instead of saying anything).
    static func message(name: String, outcome: PluginUpdateOutcome) -> String? {
        switch outcome {
        case let .updated(from, to, trustReset, claudeUpdated):
            return updatedMessage(name: name, from: from, to: to, trustReset: trustReset, claudeUpdated: claudeUpdated)
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

    private static func updatedMessage(name: String, from: String?, to: String?, trustReset: Bool,
                                       claudeUpdated: Bool) -> String {
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
        // Only when Claude Code's own install moved: an offline re-import of
        // what Claude already had needs no restart there.
        if claudeUpdated {
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

    /// The Library alert text for a finished update: an earlier "Update all"
    /// summary, then this update's own message. nil when both are empty —
    /// never "", which would open an empty alert.
    static func libraryMessage(prefix: String?, message: String?) -> String? {
        let parts = [prefix, message].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    private static func detailSuffix(_ detail: String) -> String {
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "" : ": \(trimmed)"
    }
}

/// How one plugin update ended, as the update center sequences it.
enum PluginUpdateStep: Equatable {
    /// Stopped for a marketplace-declared command the user must see first.
    case confirm(command: String, sha256: String)
    /// `claudeUpdated`: Claude Code's own install changed (drives the restart note).
    case done(message: String, succeeded: Bool, trustReset: Bool, stopsBatch: Bool, claudeUpdated: Bool = false)
    /// Finished after a sign-out: nothing may be shown or written.
    case discarded

    /// The step a server outcome maps to. Busy / in-progress stop an
    /// "Update all": every remaining plugin would be refused the same way.
    init(name: String, outcome: PluginUpdateOutcome) {
        let message = PluginUpdatePresentation.message(name: name, outcome: outcome) ?? ""
        switch outcome {
        case let .needsConfirmation(command, sha256):
            self = .confirm(command: command, sha256: sha256)
        case let .updated(_, _, trustReset, claudeUpdated):
            self = .done(message: message, succeeded: true, trustReset: trustReset, stopsBatch: false,
                         claudeUpdated: claudeUpdated)
        case .busy, .inProgress:
            self = .done(message: message, succeeded: false, trustReset: false, stopsBatch: true)
        case .cliFailed, .reimportFailed, .notFound:
            self = .done(message: message, succeeded: false, trustReset: false, stopsBatch: false)
        }
    }

    var stopsBatch: Bool {
        if case let .done(_, _, _, stops, _) = self { return stops }
        return false
    }
}

/// A marketplace-declared command the user must see before an update runs.
struct PluginUpdateConfirmation: Identifiable, Equatable {
    let pluginName: String
    let command: String
    let sha256: String
    var id: String { pluginName + "@" + sha256 }
}
