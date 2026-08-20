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
    /// Scripted approval to fire via the 4-callback `roundTrip` below — nil
    /// (the default) means this double never parks anything, matching every
    /// pre-Task-9 test that drives it. Set this to prove a legacy-engine
    /// `ToolApproval` reaches `onApproval`, including THROUGH
    /// `AgentV2EngineTransport`'s legacy-routing branches (Task 9).
    var approvalToFire: AgentV2Approval?

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        inputs.append(input)
        await onChunk("legacy reply")
        return result
    }

    /// 4-callback override — Task 9: the legacy engine's gated `run-bash`
    /// now genuinely parks a `ToolApproval`, so this double must be able to
    /// fire one too. Without this override, calling this double through the
    /// 4-callback entry point would fall through to `ChatTransport`'s
    /// default (which forwards to the 3-callback method above and silently
    /// drops `onApproval`) — exactly the shape of the bug
    /// `AgentV2EngineTransport` had before Task 9's fix, and exactly why
    /// that fix was otherwise unprovable: without this override the double
    /// COULD NOT produce an approval for any test to observe.
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        inputs.append(input)
        if let approval = approvalToFire {
            onApproval(approval)
        }
        await onChunk("legacy reply")
        return result
    }
}

/// Task 12 — engine selection and the v2 turn guards: the selection rule
/// (toggle × provider × per-chat engine marker), the transport factory seam,
/// the sessionUnresumable fresh retry (with its in-chat note), the
/// stale-server 404 fallback to the legacy transport, the v2 save-plan
/// action's visibility rule, the transport swap behind the settings toggle,
/// the D3 per-chat marker (ChatSession.engine), and deleteSession's v2
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
                       toggle: @escaping () -> Bool,
                       sessionEngine: @escaping () -> String? = { AgentV2Selection.sessionEngineV2 })
        -> (AgentV2EngineTransport, ScriptedLegacyTransport) {
        (AgentV2EngineTransport(v2: AgentV2Transport(streamer: stream),
                                legacy: legacy, isV2Enabled: toggle,
                                sessionEngineMarker: sessionEngine), legacy)
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

    @Test("Selection truth table: toggle × provider × per-chat engine marker (D3 clean cut)")
    func selectionRuleTruthTable() {
        let v2 = AgentV2Selection.sessionEngineV2
        // (toggle on, anthropic, marker v2) → v2 — the only v2 combination.
        #expect(AgentV2Selection.useV2(toggleOn: true, resolvedProvider: "anthropic", sessionEngine: v2))
        // (toggle on, anthropic, marker nil/legacy) → legacy — a legacy chat
        // stays on the legacy engine forever; flipping the toggle mid-chat
        // must not hand it a context-blind fresh SDK session.
        #expect(!AgentV2Selection.useV2(toggleOn: true, resolvedProvider: "anthropic", sessionEngine: nil))
        #expect(!AgentV2Selection.useV2(toggleOn: true, resolvedProvider: "anthropic", sessionEngine: "legacy"))
        // (toggle off, marker v2) → legacy — the toggle is the global kill
        // switch: off disables v2 entirely, v2 chats included.
        #expect(!AgentV2Selection.useV2(toggleOn: false, resolvedProvider: "anthropic", sessionEngine: v2))
        // The provider dimension still applies to v2 chats.
        #expect(!AgentV2Selection.useV2(toggleOn: true, resolvedProvider: "openai", sessionEngine: v2))
        #expect(!AgentV2Selection.useV2(toggleOn: false, resolvedProvider: "glm", sessionEngine: v2))
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

    // MARK: - Legacy-routed approval forwarding (Task 9 regression)
    //
    // Before Task 9's fix, every "route to legacy" branch below called
    // `legacy.roundTrip(input, onProgress:onChunk:)` — the 3-callback form —
    // which (per `ChatTransport`'s own default-forwarding extension) drops
    // `onApproval` on the floor. That was correct pre-Task-8 (the legacy
    // engine never parked anything), but is now a real bug: the legacy
    // engine's gated `run-bash` DOES park a `ToolApproval`. These two tests
    // pin the fix at both call sites — the top-level guard (never touches
    // v2 at all) and `fallbackToLegacy` (reached after a v2 stale-404) —
    // using `ScriptedLegacyTransport`'s new `approvalToFire`, which only
    // exists because the double now implements the 4-callback `roundTrip`
    // itself (see its doc comment: without that, the double could not
    // produce an approval for either test to observe, fix or no fix).

    @Test("Toggle off routes straight to legacy — its parked ToolApproval still reaches onApproval")
    func legacyRoutedCompositeForwardsApproval() async throws {
        let stream = QueuedAgentV2Stream()
        let legacy = ScriptedLegacyTransport()
        let approval = AgentV2Approval(requestId: "req-legacy-1", kind: "ToolApproval",
                                       toolName: "run-bash", argsSummary: "echo hi")
        legacy.approvalToFire = approval
        let (composite, _) = makeComposite(stream: stream, legacy: legacy, toggle: { false })

        var received: AgentV2Approval?
        let result = try await composite.roundTrip(
            makeInput(provider: "anthropic"),
            onProgress: { _ in }, onChunk: { _ in },
            onApproval: { received = $0 })

        #expect(result.reply == "legacy reply")
        #expect(received?.requestId == "req-legacy-1")
        #expect(received?.kind == "ToolApproval")
        #expect(received?.toolName == "run-bash")
        #expect(received?.argsSummary == "echo hi")
    }

    @Test("Stale-404 fallback to legacy also forwards onApproval (fallbackToLegacy path)")
    func staleServer404FallbackForwardsApproval() async throws {
        let stream = QueuedAgentV2Stream()
        stream.thrownErrors = [APIError.http(status: 404, code: "HTTP_ERROR",
                                             message: "Agent v2 stream request failed (404)",
                                             details: nil)]
        let legacy = ScriptedLegacyTransport()
        let approval = AgentV2Approval(requestId: "req-legacy-2", kind: "ToolApproval",
                                       toolName: "run-bash", argsSummary: "npm test")
        legacy.approvalToFire = approval
        let (composite, _) = makeComposite(stream: stream, legacy: legacy, toggle: { true })

        var received: AgentV2Approval?
        let result = try await composite.roundTrip(
            makeInput(provider: "anthropic"),
            onProgress: { _ in }, onChunk: { _ in },
            onApproval: { received = $0 })

        #expect(result.reply == "legacy reply")
        #expect(received?.requestId == "req-legacy-2")
        #expect(received?.kind == "ToolApproval")
    }

    // MARK: - Per-turn routing

    @Test("Toggle off at turn time, a non-anthropic provider, or a legacy-marked chat → legacy")
    func perTurnRouting() async throws {
        // Toggle off → legacy even though the composite carries v2 machinery
        // (kill switch; the chat is v2-marked).
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
        // D3: toggle on + anthropic, but the CHAT was created as a legacy
        // chat (nil marker) → legacy; the marker, not the toggle, decides
        // which engine owns an existing chat.
        do {
            let stream = QueuedAgentV2Stream()
            stream.turns = [okTurn(sessionId: "sdk-never", deltas: ["v2 reply"])]
            let (composite, _) = makeComposite(stream: stream, legacy: ScriptedLegacyTransport(),
                                               toggle: { true }, sessionEngine: { nil })
            let result = try await composite.roundTrip(
                makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
            #expect(result.reply == "legacy reply")
            #expect(stream.bodies.isEmpty, "the v2 streamer is never contacted for a legacy-marked chat")
        }
    }

    // MARK: - Engine-level behavior

    /// Engine whose transport input carries the Anthropic provider, as the
    /// panel's `wireEngine` resolves it — the default pass-through hook
    /// leaves `provider` nil, which (correctly) routes legacy — AND whose
    /// current session is stamped as a v2 chat: the D3 marker the composite
    /// reads at turn time (via the engine's `currentSessionEngineMarker`).
    /// Without a loaded session the marker is nil and turns (correctly)
    /// route legacy. Must run inside `withTempStore` — it saves and re-reads
    /// a session file.
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
        let session = ChatSession(scope: .explorer, engine: AgentV2Selection.sessionEngineV2)
        ChatSessionStore.save(session)
        engine.currentSessionIDString = session.id.uuidString
        return engine
    }

    @Test("Engine turn over v2: fresh-retry note lands in the chat, turn succeeds")
    func engineFreshRetryNoteLandsInChat() async throws {
        try await withTempStore {
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
    }

    @Test("Engine turn over v2 404: notice banner set, legacy completes the turn, next turn clears it")
    func engineStaleServerNotice() async throws {
        try await withTempStore {
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
    }

    @Test("Engine with NO session loaded routes legacy even with the toggle on (fail-closed marker)")
    func engineWithoutSessionRoutesLegacy() async throws {
        try await withTempStore {
            let stream = QueuedAgentV2Stream()
            stream.turns = [okTurn(sessionId: "sdk-x", deltas: ["v2 reply"])]
            let legacy = ScriptedLegacyTransport()
            let engine = ChatEngine(
                scope: .explorer,
                transport: AgentV2EngineTransport(v2: AgentV2Transport(streamer: stream),
                                                   legacy: legacy, isV2Enabled: { true }))
            engine.resolveTransportInput = { message, history, attachments, skills in
                ChatTransportInput(message: message, history: history, attachments: attachments,
                                   skills: skills, agentContext: nil, language: nil,
                                   model: nil, provider: "anthropic", mode: "plan")
            }

            await engine.runTurn("hello")

            #expect(engine.messages.last(where: { $0.role == .assistant })?.content == "legacy reply")
            #expect(stream.bodies.isEmpty)
        }
    }

    // MARK: - Per-chat marker (D3 clean cut)

    @Test("ChatSession engine marker: files persisted before the field decode as legacy; stamps round-trip")
    func chatSessionEngineDecode() throws {
        // A v2-envelope file written before the marker existed — no `engine`
        // key at all — must decode (nil marker = legacy chat), never throw.
        let oldJSON = """
        {"storeVersion":2,"id":"22222222-2222-2222-2222-222222222222","scope":"explorer",
         "title":"Old v2","createdAt":807271200.0,"lastUsedAt":807271200.0,"messages":[]}
        """
        let old = try AppJSON.decoder.decode(ChatSession.self, from: Data(oldJSON.utf8))
        #expect(old.engine == nil)

        // A stamped chat round-trips through the store's encoder.
        let stamped = ChatSession(scope: .explorer, engine: AgentV2Selection.sessionEngineV2)
        let data = try AppJSON.encoder.encode(stamped)
        #expect(try AppJSON.decoder.decode(ChatSession.self, from: data).engine
               == AgentV2Selection.sessionEngineV2)
    }

    @Test("Toggle defaults to on when unset")
    func toggleDefaultsOnWhenUnset() {
        let defaults = UserDefaults(suiteName: "v2-default-on-\(UUID().uuidString)")!
        #expect(AgentV2Selection.toggleEnabled(defaults: defaults) == true)
        #expect(AgentV2Selection.engineForNewChat(defaults: defaults) == AgentV2Selection.sessionEngineV2)
    }

    @Test("Explicit opt-out is honored")
    func explicitOptOutIsHonored() {
        let defaults = UserDefaults(suiteName: "v2-opt-out-\(UUID().uuidString)")!
        defaults.set(false, forKey: AgentV2Selection.toggleKey)
        #expect(AgentV2Selection.toggleEnabled(defaults: defaults) == false)
        #expect(AgentV2Selection.engineForNewChat(defaults: defaults) == nil)
    }

    @Test("engineForNewChat: stamps v2 iff the toggle is on at creation")
    func engineForNewChatStamp() {
        let suite = "agent-v2-newchat-test"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        #expect(AgentV2Selection.engineForNewChat(defaults: defaults) == nil,
                "toggle off (the default) mints a legacy chat")
        defaults.set(true, forKey: AgentV2Selection.toggleKey)
        #expect(AgentV2Selection.engineForNewChat(defaults: defaults) == AgentV2Selection.sessionEngineV2)
    }

    @Test("mintFreshSession stamps the chat's engine from the toggle; the stamp survives, later mints don't touch it")
    func mintStampsEngineMarker() async throws {
        try await withTempStore {
            let key = AgentV2Selection.toggleKey
            let prev = UserDefaults.standard.bool(forKey: key)
            UserDefaults.standard.set(true, forKey: key)
            defer { UserDefaults.standard.set(prev, forKey: key) }

            let engine = ChatEngine(scope: .explorer, transport: ScriptedLegacyTransport())
            engine.mintFreshSession()
            let v2Chat = UUID(uuidString: engine.currentSessionIDString)!
            #expect(ChatSessionStore.load(id: v2Chat)?.engine == AgentV2Selection.sessionEngineV2)
            #expect(engine.currentSessionEngineMarker() == AgentV2Selection.sessionEngineV2)

            // Toggle off later: a NEW chat mints legacy, and the v2 chat
            // keeps its stamp (the clean cut is per chat, not global state).
            UserDefaults.standard.set(false, forKey: key)
            let engine2 = ChatEngine(scope: .explorer, transport: ScriptedLegacyTransport())
            engine2.mintFreshSession()
            let legacyChat = UUID(uuidString: engine2.currentSessionIDString)!
            #expect(ChatSessionStore.load(id: legacyChat)?.engine == nil)
            #expect(ChatSessionStore.load(id: v2Chat)?.engine == AgentV2Selection.sessionEngineV2)
        }
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
