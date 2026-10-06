import Foundation
import Testing
@testable import LlmIdeMacLib

/// Pins the Library's plugin-update wording and the v60 wire shapes:
/// the tier → badge / button mapping, the update-check decode, and how each
/// `POST /auth/me/claude-plugins/update` answer maps to an outcome (409 / 502 /
/// 404 bodies carry a top-level `code`, not the `{error:{…}}` envelope).

@Test func tierMapsToBadgeAndTitle() {
    #expect(PluginUpdatePresentation.badge(for: "reimport") == "Update")
    #expect(PluginUpdatePresentation.badge(for: "upstream") == "Update")
    #expect(PluginUpdatePresentation.badge(for: nil) == nil)
    #expect(PluginUpdatePresentation.badge(for: "something-new") == nil)
    #expect(PluginUpdatePresentation.buttonTitle(tier: "reimport") == "Update")
    #expect(PluginUpdatePresentation.buttonTitle(tier: "upstream") == "Update")
    #expect(PluginUpdatePresentation.buttonTitle(tier: nil) == "Update (re-fetch)")
}

@Test func decodesUpdateCheck() throws {
    let json = #"{"cli":true,"checkedAt":"t","updates":[{"name":"claude-a","pluginId":"a@mp","importedVersion":"1.0.0","claudeVersion":"1.1.0","latest":null,"tier":"reimport"}]}"#
    let v = try JSONDecoder().decode(PluginUpdateCheck.self, from: Data(json.utf8))
    #expect(v.cli)
    #expect(v.updates.first?.tier == "reimport")
    #expect(v.updates.first?.targetVersion == "1.1.0")
    #expect(v.updates.first?.sourcePluginName == "a")
}

@Test func decodesCheckWithLegacyFields() throws {
    // What a v60 server actually sends: the new row plus the pre-v60 fields.
    let json = #"{"cli":false,"checkedAt":"t","updates":[{"name":"codex-docs","pluginId":null,"importedVersion":"1.0.0","claudeVersion":"2.0.0","latest":"2.0.0","tier":"upstream","sourceVersion":"2.0.0","source":"installed"}]}"#
    let row = try #require(try JSONDecoder().decode(PluginUpdateCheck.self, from: Data(json.utf8)).updates.first)
    #expect(row.pluginId == nil)
    #expect(row.source == "installed")
}

@Test func serverVersionGate() {
    #expect(!PluginUpdatePresentation.supportsOneClickUpdate(serverApiVersion: nil))
    #expect(!PluginUpdatePresentation.supportsOneClickUpdate(serverApiVersion: 59))
    #expect(PluginUpdatePresentation.supportsOneClickUpdate(serverApiVersion: 60))
}

@Test func updateOutcomeDecoding() {
    func outcome(_ status: Int, _ json: String) -> PluginUpdateOutcome? {
        PluginUpdateOutcome.decode(status: status, data: Data(json.utf8))
    }
    #expect(outcome(200, #"{"ok":true,"from":"1.0.0","to":"1.1.0","trustReset":true,"claudeUpdated":true}"#)
            == .updated(from: "1.0.0", to: "1.1.0", trustReset: true, claudeUpdated: true))
    // An older v60 body without the field: Claude's install is not assumed moved.
    #expect(outcome(200, #"{"ok":true,"from":"1.0.0","to":"1.1.0","trustReset":false}"#)
            == .updated(from: "1.0.0", to: "1.1.0", trustReset: false, claudeUpdated: false))
    #expect(outcome(200, #"{"ok":false,"code":"REIMPORT_FAILED","claudeUpdated":true,"detail":"x"}"#)
            == .reimportFailed("x"))
    #expect(outcome(409, #"{"code":"NEEDS_CONFIRMATION","command":"npm i","sha256":"abc123"}"#)
            == .needsConfirmation(command: "npm i", sha256: "abc123"))
    #expect(outcome(409, #"{"code":"UPDATE_IN_PROGRESS"}"#) == .inProgress)
    #expect(outcome(409, #"{"code":"BUSY"}"#) == .busy)
    #expect(outcome(502, #"{"code":"CLI_FAILED","detail":"exit 1"}"#) == .cliFailed("exit 1"))
    #expect(outcome(404, #"{"code":"NOT_FOUND"}"#) == .notFound)
    // The error envelope is not an outcome: the client throws for it instead.
    #expect(outcome(500, #"{"error":{"code":"UPDATE_FAILED","message":"boom"}}"#) == nil)
    #expect(outcome(404, #"{"error":{"code":"NOT_FOUND","message":"no route"}}"#) == nil)
}

