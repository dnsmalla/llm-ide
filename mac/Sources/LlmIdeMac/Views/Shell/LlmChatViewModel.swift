import Foundation

/// View model for `LlmChatSheet` — `send`/`stop`/`loadHistory`/`clearHistory`
/// pulled out of the view so they're unit-testable without instantiating
/// SwiftUI. Wraps a `ChatEngine` (built by the view with `AgentAskTransport`)
/// rather than re-implementing the turn lifecycle: `send`/`stop` are thin
/// passthroughs onto the engine, which already owns — and is already tested
/// for — queueing, the streaming placeholder, and stop-mid-turn semantics.
/// Nothing about that lifecycle is specific to this sheet; only the
/// server-persisted-history polling below is.
@MainActor
@Observable
final class LlmChatViewModel {
    let engine: ChatEngine
    private let historyAPI: AgentAskHistoryFetching

    private(set) var loadingHistory = false
    var lastError: String?

    init(engine: ChatEngine, historyAPI: AgentAskHistoryFetching) {
        self.engine = engine
        self.historyAPI = historyAPI
    }

    /// Real construction path: builds the engine with `AgentAskTransport`
    /// over `api`, and reuses `api` for the history endpoints too (it already
    /// conforms to `AgentAskHistoryFetching` — see `AgentAskTransport.swift`).
    convenience init(api: LlmIdeAPIClient) {
        self.init(engine: ChatEngine(scope: .explorer, transport: AgentAskTransport(api: api)),
                   historyAPI: api)
    }

    /// Start a turn. A thin call onto the engine — `startTurn` is what wires
    /// up `runTask`, which `stop()` below cancels; calling `engine.runTurn`
    /// directly here would leave `runTask` nil and make Stop a no-op.
    func send(_ text: String) {
        engine.startTurn(text)
    }

    /// Cancel the in-flight turn, if any.
    func stop() {
        engine.stop()
    }

    /// Fetch the most recent persisted Ask-the-Agent turns and replace the
    /// engine's transcript with them. Guarded on `!engine.busy`, matching the
    /// original sheet's `guard !sending` — a turn already in flight hasn't
    /// landed its reply in the server's history yet, so polling now would
    /// clobber the (correct) in-memory streaming placeholder with a stale
    /// server snapshot.
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
            engine.replaceMessages(items.map(Self.chatMessage(from:)))
        } catch {
            lastError = "Could not load shared conversation: \(error.localizedDescription)"
        }
    }

    /// Wipe the shared transcript server-side and locally, then tell other
    /// listeners (in particular the iPhone's own poll/refresh, and this
    /// sheet's own `.onReceive`) that the transcript changed — mirrors the
    /// original sheet's `clearHistory()`.
    func clearHistory() async {
        do {
            _ = try await historyAPI.clearAgentAskHistory()
            engine.replaceMessages([])
            NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Notify other listeners exactly when a turn just finished with a real
    /// reply — mirrors the original sheet's `send()`, which posted
    /// `.llmChatTranscriptChanged` only after a successful `askAgent` reply
    /// landed, never on failure or a user-initiated stop. Driven from the
    /// view's `.onChange(of: engine.messages)`, since that's the one place
    /// that sees both the before/after snapshot around a turn completing.
    func notifyIfTurnFinished(oldValue: [ChatMessage], newValue: [ChatMessage]) {
        guard newValue.count > oldValue.count,
              let last = newValue.last,
              last.role == .assistant,
              last.status == .done
        else { return }
        NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
    }

    /// One `AgentAskHistoryItem` → `ChatMessage`, with the deterministic id
    /// scheme documented on `loadHistory` above. `seq` is expected to fit in
    /// 12 decimal digits (a per-user counter that would need ~10^12 sent
    /// messages to overflow it) — decimal digits are a subset of the hex
    /// alphabet a UUID's last group requires, so zero-padding to 12 with
    /// `%012d` always yields a syntactically valid UUID string.
    private static func chatMessage(from item: LlmIdeAPIClient.AgentAskHistoryItem) -> ChatMessage {
        let id = UUID(uuidString: "00000000-0000-0000-0000-\(String(format: "%012d", item.seq))")!
        let role: ChatMessage.Role = item.role == "assistant" ? .assistant : .user
        // Server stores `created_at` as `Date.now() / 1000` (seconds since
        // epoch — `kb/personas.mjs:appendAgentAskMessage`).
        return ChatMessage(id: id, role: role, content: item.content, status: .done,
                            createdAt: Date(timeIntervalSince1970: item.createdAt))
    }
}
