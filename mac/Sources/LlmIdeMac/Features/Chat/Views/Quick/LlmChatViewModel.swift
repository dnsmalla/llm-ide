import Foundation

/// View model for `LlmChatSheet` — `send`/`stop` pulled out of the view so
/// they're unit-testable without instantiating SwiftUI. Wraps a `ChatEngine`
/// (the same shared `.quick` instance `MenuBarChatView` and the phone drive,
/// resolved via `ChatEngineRegistry`) rather than re-implementing the turn
/// lifecycle: `send`/`stop` are thin passthroughs onto the engine, which
/// already owns — and is already tested for — queueing, the streaming
/// placeholder, and stop-mid-turn semantics.
///
/// As of Task 6, this no longer polls `/kb/agent/ask/history` at all: the
/// engine owns its transcript directly (`engine.messages`, persisted via
/// `ChatSessionStore`), so there is nothing left for a view model to fetch or
/// reconcile. The old `loadHistory`/`clearHistory`/`notifyIfTurnFinished`/
/// `PollBackoff` machinery (and the `AgentAskHistoryFetching` seam it was
/// built on) is gone with it — see `LlmChatSheet.swift`'s `performClearHistory`
/// for how clearing works now (`engine.clearCurrentChat()`), and its
/// `.onChange(of: engine.messages)` for how persistence works now
/// (`engine.announceAndPersist`).
@MainActor
@Observable
final class LlmChatViewModel {
    let engine: ChatEngine

    var lastError: String?

    init(engine: ChatEngine) {
        self.engine = engine
    }

    /// Start a turn. A thin call onto the engine — `startTurn` is what wires
    /// up `runTask`, which `stop()` below cancels; calling `engine.runTurn`
    /// directly here would leave `runTask` nil and make Stop a no-op.
    ///
    /// Clears `lastError` up front, matching the original sheet's `send()` —
    /// a stale error banner shouldn't keep showing once the user is clearly
    /// back online and sending again.
    func send(_ text: String, skillIds: [String] = []) {
        lastError = nil
        engine.startTurn(text, skillIds: skillIds)
    }

    /// Cancel the in-flight turn, if any.
    func stop() {
        engine.stop()
    }

    /// If the turn that just changed ended in `.failed` (a connectivity/
    /// server failure — never a user-initiated stop, which is `.stopped`),
    /// returns the user's own prompt so the view can restore it into the
    /// composer draft instead of losing it silently (the original sheet's
    /// `draft = text` on a caught error; this view clears the draft
    /// optimistically before the turn resolves, so recovery has to happen
    /// here instead). Only fires on the TRANSITION into `.failed` — a later,
    /// unrelated `onChange` delivery for the same already-failed message
    /// returns nil, so the view doesn't stomp on whatever the user has since
    /// typed.
    func recoverableDraftAfterFailure(oldValue: [ChatMessage], newValue: [ChatMessage]) -> String? {
        guard let last = newValue.last, last.role == .assistant, last.status == .failed else { return nil }
        if let oldLast = oldValue.last, oldLast.id == last.id, oldLast.status == .failed { return nil }
        guard newValue.count >= 2 else { return nil }
        let prior = newValue[newValue.count - 2]
        guard prior.role == .user else { return nil }
        return prior.content
    }
}
