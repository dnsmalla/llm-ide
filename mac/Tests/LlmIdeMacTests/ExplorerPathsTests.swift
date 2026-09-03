import XCTest
@testable import LlmIdeMacLib

final class ExplorerPathsTests: XCTestCase {

    // MARK: - key

    func testKeyStandardizesAndDropsTrailingSlash() {
        let a = URL(fileURLWithPath: "/tmp/a/b/", isDirectory: true)
        let b = URL(fileURLWithPath: "/tmp/a/./b")
        XCTAssertEqual(ExplorerPaths.key(a), ExplorerPaths.key(b))
        XCTAssertFalse(ExplorerPaths.key(a).hasSuffix("/"))
    }

    // MARK: - relativePath

    func testRelativePathOfDescendant() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let file = URL(fileURLWithPath: "/tmp/proj/src/main.swift")
        XCTAssertEqual(ExplorerPaths.relativePath(of: file, from: root), "src/main.swift")
    }

    func testRelativePathOfRootItselfIsEmptyString() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertEqual(ExplorerPaths.relativePath(of: root, from: root), "")
    }

    func testRelativePathOutsideRootIsNil() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertNil(ExplorerPaths.relativePath(of: URL(fileURLWithPath: "/tmp/other/x"), from: root))
    }

    /// The sibling-prefix trap: "/tmp/projector" starts with "/tmp/proj" as a
    /// STRING but is not inside it. A naive `hasPrefix(root.path)` would move
    /// files into the wrong tree.
    func testRelativePathRejectsSiblingWithSharedPrefix() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertNil(ExplorerPaths.relativePath(of: URL(fileURLWithPath: "/tmp/projector/x"), from: root))
    }

    // MARK: - isDescendant

    func testIsDescendantIsStrict() {
        let dir = URL(fileURLWithPath: "/tmp/proj/src")
        XCTAssertTrue(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj/src/a.swift"), of: dir))
        XCTAssertTrue(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj/src/deep/a.swift"), of: dir))
        XCTAssertFalse(ExplorerPaths.isDescendant(dir, of: dir), "a directory is not its own descendant")
        XCTAssertFalse(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj/srcx/a.swift"), of: dir))
        XCTAssertFalse(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj"), of: dir))
    }

    // MARK: - includeGlob

    func testIncludeGlobForNestedFolderIsPrefixWithTrailingSlash() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertEqual(
            ExplorerPaths.includeGlob(for: URL(fileURLWithPath: "/tmp/proj/app/job"), root: root),
            "app/job/")
    }

    func testIncludeGlobForRootItselfIsEmptyMeaningEverything() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertEqual(ExplorerPaths.includeGlob(for: root, root: root), "")
    }

    func testIncludeGlobOutsideRootIsNil() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertNil(ExplorerPaths.includeGlob(for: URL(fileURLWithPath: "/tmp/elsewhere"), root: root))
    }

    // MARK: - canonical

    /// `/var` is a symlink to `/private/var` on every macOS install — the
    /// exact real-world case that defeats raw `URL` equality/hashing for
    /// `List(selection:)`: `FileManager.contentsOfDirectory` returns
    /// symlink-resolved URLs while `appendingPathComponent` does not, so a
    /// selection URL built the second way never `==`s one built the first.
    ///
    /// This pins EQUALITY only, not a specific winning spelling: verified by
    /// probe, `URL.standardizedFileURL` folds `/private/var`/`/private/tmp`
    /// back to their shorter symlinked form (a documented
    /// `stringByStandardizingPath` special case) rather than the other way
    /// around, so `canonical(_:)` on this toolchain actually normalizes
    /// toward `/var/...`, not `/private/var/...`. Either direction satisfies
    /// this type's actual contract — "both spellings collapse to one key" —
    /// so do not tighten this into a literal-path assertion.
    func testCanonicalUnifiesVarAndPrivateVarSpellings() {
        let viaVar = URL(fileURLWithPath: "/var/tmp")
        let viaPrivateVar = URL(fileURLWithPath: "/private/var/tmp")
        XCTAssertEqual(ExplorerPaths.canonical(viaVar), ExplorerPaths.canonical(viaPrivateVar))
    }

    /// Reproduces the actual bug end-to-end against a real directory: a URL
    /// built with `appendingPathComponent` (what a caller constructs) and the
    /// URL `FileManager` hands back for the same file via
    /// `contentsOfDirectory` (what a `Row` is built from) can be `URL`-unequal
    /// even though they name the same file — `canonical(_:)` unifies them.
    func testCanonicalUnifiesAppendingPathComponentAndContentsOfDirectoryForms() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-paths-canonical-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let name = "a.txt"
        FileManager.default.createFile(atPath: root.appendingPathComponent(name).path, contents: nil)

        let viaAppend = root.appendingPathComponent(name)
        let viaListing = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent == name })

        XCTAssertEqual(ExplorerPaths.canonical(viaAppend), ExplorerPaths.canonical(viaListing))
    }
}
