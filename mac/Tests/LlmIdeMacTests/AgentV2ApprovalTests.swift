import Testing
import Foundation
@testable import LlmIdeMacLib

/// Decision-poster double for `ChatEngine.postApprovalDecision`. Records
/// every (requestId, sdkSessionId, answers) it was handed and answers from a
/// scriptable `result` — success(true) for the happy path, success(false) for
/// a server-declined decision, failure for a transport-level error.
@MainActor
final class ScriptedDecisionPoster: @unchecked Sendable {
    struct Call: Equatable {
        let requestId: String
        let sdkSessionId: String
        let answers: [String: String]
    }

    var result: Result<Bool, Error> = .success(true)
    private(set) var calls: [Call] = []

    func post(requestId: String, sdkSessionId: String, answers: [String: String]) async throws -> Bool {
        calls.append(Call(requestId: requestId, sdkSessionId: sdkSessionId, answers: answers))
        switch result {
        case .success(let ok): return ok
        case .failure(let error): throw error
        }
    }
}

/// Decision-poster double for `ChatEngine.postToolDecision`/
/// `postLegacyToolDecision` — the `ToolApproval`-answering counterpart of
/// `ScriptedDecisionPoster` above (no `answers` dictionary; `action` instead).
/// `sessionId` is whichever the calling closure was handed: an SDK session
/// id for `postToolDecision`, or the legacy chat's own
/// `agentContext.sessionId` for `postLegacyToolDecision` — the same double
/// type serves both so a test can assert exactly one of the two posters
/// ever received a call.
@MainActor
final class ScriptedToolDecisionPoster: @unchecked Sendable {
    struct Call: Equatable {
        let requestId: String
        let sessionId: String
        let action: String
    }

    var result: Result<Bool, Error> = .success(true)
    private(set) var calls: [Call] = []

    func post(requestId: String, sessionId: String, action: String) async throws -> Bool {
        calls.append(Call(requestId: requestId, sessionId: sessionId, action: action))
        switch result {
        case .success(let ok): return ok
        case .failure(let error): throw error
        }
    }
}

/// Task 11 — the ChatEngine approval state machine over the v2 transport:
/// a parked `AskUserQuestion` surfaces as `pendingApproval`, is answered via
/// the decision POST (keeping the card on failure so the user can retry),
/// expires at the next turn start, and — during an EXTERNAL (phone-driven)
/// turn — also records the "Question pending on Mac" note into the streaming
/// turn's tool steps so the phone's mirrored view shows it.
@MainActor
@Suite("ChatEngine AgentV2 approvals")
struct AgentV2ApprovalTests {

    // MARK: - Helpers

    /// Engine + real `AgentV2Transport` over the shared `ScriptedAgentV2Stream`
    /// double (from AgentV2TransportTests) + a scripted decision poster wired
    /// into `postApprovalDecision`. Driving the REAL transport (not a new
    /// double) pins the engine↔transport onApproval plumbing end-to-end.
    func makeEngine() -> (ChatEngine, ScriptedAgentV2Stream, ScriptedDecisionPoster) {
        let stream = ScriptedAgentV2Stream()
        let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
        let poster = ScriptedDecisionPoster()
        engine.postApprovalDecision = { requestId, sdkSessionId, answers in
            try await poster.post(requestId: requestId, sdkSessionId: sdkSessionId, answers: answers)
        }
        return (engine, stream, poster)
    }

    func makeApproval(id: String) -> AgentV2Approval {
        AgentV2Approval(
            requestId: id,
            kind: "AskUserQuestion",
            questions: [AgentV2ApprovalQuestion(
                question: "Which file?",
                header: "Files",
                options: [AgentV2ApprovalOption(label: "A.md", description: "First option"),
                          AgentV2ApprovalOption(label: "B.md", description: nil)],
                multiSelect: false
            )]
        )
    }

