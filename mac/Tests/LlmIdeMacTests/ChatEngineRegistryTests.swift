import Testing
import Foundation
@testable import LlmIdeMacLib

/// Task 12: `ChatEngineRegistry` gives `MobileControlManager`'s
/// `explore_chat` bridge and the Mac `CodeAssistantPanel` the SAME
/// `ChatEngine` instance for `.explorer`, and `ChatEngine.runExternalTurn`
/// is the entry point a non-view caller (the phone) drives a turn through.
///
/// `ChatEngineRegistry.shared` is a real process-wide singleton with no
/// reset hook — each `@Test` below claims its OWN `ChatScope` case so the
/// four tests here can never see each other's cached engine. There are only
/// four scopes (`explorer`/`conflicts`/`visual`/`docGen`), which is exactly
/// enough for this suite; a fifth registry test would have to share a scope
/// with an existing one rather than add a case.
@MainActor
@Suite("ChatEngineRegistry", .serialized)
struct ChatEngineRegistryTests {
    @Test("engine(for:api:) returns the SAME instance across repeated calls, even with a different api")
    func sameInstanceAcrossCalls() {
        let apiA = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let apiB = LlmIdeAPIClient(baseURL: "http://127.0.0.1:19999")

        let first = ChatEngineRegistry.shared.engine(for: .docGen, api: apiA)
        // `api` is consulted only on first creation — a second call for the
        // SAME scope with a DIFFERENT api instance must still return the
        // identical cached engine, not rebuild it against apiB.
        let second = ChatEngineRegistry.shared.engine(for: .docGen, api: apiB)
        let third = ChatEngineRegistry.shared.engine(for: .docGen, api: apiA)

        #expect(first === second)
        #expect(first === third)
        #expect(first.scope == .docGen)
    }

    @Test("Different scopes get distinct, independent engine instances")
    func distinctScopesGetDistinctEngines() {
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")

        let visual = ChatEngineRegistry.shared.engine(for: .visual, api: api)
        let conflicts = ChatEngineRegistry.shared.engine(for: .conflicts, api: api)

        #expect(visual !== conflicts)
        #expect(visual.scope == .visual)
        #expect(conflicts.scope == .conflicts)
        // Re-fetching either one still resolves back to its own cached
        // instance, not the other scope's.
        #expect(ChatEngineRegistry.shared.engine(for: .visual, api: api) === visual)
        #expect(ChatEngineRegistry.shared.engine(for: .conflicts, api: api) === conflicts)
    }
}

