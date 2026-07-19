import Testing
import Foundation
@testable import LlmIdeMac

@Suite("ChatSessionStore scope-keyed", .serialized)
struct ChatSessionStoreTests {

    /// Point the store at a throwaway "LLM IDE" dir for this test.
    private func overrideDir() {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("chatstore-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = dir
    }

    @Test func loadReturnsFreshWhenNoFile() {
        overrideDir()
        let session = ChatSessionStore.load(for: .explorer)
        #expect(session.history.isEmpty)
        #expect(session.title == "New chat")
    }

    @Test func saveRoundTripsHistory() {
        overrideDir()
        var session = ChatSessionStore.load(for: .visual)
        session.history = [.init(role: .user, content: "hello"),
                           .init(role: .assistant, content: "hi")]
        ChatSessionStore.save(session, for: .visual)

        let reloaded = ChatSessionStore.load(for: .visual)
        #expect(reloaded.history.count == 2)
        #expect(reloaded.history.first?.role == .user)
        #expect(reloaded.history.first?.content == "hello")
    }

    @Test func scopesAreIsolated() {
        overrideDir()
        var explorer = ChatSessionStore.load(for: .explorer)
        explorer.history = [.init(role: .user, content: "in explorer")]
        ChatSessionStore.save(explorer, for: .explorer)

        // Conflicts must be untouched by the explorer save.
        let conflicts = ChatSessionStore.load(for: .conflicts)
        #expect(conflicts.history.isEmpty)

        var conflictsMut = conflicts
        conflictsMut.history = [.init(role: .user, content: "in conflicts")]
        ChatSessionStore.save(conflictsMut, for: .conflicts)

        #expect(ChatSessionStore.load(for: .explorer).history.first?.content == "in explorer")
        #expect(ChatSessionStore.load(for: .conflicts).history.first?.content == "in conflicts")
    }

    @Test func clearRemovesOnlyOneScope() {
        overrideDir()
        var a = ChatSessionStore.load(for: .explorer)
        a.history = [.init(role: .user, content: "keep me")]
        ChatSessionStore.save(a, for: .explorer)
        var b = ChatSessionStore.load(for: .docGen)
        b.history = [.init(role: .user, content: "clear me")]
        ChatSessionStore.save(b, for: .docGen)

        ChatSessionStore.clear(for: .docGen)

        #expect(ChatSessionStore.load(for: .explorer).history.first?.content == "keep me")
        #expect(ChatSessionStore.load(for: .docGen).history.isEmpty)
    }

    @Test func saveBumpsLastUsedAt() {
        overrideDir()
        var session = ChatSessionStore.load(for: .visual)
        let before = session.lastUsedAt
        session.history = [.init(role: .user, content: "x")]
        ChatSessionStore.save(session, for: .visual)

        let reloaded = ChatSessionStore.load(for: .visual)
        #expect(reloaded.lastUsedAt >= before)
    }

    @Test func loadQuarantinesCorruptFileAndReturnsFresh() {
        overrideDir()
        // Save a valid file (creates sessions/<scope>.json via the store),
        // then clobber it with garbage.
        var session = ChatSessionStore.load(for: .explorer)
        session.history = [.init(role: .user, content: "good")]
        ChatSessionStore.save(session, for: .explorer)
        let file = ChatSessionStore.baseDirectoryOverride!
            .appendingPathComponent("sessions").appendingPathComponent("explorer.json")
        try? "{ broken".data(using: .utf8)?.write(to: file)

        let reloaded = ChatSessionStore.load(for: .explorer)
        #expect(reloaded.history.isEmpty)            // fresh fallback
        #expect(reloaded.title == "New chat")
        #expect(!FileManager.default.fileExists(atPath: file.path))  // quarantined aside
    }

    @Test func clearAllWipesEveryScope() {
        overrideDir()
        var a = ChatSessionStore.load(for: .explorer)
        a.history = [.init(role: .user, content: "a")]
        ChatSessionStore.save(a, for: .explorer)
        var b = ChatSessionStore.load(for: .conflicts)
        b.history = [.init(role: .user, content: "b")]
        ChatSessionStore.save(b, for: .conflicts)

        ChatSessionStore.clear()   // no-arg — the sign-out wipe

        #expect(ChatSessionStore.load(for: .explorer).history.isEmpty)
        #expect(ChatSessionStore.load(for: .conflicts).history.isEmpty)
    }
}
