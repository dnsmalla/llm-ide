import Testing
import Foundation
@testable import LlmIdeMacLib

/// Pins `relativeDirComponents` against the case-mismatch regression that
/// flattened the whole CODE tree: the project was registered as
/// "…/Desktop/LLM" while the on-disk folder is "…/Desktop/llm", and
/// `FileManager.enumerator` reports the ON-DISK case — so a case-sensitive
/// prefix compare failed for every file and every `treePath` came back `[]`.
@MainActor
struct LibraryItemStoreTreePathTests {

    @Test("nested file resolves its directory components")
    func nestedFile() {
        let root = URL(fileURLWithPath: "/Users/u/proj/code")
        let file = URL(fileURLWithPath: "/Users/u/proj/code/repo/pkg/__init__.py")
        #expect(LibraryItemStore.relativeDirComponents(of: file, under: root) == ["repo", "pkg"])
    }

    @Test("a case-mismatched root still matches (macOS volumes are case-insensitive)")
    func caseMismatchedRoot() {
        let root = URL(fileURLWithPath: "/Users/u/Desktop/LLM/code")
        let file = URL(fileURLWithPath: "/Users/u/Desktop/llm/code/repo/pkg/__init__.py")
        #expect(LibraryItemStore.relativeDirComponents(of: file, under: root) == ["repo", "pkg"])
    }

    @Test("a file outside the root yields [] (never crashes)")
    func outsideRoot() {
        let root = URL(fileURLWithPath: "/Users/u/proj/code")
        // DEEPER than the root so the [] comes from the prefix check, not
        // the component-count guard — otherwise deleting the prefix loop
        // would pass this test.
        let file = URL(fileURLWithPath: "/Users/u/elsewhere/deep/pkg/a.py")
        #expect(LibraryItemStore.relativeDirComponents(of: file, under: root) == [])
    }

    @Test("a file directly in the root yields []")
    func topLevelFile() {
        let root = URL(fileURLWithPath: "/Users/u/proj/code")
        let file = URL(fileURLWithPath: "/Users/u/proj/code/main.py")
        #expect(LibraryItemStore.relativeDirComponents(of: file, under: root) == [])
    }

    // Layer 2 of the fix: the bound project root resolves the recents
    // entry's spelling to the ON-DISK canonical path, so downstream prefix
    // comparisons see the case the enumerator reports. Pinned on the pure
    // `canonicalRoot` seam — driving `bindProject` here would run the
    // legacy-index migration against the REAL Application Support dir.
    @Test("canonicalRoot resolves a case-mismatched root to the on-disk spelling")
    func canonicalRootResolvesCase() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-treepath-\(UUID().uuidString)")
        let onDisk = base.appendingPathComponent("llm")
        try FileManager.default.createDirectory(at: onDisk, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let resolved = LibraryItemStore.canonicalRoot(base.appendingPathComponent("LLM"))
        #expect(resolved?.lastPathComponent == "llm")
    }

    @Test("canonicalRoot keeps a missing folder's standardized path (no crash, no nil)")
    func canonicalRootMissingFolder() {
        let missing = URL(fileURLWithPath: "/nonexistent/llmide-treepath-missing")
        #expect(LibraryItemStore.canonicalRoot(missing)?.path == "/nonexistent/llmide-treepath-missing")
        #expect(LibraryItemStore.canonicalRoot(nil) == nil)
    }

    // ProjectPaths.isInside shares the same canonical rule — a mixed-case
    // spelling of an in-project folder must still classify as inside, or
    // the external-folder path would double-index every code file.
    @Test("isInside accepts a case-mismatched spelling of an in-project folder")
    func isInsideCaseMismatch() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-isinside-\(UUID().uuidString)")
        let root = base.appendingPathComponent("llm")
        let inner = root.appendingPathComponent("code")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let misCasedRoot = base.appendingPathComponent("LLM")
        #expect(ProjectPaths.isInside(inner, root: misCasedRoot))
        #expect(!ProjectPaths.isInside(base.appendingPathComponent("elsewhere"), root: root))
    }
}
