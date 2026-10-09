import Testing
import Foundation
@testable import LlmIdeMacLib

/// Every definitive sign-out goes through `SessionStore.clear()`, including a
/// 401/403 from a token refresh that no UI button ever sees. The previous
/// account's chats must go with it.
@MainActor
@Suite("Sign-out account isolation", .serialized)
struct SignOutAccountIsolationTests {
    @Test("draining the session-scoped registry wipes chats, not only the account-menu buttons")
    func chatsAreSessionScoped() async throws {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("signout-chats-\(UUID().uuidString)", isDirectory: true)
        let sessions = tmp.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
        try "{}".write(to: sessions.appendingPathComponent("previous-user.json"), atomically: true, encoding: .utf8)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer {
            ChatSessionStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: tmp)
        }

        let registry = SessionScopedRegistry()
        let chats = ChatEngineRegistry()
        registry.register(chats)
        registry.resetAll()

        #expect(!FileManager.default.fileExists(atPath: sessions.appendingPathComponent("previous-user.json").path))
    }
}
