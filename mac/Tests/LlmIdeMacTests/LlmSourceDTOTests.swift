// Decode-shape guard: catches server/client field-name drift before it ships
// (the isAuthRoute allowlist miss during the server plan was exactly this
// class of bug, one layer further down the stack).
import XCTest
@testable import LlmIdeMacLib

final class LlmSourceDTOTests: XCTestCase {
    func testDecodesListResponse() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin",
        "location":"/repo/.skills","builtin":true,"version":"3.0.0",
        "installed":true,"skillCount":57,"agentCount":2,"hookCount":1,"mcpCount":1,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.LlmSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources.count, 1)
        XCTAssertEqual(decoded.sources[0].id, "builtin")
        XCTAssertNil(decoded.sources[0].ref)
        XCTAssertEqual(decoded.sources[0].agentCount, 2)
        XCTAssertEqual(decoded.sources[0].hookCount, 1)
        XCTAssertEqual(decoded.sources[0].mcpCount, 1)
    }

    /// A v27 server (renamed endpoints, pre-MCP) omits agentCount/hookCount/
    /// mcpCount. The list must still decode — defaulting the missing counts to
    /// 0 — instead of throwing keyNotFound and rendering the section empty.
    func testDecodesListResponseMissingNewCountFields() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin",
        "location":"/repo/.skills","builtin":true,"version":"3.0.0",
        "installed":true,"skillCount":57,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.LlmSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources.count, 1)
        XCTAssertEqual(decoded.sources[0].skillCount, 57)
        XCTAssertEqual(decoded.sources[0].agentCount, 0)
        XCTAssertEqual(decoded.sources[0].hookCount, 0)
        XCTAssertEqual(decoded.sources[0].mcpCount, 0)
    }

    func testDecodesAddResponseWithoutListOnlyFields() throws {
        let json = """
        {"source":{"id":"other","name":"other","origin":"local",
        "location":"/tmp/other-repo","builtin":false,"version":"3.0.0"}}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let source: LlmIdeAPIClient.LlmSourceSummary }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.source.id, "other")
        XCTAssertEqual(decoded.source.origin, "local")
    }

    func testDecodesDiscoveryDetail() throws {
        let json = """
        {"agents":[{"name":"reviewer","description":"reviews code","path":"/repo/agents/reviewer.md"}],
        "hooks":[{"event":"PreToolUse","matcher":"Bash","command":"echo hi"}],
        "mcpServers":[{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}]}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LlmIdeAPIClient.LlmSourceDiscoveryDetail.self, from: json)
        XCTAssertEqual(decoded.agents.count, 1)
        XCTAssertEqual(decoded.agents[0].name, "reviewer")
        XCTAssertEqual(decoded.hooks.count, 1)
        XCTAssertEqual(decoded.hooks[0].event, "PreToolUse")
        XCTAssertEqual(decoded.hooks[0].matcher, "Bash")
        XCTAssertEqual(decoded.mcpServers.count, 1)
        XCTAssertEqual(decoded.mcpServers[0].name, "filesystem")
        XCTAssertEqual(decoded.mcpServers[0].command, "npx")
        XCTAssertEqual(decoded.mcpServers[0].args, ["-y", "@modelcontextprotocol/server-filesystem"])
    }
}