@Test func successMessageMentionsTrustAndRestart() throws {
    let updated = try #require(PluginUpdatePresentation.message(
        name: "claude-a", outcome: .updated(from: "1.0.0", to: "1.1.0", trustReset: true, claudeUpdated: true)))
    #expect(updated.contains("Hooks/MCP of claude-a changed — review and re-approve them."))
    #expect(updated.contains("Restart Claude Code to use the new version there."))

    // Tier 1 offline re-import: llm-ide's copy moved, Claude Code's did not.
    let offline = try #require(PluginUpdatePresentation.message(
        name: "claude-a", outcome: .updated(from: "1.0.0", to: "1.1.0", trustReset: false, claudeUpdated: false)))
    #expect(offline.contains("Updated claude-a from v1.0.0 to v1.1.0."))
    #expect(!offline.contains("Restart Claude Code"))

    // Re-fetch of the same version, nothing executable changed: no restart,
    // no trust notice.
    let latest = try #require(PluginUpdatePresentation.message(
        name: "claude-a", outcome: .updated(from: "1.1.0", to: "1.1.0", trustReset: false, claudeUpdated: false)))
    #expect(latest.contains("already the latest"))
    #expect(!latest.contains("Restart Claude Code"))
    #expect(!latest.contains("Hooks/MCP"))

    // Same version, but its executables changed: the trust notice must stay.
    let latestReset = try #require(PluginUpdatePresentation.message(
        name: "claude-a", outcome: .updated(from: "1.1.0", to: "1.1.0", trustReset: true, claudeUpdated: false)))
    #expect(latestReset.contains("already the latest"))
    #expect(latestReset.contains("Hooks/MCP of claude-a changed — review and re-approve them."))
    #expect(!latestReset.contains("Restart Claude Code"))

    #expect(PluginUpdatePresentation.message(
        name: "claude-a", outcome: .needsConfirmation(command: "c", sha256: "s")) == nil)
}

@Test func legacyRowConvertsToEntry() throws {
    let json = #"{"updates":[{"name":"claude-x","importedVersion":"1.0.0","sourceVersion":"1.4.0","source":"marketplace"}]}"#
    let legacy = try #require(try JSONDecoder().decode(PluginUpdatesResponse.self, from: Data(json.utf8)).updates.first)
    let entry = PluginUpdateEntry(legacy: legacy)
    #expect(entry.tier == "upstream")
    #expect(entry.targetVersion == "1.4.0")
    #expect(entry.source == "marketplace")
}

@Test func claudeImportNameFollowsServerRule() {
    #expect(PluginUpdatePresentation.claudeImportName(for: "code-review") == "claude-code-review")
    // Already prefixed: the server does not double it.
    #expect(PluginUpdatePresentation.claudeImportName(for: "claude-tools") == "claude-tools")
}

@Test func updateAllSummaryListsEachFailure() {
    let summary = PluginUpdatePresentation.updateAllSummary(
        succeeded: 1,
        failures: [(name: "claude-b", message: "Claude Code could not update claude-b: exit 1. Nothing was changed.")],
        trustResets: ["claude-a"], claudeUpdated: true)
    #expect(summary.contains("Updated 1 of 2."))
    #expect(summary.contains("Claude Code could not update claude-b: exit 1."))
    #expect(summary.contains("Hooks/MCP of claude-a changed"))
    #expect(summary.contains("Restart Claude Code"))
}

