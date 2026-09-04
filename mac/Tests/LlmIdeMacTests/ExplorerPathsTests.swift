import XCTest
@testable import LlmIdeMacLib

/// FIXTURE HAZARD — the temp fixtures below live under `/var/folders`, which is
/// exactly where `ExplorerPaths.key(_:)` is existence-dependent: Foundation
/// folds `/private` only while a path EXISTS, so the same path keys differently
/// once it is deleted. A deleted-path assertion that behaves oddly here is the
/// FIXTURE, not the code — re-root under `$HOME` rather than chasing it. Latent
/// today: no XCTest has ever executed in this repo.
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

    /// `canonical(_:)` must produce a full `URL` identity, not merely a
    /// `.path` match. A `URL` carries a directory hint (the trailing slash)
    /// and `standardizedFileURL` preserves whatever the input had, so two
    /// spellings of one directory used to come back `.path`-equal but
    /// `==`-unequal. `List(selection:)` matches by raw `URL` hashing, so that
    /// difference is the whole bug.
    func testCanonicalNormalizesTheDirectoryHintAcrossSpellings() {
        let hintless = URL(fileURLWithPath: "/private/var/tmp", isDirectory: false)
        let hinted = URL(fileURLWithPath: "/var/tmp", isDirectory: true)

        XCTAssertEqual(ExplorerPaths.canonical(hintless), ExplorerPaths.canonical(hinted))
        XCTAssertEqual(ExplorerPaths.canonical(hintless).hashValue,
                       ExplorerPaths.canonical(hinted).hashValue)
        XCTAssertTrue(Set([ExplorerPaths.canonical(hinted)])
            .contains(ExplorerPaths.canonical(hintless)))
    }

    /// The live shape this was found in: a folder URL built BEFORE the folder
    /// existed (so it carries no directory hint) is canonicalized and put into
    /// a `Set<URL>` selection, where it must match the row `FileManager` hands
    /// back for that same folder. Non-ASCII on purpose.
    func testCanonicalOfAHintlessFolderMatchesItsDirectoryListingForm() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-paths-hint-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let name = "サブ フォルダ"

        // built without a hint first — this is what a create-folder call returns
        let hintless = URL(fileURLWithPath: root.path).appendingPathComponent(name, isDirectory: false)
        try FileManager.default.createDirectory(at: root.appendingPathComponent(name),
                                                withIntermediateDirectories: true)
        let row = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent == name }).standardizedFileURL

        XCTAssertEqual(ExplorerPaths.canonical(hintless), row)
        XCTAssertTrue(Set([row]).contains(ExplorerPaths.canonical(hintless)),
                      "a canonicalized folder URL must actually select its own row")
    }

    /// A path that does not exist has no hint to ask the filesystem for, and
    /// must come back unchanged rather than guessed at.
    func testCanonicalLeavesANonExistentPathAlone() {
        let ghost = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-paths-ghost-\(UUID().uuidString)/nope.txt")
        XCTAssertEqual(ExplorerPaths.canonical(ghost).path, ghost.standardizedFileURL.path)
    }

    // MARK: - topLevel

    private func paths(_ strings: [String]) -> [URL] {
        strings.map { URL(fileURLWithPath: $0) }
    }

    /// The three shapes the final review reproduced on a real filesystem: a
    /// drop, a copy and a confirmed three-item delete, each given a folder AND
    /// something inside it. The child is redundant — trashing or moving the
    /// folder takes it along — and leaving it in the list made the destructive
    /// loop throw on it and silently abandon everything behind it.
    func testTopLevelDropsAChildOfASelectedFolderAndKeepsTheSibling() {
        let selection = paths(["/p/folder", "/p/folder/child.txt", "/p/other.txt"])
        XCTAssertEqual(ExplorerPaths.topLevel(selection).map(\.path),
                       ["/p/folder", "/p/other.txt"])
    }

    func testTopLevelKeepsTheInputOrder() {
        let selection = paths(["/p/a.txt", "/p/folder", "/p/folder/deep/x", "/p/b.txt"])
        XCTAssertEqual(ExplorerPaths.topLevel(selection).map(\.path),
                       ["/p/a.txt", "/p/folder", "/p/b.txt"],
                       "the order is the user's display order, and the loops apply in it")
    }

    /// A folder inside a folder inside a selected folder — only the outermost
    /// survives, however deep the nesting goes.
    func testTopLevelCollapsesAWholeNestedChain() {
        let selection = paths(["/p/a", "/p/a/b", "/p/a/b/c", "/p/a/b/c/d.txt"])
        XCTAssertEqual(ExplorerPaths.topLevel(selection).map(\.path), ["/p/a"])
    }

    /// A sibling whose name merely STARTS with a selected folder's name is not
    /// inside it. Same rule `relativePath`'s `+ "/"` guard enforces.
    func testTopLevelKeepsASiblingWithASharedNamePrefix() {
        let selection = paths(["/p/proj", "/p/projector", "/p/proj.old"])
        XCTAssertEqual(Set(ExplorerPaths.topLevel(selection).map(\.path)),
                       Set(["/p/proj", "/p/projector", "/p/proj.old"]))
    }

    /// The adversarial ordering the sort has to survive: "." (0x2E) sorts
    /// BEFORE "/" (0x2F), so on raw keys "/p/a." falls between "/p/a" and
    /// "/p/a/z" and a scan that only remembers its previous neighbour loses
    /// track of the ancestor. Terminating every key with "/" before sorting is
    /// what keeps a folder's descendants contiguous behind it.
    func testTopLevelSurvivesASeparatorAdjacentSiblingName() {
        let selection = paths(["/p/a", "/p/a.", "/p/a/z.txt"])
        XCTAssertEqual(ExplorerPaths.topLevel(selection).map(\.path), ["/p/a", "/p/a."])
    }

    /// Non-ASCII and spaces, because that is what this project's users select.
    func testTopLevelHandlesJapaneseAndSpacedPaths() {
        let selection = paths(["/p/資料 フォルダ", "/p/資料 フォルダ/設計.txt", "/p/読み.txt"])
        XCTAssertEqual(ExplorerPaths.topLevel(selection).map(\.path),
                       ["/p/資料 フォルダ", "/p/読み.txt"])
    }

    /// Nothing to prune must come back untouched, including the empty and
    /// single-item selections every gesture starts from.
    func testTopLevelLeavesAnUnnestedSelectionAlone() {
        XCTAssertTrue(ExplorerPaths.topLevel([]).isEmpty)
        XCTAssertEqual(ExplorerPaths.topLevel(paths(["/p/a.txt"])).map(\.path), ["/p/a.txt"])
        let flat = paths(["/p/c.txt", "/p/a.txt", "/p/b.txt"])
        XCTAssertEqual(ExplorerPaths.topLevel(flat).map(\.path),
                       ["/p/c.txt", "/p/a.txt", "/p/b.txt"])
    }
}
