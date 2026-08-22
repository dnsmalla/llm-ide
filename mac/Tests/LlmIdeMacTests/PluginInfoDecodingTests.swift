// Decode-shape guard: PluginInfo reads the /auth/me/plugins payload leniently,
// so a server predating the vendor-format fields still decodes (house pattern
// — see the `subagents` field).
import XCTest
@testable import LlmIdeMacLib

final class PluginInfoDecodingTests: XCTestCase {
    func testVendorFieldsDecode() throws {
        let json = """
        {"name":"example","version":"1.0.0","displayName":"Example","description":"d",
         "author":"a","enabled":false,"skillCount":1,"commands":[],"subagents":[],
         "format":"claude","unsupportedComponents":["themes",".lsp.json"],
         "pendingComponents":["hooks"]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PluginInfo.self, from: json)
        XCTAssertEqual(info.format, "claude")
        XCTAssertEqual(info.unsupportedComponents, ["themes", ".lsp.json"])
        XCTAssertEqual(info.pendingComponents, ["hooks"])
    }

    func testOlderServerPayloadStillDecodesWithDefaults() throws {
        let json = """
        {"name":"example","version":"1.0.0","displayName":"Example","description":"d",
         "author":"a","enabled":false,"skillCount":1,"commands":[],"subagents":[]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PluginInfo.self, from: json)
        XCTAssertEqual(info.format, "llmide")
        XCTAssertEqual(info.unsupportedComponents, [])
        XCTAssertEqual(info.pendingComponents, [])
    }
}

/// Hook fields on the plugins payload. A plugin's hooks run shell commands, so
/// the client must read the count (is there anything to trust?) and the trust
/// flag (has this user granted it?) — and default both to "nothing, untrusted"
/// when talking to a server that predates them.
extension PluginInfoDecodingTests {
    func testHookFieldsDecode() throws {
        let json = """
        {"name":"hooked","version":"1.0.0","displayName":"Hooked","description":"d",
         "author":"a","enabled":true,"skillCount":0,"commands":[],"subagents":[],
         "format":"claude","pendingComponents":["hooks"],
         "hookCount":3,"hookNotes":["PreToolUse: 'http' handlers are shown but not run"],
         "hooksTrusted":true,"mcpServerCount":2}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PluginInfo.self, from: json)
        XCTAssertEqual(info.hookCount, 3)
        XCTAssertEqual(info.hooksTrusted, true)
        XCTAssertEqual(info.hookNotes.count, 1)
        XCTAssertEqual(info.mcpServerCount, 2)
    }

    func testHookFieldsDefaultToUntrusted() throws {
        let json = """
        {"name":"plain","version":"1.0.0","displayName":"Plain","description":"d",
         "author":"a","enabled":true,"skillCount":1,"commands":[],"subagents":[]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PluginInfo.self, from: json)
        XCTAssertEqual(info.hookCount, 0)
        XCTAssertEqual(info.hooksTrusted, false)
        XCTAssertEqual(info.hookNotes, [])
        XCTAssertEqual(info.mcpServerCount, 0)
    }
}
