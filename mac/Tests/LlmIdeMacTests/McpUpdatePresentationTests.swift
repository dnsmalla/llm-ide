import Foundation
import Testing
@testable import LlmIdeMacLib

@Suite("MCP update presentation")
struct McpUpdatePresentationTests {
    @Test("source labels cover every origin, including catalog and codex")
    func sourceLabels() {
        #expect(McpUpdatePresentation.sourceLabel(source: "catalog") == "Catalog")
        #expect(McpUpdatePresentation.sourceLabel(source: "claude") == "Imported from Claude Code")
        #expect(McpUpdatePresentation.sourceLabel(source: "codex") == "Imported from Codex")
        #expect(McpUpdatePresentation.sourceLabel(source: "plugin") == "From plugin")
        #expect(McpUpdatePresentation.sourceLabel(source: "manual") == "Manually registered")
        #expect(McpUpdatePresentation.sourceLabel(source: "other") == "Manually registered")
    }

    @Test("source badge names plugin-declared servers instead of calling them manual")
    func sourceBadges() {
        for source in ["catalog", "claude", "codex", "plugin"] {
            #expect(McpUpdatePresentation.sourceBadge(source: source) == source)
        }
        #expect(McpUpdatePresentation.sourceBadge(source: "manual") == "manual")
        #expect(McpUpdatePresentation.sourceBadge(source: "other") == "manual")
    }

    @Test("checked text states the server time, or says cached when there is none")
    func checkedText() {
        #expect(McpUpdatePresentation.checkedText(checkedAt: nil, upToDate: true) == "Checked (cached) — up to date.")
        #expect(McpUpdatePresentation.checkedText(checkedAt: "garbage", upToDate: false) == "Checked (cached).")
        let text = McpUpdatePresentation.checkedText(checkedAt: "2026-10-06T05:07:09.123Z", upToDate: true)
        #expect(text.hasPrefix("Checked at "))
        #expect(text.hasSuffix(" — up to date."))
    }

    @Test("version text: pinned, unpinned, unmanaged")
    func versionText() throws {
        let pinned = try decodePackage(#"{"runner":"npx","name":"x","version":"1.2.3","tag":null}"#)
        let unpinned = try decodePackage(#"{"runner":"npx","name":"x","version":null,"tag":"latest"}"#)
        #expect(McpUpdatePresentation.versionText(package: pinned) == "v1.2.3")
        #expect(McpUpdatePresentation.versionText(package: unpinned) == "unpinned")
        #expect(McpUpdatePresentation.versionText(package: nil) == nil)
    }

    @Test("action titles")
    func actionTitles() {
        #expect(McpUpdatePresentation.actionTitle(status: "update-available", latest: "2.0.0") == "Update to 2.0.0")
        #expect(McpUpdatePresentation.actionTitle(status: "unpinned", latest: "2.0.0") == "Pin to 2.0.0")
        #expect(McpUpdatePresentation.actionTitle(status: "up-to-date", latest: "2.0.0") == nil)
        #expect(McpUpdatePresentation.actionTitle(status: "update-available", latest: nil) == nil)
    }

    @Test("after-change message and API gate")
    func misc() {
        #expect(McpUpdatePresentation.afterChangeMessage == "Consent was reset — approve again to use it.")
        #expect(McpUpdatePresentation.isSupported(serverApiVersion: 62))
        #expect(!McpUpdatePresentation.isSupported(serverApiVersion: 61))
        #expect(!McpUpdatePresentation.isSupported(serverApiVersion: nil))
    }

    @Test("plugin row decodes with and without the v62 fields")
    func pluginDecode() throws {
        let withFields = Data(#"""
        {"id":"a","name":"A","command":"npx","args":["-y","p@1.0.0"],"source":"codex","builtin":false,
         "package":{"runner":"npx","name":"p","version":"1.0.0","tag":null},"catalogId":"c","sourceName":"s"}
        """#.utf8)
        let row = try JSONDecoder().decode(LlmIdeAPIClient.McpPluginInfo.self, from: withFields)
        #expect(row.package?.version == "1.0.0")
        #expect(row.catalogId == "c")
        #expect(row.sourceName == "s")
        let old = Data(#"{"id":"a","name":"A","command":"npx","args":[],"source":"manual","builtin":false}"#.utf8)
        let oldRow = try JSONDecoder().decode(LlmIdeAPIClient.McpPluginInfo.self, from: old)
        #expect(oldRow.package == nil)
        #expect(oldRow.catalogId == nil)
    }

    @Test("update check decodes, reason optional")
    func checkDecode() throws {
        let json = Data(#"""
        {"checkedAt":"2026-10-06T00:00:00Z","servers":[
         {"id":"a","runner":"npx","name":"p","current":"1.0.0","latest":"1.1.0","status":"update-available"},
         {"id":"b","runner":"uvx","name":"q","current":null,"latest":null,"status":"unknown","reason":"offline"}]}
        """#.utf8)
        let check = try JSONDecoder().decode(LlmIdeAPIClient.McpUpdateCheck.self, from: json)
        #expect(check.servers.count == 2)
        #expect(check.servers[0].reason == nil)
        #expect(check.servers[1].reason == "offline")
    }

    private func decodePackage(_ json: String) throws -> LlmIdeAPIClient.McpPackageSpec {
        try JSONDecoder().decode(LlmIdeAPIClient.McpPackageSpec.self, from: Data(json.utf8))
    }
}
