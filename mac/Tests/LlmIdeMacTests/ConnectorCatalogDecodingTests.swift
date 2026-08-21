// Decode-shape guard for the /auth/me/connectors family: catches
// server/client field-name drift before it ships.
import XCTest
@testable import LlmIdeMacLib

final class ConnectorCatalogDecodingTests: XCTestCase {
    func testCatalogEntryDecodesWithSelectedFlag() throws {
        let json = """
        {"id":"miro","name":"Miro","description":"Fetch boards.",
         "icon":"square.grid.3x3","authKind":"miro-oauth",
         "docsUrl":"https://developers.miro.com/docs","pipelineReady":false,
         "selected":true}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ConnectorCatalogEntry.self, from: json)
        XCTAssertEqual(entry.id, "miro")
        XCTAssertEqual(entry.authKind, "miro-oauth")
        XCTAssertFalse(entry.pipelineReady)
        XCTAssertTrue(entry.selected)
    }

    func testSelectedListEntryToleratesMissingSelectedFlag() throws {
        // GET /auth/me/connectors omits `selected` (implied true) — decode
        // must not fail on the leaner shape.
        let json = """
        {"id":"box","name":"Box","description":"Index.",
         "icon":"externaldrive.fill","authKind":"box-ccg",
         "docsUrl":"https://developer.box.com/","pipelineReady":true}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ConnectorCatalogEntry.self, from: json)
        XCTAssertEqual(entry.id, "box")
        XCTAssertEqual(entry.selected, false) // lenient default
    }

    func testDecodesSelectedListResponseWrapper() throws {
        let json = """
        {"connectors":[{"id":"box","name":"Box","description":"Index.",
         "icon":"externaldrive.fill","authKind":"box-ccg",
         "docsUrl":"https://developer.box.com/","pipelineReady":true},
        {"id":"slack","name":"Slack","description":"Fetch channel history.",
         "icon":"message.fill","authKind":"slack-oauth",
         "docsUrl":"https://api.slack.com/authentication","pipelineReady":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let connectors: [ConnectorCatalogEntry] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.connectors.map(\.id), ["box", "slack"])
    }

    func testDecodesCatalogResponseWrapper() throws {
        let json = """
        {"catalog":[{"id":"gdrive","name":"Google Drive","description":"Fetch files.",
         "icon":"externaldrive.fill.badge.icloud","authKind":"google-oauth",
         "docsUrl":"https://developers.google.com/drive","pipelineReady":false,"selected":false}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let catalog: [ConnectorCatalogEntry] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.catalog.count, 1)
        XCTAssertEqual(decoded.catalog[0].icon, "externaldrive.fill.badge.icloud")
        XCTAssertFalse(decoded.catalog[0].selected)
    }
}
