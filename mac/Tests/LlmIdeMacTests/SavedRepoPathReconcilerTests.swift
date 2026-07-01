import Testing
import Foundation
@testable import LlmIdeMac

@Suite("SavedRepoPathReconciler")
struct SavedRepoPathReconcilerTests {

    // MARK: - remoteMatches

    @Test func matchesIdenticalURLs() {
        #expect(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/dnsmalla/InfiniteBrain",
            remoteURL: "https://github.com/dnsmalla/InfiniteBrain"))
    }

    @Test func matchesDespiteDotGitSuffix() {
        #expect(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/dnsmalla/InfiniteBrain",
            remoteURL: "https://github.com/dnsmalla/InfiniteBrain.git"))
    }

    @Test func matchesDespiteTrailingSlashAndCase() {
        #expect(SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://GitHub.com/dnsmalla/InfiniteBrain/",
            remoteURL: "https://github.com/dnsmalla/infinitebrain"))
    }

    @Test func rejectsDifferentRepo() {
        #expect(!SavedRepoPathReconciler.remoteMatches(
            repoURL: "https://github.com/dnsmalla/InfiniteBrain",
            remoteURL: "https://github.com/dnsmalla/OtherRepo"))
    }

    @Test func rejectsEmptyRepoURL() {
        #expect(!SavedRepoPathReconciler.remoteMatches(repoURL: "", remoteURL: ""))
    }

    // MARK: - findExistingClone

    private func tmpDir() -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("recon-test-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    @Test func findsMatchInFirstCandidateDir() async {
        let dirA = tmpDir()
        let dirB = tmpDir()
        try? FileManager.default.createDirectory(
            at: dirA.appendingPathComponent("InfiniteBrain"), withIntermediateDirectories: true)

        let found = await SavedRepoPathReconciler.findExistingClone(
            name: "InfiniteBrain",
            url: "https://github.com/dnsmalla/InfiniteBrain",
            candidateDirs: [dirA, dirB],
            remoteURL: { _ in "https://github.com/dnsmalla/InfiniteBrain.git" })

        #expect(found == dirA.appendingPathComponent("InfiniteBrain").path)
    }

    @Test func fallsThroughToSecondCandidateDir() async {
        let dirA = tmpDir()
        let dirB = tmpDir()
        try? FileManager.default.createDirectory(
            at: dirB.appendingPathComponent("InfiniteBrain"), withIntermediateDirectories: true)

        let found = await SavedRepoPathReconciler.findExistingClone(
            name: "InfiniteBrain",
            url: "https://github.com/dnsmalla/InfiniteBrain",
            candidateDirs: [dirA, dirB],
            remoteURL: { _ in "https://github.com/dnsmalla/InfiniteBrain.git" })

        #expect(found == dirB.appendingPathComponent("InfiniteBrain").path)
    }

    @Test func returnsNilWhenFolderExistsButRemoteDoesNotMatch() async {
        let dirA = tmpDir()
        try? FileManager.default.createDirectory(
            at: dirA.appendingPathComponent("InfiniteBrain"), withIntermediateDirectories: true)

        let found = await SavedRepoPathReconciler.findExistingClone(
            name: "InfiniteBrain",
            url: "https://github.com/dnsmalla/InfiniteBrain",
            candidateDirs: [dirA],
            remoteURL: { _ in "https://github.com/someone-else/InfiniteBrain" })

        #expect(found == nil)
    }

    @Test func returnsNilWhenNoFolderExists() async {
        let dirA = tmpDir()
        let found = await SavedRepoPathReconciler.findExistingClone(
            name: "InfiniteBrain",
            url: "https://github.com/dnsmalla/InfiniteBrain",
            candidateDirs: [dirA],
            remoteURL: { _ in "https://github.com/dnsmalla/InfiniteBrain.git" })

        #expect(found == nil)
    }

    @Test func returnsNilWhenRemoteLookupThrows() async {
        let dirA = tmpDir()
        try? FileManager.default.createDirectory(
            at: dirA.appendingPathComponent("InfiniteBrain"), withIntermediateDirectories: true)

        struct Boom: Error {}
        let found = await SavedRepoPathReconciler.findExistingClone(
            name: "InfiniteBrain",
            url: "https://github.com/dnsmalla/InfiniteBrain",
            candidateDirs: [dirA],
            remoteURL: { _ in throw Boom() })

        #expect(found == nil)
    }
}
