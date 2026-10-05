import Testing
import Foundation
@testable import LlmIdeMacLib

/// The plugin detail view must say only what the server will really do: the
/// Agent engine runs monitors / LSP / bin/ / JS modules, but only for a
/// `.claude-plugin` package with native loading on — otherwise nothing does.
@Suite("Plugin trust presentation")
struct PluginTrustPresentationTests {
    private func plugin(kinds: [String] = [], hookCount: Int = 0, declares: Bool? = nil,
                        trusted: Bool = false, native: Bool = false, enabled: Bool = true,
                        sdkReadable: Bool? = true, nativeOn: Bool? = true,
                        commands: String = "[]", pending: String = "[]") throws -> PluginInfo {
        func flag(_ value: Bool?) -> String { value.map { "\($0)" } ?? "null" }
        let kindsJSON = "[" + kinds.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        let json = """
        {"name":"p","version":"1.0.0","displayName":"P","description":"d","author":"a",
         "enabled":\(enabled),"skillCount":0,"commands":\(commands),"subagents":[],"format":"claude",
         "pendingComponents":\(pending),
         "hookCount":\(hookCount),"declaresHooks":\(declares ?? !kinds.isEmpty),
         "executableKinds":\(kindsJSON),"hooksTrusted":\(trusted),"nativeDelivery":\(native),
         "sdkReadable":\(flag(sdkReadable)),"nativePluginsOn":\(flag(nativeOn))}
        """
        return try JSONDecoder().decode(PluginInfo.self, from: Data(json.utf8))
    }

    @Test("a monitors row says the engine runs it only when the engine can load the plugin")
    func componentStatus() throws {
        #expect(PluginTrustPresentation.componentStatus("monitors", try plugin(kinds: ["monitors"])) == .agentEngine)
        // Pref off: it would run, but is switched off.
        #expect(PluginTrustPresentation.componentStatus("monitors", try plugin(kinds: ["monitors"], nativeOn: false)) == .nativeOff)
        // A Codex layout never reaches the SDK: ignored, whatever the pref.
        #expect(PluginTrustPresentation.componentStatus("monitors", try plugin(kinds: ["monitors"], sdkReadable: false)) == .ignored)
        // A component the package does not declare as executable stays ignored.
        #expect(PluginTrustPresentation.componentStatus("themes", try plugin(kinds: ["monitors"])) == .ignored)
        #expect(PluginTrustPresentation.componentStatus(".lsp.json", try plugin(kinds: ["lsp"])) == .agentEngine)
        #expect(PluginTrustPresentation.componentStatus("bin", try plugin(kinds: ["bin"])) == .agentEngine)
    }

