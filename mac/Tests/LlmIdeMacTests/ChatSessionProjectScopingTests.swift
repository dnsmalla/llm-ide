import XCTest
@testable import LlmIdeMacLib

/// `ChatSession.projectId` + `ChatSessionStore.list(for:projectId:)`: the
/// `.quick` scope follows the ACTIVE project, so a session with no (or a
/// mismatched) project id must never leak into another project's list.
/// Mirrors `ChatSessionStoreTests`' isolation pattern (`baseDirectoryOverride`
/// pointed at a throwaway temp dir) so this suite never touches the real
/// Application Support directory.
final class ChatSessionProjectScopingTests: XCTestCase {
    var tmp: URL!

    override func setUp() {
        tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-session-project-scoping-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
    }

    override func tearDown() {
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    func testListFiltersByProject() {
        let a = ChatSession(id: UUID(), scope: .quick, projectId: "proj-a")
        let b = ChatSession(id: UUID(), scope: .quick, projectId: "proj-b")
        ChatSessionStore.save(a); ChatSessionStore.save(b)
        let forA = ChatSessionStore.list(for: .quick, projectId: "proj-a")
        XCTAssertEqual(forA.map(\.id), [a.id], "a project must not see another's quick chat")
    }

    func testLegacySessionWithNoProjectIdIsNotServedToEveryProject() {
        let legacy = ChatSession(id: UUID(), scope: .quick, projectId: nil)
        ChatSessionStore.save(legacy)
        XCTAssertFalse(ChatSessionStore.list(for: .quick, projectId: "proj-a").map(\.id).contains(legacy.id),
                       "an unknown-project chat belongs to none, not to all")
    }
}
