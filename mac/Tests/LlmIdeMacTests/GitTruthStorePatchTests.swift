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
        // Pinned, not inherited: every fixture here is LF, and a developer
        // whose global config says `core.autocrlf=input` (or `true`) would
        // otherwise get a checkout whose line endings don't match the
        // patches these tests synthesize — failures that look like a patch
        // bug and are actually the machine's git config.
        try run(["config", "core.autocrlf", "false"])
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

        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
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

        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
        try await store.unstagePatch(root: repo, path: "f.txt", hunk: stagedHunks[0])

        let stagedAfter = try run(["diff", "--cached", "--", "f.txt"])
        XCTAssertFalse(stagedAfter.contains("CHANGED1"), "the unstaged hunk must be gone from the index")
        XCTAssertTrue(stagedAfter.contains("CHANGED9"), "the other hunk must remain staged")
    }

    func testStagePatchOnAMalformedHunkThrows() async {
        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
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

    // MARK: - Whole-file hunks must never reach `git apply --cached`
    //
    // `synthesizePatch` emits a content-MODIFICATION header for every hunk.
    // Handed a whole-file add or delete, `git apply --cached` accepts it with
    // exit status 0 and writes a ZERO-BYTE blob — the index is silently
    // wrong and the next commit records an empty file. These three cases were
    // all reproduced against real repos before the guard existed; each asserts
    // BOTH that the call throws AND that the index is byte-for-byte untouched,
    // because "it threw" alone would also pass if git had run and failed
    // halfway.

    /// The path the C1 bug was actually reached by: stage a new file, select
    /// it, click Unstage on its one hunk. Before the guard this produced
    /// `AM brand.txt` with a 0-byte blob.
    func testUnstagePatchRefusesAStagedNewFilesWholeFileHunk() async throws {
        try "alpha\nbeta\ngamma\n".write(to: repo.appendingPathComponent("brand.txt"),
                                        atomically: true, encoding: .utf8)
        try run(["add", "brand.txt"])
        let hunks = UnifiedDiffParser.parse(try run(["diff", "--cached", "--", "brand.txt"]))
        XCTAssertEqual(hunks.first?.header, "@@ -0,0 +1,3 @@",
                       "a staged new file diffs as one whole-file add hunk")
        let before = try indexBlob("brand.txt")
        XCTAssertEqual(before.count, 17)

        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
        do {
            try await store.unstagePatch(root: repo, path: "brand.txt", hunk: hunks[0])
            XCTFail("unstaging a whole-file add hunk must be refused, not applied")
        } catch let error as HunkPatchError {
            guard case .wholeFileHunk = error else { return XCTFail("wrong refusal: \(error)") }
        }
        XCTAssertEqual(try indexBlob("brand.txt"), before, "the index blob must be untouched")
        XCTAssertEqual(try porcelain(), "A  brand.txt", "the file must still be staged, whole")
    }

    /// `git diff --cached -- <newpath>` is pathspec-limited, so git reports a
    /// staged rename as a whole-file ADD of the new path. Before the guard,
    /// unstaging that hunk left `D  old.txt` + `AM new.txt` with a 0-byte
    /// blob — the rename destroyed and unrecoverable from the hunk alone.
    func testUnstagePatchRefusesAStagedRenamesWholeFileHunk() async throws {
        try run(["mv", "f.txt", "renamed.txt"])
        let hunks = UnifiedDiffParser.parse(try run(["diff", "--cached", "--", "renamed.txt"]))
        XCTAssertEqual(hunks.first?.header, "@@ -0,0 +1,9 @@")
        let before = try indexBlob("renamed.txt")

        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
        do {
            try await store.unstagePatch(root: repo, path: "renamed.txt", hunk: hunks[0])
            XCTFail("unstaging a staged rename's hunk must be refused, not applied")
        } catch let error as HunkPatchError {
            guard case .wholeFileHunk = error else { return XCTFail("wrong refusal: \(error)") }
        }
        XCTAssertEqual(try indexBlob("renamed.txt"), before)
        XCTAssertEqual(try porcelain(), "R  f.txt -> renamed.txt", "the staged rename must survive intact")
    }

    /// The stage-side twin: a worktree deletion diffs as `@@ -1,N +0,0 @@`.
    /// Before the guard this staged a 0-byte blob (`MD gone.txt`) instead of
    /// staging the deletion.
    func testStagePatchRefusesAWholeFileDeleteHunk() async throws {
        try FileManager.default.removeItem(at: repo.appendingPathComponent("f.txt"))
        let hunks = UnifiedDiffParser.parse(try run(["diff", "--", "f.txt"]))
        XCTAssertEqual(hunks.first?.header, "@@ -1,9 +0,0 @@")
        let before = try indexBlob("f.txt")

        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
        do {
            try await store.stagePatch(root: repo, path: "f.txt", hunk: hunks[0])
            XCTFail("staging a whole-file delete hunk must be refused, not applied")
        } catch let error as HunkPatchError {
            guard case .wholeFileHunk = error else { return XCTFail("wrong refusal: \(error)") }
        }
        XCTAssertEqual(try indexBlob("f.txt"), before, "the index blob must be untouched")
        XCTAssertEqual(try porcelain(), " D f.txt", "the deletion must still be unstaged")
    }

    /// `DiffHunk.fromLineDiff` (the agent-diff path) builds hunks with an
    /// EMPTY header, so its line counts promise nothing. Such a hunk must be
    /// refused rather than fed to git.
    func testStagePatchRefusesAHunkWithNoUsableHeader() async {
        let store = await GitTruthStore()   // @MainActor type; this test is nonisolated
        let headerless = DiffHunk(header: "", rows: [
            DiffRow(kind: .insert, oldLine: nil, newLine: 1, text: "x"),
        ])
        do {
            try await store.stagePatch(root: repo, path: "f.txt", hunk: headerless)
            XCTFail("a hunk with no @@ header must be refused")
        } catch let error as HunkPatchError {
            guard case .unparsableHeader = error else { return XCTFail("wrong refusal: \(error)") }
        } catch {
            XCTFail("expected a HunkPatchError refusal, got \(error)")
        }
    }

    /// The refusal must be an ALLOW-list on real modification hunks, not a
    /// blanket ban on `@@ -0,0`-looking headers: git's single-line shorthand
    /// (`@@ -1 +1 @@`, no comma) means one line on each side and is perfectly
    /// patchable.
    @MainActor
    func testAssertPatchableAcceptsGitsSingleLineShorthand() throws {
        XCTAssertNoThrow(try GitTruthStore.assertPatchable(
            path: "f.txt", hunk: DiffHunk(header: "@@ -1 +1 @@", rows: [])))
        XCTAssertThrowsError(try GitTruthStore.assertPatchable(
            path: "f.txt", hunk: DiffHunk(header: "@@ -0,0 +1,3 @@", rows: [])))
        XCTAssertThrowsError(try GitTruthStore.assertPatchable(
            path: "f.txt", hunk: DiffHunk(header: "@@ -1,3 +0,0 @@", rows: [])))
    }

    // MARK: - helpers

    /// Raw bytes of `path`'s current index entry (`git show :<path>`), so a
    /// zero-byte blob is detectable rather than merely "different".
    private func indexBlob(_ path: String) throws -> Data {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["show", ":" + path]
        p.currentDirectoryURL = repo
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return data
    }

    private func porcelain() throws -> String {
        try run(["status", "--porcelain=v1"]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