@Test func outcomeMapsToStep() {
    #expect(PluginUpdateStep(name: "claude-a", outcome: .needsConfirmation(command: "c", sha256: "s"))
            == .confirm(command: "c", sha256: "s"))
    // Busy / in-progress stop an "Update all"; a single failure does not.
    #expect(PluginUpdateStep(name: "claude-a", outcome: .busy).stopsBatch)
    #expect(PluginUpdateStep(name: "claude-a", outcome: .inProgress).stopsBatch)
    #expect(!PluginUpdateStep(name: "claude-a", outcome: .cliFailed("x")).stopsBatch)
    #expect(!PluginUpdateStep(name: "claude-a", outcome: .notFound).stopsBatch)
    #expect(!PluginUpdateStep.discarded.stopsBatch)
    guard case let .done(_, ok, trustReset, _, claudeUpdated) = PluginUpdateStep(
        name: "claude-a", outcome: .updated(from: "1", to: "2", trustReset: true, claudeUpdated: true)) else {
        Issue.record("updated must map to .done")
        return
    }
    #expect(ok)
    #expect(trustReset)
    #expect(claudeUpdated)
}

@Test func libraryMessageIsNeverEmpty() {
    // A dropped (discarded) result must not open an empty alert.
    #expect(PluginUpdatePresentation.libraryMessage(prefix: nil, message: "") == nil)
    #expect(PluginUpdatePresentation.libraryMessage(prefix: "", message: nil) == nil)
    #expect(PluginUpdatePresentation.libraryMessage(prefix: nil, message: nil) == nil)
    #expect(PluginUpdatePresentation.libraryMessage(prefix: "a", message: "") == "a")
    #expect(PluginUpdatePresentation.libraryMessage(prefix: "a", message: "b") == "a\n\nb")
}

@Test func replacedMessageNamesTrustReset() {
    #expect(PluginUpdatePresentation.replacedMessage(name: "x", version: "2.0.0", trustReset: false)
        == "Replaced x — now v2.0.0.")
    #expect(PluginUpdatePresentation.replacedMessage(name: "x", version: "2.0.0", trustReset: true)
        .contains("were reset and need re-approval"))
}

// MARK: - Update routing by install source

private let routeSha = String(repeating: "a", count: 40)

private func route(_ name: String, origin: String? = nil, source: PluginInstallSource? = nil,
                   entry: PluginUpdateEntry? = nil, oneClick: Bool = true) -> PluginUpdatePresentation.UpdateAction {
    PluginUpdatePresentation.action(name: name, origin: origin, installSource: source, entry: entry, oneClick: oneClick)
}

@Test func actionRoutesByInstallSourceFirst() {
    let git = PluginInstallSource.git(url: "https://github.com/o/r", ref: "main", commit: routeSha)
    let market = PluginInstallSource.marketplace(url: "https://github.com/o/m", ref: nil, commit: routeSha,
                                                 entry: "x", path: "plugins/x", tree: routeSha, version: "1.0.0")
    let zip = PluginInstallSource.zip(fileName: "x.zip")
    #expect(route("x", source: git) == .gitReinstall)
    #expect(route("x", source: market) == .marketplaceReinstall)
    #expect(route("x", source: zip) == .replaceFromFile)
    // The record outranks the vendor origin too.
    #expect(route("claude-x", origin: "claude", source: git) == .gitReinstall)
}

@Test func zipNamedLikeAnImportIsNeverReimported() {
    let zip = PluginInstallSource.zip(fileName: "claude-x.zip")
    #expect(route("claude-x", source: zip) == .replaceFromFile)
    #expect(route("claude-x", source: zip, oneClick: false) == .replaceFromFile)
    #expect(route("codex-x", source: zip) == .replaceFromFile)
}