/// `ChatEngine.runExternalTurn` — the turn lifecycle a non-view client (the
/// iPhone's `explore_chat`, via `MobileControlManager`) drives. These
/// construct the engine directly with a `ScriptedChatTransport`
/// (`CodeAssistTransportTests.swift`) rather than through
/// `ChatEngineRegistry` — the registry's ONLY job is returning the same
/// cached instance (covered above); `runExternalTurn`'s own behavior is
/// exactly as testable in isolation as `runTurn`'s (`ChatEngineTurnTests`),
/// and isolating it here avoids needing a live `LlmIdeAPIClient` round trip.
@MainActor
@Suite("ChatEngine.runExternalTurn", .serialized)
struct ChatEngineRunExternalTurnTests {
    static let scope: ChatScope = .explorer

    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: Self.scope, transport: t)
        return (engine, t)
    }

    /// Same pattern as `ChatEngineSessionTests.withTempStore`: point
    /// `ChatSessionStore` at a throwaway directory for the duration of
    /// `body`, then restore it. `rethrows` so a test whose closure contains
    /// `try` (runExternalTurn) compiles — a bare `() async -> Void` made the
    /// whole test target fail to build.
    func withTempStore(_ body: () async throws -> Void) async rethrows {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-engine-external-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        // Restore + cleanup in a defer, not trailing lines: `body` can throw
        // (rethrows), and a throwing body must not leave the process-global
        // override pointing at this now-abandoned directory for the rest of
        // the process. Registered AFTER the gate's defer so LIFO restores the
        // override while this suite still holds the gate, then hands it on.
        defer {
            ChatSessionStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: tmp)
        }
        try await body()
    }

    @Test("Appends user+assistant turns, forwards scripted progress, persists to disk, and is visible with no reload")
    func appendsAndPersistsAndStreams() async throws {
        try await withTempStore {
            let (engine, t) = makeEngine()
            let session = ChatSession(scope: Self.scope, title: "New chat")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == session.id.uuidString)

            t.scripted = [.progress("Reading Foo.swift", "read-file"),
                          .progress("Writing the answer", nil)]
            t.result = .init(reply: "the answer", pendingTool: nil, tasks: nil,
                             continueNeeded: nil, usage: nil, mode: nil)

            var progressLabels: [String] = []
            let reply = try await engine.runExternalTurn(
                message: "hello from iPhone", skillIds: [], attachments: [],
                agentContext: nil, model: nil, provider: nil,
                expectedSessionID: session.id,
                onProgress: { progressLabels.append($0) })

            #expect(reply == "the answer")
            // The mobile bridge's progress callback fires once per scripted
            // step — this is what lets the phone show live status text.
            #expect(progressLabels == ["Reading Foo.swift", "Writing the answer"])

            // "The panel" here is just a second reference to the exact SAME
            // engine object — precisely what `ChatEngineRegistry` sharing
            // (the other half of Task 12) hands `CodeAssistantPanel` and
            // `MobileControlManager`. No reload/notification is needed to see
            // the turn: it's the identical `messages` array underneath.
            let panelView = engine
            #expect(panelView.messages.map(\.role) == [.user, .assistant])
            #expect(panelView.messages.map(\.content) == ["hello from iPhone", "the answer"])
            #expect(panelView.messages.allSatisfy { $0.status == .done })
            #expect(engine.busy == false)
            #expect(engine.error == nil)

            // Genuinely durable — not just visible in memory. This is what
            // "persists through the engine's normal path" means: no direct
            // ChatSessionStore.save() call anywhere in MobileControlManager
            // anymore, yet the turn is still on disk.
            let onDisk = ChatSessionStore.load(id: session.id)
            #expect(onDisk?.messages.map(\.content) == ["hello from iPhone", "the answer"])
        }
    }

    @Test("A failing round trip still finalizes and persists the placeholder, and rethrows")
    func failurePropagates() async {
        await withTempStore {
            let (engine, t) = makeEngine()
            let session = ChatSession(scope: Self.scope, title: "New chat")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()

            t.thrownError = APIError.agent(message: "down")

            do {
                _ = try await engine.runExternalTurn(
                    message: "hi", skillIds: [], attachments: [],
                    agentContext: nil, model: nil, provider: nil,
                    expectedSessionID: session.id,
                    onProgress: { _ in })
                Issue.record("Expected runExternalTurn to rethrow the transport failure")
            } catch is APIError {
                // expected
            } catch {
                Issue.record("Expected APIError, got \(error)")
            }

            #expect(engine.error != nil)
            #expect(engine.busy == false)
            #expect(engine.messages.last?.role == .assistant)
            let onDisk = ChatSessionStore.load(id: session.id)
            #expect(onDisk?.messages.map(\.content).first == "hi")
        }
    }

    @Test("Throws .busy instead of racing an in-flight turn on the same shared engine")
    func busyGuardPreventsConcurrentTurns() async {
        await withTempStore {
            let (engine, _) = makeEngine()
            let session = ChatSession(scope: Self.scope, title: "New chat")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()

            // Claim the turn slot synchronously — the same mechanism
            // `beginPanelRun()` uses for a panel-driven run — so "already
            // busy" is reproduced deterministically, with no Task-scheduling
            // race to depend on.
            engine.beginPanelRun()
            #expect(engine.busy == true)

            do {
                _ = try await engine.runExternalTurn(
                    message: "hi", skillIds: [], attachments: [],
                    agentContext: nil, model: nil, provider: nil,
                    expectedSessionID: session.id,
                    onProgress: { _ in })
                Issue.record("Expected ExternalTurnError.busy to be thrown")
            } catch is ExternalTurnError {
                // expected
            } catch {
                Issue.record("Expected ExternalTurnError, got \(error)")
            }

            // The guard fires before any state mutation — nothing appended.
            #expect(engine.messages.isEmpty)
        }
    }

    @Test("Throws .sessionMoved instead of silently writing into a DIFFERENT session if the engine's active session changed after resolve")
    func sessionMovedGuardPreventsWrongSessionWrite() async {
        await withTempStore {
            let (engine, _) = makeEngine()
            let sessionA = ChatSession(scope: Self.scope, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: Self.scope, title: "B")
            ChatSessionStore.save(sessionB)

            engine.switchSession(to: sessionA.id)
            #expect(engine.currentSessionIDString == sessionA.id.uuidString)

            // Simulate the caller (`MobileControlManager.handleExploreChat`)
            // resolving the engine for session A, then — during the `await`s
            // between resolve and this call (`buildAgentContext`'s `git`
            // subprocesses in production) — the Mac user switching this SAME
            // engine to session B, exactly the race code review caught.
            let expectedSessionID = sessionA.id
            engine.switchSession(to: sessionB.id)
            #expect(engine.currentSessionIDString == sessionB.id.uuidString)

            do {
                _ = try await engine.runExternalTurn(
                    message: "should never land anywhere", skillIds: [], attachments: [],
                    agentContext: nil, model: nil, provider: nil,
                    expectedSessionID: expectedSessionID,
                    onProgress: { _ in })
                Issue.record("Expected ExternalTurnError.sessionMoved to be thrown")
            } catch is ExternalTurnError {
                // expected
            } catch {
                Issue.record("Expected ExternalTurnError, got \(error)")
            }

            // The guard fires before any state mutation — the stray message
            // landed in NEITHER session, on disk or in memory.
            #expect(engine.messages.isEmpty)
            #expect(ChatSessionStore.load(id: sessionA.id)?.messages.isEmpty == true)
            #expect(ChatSessionStore.load(id: sessionB.id)?.messages.isEmpty == true)
        }
    }

    @Test("A freshly-constructed engine's packHistory defaults to the budget-aware historyForRequest, not the bare wire encoder")
    func packHistoryDefaultsToBudgetAwareHistoryForRequest() {
        // No `wireEngine()`-style wiring at all — pins that ChatEngine.init
        // itself (not a caller) is what makes this budget-aware now (code
        // review, Task 12): any engine nobody has wired — an off-screen
        // mobile-bridge engine, or the registry's cached engine before its
        // panel has ever appeared — must still clip an oversized turn.
        let (engine, _) = makeEngine()
        let big = String(repeating: "a", count: ChatEngine.maxHistoryTurnChars + 500)
        let oversized = ChatMessage(wireTurn: .init(role: .user, content: big), sessionDate: Date())

        let packed = engine.packHistory([oversized])
        #expect(packed.first?.content.hasSuffix("…(turn clipped)") == true)
        #expect(packed.first?.content.count == ChatEngine.maxHistoryTurnChars + "\n…(turn clipped)".count)
        // Exactly matches calling the budgeted packer directly — proving the
        // default isn't a coincidentally-similar bare encoder.
        #expect(packed.map(\.content) == engine.historyForRequest([oversized]).map(\.content))
    }

    @Test("runExternalTurn suppresses continueNeeded — no autonomous follow-up is scheduled, even when the transport asks for one")
    func continueNeededIsSuppressedForExternalTurns() async {
        await withTempStore {
            let (engine, t) = makeEngine()
            let session = ChatSession(scope: Self.scope, title: "New chat")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()
            // 0-delay so a scheduled continue (if one were wrongly fired)
            // would land on the next main-queue drain, not 0.8 real seconds
            // from now — same trick `ChatEngineSessionTests.epochBump` uses.
            engine.continueDelayNanos = 0

            t.result = .init(reply: "working on it", pendingTool: nil, tasks: nil,
                             continueNeeded: true, usage: nil, mode: nil)
            _ = try? await engine.runExternalTurn(
                message: "kick off", skillIds: [], attachments: [],
                agentContext: nil, model: nil, provider: nil,
                expectedSessionID: session.id,
                onProgress: { _ in })

            #expect(engine.agent.agentIsAutonomous == false)

            // Give the (would-be) 0-delay asyncAfter closure a chance to run,
            // then confirm no "Continue working…" turn was ever appended —
            // a phone-driven turn must never silently re-enter runTurn with
            // the engine's default (unwired, off-screen-unsafe) hooks.
            try? await Task.sleep(nanoseconds: 50_000_000)
            #expect(engine.messages.map(\.content).contains("Continue working on your pending tasks.") == false)
            #expect(engine.busy == false)
        }
    }

    @Test("runExternalTurn never auto-chains a proposed tool — the card is left for a Mac panel to confirm")
    func autoChainIsSuppressedForExternalTurns() async throws {
        try await withTempStore {
            let (engine, t) = makeEngine()
            let session = ChatSession(scope: Self.scope, title: "New chat")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()

            // The agent proposes a bash command with this turn.
            t.result = .init(reply: "proposing a command",
                             pendingTool: PendingTool(name: "bash", arguments: .init(raw: Data(#"{"command":"ls"}"#.utf8))),
                             tasks: nil, continueNeeded: nil, usage: nil, mode: nil)

            // Wired so the test can prove the panel's Bypass/Auto chaining
            // would NOT fire for this phone-driven turn.
            var autoChainCalls = 0
            engine.autoChain = { _, _ in autoChainCalls += 1 }

            _ = try await engine.runExternalTurn(
                message: "run ls", skillIds: [], attachments: [],
                agentContext: nil, model: nil, provider: nil,
                expectedSessionID: session.id,
                onProgress: { _ in })

            #expect(autoChainCalls == 0)
            // The proposal survives on the engine instead — the pendingTool
            // a Mac panel renders as a confirmation card, never a silent
            // execution from a surface that can't confirm it.
            #expect(engine.agent.pendingTool?.name == "bash")
        }
    }

    @Test("A mid-flight session switch on the shared engine leaves the newly-active session untouched, and the call returns gracefully")
    func midFlightSessionSwitchDoesNotCorruptTheNewSession() async {
        await withTempStore {
            let transport = SuspendableChatTransport()
            let engine = ChatEngine(scope: Self.scope, transport: transport)
            let sessionA = ChatSession(scope: Self.scope, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(
                scope: Self.scope, title: "B",
                messages: [ChatMessage(wireTurn: .init(role: .user, content: "B's own turn"), sessionDate: Date())])
            ChatSessionStore.save(sessionB)

            engine.switchSession(to: sessionA.id)
            #expect(engine.currentSessionIDString == sessionA.id.uuidString)

            // Wired so the test can prove it does NOT fire against B.
            var autoChainCalls = 0
            engine.autoChain = { _, _ in autoChainCalls += 1 }

            // 1. The phone's turn starts on A — passes the entry guard,
            // appends+persists the user turn, busy = true — then suspends
            // inside the transport call, simulating the multi-second
            // /code-assist round trip code review flagged.
            let turnTask = Task {
                try? await engine.runExternalTurn(
                    message: "from iPhone", skillIds: [], attachments: [],
                    agentContext: nil, model: nil, provider: nil,
                    expectedSessionID: sessionA.id,
                    onProgress: { _ in })
            }
            try? await Task.sleep(nanoseconds: 30_000_000)
            #expect(engine.busy == true)
            #expect(engine.currentSessionIDString == sessionA.id.uuidString)

            // 2. WHILE the round trip is in flight, the Mac user clicks a
            // different chat — exactly what `ChatSessionHeader`'s switch
            // action does: `switchSession(to:)`, no busy check.
            engine.switchSession(to: sessionB.id)
            #expect(engine.currentSessionIDString == sessionB.id.uuidString)
            // resetActiveTurnState() clears busy — the phone's turn is never
            // cancelled (runExternalTurn never registers a runTask), it's
            // just no longer reflected in `busy`.
            #expect(engine.busy == false)
            let bMessagesBeforeResolve = engine.messages

            // 3. The round trip finally resolves.
            transport.resume()
            await turnTask.value

            // The call returned gracefully (no crash, no error escaping the
            // Task). Session B — now active — is COMPLETELY untouched: no
            // stray append, no auto-chain execution, identical messages in
            // memory and on disk.
            #expect(engine.currentSessionIDString == sessionB.id.uuidString)
            #expect(engine.messages.map(\.id) == bMessagesBeforeResolve.map(\.id))
            #expect(engine.messages.map(\.content) == ["B's own turn"])
            #expect(autoChainCalls == 0)
            let bOnDisk = ChatSessionStore.load(id: sessionB.id)
            #expect(bOnDisk?.messages.map(\.content) == ["B's own turn"])

            // Session A keeps whatever `resetActiveTurnState` already
            // finalized it to when the Mac switched away (the user turn,
            // plus an empty `.stopped` placeholder) — a best-effort
            // tradeoff, not the full reply. The point pinned here is that it
            // is NOT silently overwritten with B's content, or anything else
            // from the orphaned round trip.
            let aOnDisk = ChatSessionStore.load(id: sessionA.id)
            #expect(aOnDisk?.messages.map(\.content).first == "from iPhone")
            #expect(aOnDisk?.messages.contains { $0.content == "B's own turn" } == false)
        }
    }

    @Test("Deleting the session MID external turn never resurrects it — the orphaned round trip must not re-persist")
    func deleteDuringExternalTurnDoesNotResurrect() async {
        await withTempStore {
            let transport = SuspendableChatTransport()
            let engine = ChatEngine(scope: Self.scope, transport: transport)
            let sessionA = ChatSession(scope: Self.scope, title: "A")
            ChatSessionStore.save(sessionA)

            engine.switchSession(to: sessionA.id)
            #expect(engine.currentSessionIDString == sessionA.id.uuidString)

            // 1. The phone's turn starts on A — passes the entry guard,
            // appends+persists the user turn, busy = true — then suspends
            // inside the transport call.
            let turnTask = Task {
                try? await engine.runExternalTurn(
                    message: "from iPhone", skillIds: [], attachments: [],
                    agentContext: nil, model: nil, provider: nil,
                    expectedSessionID: sessionA.id,
                    onProgress: { _ in })
            }
            try? await Task.sleep(nanoseconds: 30_000_000)
            #expect(engine.busy == true)

            // 2. The phone deletes the very chat its turn is running in,
            // routed the way `handleExploreDelete` routes it: through the
            // engine, NOT a raw store delete. resetActiveTurnState finalizes
            // the in-flight placeholder, the file is deleted, and
            // mintFreshSession moves the engine OFF the deleted id — which is
            // what makes the orphaned round trip's guards bail instead of
            // re-persisting. Also pins the session-memory forget firing.
            var forgotten: [String] = []
            engine.forgetSessionMemory = { forgotten.append($0) }
            await engine.deleteSession(sessionA.id)
            #expect(engine.currentSessionIDString != sessionA.id.uuidString)
            #expect(forgotten == [sessionA.id.uuidString])

            // 3. The round trip resolves after the delete. Both the success
            // and catch paths re-check expectedSessionID; with the engine
            // moved off A, neither may persist into it.
            transport.resume()
            let _: String? = await turnTask.value

            // The file stays deleted. persistCurrentChat's load-nil fallback
            // (`?? ChatSession(id:scope:)`, id preserved) is exactly the
            // resurrection vector a raw store delete used to trigger — the
            // old explore_delete_session behavior.
            #expect(ChatSessionStore.load(id: sessionA.id) == nil)
            #expect(engine.busy == false)
        }
    }
}

/// A `ChatTransport` whose `roundTrip` suspends until `resume()` is called —
/// for reproducing the mid-round-trip session-switch race
/// `runExternalTurn`'s post-await `expectedSessionID` re-check guards
/// against: the engine's active session changes while the transport call is
/// still suspended. Same shape as `AgentAskTransportTests.swift`'s
/// `SuspendableHistoryFetcher`, adapted to `ChatTransport`'s signature.
@MainActor
final class SuspendableChatTransport: ChatTransport, @unchecked Sendable {
    var result = ChatTransportResult(reply: "the answer", pendingTool: nil, tasks: nil,
                                     continueNeeded: nil, usage: nil, mode: nil)
    var thrownError: Error?
    private var continuation: CheckedContinuation<Void, Never>?

    func resume() {
        continuation?.resume()
        continuation = nil
    }

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        await withCheckedContinuation { self.continuation = $0 }
        if let thrownError { throw thrownError }
        return result
    }
}

/// `ExplorerMobileEngineResolver` — the fix for the bug spec review caught
/// in Task 12's first pass: `handleExploreChat` used to call
/// `switchSession(to:)` unconditionally on the SHARED `.explorer` engine, so
/// a phone request for a session the Mac panel wasn't currently showing
/// would silently cancel the Mac user's in-flight turn and swap their
/// visible screen to an unrelated chat. These pin that the shared engine's
/// visible state (`messages`/`currentSessionIDString`/`busy`) is untouched
/// whenever it's already showing something else, and that off-screen
/// sessions still resolve to a working (cached, reusable) engine instead of
/// being rejected outright.
@MainActor
@Suite("ExplorerMobileEngineResolver", .serialized)
struct ExplorerMobileEngineResolverTests {
    func withTempStore(_ body: () async -> Void) async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-engine-resolver-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        await body()
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    @Test("A request for a DIFFERENT session never touches the shared engine's visible state, even mid-turn")
    func doesNotHijackActiveSession() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let sessionA = ChatSession(
                scope: .explorer, title: "A",
                messages: [ChatMessage(wireTurn: .init(role: .user, content: "on Mac"), sessionDate: Date())])
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: .explorer, title: "B")
            ChatSessionStore.save(sessionB)

            shared.switchSession(to: sessionA.id)
            #expect(shared.currentSessionIDString == sessionA.id.uuidString)
            // Simulate the Mac user's own turn actively in flight — the
            // exact state a naive `switchSession` would have force-cancelled.
            shared.beginPanelRun()
            #expect(shared.busy == true)
            let messagesBefore = shared.messages

            let resolver = ExplorerMobileEngineResolver()
            let resolved = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)

            // A DIFFERENT engine is handed back — never the live one — since
            // the shared engine is already showing (and busy on) session A.
            #expect(resolved !== shared)
            #expect(resolved?.currentSessionIDString == sessionB.id.uuidString)

            // The Mac's visible state is completely untouched: still on A,
            // still busy, identical messages.
            #expect(shared.currentSessionIDString == sessionA.id.uuidString)
            #expect(shared.busy == true)
            #expect(shared.messages.map(\.id) == messagesBefore.map(\.id))
            #expect(shared.messages.map(\.content) == ["on Mac"])
        }
    }

    @Test("The same off-screen session id resolves to the SAME cached engine across calls")
    func offScreenEngineIsCachedPerSession() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let sessionA = ChatSession(scope: .explorer, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: .explorer, title: "B")
            ChatSessionStore.save(sessionB)
            shared.switchSession(to: sessionA.id)

            let resolver = ExplorerMobileEngineResolver()
            let first = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            let second = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            #expect(first != nil)
            #expect(first === second)
            // Still hasn't touched the shared engine.
            #expect(shared.currentSessionIDString == sessionA.id.uuidString)
        }
    }

    @Test("cachedEngine(for:) is side-effect free — no creation, no disk refresh, and forget drops it")
    func cachedEngineAccessorDoesNotCreateOrRefresh() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let sessionA = ChatSession(scope: .explorer, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: .explorer, title: "B")
            ChatSessionStore.save(sessionB)
            shared.switchSession(to: sessionA.id)

            let resolver = ExplorerMobileEngineResolver()
            // Nothing cached for a random id — and crucially no engine is
            // CREATED for it (the full engine(for:) lookup would return one).
            #expect(resolver.cachedEngine(for: UUID()) == nil)

            #expect(resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api) != nil)

            // A disk write the full lookup would refresh on next resolve is
            // NOT visible through cachedEngine — it returns the cached
            // instance exactly as it is.
            var updated = sessionB
            updated.messages = [ChatMessage(wireTurn: .init(role: .user, content: "Mac-side turn"), sessionDate: Date())]
            ChatSessionStore.save(updated)
            let cached = resolver.cachedEngine(for: sessionB.id)
            #expect(cached?.messages.isEmpty == true)
            // The full lookup DOES refresh from disk.
            #expect(resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)?
                .messages.map(\.content) == ["Mac-side turn"])
            // Same instance either way — the accessor never rebuilds.
            #expect(cached === resolver.cachedEngine(for: sessionB.id))

            resolver.forget(sessionID: sessionB.id)
            #expect(resolver.cachedEngine(for: sessionB.id) == nil)
        }
    }

    @Test("An idle, unclaimed shared engine is safely claimed directly — nothing is visibly displayed yet")
    func claimsIdleUnclaimedSharedEngine() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            #expect(shared.currentSessionIDString.isEmpty)
            let session = ChatSession(scope: .explorer, title: "Fresh")
            ChatSessionStore.save(session)

            let resolver = ExplorerMobileEngineResolver()
            let resolved = resolver.engine(for: session.id, sharedExplorerEngine: shared, api: api)

            // Safe to claim directly: no Mac panel has shown anything on
            // this engine yet, so there is nothing to hijack.
            #expect(resolved === shared)
            #expect(shared.currentSessionIDString == session.id.uuidString)
        }
    }

    @Test("Once the shared engine is already showing the requested session, it's used directly")
    func usesSharedEngineWhenAlreadyOnRequestedSession() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let session = ChatSession(scope: .explorer, title: "Same")
            ChatSessionStore.save(session)
            shared.switchSession(to: session.id)

            let resolver = ExplorerMobileEngineResolver()
            let resolved = resolver.engine(for: session.id, sharedExplorerEngine: shared, api: api)
            #expect(resolved === shared)
        }
    }

    @Test("forget(sessionID:) drops the off-screen cache entry")
    func forgetDropsCachedEngine() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let sessionA = ChatSession(scope: .explorer, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: .explorer, title: "B")
            ChatSessionStore.save(sessionB)
            shared.switchSession(to: sessionA.id)

            let resolver = ExplorerMobileEngineResolver()
            let first = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            #expect(first != nil)

            resolver.forget(sessionID: sessionB.id)
            ChatSessionStore.delete(id: sessionB.id)
            // No cache hit now, and the session is genuinely gone — resolving
            // again correctly fails instead of returning a stale engine.
            let afterForget = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            #expect(afterForget == nil)
        }
    }

    @Test("A stale off-screen cache entry is refreshed from disk before reuse — no data loss when the Mac later owns the session")
    func staleOffScreenEntryRefreshesFromDiskAndDoesNotLoseData() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let sessionA = ChatSession(scope: .explorer, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: .explorer, title: "B")
            ChatSessionStore.save(sessionB)
            let sessionC = ChatSession(scope: .explorer, title: "C")
            ChatSessionStore.save(sessionC)

            shared.switchSession(to: sessionA.id)
            let resolver = ExplorerMobileEngineResolver()

            // 1. Phone opens session B while the Mac is on A — caches an
            // off-screen engine for B (empty, matching disk at this point).
            let firstResolve = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            #expect(firstResolve != nil)
            #expect(firstResolve?.messages.isEmpty == true)

            // 2. The Mac user switches the SHARED engine to B directly and
            // appends a turn — persisted through the shared engine, entirely
            // independent of the cached off-screen instance from step 1.
            shared.switchSession(to: sessionB.id)
            shared.replaceMessages([ChatMessage(wireTurn: .init(role: .user, content: "from Mac"),
                                                sessionDate: Date())])
            shared.persistCurrentChat()

            // 3. The Mac user switches away to C.
            shared.switchSession(to: sessionC.id)
            #expect(shared.currentSessionIDString == sessionC.id.uuidString)

            // 4. The phone hits session B again. The stale cached engine from
            // step 1 must NOT be served as-is — it must be refreshed from
            // disk first, so the phone (and any turn it appends) sees the
            // Mac's newer content instead of silently overwriting it.
            let secondResolve = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            #expect(secondResolve != nil)
            #expect(secondResolve?.messages.map(\.content) == ["from Mac"])
            // It's still the SAME cached instance (refreshed in place), not a
            // brand-new one — the whole point of the off-screen cache.
            #expect(secondResolve === firstResolve)

            // And the shared engine (now showing C) is untouched by this.
            #expect(shared.currentSessionIDString == sessionC.id.uuidString)
        }
    }

    @Test("A BUSY off-screen cache entry is returned as-is, not refreshed mid-turn")
    func busyOffScreenEntryIsNotRefreshed() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let sessionA = ChatSession(scope: .explorer, title: "A")
            ChatSessionStore.save(sessionA)
            let sessionB = ChatSession(scope: .explorer, title: "B")
            ChatSessionStore.save(sessionB)
            shared.switchSession(to: sessionA.id)

            let resolver = ExplorerMobileEngineResolver()
            guard let cached = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api) else {
                Issue.record("expected an off-screen engine for session B")
                return
            }
            // Simulate a phone turn mid-flight on the cached engine, with
            // in-memory content that hasn't been persisted yet.
            cached.beginPanelRun()
            cached.replaceMessages([ChatMessage(wireTurn: .init(role: .user, content: "mid-turn draft"),
                                                sessionDate: Date())])
            #expect(cached.busy == true)

            let resolvedWhileBusy = resolver.engine(for: sessionB.id, sharedExplorerEngine: shared, api: api)
            // Same instance, untouched — NOT reloaded from (stale-relative-
            // to-memory) disk while a turn is in flight.
            #expect(resolvedWhileBusy === cached)
            #expect(resolvedWhileBusy?.messages.map(\.content) == ["mid-turn draft"])
        }
    }
}