    /// One scripted v2 turn: init (carrying the SDK session id), a leading
    /// delta, the parked approval, the post-answer delta, result. The real
    /// server holds the stream open between approval and decision; the double
    /// plays straight through — sufficient here because the engine treats
    /// `onApproval` as a side event, and the state assertions run after the
    /// turn anyway.
    func approvalTurnEvents(requestId: String, sdkSessionId: String?) -> [AgentV2Event] {
        [
            .init_(AgentV2Init(sessionId: sdkSessionId, claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .delta("I need to ask something.\n\n"),
            .approvalRequest(makeApproval(id: requestId)),
            .delta("Thanks — continuing."),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
    }

    func plainTurnEvents(sdkSessionId: String?) -> [AgentV2Event] {
        [
            .init_(AgentV2Init(sessionId: sdkSessionId, claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .delta("plain answer"),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
    }

    /// One scripted v2 turn parking a `ToolApproval` (Task 9's act-tool gate)
    /// instead of an `AskUserQuestion` — same shape as `approvalTurnEvents`,
    /// just a different `kind` on the parked approval.
    func toolApprovalTurnEvents(requestId: String, sdkSessionId: String?,
                                toolName: String = "run-bash",
                                argsSummary: String = "echo hi") -> [AgentV2Event] {
        [
            .init_(AgentV2Init(sessionId: sdkSessionId, claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .delta("Running a command.\n\n"),
            .approvalRequest(AgentV2Approval(requestId: requestId, kind: "ToolApproval",
                                             toolName: toolName, argsSummary: argsSummary)),
            .delta("Done."),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
    }

    /// The tool-step labels recorded on the last assistant turn.
    func lastAssistantToolSteps(_ engine: ChatEngine) -> [String] {
        engine.messages.last(where: { $0.role == .assistant })?.toolSteps.map(\.label) ?? []
    }

    // MARK: - Arrival + submit

    @Test("Approval arrives mid-turn → pendingApproval set; submit posts requestId/sdkSessionId/answers and clears on ok")
    func arrivalAndSubmit() async throws {
        let (engine, stream, poster) = makeEngine()
        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: "sdk-77")

        await engine.runTurn("hello")
        #expect(engine.pendingApproval?.approval.requestId == "req-1")
        #expect(engine.pendingApproval?.submitted == false)
        #expect(engine.pendingApproval?.lastError == nil)

        await engine.submitApproval(answers: ["Which file?": "A.md"])
        #expect(poster.calls == [.init(requestId: "req-1", sdkSessionId: "sdk-77",
                                       answers: ["Which file?": "A.md"])])
        #expect(engine.pendingApproval == nil)
    }

    @Test("Panel-driven approval sets NO external note in the turn's tool steps")
    func panelTurnHasNoNote() async throws {
        let (engine, stream, _) = makeEngine()
        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: "sdk-77")
        await engine.runTurn("hello")
        #expect(engine.pendingApproval != nil)
        #expect(!lastAssistantToolSteps(engine).contains(ChatEngine.externalApprovalNote))
    }

    // MARK: - Failure + retry

    @Test("Failed submit keeps the card and records the error; retry succeeds and clears")
    func failedSubmitKeepsCardForRetry() async throws {
        let (engine, stream, poster) = makeEngine()
        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: "sdk-77")
        await engine.runTurn("hello")

        poster.result = .failure(APIError.http(status: 503, code: "UNAVAILABLE",
                                               message: "backend down", details: nil))
        await engine.submitApproval(answers: ["Which file?": "A.md"])
        // Card SURVIVES a failed decision so the user can retry — with the
        // failure surfaced on the state the card renders.
        #expect(engine.pendingApproval?.approval.requestId == "req-1")
        #expect(engine.pendingApproval?.lastError != nil)
        #expect(engine.pendingApproval?.submitted == false)
        #expect(poster.calls.count == 1)

        poster.result = .success(true)
        await engine.submitApproval(answers: ["Which file?": "B.md"])
        #expect(poster.calls.count == 2)
        #expect(poster.calls[1].answers == ["Which file?": "B.md"])
        #expect(engine.pendingApproval == nil)
    }

    @Test("ok:false keeps the card too — a server-declined decision is retryable state, not success")
    func falseSubmitKeepsCard() async throws {
        let (engine, stream, poster) = makeEngine()
        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: "sdk-77")
        await engine.runTurn("hello")

        poster.result = .success(false)
        await engine.submitApproval(answers: ["Which file?": "A.md"])
        #expect(engine.pendingApproval != nil)
        #expect(engine.pendingApproval?.lastError != nil)
        #expect(poster.calls.count == 1)
    }

    @Test("No SDK session id (init carried none) → no POST, failure recorded, card kept")
    func missingSessionIdSurfacesFailure() async throws {
        let (engine, stream, poster) = makeEngine()
        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: nil)
        await engine.runTurn("hello")
        #expect(engine.pendingApproval != nil)

        await engine.submitApproval(answers: ["Which file?": "A.md"])
        #expect(poster.calls.isEmpty)
        #expect(engine.pendingApproval?.lastError != nil)
    }

    // MARK: - Tool decision (ToolApproval, Task 9)
    //
    // `submitToolDecision` is `submitApproval`'s sibling for the `ToolApproval`
    // kind: no `answers` dictionary, just an `action` string, and — unlike
    // `submitApproval`, which only ever talks to the v2 decision endpoint —
    // it branches between TWO endpoints depending on which engine actually
    // holds the approval (`agentV2SessionId` non-nil → v2's
    // `postToolDecision`; else the state's own `legacySessionId` →
    // `postLegacyToolDecision`). These tests cover both branches plus the
    // same success/failure/ok:false contract `submitApproval` already has.

    @Test("v2 ToolApproval: submitToolDecision posts requestId/sdkSessionId/action via postToolDecision and clears on ok")
    func v2ToolDecisionSubmitSucceeds() async throws {
        let stream = ScriptedAgentV2Stream()
        let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
        let poster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        stream.events = toolApprovalTurnEvents(requestId: "req-tool-1", sdkSessionId: "sdk-99")

        await engine.runTurn("run a command")
        #expect(engine.pendingApproval?.approval.kind == "ToolApproval")
        #expect(engine.pendingApproval?.approval.toolName == "run-bash")
        #expect(engine.pendingApproval?.legacySessionId == nil)

        await engine.submitToolDecision(action: "allow")
        #expect(poster.calls == [.init(requestId: "req-tool-1", sessionId: "sdk-99", action: "allow")])
        #expect(engine.pendingApproval == nil)
    }

    @Test("v2 ToolApproval: failed submit keeps the card and records the error; retry succeeds and clears")
    func v2ToolDecisionFailedSubmitKeepsCardForRetry() async throws {
        let stream = ScriptedAgentV2Stream()
        let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
        let poster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        stream.events = toolApprovalTurnEvents(requestId: "req-tool-1", sdkSessionId: "sdk-99")
        await engine.runTurn("run a command")

        poster.result = .failure(APIError.http(status: 503, code: "UNAVAILABLE",
                                                message: "backend down", details: nil))
        await engine.submitToolDecision(action: "deny")
        // Card SURVIVES a failed decision so the user can retry.
        #expect(engine.pendingApproval?.approval.requestId == "req-tool-1")
        #expect(engine.pendingApproval?.lastError != nil)
        #expect(engine.pendingApproval?.submitted == false)
        #expect(poster.calls.count == 1)

        poster.result = .success(true)
        await engine.submitToolDecision(action: "allow")
        #expect(poster.calls.count == 2)
        #expect(poster.calls[1].action == "allow")
        #expect(engine.pendingApproval == nil)
    }

    @Test("v2 ToolApproval: ok:false keeps the card too — a server-declined decision is retryable state, not success")
    func v2ToolDecisionFalseSubmitKeepsCard() async throws {
        let stream = ScriptedAgentV2Stream()
        let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
        let poster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        stream.events = toolApprovalTurnEvents(requestId: "req-tool-1", sdkSessionId: "sdk-99")
        await engine.runTurn("run a command")

        poster.result = .success(false)
        await engine.submitToolDecision(action: "always-allow")
        #expect(engine.pendingApproval != nil)
        #expect(engine.pendingApproval?.lastError != nil)
        #expect(poster.calls.count == 1)
    }

    @Test("ToolApproval with no session id anywhere (v2 init carried none, no legacy context) → no POST, failure recorded, card kept")
    func toolDecisionMissingSessionIdSurfacesFailure() async throws {
        let stream = ScriptedAgentV2Stream()
        let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
        let poster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        stream.events = toolApprovalTurnEvents(requestId: "req-tool-1", sdkSessionId: nil)
        await engine.runTurn("run a command")
        #expect(engine.pendingApproval != nil)
        #expect(engine.pendingApproval?.legacySessionId == nil)

        await engine.submitToolDecision(action: "allow")
        #expect(poster.calls.isEmpty)
        #expect(engine.pendingApproval?.lastError != nil)
    }

    @Test("Legacy ToolApproval: submitToolDecision routes to postLegacyToolDecision using the captured legacySessionId, never postToolDecision")
    func legacyToolDecisionRoutesToLegacyEndpoint() async throws {
        // ScriptedLegacyTransport (AgentV2SelectionTests.swift) now supports
        // firing a scripted approval through its 4-callback roundTrip — the
        // same capability Task 9's fix needed AgentV2EngineTransport to
        // forward. Driving it directly (no composite) here isolates
        // `submitToolDecision`'s endpoint-branch selection from that
        // composite-forwarding concern, which AgentV2SelectionTests covers
        // separately.
        let legacy = ScriptedLegacyTransport()
        let approval = AgentV2Approval(requestId: "req-legacy-9", kind: "ToolApproval",
                                       toolName: "run-bash", argsSummary: "npm test")
        legacy.approvalToFire = approval
        let engine = ChatEngine(scope: .explorer, transport: legacy)
        engine.resolveTransportInput = { message, history, attachments, skills in
            ChatTransportInput(message: message, history: history, attachments: attachments,
                              skills: skills,
                              agentContext: AgentContext(indexedRepos: [], sessionId: "legacy-sess-1"),
                              language: nil, model: nil, provider: nil, mode: nil)
        }
        let v2Poster = ScriptedToolDecisionPoster()
        let legacyPoster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await v2Poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        engine.postLegacyToolDecision = { requestId, sessionId, action in
            try await legacyPoster.post(requestId: requestId, sessionId: sessionId, action: action)
        }

        await engine.runTurn("run a command")
        #expect(engine.pendingApproval?.approval.kind == "ToolApproval")
        #expect(engine.pendingApproval?.legacySessionId == "legacy-sess-1")

        await engine.submitToolDecision(action: "allow")
        #expect(legacyPoster.calls == [.init(requestId: "req-legacy-9", sessionId: "legacy-sess-1", action: "allow")])
        #expect(v2Poster.calls.isEmpty)
        #expect(engine.pendingApproval == nil)
    }

    // MARK: - I4: mixed-engine chats
    //
    // `agentV2SessionId` reads the v2 transport's `sdkSessionId`, which
    // persists for the CHAT's lifetime once any v2 turn has run.
    // `AgentContext.sessionId` (the legacy park key) is filled on EVERY turn,
    // v2 included. So in a chat that runs a v2 turn and then a legacy one —
    // the exact shape of a stale-server 404 fallback — BOTH are non-nil, and
    // the pair alone cannot say which engine parked the approval.
    //
    // Two things make it unambiguous: the composite records which transport
    // actually ran the turn (`lastTurnRanLegacy`), and `submitToolDecision`
    // then trusts the state's captured `legacySessionId` FIRST. Before the
    // fix the v2 branch won, so a legacy approval in such a chat was posted
    // with a stale SDK session id → 403 DECISION_FORBIDDEN, an unanswerable
    // card.

    /// Mutable box so the scripted `sessionEngineMarker` closure can be
    /// flipped between turns (the composite reads it at TURN time).
    final class EngineSwitch: @unchecked Sendable { var useLegacy = false }

    /// Composite wired v2-first, then flipped to legacy for the second turn —
    /// a real mixed-engine chat, not a hand-built state.
    private func makeMixedEngineChat() -> (ChatEngine, ScriptedAgentV2Stream, ScriptedLegacyTransport, EngineSwitch) {
        let stream = ScriptedAgentV2Stream()
        let legacy = ScriptedLegacyTransport()
        let engineSwitch = EngineSwitch()
        let composite = AgentV2EngineTransport(
            v2: AgentV2Transport(streamer: stream),
            legacy: legacy,
            isV2Enabled: { true },
            sessionEngineMarker: { engineSwitch.useLegacy ? nil : AgentV2Selection.sessionEngineV2 }
        )
        let engine = ChatEngine(scope: .explorer, transport: composite)
        // ChatEngine's init re-points `sessionEngineMarker` at its own loaded
        // session (connectTransportObservers), clobbering the closure passed
        // above — restore the scripted one so this test controls the engine
        // selection without a ChatSessionStore round-trip.
        composite.sessionEngineMarker = { engineSwitch.useLegacy ? nil : AgentV2Selection.sessionEngineV2 }
        engine.resolveTransportInput = { message, history, attachments, skills in
            ChatTransportInput(message: message, history: history, attachments: attachments,
                               skills: skills,
                               agentContext: AgentContext(indexedRepos: [], sessionId: "legacy-sess-mixed"),
                               language: nil, model: nil,
                               // The composite's selection rule also requires an
                               // Anthropic provider — without it every turn would
                               // fall to legacy and the mixed state never forms.
                               provider: AgentV2Selection.anthropicProvider, mode: nil)
        }
        return (engine, stream, legacy, engineSwitch)
    }

    @Test("Mixed-engine chat: a LEGACY approval posts the legacy session id even though agentV2SessionId is also set")
    func mixedEngineLegacyApprovalUsesLegacySessionId() async throws {
        let (engine, stream, legacy, engineSwitch) = makeMixedEngineChat()
        let v2Poster = ScriptedToolDecisionPoster()
        let legacyPoster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await v2Poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        engine.postLegacyToolDecision = { requestId, sessionId, action in
            try await legacyPoster.post(requestId: requestId, sessionId: sessionId, action: action)
        }

        // Turn 1 runs on v2 and leaves an SDK session id behind for the chat.
        stream.events = plainTurnEvents(sdkSessionId: "sdk-stale-1")
        await engine.runTurn("first, on v2")
        #expect(engine.agentV2SessionId == "sdk-stale-1")

        // Turn 2 runs on LEGACY and parks a ToolApproval.
        engineSwitch.useLegacy = true
        legacy.approvalToFire = AgentV2Approval(requestId: "req-mixed-1", kind: "ToolApproval",
                                                toolName: "run-bash", argsSummary: "npm publish")
        await engine.runTurn("second, on legacy")

        // Both ids are live — this is the ambiguous state the bug lived in.
        #expect(engine.agentV2SessionId == "sdk-stale-1")
        #expect(engine.pendingApproval?.legacySessionId == "legacy-sess-mixed")

        await engine.submitToolDecision(action: "allow")
        #expect(legacyPoster.calls == [.init(requestId: "req-mixed-1", sessionId: "legacy-sess-mixed", action: "allow")])
        #expect(v2Poster.calls.isEmpty, "a legacy approval must never be posted with the stale SDK session id")
        #expect(engine.pendingApproval == nil)
    }

    @Test("Mixed-engine chat: a V2 approval still posts the SDK session id, not the always-present agentContext.sessionId")
    func mixedEngineV2ApprovalUsesSdkSessionId() async throws {
        let (engine, stream, _, _) = makeMixedEngineChat()
        let v2Poster = ScriptedToolDecisionPoster()
        let legacyPoster = ScriptedToolDecisionPoster()
        engine.postToolDecision = { requestId, sdkSessionId, action in
            try await v2Poster.post(requestId: requestId, sessionId: sdkSessionId, action: action)
        }
        engine.postLegacyToolDecision = { requestId, sessionId, action in
            try await legacyPoster.post(requestId: requestId, sessionId: sessionId, action: action)
        }

        // A v2 turn parks the approval — note the input STILL carries a
        // non-nil agentContext.sessionId ("legacy-sess-mixed"), which is why
        // tagging every approval with it unconditionally was wrong.
        stream.events = toolApprovalTurnEvents(requestId: "req-mixed-2", sdkSessionId: "sdk-live-2")
        await engine.runTurn("run a command on v2")
        #expect(engine.pendingApproval?.legacySessionId == nil, "a v2-parked approval must not be tagged legacy")

        await engine.submitToolDecision(action: "deny")
        #expect(v2Poster.calls == [.init(requestId: "req-mixed-2", sessionId: "sdk-live-2", action: "deny")])
        #expect(legacyPoster.calls.isEmpty)
    }

    // MARK: - Replacement + staleness

    @Test("A second approval replaces the state; the next turn's start clears stale state")
    func replacementAndStaleClear() async throws {
        let (engine, stream, _) = makeEngine()

        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: "sdk-77")
        await engine.runTurn("one")
        #expect(engine.pendingApproval?.approval.requestId == "req-1")

        // Turn two starts → the stale req-1 card must not survive into it…
        stream.events = approvalTurnEvents(requestId: "req-2", sdkSessionId: "sdk-77")
        await engine.runTurn("two")
        // …and req-2 REPLACES whatever was there.
        #expect(engine.pendingApproval?.approval.requestId == "req-2")

        // A plain turn (no approval at all) clears the card at turn start.
        stream.events = plainTurnEvents(sdkSessionId: "sdk-77")
        await engine.runTurn("three")
        #expect(engine.pendingApproval == nil)
    }

