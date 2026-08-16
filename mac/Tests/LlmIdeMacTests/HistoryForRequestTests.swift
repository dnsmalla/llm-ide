import Testing
@testable import LlmIdeMacLib

/// Pins the wire-history packing rules from CodeAssistantPanel+Session.swift
/// (historyForRequest, lines 468-499): per-turn clip at 24k, total budget
/// 400k, newest-first packing, first-user-turn anchor always included.
///
/// Divergences from the task brief, fixed to match current behavior:
/// - `LlmIdeAPIClient(baseURL:)` takes a `String`, not a `URL`.
/// - The "anchor larger than whole budget is dropped" scenario is
///   UNREACHABLE: per-turn clipping runs before the anchor reservation, so
///   a first user turn is at most `maxHistoryTurnChars + marker` chars and
///   always fits the 400k budget. The oversized-anchor test pins what
///   actually happens (clip, keep, tail kept); the anchor-nil branch is
///   covered separately by the no-user-turn test.
@Suite("historyForRequest packing")
struct HistoryForRequestTests {
    let panel = CodeAssistantPanel(
        api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"),
        scope: .explorer)

    func turn(_ role: LlmIdeAPIClient.CodeAssistRole, _ content: String)
        -> LlmIdeAPIClient.CodeAssistTurn { .init(role: role, content: content) }

    @Test("Under budget: everything passes through, order preserved")
    func underBudget() {
        let turns = [turn(.user, "hello"), turn(.assistant, "hi"), turn(.user, "again")]
        let out = panel.historyForRequest(turns)
        #expect(out.map(\.content) == ["hello", "hi", "again"])
    }

    @Test("Oversized single turn is clipped with marker")
    func perTurnClip() {
        let big = String(repeating: "a", count: CodeAssistantPanel.maxHistoryTurnChars + 500)
        let out = panel.historyForRequest([turn(.user, big)])
        #expect(out.count == 1)
        #expect(out[0].content.count == CodeAssistantPanel.maxHistoryTurnChars
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
        let out = panel.historyForRequest(turns)
        #expect(out.first?.content.hasPrefix("aaaa") == true)          // anchor survives
        #expect(out.last?.content == "final question")                 // newest survives
        let total = out.reduce(0) { $0 + $1.content.count }
        #expect(total <= CodeAssistantPanel.maxHistoryChars)
    }

    @Test("Oversized anchor is per-turn clipped and kept, never dropped")
    func anchorTooBig() {
        // Reality check: the anchor is clipped to maxHistoryTurnChars + marker
        // BEFORE the anchor reservation, so the total fits the 400k budget and
        // both turns survive. The brief expected ["small"] only (anchor
        // dropped) — that branch is unreachable while per-turn clipping runs
        // first, since a clipped turn (24,016 chars) always fits the 400k
        // reservation budget.
        let anchor = turn(.user, String(repeating: "a", count: CodeAssistantPanel.maxHistoryChars + 1))
        let out = panel.historyForRequest([anchor, turn(.user, "small")])
        #expect(out.count == 2)
        #expect(out[0].content.count == CodeAssistantPanel.maxHistoryTurnChars
                + "\n…(turn clipped)".count)
        #expect(out[0].content.hasSuffix("…(turn clipped)"))
        #expect(out[1].content == "small")
    }

    @Test("No user turn: no anchor, newest-first packing within full budget")
    func noUserTurn() {
        // The only reachable anchor==nil path: there is no user turn to
        // reserve, so the whole 400k budget packs the tail newest-first.
        var turns: [LlmIdeAPIClient.CodeAssistTurn] = []
        for _ in 0..<20 { turns.append(turn(.assistant, String(repeating: "b", count: 24_000))) }
        turns.append(turn(.assistant, "final answer"))
        let out = panel.historyForRequest(turns)
        #expect(out.last?.content == "final answer")
        let total = out.reduce(0) { $0 + $1.content.count }
        #expect(total <= CodeAssistantPanel.maxHistoryChars)
        // Newest-first packing: with 20×24k + tail, the oldest turns are the
        // ones dropped (400k admits 16 of the 24k turns plus the tail).
        #expect(out.count == 17)
        #expect(out.first?.content == String(repeating: "b", count: 24_000))
    }
}
