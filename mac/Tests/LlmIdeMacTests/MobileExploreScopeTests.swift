import Testing
import Foundation
@testable import LlmIdeMacLib

/// The phone's `explore_*` handlers take a bare session UUID. Only Explorer
/// chats may be reachable that way — not the quick chat or another scope's.
@MainActor
@Suite("Mobile explore scope guard", .serialized)
struct MobileExploreScopeTests {
    func withTempStore(_ body: () async -> Void) async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("mobile-explore-scope-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        await body()
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    @Test("Loading by id returns Explorer chats only")
    func loadIsScoped() async {
        await withTempStore {
            let explorer = ChatSession(scope: .explorer, title: "E")
            let quick = ChatSession(scope: .quick, title: "Q")
            ChatSessionStore.save(explorer)
            ChatSessionStore.save(quick)
            #expect(MobileControlManager.loadExplorerSession(id: explorer.id)?.id == explorer.id)
            #expect(MobileControlManager.loadExplorerSession(id: quick.id) == nil)
            #expect(ChatSessionStore.load(id: quick.id) != nil)
        }
    }

    @Test("Deleting by id refuses a non-Explorer session and deletes an Explorer one")
    func deleteIsScoped() async {
        await withTempStore {
            let explorer = ChatSession(scope: .explorer, title: "E")
            let quick = ChatSession(scope: .quick, title: "Q")
            ChatSessionStore.save(explorer)
            ChatSessionStore.save(quick)
            let manager = MobileControlManager()
            await manager.handleExploreDelete(quick.id)
            #expect(ChatSessionStore.load(id: quick.id) != nil, "the quick chat must survive a phone delete")
            await manager.handleExploreDelete(explorer.id)
            #expect(ChatSessionStore.load(id: explorer.id) == nil)
        }
    }
}
