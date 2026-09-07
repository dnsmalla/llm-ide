import Testing
import Foundation
@testable import LlmIdeMacLib

// MARK: - Scripted doubles

/// Scripts `askAgent` deterministically: records every call, returns a
/// canned reply (or throws a canned error). Task 11's answer to
/// `ScriptedChatTransport` (`CodeAssistTransportTests.swift`) for the
/// `/kb/agent/ask` surface — no live server involved.
@MainActor
final class ScriptedAgentAskSender: AgentAskSending, @unchecked Sendable {
    struct Call: Equatable {
        let message: String
        let history: [LlmIdeAPIClient.AgentAskMessage]
        let model: String?
        let provider: String?
    }

    var reply = "the reply"
    var thrownError: Error?
    private(set) var calls: [Call] = []

    func askAgent(message: String, history: [LlmIdeAPIClient.AgentAskMessage],
                  images: [(mediaType: String, data: String)],
                  model: String?, provider: String?) async throws -> String {
        calls.append(Call(message: message, history: history, model: model, provider: provider))
        if let thrownError { throw thrownError }
        return reply
    }
}

/// A `ChatTransport` that never resolves until cancelled — for exercising
/// `LlmChatViewModel.stop()`'s wiring onto `engine.stop()` (which needs a
/// turn genuinely in flight to cancel, unlike `ScriptedChatTransport`'s
/// synchronous scripted steps).
@MainActor
final class HangingTransport: ChatTransport, @unchecked Sendable {
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        // Long enough that every test below cancels well before this fires;
        // `Task.sleep` throws `CancellationError` as soon as its task is
        // cancelled, so `stop()` unblocks this immediately in practice.
        try await Task.sleep(nanoseconds: 5_000_000_000)
        return .init(reply: "too late", pendingTool: nil, tasks: nil,
                     continueNeeded: nil, usage: nil, mode: nil)
    }
}

// MARK: - AgentAskTransport

@MainActor
@Suite("AgentAskTransport")
struct AgentAskTransportTests {
    @Test("roundTrip maps CodeAssistTurn history to AgentAskMessage, forwards model/provider, and never streams")
    func mapsHistoryAndForwards() async throws {
        let sender = ScriptedAgentAskSender()
        sender.reply = "Hello there"
        let transport = AgentAskTransport(sender: sender)

        let history: [LlmIdeAPIClient.CodeAssistTurn] = [
            .init(role: .user, content: "hi"),
            .init(role: .assistant, content: "hello"),
        ]
        let input = ChatTransportInput(message: "hi again", history: history, attachments: [],
                                        skills: [], agentContext: nil, language: "en",
                                        model: "claude-x", provider: "anthropic", mode: nil)

        var progressCount = 0
        var chunkCount = 0
        let result = try await transport.roundTrip(
            input,
            onProgress: { _ in progressCount += 1 },
            onChunk: { _ in chunkCount += 1 }
        )

        // /kb/agent/ask is one buffered call — never a streamed progress/chunk.
        #expect(progressCount == 0)
        #expect(chunkCount == 0)

        // The reply lands verbatim; every other ChatTransportResult field is
        // nil — none of them mean anything for this endpoint.
        #expect(result.reply == "Hello there")
        #expect(result.pendingTool == nil)
        #expect(result.tasks == nil)
        #expect(result.continueNeeded == nil)
        #expect(result.usage == nil)
        #expect(result.mode == nil)

        #expect(sender.calls.count == 1)
        let call = sender.calls[0]
        #expect(call.message == "hi again")
        #expect(call.model == "claude-x")
        #expect(call.provider == "anthropic")
        #expect(call.history.map(\.role) == [.user, .assistant])
        #expect(call.history.map(\.content) == ["hi", "hello"])
    }

