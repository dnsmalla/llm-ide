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
    /// `body`, then restore it.
    func withTempStore(_ body: () async -> Void) async {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-engine-external-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        await body()
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    @Test("Appends user+assistant turns, forwards scripted progress, persists to disk, and is visible with no reload")
    func appendsAndPersistsAndStreams() async throws {
        await withTempStore {
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
