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

    /// The label and the send MUST resolve identically — a label reading
    /// "Auto" while the turn carries a retired id is the exact divergence
    /// this shared function exists to prevent.
    func testEffectiveModelIdDropsIdsTheProviderNoLongerOffers() {
        let models = [AIModel(id: "sonnet", displayName: "Sonnet")]
        XCTAssertEqual(QuickChatContext.effectiveModelId(explicit: "sonnet",
                                                         defaultModelId: "", models: models), "sonnet")
        // Switching provider resets defaultModelId but leaves an explicit
        // pick naming the OLD provider's model: send Auto, not the retired id.
        XCTAssertNil(QuickChatContext.effectiveModelId(explicit: "gpt-retired",
                                                       defaultModelId: "", models: models))
        XCTAssertEqual(QuickChatContext.effectiveModelId(explicit: nil,
                                                         defaultModelId: "sonnet", models: models), "sonnet")
        XCTAssertNil(QuickChatContext.effectiveModelId(explicit: nil,
                                                       defaultModelId: "also-retired", models: models))
        XCTAssertNil(QuickChatContext.effectiveModelId(explicit: "sonnet",
                                                       defaultModelId: "sonnet", models: []))
    }

    /// A refused send must tell the user which refusal it was: an older
    /// server takes the composer away, an unreachable one leaves it in place,
    /// so the two cannot share one message.
    func testSendGateMessages() {
        XCTAssertNil(QuickChatContext.SendGate.allowed.message)
        XCTAssertEqual(QuickChatContext.SendGate.serverTooOld(46).message,
                       QuickChatContext.unsupportedServerMessage(apiVersion: 46))
        let unreachable = QuickChatContext.SendGate.unreachable.message
        XCTAssertNotNil(unreachable)
        XCTAssertTrue(unreachable?.contains("wasn't sent") == true)
    }
}
