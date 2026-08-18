import Testing
import Foundation
@testable import LlmIdeMacLib

/// v2 stream double with a PER-CALL script: `turns[i]` / `thrownErrors[i]`
/// drive the i-th `agentV2Stream` call, so one instance can play "first
/// attempt fails, fresh retry succeeds" — the sessionUnresumable recovery —
/// which the shared `ScriptedAgentV2Stream` (same events every call) cannot.
@MainActor
final class QueuedAgentV2Stream: AgentV2Streaming, @unchecked Sendable {
    var turns: [[AgentV2Event]] = []
    var thrownErrors: [Error?] = []
    private(set) var bodies: [[String: Any]] = []
    private var callIndex = 0

    func agentV2Stream(
        _ body: [String: Any],
        onEvent: @escaping @MainActor (AgentV2Event) -> Void
    ) async throws {
        bodies.append(body)
        defer { callIndex += 1 }
        if callIndex < turns.count {
            for event in turns[callIndex] { await onEvent(event) }
        }
        if callIndex < thrownErrors.count, let error = thrownErrors[callIndex] {
            throw error
        }
    }
}

/// Legacy-side double for the stale-server fallback path: records every
/// input it was handed and answers a fixed result.
@MainActor
final class ScriptedLegacyTransport: ChatTransport, @unchecked Sendable {
    var result = ChatTransportResult(reply: "legacy reply", pendingTool: nil, tasks: nil,
                                     continueNeeded: nil, usage: nil, mode: "plan")
    private(set) var inputs: [ChatTransportInput] = []

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        inputs.append(input)
        await onChunk("legacy reply")
        return result
    }
}

/// Task 12 — engine selection and the v2 turn guards: the selection rule
/// (toggle × provider), the transport factory seam, the sessionUnresumable
/// fresh retry (with its in-chat note), the stale-server 404 fallback to the
/// legacy transport, the v2 save-plan action's visibility rule, the
/// transport swap behind the settings toggle, and deleteSession's v2
/// server-side cleanup.
@MainActor
@Suite("AgentV2 selection + guards")
struct AgentV2SelectionTests {

    // MARK: - Helpers

    func makeInput(provider: String?) -> ChatTransportInput {
        ChatTransportInput(
            message: "hello", history: [], attachments: [], skills: [],
            agentContext: nil, language: nil, model: nil, provider: provider, mode: "plan")
    }

