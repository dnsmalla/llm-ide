import XCTest
@testable import LlmIdeMacLib

/// SavedRepoPathReconciler heals a saved repo's localPath at startup by
/// finding an already-cloned folder whose origin remote matches. Getting
/// remoteMatches wrong either fails to heal a real match (repo looks
/// un-cloned forever) or — worse — matches the wrong repo and points the
/// app at an unrelated clone.
final class SavedRepoPathReconcilerTests: XCTestCase {

    // MARK: - remoteMatches

    func testIdenticalURLsMatch() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "https://github.com/a/b"))
    }

    func testDifferentSchemeMatches() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "http://github.com/a/b"))
    }

    func testWwwPrefixDifferenceMatches() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "https://www.github.com/a/b"))
    }

    func testTrailingDotGitDifferenceMatches() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "https://github.com/a/b.git"))
    }

    func testTrailingSlashDifferenceMatches() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "https://github.com/a/b/"))
    }

    func testCaseDifferenceMatches() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "https://GitHub.com/A/B"))
    }

    func testAllNormalizationsCombinedStillMatch() {
        XCTAssertTrue(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "HTTP://WWW.GitHub.com/A/B.GIT/"))
    }

    func testDifferentRepoDoesNotMatch() {
        XCTAssertFalse(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "https://github.com/a/c"))
    }

    func testEmptyRepoURLNeverMatches() {
        XCTAssertFalse(SavedRepoPathReconciler.remoteMatches(repoURL: "", remoteURL: ""))
    }

    /// Documented limitation: SSH remotes use a different host separator
    /// (`git@host:owner/repo.git`) than the HTTPS form this app saves, so
    /// they don't normalize to the same string even though they're the
    /// same repo. Locking this in so a future "fix" doesn't silently
    /// change matching behavior without updating the doc comment too.
    func testSSHFormDoesNotMatchHTTPSForm() {
        XCTAssertFalse(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/a/b", remoteURL: "git@github.com:a/b.git"))
    }

    // MARK: - findExistingClone

    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("saved-repo-reconciler-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func makeDir(_ name: String, under base: URL? = nil) -> URL {
        let dir = (base ?? root).appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testFindsMatchInFirstCandidateDir() async {
        let dirA = makeDir("dirA")
        _ = makeDir("repo", under: dirA)
        let dirB = makeDir("dirB")

        let result = await SavedRepoPathReconciler.findExistingClone(
            name: "repo", url: "https://github.com/a/repo",
            candidateDirs: [dirA, dirB],
            remoteURL: { _ in "https://github.com/a/repo" })

        XCTAssertEqual(result, dirA.appendingPathComponent("repo").path)
    }

    func testSkipsNonExistentCandidateDirsAndFindsInSecond() async {
        let dirA = makeDir("dirA")
        let dirB = makeDir("dirB")
        _ = makeDir("repo", under: dirB)

        let result = await SavedRepoPathReconciler.findExistingClone(
            name: "repo", url: "https://github.com/a/repo",
            candidateDirs: [dirA, dirB],
            remoteURL: { _ in "https://github.com/a/repo" })

        XCTAssertEqual(result, dirB.appendingPathComponent("repo").path)
    }

    func testReturnsNilWhenRemoteDoesNotMatch() async {
        let dirA = makeDir("dirA")
        _ = makeDir("repo", under: dirA)

        let result = await SavedRepoPathReconciler.findExistingClone(
            name: "repo", url: "https://github.com/a/repo",
            candidateDirs: [dirA],
            remoteURL: { _ in "https://github.com/someone-else/repo" })

        XCTAssertNil(result)
    }

    func testReturnsNilWhenNoCandidateHasTheFolder() async {
        let dirA = makeDir("dirA")

        let result = await SavedRepoPathReconciler.findExistingClone(
            name: "repo", url: "https://github.com/a/repo",
            candidateDirs: [dirA],
            remoteURL: { _ in "https://github.com/a/repo" })

        XCTAssertNil(result)
    }

    func testThrowingRemoteURLIsTreatedAsNoMatch() async {
        let dirA = makeDir("dirA")
        _ = makeDir("repo", under: dirA)
        struct Boom: Error {}

        let result = await SavedRepoPathReconciler.findExistingClone(
            name: "repo", url: "https://github.com/a/repo",
            candidateDirs: [dirA],
            remoteURL: { _ in throw Boom() })

        XCTAssertNil(result)
    }

    func testEmptyNameReturnsNilImmediately() async {
        let dirA = makeDir("dirA")

        let result = await SavedRepoPathReconciler.findExistingClone(
            name: "", url: "https://github.com/a/repo",
            candidateDirs: [dirA],
            remoteURL: { _ in "https://github.com/a/repo" })

        XCTAssertNil(result)
    }
}
