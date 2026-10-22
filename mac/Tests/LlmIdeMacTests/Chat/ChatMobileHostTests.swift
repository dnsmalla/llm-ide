import Testing
import Foundation
@testable import LlmIdeMacLib

/// `ChatMobileHost` is Chat's side of `MobileChatHosting`, the seam Mobile
/// Control reaches Chat through. These pin the mappings the phone frames are
/// built from — they must stay byte-identical to what the manager produced
/// when it read `ChatSessionStore`/`ChatEngine` directly — and the scope and
/// project guards on every phone-supplied session id.
///
/// Names no MobileControl type, so it runs with `mobile_sync` off too.
@MainActor
@Suite("ChatMobileHost", .serialized)
struct ChatMobileHostTests {
    func withTempStore(_ body: () async -> Void) async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-mobile-host-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        await body()
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    @Test("Session list holds visible Explorer chats only")
    func listIsScoped() async {
        await withTempStore {
            let mine = ChatSession(scope: .explorer, title: "Mine", projectId: "p1")
            let unassigned = ChatSession(scope: .explorer, title: "Loose")
            let other = ChatSession(scope: .explorer, title: "Other", projectId: "p2")
            let quick = ChatSession(scope: .quick, title: "Q", projectId: "p1")
            for session in [mine, unassigned, other, quick] { ChatSessionStore.save(session) }
            let host = ChatMobileHost()
            let ids = Set(host.explorerSessions(visibleInProject: "p1").map(\.id))
            #expect(ids == [mine.id, unassigned.id])
        }
    }

    @Test("Loaded history uses the wire shape the phone always received")
    func historyUsesWireTurns() async {
        await withTempStore {
            let stopped = ChatMessage(role: .assistant, content: "partial", status: .stopped, createdAt: Date())
            let user = ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date())
            let session = ChatSession(scope: .explorer, title: "E", messages: [user, stopped])
            ChatSessionStore.save(session)
            let history = ChatMobileHost().explorerSession(id: session.id, visibleInProject: nil)
            #expect(history?.title == "E")
            #expect(history?.lines == [
                MobileChatLine(role: "user", content: "hi"),
                MobileChatLine(role: "assistant", content: "partial\n\n_(stopped)_"),
            ])
        }
    }

    @Test("Rename and delete refuse another scope's or project's session")
    func editsAreScoped() async {
        await withTempStore {
            let quick = ChatSession(scope: .quick, title: "Q")
            let other = ChatSession(scope: .explorer, title: "Other", projectId: "p2")
            ChatSessionStore.save(quick)
            ChatSessionStore.save(other)
            let host = ChatMobileHost()
            #expect(host.renameExplorerSession(id: quick.id, visibleInProject: nil, title: "x") == nil)
            #expect(ChatSessionStore.load(id: quick.id)?.title == "Q")
            #expect(await host.deleteExplorerSession(id: quick.id, visibleInProject: nil, api: nil) == .notExplorer)
            #expect(await host.deleteExplorerSession(id: other.id, visibleInProject: "p1", api: nil) == .otherProject)
            #expect(ChatSessionStore.load(id: other.id) != nil)
        }
    }

    @Test("Create, rename and delete an Explorer chat")
    func createRenameDelete() async {
        await withTempStore {
            let host = ChatMobileHost()
            let id = host.createExplorerSession(projectId: "p1")
            #expect(ChatSessionStore.load(id: id)?.scope == .explorer)
            #expect(host.renameExplorerSession(id: id, visibleInProject: "p1", title: "Renamed") == "Renamed")
            #expect(await host.deleteExplorerSession(id: id, visibleInProject: "p1", api: nil) == .deleted)
            #expect(ChatSessionStore.load(id: id) == nil)
        }
    }

    @Test("Phone transcript drops tool rows and keeps raw content")
    func conversationLinesFilterToolRows() {
        let engine = ChatEngine(scope: .quick, transport: ScriptedChatTransport())
        engine.messages = [
            ChatMessage(role: .user, content: "q", status: .done, createdAt: Date()),
            ChatMessage(role: .toolResult, content: "tool", status: .done, createdAt: Date()),
            ChatMessage(role: .assistant, content: "a", status: .stopped, createdAt: Date()),
        ]
        #expect(engine.conversationLines == [
            MobileChatLine(role: "user", content: "q"),
            MobileChatLine(role: "assistant", content: "a"),
        ])
    }
}
