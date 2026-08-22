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
