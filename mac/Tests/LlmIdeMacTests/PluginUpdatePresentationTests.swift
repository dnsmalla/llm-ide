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
    #expect(outcome(200, #"{"ok":true,"from":"1.0.0","to":"1.1.0","trustReset":true}"#)
            == .updated(from: "1.0.0", to: "1.1.0", trustReset: true))
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
        name: "claude-a", outcome: .updated(from: "1.0.0", to: "1.1.0", trustReset: true)))
    #expect(updated.contains("Hooks/MCP of claude-a changed — review and re-approve them."))
    #expect(updated.contains("Restart Claude Code to use the new version there."))

    let latest = try #require(PluginUpdatePresentation.message(
        name: "claude-a", outcome: .updated(from: "1.1.0", to: "1.1.0", trustReset: false)))
    #expect(latest.contains("already the latest"))

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
