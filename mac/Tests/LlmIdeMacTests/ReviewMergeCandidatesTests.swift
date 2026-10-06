import Testing
import Foundation
@testable import LlmIdeMacLib

/// Review-merge must only push branches the pipeline created and that carry
/// new, not-yet-pushed commits — never a user's own `fix/…` WIP branch.
@Suite("Review-merge candidates", .serialized)
struct ReviewMergeCandidatesTests {
    @discardableResult
    private func git(_ args: [String], in dir: URL) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", dir.path, "-c", "user.name=t", "-c", "user.email=t@t",
                             "-c", "commit.gpgsign=false"] + args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("review-merge-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        git(["init", "-q", "-b", "main"], in: dir)
        git(["commit", "-q", "--allow-empty", "-m", "base"], in: dir)
        return dir
    }

    private func branchWithCommit(_ name: String, in dir: URL) {
        git(["switch", "-q", "-c", name, "main"], in: dir)
        git(["commit", "-q", "--allow-empty", "-m", name], in: dir)
        git(["switch", "-q", "main"], in: dir)
    }

    @Test func pipelineBranchRecognition() {
        #expect(AutoCodeUpdateService.isPipelineBranch("fix/12-null-crash"))
        #expect(AutoCodeUpdateService.isPipelineBranch("fix/custom-lint-ab12"))
        #expect(!AutoCodeUpdateService.isPipelineBranch("fix/typo"))
        #expect(!AutoCodeUpdateService.isPipelineBranch("feature/12-x"))
    }

    @Test func onlyAheadPipelineBranchesAreCandidates() throws {
        let repo = try makeRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        branchWithCommit("fix/7-real", in: repo)       // pipeline + new commits
        branchWithCommit("fix/typo", in: repo)         // user WIP, wrong name
        git(["branch", "fix/8-empty", "main"], in: repo) // pipeline but no commits

        let result = AutoCodeUpdateService.reviewMergeCandidates(defaultBranch: "main", at: repo.path)
        #expect(result == ["fix/7-real"])
    }
}