@Test func actionRoutesVendorImports() {
    #expect(route("claude-x", origin: "claude") == .claudeOneClick)
    #expect(route("claude-x", origin: "claude", oneClick: false) == .reimportClaude)
    // A locally-answered row (no pluginId) cannot take the one-click route.
    let local = PluginUpdateEntry(name: "claude-x", pluginId: nil, importedVersion: "1", claudeVersion: "2",
                                  latest: nil, tier: "reimport", source: nil)
    #expect(route("claude-x", origin: "claude", entry: local) == .reimportClaude)
    #expect(route("codex-x", origin: "codex") == .reimportCodex)
}

@Test func actionWithoutSourceOrOrigin() {
    // A server predating `origin` (< v60): the prefix is the only import sign left.
    #expect(route("claude-x", oneClick: false) == .reimportClaude)
    #expect(route("codex-x", oneClick: false) == .reimportCodex)
    #expect(route("plain", oneClick: false) == .replaceFromFile)
    // A server that reports origin and gave none: not an import, whatever the name.
    #expect(route("claude-x") == .replaceFromFile)
    #expect(route("codex-x") == .replaceFromFile)
    #expect(route("plain") == .replaceFromFile)
    // An origin this client does not know, with no source: nothing to do.
    #expect(route("x", origin: "other") == PluginUpdatePresentation.UpdateAction.none)
}

@Test func actionForDecodedPluginInfo() throws {
    let json = #"{"name":"claude-x","version":"1.0.0","displayName":"X","description":"","author":"","enabled":true,"skillCount":0,"commands":[],"installSource":{"kind":"zip","fileName":"claude-x.zip"}}"#
    let info = try JSONDecoder().decode(PluginInfo.self, from: Data(json.utf8))
    #expect(PluginUpdatePresentation.action(for: info, entry: nil, oneClick: true) == .replaceFromFile)
}

@Test func sourceMessages() {
    let git = PluginInstallSource.git(url: "https://github.com/o/r", ref: "main", commit: routeSha)
    #expect(PluginUpdatePresentation.sourceDescription(git) == "From git: https://github.com/o/r @ main (aaaaaaa)")
    #expect(PluginUpdatePresentation.sourceDescription(.zip(fileName: "a.zip")) == "Installed from file a.zip")
    #expect(PluginUpdatePresentation.sourceAvailabilityText(kind: "marketplace", latest: "2.0")
        == "The marketplace has a newer version v2.0.")
    let updated = PluginUpdatePresentation.reinstalledMessage(name: "a", version: "1", trustReset: true)
    #expect(updated.hasPrefix("Updated a to v1.") && updated.contains("need re-approval"))
}

@Test func nameMismatchIsRefusedWithTheProvidedName() {
    let server = "plugin source now provides 'other', not 'mine'"
    #expect(PluginUpdatePresentation.nameMismatchMessage(name: "mine", serverMessage: server)
        == "The source now provides other, not mine; nothing was replaced.")
    #expect(PluginUpdatePresentation.nameMismatchMessage(name: "mine", serverMessage: "odd")
        == "The source now provides another plugin, not mine; nothing was replaced.")
    let error = APIError.http(status: 409, code: "NAME_MISMATCH", message: server, details: nil)
    #expect(PluginUpdatePresentation.updateFailureMessage(name: "mine", error: error).contains("nothing was replaced"))
    let other = APIError.http(status: 409, code: "INSTALL_FAILED", message: "x", details: nil)
    #expect(PluginUpdatePresentation.updateFailureMessage(name: "mine", error: other).hasPrefix("Could not update mine"))
}

