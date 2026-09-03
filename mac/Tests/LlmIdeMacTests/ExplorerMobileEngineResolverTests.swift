import Testing
import Foundation
@testable import LlmIdeMacLib

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

    @Test("The off-screen cache is capped — oldest entries evicted past the limit")
    func offScreenCacheIsCapped() async {
        await withTempStore {
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shared = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            let home = ChatSession(scope: .explorer, title: "home")
            ChatSessionStore.save(home)
            shared.switchSession(to: home.id)

            let resolver = ExplorerMobileEngineResolver()
            // One more than the cap, opened oldest-first.
            let ids = (0...(ExplorerMobileEngineResolver.offScreenCacheLimit + 1)).map { _ in
                let s = ChatSession(scope: .explorer, title: "B")
                ChatSessionStore.save(s)
                return s.id
            }
            for id in ids {
                #expect(resolver.engine(for: id, sharedExplorerEngine: shared, api: api) != nil)
            }

            // The two oldest were evicted; the newest cap-worth remain.
            #expect(resolver.cachedEngine(for: ids[0]) == nil)
            #expect(resolver.cachedEngine(for: ids[1]) == nil)
            for id in ids.suffix(ExplorerMobileEngineResolver.offScreenCacheLimit) {
                #expect(resolver.cachedEngine(for: id) != nil)
            }

            // Re-touching an evicted-id's NEIGHBOUR keeps it alive while
            // opening one more session evicts the next-oldest instead.
            let fresh = ChatSession(scope: .explorer, title: "fresh")
            ChatSessionStore.save(fresh)
            _ = resolver.engine(for: ids[2], sharedExplorerEngine: shared, api: api)  // touch: ids[2] is now MRU
            _ = resolver.engine(for: fresh.id, sharedExplorerEngine: shared, api: api)
            #expect(resolver.cachedEngine(for: ids[2]) != nil)  // touched → survived
            #expect(resolver.cachedEngine(for: ids[3]) == nil)  // next-oldest went instead
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
