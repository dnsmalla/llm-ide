import XCTest
@testable import LlmIdeMacLib

/// Bounded tool-call args on transcript steps.
final class ChatStoredArgsTests: XCTestCase {
    // MARK: - Stored args

    func testSmallArgsAreStoredVerbatim() {
        let raw = #"{"file_path":"/a/b.swift","content":"short"}"#
        XCTAssertEqual(AgentV2Transport.boundedStoredArgs(raw), raw)
        XCTAssertNil(AgentV2Transport.boundedStoredArgs(nil))
    }

    func testLargeValueIsCutButKeysAndPathSurvive() throws {
        let body = String(repeating: "x", count: 50_000)
        let raw = #"{"file_path":"/a/b.swift","content":""# + body + #""}"#
        let bounded = try XCTUnwrap(AgentV2Transport.boundedStoredArgs(raw))
        XCTAssertLessThan(bounded.count, 3_000)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(bounded.utf8)) as? [String: Any])
        XCTAssertEqual(object["file_path"] as? String, "/a/b.swift")
        XCTAssertTrue((object["content"] as? String)?.contains("[truncated 48000 chars]") == true)
    }

    func testUnparseableHugeArgsAreCappedWhole() throws {
        let raw = String(repeating: "y", count: 40_000)
        let bounded = try XCTUnwrap(AgentV2Transport.boundedStoredArgs(raw))
        XCTAssertLessThan(bounded.count, AgentV2Transport.storedArgsTotalLimit + 100)
    }
}
