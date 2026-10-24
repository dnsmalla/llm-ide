import XCTest
@testable import LlmIdeMacLib

/// Tests must never write chat sessions into the user's real Application
/// Support directory (ChatEngine turn tests used to leave "continue working"
/// sessions there).
final class ChatSessionStoreIsolationTests: XCTestCase {
    func testOverrideWins() {
        let o = URL(fileURLWithPath: "/tmp/override")
        XCTAssertEqual(ChatSessionStore.resolveBaseDir(override: o, underTests: true,
                                                       real: { URL(fileURLWithPath: "/real") }), o)
    }

    func testTestRunWithoutOverrideNeverUsesTheRealDirectory() {
        var touchedReal = false
        let dir = ChatSessionStore.resolveBaseDir(override: nil, underTests: true,
                                                  real: { touchedReal = true; return URL(fileURLWithPath: "/real") })
        XCTAssertFalse(touchedReal)
        XCTAssertEqual(dir, ChatSessionStore.testFallbackDirectory)
        XCTAssertTrue(dir.path.hasPrefix(FileManager.default.temporaryDirectory.path))
    }

    func testProductionUsesTheRealDirectory() {
        let real = URL(fileURLWithPath: "/real")
        XCTAssertEqual(ChatSessionStore.resolveBaseDir(override: nil, underTests: false, real: { real }), real)
    }

    func testThisProcessIsDetectedAsATestRun() {
        XCTAssertTrue(ChatSessionStore.isRunningUnderTests)
    }
}
