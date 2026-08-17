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

/// Scripts `listAgentAskHistory`/`clearAgentAskHistory` for
/// `LlmChatViewModel` — the two history endpoints `AgentAskSending` doesn't
/// cover.
@MainActor
final class ScriptedHistoryFetcher: AgentAskHistoryFetching, @unchecked Sendable {
    var items: [LlmIdeAPIClient.AgentAskHistoryItem] = []
    var listError: Error?
    var clearedCount = 0
    var clearError: Error?
    private(set) var listCallCount = 0
    private(set) var clearCallCount = 0

    func listAgentAskHistory(limit: Int) async throws -> [LlmIdeAPIClient.AgentAskHistoryItem] {
        listCallCount += 1
        if let listError { throw listError }
        return items
    }

    @discardableResult
    func clearAgentAskHistory() async throws -> Int {
        clearCallCount += 1
        if let clearError { throw clearError }
        return clearedCount
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

/// Local, non-`Sendable`-capturing counter for asserting how many times a
/// `NotificationCenter` observer fired — avoids the "mutable var captured by
/// an escaping closure" shape entirely.
private final class Counter {
    var value = 0
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

@MainActor
@Suite("LlmChatViewModel")
struct LlmChatViewModelTests {
    func makeViewModel() -> (LlmChatViewModel, ScriptedChatTransport, ScriptedHistoryFetcher) {
        let transport = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: transport)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: nil)
        }
        let history = ScriptedHistoryFetcher()
        let vm = LlmChatViewModel(engine: engine, historyAPI: history)
        return (vm, transport, history)
    }

    @Test("send() starts a turn on the engine and it completes normally")
    func sendStartsATurn() async {
        let (vm, transport, _) = makeViewModel()
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
        let vm = LlmChatViewModel(engine: engine, historyAPI: ScriptedHistoryFetcher())
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

    @Test("loadHistory maps items to ChatMessage with deterministic ids derived from seq")
    func loadHistoryMapsDeterministicIds() async {
        let (vm, _, history) = makeViewModel()
        history.items = [
            .init(seq: 1, role: "user", content: "hi", createdAt: 1_700_000_000),
            .init(seq: 2, role: "assistant", content: "hello", createdAt: 1_700_000_001),
        ]
        await vm.loadHistory()
        #expect(vm.engine.messages.count == 2)
        #expect(vm.engine.messages[0].role == .user)
        #expect(vm.engine.messages[0].content == "hi")
        #expect(vm.engine.messages[1].role == .assistant)
        #expect(vm.engine.messages[1].content == "hello")
        // Deterministic scheme per the brief: zero-padded 12-digit decimal
        // seq in the last UUID group.
        #expect(vm.engine.messages[0].id == UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
        #expect(vm.engine.messages[1].id == UUID(uuidString: "00000000-0000-0000-0000-000000000002")!)
        #expect(vm.loadingHistory == false)

        // A second poll with the SAME items must yield the SAME ids — this
        // is the whole point of the deterministic scheme (stable across
        // repeated polls, unlike a fresh UUID() per load).
        let idsBefore = vm.engine.messages.map(\.id)
        await vm.loadHistory()
        #expect(vm.engine.messages.map(\.id) == idsBefore)
    }

    @Test("loadHistory does not clobber the transcript while a turn is running")
    func loadHistorySkippedWhileBusy() async {
        let engine = ChatEngine(scope: .explorer, transport: HangingTransport())
        let history = ScriptedHistoryFetcher()
        history.items = [.init(seq: 1, role: "user", content: "server side", createdAt: 0)]
        let vm = LlmChatViewModel(engine: engine, historyAPI: history)
        vm.send("hello")
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(engine.busy == true)

        await vm.loadHistory()

        #expect(history.listCallCount == 0)
        // The in-flight turn's own placeholder is untouched — not clobbered
        // by the (stale, pre-reply) server snapshot.
        #expect(engine.messages.first?.content == "hello")

        vm.stop()
    }

    @Test("loadHistory surfaces a fetch failure via lastError, leaving messages untouched")
    func loadHistoryFailure() async {
        struct Boom: Error {}
        let (vm, _, history) = makeViewModel()
        history.listError = Boom()
        await vm.loadHistory()
        #expect(vm.lastError != nil)
        #expect(vm.engine.messages.isEmpty)
    }

    @Test("clearHistory empties the transcript, calls through to clear, and posts llmChatTranscriptChanged")
    func clearHistoryPostsNotification() async {
        let (vm, transport, history) = makeViewModel()
        transport.result = .init(reply: "seed", pendingTool: nil, tasks: nil,
                                 continueNeeded: nil, usage: nil, mode: nil)
        vm.send("seed")
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(!vm.engine.messages.isEmpty)

        let counter = Counter()
        let observer = NotificationCenter.default.addObserver(
            forName: .llmChatTranscriptChanged, object: nil, queue: nil
        ) { _ in counter.value += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }

        await vm.clearHistory()

        #expect(vm.engine.messages.isEmpty)
        #expect(history.clearCallCount == 1)
        #expect(counter.value == 1)
    }

    @Test("clearHistory surfaces a failure via lastError and does not clear or notify")
    func clearHistoryFailure() async {
        struct Boom: Error {}
        let (vm, transport, history) = makeViewModel()
        transport.result = .init(reply: "seed", pendingTool: nil, tasks: nil,
                                 continueNeeded: nil, usage: nil, mode: nil)
        vm.send("seed")
        try? await Task.sleep(nanoseconds: 100_000_000)
        history.clearError = Boom()

        let counter = Counter()
        let observer = NotificationCenter.default.addObserver(
            forName: .llmChatTranscriptChanged, object: nil, queue: nil
        ) { _ in counter.value += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }

        await vm.clearHistory()

        #expect(vm.lastError != nil)
        #expect(!vm.engine.messages.isEmpty)
        #expect(counter.value == 0)
    }

    @Test("notifyIfTurnFinished posts only when a new DONE assistant turn was appended")
    func notifyIfTurnFinishedGates() {
        let (vm, _, _) = makeViewModel()
        let counter = Counter()
        let observer = NotificationCenter.default.addObserver(
            forName: .llmChatTranscriptChanged, object: nil, queue: nil
        ) { _ in counter.value += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }

        let userMsg = ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date())
        let doneAssistant = ChatMessage(role: .assistant, content: "ok", status: .done, createdAt: Date())
        let streamingAssistant = ChatMessage(role: .assistant, content: "", status: .streaming, createdAt: Date())

        // Growing history ending in a DONE assistant turn → posts.
        vm.notifyIfTurnFinished(oldValue: [userMsg], newValue: [userMsg, doneAssistant])
        #expect(counter.value == 1)

        // Growing history ending in a STREAMING placeholder → must not post yet.
        vm.notifyIfTurnFinished(oldValue: [userMsg], newValue: [userMsg, streamingAssistant])
        #expect(counter.value == 1)

        // Same-size history (e.g. an in-place content mutation) → no post.
        vm.notifyIfTurnFinished(oldValue: [userMsg, doneAssistant], newValue: [userMsg, doneAssistant])
        #expect(counter.value == 1)
    }
}
