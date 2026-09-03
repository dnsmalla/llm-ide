import XCTest
@testable import LlmIdeMacLib

final class MonacoEditorMessageHandlerTests: XCTestCase {
    func testContentChangedProducesUpdateContentEffect() {
        let effect = MonacoEditorMessageHandler.effect(for: .contentChanged(text: "let a = 1"))
        XCTAssertEqual(effect, .updateContent("let a = 1"))
    }

    func testRequestSaveProducesRequestSaveEffect() {
        let effect = MonacoEditorMessageHandler.effect(for: .requestSave)
        XCTAssertEqual(effect, .requestSave)
    }

    func testReadyProducesNoEffect() {
        // .ready is handled by MonacoHost's own onReady callback, not this handler.
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .ready), .none)
    }

    func testUnhandledMessagesProduceNoEffect() {
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .cursorMoved(line: 3, column: 7)), .none)
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .gutterAction(line: 1, action: .stage)), .none)
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .diffHunkAction(hunkId: "h1", action: .stage)), .none)
    }
}
