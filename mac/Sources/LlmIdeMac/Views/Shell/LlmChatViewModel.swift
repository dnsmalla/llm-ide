import Foundation
import os.log

/// Seam over the two `/kb/agent/ask/history` endpoints `LlmChatViewModel`
/// needs (`AgentAskSending` in `AgentAskTransport.swift` only covers the
/// send side) — so `loadHistory()`/`clearHistory()` can be driven by a
/// canned double instead of a live server. Lives alongside its one
/// consumer rather than in `AgentAskTransport.swift`.
protocol AgentAskHistoryFetching: Sendable {
    func listAgentAskHistory(limit: Int) async throws -> [LlmIdeAPIClient.AgentAskHistoryItem]
    @discardableResult
    func clearAgentAskHistory() async throws -> Int
}

extension LlmIdeAPIClient: AgentAskHistoryFetching {}

/// View model for `LlmChatSheet` — `send`/`stop`/`loadHistory`/`clearHistory`
/// pulled out of the view so they're unit-testable without instantiating
/// SwiftUI. Wraps a `ChatEngine` (built by the view with `AgentAskTransport`)
/// rather than re-implementing the turn lifecycle: `send`/`stop` are thin
/// passthroughs onto the engine, which already owns — and is already tested
/// for — queueing, the streaming placeholder, and stop-mid-turn semantics.
/// Nothing about that lifecycle is specific to this sheet; only the
/// server-persisted-history polling below is.
///
/// IMPORTANT limitation this whole file works around for late-cancel races
/// (code review, Task 11 follow-up — see `stop()` and `chatMessage(from:)`
/// below): when Stop arrives after the server already persisted a reply,
/// `loadHistory()`'s poll can overwrite a local `.stopped` bubble. Server-side
/// cancel now retracts the user row and skips the assistant append when the
/// client disconnects in time; `clientStoppedTurnActive` covers the late case.
@MainActor
@Observable
final class LlmChatViewModel {
    let engine: ChatEngine
    private let historyAPI: AgentAskHistoryFetching
    private let log = Logger(subsystem: "com.llmide.macapp", category: "LlmChatViewModel")

    private(set) var loadingHistory = false
    var lastError: String?

    /// Set by `send()`, consumed by `notifyIfTurnFinished` — gates the
    /// `.llmChatTranscriptChanged` repost to turns THIS view model started,
    /// so a poll that happens to observe growth from an iPhone-driven turn
    /// (already the reason the poll ran) doesn't re-post and cause another
    /// redundant refresh loop.
    private var awaitingOwnTurn = false

    /// After the user hits Stop, `loadHistory()` must not replace the local
    /// `.stopped` tail with the server's eventual `.done` row for the same
    /// turn (`/kb/agent/ask` has no server-side cancel). Cleared on the next
    /// `send()` / `clearHistory()`, or when the server history grows (e.g.
    /// a turn started from the iPhone).
    private var clientStoppedTurnActive = false

    init(engine: ChatEngine, historyAPI: AgentAskHistoryFetching) {
        self.engine = engine
        self.historyAPI = historyAPI
    }

    /// Start a turn. A thin call onto the engine — `startTurn` is what wires
    /// up `runTask`, which `stop()` below cancels; calling `engine.runTurn`
    /// directly here would leave `runTask` nil and make Stop a no-op.
    ///
    /// Clears `lastError` up front, matching the original sheet's `send()` —
    /// a stale history-fetch error banner shouldn't keep showing once the
    /// user is clearly back online and sending again.
    func send(_ text: String) {
        lastError = nil
        clientStoppedTurnActive = false
        awaitingOwnTurn = true
        engine.startTurn(text)
    }

    /// Cancel the in-flight turn, if any.
    ///
    /// Cancels the client's URLSession wait; the server aborts `runClaude`
    /// on socket close and retracts the persisted user row when cancel lands
    /// in time. `clientStoppedTurnActive` still guards the poll against a
    /// late server reply overwriting the local `.stopped` bubble.
    func stop() {
        engine.stop()
        clientStoppedTurnActive = true
    }