    @Test("Session swap drops a parked approval and its SDK session id — a later submit posts nothing")
    func sessionSwapDropsParkedApproval() async throws {
        try await withTempStore {
            let stream = ScriptedAgentV2Stream()
            let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
            let poster = ScriptedDecisionPoster()
            engine.postApprovalDecision = { requestId, sdkSessionId, answers in
                try await poster.post(requestId: requestId, sdkSessionId: sdkSessionId, answers: answers)
            }
            // Chat A loads, runs a turn, parks an approval — its init event
            // carrying the SDK session id a submit would post with.
            let a = ChatSession(scope: .explorer, title: "Chat A")
            ChatSessionStore.save(a)
            engine.handleOnAppearSessions()
            stream.events = approvalTurnEvents(requestId: "req-A", sdkSessionId: "sdk-A")
            await engine.runTurn("hello")
            #expect(engine.pendingApproval?.approval.requestId == "req-A")
            #expect(engine.agentV2SessionId == "sdk-A")

            // Swap to chat B — the same driving as ChatEngineSessionTests'
            // epochBump: save the target, call switchSession directly.
            let b = ChatSession(scope: .explorer, title: "Chat B")
            ChatSessionStore.save(b)
            engine.switchSession(to: b.id)

            // The parked card AND the id it would post with are gone — the
            // same staleness class as agent.pendingTool on the same reset.
            #expect(engine.pendingApproval == nil)
            #expect(engine.agentV2SessionId == nil)

            // Decisive: submitting on the cleared state is a no-op, so chat
            // A's requestId can never be answered from chat B.
            await engine.submitApproval(answers: ["Which file?": "A.md"])
            #expect(poster.calls.isEmpty)
        }
    }

