import Testing
import Foundation
@testable import LlmIdeMacLib

/// A transport whose round trip does not return until the test releases it,
/// so a `ChatEngine` can be observed genuinely mid-turn. `ScriptedChatTransport`
/// completes synchronously, which is exactly wrong for testing what happens
/// to a turn that is still running when the user switches chats.
@MainActor
final class BlockingChatTransport: ChatTransport, @unchecked Sendable {
    private var resume: CheckedContinuation<Void, Never>?
    private(set) var started = false
    var reply = "background answer"

    func roundTrip(_ input: ChatTransportInput,
                   onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
                   onChunk: @escaping @MainActor (String) -> Void) async throws -> ChatTransportResult {
        started = true
        onChunk(reply)
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            self.resume = c
        }
        try Task.checkCancellation()
        return ChatTransportResult(reply: reply, pendingTool: nil, tasks: nil,
                                   continueNeeded: nil, usage: nil, mode: nil)
    }

    /// Let the parked turn finish.
    func finish() {
        resume?.resume()
        resume = nil
    }
}

/// Switching chats used to cancel whatever the outgoing chat was doing:
/// `ChatEngine.switchSession(to:)` opens with `resetActiveTurnState()`, which
/// cancels `runTask` and finalizes the in-flight reply as `.stopped`. With one
/// engine per scope that is unavoidable — the engine's `messages` array is
/// about to be replaced with another chat's history — so the fix is to stop
/// reusing that one engine for a switch away from a running chat.
///
/// These pin the behaviour `ChatEngineRegistry` now provides: the running
/// chat is parked and keeps going, an idle switch costs nothing extra, a
/// backgrounded turn reaches disk with no view observing it, and no session
/// ever ends up with two live engines writing it.
///
/// `.serialized` + `ChatStoreOverrideGate`: every test drives the
/// process-global `ChatSessionStore.baseDirectoryOverride`.
@MainActor
@Suite("Background chat sessions", .serialized)
struct ChatEngineBackgroundSessionTests {
    static let scope: ChatScope = .explorer
    static var pointerKey: String { "chat.current.\(scope.rawValue)" }
    /// Unused by the isolated registry (its `engineFactory` builds every
    /// engine), but the signature still asks for one.
    static let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")

    func withTempStore(_ body: () async -> Void) async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-bg-session-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        UserDefaults.standard.removeObject(forKey: Self.pointerKey)
        await body()
        UserDefaults.standard.removeObject(forKey: Self.pointerKey)
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    /// A registry whose engines all run on `transport`, plus two saved
    /// sessions to switch between.
    func makeFixture(transport: ChatTransport) -> (ChatEngineRegistry, UUID, UUID) {
        let registry = ChatEngineRegistry(engineFactory: { scope in
            let engine = ChatEngine(scope: scope, transport: transport)
            engine.resolveTransportInput = { msg, history, _, skills in
                ChatTransportInput(message: msg, history: history, attachments: [],
                                   skills: skills, agentContext: nil, language: "en",
                                   model: nil, provider: nil, mode: "auto")
            }
            return engine
        })
        let a = ChatSession(scope: Self.scope)
        let b = ChatSession(scope: Self.scope)
        ChatSessionStore.save(a)
        ChatSessionStore.save(b)
        return (registry, a.id, b.id)
    }

    /// Spin the main queue so a `Task`-wrapped turn actually starts.
    func settle() async {
        await Task.yield()
        try? await Task.sleep(nanoseconds: 30_000_000)
    }

    @Test("Switching away from a running chat keeps its turn alive on a parked engine")
    func switchingAwayParksTheRunningTurn() async {
        await withTempStore {
            let blocking = BlockingChatTransport()
            let (registry, a, b) = makeFixture(transport: blocking)

            let engineA = registry.engine(for: Self.scope, api: Self.api)
            engineA.switchSession(to: a)
            engineA.startTurn("work on this for a while")
            await settle()
            #expect(engineA.busy)

            let engineB = registry.switchDisplayedSession(scope: Self.scope, to: b, api: Self.api)
            await settle()

            // The visible engine changed — the running one was NOT reused.
            #expect(engineB !== engineA)
            #expect(engineB.currentSessionIDString == b.uuidString)
            // …and the chat we switched away from is still working, with its
            // reply still streaming rather than finalized as `.stopped`.
            #expect(engineA.busy)
            #expect(engineA.messages.last?.status == .streaming)
            #expect(registry.isRunning(a))
            #expect(registry.backgroundRunningSessionIDs.contains(a))

            blocking.finish()
            await settle()
        }
    }

    @Test("Switching back hands the SAME still-running engine to the panel")
    func switchingBackReturnsTheParkedEngine() async {
        await withTempStore {
            let blocking = BlockingChatTransport()
            let (registry, a, b) = makeFixture(transport: blocking)

            let engineA = registry.engine(for: Self.scope, api: Self.api)
            engineA.switchSession(to: a)
            engineA.startTurn("long task")
            await settle()
            _ = registry.switchDisplayedSession(scope: Self.scope, to: b, api: Self.api)
            await settle()

            let backToA = registry.switchDisplayedSession(scope: Self.scope, to: a, api: Self.api)
            // Identity matters: a second engine loaded from disk would show a
            // pre-turn snapshot while the real one kept writing the file.
            #expect(backToA === engineA)
            #expect(backToA.busy)

            blocking.finish()
            await settle()
        }
    }

