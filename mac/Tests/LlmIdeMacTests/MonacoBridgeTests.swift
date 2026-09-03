import XCTest
@testable import LlmIdeMacLib

final class MonacoBridgeTests: XCTestCase {
    private func decode(_ json: String) throws -> MonacoOutboundMessage {
        try JSONDecoder().decode(MonacoOutboundMessage.self, from: Data(json.utf8))
    }

    func testDecodesReady() throws {
        guard case .ready = try decode(#"{"type":"ready"}"#) else { return XCTFail("expected .ready") }
    }

    func testDecodesContentChanged() throws {
        guard case .contentChanged(let text) = try decode(#"{"type":"contentChanged","text":"let a = 1"}"#) else {
            return XCTFail("expected .contentChanged")
        }
        XCTAssertEqual(text, "let a = 1")
    }

    func testDecodesRequestSave() throws {
        guard case .requestSave = try decode(#"{"type":"requestSave"}"#) else { return XCTFail("expected .requestSave") }
    }

    func testDecodesGutterAction() throws {
        guard case .gutterAction(let line, let action) = try decode(#"{"type":"gutterAction","line":42,"action":"stage"}"#) else {
            return XCTFail("expected .gutterAction")
        }
        XCTAssertEqual(line, 42)
        XCTAssertEqual(action, .stage)
    }

    func testDecodesCursorMoved() throws {
        guard case .cursorMoved(let line, let column) = try decode(#"{"type":"cursorMoved","line":3,"column":7}"#) else {
            return XCTFail("expected .cursorMoved")
        }
        XCTAssertEqual(line, 3)
        XCTAssertEqual(column, 7)
    }

    func testDecodesDiffHunkAction() throws {
        guard case .diffHunkAction(let id, let action) = try decode(#"{"type":"diffHunkAction","hunkId":"h1","action":"unstage"}"#) else {
            return XCTFail("expected .diffHunkAction")
        }
        XCTAssertEqual(id, "h1")
        XCTAssertEqual(action, .unstage)
    }

    func testUnknownTypeThrows() {
        XCTAssertThrowsError(try decode(#"{"type":"bogus"}"#))
    }

    // MARK: - MonacoDecoration.decorations(from:) — the GitGutter.Mark -> wire mapping

    func testDecorationsMapsEachGitGutterMarkToItsWireKind() {
        let marks: [Int: GitGutter.Mark] = [1: .added, 2: .modified, 3: .deleted]
        let decorations = MonacoDecoration.decorations(from: marks).sorted { $0.line < $1.line }
        XCTAssertEqual(decorations, [
            MonacoDecoration(line: 1, kind: "added"),
            MonacoDecoration(line: 2, kind: "modified"),
            MonacoDecoration(line: 3, kind: "deleted"),
        ])
    }
}
