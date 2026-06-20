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

    @Test func folderWithOldSubdirsIsRejected() throws {
        // The old meetings/notes/plans layout is no longer a valid project.
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        for sub in ["meetings", "notes", "plans"] {
            try FileManager.default.createDirectory(
                at: dir.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        #expect(throws: ProjectStoreError.self) {
            try ProjectScaffolder.validate(at: dir)
        }
    }

    @Test func folderWithNewMarkerIsAccepted() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let systemDir = dir.appendingPathComponent("system")
        try FileManager.default.createDirectory(at: systemDir, withIntermediateDirectories: true)
        try "{}".write(to: systemDir.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)
        try ProjectScaffolder.validate(at: dir)   // must not throw
    }

    @Test func oldDotLlmideMarkerIsRejected() throws {
        // A folder with only `.llmide/project.json` (old marker) is NOT accepted
        // by the new validator — it is non-empty but lacks `system/project.json`.
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let mn = dir.appendingPathComponent(".llmide")
        try FileManager.default.createDirectory(at: mn, withIntermediateDirectories: true)
        try "{}".write(to: mn.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)
        #expect(throws: ProjectStoreError.self) {
            try ProjectScaffolder.validate(at: dir)
        }
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

    // MARK: legacy MeetNotes layout — now rejected

    @Test func legacyMeetnotesProjectIsRejected() throws {
        // The old .meetnotes marker is no longer a recognised project layout.
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let mn = dir.appendingPathComponent(".meetnotes")
        try FileManager.default.createDirectory(at: mn, withIntermediateDirectories: true)
        try "{}".write(to: mn.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)
        #expect(throws: ProjectStoreError.self) {
            try ProjectScaffolder.validate(at: dir)
        }
    }

    // MARK: scaffold

    @Test func scaffoldCreatesCanonicalTree() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try ProjectScaffolder.scaffold(at: dir, project: sampleProject())
        let fm = FileManager.default
        for sub in ["source", "code", "data", "notes", "system",
                    "system/faults", "system/graph", "system/cache"] {
            var isDir: ObjCBool = false
            let exists = fm.fileExists(
                atPath: dir.appendingPathComponent(sub).path, isDirectory: &isDir)
            #expect(exists && isDir.boolValue, "missing dir: \(sub)")
        }
    }

    @Test func scaffoldDoesNotCreateOldDirectories() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try ProjectScaffolder.scaffold(at: dir, project: sampleProject())
        let fm = FileManager.default
        for sub in ["meetings", "plans", "assets", ".llmide", ".understand-anything", ".code-notes"] {
            #expect(!fm.fileExists(atPath: dir.appendingPathComponent(sub).path),
                    "unexpected dir present: \(sub)")
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

    @Test func gitignoreBlockWrittenToRootAndIdempotent() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("gi-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        // Pre-existing user .gitignore must be preserved.
        let root = tmp.appendingPathComponent(".gitignore")
        try "build/\n".write(to: root, atomically: true, encoding: .utf8)

        try ProjectScaffolder.scaffold(at: tmp, project: sampleProject())
        let once = try String(contentsOf: root, encoding: .utf8)
        #expect(once.contains("build/"))                 // user rule preserved
        #expect(once.contains("system/"))               // managed block added
        #expect(once.contains("# >>> LLM IDE managed"))

        // Idempotent: a second scaffold must not duplicate the block.
        try ProjectScaffolder.scaffold(at: tmp, project: sampleProject())
        let twice = try String(contentsOf: root, encoding: .utf8)
        let occurrences = twice.components(separatedBy: "# >>> LLM IDE managed").count - 1
        #expect(occurrences == 1)
    }
}
