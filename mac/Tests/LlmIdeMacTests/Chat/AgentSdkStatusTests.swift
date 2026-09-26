import Testing
import Foundation
@testable import LlmIdeMacLib

/// Wire shape of GET /kb/agent-sdk and POST /kb/agent-sdk/update (server API
/// v57, extension/llm_agent/sdk/updater.mjs) as the Settings card decodes it.
@Suite("Agent SDK status wire")
struct AgentSdkStatusTests {
    @Test("status decodes, extra server fields ignored")
    func status() throws {
        let json = #"{"package":"@anthropic-ai/claude-agent-sdk","running":"0.3.272","installed":"0.3.283","declared":"0.3.283","restartNeeded":true,"latest":"0.3.283","updateAvailable":false,"updating":false,"canUpdate":true,"error":null}"#
        let s = try JSONDecoder().decode(AgentSdkStatus.self, from: Data(json.utf8))
        #expect(s.running == "0.3.272")
        #expect(s.installed == "0.3.283")
        #expect(s.restartNeeded)
        #expect(!s.updateAvailable)
        #expect(s.error == nil)
    }

    @Test("an update result decodes, including a rollback")
    func updateResult() throws {
        let json = #"{"ok":false,"from":"0.3.272","to":"0.3.272","rolledBack":true,"restartNeeded":false,"log":"the new SDK failed to load. Restored 0.3.272."}"#
        let r = try JSONDecoder().decode(AgentSdkUpdateResult.self, from: Data(json.utf8))
        #expect(!r.ok && r.rolledBack)
        #expect(r.from == "0.3.272")
    }
}