    /// Fetch the most recent persisted Ask-the-Agent turns and replace the
    /// engine's transcript with them. Guarded on `!engine.busy` BOTH before
    /// AND after the network await: a turn can start (`engine.busy` flips
    /// true) WHILE this call is suspended waiting on `listAgentAskHistory`,
    /// and the pre-await guard alone can't see that — it would let a stale,
    /// pre-turn snapshot clobber the just-appended user turn and its
    /// in-flight streaming placeholder once the await resumes (the reply,
    /// when it lands, then can't find that placeholder's id and silently
    /// no-ops). See `AgentAskTransportTests.loadHistoryRaceAfterAwait`.
    ///
    /// Each history row gets a STABLE, deterministic id derived from its
    /// per-user `seq` — not a fresh `UUID()` per poll, which would break
    /// `ForEach` diffing/animation and any transient per-message UI state on
    /// every 2s refresh. `seq` is a per-user monotonically increasing
    /// counter (`kb/personas.mjs:appendAgentAskMessage`), so this is
    /// collision-free and stable across reloads within one transcript.
    func loadHistory(limit: Int = 50) async {
        guard !engine.busy else { return }
        loadingHistory = true
        defer { loadingHistory = false }
        do {
            let items = try await historyAPI.listAgentAskHistory(limit: limit)
            guard !engine.busy else { return }
            let mapped = items.map(Self.chatMessage(from:))
            if clientStoppedTurnActive {
                // Server finished a turn the user stopped — same row count,
                // assistant flips to `.done`. Keep the local `.stopped` tail.
                if mapped.count > engine.messages.count {
                    clientStoppedTurnActive = false
                    if mapped != engine.messages {
                        engine.replaceMessages(mapped)
                    }
                }
            } else if mapped != engine.messages {
                engine.replaceMessages(mapped)
            }
            lastError = nil
        } catch {
            lastError = "Could not load shared conversation: \(error.localizedDescription)"
            log.error("Failed to load LLM Chat history: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Wipe the shared transcript server-side and locally, then tell other
    /// listeners (in particular the iPhone's own poll/refresh, and this
    /// sheet's own `.onReceive`) that the transcript changed — mirrors the
    /// original sheet's `clearHistory()`.
    func clearHistory() async {
        do {
            _ = try await historyAPI.clearAgentAskHistory()
            clientStoppedTurnActive = false
            engine.replaceMessages([])
            lastError = nil
            NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
        } catch {
            lastError = error.localizedDescription
            log.error("Failed to clear LLM Chat history: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Notify other listeners exactly when a turn THIS view model started
    /// just finished with a real reply — mirrors the original sheet's
    /// `send()`, which posted `.llmChatTranscriptChanged` only after a
    /// successful `askAgent` reply landed, never on failure or a
    /// user-initiated stop. Gated on `awaitingOwnTurn` (see that property's
    /// doc comment) so a poll-driven `replaceMessages` that happens to grow
    /// the transcript — an iPhone-originated turn arriving — doesn't also
    /// repost. Driven from the view's `.onChange(of: engine.messages)`,
    /// since that's the one place that sees both the before/after snapshot
    /// around a turn completing.
    func notifyIfTurnFinished(oldValue: [ChatMessage], newValue: [ChatMessage]) {
        guard awaitingOwnTurn,
              newValue.count > oldValue.count,
              let last = newValue.last,
              last.role == .assistant,
              last.status == .done
        else { return }
        awaitingOwnTurn = false
        NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
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

    /// One `AgentAskHistoryItem` → `ChatMessage`, with the deterministic id
    /// scheme documented on `loadHistory` above. `seq` is expected to fit in
    /// 12 decimal digits (a per-user counter that would need ~10^12 sent
    /// messages to overflow it) — decimal digits are a subset of the hex
    /// alphabet a UUID's last group requires, so zero-padding to 12 with
    /// `%012d` always yields a syntactically valid UUID string; `?? UUID()`
    /// is a belt-and-braces fallback for that theoretical overflow rather
    /// than a force-unwrap crash.
    ///
    /// `status` is unconditionally `.done`: the server only ever persists a
    /// COMPLETED turn (there's no server-side notion of `.stopped`/
    /// `.failed`), so every row this decodes really is done. The cost is
    /// documented on this class's header comment — a locally `.stopped`/
    /// `.failed` message newer than what's in `items` gets overwritten by
    /// `loadHistory`'s `replaceMessages` the moment the server's own version
    /// of that turn (or nothing at all, if it never persisted) shows up.
    private static func chatMessage(from item: LlmIdeAPIClient.AgentAskHistoryItem) -> ChatMessage {
        let id = UUID(uuidString: "00000000-0000-0000-0000-\(String(format: "%012d", item.seq))") ?? UUID()
        let role: ChatMessage.Role = item.role == "assistant" ? .assistant : .user
        // Server stores `created_at` as `Date.now() / 1000` (seconds since
        // epoch — `kb/personas.mjs:appendAgentAskMessage`).
        return ChatMessage(id: id, role: role, content: item.content, status: .done,
                            createdAt: Date(timeIntervalSince1970: item.createdAt))
    }
}
