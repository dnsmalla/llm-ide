// Decode-shape guard for the two vendor endpoints that shipped with no client
// at all: /auth/me/{claude,codex}-plugins/updates. An update entry is what the
// Plugins header badge counts and what one-click re-import acts on.
import XCTest
@testable import LlmIdeMacLib

final class PluginUpdateDTOTests: XCTestCase {
    func testDecodesUpdatesResponse() throws {
        let json = """
        {"updates":[{"name":"claude-code-review","importedVersion":"1.0.0",
                     "sourceVersion":"1.4.0","source":"marketplace"}]}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(PluginUpdatesResponse.self, from: json)
        XCTAssertEqual(decoded.updates.count, 1)
        let u = decoded.updates[0]
        XCTAssertEqual(u.name, "claude-code-review")
        XCTAssertEqual(u.importedVersion, "1.0.0")
        XCTAssertEqual(u.sourceVersion, "1.4.0")
        XCTAssertEqual(u.source, "marketplace")
        // The source plugin name is what re-import must ask for — the stored
        // plugin carries the vendor namespace prefix, the source does not.
        XCTAssertEqual(u.sourcePluginName, "code-review")
    }

    func testDecodesEmptyUpdates() throws {
        let json = "{\"updates\":[]}".data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode(PluginUpdatesResponse.self, from: json).updates, [])
    }

    func testCodexPrefixIsStrippedToo() throws {
        let json = """
        {"updates":[{"name":"codex-documents","importedVersion":"1.0.0",
                     "sourceVersion":"2.0.0","source":"installed"}]}
        """.data(using: .utf8)!
        let u = try JSONDecoder().decode(PluginUpdatesResponse.self, from: json).updates[0]
        XCTAssertEqual(u.sourcePluginName, "documents")
    }

    func testRefreshResponseDecodes() throws {
        let json = "{\"installed\":3,\"marketplace\":12}".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(PluginRefreshResponse.self, from: json)
        XCTAssertEqual(decoded.installed, 3)
        XCTAssertEqual(decoded.marketplace, 12)
    }
}
