import Foundation

/// Pure presentation rules for the installed-extensions catalog screen: the
/// kind order and labels, what a consent names, and the user-facing text for
/// the server's stable error codes. No UI, no network, so it is unit tested.
enum ExtensionsCatalogPresentation {
    /// Fixed display order of the four item kinds.
    static let kindOrder = ["skill", "plugin", "mcp", "llm-source"]

    static func kindTitle(_ kind: String) -> String {
        switch kind {
        case "skill": return "Skills"
        case "plugin": return "Plugins"
        case "mcp": return "MCP servers"
        case "llm-source": return "Skill bundles"
        default: return kind.capitalized
        }
    }

    static func kindIcon(_ kind: String) -> String {
        switch kind {
        case "skill": return "sparkles"
        case "plugin": return "puzzlepiece.extension"
        case "mcp": return "server.rack"
        case "llm-source": return "books.vertical"
        default: return "shippingbox"
        }
    }

    /// Installed items grouped by kind in `kindOrder` (unknown kinds last),
    /// each group sorted by name; empty groups are dropped.
    static func grouped(_ items: [ExtInstalledItem]) -> [(kind: String, items: [ExtInstalledItem])] {
        let byKind = Dictionary(grouping: items, by: \.kind)
        let known = kindOrder.filter { byKind[$0] != nil }
        let extra = byKind.keys.filter { !kindOrder.contains($0) }.sorted()
        return (known + extra).map { kind in
            (kind, (byKind[kind] ?? []).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
        }
    }

    static func trustLabel(_ trust: String) -> String {
        switch trust {
        case "official": return "Official"
        case "local": return "Local"
        default: return "Unverified"
        }
    }

    static func shortCommit(_ commit: String) -> String { String(commit.prefix(8)) }

    /// `owner/repo` from a GitHub URL, or the URL itself when it is not one.
    static func repoName(_ url: String) -> String {
        guard let comps = URLComponents(string: url), comps.host?.lowercased() == "github.com" else { return url }
        var parts = comps.path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return url }
        if parts[1].hasSuffix(".git") { parts[1] = String(parts[1].dropLast(4)) }
        return "\(parts[0])/\(parts[1])"
    }

    static func hasUpdate(_ item: ExtInstalledItem) -> Bool {
        guard let latest = item.update?.latest else { return false }
        return latest != item.pinnedCommit
    }

    /// The executable kinds the user must name before the item may be switched on.
    static func consentKinds(_ item: ExtInstalledItem) -> [String] {
        ExtConsentKind.ordered(item.declared.executableKinds)
    }

    // MARK: Consent text

    /// One line per executable kind saying exactly what would run, built from
    /// the item's own members and permission summary.
    static func consentLines(kinds: [String], members: [ExtInstalledItem.Member],
                             permissions: [ExtInstalledItem.Permission]) -> [ExtConsentLine] {
        ExtConsentKind.ordered(kinds).map { kind in
            let names = members.filter { $0.type == kind }.map(\.name)
            let permission = permissions.first { $0.type == kind }?.text
            let what = ExtConsentKind.runs(kind)
            var detail = what
            if !names.isEmpty { detail += " Declared: " + names.joined(separator: ", ") + "." }
            if let permission, !permission.isEmpty { detail += " " + permission }
            return ExtConsentLine(kind: kind, title: ExtConsentKind.title(kind), detail: detail)
        }
    }

    // MARK: Errors

    /// A short sentence for an API error, with the operator hint where the
    /// fix is outside the app (the allowlist lives in Settings under Extension sources).
    static func message(forCode code: String, serverMessage: String) -> String {
        switch code {
        case "CATALOG_DISABLED":
            return "The extension catalog is turned off on this server (LLMIDE_EXT_CATALOG=off). Installing, updating and refreshing are unavailable until it is turned on."
        case "SOURCE_NOT_ALLOWED":
            return "This source is not on the allowed list. Add owner/repo (or owner/*) in Settings under Extension sources, then try again. If the setting refuses it, the operator's limit does not cover it and the operator has to allow it on the server."
        case "SOURCE_BLOCKED":
            return "This source is blocked and cannot be installed."
        case "ALREADY_INSTALLED":
            return "This item is already installed at another commit. Use Update instead of installing it again."
        case "ALREADY_CURRENT":
            return "Already up to date."
        case "MARKETPLACE":
            return "That repository is a marketplace, not a single extension. Pick one entry from the Browse tab."
        case "NOTHING_INSTALLABLE":
            return "Nothing installable was found in that repository (no skill, plugin or MCP entry)."
        case "BUSY":
            return "Another change to this item is in progress. Try again in a moment."
        case "BYTES_MISSING":
            return "The stored files for this item are missing or damaged. Run Repair first."
        case "IDENTITY_CHANGED":
            return "The new commit is a different item than the one installed, so it was refused."
        case "NO_PREVIOUS":
            return "There is no previous version to roll back to."
        case "PREVIOUS_UNAVAILABLE":
            return "The previous version's files are missing or damaged, so rollback is not possible."
        case "INTEGRITY_MISMATCH":
            return "The re-downloaded files do not match the recorded fingerprint, so nothing was overwritten."
        case "CONSENT_REQUIRED":
            return "This item can run code. Consent to each kind first."
        case "UPSTREAM":
            return "GitHub could not be reached or answered with an error. Try again later."
        case "TOO_LARGE":
            return "That repository is larger than the install limits allow."
        default:
            return serverMessage.isEmpty ? "Request failed (\(code))." : serverMessage
        }
    }

