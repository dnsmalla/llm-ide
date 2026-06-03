import Testing
import Foundation
@testable import MeetNotesMac

@Suite("ProjectMigrator")
@MainActor
struct ProjectMigratorTests {

    private func tmpRoot() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mig-test-\(UUID().uuidString)")
    }

    @Test func importsActiveGitLabAndGitHubProjects() throws {
        let stateRoot = tmpRoot()
        let glPath = tmpRoot()
        let ghPath = tmpRoot()
        for u in [stateRoot, glPath, ghPath] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }

        var glSaved = SavedGitLabProject(
            url: "https://gitlab.com/a/b", displayName: "GL one",
            resolvedId: 100, isActive: true)
        glSaved.localPath = glPath.path

        var ghSaved = SavedGitHubRepo(
            url: "https://github.com/c/d", displayName: "GH one",
            resolvedId: 200, isActive: false)
        ghSaved.localPath = ghPath.path

        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: stateRoot)
        let result = migrator.runOnce(gitLab: [glSaved], gitHub: [ghSaved])

        #expect(result.imported == 2)
        #expect(store.recents.count == 2)
        // Active GitLab → activeProject (preferredActive wins)
        #expect(store.activeProject?.localPath == glPath.path)
    }

    @Test func isIdempotent() throws {
        let stateRoot = tmpRoot()
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: stateRoot)

        let first = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(first.alreadyCompleted == false)
        let second = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(second.alreadyCompleted == true)
    }

    @Test func emptyInputIsNoOp() throws {
        let stateRoot = tmpRoot()
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: stateRoot)
        let result = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(result.imported == 0)
        #expect(store.activeProject == nil)
    }

    @Test func skipsRowsWithoutLocalPath() throws {
        let stateRoot = tmpRoot()
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let glNoPath = SavedGitLabProject(
            url: "https://gitlab.com/x/y", displayName: "no-path",
            resolvedId: 1, isActive: true)
        // localPath stays nil
        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: stateRoot)
        let result = migrator.runOnce(gitLab: [glNoPath], gitHub: [])
        #expect(result.imported == 0)
        #expect(store.recents.isEmpty)
    }

    @Test func gitLabActiveWinsOverGitHubActive() throws {
        let stateRoot = tmpRoot()
        let glPath = tmpRoot()
        let ghPath = tmpRoot()
        for u in [stateRoot, glPath, ghPath] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        var gl = SavedGitLabProject(
            url: "https://gitlab.com/x/y", displayName: "GL",
            resolvedId: 1, isActive: true)
        gl.localPath = glPath.path
        var gh = SavedGitHubRepo(
            url: "https://github.com/a/b", displayName: "GH",
            resolvedId: 2, isActive: true)
        gh.localPath = ghPath.path

        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: stateRoot)
        _ = migrator.runOnce(gitLab: [gl], gitHub: [gh])

        #expect(store.activeProject?.localPath == glPath.path)
    }

    @Test func markerIsNotWrittenWhenAllRowsFail() throws {
        // Every row has a localPath pointing at a NON-EXISTENT folder.
        // openFolder will throw on each (Data(contentsOf:) fails for the
        // ones with .meetnotes/project.json; for fresh folders without it,
        // mkdir then write — so even non-existent paths can succeed if
        // their PARENT directory exists. Pick a parent we know is
        // unwritable to force failure: under /System or read-only mount.
        // Simplest cross-host: create a regular file at the path so
        // openFolder's createDirectory(at:) fails with "file exists".
        let stateRoot = tmpRoot()
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let blockingFile = stateRoot.appendingPathComponent("not-a-dir.txt")
        try "block".data(using: .utf8)!.write(to: blockingFile)

        var gl = SavedGitLabProject(
            url: "https://gitlab.com/x/y", displayName: "BLOCKED",
            resolvedId: 1, isActive: true)
        gl.localPath = blockingFile.path  // a FILE, not a dir

        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: stateRoot)
        let result = migrator.runOnce(gitLab: [gl], gitHub: [])

        #expect(result.imported == 0)
        let markerPath = stateRoot.appendingPathComponent(".project-migration-complete").path
        #expect(FileManager.default.fileExists(atPath: markerPath) == false)
    }

    @Test func markerDirectoryIsCreatedWhenMissing() throws {
        let stateRoot = tmpRoot()
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        // markerDirectory points at a nested path that doesn't exist yet.
        let nestedDir = stateRoot.appendingPathComponent("a/b/c")
        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, markerDirectory: nestedDir)
        let result = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(result.imported == 0)
        let markerPath = nestedDir.appendingPathComponent(".project-migration-complete").path
        #expect(FileManager.default.fileExists(atPath: markerPath) == true)
    }
}
