import Testing
import Foundation
@testable import LlmIdeMacLib

/// Explorer chats are scoped to the active project (`ChatEngine.explorerProjectId`).
///
/// Regression (2026-09 review): Explorer sessions were never stamped with a
/// project and nothing filtered them, so project A's chats listed — and
/// resumed, with project B's code as the agent context — while B was open,
/// on the Mac and on the phone alike.
@MainActor
@Suite("Explorer project scope", .serialized)
struct ExplorerProjectScopeTests {
    static let legacyPointerKey = "chat.current.explorer"

    func withTempStore(_ body: () async -> Void) async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-project-scope-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        let savedLegacyPointer = UserDefaults.standard.string(forKey: Self.legacyPointerKey)
        await body()
        if let savedLegacyPointer {
            UserDefaults.standard.set(savedLegacyPointer, forKey: Self.legacyPointerKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.legacyPointerKey)
        }
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    private func engine(project: String?) -> ChatEngine {
        let e = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        e.explorerProjectId = project
        return e
    }

    private func cleanPointer(_ project: String) {
        UserDefaults.standard.removeObject(forKey: "chat.current.explorer.\(project)")
    }

    @Test("A new Explorer chat is stamped with the active project")
    func mintStampsProject() async {
        await withTempStore {
            let p = "proj-\(UUID().uuidString)"
            defer { cleanPointer(p) }
            let e = engine(project: p)
            e.mintFreshSession()
            let id = UUID(uuidString: e.currentSessionIDString)!
            #expect(ChatSessionStore.load(id: id)?.projectId == p)
        }
    }

    @Test("The list shows this project's chats and unassigned ones, never another project's")
    func listIsProjectScoped() async {
        await withTempStore {
            let p = "proj-\(UUID().uuidString)", q = "proj-\(UUID().uuidString)"
            let mine = ChatSession(scope: .explorer, title: "mine", projectId: p)
            let legacy = ChatSession(scope: .explorer, title: "legacy")
            let theirs = ChatSession(scope: .explorer, title: "theirs", projectId: q)
            for s in [mine, legacy, theirs] { ChatSessionStore.save(s) }

            let e = engine(project: p)
            e.refreshSessions()
            #expect(Set(e.sessions.map(\.id)) == [mine.id, legacy.id])

            // No project open: unscoped, as before.
            #expect(ChatSessionStore.list(for: .explorer, visibleInProject: nil).count == 3)
        }
    }

    @Test("A remembered chat from another project is not resumed")
    func pointerToOtherProjectIsRejected() async {
        await withTempStore {
            let p = "proj-\(UUID().uuidString)", q = "proj-\(UUID().uuidString)"
            defer { cleanPointer(p) }
            let mine = ChatSession(scope: .explorer, title: "mine", projectId: p)
            let theirs = ChatSession(scope: .explorer, title: "theirs", projectId: q)
            ChatSessionStore.save(mine)
            ChatSessionStore.save(theirs)
            // The pre-per-project global pointer still names Q's chat.
            UserDefaults.standard.set(theirs.id.uuidString, forKey: Self.legacyPointerKey)

            let e = engine(project: p)
            _ = e.handleOnAppearSessions()
            #expect(e.currentSessionIDString == mine.id.uuidString)
        }
    }

    @Test("Saving an unassigned chat claims it for the project; an assigned one keeps its project")
    func persistClaimsUnassigned() async {
        await withTempStore {
            let p = "proj-\(UUID().uuidString)"
            defer { cleanPointer(p) }
            let legacy = ChatSession(scope: .explorer, title: "legacy")
            ChatSessionStore.save(legacy)
            let e = engine(project: p)
            e.switchSession(to: legacy.id)
            // Just opening it (the load's own persist) must NOT claim it —
            // that made every project switch move an old chat into whichever
            // project was open.
            e.persistCurrentChat()
            #expect(ChatSessionStore.load(id: legacy.id)?.projectId == nil)
            // Working in it does.
            e.messages.append(ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date()))
            e.persistCurrentChat()
            #expect(ChatSessionStore.load(id: legacy.id)?.projectId == p)
        }
    }

    @Test("After a project switch or a delete, this project's own chat is preferred over an unassigned one")
    func ownChatPreferred() async {
        await withTempStore {
            let p = "proj-\(UUID().uuidString)"
            defer { cleanPointer(p) }
            let own = ChatSession(scope: .explorer, title: "own", lastUsedAt: Date(timeIntervalSinceNow: -60), projectId: p)
            let legacy = ChatSession(scope: .explorer, title: "legacy", lastUsedAt: Date())
            ChatSessionStore.save(own)
            ChatSessionStore.save(legacy)
            let e = engine(project: p)
            e.refreshSessions()
            #expect(e.preferredSessionForCurrentProject() == own.id)
        }
    }

    @Test("A new chat opened while a turn runs is stamped with the project too")
    func registryHandsProjectToNewChat() async {
        await withTempStore {
            let p = "proj-\(UUID().uuidString)"
            defer { cleanPointer(p) }
            let blocking = BlockingChatTransport()
            let registry = ChatEngineRegistry(engineFactory: { scope in
                let engine = ChatEngine(scope: scope, transport: blocking)
                engine.hooks.resolveTransportInput = { msg, history, _, skills in
                    ChatTransportInput(message: msg, history: history, attachments: [],
                                       skills: skills, agentContext: nil, language: "en",
                                       model: nil, provider: nil, mode: "auto")
                }
                return engine
            })
            let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
            let shown = registry.engine(for: .explorer, api: api)
            shown.explorerProjectId = p
            shown.mintFreshSession()
            shown.startTurn("busy")
            await Task.yield()
            try? await Task.sleep(nanoseconds: 30_000_000)

            // Busy, so the registry parks it and builds a FRESH engine.
            let next = registry.newDisplayedSession(scope: .explorer, api: api)
            #expect(next !== shown)
            #expect(next.explorerProjectId == p)
            let id = UUID(uuidString: next.currentSessionIDString)
            #expect(id != nil)
            #expect(id.flatMap { ChatSessionStore.load(id: $0) }?.projectId == p)
            blocking.finish()
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
    }
}
