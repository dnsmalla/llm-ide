import Testing
import Foundation
@testable import LlmIdeMac

/// Covers the folder-validation and scaffolding logic that backs "Open Folder"
/// and the clone-adopt path: which folders are accepted as projects, that the
/// canonical tree is created, and that a cloned repo's own README is preserved.
struct ProjectScaffolderTests {

    private func tempDir() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scaffold-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func sampleProject() -> Project {
        Project(id: "test-id", displayName: "Test",
                createdAt: Date(timeIntervalSince1970: 0),
                settings: ProjectStore.fallbackDefaults)
    }

    // MARK: validate

    @Test func emptyFolderIsAcceptedAsNewProject() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try ProjectScaffolder.validate(at: dir)   // must not throw
    }

    @Test func folderWithRequiredSubdirsIsAccepted() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        for sub in ["meetings", "notes", "plans"] {
            try FileManager.default.createDirectory(
                at: dir.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        try ProjectScaffolder.validate(at: dir)   // must not throw
    }

    @Test func existingMeetnotesProjectIsAccepted() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let mn = dir.appendingPathComponent(".llmide")
        try FileManager.default.createDirectory(at: mn, withIntermediateDirectories: true)
        try "{}".write(to: mn.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)
        try ProjectScaffolder.validate(at: dir)   // must not throw
    }

    @Test func nonEmptyNonProjectFolderIsRejected() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        // A bare code repo: has files but no llmide tree.
        try "code".write(to: dir.appendingPathComponent("main.swift"),
                         atomically: true, encoding: .utf8)
        #expect(throws: ProjectStoreError.self) {
            try ProjectScaffolder.validate(at: dir)
        }
    }

    // MARK: legacy MeetNotes migration

    @Test func legacyMeetnotesProjectStillValidates() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let mn = dir.appendingPathComponent(".meetnotes")
        try FileManager.default.createDirectory(at: mn, withIntermediateDirectories: true)
        try "{}".write(to: mn.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)
        // A pre-rename project (only a .meetnotes marker) must still be accepted.
        try ProjectScaffolder.validate(at: dir)
    }

    @MainActor @Test func migrateRenamesLegacyMarker() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let fm = FileManager.default
        let legacy = dir.appendingPathComponent(".meetnotes")
        try fm.createDirectory(at: legacy, withIntermediateDirectories: true)
        try "{}".write(to: legacy.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)

        ProjectStore.migrateLegacyMarker(at: dir)

        #expect(!fm.fileExists(atPath: legacy.path))
        #expect(fm.fileExists(
            atPath: dir.appendingPathComponent(".llmide/project.json").path))
    }

    // MARK: scaffold

    @Test func scaffoldCreatesCanonicalTree() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try ProjectScaffolder.scaffold(at: dir, project: sampleProject())
        let fm = FileManager.default
        for sub in [".llmide", "meetings", "notes", "plans", "assets"] {
            var isDir: ObjCBool = false
            let exists = fm.fileExists(
                atPath: dir.appendingPathComponent(sub).path, isDirectory: &isDir)
            #expect(exists && isDir.boolValue, "missing dir: \(sub)")
        }
    }

    @Test func scaffoldPreservesForeignReadme() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let readme = dir.appendingPathComponent("README.md")
        let original = "# Real Repo\n\nThis is the cloned project's own README.\n"
        try original.write(to: readme, atomically: true, encoding: .utf8)

        try ProjectScaffolder.scaffold(at: dir, project: sampleProject())

        let after = try String(contentsOf: readme, encoding: .utf8)
        #expect(after == original, "scaffold must not clobber a repo's own README")
    }

    @Test func scaffoldRefreshesMeetnotesManagedReadme() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let readme = dir.appendingPathComponent("README.md")
        // A previously LLM IDE-generated README carries the auto marker.
        try "# Old\n<!-- llmide:auto -->\nstale\n"
            .write(to: readme, atomically: true, encoding: .utf8)

        try ProjectScaffolder.scaffold(at: dir, project: sampleProject())

        let after = try String(contentsOf: readme, encoding: .utf8)
        #expect(after.contains("Managed by **LLM IDE**"),
                "a LLM IDE-managed README should be refreshed")
    }
}
