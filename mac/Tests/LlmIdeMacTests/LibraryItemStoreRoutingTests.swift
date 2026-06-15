import Testing
import Foundation
@testable import LlmIdeMac

/// Contract for the single-source LibraryItemStore: the bound project
/// folder is the source of truth (scan-as-index), adding an external file
/// copies it once into the right subfolder (replace on same-name conflict),
/// and a file already inside the project is referenced, not copied.
@MainActor
@Suite("LibraryItemStore routing")
struct LibraryItemStoreRoutingTests {

    /// Make a fresh temp project root with the given relative files written.
    private func makeProject(files: [String: String] = [:]) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for (rel, contents) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try contents.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }

    // MARK: - Scan indexes files by canonical subfolder

    @Test func scanIndexesFilesByFolder() throws {
        let root = try makeProject(files: [
            "notes/idea.md": "x",
            "data/rows.csv": "a,b",
            "code/main.swift": "import Foundation",
            "meetings/standup.md": "notes",
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let store = LibraryItemStore()
        store.bindProject(root: root)

        #expect(store.items(for: .notes).contains { $0.name == "idea.md" })
        #expect(store.items(for: .data).contains { $0.name == "rows.csv" })
        #expect(store.items(for: .code).contains { $0.name == "main.swift" })
        #expect(store.items(for: .meetings).contains { $0.name == "standup.md" })
    }

    @Test func scanAssignsFolderOriginForNestedFiles() throws {
        let root = try makeProject(files: [
            "notes/top.md": "x",          // direct child → folderOrigin nil
            "meetings/2026-05/m.md": "y", // nested → folderOrigin "2026-05"
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let store = LibraryItemStore()
        store.bindProject(root: root)

        let top = store.items.first { $0.name == "top.md" }
        let nested = store.items.first { $0.name == "m.md" }
        #expect(top?.folderOrigin == nil)
        #expect(nested?.folderOrigin == "2026-05")
    }

    @Test func scanSkipsPartialAndTemplate() throws {
        let root = try makeProject(files: [
            "notes/real.md": "x",
            "notes/draft.partial.md": "x",
            "notes/template.md": "x",
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let store = LibraryItemStore()
        store.bindProject(root: root)

        let names = Set(store.items(for: .notes).map(\.name))
        #expect(names.contains("real.md"))
        #expect(!names.contains("draft.partial.md"))
        #expect(!names.contains("template.md"))
    }

    @Test func noProjectMeansEmptyIndex() throws {
        let store = LibraryItemStore()
        store.bindProject(root: nil)
        #expect(store.items.isEmpty)
    }

    // MARK: - External file is copied into the subfolder, original kept

    @Test func externalFileCopiedIntoSubfolder() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        // External file outside the project.
        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-ext-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }
        let src = outside.appendingPathComponent("rows.csv")
        try "a,b".write(to: src, atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)
        store.add(url: src, category: .data)

        let dest = root.appendingPathComponent("data/rows.csv")
        #expect(FileManager.default.fileExists(atPath: dest.path))
        // Original is kept (copy, not move).
        #expect(FileManager.default.fileExists(atPath: src.path))
        // The copy is indexed.
        #expect(store.items(for: .data).contains { $0.path == dest.path })
    }

    // MARK: - In-project file is referenced, not copied

    @Test func inProjectFileReferencedNotCopied() throws {
        let root = try makeProject(files: ["code/app.swift": "import Foundation"])
        defer { try? FileManager.default.removeItem(at: root) }

        let store = LibraryItemStore()
        store.bindProject(root: root)

        let inProject = root.appendingPathComponent("code/app.swift")
        let codeDirBefore = try FileManager.default
            .contentsOfDirectory(atPath: root.appendingPathComponent("code").path)
        store.add(url: inProject, category: .code)
        let codeDirAfter = try FileManager.default
            .contentsOfDirectory(atPath: root.appendingPathComponent("code").path)

        // No duplicate file created.
        #expect(codeDirBefore.sorted() == codeDirAfter.sorted())
        // Still indexed exactly once.
        #expect(store.items(for: .code).filter { $0.path == inProject.path }.count == 1)
    }

    // MARK: - Same-name conflict replaces the existing file

    @Test func sameNameReplacesExisting() throws {
        let root = try makeProject(files: ["data/rows.csv": "old"])
        defer { try? FileManager.default.removeItem(at: root) }

        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-ext-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }
        let src = outside.appendingPathComponent("rows.csv")
        try "new".write(to: src, atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)
        store.add(url: src, category: .data)

        let dest = root.appendingPathComponent("data/rows.csv")
        let contents = try String(contentsOf: dest, encoding: .utf8)
        #expect(contents == "new")
        // Replaced, not duplicated.
        #expect(store.items(for: .data).filter { $0.path == dest.path }.count == 1)
    }

    // MARK: - External code folder referenced in place (not copied)

    @Test func externalCodeFolderReferencedInPlace() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let extRepo = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-repo-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: extRepo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: extRepo) }
        try "import Foundation".write(
            to: extRepo.appendingPathComponent("lib.swift"), atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)
        store.addFolder(url: extRepo, category: .code)

        let item = store.items(for: .code).first { $0.name == "lib.swift" }
        #expect(item != nil)
        // Indexed at its original location — not copied into the project's code/.
        #expect(item?.path == extRepo.appendingPathComponent("lib.swift").path)
        #expect(item?.folderOrigin == extRepo.lastPathComponent)
        // Nothing copied into the project.
        #expect(!FileManager.default.fileExists(
            atPath: root.appendingPathComponent("code/lib.swift").path))
    }
}