    @Test("A thrown error propagates from roundTrip unchanged")
    func propagatesError() async {
        struct Boom: Error {}
        let sender = ScriptedAgentAskSender()
        sender.thrownError = Boom()
        let transport = AgentAskTransport(sender: sender)
        let input = ChatTransportInput(message: "hi", history: [], attachments: [],
                                        skills: [], agentContext: nil, language: nil,
                                        model: nil, provider: nil, mode: nil)
        do {
            _ = try await transport.roundTrip(input, onProgress: { _ in }, onChunk: { _ in })
            Issue.record("expected roundTrip to throw")
        } catch is Boom {
            // expected
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }
}

// MARK: - LlmChatViewModel
//
// As of Task 6, `LlmChatViewModel` no longer polls `/kb/agent/ask/history` —
// `loadHistory`/`clearHistory`/`notifyIfTurnFinished`/`PollBackoff` and the
// `AgentAskHistoryFetching` seam they were built on are gone (the `.quick`
// engine owns its transcript directly via `ChatSessionStore`). Only
// `send`/`stop`/`recoverableDraftAfterFailure` remain to test here — the
// history-polling coverage that used to live in this suite (and in
// `LlmChatPollBackoffTests.swift`, deleted alongside this) went with the code
// it tested.

@MainActor
@Suite("LlmChatViewModel")
struct LlmChatViewModelTests {
    func makeViewModel() -> (LlmChatViewModel, ScriptedChatTransport) {
        let transport = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: transport)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: nil)
        }
        let vm = LlmChatViewModel(engine: engine)
        return (vm, transport)
    }

    @Test("send() starts a turn on the engine and it completes normally")
    func sendStartsATurn() async {
        let (vm, transport) = makeViewModel()
        transport.result = .init(reply: "hi back", pendingTool: nil, tasks: nil,
                                 continueNeeded: nil, usage: nil, mode: nil)
        vm.send("hello")
        // send() fires an unstructured Task via engine.startTurn — pump it,
        // same technique ChatEngineTurnTests.queueDrain uses.
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(vm.engine.messages.map(\.role) == [.user, .assistant])
        #expect(vm.engine.messages.last?.content == "hi back")
        #expect(vm.engine.busy == false)
    }

    @Test("stop() cancels the in-flight turn started by send()")
    func stopCancelsTurn() async {
        let engine = ChatEngine(scope: .explorer, transport: HangingTransport())
        let vm = LlmChatViewModel(engine: engine)
        vm.send("hello")
        // Let runTurn actually start and reach the roundTrip suspension point.
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(engine.busy == true)
        vm.stop()
        // Give the cancelled Task.sleep + runTurn's catch block time to unwind.
        try? await Task.sleep(nanoseconds: 150_000_000)
        #expect(engine.busy == false)
        #expect(engine.messages.last?.status == .stopped)
    }

    @Test("recoverableDraftAfterFailure returns the user's prompt on the transition into .failed, once")
    func recoverableDraftAfterFailureFiresOnce() {
        let (vm, _) = makeViewModel()
        let userMsg = ChatMessage(role: .user, content: "please help", status: .done, createdAt: Date())
        let failedAssistant = ChatMessage(role: .assistant, content: "", status: .failed, createdAt: Date())

        #expect(vm.recoverableDraftAfterFailure(oldValue: [userMsg], newValue: [userMsg, failedAssistant])
                == "please help")
        // Already failed BEFORE this change (same id, same status) — a later,
        // unrelated onChange delivery for the same value must return nil so
        // the view doesn't stomp on whatever the user has since typed.
        #expect(vm.recoverableDraftAfterFailure(oldValue: [userMsg, failedAssistant],
                                                 newValue: [userMsg, failedAssistant]) == nil)
    }

    @Test("recoverableDraftAfterFailure returns nil for a user-initiated stop")
    func recoverableDraftAfterFailureIgnoresStopped() {
        let (vm, _) = makeViewModel()
        let userMsg = ChatMessage(role: .user, content: "please help", status: .done, createdAt: Date())
        let stoppedAssistant = ChatMessage(role: .assistant, content: "partial", status: .stopped, createdAt: Date())
        #expect(vm.recoverableDraftAfterFailure(oldValue: [userMsg], newValue: [userMsg, stoppedAssistant]) == nil)
    }
}
