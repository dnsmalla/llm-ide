// Decode-shape guard: catches server/client field-name drift before it ships.
import XCTest
@testable import LlmIdeMacLib

final class McpPluginDTOTests: XCTestCase {
    func testDecodesListResponse() throws {
        let json = """
        {"plugins":[{"id":"slack","name":"Slack","command":"npx","args":["-y","@slack/mcp"],
        "env":{"TOKEN":"t"},"source":"claude","builtin":false,"enabled":true,"consented":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.plugins.count, 1)
        XCTAssertEqual(decoded.plugins[0].id, "slack")
        XCTAssertEqual(decoded.plugins[0].command, "npx")
        XCTAssertEqual(decoded.plugins[0].args, ["-y", "@slack/mcp"])
        XCTAssertEqual(decoded.plugins[0].env?["TOKEN"], "t")
        XCTAssertEqual(decoded.plugins[0].source, "claude")
        XCTAssertEqual(decoded.plugins[0].enabled, true)
        XCTAssertEqual(decoded.plugins[0].consented, true)
    }

    func testDecodesListResponseDefaultsMissingFlagsToFalse() throws {
        let json = """
        {"plugins":[{"id":"linear","name":"Linear","command":"npx","args":[],"source":"manual","builtin":false}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.plugins[0].enabled, false)
        XCTAssertEqual(decoded.plugins[0].consented, false)
        XCTAssertNil(decoded.plugins[0].env)
    }

    func testDecodesAddResponseWithoutPerUserFields() throws {
        let json = """
        {"plugin":{"id":"slack","name":"Slack","command":"npx","args":["-y","@slack/mcp"],"source":"manual","builtin":false}}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugin: LlmIdeAPIClient.McpPluginSummary }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.plugin.id, "slack")
        XCTAssertEqual(decoded.plugin.source, "manual")
    }

    func testDecodesClaudeSourcesScan() throws {
        let json = """
        {"servers":[{"name":"linear","command":"npx","args":["-y","@linear/mcp"],"env":{"TOKEN":"x"}}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let servers: [LlmIdeAPIClient.ClaudeMcpSource] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.servers.count, 1)
        XCTAssertEqual(decoded.servers[0].name, "linear")
        XCTAssertEqual(decoded.servers[0].env?["TOKEN"], "x")
    }
}
