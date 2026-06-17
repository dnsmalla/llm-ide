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

    /// A freshly-created temp directory, normalized to the canonical form the
    /// store records. The store's paths come from `FileManager`'s enumerator,
    /// which on macOS reports the temp dir under `/private/var/folders/…` —
    /// but every `URL` transform (`standardizedFileURL`, `resolvingSymlinksInPath`)
    /// leaves the `/var` firmlink in place. So we map `/var/…` → `/private/var/…`
    /// explicitly; otherwise every path assertion mismatches by the `/private`
    /// prefix on this and any APFS macOS host.
    private func tempDir(_ prefix: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let p = url.path
        let canonical = p.hasPrefix("/var/") ? "/private" + p : p
        return URL(fileURLWithPath: canonical, isDirectory: true)
    }

    /// Make a fresh temp project root with the given relative files written.
    private func makeProject(files: [String: String] = [:]) throws -> URL {
        let root = try tempDir("llmide-store")
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

        let extRepo = try tempDir("llmide-repo")
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

    // MARK: - In-project overlap never produces duplicate ids

    /// An external code-folder reference that points INSIDE the bound project
    /// root overlaps the canonical `code/` scan: the same file would be emitted
    /// once by the subfolder scan and once by externalFolderItems(). Both the
    /// entry-point guard (rejecting in-project refs) and the rescan() path-dedup
    /// must ensure `items` carries no two entries with the same id (== path) —
    /// duplicate Identifiable ids are undefined behavior in SwiftUI ForEach.
    @Test func externalFolderInsideProjectProducesNoDuplicateIds() throws {
        let root = try makeProject(files: ["code/main.swift": "import Foundation"])
        defer { try? FileManager.default.removeItem(at: root) }

        let store = LibraryItemStore()
        store.bindProject(root: root)

        // Reference the project's own code/ subtree as an "external" folder.
        let inProjectCode = root.appendingPathComponent("code", isDirectory: true)
        store.addFolder(url: inProjectCode, category: .code)
        // Also force it through the inbound-sync path to cover both entry points.
        store.setExternalCodeFolders([inProjectCode.path])
        store.rescan()

        // The overlapping file is still indexed exactly once...
        #expect(store.items(for: .code).filter { $0.name == "main.swift" }.count == 1)
        // ...and no two items share an id anywhere in the index.
        let ids = store.items.map(\.id)
        #expect(Set(ids).count == ids.count)
        // The in-project ref was rejected, not retained.
        #expect(store.externalCodeFolders.isEmpty)
    }

    // MARK: - Folder removal clears the external reference (no resurrection)

    @Test func removeFolderByOriginClearsExternalRefAndRescanDoesNotResurrect() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let extRepo = try tempDir("llmide-repo")
        defer { try? FileManager.default.removeItem(at: extRepo) }
        try "import Foundation".write(
            to: extRepo.appendingPathComponent("lib.swift"), atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        var persisted: [String] = []
        store.onExternalCodeFoldersChanged = { persisted = $0 }
        store.bindProject(root: root)
        store.addFolder(url: extRepo, category: .code)
        #expect(store.items(for: .code).contains { $0.name == "lib.swift" })

        // Remove by the sidebar group name (the folder's basename).
        store.removeFolder(folderOrigin: extRepo.lastPathComponent)

        // The external reference is gone and the owner was notified.
        #expect(store.externalCodeFolders.isEmpty)
        #expect(persisted.isEmpty)
        // rescan() must NOT resurrect the removed folder's items.
        #expect(!store.items(for: .code).contains { $0.name == "lib.swift" })
        store.rescan()
        #expect(!store.items(for: .code).contains { $0.name == "lib.swift" })
    }

    @Test func removeFolderByPathClearsExternalRef() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let extRepo = try tempDir("llmide-repo")
        defer { try? FileManager.default.removeItem(at: extRepo) }
        try "import Foundation".write(
            to: extRepo.appendingPathComponent("lib.swift"), atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)
        store.addFolder(url: extRepo, category: .code)
        #expect(store.items(for: .code).contains { $0.name == "lib.swift" })

        store.removeFolder(underPath: extRepo.standardizedFileURL.path)

        #expect(store.externalCodeFolders.isEmpty)
        #expect(!store.items(for: .code).contains { $0.name == "lib.swift" })
    }

    // MARK: - remove(id:) deletes the in-project file from disk

    /// Under scan-as-index, remove(id:) must delete the backing file on disk;
    /// an in-memory-only remove would be resurrected by the next rescan().
    @Test func removeInProjectFileDeletesFromDiskAndIndex() throws {
        let root = try makeProject(files: ["notes/scratch.md": "x"])
        defer { try? FileManager.default.removeItem(at: root) }

        let store = LibraryItemStore()
        store.bindProject(root: root)

        let noteURL = root.appendingPathComponent("notes/scratch.md")
        let item = try #require(store.items(for: .notes).first { $0.name == "scratch.md" })
        #expect(FileManager.default.fileExists(atPath: noteURL.path))

        store.remove(id: item.id)

        // File is gone from disk and from the index.
        #expect(!FileManager.default.fileExists(atPath: noteURL.path))
        #expect(!store.items(for: .notes).contains { $0.name == "scratch.md" })

        // A rescan must NOT resurrect it (the bug being guarded against).
        store.rescan()
        #expect(!store.items(for: .notes).contains { $0.name == "scratch.md" })
    }

    /// remove(id:) on an external referenced file is a no-op: we never delete
    /// the user's out-of-project files (whole-folder removal goes through
    /// removeFolder).
    @Test func removeExternalFileIsNoOp() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let extRepo = try tempDir("llmide-repo")
        defer { try? FileManager.default.removeItem(at: extRepo) }
        let extFile = extRepo.appendingPathComponent("lib.swift")
        try "import Foundation".write(to: extFile, atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)
        store.addFolder(url: extRepo, category: .code)
        let item = try #require(store.items(for: .code).first { $0.name == "lib.swift" })

        store.remove(id: item.id)

        // The user's external file is untouched and still indexed.
        #expect(FileManager.default.fileExists(atPath: extFile.path))
        #expect(store.items(for: .code).contains { $0.name == "lib.swift" })
    }

    /// The relocate contract: removeFolder(old) then addFolder(new) leaves
    /// only the new folder referenced — the old ref must not linger.
    @Test func relocateClearsOldRefAndKeepsOnlyNew() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        // Old and new clone locations share the same repo basename "myrepo".
        let oldParent = try tempDir("llmide-old")
        let newParent = try tempDir("llmide-new")
        let oldRepo = oldParent.appendingPathComponent("myrepo", isDirectory: true)
        let newRepo = newParent.appendingPathComponent("myrepo", isDirectory: true)
        try FileManager.default.createDirectory(at: oldRepo, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: newRepo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: oldParent) }
        defer { try? FileManager.default.removeItem(at: newParent) }
        try "old".write(to: oldRepo.appendingPathComponent("a.swift"), atomically: true, encoding: .utf8)
        try "new".write(to: newRepo.appendingPathComponent("a.swift"), atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)
        store.addFolder(url: oldRepo, category: .code)

        // Relocate: the call sites pass the (shared) basename then add the new path.
        store.removeFolder(folderOrigin: newRepo.lastPathComponent)
        store.addFolder(url: newRepo, category: .code)

        // Only the new path is referenced; the old one is gone.
        #expect(store.externalCodeFolders == [newRepo.standardizedFileURL.path])
        let codePaths = Set(store.items(for: .code).map(\.path))
        #expect(codePaths.contains(newRepo.appendingPathComponent("a.swift").path))
        #expect(!codePaths.contains(oldRepo.appendingPathComponent("a.swift").path))
    }
}
