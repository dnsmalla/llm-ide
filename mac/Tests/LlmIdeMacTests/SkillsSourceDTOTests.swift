// Decode-shape guard: catches server/client field-name drift before it ships
// (the isAuthRoute allowlist miss during the server plan was exactly this
// class of bug, one layer further down the stack).
import XCTest
@testable import LlmIdeMacLib

final class SkillsSourceDTOTests: XCTestCase {
    func testDecodesListResponse() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin",
        "location":"/repo/.skills","builtin":true,"version":"3.0.0",
        "installed":true,"skillCount":57,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.SkillsSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources.count, 1)
        XCTAssertEqual(decoded.sources[0].id, "builtin")
        XCTAssertNil(decoded.sources[0].ref)
    }

    func testDecodesAddResponseWithoutListOnlyFields() throws {
        let json = """
        {"source":{"id":"other","name":"other","origin":"local",
        "location":"/tmp/other-repo","builtin":false,"version":"3.0.0"}}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let source: LlmIdeAPIClient.SkillsSourceSummary }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.source.id, "other")
        XCTAssertEqual(decoded.source.origin, "local")
    }
}
