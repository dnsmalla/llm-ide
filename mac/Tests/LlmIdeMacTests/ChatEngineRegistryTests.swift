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
