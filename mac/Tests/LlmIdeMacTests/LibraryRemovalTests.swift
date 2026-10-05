import Testing
import Foundation
@testable import LlmIdeMacLib

/// Destructive Library actions are confirmed first, and the confirmation says
/// what really happens — the plugin's trust goes with it, the MCP registry is
/// shared by every user, a connector only loses its card.
@Suite("Library removal confirmations")
struct LibraryRemovalTests {
    @Test("each kind names the thing and says what it deletes")
    func wording() {
        let plugin = LibraryRemoval.plugin(name: "claude-security", title: "Claude Security")
        #expect(plugin.dialogTitle == "Uninstall “Claude Security”?")
        #expect(plugin.confirmLabel == "Uninstall")
        #expect(plugin.message.contains("trust"), "reinstalling asks for trust again")

        let mcp = LibraryRemoval.mcpServer(id: "slack", name: "Slack")
        #expect(mcp.dialogTitle == "Remove “Slack”?")
        #expect(mcp.message.contains("every user"), "the registry is one shared file")

        let connector = LibraryRemoval.connector(id: "miro", name: "Miro")
        #expect(connector.confirmLabel == "Remove")
        #expect(connector.message.contains("kept"), "a connector removal keeps what it produced")
        #expect(!connector.message.contains("every user"))
    }

    @Test("the same id in different kinds does not collide")
    func identity() {
        #expect(LibraryRemoval.mcpServer(id: "x", name: "X").id != LibraryRemoval.connector(id: "x", name: "X").id)
        #expect(LibraryRemoval.plugin(name: "x", title: "X").id != LibraryRemoval.mcpServer(id: "x", name: "X").id)
        #expect(LibraryRemoval.mcpServer(id: "x", name: "X") == LibraryRemoval.mcpServer(id: "x", name: "X"))
    }
}

@Suite("Plugin trust confirmation")
struct PluginTrustConfirmationTests {
    private func plugin() throws -> PluginInfo {
        let json = """
        {"name":"p","version":"1.0.0","displayName":"Pretty Name","description":"d","author":"a",
         "enabled":true,"skillCount":0,"commands":[],"subagents":[],"format":"claude",
         "hookCount":1,"declaresHooks":true,"executableKinds":["hooks","monitors"],
         "hooksTrusted":false,"nativeDelivery":false,"sdkReadable":true,"nativePluginsOn":true}
        """
        return try JSONDecoder().decode(PluginInfo.self, from: Data(json.utf8))
    }

    @Test("the dialog promises exactly what the toggle's explanation says")
    func sameWordsAsTheToggle() throws {
        let info = try plugin()
        #expect(PluginTrustConfirmation.message(info) == PluginTrustPresentation.trustExplanation(info))
        #expect(PluginTrustConfirmation.title(info) == "Trust “\(info.title)”?")
        #expect(PluginTrustConfirmation.message(info).contains("outside the sandbox"),
                "a plugin with monitors must show the sandbox warning in the dialog too")
        #expect(PluginTrustConfirmation.confirmLabel == "Trust")
    }
}
