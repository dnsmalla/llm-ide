import Foundation

/// Seam over `LlmIdeAPIClient.askAgent` so `AgentAskTransport` can be driven
/// by a scripted double in tests, with no live server — the same idea as
/// `ChatTransport` abstracting the code-assist round trip (`ChatTransport.swift`).
/// Deliberately narrow (only the one method `AgentAskTransport` calls): a
/// wider "the whole agent-ask surface" protocol would force a double to
/// implement methods this transport never touches.
protocol AgentAskSending: Sendable {
    func askAgent(message: String, history: [LlmIdeAPIClient.AgentAskMessage],
                  images: [(mediaType: String, data: String)],
                  model: String?, provider: String?) async throws -> String
}

/// Seam over the two `/kb/agent/ask/history` endpoints `LlmChatViewModel`
/// needs (`AgentAskSending` above only covers the send side) — so
/// `loadHistory()`/`clearHistory()` can be driven by a canned double instead
/// of a live server.
protocol AgentAskHistoryFetching: Sendable {
    func listAgentAskHistory(limit: Int) async throws -> [LlmIdeAPIClient.AgentAskHistoryItem]
    @discardableResult
    func clearAgentAskHistory() async throws -> Int
}

// `LlmIdeAPIClient`'s existing methods already match both signatures above
// (default parameter values aren't part of a method's type, so they don't
// block conformance) — no forwarding shims needed.
extension LlmIdeAPIClient: AgentAskSending, AgentAskHistoryFetching {}

/// `ChatTransport` for the LLM Chat sheet's `/kb/agent/ask` endpoint — the
/// same shared transcript the iPhone's `llmide_chat` uses via
/// `MobileControlManager`. Unlike `CodeAssistTransport`, `/kb/agent/ask` is a
/// single buffered call with no SSE progress/chunk events: `roundTrip` never
/// invokes `onProgress`/`onChunk`, so the engine's streaming placeholder
/// stays empty for the whole call and is filled in one shot when the reply
/// lands — exactly like `CodeAssistTransport`'s buffered-fallback path, just
/// without ever having a streamed path to fall back FROM.
struct AgentAskTransport: ChatTransport {
    let sender: AgentAskSending

    init(api: LlmIdeAPIClient) {
        self.sender = api
    }

    /// Test-only entry point — takes the seam directly so a scripted double
    /// can stand in for `LlmIdeAPIClient`.
    init(sender: AgentAskSending) {
        self.sender = sender
    }

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        // `input.history` arrives already wire-encoded by `ChatEngine.packHistory`
        // (`[CodeAssistTurn]`, i.e. `{role, content}`) — re-shape into the
        // `askAgent`-specific `AgentAskMessage` the endpoint expects. No images:
        // the sheet has never supported attaching one.
        let history = input.history.map {
            LlmIdeAPIClient.AgentAskMessage(
                role: $0.role == .user ? .user : .assistant,
                content: $0.content
            )
        }
        let reply = try await sender.askAgent(
            message: input.message,
            history: history,
            images: [],
            model: input.model,
            provider: input.provider
        )
        // `/kb/agent/ask` has no pending-tool/task/continuation/usage concept —
        // those fields only mean something for `/code-assist`.
        return ChatTransportResult(
            reply: reply, pendingTool: nil, tasks: nil,
            continueNeeded: nil, usage: nil, mode: nil
        )
    }
}