    func okTurn(sessionId: String, deltas: [String]) -> [AgentV2Event] {
        var events = [AgentV2Event.init_(AgentV2Init(sessionId: sessionId, claudeCodeVersion: nil,
                                                     model: nil, tools: [], capabilities: [],
                                                     mcpServers: []))]
        for d in deltas { events.append(.delta(d)) }
        events.append(.result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                             durationMs: nil, sessionId: nil, stopReason: nil)))
        return events
    }

    func unresumableTurn(sessionId: String) -> [AgentV2Event] {
        [
            .init_(AgentV2Init(sessionId: sessionId, claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .error(code: "SESSION_UNRESUMABLE", message: "SDK session is no longer resumable"),
        ]
    }

    func makeComposite(stream: QueuedAgentV2Stream,
                       legacy: ScriptedLegacyTransport,
                       toggle: @escaping () -> Bool)
        -> (AgentV2EngineTransport, ScriptedLegacyTransport) {
        (AgentV2EngineTransport(v2: AgentV2Transport(streamer: stream),
                                legacy: legacy, isV2Enabled: toggle), legacy)
    }

    /// Mirrors `AgentV2ApprovalTests.withTempStore`: deleteSession touches
    /// `ChatSessionStore`, so the suite must hold the ChatStoreOverrideGate
    /// and point the store at a throwaway directory.
    func withTempStore(_ body: () async throws -> Void) async rethrows {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-v2-selection-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer {
            ChatSessionStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: tmp)
        }
        try await body()
    }

    // MARK: - Selection rule (truth table)

    @Test("Selection truth table: v2 only when toggle ON and provider anthropic")
    func selectionRuleTruthTable() {
        #expect(AgentV2Selection.useV2(toggleOn: true, resolvedProvider: "anthropic") == true)
        #expect(AgentV2Selection.useV2(toggleOn: true, resolvedProvider: "openai") == false)
        #expect(AgentV2Selection.useV2(toggleOn: false, resolvedProvider: "anthropic") == false)
        #expect(AgentV2Selection.useV2(toggleOn: false, resolvedProvider: "glm") == false)
    }

    @Test("Anthropic-ness follows the app's provider resolution, not the raw picker id")
    func providerResolution() {
        // Built-in Claude tool resolves to the backend's anthropic id…
        #expect(AgentV2Selection.providerIsAnthropic(
            ChatTransportInput.makeProvider(selectedProvider: "claude_code")))
        // …while every other built-in and custom:<uuid> does not.
        #expect(!AgentV2Selection.providerIsAnthropic(
            ChatTransportInput.makeProvider(selectedProvider: "openai")))
        #expect(!AgentV2Selection.providerIsAnthropic(
            ChatTransportInput.makeProvider(selectedProvider: "gemini")))
        #expect(!AgentV2Selection.providerIsAnthropic(
            ChatTransportInput.makeProvider(selectedProvider: "custom:abc-123")))
        #expect(!AgentV2Selection.providerIsAnthropic(nil))
    }

    // MARK: - Factory seam

    @Test("Factory: v2 selected → engine transport carrying AgentV2Transport; else legacy")
    func factoryBranches() throws {
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        // Off → the plain legacy transport, byte-identical behavior.
        let legacyTransport = ChatTransportFactory.makeTransport(api: api, useV2: false)
        #expect(legacyTransport is CodeAssistTransport)
        #expect((legacyTransport as? AgentV2EngineTransport) == nil)
        // On → the engine-selection composite wrapping a real AgentV2Transport
        // over the client (the client satisfies AgentV2Streaming).
        let v2Transport = ChatTransportFactory.makeTransport(api: api, useV2: true)
        let composite = try #require(v2Transport as? AgentV2EngineTransport)
        #expect(composite.legacy is CodeAssistTransport)
    }

    // MARK: - sessionUnresumable → fresh retry

    @Test("sessionUnresumable: retries once with fresh:true, notes, and returns the fresh reply")
    func sessionUnresumableRetriesFresh() async throws {
        let stream = QueuedAgentV2Stream()
        stream.turns = [unresumableTurn(sessionId: "sdk-old"),
                        okTurn(sessionId: "sdk-new", deltas: ["fresh ", "answer"])]
        let (composite, legacy) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(), toggle: { true })

        var labels: [String] = []
        let result = try await composite.roundTrip(
            makeInput(provider: "anthropic"),
            onProgress: { labels.append($0.label) },
            onChunk: { _ in },
            onApproval: { _ in })

        #expect(result.reply == "fresh answer")
        // The system-style note rides the progress road (same as the parked-
        // approval note), so it lands in the streaming turn's tool steps.
        #expect(labels.contains(AgentV2EngineTransport.freshSessionNote))
        // Two v2 attempts; only the second carries fresh:true.
        #expect(stream.bodies.count == 2)
        #expect(stream.bodies[0]["fresh"] == nil)
        #expect(stream.bodies[1]["fresh"] as? Bool == true)
        // Legacy never fired — recovery stayed inside v2.
        #expect(legacy.inputs.isEmpty)
    }

    @Test("sessionUnresumable twice: surfaces as a failed turn, no legacy fallback")
    func sessionUnresumableTwiceFails() async {
        let stream = QueuedAgentV2Stream()
        stream.turns = [unresumableTurn(sessionId: "sdk-a"), unresumableTurn(sessionId: "sdk-b")]
        let (composite, legacy) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(), toggle: { true })

        await #expect(throws: AgentV2Error.sessionUnresumable) {
            _ = try await composite.roundTrip(
                makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        }
        #expect(legacy.inputs.isEmpty)
    }

    // MARK: - Stale-server 404 guard

    @Test("HTTP 404: banner fires and THIS turn completes on the legacy transport")
    func staleServer404FallsBack() async throws {
        let stream = QueuedAgentV2Stream()
        stream.thrownErrors = [APIError.http(status: 404, code: "HTTP_ERROR",
                                             message: "Agent v2 stream request failed (404)",
                                             details: nil)]
        let (composite, legacy) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(), toggle: { true })
        var staleBanner = 0
        composite.onStaleServer = { staleBanner += 1 }

        let result = try await composite.roundTrip(
            makeInput(provider: "anthropic"),
            onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })

        #expect(result.reply == "legacy reply")
        #expect(legacy.inputs.count == 1)
        #expect(staleBanner == 1)
    }

    @Test("Non-404 transport errors propagate — no banner, no legacy retry")
    func non404Propagates() async {
        let stream = QueuedAgentV2Stream()
        stream.thrownErrors = [APIError.http(status: 500, code: "HTTP_ERROR",
                                             message: "boom", details: nil)]
        let (composite, legacy) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(), toggle: { true })
        var staleBanner = 0
        composite.onStaleServer = { staleBanner += 1 }

        await #expect(throws: APIError.self) {
            _ = try await composite.roundTrip(
                makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        }
        #expect(legacy.inputs.isEmpty)
        #expect(staleBanner == 0)
    }

    // MARK: - Per-turn routing

    @Test("Toggle off at turn time, or a non-anthropic provider, routes the turn to legacy")
    func perTurnRouting() async throws {
        // Toggle off → legacy even though the composite carries v2 machinery.
        do {
            let stream = QueuedAgentV2Stream()
            let (composite, legacy) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(), toggle: { false })
            let result = try await composite.roundTrip(
                makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
            #expect(result.reply == "legacy reply")
            #expect(stream.bodies.isEmpty)
            _ = legacy
        }
        // Toggle on but provider openai → legacy; the v2 engine only runs
        // Anthropic turns.
        do {
            let stream = QueuedAgentV2Stream()
            let (composite, _) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(), toggle: { true })
            let result = try await composite.roundTrip(
                makeInput(provider: "openai"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
            #expect(result.reply == "legacy reply")
            #expect(stream.bodies.isEmpty)
        }
    }

    // MARK: - Engine-level behavior

    /// Engine whose transport input carries the Anthropic provider, as the
    /// panel's `wireEngine` resolves it — the default pass-through hook
    /// leaves `provider` nil, which (correctly) routes legacy.
    func makeV2Engine(stream: QueuedAgentV2Stream, legacy: ScriptedLegacyTransport) -> ChatEngine {
        let engine = ChatEngine(
            scope: .explorer,
            transport: AgentV2EngineTransport(v2: AgentV2Transport(streamer: stream),
                                               legacy: legacy, isV2Enabled: { true }))
        engine.resolveTransportInput = { message, history, attachments, skills in
            ChatTransportInput(message: message, history: history, attachments: attachments,
                               skills: skills, agentContext: nil, language: nil,
                               model: nil, provider: "anthropic", mode: "plan")
        }
        return engine
    }

    @Test("Engine turn over v2: fresh-retry note lands in the chat, turn succeeds")
    func engineFreshRetryNoteLandsInChat() async throws {
        let stream = QueuedAgentV2Stream()
        stream.turns = [unresumableTurn(sessionId: "sdk-old"),
                        okTurn(sessionId: "sdk-new", deltas: ["fresh ", "answer"])]
        let engine = makeV2Engine(stream: stream, legacy: ScriptedLegacyTransport())

        await engine.runTurn("hello")

        let last = engine.messages.last(where: { $0.role == .assistant })
        #expect(last?.content == "fresh answer")
        #expect(last?.toolSteps.map(\.label).contains(AgentV2EngineTransport.freshSessionNote) == true)
        #expect(engine.error == nil)
    }

    @Test("Engine turn over v2 404: notice banner set, legacy completes the turn, next turn clears it")
    func engineStaleServerNotice() async throws {
        let stream = QueuedAgentV2Stream()
        stream.thrownErrors = [APIError.http(status: 404, code: "HTTP_ERROR",
                                             message: "Agent v2 stream request failed (404)",
                                             details: nil)]
        stream.turns = [[], okTurn(sessionId: "sdk-2", deltas: ["v2 ok"])]
        let engine = makeV2Engine(stream: stream, legacy: ScriptedLegacyTransport())

        await engine.runTurn("one")
        // Turn one: banner raised, but the turn itself COMPLETED via legacy.
        #expect(engine.agentV2Notice == AgentV2EngineTransport.staleServerBannerText)
        #expect(engine.messages.last(where: { $0.role == .assistant })?.content == "legacy reply")
        #expect(engine.error == nil)

        // Turn two (a healthy v2 turn): the transient notice is gone.
        await engine.runTurn("two")
        #expect(engine.agentV2Notice == nil)
    }

    @Test("setTransport swaps when idle and refuses mid-turn")
    func setTransportGuards() {
        let a = ScriptedLegacyTransport()
        let engine = ChatEngine(scope: .explorer, transport: a)

        // Mid-turn: the in-flight round-trip holds the old transport; a swap
        // under it would split one turn across two engines.
        engine.busy = true
        let b = ScriptedLegacyTransport()
        engine.setTransport(b)
        #expect((engine.transport as? ScriptedLegacyTransport) === a)

        engine.busy = false
        engine.setTransport(b)
        #expect((engine.transport as? ScriptedLegacyTransport) === b)
    }

    // MARK: - Save-plan action visibility

    @Test("Save Plan action: plan-like v2 results only")
    func savePlanActionVisibility() {
        #expect(AgentV2Selection.showsSavePlanAction(mode: "plan", v2Selected: true, hasPendingTool: false))
        #expect(AgentV2Selection.showsSavePlanAction(mode: "assist_plan", v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "execute", v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "auto", v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: nil, v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "plan", v2Selected: false, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "plan", v2Selected: true, hasPendingTool: true))
    }

    @Test("Plan title derivation: first non-empty heading line, hashes stripped, capped")
    func planTitleDerivation() {
        #expect(CodeAssistantPanel.planTitle(from: "# Add dark mode\n\nSteps…") == "Add dark mode")
        #expect(CodeAssistantPanel.planTitle(from: "###  Refactor parser ") == "Refactor parser")
        #expect(CodeAssistantPanel.planTitle(from: "\n\nplain first line") == "plain first line")
        let long = String(repeating: "x", count: 100)
        #expect(CodeAssistantPanel.planTitle(from: long).count == 60)
    }

    // MARK: - deleteSession cleanup

    @Test("deleteSession additionally calls the v2 server-side session delete (best-effort)")
    func deleteSessionCallsAgentV2Cleanup() async throws {
        try await withTempStore {
            let engine = ChatEngine(scope: .explorer, transport: ScriptedLegacyTransport())
            var deleted: [String] = []
            engine.deleteAgentV2Session = { deleted.append($0) }

            let session = ChatSession(scope: .explorer, title: "Doomed")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == session.id.uuidString)

            await engine.deleteSession(session.id)
            // The local delete proceeded (file gone, engine re-pointed) AND the
            // server-side chat→SDK-session mapping was dropped with the same id.
            #expect(deleted == [session.id.uuidString])
            #expect(ChatSessionStore.load(id: session.id) == nil)
        }
    }
}
