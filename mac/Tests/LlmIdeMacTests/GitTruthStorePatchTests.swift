import XCTest
@testable import LlmIdeMacLib

final class GitTruthStorePatchTests: XCTestCase {
    var repo: URL!

    override func setUp() async throws {
        try await super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("git-truth-patch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try run(["init", "-q"])
        try run(["config", "user.email", "test@example.com"])
        try run(["config", "user.name", "Test"])
        // 9 lines, not 3: git's default 3-line diff context merges two
        // single-line changes into ONE hunk unless the unchanged run between
        // them exceeds 2*context (6) lines. A 3-line fixture (as originally
        // specified) produces exactly ONE hunk from git, not two — verified
        // empirically against real git during Task 3 implementation. 9 lines
        // (line1 changed, 7 unchanged lines of context, line9 changed)
        // reliably splits into two independent hunks.
        try "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n".write(to: repo.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])
        try run(["commit", "-q", "-m", "init"])
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    @discardableResult
    private func run(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = repo
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func testStagePatchStagesExactlyOneHunk() async throws {
        // Two independent hunks: change line1, change line9 (7 unchanged
        // lines between them — see the fixture comment in setUp()).
        try "CHANGED1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nCHANGED9\n".write(to: repo.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        let diff = try run(["diff", "--", "f.txt"])
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks.count, 2, "fixture must produce two independent hunks — adjust the fixture if git merged them into one")

        let store = GitTruthStore()
        try await store.stagePatch(root: repo, path: "f.txt", hunk: hunks[0])

        let staged = try run(["diff", "--cached", "--", "f.txt"])
        XCTAssertTrue(staged.contains("-line1"), "the first hunk's change must be staged")
        XCTAssertTrue(staged.contains("+CHANGED1"))
        XCTAssertFalse(staged.contains("CHANGED9"), "the second hunk must NOT be staged")

        let unstaged = try run(["diff", "--", "f.txt"])
        XCTAssertTrue(unstaged.contains("CHANGED9"), "the second hunk's change must still be in the working tree, unstaged")
    }

    func testUnstagePatchReversesExactlyOneStagedHunk() async throws {
        try "CHANGED1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nCHANGED9\n".write(to: repo.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])   // stage both hunks first
        let staged = try run(["diff", "--cached", "--", "f.txt"])
        let stagedHunks = UnifiedDiffParser.parse(staged)
        XCTAssertEqual(stagedHunks.count, 2)

        let store = GitTruthStore()
        try await store.unstagePatch(root: repo, path: "f.txt", hunk: stagedHunks[0])

        let stagedAfter = try run(["diff", "--cached", "--", "f.txt"])
        XCTAssertFalse(stagedAfter.contains("CHANGED1"), "the unstaged hunk must be gone from the index")
        XCTAssertTrue(stagedAfter.contains("CHANGED9"), "the other hunk must remain staged")
    }

    func testStagePatchOnAMalformedHunkThrows() async {
        let store = GitTruthStore()
        let bogus = DiffHunk(header: "@@ -1,1 +1,1 @@", rows: [
            DiffRow(kind: .delete, oldLine: 1, newLine: nil, text: "this line does not exist in f.txt"),
        ])
        do {
            try await store.stagePatch(root: repo, path: "f.txt", hunk: bogus)
            XCTFail("expected git apply to reject a patch that doesn't match the file")
        } catch {
            // Expected — git apply --cached correctly refuses a non-matching patch.
        }
    }
}
