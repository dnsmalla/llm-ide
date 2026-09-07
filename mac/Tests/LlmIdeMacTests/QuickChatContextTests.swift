import XCTest
@testable import LlmIdeMacLib

final class QuickChatContextTests: XCTestCase {
    func testNoProjectMessageNamesTheReason() {
        // The phone shows this verbatim, so it must explain WHY rather than
        // just refuse.
        XCTAssertTrue(QuickChatContext.noProjectMessage.contains("Open a project"))
        XCTAssertTrue(QuickChatContext.noProjectMessage.contains("memory"))
    }

    /// The spec's one safety-critical assertion (§Testing): an `ask` request
    /// must not silently become `execute` on a server that doesn't know the
    /// mode. `serverSupportsAsk` IS that gate, and an unknown version has to
    /// fail CLOSED — treating nil as supported would let a turn race the
    /// first health probe onto an older server.
    func testServerSupportsAskFailsClosedBelowV47() {
        XCTAssertFalse(QuickChatContext.serverSupportsAsk(nil))
        XCTAssertFalse(QuickChatContext.serverSupportsAsk(46))
        XCTAssertTrue(QuickChatContext.serverSupportsAsk(47))
        XCTAssertTrue(QuickChatContext.serverSupportsAsk(48))
    }

    /// The picker's label and the model actually sent read the same value
    /// (`ChatEngine.quickChatModelId`), so this resolution order is what
    /// makes the popover's label honest: explicit pick, else the config
    /// default, else "Auto".
    func testModelLabelResolutionOrder() {
        let models = [AIModel(id: "sonnet", displayName: "Sonnet"),
                      AIModel(id: "opus", displayName: "Opus")]
        XCTAssertEqual(QuickChatContext.modelLabel(modelId: "opus", defaultModelId: "sonnet", models: models),
                       "Opus")
        XCTAssertEqual(QuickChatContext.modelLabel(modelId: nil, defaultModelId: "sonnet", models: models),
                       "Sonnet")
        XCTAssertEqual(QuickChatContext.modelLabel(modelId: nil, defaultModelId: "", models: models),
                       "Auto")
        // A model the picker no longer offers must not render as a raw id.
        XCTAssertEqual(QuickChatContext.modelLabel(modelId: "retired", defaultModelId: "sonnet", models: models),
                       "Auto")
    }
}