    static func message(for error: Error) -> String {
        if let api = error as? APIError, case .http(_, let code, let msg, _) = api {
            return message(forCode: code, serverMessage: msg)
        }
        return error.localizedDescription
    }

    static func errorCode(_ error: Error) -> String? {
        if let api = error as? APIError, case .http(_, let code, _, _) = api { return code }
        return nil
    }

    // MARK: Catalog

    static func reasonText(_ reason: String?) -> String {
        switch reason {
        case "package_launcher": return "Browse only: it would need a package launcher (npx/uvx) that is never run."
        case "registry_install_not_supported": return "Browse only: MCP registry entries cannot be installed from here. Open the repository link to set it up yourself."
        case "unsupported_source": return "Browse only: its source is not a GitHub repository path this screen can install."
        case "source_not_allowed": return "Not allowed: add the repository in Settings under Extension sources to install it."
        case .some(let r) where !r.isEmpty: return "Browse only (\(r))."
        default: return "Browse only."
        }
    }

    static func sourceStatusText(_ s: ExtCatalogSource) -> String {
        switch s.status {
        case "fresh": return "\(s.count) entries, up to date"
        case "stale": return "\(s.count) entries, older than 6 hours"
        case "empty": return "not fetched yet"
        case "error": return "last refresh failed (\(s.count) cached)"
        default: return s.status
        }
    }

    /// True when no source has ever been fetched (so "no results" means "no data yet").
    static func catalogNeverFetched(_ sources: [ExtCatalogSource]) -> Bool {
        !sources.isEmpty && sources.allSatisfy { $0.status == "empty" }
    }

    static func refreshSummary(_ r: ExtRefreshResult) -> String {
        let failed = r.results.filter { $0.status == "error" }
        let throttled = r.results.filter { $0.status == "throttled" }.count
        var parts = ["Refreshed \(r.results.filter { $0.status == "refreshed" }.count) of \(r.results.count) sources"]
        if throttled > 0 { parts.append("\(throttled) skipped (asked less than a minute ago)") }
        if !failed.isEmpty {
            parts.append("failed: " + failed.map { "\($0.id) (\($0.error ?? "error"))" }.joined(separator: ", "))
        }
        return parts.joined(separator: "; ") + "."
    }

    // MARK: Update preview

    static func flagText(_ flag: String) -> String {
        switch flag {
        case "new_executable_kind": return "Adds a new kind of code that can run"
        case "new_executable_member": return "Adds new members that can run code"
        case "new_findings": return "The scan found new warnings"
        case "consent_required": return "Needs your consent before it stays on"
        default: return flag
        }
    }

    static func updateOutcomeText(_ s: ExtUpdateSummary, verb: String) -> String {
        let move = "\(shortCommit(s.from)) to \(shortCommit(s.to))"
        if s.wasEnabled && !s.enabled {
            let kinds = s.kinds.isEmpty ? "" : " (" + s.kinds.joined(separator: ", ") + ")"
            return "\(verb) \(move). It was switched off until you consent to the code it can run\(kinds)."
        }
        return "\(verb) \(move)."
    }

    static func repairText(_ r: ExtRepairResult) -> String {
        switch r.status {
        case "ok": return "Files verified: nothing to repair."
        case "verified": return "Files verified against the source and a fingerprint was recorded."
        case "restored": return "Files restored at the pinned commit\(r.was.map { " (they were \($0))" } ?? "")."
        default: return "Repair finished (\(r.status))."
        }
    }
}

struct ExtConsentLine: Equatable, Identifiable {
    let kind: String
    let title: String
    let detail: String
    var id: String { kind }
}

enum ExtConsentKind {
    static let order = ["hook", "mcp", "lsp", "bin"]

    static func ordered(_ kinds: [String]) -> [String] {
        let set = Set(kinds)
        return order.filter(set.contains) + kinds.filter { !order.contains($0) }.sorted()
    }

    static func title(_ kind: String) -> String {
        switch kind {
        case "hook": return "Hooks"
        case "mcp": return "MCP servers"
        case "lsp": return "Language servers"
        case "bin": return "Executables"
        default: return kind
        }
    }

    static func runs(_ kind: String) -> String {
        switch kind {
        case "hook": return "Shell commands that run on your machine when the assistant triggers an event."
        case "mcp": return "MCP servers the assistant can start or connect to and call tools on."
        case "lsp": return "Language server programs started on your machine."
        case "bin": return "Executable programs from the item's bin folder that the assistant can run."
        default: return "Code of this kind runs on your machine."
        }
    }
}