@Test func installPlanFallsBackToZipOnlyOnReplace() {
    let git = PluginInstallSource.git(url: "https://github.com/o/r", ref: nil, commit: routeSha)
    let badGit = PluginInstallSource.git(url: "file:///etc", ref: nil, commit: routeSha)
    let zip = PluginInstallSource.zip(fileName: "p.zip")
    // A sendable source goes first; on replace its retry is the zip stand-in.
    var plan = PluginInstallSource.installPlan(source: git, replace: true, fallbackFileName: "p.zip")
    #expect(plan.first == git && plan.retry == zip)
    plan = PluginInstallSource.installPlan(source: git, replace: false, fallbackFileName: "p.zip")
    #expect(plan.first == git && plan.retry == nil)
    // Unsendable or missing source: the zip on replace, nothing otherwise; no retry.
    plan = PluginInstallSource.installPlan(source: badGit, replace: true, fallbackFileName: "p.zip")
    #expect(plan.first == zip && plan.retry == nil)
    plan = PluginInstallSource.installPlan(source: nil, replace: true, fallbackFileName: "p.zip")
    #expect(plan.first == zip && plan.retry == nil)
    plan = PluginInstallSource.installPlan(source: badGit, replace: false, fallbackFileName: "p.zip")
    #expect(plan.first == nil && plan.retry == nil)
    // A fallback name the server would refuse is never planned.
    plan = PluginInstallSource.installPlan(source: nil, replace: true, fallbackFileName: "a/b.zip")
    #expect(plan.first == nil)
}

private func decodedPlugin(_ name: String, extra: String = "") throws -> PluginInfo {
    let json = #"{"name":"\#(name)","version":"1.0.0","displayName":"X","description":"","author":"","enabled":true,"skillCount":0,"commands":[]\#(extra)}"#
    return try JSONDecoder().decode(PluginInfo.self, from: Data(json.utf8))
}

@Test func mergeDropsRowsThatCanOnlyFail() throws {
    let zipped = try decodedPlugin("claude-z", extra: #","installSource":{"kind":"zip","fileName":"z.zip"}"#)
    let imported = try decodedPlugin("claude-i", extra: #","origin":"claude""#)
    let git = try decodedPlugin("g", extra: #","installSource":{"kind":"git","url":"https://h/r","commit":"\#(routeSha)"}"#)
    let plugins = Dictionary(uniqueKeysWithValues: [zipped, imported, git].map { ($0.name, $0) })
    func row(_ name: String) -> PluginUpdateEntry {
        PluginUpdateEntry(name: name, pluginId: "p", importedVersion: nil, claudeVersion: "2",
                          latest: nil, tier: "reimport", source: nil)
    }
    let merged = PluginUpdateSources.merge(
        vendor: [row("claude-z"), row("claude-i"), row("g"), row("unlisted")],
        source: [row("g"), row("gone")], plugins: plugins, oneClick: true)
    #expect(merged.map(\.name) == ["claude-i", "unlisted", "g"])
}

@Test func sourceCheckDueForUncoveredPlugins() {
    let now = Date()
    let recent = now.addingTimeInterval(-60)
    #expect(!PluginUpdateSources.isDue(tracked: [], checked: [], lastCheck: nil, now: now, ttl: 1800, force: true))
    #expect(PluginUpdateSources.isDue(tracked: ["a"], checked: [], lastCheck: nil, now: now, ttl: 1800, force: false))
    #expect(!PluginUpdateSources.isDue(tracked: ["a"], checked: ["a"], lastCheck: recent, now: now, ttl: 1800, force: false))
    #expect(PluginUpdateSources.isDue(tracked: ["a", "b"], checked: ["a"], lastCheck: recent, now: now, ttl: 1800, force: false))
    #expect(PluginUpdateSources.isDue(tracked: ["a"], checked: ["a"], lastCheck: recent, now: now, ttl: 1800, force: true))
    #expect(PluginUpdateSources.isDue(tracked: ["a"], checked: ["a"], lastCheck: now.addingTimeInterval(-1801),
                                      now: now, ttl: 1800, force: false))
}