    @Test("An idle switch reuses the one displayed engine — no extra instance")
    func idleSwitchReusesTheDisplayedEngine() async {
        await withTempStore {
            let (registry, a, b) = makeFixture(transport: ScriptedChatTransport())
            let engine = registry.engine(for: Self.scope, api: Self.api)
            engine.switchSession(to: a)

            let after = registry.switchDisplayedSession(scope: Self.scope, to: b, api: Self.api)
            #expect(after === engine)
            #expect(after.currentSessionIDString == b.uuidString)
            #expect(registry.backgroundRunningSessionIDs.isEmpty)
        }
    }

    // Persistence normally rides the panel's `.onChange(of: engine.messages)`.
    // A parked engine has no panel, so without `persistsUnobserved` the whole
    // background turn would finish in memory and never reach disk — the reply
    // would be gone if the app quit before the user switched back.
    @Test("A backgrounded turn persists its reply with no view observing it")
    func backgroundTurnPersistsItself() async {
        await withTempStore {
            let blocking = BlockingChatTransport()
            let (registry, a, b) = makeFixture(transport: blocking)

            let engineA = registry.engine(for: Self.scope, api: Self.api)
            engineA.switchSession(to: a)
            engineA.startTurn("go")
            await settle()
            _ = registry.switchDisplayedSession(scope: Self.scope, to: b, api: Self.api)
            await settle()

            blocking.finish()
            await settle()

            let saved = ChatSessionStore.load(id: a)
            #expect(saved?.messages.last?.role == .assistant)
            #expect(saved?.messages.last?.content == blocking.reply)
        }
    }

    // "+ New chat" runs the same `resetActiveTurnState()` path switching did,
    // so it killed a running turn just as silently.
    @Test("Starting a new chat parks the running one instead of cancelling it")
    func newChatParksTheRunningTurn() async {
        await withTempStore {
            let blocking = BlockingChatTransport()
            let (registry, a, _) = makeFixture(transport: blocking)

            let engineA = registry.engine(for: Self.scope, api: Self.api)
            engineA.switchSession(to: a)
            engineA.startTurn("go")
            await settle()

            let fresh = registry.newDisplayedSession(scope: Self.scope, api: Self.api)
            await settle()

            #expect(fresh !== engineA)
            #expect(fresh.messages.isEmpty)
            #expect(engineA.busy)
            #expect(registry.liveEngine(for: a) === engineA)

            blocking.finish()
            await settle()
        }
    }

    @Test("Starting a new chat from an IDLE engine still reuses it")
    func newChatFromIdleReusesTheEngine() async {
        await withTempStore {
            let (registry, a, _) = makeFixture(transport: ScriptedChatTransport())
            let engine = registry.engine(for: Self.scope, api: Self.api)
            engine.switchSession(to: a)
            // A blank "New chat" is a no-op by design (createNewSession
            // refuses to stack empty chats), so give it real content first.
            engine.messages = [ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date())]
            engine.renameSession(a, to: "Something")

            let after = registry.newDisplayedSession(scope: Self.scope, api: Self.api)
            #expect(after === engine)
            #expect(registry.backgroundRunningSessionIDs.isEmpty)
        }
    }

    // The mobile bridge builds its OWN off-screen engines for sessions the Mac
    // isn't showing. A parked session is off-screen but very much alive, so it
    // has to be findable — two engines on one session file means the loser's
    // turns disappear on the winner's next persist.
    @Test("liveEngine finds a parked session so a second writer is never created")
    func liveEngineFindsParkedSessions() async {
        await withTempStore {
            let blocking = BlockingChatTransport()
            let (registry, a, b) = makeFixture(transport: blocking)

            let engineA = registry.engine(for: Self.scope, api: Self.api)
            engineA.switchSession(to: a)
            engineA.startTurn("go")
            await settle()
            let engineB = registry.switchDisplayedSession(scope: Self.scope, to: b, api: Self.api)
            await settle()

            #expect(registry.liveEngine(for: a) === engineA)   // parked
            #expect(registry.liveEngine(for: b) === engineB)   // displayed
            #expect(registry.liveEngine(for: UUID()) == nil)

            blocking.finish()
            await settle()
        }
    }

    // Deleting a chat that is still working has to stop it first: its
    // turn-end persist would otherwise write the session file straight back
    // after the delete removed it.
    @Test("discardBackground stops the parked turn so a delete can't be undone by it")
    func discardBackgroundStopsTheTurn() async {
        await withTempStore {
            let blocking = BlockingChatTransport()
            let (registry, a, b) = makeFixture(transport: blocking)

            let engineA = registry.engine(for: Self.scope, api: Self.api)
            engineA.switchSession(to: a)
            engineA.startTurn("go")
            await settle()
            _ = registry.switchDisplayedSession(scope: Self.scope, to: b, api: Self.api)
            await settle()

            registry.discardBackground(sessionID: a)
            blocking.finish()
            await settle()

            #expect(registry.liveEngine(for: a) == nil)
            #expect(registry.backgroundRunningSessionIDs.isEmpty)
        }
    }
}
