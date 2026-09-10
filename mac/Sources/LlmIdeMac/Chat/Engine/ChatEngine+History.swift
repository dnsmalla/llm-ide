import Foundation

/// Wire-history packing for `ChatEngine` — the char budgets and
/// `historyForRequest`. Split out of ChatEngine.swift in Task 17 as a pure
/// mechanical move. Pure with respect to engine state: everything operates
/// on the `[ChatMessage]` parameter, pinned by HistoryForRequestTests.
extension ChatEngine {
    // MARK: - History packing for the wire

    /// Total characters of chat history sent per request. The server applies
    /// its own (smaller, prompt-aware) budget — see `config.history` and
    /// `selectHistoryTurns` in `llm_agent/runtime/loop.mjs` — so this only has
    /// to keep the POST body clear of the server's 8 MB request-body limit.
    static let maxHistoryChars = 400_000
    /// Per-turn clip. One runaway turn (a big command output, a whole file)
    /// must not be able to consume the entire budget by itself.
    static let maxHistoryTurnChars = 24_000

    /// The history to replay on the wire: as much as fits `maxHistoryChars`,
    /// newest-first, ALWAYS including the first user turn.
    ///
    /// Replaces a flat `history.suffix(8)`. Eight turns sounds generous until
    /// you count tool calls: every client-executed tool (bash / update-file /
    /// git-op) appends a synthetic result turn plus the agent's reply, so a
    /// four-step task pushed the user's original request out of the window and
    /// the agent carried on with no idea what it had been asked to do.
    ///
    /// Takes its input as a parameter rather than reading `self.messages`:
    /// both round-trip sites pack the history they are about to send, and the
    /// contract is pinned turn-by-turn by `HistoryForRequestTests`.
    ///
    /// Wire-encodes FIRST (`wireTurn()`, which re-renders a `.toolResult`
    /// message through `ToolResultPayload.legacyContent()` and re-attaches the
    /// stopped marker), then budgets. Both budgets have to measure what is
    /// actually SENT — a tool-result message's `content` and its reconstructed
    /// wire text can differ, and it's the latter that lands in the POST body.
    func historyForRequest(_ msgs: [ChatMessage])
        -> [LlmIdeAPIClient.CodeAssistTurn]
    {
        let clipped = msgs.map { $0.wireTurn() }.map { turn -> LlmIdeAPIClient.CodeAssistTurn in
            guard turn.content.count > Self.maxHistoryTurnChars else { return turn }
            return .init(role: turn.role,
                         content: String(turn.content.prefix(Self.maxHistoryTurnChars))
                             + "\n…(turn clipped)")
        }
        let total = clipped.reduce(0) { $0 + $1.content.count }
        if total <= Self.maxHistoryChars { return clipped }

        // Reserve the anchor (first user turn) before packing the tail.
        let anchorIdx = clipped.firstIndex { $0.role == .user }
        var budget = Self.maxHistoryChars
        var anchor: LlmIdeAPIClient.CodeAssistTurn?
        if let idx = anchorIdx, clipped[idx].content.count <= budget {
            anchor = clipped[idx]
            budget -= clipped[idx].content.count
        }
        var tail: [LlmIdeAPIClient.CodeAssistTurn] = []
        let stopAt = anchor == nil ? -1 : (anchorIdx ?? -1)
        var i = clipped.count - 1
        while i > stopAt {
            let cost = clipped[i].content.count
            if cost > budget { break }
            budget -= cost
            tail.append(clipped[i])
            i -= 1
        }
        return (anchor.map { [$0] } ?? []) + tail.reversed()
    }

}