    // MARK: - Dismiss

    @Test("dismissApproval clears without posting anything")
    func dismissClearsWithoutPosting() async throws {
        let (engine, stream, poster) = makeEngine()
        stream.events = approvalTurnEvents(requestId: "req-1", sdkSessionId: "sdk-77")
        await engine.runTurn("hello")
        #expect(engine.pendingApproval != nil)

        engine.dismissApproval()
        #expect(engine.pendingApproval == nil)
        #expect(poster.calls.isEmpty)
    }

    // MARK: - External (phone) turn note

    /// Mirrors `ChatEngineRunExternalTurnTests.withTempStore`: external turns
    /// persist through `ChatSessionStore`, so the suite must hold the
    /// ChatStoreOverrideGate and point the store at a throwaway directory.
    func withTempStore(_ body: () async throws -> Void) async rethrows {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-v2-approval-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer {
            ChatSessionStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: tmp)
        }
        try await body()
    }

    @Test("External turn: approval sets state AND the Mac-pending note lands in tool steps + the phone progress channel")
    func externalTurnRecordsNote() async throws {
        try await withTempStore {
            let stream = ScriptedAgentV2Stream()
            let engine = ChatEngine(scope: .explorer, transport: AgentV2Transport(streamer: stream))
            let poster = ScriptedDecisionPoster()
            engine.postApprovalDecision = { requestId, sdkSessionId, answers in
                try await poster.post(requestId: requestId, sdkSessionId: sdkSessionId, answers: answers)
            }
            let session = ChatSession(scope: .explorer, title: "Phone chat")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()

            stream.events = approvalTurnEvents(requestId: "req-9", sdkSessionId: "sdk-phone")
            var phoneLabels: [String] = []
            _ = try await engine.runExternalTurn(
                message: "from iPhone", skillIds: [], attachments: [],
                agentContext: nil, model: nil, provider: nil,
                expectedSessionID: session.id,
                onProgress: { phoneLabels.append($0) })

            // The Mac panel still owns the card — rendering is NOT gated on
            // the turn's origin.
            #expect(engine.pendingApproval?.approval.requestId == "req-9")
            // The note lands durably in the streaming turn's tool steps…
            #expect(lastAssistantToolSteps(engine).contains(ChatEngine.externalApprovalNote))
            // …and reaches the phone's live progress channel, the same road
            // every other progress label travels.
            #expect(phoneLabels.contains(ChatEngine.externalApprovalNote))

            await engine.submitApproval(answers: ["Which file?": "A.md"])
            #expect(poster.calls.map(\.requestId) == ["req-9"])
            #expect(poster.calls.map(\.sdkSessionId) == ["sdk-phone"])
            #expect(engine.pendingApproval == nil)
        }
    }

    // MARK: - Card answer building

    @Test("Card answer mapping: keyed by question text, multi-select comma-joined")
    func cardAnswerMapping() {
        let approval = AgentV2Approval(
            requestId: "req-map",
            kind: "AskUserQuestion",
            questions: [
                AgentV2ApprovalQuestion(
                    question: "Which files?",
                    header: "Files",
                    options: [AgentV2ApprovalOption(label: "B.md", description: nil),
                              AgentV2ApprovalOption(label: "A.md", description: nil),
                              AgentV2ApprovalOption(label: "C.md", description: nil)],
                    multiSelect: true
                ),
                AgentV2ApprovalQuestion(
                    question: "Proceed?",
                    header: nil,
                    options: [AgentV2ApprovalOption(label: "Yes", description: nil),
                              AgentV2ApprovalOption(label: "No", description: nil)],
                    multiSelect: false
                ),
            ]
        )
        let answers = ApprovalQuestionCard.answers(
            selection: [0: ["C.md", "A.md"], 1: ["Yes"]],
            questions: approval.questions
        )
        // Sorted before joining so the wire value is deterministic regardless
        // of tap order; single-select arrives as the bare label.
        #expect(answers == ["Which files?": "A.md,C.md", "Proceed?": "Yes"])
    }
}
