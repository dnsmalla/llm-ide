import XCTest
@testable import LlmIdeMacLib

final class AutoCodeUpdateServiceCLITests: XCTestCase {
    func testCustomImplementBranchFormat() {
        let b = AutoCodeUpdateService.customImplementBranch(slug: "nightly-cleanup", token: "a1b2")
        XCTAssertEqual(b, "fix/custom-nightly-cleanup-a1b2")
    }

    func testCommitAllReturnsFalseOutsideGitRepo() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("cli-commit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        // Not a git repo → commit fails (non-zero).
        XCTAssertFalse(AutoCodeUpdateService.commitAll(at: tmp.path, message: "x"))
    }
}