    @Test("with native loading off and no command hooks, the text says nothing runs")
    func explanationWhenNothingRuns() throws {
        let off = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["monitors"], nativeOn: false))
        #expect(off.hasPrefix("Nothing from this plugin runs right now"))
        #expect(off.contains("Settings → Preferences"))
        let codex = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["hooks"], declares: true, sdkReadable: false))
        #expect(codex.hasPrefix("Nothing from this plugin runs right now"))
        #expect(!codex.contains("agent engine run"))
        // Even after trusting: still no promise.
        let trusted = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["monitors"], trusted: true, nativeOn: false))
        #expect(trusted.hasPrefix("Nothing from this plugin runs right now"))
    }

    @Test("command hooks still run through LLM-IDE when the engine cannot load the plugin")
    func translatedHooks() throws {
        let text = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["hooks"], hookCount: 2, trusted: true, nativeOn: false))
        #expect(text.hasPrefix("LLM-IDE runs this plugin's command hooks"))
    }

    @Test("the engine path names what runs, and warns about the sandbox only for monitors")
    func nativeText() throws {
        let untrustedMon = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["monitors"]))
        #expect(untrustedMon.contains("background monitors") && untrustedMon.contains("outside the sandbox"))
        let untrustedLsp = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["lsp"]))
        #expect(untrustedLsp.contains("language servers") && !untrustedLsp.contains("sandbox"))
        let trusted = PluginTrustPresentation.trustExplanation(try plugin(kinds: ["hooks", "bin"], hookCount: 1, trusted: true, native: true))
        #expect(trusted.contains("bin/ commands"))
    }

    @Test("label and heading follow the kinds")
    func labels() throws {
        #expect(PluginTrustPresentation.trustLabel(try plugin(kinds: ["hooks"], hookCount: 1)) == "Trust hooks (1 handler)")
        #expect(PluginTrustPresentation.trustLabel(try plugin(kinds: ["hooks"], hookCount: 0)) == "Trust hooks")
        #expect(PluginTrustPresentation.trustLabel(try plugin(kinds: ["monitors", "lsp"])) == "Trust background monitors, language servers")
        #expect(PluginTrustPresentation.hooksHeading(try plugin(kinds: ["hooks"])) == "Hooks")
        #expect(PluginTrustPresentation.hooksHeading(try plugin(kinds: ["monitors"])) == "Hooks & scripts")
    }

    @Test("a trusted but DISABLED plugin is not described by a delivery route it is not on")
    func disabledTrusted() throws {
        // nativeDelivery is false for every disabled plugin, so it cannot pick the route.
        let engine = PluginTrustPresentation.trustExplanation(
            try plugin(kinds: ["hooks", "monitors"], hookCount: 1, trusted: true, enabled: false))
        #expect(engine.hasPrefix("Trusted. Once you enable the plugin, the agent engine runs"))
        #expect(!engine.contains("LLM-IDE runs"))
        let translated = PluginTrustPresentation.trustExplanation(
            try plugin(kinds: ["hooks"], hookCount: 1, trusted: true, enabled: false, nativeOn: false))
        #expect(translated.hasPrefix("Trusted. Once you enable the plugin, LLM-IDE runs its command hooks"))
        let noHooks = PluginTrustPresentation.trustExplanation(
            try plugin(kinds: ["hooks"], hookCount: 0, trusted: true, enabled: false, sdkReadable: true))
        #expect(noHooks.contains("agent engine runs"))
    }

    @Test("a component row stops saying 'once you trust' after the grant, and while disabled")
    func rowText() throws {
        #expect(PluginTrustPresentation.agentEngineRowText("monitors", try plugin(kinds: ["monitors"]))
            .contains("once you trust this plugin"))
        #expect(PluginTrustPresentation.agentEngineRowText("monitors", try plugin(kinds: ["monitors"], trusted: true))
            == "monitors — run by the agent engine (trusted)")
        #expect(PluginTrustPresentation.agentEngineRowText("monitors", try plugin(kinds: ["monitors"], trusted: true, enabled: false))
            .contains("once you enable this plugin"))
    }

    @Test("an older server (no delivery facts) is treated as loadable, like before")
    func olderServer() throws {
        let info = try plugin(kinds: ["monitors"], sdkReadable: nil, nativeOn: nil)
        #expect(info.agentEngineCanLoad)
        #expect(PluginTrustPresentation.componentStatus("monitors", info) == .agentEngine)
    }

    @Test("PluginInfo equality sees every field the detail view renders")
    func equality() throws {
        let base = try plugin(kinds: ["hooks"], hookCount: 1)
        #expect(base == (try plugin(kinds: ["hooks"], hookCount: 1)))
        #expect(base != (try plugin(kinds: ["hooks"], hookCount: 2)), "a reinstall with more handlers must refresh")
        #expect(base != (try plugin(kinds: ["hooks", "monitors"], hookCount: 1)))
        #expect(base != (try plugin(kinds: ["hooks"], hookCount: 1, nativeOn: false)))
        // What the rest of the detail view renders.
        #expect(base != (try plugin(kinds: ["hooks"], hookCount: 1, pending: "[\"mcp\"]")), "a reinstall that adds .mcp.json")
        #expect(base != (try plugin(kinds: ["hooks"], hookCount: 1,
                                    commands: "[{\"trigger\":\"go\",\"description\":\"d\"}]")), "a new slash command")
    }
}

/// `effective` is what the server says a turn would mount; the client falls back
/// to enabled && consented only when an older server omits it.
@Suite("MCP effective flag")
struct McpEffectiveTests {
    private func server(effective: String, enabled: Bool = true, consented: Bool = true) throws -> LlmIdeAPIClient.McpPluginInfo {
        let json = """
        {"id":"s","name":"S","transport":"stdio","command":"npx","args":[],"source":"manual",
         "builtin":false,"enabled":\(enabled),"consented":\(consented),"credentialMissing":false\(effective)}
        """
        return try JSONDecoder().decode(LlmIdeAPIClient.McpPluginInfo.self, from: Data(json.utf8))
    }

    @Test("server-computed effective wins; absent falls back to enabled && consented")
    func fallback() throws {
        #expect(try server(effective: ",\"effective\":true").isEffective)
        #expect(!(try server(effective: ",\"effective\":false").isEffective), "plugin switched off")
        #expect(try server(effective: "").isEffective, "older server: enabled && consented")
        #expect(!(try server(effective: "", consented: false).isEffective))
    }

    @Test("status says inactive for an enabled, consented server the engine would not mount")
    func status() throws {
        #expect(try server(effective: ",\"effective\":false").statusSummary == "inactive")
        #expect(try server(effective: ",\"effective\":true").statusSummary == "enabled")
        #expect(try server(effective: "", enabled: false).statusSummary == "disabled")
    }
}
