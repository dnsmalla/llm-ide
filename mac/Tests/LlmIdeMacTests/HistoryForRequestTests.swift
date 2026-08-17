import Foundation
import Testing
@testable import LlmIdeMacLib

/// Pins the wire-history packing rules of `ChatEngine.historyForRequest`:
/// per-turn clip at 24k, total budget 400k, newest-first packing,
/// first-user-turn anchor always included. (Written against
/// `CodeAssistantPanel.historyForRequest` in Task 1; retargeted verbatim
/// when Task 7 moved the method — and its two budget constants — into the
/// engine along with the rest of the turn lifecycle. Same assertions.)
///
/// Divergences from the task brief, fixed to match current behavior:
/// - `LlmIdeAPIClient(baseURL:)` takes a `String`, not a `URL`.
/// - The "anchor larger than whole budget is dropped" scenario is
///   UNREACHABLE: per-turn clipping runs before the anchor reservation, so
///   a first user turn is at most `maxHistoryTurnChars + marker` chars and
///   always fits the 400k budget. The oversized-anchor test pins what
///   actually happens (clip, keep, tail kept); the anchor-nil branch is
///   covered separately by the no-user-turn test.
///
/// Task 9 retargeted the INPUT type only: the packer takes `[ChatMessage]`
/// and wire-encodes before budgeting. Same rules, same constants, same
/// assertions — plus one new case pinning that a `.toolResult` message is
/// measured and emitted by its RECONSTRUCTED wire text, which is what
/// actually goes in the POST body.
@MainActor
@Suite("historyForRequest packing")
struct HistoryForRequestTests {
    let engine = ChatEngine(
        scope: .explorer,
        transport: CodeAssistTransport(api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")))

    /// Builds the `ChatMessage` a wire turn of this shape migrates into —
    /// the same transform every real append site uses, so these fixtures
    /// can't drift from production message construction.
    func turn(_ role: LlmIdeAPIClient.CodeAssistRole, _ content: String) -> ChatMessage {
        ChatMessage(wireTurn: .init(role: role, content: content), sessionDate: Date())
    }

    @Test("Under budget: everything passes through, order preserved")
    func underBudget() {
        let turns = [turn(.user, "hello"), turn(.assistant, "hi"), turn(.user, "again")]
        let out = engine.historyForRequest(turns)
        #expect(out.map(\.content) == ["hello", "hi", "again"])
    }

    @Test("Oversized single turn is clipped with marker")
    func perTurnClip() {
        let big = String(repeating: "a", count: ChatEngine.maxHistoryTurnChars + 500)
        let out = engine.historyForRequest([turn(.user, big)])
        #expect(out.count == 1)
        #expect(out[0].content.count == ChatEngine.maxHistoryTurnChars
                + "\n…(turn clipped)".count)
        #expect(out[0].content.hasSuffix("…(turn clipped)"))
    }

    @Test("Over total budget: newest turns kept, first user turn anchored")
    func anchorAndTail() {
        // anchor is huge but fits a reserved budget (after its own per-turn
        // clip); tail turns are small.
        let anchor = turn(.user, String(repeating: "a", count: 100_000))
        var turns = [anchor]
        for _ in 0..<20 { turns.append(turn(.assistant, String(repeating: "b", count: 24_000))) }
        turns.append(turn(.user, "final question"))
        let out = engine.historyForRequest(turns)
        #expect(out.first?.content.hasPrefix("aaaa") == true)          // anchor survives
        #expect(out.last?.content == "final question")                 // newest survives
        let total = out.reduce(0) { $0 + $1.content.count }
        #expect(total <= ChatEngine.maxHistoryChars)
    }

    @Test("Oversized anchor is per-turn clipped and kept, never dropped")
    func anchorTooBig() {
        // Reality check: the anchor is clipped to maxHistoryTurnChars + marker
        // BEFORE the anchor reservation, so the total fits the 400k budget and
        // both turns survive. The brief expected ["small"] only (anchor
        // dropped) — that branch is unreachable while per-turn clipping runs
        // first, since a clipped turn (24,016 chars) always fits the 400k
        // reservation budget.
        let anchor = turn(.user, String(repeating: "a", count: ChatEngine.maxHistoryChars + 1))
        let out = engine.historyForRequest([anchor, turn(.user, "small")])
        #expect(out.count == 2)
        #expect(out[0].content.count == ChatEngine.maxHistoryTurnChars
                + "\n…(turn clipped)".count)
        #expect(out[0].content.hasSuffix("…(turn clipped)"))
        #expect(out[1].content == "small")
    }

    @Test("No user turn: no anchor, newest-first packing within full budget")
    func noUserTurn() {
        // The only reachable anchor==nil path: there is no user turn to
        // reserve, so the whole 400k budget packs the tail newest-first.
        var turns: [ChatMessage] = []
        for _ in 0..<20 { turns.append(turn(.assistant, String(repeating: "b", count: 24_000))) }
        turns.append(turn(.assistant, "final answer"))
        let out = engine.historyForRequest(turns)
        #expect(out.last?.content == "final answer")
        let total = out.reduce(0) { $0 + $1.content.count }
        #expect(total <= ChatEngine.maxHistoryChars)
        // Newest-first packing: with 20×24k + tail, the oldest turns are the
        // ones dropped (400k admits 16 of the 24k turns plus the tail).
        #expect(out.count == 17)
        #expect(out.first?.content == String(repeating: "b", count: 24_000))
    }

    @Test("A tool-result message is packed by its reconstructed wire text")
    func toolResultUsesWireText() {
        // `migrate` splits this ack into summary + output; the packer must
        // measure and emit `legacyContent()`, not the summary line alone —
        // the whole point of the budget is to bound what is SENT.
        let ack = "(git push result)\nEverything up-to-date"
        let out = engine.historyForRequest([turn(.user, "push it"), turn(.user, ack)])
        #expect(out.map(\.role) == [.user, .user])   // server sees user/assistant only
        #expect(out[1].content == ack)
    }
}
