import Foundation
import Testing
@testable import LlmIdeMacLib

/// The `.plan` tool-result payload behind the chat's PlanSavedCard: the plan
/// body and title ride on the payload for DISPLAY only — the server must keep
/// seeing exactly the one-line ack it always saw, or the agent's history
/// would suddenly carry a full copy of every saved plan on every turn.
struct PlanSavedPayloadTests {

    private func planPayload() -> ChatMessage.ToolResultPayload {
        ChatMessage.ToolResultPayload(
            kind: .plan,
            summary: "(saved plan to llm-doc/plans/2026-08-18-dark-mode.md)",
            exitCode: nil, command: nil, output: nil,
            url: "/Users/x/proj/llm-doc/plans/2026-08-18-dark-mode.md",
            isFailure: false,
            planTitle: "Dark mode support",
            planContent: "# Plan\n\n1. Add theme tokens\n2. Wire the toggle\n")
    }

    @Test func planPayloadRoundTripsThroughCodable() throws {
        let original = planPayload()
        let data = try AppJSON.encoder.encode(original)
        let decoded = try AppJSON.decoder.decode(ChatMessage.ToolResultPayload.self, from: data)
        #expect(decoded == original)
        #expect(decoded.planTitle == "Dark mode support")
        #expect(decoded.planContent?.contains("theme tokens") == true)
    }

    @Test func legacyContentStaysSummaryOnly() {
        // The wire form (what the agent sees of its own save) must remain the
        // single ack line — planContent is display-only and must never leak
        // into the reconstructed legacy text.
        let payload = planPayload()
        #expect(payload.legacyContent() == "(saved plan to llm-doc/plans/2026-08-18-dark-mode.md)")
    }

    @Test func wireTurnOfPlanResultIsSummaryOnly() {
        let msg = ChatMessage(role: .toolResult,
                              content: "(saved plan to llm-doc/plans/2026-08-18-dark-mode.md)",
                              status: .done, createdAt: Date(),
                              toolResult: planPayload())
        let wire = msg.wireTurn()
        #expect(wire.role == .user)
        #expect(wire.content == "(saved plan to llm-doc/plans/2026-08-18-dark-mode.md)")
    }

    @Test func payloadWithoutPlanFieldsStillDecodes() throws {
        // Backward compatibility: every payload persisted before the fields
        // existed decodes with them nil.
        let legacyJSON = """
        {"kind":"edit","summary":"(applied update to a.swift: +1 lines)","isFailure":false}
        """.data(using: .utf8)!
        let decoded = try AppJSON.decoder.decode(ChatMessage.ToolResultPayload.self, from: legacyJSON)
        #expect(decoded.kind == .edit)
        #expect(decoded.planTitle == nil)
        #expect(decoded.planContent == nil)
    }
}
