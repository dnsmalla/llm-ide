# VS Code Parity P3: Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Mac app's Explorer to VS Code parity — an observable tree store with live filesystem updates, `List(selection:)` multi-select and keyboard navigation, drag & drop, cut/copy/paste, inline rename, a resizable persisted tree width, Copy Path, and Find in Folder.

**Architecture:** `ExplorerView`'s inline `@State` tree cache (which mutates during view-body evaluation — design §3 finding #9) is replaced by a `@MainActor @Observable ExplorerTreeStore` that owns the children cache, expansion set, and selection, loads directories off the main actor, flattens the visible tree to a `[Row]` list keyed by `URL`, persists expansion/selection to `UserDefaults`, and live-refreshes from its own `RepoFileWatcher`. Destructive filesystem work stays in the existing stateless `ExplorerFileOps` enum, which gains `move`/`copy`/`paste` with collision and self-nesting guards. Git decoration switches from the deleted `GitStatusStore` to `GitTruthStore` and — the actual fix for design §3 finding #1 — is resolved against `WorkspaceRoot.gitWorkingTree(config:projectStore:)` instead of the `code/` container that has no `.git`.

**Tech Stack:** Swift 6.2.3 toolchain in language mode v5, SwiftUI (macOS 14 deployment target), Observation (`@Observable`), FSEvents via the existing `RepoFileWatcher`, XCTest, SwiftPM.

**Spec:** [`docs/superpowers/specs/2026-09-03-vscode-parity-explorer-scm-search-design.md`](../specs/2026-09-03-vscode-parity-explorer-scm-search-design.md) — §6.3 (`ExplorerTreeStore`), §6.5 (`ExplorerFileOps.move`/`copy`), §3 findings #1/#5/#9/#10, §9 (testing strategy), §11 (P3 scope).

## Global Constraints

- Swift 6 language mode is NOT enabled (`swiftLanguageModes: [.v5]` in `Package.swift`) — do not add
  strict-concurrency-only syntax.
- No raw `Color.green`/`.red`/`.orange` in new or touched view code — always a `Theme` token (`Theme.swift`).
- This toolchain (Xcode Command Line Tools only, no full Xcode) CANNOT run `swift test` — it fails with
  `no such module 'XCTest'`. Every "run the test" step still means literally running the command; if it fails
  that way, that is an environment limitation, not a task failure. Confirm via `swift build` and
  `swift build --build-tests` instead, and state explicitly that the test did not execute. Never claim a test
  passed when it did not run.
- Do NOT set `GIT_CONFIG_GLOBAL` in any command — it is blocked in this isolated session and unnecessary.
  Build commands are plain `swift build`.
- View-glue code (SwiftUI + WKWebView) has no live-WebView test harness — confirmed manually per a checklist,
  not by XCTest. Pure logic (stores, file ops, path handling) gets real tests.
- File operations (move/copy/delete/rename) are DESTRUCTIVE to the user's working tree. Every task touching
  them must test against a REAL temp directory, never a mock, and must verify the resulting filesystem state.
- Split on `\.isNewline`, never the literal `"\n"` — Swift treats `"\r\n"` as ONE Character, a trap that has
  bitten this project three times.
- Chain every `cd` with its command in ONE Bash call; the working directory does not persist between calls.
- SourceKit diagnostics in this repo are frequently STALE false positives. Only real `swift build` output counts.

### P3-specific rulings (settled during design — do not re-litigate)

- `move(from:to:)` / `copy(from:to:)` take a destination **directory**, not a destination file URL. Move never
  overwrites (throws `.alreadyExists`); copy auto-uniquifies Finder-style via `uniqueDestination`.
- The spec says live updates come from `GitTruthStore.startWatching`, but that watcher only covers git
  *status*, rooted at the git working tree. Tree *structure* needs its OWN watcher rooted at the tree root,
  which is frequently a different directory (the `code/` container holding several clones). `ExplorerTreeStore`
  therefore gets its own `RepoFileWatcher` at **1.0s** debounce (`GitTruthStore`'s is 2.0s).
- The `Decoration` → `Theme` mapping mirrors `Theme.color(for: FileChange.Status)` exactly — `modified` maps to
  `info` (blue), NOT the amber `TreeRowLabel` hardcodes today — so Explorer and Source Control cannot drift.
- Persistence is `UserDefaults`, JSON-encoded, with paths stored **root-relative**; paths that no longer exist
  on disk are dropped at restore.
- The cut/copy/paste clipboard is Explorer-internal (`ExplorerClipboard`), **not** `NSPasteboard` — the system
  pasteboard would leak file paths into unrelated ⌘V targets.
- Find in Folder hands off through a `ShellState` property, **not** a `Notification`: `SearchView` is not
  mounted at the moment the section switches, so a notification would be posted into the void. This mirrors the
  existing `ShellState.pendingResummarizeMeetingId` consume-once pattern.
- The Search/Explorer root mismatch (design §3 finding #10) belongs to **P4, not P3**. Find in Folder computes
  its glob against Search's root (`WorkspaceRoot.resolve`) and DISABLES the menu item when the folder falls
  outside that root.
- Keyboard: ↑/↓ are left to `List` itself (it already does them correctly). →/← expand/collapse, ⏎ opens,
  **F2 renames** (⏎ is taken).
- `ExplorerPaths.key(_:)` is the single path normalizer. `flatten`, persistence, and `refreshLoaded` all call
  it; no task may introduce a second normalization.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/Services/ExplorerPaths.swift` | Pure path helpers: `key`, `relativePath`, `isDescendant`, `includeGlob`. No filesystem I/O. |
| `mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift` | `@Observable` tree model: children cache, expansion, selection, `flatten`, persistence, watcher. |
| `mac/Sources/LlmIdeMac/Services/ExplorerDragPayload.swift` | Encode/decode the newline-joined path list carried by a tree drag. |
| `mac/Sources/LlmIdeMac/Services/ExplorerClipboard.swift` | Explorer-internal cut/copy clipboard (never `NSPasteboard`). |
| `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift` | Pure key-character → command resolver for the tree's `onKeyPress`. |
| `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift` | `List(selection:)` tree + `ExplorerTreeRow` + the `ExplorerActions` closure bundle. |
| `mac/Sources/LlmIdeMac/Views/Shared/ResizableDivider.swift` | Draggable vertical divider that writes a clamped width back to a binding. |
| `mac/Tests/LlmIdeMacTests/ExplorerPathsTests.swift` | Task 1 tests. |
| `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreTests.swift` | Tasks 3 + 4 tests (core cache/expansion/selection, `flatten`). |
| `mac/Tests/LlmIdeMacTests/ExplorerTreeStorePersistenceTests.swift` | Task 5 tests. |
| `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreWatchTests.swift` | Task 6 tests. |
| `mac/Tests/LlmIdeMacTests/ThemeDecorationColorTests.swift` | Task 7 tests. |
| `mac/Tests/LlmIdeMacTests/ResizableDividerTests.swift` | Task 9 tests. |
| `mac/Tests/LlmIdeMacTests/ExplorerDragPayloadTests.swift` | Task 10 tests. |
| `mac/Tests/LlmIdeMacTests/ExplorerClipboardTests.swift` | Task 11 tests. |
| `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift` | Tasks 8/11/12 key-resolver tests. |
| `mac/Tests/LlmIdeMacTests/ShellStatePendingSearchTests.swift` | Task 14 tests. |

**Modify:**

| File | Change |
|---|---|
| `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift` | Add `.cannotMoveIntoSelf` error, `move`, `copy`, `uniqueDestination`, `paste`. |
| `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift` | Add move/copy/unique/paste tests. |
| `mac/Sources/LlmIdeMac/Models/Theme.swift` | Add `color(for: GitTruthStore.Decoration)`. |
| `mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift` | Retype `gitStatus` to `GitTruthStore.Decoration?`; colors from `Theme`. |
| `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` | Swap to `GitTruthStore` on the git root; adopt `ExplorerTreeStore` + `ExplorerTreeList`; resizable width; all new actions. |
| `mac/Sources/LlmIdeMac/Services/ShellState.swift` | Add `pendingSearchInclude` + `takePendingSearchInclude()`. |
| `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift` | Consume `pendingSearchInclude` on appear. |

**Delete:**

| File | Reason |
|---|---|
| `mac/Sources/LlmIdeMac/Services/GitStatusStore.swift` | Superseded by `GitTruthStore` (P0 shipped it as a byte-for-byte behavioral port; its own header comment schedules this deletion for P3). |

> **Placement rule (important):** every new *store/helper* type goes under `Sources/LlmIdeMac/Services/`, never
> under `Views/Explorer/`. `Package.swift` excludes `Views/Explorer`, `Views/Search`, and `Views/SourceControl`
> wholesale when the `file_explorer` feature is compiled out, but excludes **no test files** for that feature.
> A store placed under `Views/Explorer/` would make every new test file fail to compile in a lite build.

---

### Task 1: `ExplorerPaths` — pure path helpers

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ExplorerPaths.swift`
- Test: `mac/Tests/LlmIdeMacTests/ExplorerPathsTests.swift`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `enum ExplorerPaths`
  - `static func key(_ url: URL) -> String`
  - `static func relativePath(of url: URL, from root: URL) -> String?`
  - `static func isDescendant(_ url: URL, of ancestor: URL) -> Bool`
  - `static func includeGlob(for folder: URL, root: URL) -> String?`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerPathsTests.swift`:

```swift
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
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerPathsTests 2>&1 | tail -20`

Expected: FAIL. On this toolchain the failure is `no such module 'XCTest'` (the environment limitation named in Global Constraints) — the test did NOT execute. Record that verbatim; do not claim a pass. Then confirm the real compile-level failure:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`

Expected: FAIL with `cannot find 'ExplorerPaths' in scope`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/ExplorerPaths.swift`:

```swift
import Foundation

/// Pure path arithmetic for the Explorer tree — no filesystem I/O, no actor
/// isolation, so every rule here is unit-testable without a real directory.
///
/// `key(_:)` is THE normalizer for this subsystem: `ExplorerTreeStore`'s
/// children cache, its expansion set, its persistence, and its refresh path
/// all key on it. A second normalization anywhere would silently split the
/// cache (`/tmp/a` and `/tmp/a/` becoming two entries for one directory).
enum ExplorerPaths {
    /// Canonical dictionary/set key for a file URL: the standardized POSIX
    /// path, with no trailing slash (`URL.path` never emits one except for
    /// "/"), so a directory URL built with or without `isDirectory: true`
    /// produces the same key.
    static func key(_ url: URL) -> String {
        url.standardizedFileURL.path
    }

    /// `url`'s path relative to `root`: `""` when they are the same
    /// directory, `nil` when `url` is not inside `root`.
    ///
    /// The `+ "/"` on the prefix check is load-bearing: without it
    /// "/tmp/projector" reads as being inside "/tmp/proj", which would let a
    /// drag-and-drop move write into a sibling tree.
    static func relativePath(of url: URL, from root: URL) -> String? {
        let rootKey = key(root)
        let urlKey = key(url)
        if urlKey == rootKey { return "" }
        guard urlKey.hasPrefix(rootKey + "/") else { return nil }
        return String(urlKey.dropFirst(rootKey.count + 1))
    }

    /// True when `url` sits strictly inside `ancestor`. A directory is NOT
    /// its own descendant — the move/copy self-nesting guards depend on that
    /// strictness to reject "move a folder into itself" while still allowing
    /// "move a file back into the folder it already lives in" (a no-op).
    static func isDescendant(_ url: URL, of ancestor: URL) -> Bool {
        guard let rel = relativePath(of: url, from: ancestor) else { return false }
        return !rel.isEmpty
    }

    /// The `SearchView` "files to include" glob that scopes a search to
    /// `folder`. `nil` when `folder` is outside `root` — Search walks from
    /// `root`, so a folder outside it can never be reached by narrowing the
    /// glob, and the caller must disable the menu item rather than run a
    /// search that silently returns nothing.
    ///
    /// A bare directory prefix is exactly what `GlobMatch.matches` treats as
    /// a prefix match (it has no `*?[` metacharacters), so "app/job/" scopes
    /// to that subtree without needing `app/job/**`.
    static func includeGlob(for folder: URL, root: URL) -> String? {
        guard let rel = relativePath(of: folder, from: root) else { return nil }
        if rel.isEmpty { return "" }   // the root itself → search everything
        return rel.hasSuffix("/") ? rel : rel + "/"
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerPathsTests 2>&1 | tail -20`

Expected on a full Xcode toolchain: all 8 tests pass. Expected HERE: `no such module 'XCTest'` — the test did not execute; say so explicitly. Then confirm compilation of both the library and the test target:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors mentioning `ExplorerPaths`.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerPaths.swift mac/Tests/LlmIdeMacTests/ExplorerPathsTests.swift
git commit -m "feat(mac): add ExplorerPaths, the Explorer tree's single path normalizer"
```

---

### Task 2: `ExplorerFileOps` gains `move` / `copy` / `uniqueDestination`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift` (add a case to `ExplorerFileError`; add three static methods)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift` (append)

**Interfaces:**
- Consumes: `ExplorerPaths.isDescendant(_:of:)` (Task 1).
- Produces:
  - `ExplorerFileError.cannotMoveIntoSelf` (new case; `errorDescription` → `"Can't move a folder into itself."`)
  - `@discardableResult static func move(from source: URL, to destinationDir: URL) throws -> URL`
  - `@discardableResult static func copy(from source: URL, to destinationDir: URL) throws -> URL`
  - `static func uniqueDestination(in dir: URL, name: String) -> URL`

- [ ] **Step 1: Write the failing tests**

Append to `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift`, INSIDE the existing `ExplorerFileOpsTests` class (before its closing brace). The existing `setUp`/`tearDown` already create and remove a real temp `root` — reuse them; do not add a mock filesystem.

```swift
    // MARK: - move

    func testMoveRelocatesIntoDestinationDirectory() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "sub")
        let moved = try ExplorerFileOps.move(from: src, to: dest)
        XCTAssertFalse(FileManager.default.fileExists(atPath: src.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: moved.path))
        XCTAssertEqual(moved.path, dest.appendingPathComponent("a.txt").path)
    }

    func testMoveNeverOverwritesAnExistingItem() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "sub")
        _ = try ExplorerFileOps.createFile(in: dest, name: "a.txt")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: src, to: dest)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .alreadyExists)
        }
        // The source must survive a rejected move.
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
    }

    func testMoveIntoItsOwnParentIsANoOp() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let result = try ExplorerFileOps.move(from: src, to: root)
        XCTAssertEqual(result.path, src.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
    }

    func testMoveFolderIntoItselfThrows() throws {
        let folder = try ExplorerFileOps.createFolder(in: root, name: "parent")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: folder, to: folder)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.path))
    }

    func testMoveFolderIntoItsOwnDescendantThrows() throws {
        let parent = try ExplorerFileOps.createFolder(in: root, name: "parent")
        let child = try ExplorerFileOps.createFolder(in: parent, name: "child")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: parent, to: child)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: child.path),
                      "a rejected self-nesting move must not have disturbed the tree")
    }

    // MARK: - uniqueDestination

    func testUniqueDestinationReturnsTheNameWhenFree() {
        let url = ExplorerFileOps.uniqueDestination(in: root, name: "a.txt")
        XCTAssertEqual(url.lastPathComponent, "a.txt")
    }

    func testUniqueDestinationAppendsFinderStyleCopySuffixes() throws {
        _ = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        XCTAssertEqual(ExplorerFileOps.uniqueDestination(in: root, name: "a.txt").lastPathComponent,
                       "a copy.txt")
        _ = try ExplorerFileOps.createFile(in: root, name: "a copy.txt")
        XCTAssertEqual(ExplorerFileOps.uniqueDestination(in: root, name: "a.txt").lastPathComponent,
                       "a copy 2.txt")
    }

    func testUniqueDestinationHandlesExtensionlessNames() throws {
        _ = try ExplorerFileOps.createFolder(in: root, name: "docs")
        XCTAssertEqual(ExplorerFileOps.uniqueDestination(in: root, name: "docs").lastPathComponent,
                       "docs copy")
    }

    // MARK: - copy

    func testCopyDuplicatesFileAndLeavesSourceInPlace() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        try "hello".write(to: src, atomically: true, encoding: .utf8)
        let dest = try ExplorerFileOps.createFolder(in: root, name: "sub")
        let copied = try ExplorerFileOps.copy(from: src, to: dest)
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
        XCTAssertEqual(try String(contentsOf: copied, encoding: .utf8), "hello")
        XCTAssertEqual(copied.lastPathComponent, "a.txt")
    }

    func testCopyIntoTheSameDirectoryAutoUniquifies() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let copied = try ExplorerFileOps.copy(from: src, to: root)
        XCTAssertEqual(copied.lastPathComponent, "a copy.txt")
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: copied.path))
    }

    func testCopyFolderIntoItsOwnDescendantThrows() throws {
        let parent = try ExplorerFileOps.createFolder(in: root, name: "parent")
        let child = try ExplorerFileOps.createFolder(in: parent, name: "child")
        XCTAssertThrowsError(try ExplorerFileOps.copy(from: parent, to: child)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerFileOpsTests 2>&1 | tail -20`

Expected: FAIL. On this toolchain: `no such module 'XCTest'` — the test did not execute; record that. Then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `type 'ExplorerFileOps' has no member 'move'` (and `copy`, `uniqueDestination`, `cannotMoveIntoSelf`).

- [ ] **Step 3: Add the error case**

In `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift`, extend `ExplorerFileError` (currently `emptyName`/`invalidName`/`alreadyExists`/`writeFailed`):

```swift
enum ExplorerFileError: LocalizedError, Equatable {
    case emptyName
    case invalidName
    case alreadyExists
    case writeFailed
    /// Dropping/pasting a folder into itself or into one of its own
    /// descendants. `FileManager.moveItem` would either fail with an opaque
    /// Cocoa error or (for a copy) recurse forever, so this is caught first.
    case cannotMoveIntoSelf

    var errorDescription: String? {
        switch self {
        case .emptyName: return "Name can't be empty."
        case .invalidName: return "Name can't contain \"/\" or be \".\" or \"..\"."
        case .alreadyExists: return "An item with this name already exists."
        case .writeFailed: return "Couldn't create the item."
        case .cannotMoveIntoSelf: return "Can't move a folder into itself."
        }
    }
}
```

- [ ] **Step 4: Add `move`, `copy`, and `uniqueDestination`**

Append inside `enum ExplorerFileOps`, after the existing `trash(_:)`:

```swift
    /// Guard shared by `move` and `copy`: rejects "into itself" and "into my
    /// own descendant" before any filesystem call. `isDescendant` is strict,
    /// so the equality case is checked separately.
    private static func assertNotSelfNesting(source: URL, destinationDir: URL) throws {
        if ExplorerPaths.key(source) == ExplorerPaths.key(destinationDir) {
            throw ExplorerFileError.cannotMoveIntoSelf
        }
        if ExplorerPaths.isDescendant(destinationDir, of: source) {
            throw ExplorerFileError.cannotMoveIntoSelf
        }
    }

    /// Move `source` INTO the directory `destinationDir`, keeping its name.
    /// Returns the new URL.
    ///
    /// Never overwrites: a name collision throws `.alreadyExists` rather than
    /// silently destroying the destination file (unlike copy, which
    /// auto-uniquifies — a drag that clobbers a file is a data-loss bug, a
    /// drag that produces "x copy.txt" is Finder behavior).
    ///
    /// Moving into the directory the item already lives in is a no-op that
    /// returns the original URL — a drag that lands where it started must not
    /// throw at the user.
    @discardableResult
    static func move(from source: URL, to destinationDir: URL) throws -> URL {
        try assertNotSelfNesting(source: source, destinationDir: destinationDir)
        let dest = destinationDir.appendingPathComponent(source.lastPathComponent)
        if ExplorerPaths.key(dest) == ExplorerPaths.key(source) { return source }
        guard !FileManager.default.fileExists(atPath: dest.path) else {
            throw ExplorerFileError.alreadyExists
        }
        try FileManager.default.moveItem(at: source, to: dest)
        return dest
    }

    /// Copy `source` INTO the directory `destinationDir`, auto-uniquifying the
    /// name Finder-style on collision. Returns the new URL.
    @discardableResult
    static func copy(from source: URL, to destinationDir: URL) throws -> URL {
        try assertNotSelfNesting(source: source, destinationDir: destinationDir)
        let dest = uniqueDestination(in: destinationDir, name: source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: dest)
        return dest
    }

    /// A free URL for `name` inside `dir`, following Finder's naming:
    /// `a.txt` → `a copy.txt` → `a copy 2.txt` → `a copy 3.txt`. The base name
    /// and extension are split with `deletingPathExtension`/`pathExtension`
    /// so a dotted directory name (`my.notes`) keeps its suffix intact.
    ///
    /// The loop is bounded: after 1000 attempts it falls back to a UUID
    /// suffix rather than spinning forever on a pathological directory.
    static func uniqueDestination(in dir: URL, name: String) -> URL {
        let fm = FileManager.default
        let first = dir.appendingPathComponent(name)
        guard fm.fileExists(atPath: first.path) else { return first }

        let asURL = URL(fileURLWithPath: name)
        let ext = asURL.pathExtension
        let base = asURL.deletingPathExtension().lastPathComponent

        func candidate(_ suffix: String) -> URL {
            let stem = base + suffix
            return ext.isEmpty
                ? dir.appendingPathComponent(stem)
                : dir.appendingPathComponent(stem + "." + ext)
        }

        let plainCopy = candidate(" copy")
        if !fm.fileExists(atPath: plainCopy.path) { return plainCopy }
        for n in 2...1000 {
            let url = candidate(" copy \(n)")
            if !fm.fileExists(atPath: url.path) { return url }
        }
        return candidate(" copy \(UUID().uuidString)")
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerFileOpsTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all tests (the 6 pre-existing + the 11 new) pass. Expected HERE: `no such module 'XCTest'` — the test did not execute; say so explicitly.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift
git commit -m "feat(mac): ExplorerFileOps gains move/copy with collision and self-nesting guards"
```

---

### Task 3: `ExplorerTreeStore` core — async children cache, expansion, selection, displayRoot

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreTests.swift`

**Interfaces:**
- Consumes: `ExplorerPaths.key(_:)` (Task 1); the existing `FileSystemTree.children(of:) -> [FileSystemTree.Node]` and `FileSystemTree.Node { url, name, isDirectory, id: String }` (`Services/FileSystemTree.swift`).
- Produces:
  - `@MainActor @Observable final class ExplorerTreeStore`
  - `private(set) var children: [String: [FileSystemTree.Node]]` (keyed by `ExplorerPaths.key`)
  - `var expanded: Set<String>` (keyed by `ExplorerPaths.key`)
  - `var selection: Set<URL>`
  - `func children(of dir: URL) -> [FileSystemTree.Node]` (cache read, no I/O, no mutation)
  - `func isLoaded(_ dir: URL) -> Bool`
  - `func loadChildren(of dir: URL) async`
  - `func invalidate(_ dir: URL)`
  - `func reset()`
  - `func displayRoot(for root: URL) -> URL`
  - `func expand(_ dir: URL) async`
  - `func collapse(_ dir: URL)`
  - `func toggle(_ dir: URL) async`
  - `func collapseAll()`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ExplorerTreeStoreTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-tree-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    @discardableResult
    private func makeDir(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @discardableResult
    private func makeFile(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url
    }

    // MARK: - children cache

    func testChildrenIsEmptyBeforeLoadAndPopulatedAfter() async {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        XCTAssertTrue(store.children(of: root).isEmpty, "reading the cache must not hit the filesystem")
        XCTAssertFalse(store.isLoaded(root))

        await store.loadChildren(of: root)

        XCTAssertTrue(store.isLoaded(root))
        XCTAssertEqual(store.children(of: root).map(\.name), ["a.txt"])
    }

    func testChildrenAreDirectoriesFirstThenCaseInsensitiveByName() async {
        makeFile("Zebra.txt")
        makeFile("apple.txt")
        makeDir("src")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(store.children(of: root).map(\.name), ["src", "apple.txt", "Zebra.txt"])
    }

    func testInvalidateDropsOnlyThatDirectorysCache() async {
        makeFile("a.txt")
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.loadChildren(of: sub)

        store.invalidate(sub)

        XCTAssertTrue(store.isLoaded(root))
        XCTAssertFalse(store.isLoaded(sub))
    }

    func testReloadingAfterAFilesystemChangePicksUpTheNewFile() async {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertTrue(store.children(of: root).isEmpty)

        makeFile("late.txt")
        await store.loadChildren(of: root)

        XCTAssertEqual(store.children(of: root).map(\.name), ["late.txt"])
    }

    /// A trailing-slash directory URL and a plain one are the SAME directory —
    /// two cache entries here would double-load the tree and desync expansion.
    func testCacheKeyIgnoresTrailingSlash() async {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        let withSlash = URL(fileURLWithPath: root.path + "/", isDirectory: true)
        XCTAssertTrue(store.isLoaded(withSlash))
        XCTAssertEqual(store.children(of: withSlash).map(\.name), ["a.txt"])
    }

    // MARK: - expansion

    func testExpandLoadsChildrenAndCollapseKeepsThemCached() async {
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()

        await store.expand(sub)
        XCTAssertTrue(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertEqual(store.children(of: sub).map(\.name), ["b.txt"])

        store.collapse(sub)
        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertTrue(store.isLoaded(sub), "collapsing must not discard the cache")
    }

    func testToggleFlipsExpansion() async {
        let sub = makeDir("sub")
        let store = ExplorerTreeStore()
        await store.toggle(sub)
        XCTAssertTrue(store.expanded.contains(ExplorerPaths.key(sub)))
        await store.toggle(sub)
        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)))
    }

    func testCollapseAllClearsExpansionButNotTheCache() async {
        let a = makeDir("a")
        let b = makeDir("b")
        let store = ExplorerTreeStore()
        await store.expand(a)
        await store.expand(b)

        store.collapseAll()

        XCTAssertTrue(store.expanded.isEmpty)
        XCTAssertTrue(store.isLoaded(a))
        XCTAssertTrue(store.isLoaded(b))
    }

    func testResetClearsEverything() async {
        let a = makeDir("a")
        let store = ExplorerTreeStore()
        await store.expand(a)
        store.selection = [a]

        store.reset()

        XCTAssertTrue(store.expanded.isEmpty)
        XCTAssertTrue(store.selection.isEmpty)
        XCTAssertFalse(store.isLoaded(a))
        XCTAssertFalse(store.isLoaded(root))
    }

    // MARK: - displayRoot

    func testDisplayRootDescendsIntoASingleChildFolder() async {
        let repo = makeDir("only-repo")
        makeFile("only-repo/README.md")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(repo))
    }

    func testDisplayRootStaysAtRootForMultipleChildren() async {
        makeDir("repo-a")
        makeDir("repo-b")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(root))
    }

    func testDisplayRootStaysAtRootForASingleFileChild() async {
        makeFile("solo.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(root),
                       "a lone FILE must not become the display root")
    }

    func testDisplayRootStaysAtRootBeforeChildrenAreLoaded() {
        makeDir("only-repo")
        let store = ExplorerTreeStore()
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(root),
                       "displayRoot must be pure — it may not trigger a load")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStoreTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — the test did not execute; record that verbatim.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `cannot find 'ExplorerTreeStore' in scope`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift`:

```swift
import Foundation
import Observation

/// The Explorer file tree's model — children cache, expansion set, and
/// selection — extracted from `ExplorerView`'s `@State`.
///
/// Why this exists (design §3, finding #9): `ExplorerView.children(of:)` wrote
/// into a `@State` dictionary from inside `body`, which SwiftUI explicitly
/// forbids ("Modifying state during view update"). Moving the cache into an
/// `@Observable` model with an explicit `async` load makes the write happen in
/// a task, not during view evaluation, and makes every rule here testable
/// without a UI.
///
/// Every dictionary/set key goes through `ExplorerPaths.key(_:)` — one
/// normalizer for the cache, the expansion set, persistence, and refresh, so a
/// trailing slash or a `.` component can never split one directory into two
/// entries.
@MainActor @Observable
final class ExplorerTreeStore {
    /// Directory key (`ExplorerPaths.key`) → that directory's children. A
    /// MISSING key means "never loaded"; an EMPTY array means "loaded, and it
    /// really is empty" — the two must stay distinguishable or an empty
    /// folder would be re-enumerated on every render.
    private(set) var children: [String: [FileSystemTree.Node]] = [:]

    /// Keys of the directories the user has expanded.
    var expanded: Set<String> = []

    /// Selected rows. A `Set<URL>` because `List(selection:)` requires a set
    /// of the row `ID` type, and `ExplorerTreeStore.Row.ID` is `URL`.
    var selection: Set<URL> = []

    // MARK: - Cache reads (pure — safe to call from `body`)

    /// Cached children of `dir`, or `[]` when it has not been loaded. Never
    /// touches the filesystem and never mutates: this is the accessor a view
    /// body may call.
    func children(of dir: URL) -> [FileSystemTree.Node] {
        children[ExplorerPaths.key(dir)] ?? []
    }

    func isLoaded(_ dir: URL) -> Bool {
        children[ExplorerPaths.key(dir)] != nil
    }

    // MARK: - Loading

    /// Enumerate `dir` one level deep and store the result. The blocking
    /// `FileManager` walk runs off the main actor (`Task.detached`) so a slow
    /// directory can't stall the UI — the reason this is `async` and
    /// `children(of:)` is not.
    ///
    /// Re-loading an already-loaded directory is intentional and cheap: it is
    /// how `invalidate` + reload and the file watcher refresh a folder.
    func loadChildren(of dir: URL) async {
        let nodes = await Task.detached(priority: .userInitiated) {
            FileSystemTree.children(of: dir)
        }.value
        children[ExplorerPaths.key(dir)] = nodes
    }

    /// Forget `dir`'s children so the next `loadChildren(of:)` re-enumerates.
    func invalidate(_ dir: URL) {
        children.removeValue(forKey: ExplorerPaths.key(dir))
    }

    /// Drop every piece of per-workspace state. Called when the active project
    /// changes, so one project's tree, expansion, and selection can never leak
    /// into the next (and the cache can't grow unbounded across switches).
    func reset() {
        children.removeAll()
        expanded.removeAll()
        selection.removeAll()
    }

    // MARK: - Expansion

    /// Expand `dir`, loading its children first if needed.
    func expand(_ dir: URL) async {
        if !isLoaded(dir) { await loadChildren(of: dir) }
        expanded.insert(ExplorerPaths.key(dir))
    }

    /// Collapse `dir`. The children stay cached — re-expanding is then
    /// instant, and a collapsed folder's cache is still what `refreshLoaded`
    /// keeps current.
    func collapse(_ dir: URL) {
        expanded.remove(ExplorerPaths.key(dir))
    }

    func toggle(_ dir: URL) async {
        if expanded.contains(ExplorerPaths.key(dir)) {
            collapse(dir)
        } else {
            await expand(dir)
        }
    }

    func collapseAll() {
        expanded.removeAll()
    }

    // MARK: - Display root

    /// Where the tree should actually start rendering.
    ///
    /// When the workspace root's only child is a single folder — the common
    /// single-repo case, where the root is the project's `code/` container and
    /// its one child is the cloned repo — display AT that folder instead of
    /// wrapping it in an extra collapsible row, mirroring VS Code opening a
    /// folder directly. A multi-repo project (2+ children) keeps each repo as
    /// its own top-level row.
    ///
    /// Pure by contract: it reads only already-cached children, so calling it
    /// from a view body cannot trigger filesystem work. Before `root` has been
    /// loaded it simply answers `root`, and the caller re-renders with the
    /// real answer once the load lands.
    func displayRoot(for root: URL) -> URL {
        let kids = children(of: root)
        if kids.count == 1, kids[0].isDirectory { return kids[0].url }
        return root
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStoreTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 12 tests pass. Expected HERE: `no such module 'XCTest'` — the test did not execute; say so explicitly.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift mac/Tests/LlmIdeMacTests/ExplorerTreeStoreTests.swift
git commit -m "feat(mac): add ExplorerTreeStore with an async children cache and expansion state"
```

---

### Task 4: `ExplorerTreeStore.flatten` — the visible tree as a flat `[Row]`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift` (add `Row` + `flatten`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreTests.swift` (append)

**Interfaces:**
- Consumes: `ExplorerTreeStore.children(of:)`, `.expanded`, `ExplorerPaths.key(_:)` (Tasks 1, 3).
- Produces:
  - `struct ExplorerTreeStore.Row: Identifiable, Hashable { let url: URL; let name: String; let isDirectory: Bool; let depth: Int; var id: URL { url } }`
  - `func flatten(from displayRoot: URL) -> [Row]`

Why flat: SwiftUI's `List(selection:)` needs a single collection whose element `ID` matches the selection element type. `Row.ID == URL` and `selection: Set<URL>` line up exactly. Indentation becomes the `depth` field, which `TreeRowLabel` already renders as indent guides — no `OutlineGroup`, which would fight the lazy per-level load.

- [ ] **Step 1: Write the failing test**

Append inside `ExplorerTreeStoreTests` (before its closing brace):

```swift
    // MARK: - flatten

    func testFlattenOfACollapsedTreeIsOnlyTheTopLevel() async {
        makeFile("a.txt")
        makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)

        let rows = store.flatten(from: root)

        XCTAssertEqual(rows.map(\.name), ["sub", "a.txt"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
        XCTAssertEqual(rows.map(\.isDirectory), [true, false])
    }

    func testFlattenIncludesChildrenOfExpandedFoldersWithIncreasingDepth() async {
        makeFile("a.txt")
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let deep = makeDir("sub/deep")
        makeFile("sub/deep/c.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        await store.expand(deep)

        let rows = store.flatten(from: root)

        XCTAssertEqual(rows.map(\.name), ["sub", "deep", "c.txt", "b.txt", "a.txt"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 2, 1, 0])
    }

    func testFlattenRowIdIsTheURL() async {
        let file = makeFile("a.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        let rows = store.flatten(from: root)
        XCTAssertEqual(rows.first?.id, rows.first?.url)
        XCTAssertEqual(ExplorerPaths.key(rows[0].url), ExplorerPaths.key(file))
    }

    /// An expanded folder whose children have not loaded yet contributes no
    /// child rows rather than crashing or blocking — the load lands later and
    /// the list re-renders.
    func testFlattenSkipsExpandedButUnloadedFolders() async {
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.expanded.insert(ExplorerPaths.key(sub))   // expanded WITHOUT loading

        let rows = store.flatten(from: root)

        XCTAssertEqual(rows.map(\.name), ["sub"])
    }

    func testFlattenFromAnUnloadedDisplayRootIsEmpty() {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        XCTAssertTrue(store.flatten(from: root).isEmpty)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStoreTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `value of type 'ExplorerTreeStore' has no member 'flatten'`.

- [ ] **Step 3: Write the implementation**

Add to `ExplorerTreeStore`, immediately after the `displayRoot(for:)` method:

```swift
    // MARK: - Flattening

    /// One rendered line of the tree. `id` is the `URL` so
    /// `List(selection: Set<URL>)` selects rows directly, with no separate
    /// id-to-url lookup table to keep in sync.
    struct Row: Identifiable, Hashable {
        let url: URL
        let name: String
        let isDirectory: Bool
        /// Indent level; 0 for a top-level row under `displayRoot`.
        let depth: Int
        var id: URL { url }
    }

    /// The currently VISIBLE tree, depth-first, as a flat array — the exact
    /// shape `List` wants.
    ///
    /// Recursion is bounded by `expanded`: a collapsed folder contributes one
    /// row and stops, and an expanded-but-not-yet-loaded folder also
    /// contributes one row (its children arrive on the next render after
    /// `loadChildren` completes). So this walks only what is on screen, never
    /// the whole filesystem.
    func flatten(from displayRoot: URL) -> [Row] {
        var rows: [Row] = []
        appendRows(of: displayRoot, depth: 0, into: &rows)
        return rows
    }

    private func appendRows(of dir: URL, depth: Int, into rows: inout [Row]) {
        for node in children(of: dir) {
            rows.append(Row(url: node.url, name: node.name,
                            isDirectory: node.isDirectory, depth: depth))
            guard node.isDirectory,
                  expanded.contains(ExplorerPaths.key(node.url)) else { continue }
            appendRows(of: node.url, depth: depth + 1, into: &rows)
        }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStoreTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 17 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift mac/Tests/LlmIdeMacTests/ExplorerTreeStoreTests.swift
git commit -m "feat(mac): ExplorerTreeStore.flatten renders the visible tree as URL-keyed rows"
```

---

### Task 5: `ExplorerTreeStore` persistence — expansion + selection survive relaunch

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift` (add `PersistedState`, `defaultsKey`, `persistState`, `restoreState`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerTreeStorePersistenceTests.swift`

**Interfaces:**
- Consumes: `ExplorerPaths.key(_:)`, `ExplorerPaths.relativePath(of:from:)` (Task 1); `ExplorerTreeStore.expanded`, `.selection`, `.expand(_:)` (Tasks 3, 4).
- Produces:
  - `static func defaultsKey(for root: URL) -> String`
  - `func persistState(for root: URL, defaults: UserDefaults = .standard)`
  - `func restoreState(for root: URL, defaults: UserDefaults = .standard) async`

Design §6.3 lists `persistState(for:)`/`restoreState(for:)`; the `defaults:` parameter is added purely so tests can use an isolated suite instead of polluting the developer's real `UserDefaults`.

Paths are stored **root-relative** so a project folder that moves (or a repo cloned to a different absolute path on another machine) still restores. Entries whose file no longer exists are dropped at restore — a deleted folder must not resurrect as a phantom expanded row.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerTreeStorePersistenceTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ExplorerTreeStorePersistenceTests: XCTestCase {
    var root: URL!
    var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-persist-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        suiteName = "explorer-tree-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    @discardableResult
    private func makeDir(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @discardableResult
    private func makeFile(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url
    }

    func testExpansionAndSelectionRoundTrip() async {
        let sub = makeDir("sub")
        let file = makeFile("sub/a.txt")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.selection = [file]
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)

        XCTAssertTrue(loader.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertEqual(loader.selection.map { ExplorerPaths.key($0) }, [ExplorerPaths.key(file)])
    }

    /// Restoring an expanded folder must also have LOADED it, or the tree
    /// renders the folder open and empty until the user pokes it.
    func testRestoreLoadsTheChildrenOfRestoredExpandedFolders() async {
        let sub = makeDir("sub")
        makeFile("sub/a.txt")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)

        XCTAssertTrue(loader.isLoaded(sub))
        XCTAssertEqual(loader.children(of: sub).map(\.name), ["a.txt"])
    }

    func testPathsThatNoLongerExistAreDropped() async {
        let doomedDir = makeDir("doomed")
        let doomedFile = makeFile("doomed/x.txt")
        let survivor = makeDir("survivor")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(doomedDir)
        await saver.expand(survivor)
        saver.selection = [doomedFile]
        saver.persistState(for: root, defaults: defaults)

        try? FileManager.default.removeItem(at: doomedDir)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)

        XCTAssertFalse(loader.expanded.contains(ExplorerPaths.key(doomedDir)))
        XCTAssertTrue(loader.expanded.contains(ExplorerPaths.key(survivor)))
        XCTAssertTrue(loader.selection.isEmpty)
    }

    /// Root-relative storage is what lets a moved/re-cloned project restore.
    func testStateRestoresUnderADifferentAbsoluteRoot() async {
        let sub = makeDir("sub")
        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        // Simulate the same project at a new path: copy the tree, then restore
        // using the ORIGINAL root's key but the NEW root's URLs.
        let moved = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-persist-moved-\(UUID().uuidString)")
        try? FileManager.default.copyItem(at: root, to: moved)
        defer { try? FileManager.default.removeItem(at: moved) }
        let raw = defaults.data(forKey: ExplorerTreeStore.defaultsKey(for: root))
        defaults.set(raw, forKey: ExplorerTreeStore.defaultsKey(for: moved))

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: moved, defaults: defaults)

        XCTAssertTrue(loader.expanded.contains(ExplorerPaths.key(moved.appendingPathComponent("sub"))))
    }

    func testRestoreWithNoStoredStateLeavesTheStoreEmpty() async {
        let store = ExplorerTreeStore()
        await store.restoreState(for: root, defaults: defaults)
        XCTAssertTrue(store.expanded.isEmpty)
        XCTAssertTrue(store.selection.isEmpty)
    }

    func testTwoRootsKeepSeparateState() async {
        let otherRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-persist-other-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: otherRoot) }
        let sub = makeDir("sub")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: otherRoot, defaults: defaults)
        XCTAssertTrue(loader.expanded.isEmpty)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStorePersistenceTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `type 'ExplorerTreeStore' has no member 'defaultsKey'`.

- [ ] **Step 3: Write the implementation**

Add to `ExplorerTreeStore`, after the flattening section:

```swift
    // MARK: - Persistence

    /// On-disk shape. Both arrays hold ROOT-RELATIVE paths (see
    /// `persistState`), so the same state restores after the project folder
    /// moves or is re-cloned to a different absolute path.
    private struct PersistedState: Codable {
        var expanded: [String]
        var selection: [String]
    }

    /// `UserDefaults` key for one workspace root. Keyed by the root's
    /// normalized absolute path so switching projects switches state instead
    /// of merging two trees into one.
    static func defaultsKey(for root: URL) -> String {
        "EXPLORER_TREE_STATE::" + ExplorerPaths.key(root)
    }

    /// Save expansion + selection for `root`. Anything outside `root` is
    /// skipped rather than stored absolutely — a half-relative, half-absolute
    /// blob would restore inconsistently after a move.
    func persistState(for root: URL, defaults: UserDefaults = .standard) {
        let expandedRel = expanded.compactMap { key -> String? in
            let rel = ExplorerPaths.relativePath(of: URL(fileURLWithPath: key), from: root)
            return (rel?.isEmpty == false) ? rel : nil
        }
        let selectionRel = selection.compactMap { url -> String? in
            let rel = ExplorerPaths.relativePath(of: url, from: root)
            return (rel?.isEmpty == false) ? rel : nil
        }
        let state = PersistedState(expanded: expandedRel.sorted(), selection: selectionRel.sorted())
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.defaultsKey(for: root))
    }

    /// Restore expansion + selection for `root`, dropping any entry whose file
    /// no longer exists (a deleted folder must not come back as a phantom
    /// expanded row), and LOADING the children of every restored expanded
    /// folder so the tree renders fully populated on first paint.
    ///
    /// A missing/corrupt blob is not an error: the tree simply starts
    /// collapsed, which is the same as a first run.
    func restoreState(for root: URL, defaults: UserDefaults = .standard) async {
        guard let data = defaults.data(forKey: Self.defaultsKey(for: root)),
              let state = try? JSONDecoder().decode(PersistedState.self, from: data) else { return }

        let fm = FileManager.default
        var restoredDirs: [URL] = []
        for rel in state.expanded {
            let url = root.appendingPathComponent(rel)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { continue }
            restoredDirs.append(url)
        }
        // Shallowest first, so a parent is loaded before its child is expanded.
        restoredDirs.sort { $0.pathComponents.count < $1.pathComponents.count }
        for dir in restoredDirs { await expand(dir) }

        selection = Set(state.selection.compactMap { rel -> URL? in
            let url = root.appendingPathComponent(rel)
            return fm.fileExists(atPath: url.path) ? url.standardizedFileURL : nil
        })
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStorePersistenceTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 6 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift mac/Tests/LlmIdeMacTests/ExplorerTreeStorePersistenceTests.swift
git commit -m "feat(mac): persist Explorer expansion and selection per workspace root"
```

---

### Task 6: `ExplorerTreeStore` live updates — `refreshLoaded` + its own `RepoFileWatcher`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift` (add `refreshLoaded`, `watcher`, `startWatching`, `stopWatching`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreWatchTests.swift`

**Interfaces:**
- Consumes: `ExplorerTreeStore.children`, `.expanded`, `.selection`, `.loadChildren(of:)` (Tasks 3–5); the existing `RepoFileWatcher.init?(repoRoot:debounce:onChange:)` and `.stop()` (`Services/RepoFileWatcher.swift`).
- Produces:
  - `func refreshLoaded() async`
  - `func startWatching(_ root: URL)`
  - `func stopWatching()`

This closes design §3 finding #5 for the Explorer (the FSEvents watcher exists but "is wired to nothing relevant"; Explorer relies on a manual Refresh button).

**Why a second watcher rather than `GitTruthStore.startWatching`:** design §11's P3 bullet says "live updates via `GitTruthStore.startWatching`", but that watcher is rooted at the **git working tree** and only refreshes git *status*. The Explorer tree is rooted at the project's `code/` container, which is frequently a DIFFERENT directory containing several clones and having no `.git` of its own. A watcher on the git root would miss a file created in a sibling repo, and refreshing git status would not re-enumerate any directory. So the store owns its own watcher on the **tree root**, at a **1.0s** debounce (`GitTruthStore` uses 2.0s) so structural changes feel more immediate than status changes. Both watchers run; they answer different questions.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerTreeStoreWatchTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ExplorerTreeStoreWatchTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-watch-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    @discardableResult
    private func makeFile(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url
    }

    @discardableResult
    private func makeDir(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - refreshLoaded

    func testRefreshLoadedRePopulatesEveryCachedDirectory() async {
        let sub = makeDir("sub")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.loadChildren(of: sub)

        makeFile("top.txt")
        makeFile("sub/nested.txt")
        await store.refreshLoaded()

        XCTAssertEqual(store.children(of: root).map(\.name), ["sub", "top.txt"])
        XCTAssertEqual(store.children(of: sub).map(\.name), ["nested.txt"])
    }

    func testRefreshLoadedDoesNotLoadDirectoriesThatWereNeverLoaded() async {
        let sub = makeDir("sub")
        makeFile("sub/nested.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)

        await store.refreshLoaded()

        XCTAssertFalse(store.isLoaded(sub), "refresh must not eagerly walk unopened folders")
    }

    func testRefreshLoadedForgetsVanishedDirectoriesAndPrunesState() async {
        let sub = makeDir("sub")
        let file = makeFile("sub/nested.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        store.selection = [file]

        try? FileManager.default.removeItem(at: sub)
        await store.refreshLoaded()

        XCTAssertFalse(store.isLoaded(sub))
        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertTrue(store.selection.isEmpty, "a selected file that no longer exists must be dropped")
    }

    // MARK: - watching

    func testStartWatchingRefreshesWhenAFileAppears() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertTrue(store.children(of: root).isEmpty)

        store.startWatching(root)
        defer { store.stopWatching() }

        makeFile("appeared.txt")

        // FSEvents plus the watcher's debounce is asynchronous and real-clock,
        // so poll instead of sleeping once — the same shape GitTruthStoreTests
        // uses for its own watcher assertion.
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline, store.children(of: root).isEmpty {
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTAssertEqual(store.children(of: root).map(\.name), ["appeared.txt"])
    }

    func testStopWatchingStopsFurtherRefreshes() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.startWatching(root)
        store.stopWatching()

        makeFile("appeared.txt")
        try await Task.sleep(nanoseconds: 2_500_000_000)   // > the store's own 1.0s debounce

        XCTAssertTrue(store.children(of: root).isEmpty,
                      "no refresh should have happened after stopWatching")
    }

    func testStartWatchingTwiceReplacesTheWatcherInsteadOfStacking() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.startWatching(root)
        store.startWatching(root)
        defer { store.stopWatching() }

        makeFile("appeared.txt")
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline, store.children(of: root).isEmpty {
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTAssertEqual(store.children(of: root).map(\.name), ["appeared.txt"])

        store.stopWatching()
        makeFile("second.txt")
        try await Task.sleep(nanoseconds: 2_500_000_000)
        XCTAssertEqual(store.children(of: root).map(\.name), ["appeared.txt"],
                       "one stopWatching must silence ALL watchers this store started")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStoreWatchTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `value of type 'ExplorerTreeStore' has no member 'refreshLoaded'`.

- [ ] **Step 3: Write the implementation**

Add to `ExplorerTreeStore`, after the persistence section:

```swift
    // MARK: - Live filesystem updates

    /// Re-enumerate every directory currently in the cache, and forget the
    /// ones that no longer exist (also pruning them from `expanded`, and
    /// pruning vanished files from `selection`).
    ///
    /// Deliberately does NOT load directories that were never opened: the
    /// tree's whole cost model is "one level at a time", and walking unopened
    /// folders on every filesystem event would undo that.
    func refreshLoaded() async {
        let fm = FileManager.default
        let loadedKeys = Array(children.keys)
        for key in loadedKeys {
            let url = URL(fileURLWithPath: key)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: key, isDirectory: &isDir), isDir.boolValue else {
                children.removeValue(forKey: key)
                expanded.remove(key)
                continue
            }
            await loadChildren(of: url)
        }
        selection = selection.filter { fm.fileExists(atPath: $0.path) }
    }

    private var watcher: RepoFileWatcher?

    /// Start live-refreshing the loaded part of the tree on filesystem changes
    /// under `root`.
    ///
    /// The debounce is **1.0s**, deliberately shorter than
    /// `GitTruthStore.startWatching`'s 2.0s: a file appearing in the tree
    /// should feel immediate, while a git-status recomputation (which shells
    /// out) can afford to coalesce longer. The two watchers are separate on
    /// purpose — this one is rooted at the TREE root (often a `code/`
    /// container holding several clones), which is frequently not the git
    /// working tree at all.
    ///
    /// Safe to call repeatedly: it replaces any existing watcher.
    /// `RepoFileWatcher.init?` returns nil if FSEvents can't start (rare); in
    /// that case this is a silent no-op and the toolbar's manual Refresh stays
    /// the fallback.
    func startWatching(_ root: URL) {
        stopWatching()
        watcher = RepoFileWatcher(repoRoot: root, debounce: 1.0) { [weak self] in
            // Fires on the watcher's own background queue — hop to the main
            // actor before touching `self`.
            Task { @MainActor in
                await self?.refreshLoaded()
            }
        }
    }

    func stopWatching() {
        watcher?.stop()
        watcher = nil
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerTreeStoreWatchTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 6 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerTreeStore.swift mac/Tests/LlmIdeMacTests/ExplorerTreeStoreWatchTests.swift
git commit -m "feat(mac): ExplorerTreeStore live-refreshes from its own FSEvents watcher"
```

---

### Task 7: Git truth swap — `Theme.color(for: Decoration)`, `TreeRowLabel` retype, delete `GitStatusStore`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Theme.swift` (add one method to the semantic-alias extension, next to `color(for: FileChange.Status)` at lines 165-175)
- Modify: `mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift` (line 17 `gitStatus` type; the `gitColor` computed property, lines 81-89)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (line 40 `decorations`; the git root; the `.task`/`.onChange` decoration hooks at lines 116-122)
- Delete: `mac/Sources/LlmIdeMac/Services/GitStatusStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/ThemeDecorationColorTests.swift`

**Interfaces:**
- Consumes: the existing `GitTruthStore.Decoration` (`.modified`, `.added`, `.untracked`, `.deleted`, `.conflicted`), `GitTruthStore.refresh(root:)`, `GitTruthStore.decoration(forAbsolute:root:isDirectory:)`, `GitTruthStore.startWatching(root:)`/`stopWatching()`; `Theme.success`/`.warning`/`.info`/`.danger`; `WorkspaceRoot.gitWorkingTree(config:projectStore:)`.
- Produces:
  - `func Theme.color(for decoration: GitTruthStore.Decoration) -> Color`
  - `TreeRowLabel.gitStatus: GitTruthStore.Decoration?` (retyped)
  - `GitStatusStore` no longer exists.

**This is the fix for design §3 finding #1.** The bug was never in the store's logic — it is that `ExplorerView` passes `<project>/code`, a container of clones with no `.git`, so `refresh` correctly degrades to "no decorations" and the tree renders permanently clean. Explorer keeps rooting its TREE at `activeProjectCodeDir`, but resolves git decorations against `WorkspaceRoot.gitWorkingTree(config:projectStore:)`. These are two different roots and must not be conflated.

The color mapping mirrors `Theme.color(for: FileChange.Status)` exactly — in particular `modified` → `info` (blue), replacing `TreeRowLabel`'s hardcoded amber. Explorer and Source Control now cannot show different colors for the same file.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ThemeDecorationColorTests.swift`:

```swift
import XCTest
import SwiftUI
@testable import LlmIdeMacLib

/// The Explorer tree and the Source Control changes list must never show
/// different colors for the same file. Both go through `Theme`, and this pins
/// the two mappings to each other case by case.
final class ThemeDecorationColorTests: XCTestCase {

    func testDecorationColorsMatchTheFileChangeStatusMappingOnEveryTheme() {
        for theme in Theme.all {
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.modified),
                           theme.color(for: FileChange.Status.modified),
                           "\(theme.id): modified must read as the same color in both panels")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.added),
                           theme.color(for: FileChange.Status.added), "\(theme.id): added")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.untracked),
                           theme.color(for: FileChange.Status.untracked), "\(theme.id): untracked")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.deleted),
                           theme.color(for: FileChange.Status.deleted), "\(theme.id): deleted")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.conflicted),
                           theme.color(for: FileChange.Status.conflicted), "\(theme.id): conflicted")
        }
    }

    /// No raw SwiftUI colors: every decoration color must be one of the
    /// palette's own semantic tokens, so Midnight reads correctly.
    func testEveryDecorationColorIsAPaletteToken() {
        for theme in Theme.all {
            let tokens: Set<Color> = [theme.success, theme.warning, theme.info, theme.danger]
            for decoration in [GitTruthStore.Decoration.modified, .added, .untracked, .deleted, .conflicted] {
                XCTAssertTrue(tokens.contains(theme.color(for: decoration)),
                              "\(theme.id): \(decoration) is not a Theme token")
            }
        }
    }

    func testModifiedIsInfoNotWarning() {
        // Pins the deliberate change away from TreeRowLabel's old hardcoded
        // amber: `modified` is the INFO hue, matching Source Control.
        XCTAssertEqual(Theme.dark.color(for: GitTruthStore.Decoration.modified), Theme.dark.info)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ThemeDecorationColorTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL — no `color(for:)` overload taking `GitTruthStore.Decoration`.

- [ ] **Step 3: Add the Theme mapping**

In `mac/Sources/LlmIdeMac/Models/Theme.swift`, in the `extension Theme` that holds the semantic aliases, immediately AFTER the existing `func color(for status: FileChange.Status) -> Color`:

```swift
    /// File-tree decoration color for a git decoration. Deliberately case-for-
    /// case identical to `color(for: FileChange.Status)` above: the Explorer
    /// tree and the Source Control changes list describe the same repository,
    /// so a file that is blue in one must be blue in the other. `TreeRowLabel`
    /// previously hardcoded its own amber/green/red hex triples, which is what
    /// let the two panels drift.
    func color(for decoration: GitTruthStore.Decoration) -> Color {
        switch decoration {
        case .added, .untracked: return success
        case .deleted: return danger
        case .conflicted: return warning
        case .modified: return info
        }
    }
```

- [ ] **Step 4: Retype `TreeRowLabel`**

In `mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift`:

Change the declaration (currently `var gitStatus: GitStatusStore.Decoration? = nil`) and add theme access. The struct's stored properties become:

```swift
struct TreeRowLabel: View {
    let name: String
    let isFolder: Bool
    let isExpanded: Bool      // ignored for files
    let depth: Int
    let isSelected: Bool
    var folderTint: Color? = nil   // nil → default folder color
    // file extension for FileIconKit (files only)
    var fileExtension: String = ""
    /// Git status decoration (nil → undecorated / clean). VS Code-style.
    var gitStatus: GitTruthStore.Decoration? = nil

    @EnvironmentObject private var theme: ThemeStore
```

Then replace the whole `gitColor` computed property (currently three hardcoded `Color(red:green:blue:)` literals plus `.orange`) with:

```swift
    /// Status color, from the active palette — never a raw literal. Shared
    /// with the Source Control changes list via `Theme.color(for:)`, so both
    /// panels agree and Midnight reads correctly.
    private var gitColor: Color? {
        gitStatus.map { theme.current.color(for: $0) }
    }
```

Leave `gitLetter` (M/A/U/D/C) exactly as it is — it switches on the same cases, which are unchanged in name.

`@EnvironmentObject var theme: ThemeStore` is safe here: `ThemeStore` is injected at the app root (`LlmIdeMacApp.swift:231`), and `TreeRowLabel`'s only two call sites — `ExplorerView` and `Views/Shared/FileTreePanel.swift` (lines 176 and 194, which pass no `gitStatus` and are unaffected by the retype) — both render inside that hierarchy.

- [ ] **Step 5: Point `ExplorerView` at `GitTruthStore` and the real git root**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`:

Replace the decorations state (currently `@State private var decorations = GitStatusStore()`):

```swift
    // Git status decorations for the file tree (VS Code-style coloring).
    @State private var decorations = GitTruthStore()
```

Add a `gitRoot` computed property immediately after the existing `root` property:

```swift
    /// The git working tree — a DIFFERENT root from `root` above.
    ///
    /// `root` is the tree root (`<project>/code`, a container of clones with
    /// no `.git` of its own). Passing that to the decoration store is exactly
    /// why Explorer's git colors were dead: `refresh` requires `root/.git` and
    /// correctly degraded to "no decorations". Decorations must resolve
    /// against the actual working tree instead.
    private var gitRoot: URL? {
        WorkspaceRoot.gitWorkingTree(config: config, projectStore: projectStore)
    }
```

Replace the two decoration hooks (currently `.task(id: root?.path) { await decorations.refresh(root: root) }` plus the `controlActiveState` `.onChange`) with:

```swift
        .task(id: gitRoot?.path) {
            await decorations.refresh(root: gitRoot)
            if let gitRoot { decorations.startWatching(root: gitRoot) } else { decorations.stopWatching() }
        }
        // Re-check git status when the window regains key focus (VS Code does
        // the same — picks up edits made via terminal/other tools). Kept even
        // with the watcher running: FSEvents can be missed while the app is
        // backgrounded.
        .onChange(of: controlActiveState) { _, state in
            if state == .key { Task { await decorations.refresh(root: gitRoot) } }
        }
        .onDisappear { decorations.stopWatching() }
```

Change both `decorations.decoration(forAbsolute:root:isDirectory:)` call sites — in `folderRow` (currently `let deco = root.flatMap { decorations.decoration(forAbsolute: node.url, root: $0, isDirectory: true) }`) and in `fileRow` (same shape with `isDirectory: false`) — to bind `gitRoot` instead of `root`:

```swift
        let deco = gitRoot.flatMap {
            decorations.decoration(forAbsolute: node.url, root: $0, isDirectory: true)
        }
```

```swift
        let deco = gitRoot.flatMap {
            decorations.decoration(forAbsolute: node.url, root: $0, isDirectory: false)
        }
```

Finally, change the four `Task { await decorations.refresh(root: root) }` calls inside `performFileOp`, `delete`, and `refreshAll` to `Task { await decorations.refresh(root: gitRoot) }`.

- [ ] **Step 6: Delete `GitStatusStore`**

```bash
git rm mac/Sources/LlmIdeMac/Services/GitStatusStore.swift
```

Then update the one stale doc reference so no comment names a deleted type. In `mac/Tests/LlmIdeMacTests/SCMParsersTests.swift` line 4, the header comment reads `/// StatusParser/UnifiedDiffParser feed GitStatusStore, GitGutter, and` — change `GitStatusStore` to `GitTruthStore`.

- [ ] **Step 7: Verify nothing still references the deleted type**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -rn --include="*.swift" "GitStatusStore" mac/Sources mac/Tests`
Expected: no output.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ThemeDecorationColorTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 3 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Theme.swift \
        mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ThemeDecorationColorTests.swift \
        mac/Tests/LlmIdeMacTests/SCMParsersTests.swift
# Step 6's `git rm` already staged the GitStatusStore.swift deletion.
git commit -m "fix(mac): Explorer git decorations resolve against the git working tree, via GitTruthStore"
```

---

### Task 8: `ExplorerTreeList` — `List(selection:)` replaces the hand-built `LazyVStack` tree

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift`
- Create: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift` (add `onToggleChevron`)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (state, tree pane, toolbar target, all behavior helpers; delete `treeRow`/`folderRow`/`fileRow`/`children(of:)`/`toggle`/`effectiveDisplayRoot`/`invalidate`/`expand`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift`

**Interfaces:**
- Consumes: `ExplorerTreeStore` (`flatten(from:)`, `Row`, `expanded`, `selection`, `expand`, `collapse`, `toggle`, `collapseAll`, `displayRoot(for:)`, `loadChildren(of:)`, `invalidate`, `reset`, `refreshLoaded`, `persistState`, `restoreState`, `startWatching`, `stopWatching`) from Tasks 3–6; `ExplorerPaths.key`/`.isDescendant`/`.relativePath` from Task 1; `GitTruthStore.decoration(forAbsolute:root:isDirectory:)`; `TreeRowLabel`.
- Produces:
  - `enum ExplorerKeyCommand: Equatable { case expand, collapse, open }` with
    `static func resolve(character: Character, command: Bool) -> ExplorerKeyCommand?`
  - `struct ExplorerActions { var open: (URL) -> Void; var newFile: (URL) -> Void; var newFolder: (URL) -> Void; var beginRename: (URL) -> Void; var delete: ([URL]) -> Void; var revealInFinder: ([URL]) -> Void }`
  - `struct ExplorerTreeList: View { let store: ExplorerTreeStore; let displayRoot: URL; let gitRoot: URL?; let git: GitTruthStore; let actions: ExplorerActions }`
  - `TreeRowLabel.onToggleChevron: (() -> Void)?`

**Selection type change (explicit):** `ExplorerView`'s `@State private var selectedURL: URL?` is **deleted**. Selection now lives on the store as `ExplorerTreeStore.selection: Set<URL>` (design §6.3). Every former reader of `selectedURL` is rewritten below: the `root?.path` reset hook, `toolbarTargetDir(displayRoot:)`, `performFileOp`, `delete`, and the two row builders (which are deleted outright).

**Keyboard division of labor:** ↑/↓ are NOT handled here — `List` already moves its own selection correctly, and intercepting them would break ⇧-extend. Only →/←/⏎ are claimed. `ExplorerKeyCommand.resolve` returns `nil` for everything else, and the handler returns `.ignored`, so unclaimed keys (including ↑/↓ and anything typed in the toolbar) pass straight through.

`ExplorerKeyCommand` lives under `Services/` (not `Views/Explorer/`) so its test compiles in a build where the `file_explorer` feature is excluded — see the placement rule in File Structure.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

final class ExplorerKeyCommandTests: XCTestCase {

    func testArrowKeysExpandAndCollapse() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F703}", command: false), .expand)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F702}", command: false), .collapse)
    }

    func testReturnOpens() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\r", command: false), .open)
    }

    /// ↑/↓ belong to `List` — claiming them would break its own selection
    /// movement and ⇧-extend.
    func testVerticalArrowsAreNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F700}", command: false))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F701}", command: false))
    }

    func testUnknownKeysAreNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "a", command: false))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: " ", command: false))
    }

    /// ⌘→ / ⌘← are macOS text-navigation chords, not tree navigation — a
    /// command-modified arrow must not silently expand a folder.
    func testCommandModifiedArrowsAreNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F703}", command: true))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F702}", command: true))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\r", command: true))
    }

    /// Pins the scalars against SwiftUI's own constants, so a wrong literal
    /// here fails the test rather than silently making the arrow keys dead.
    func testScalarsMatchSwiftUIKeyEquivalents() {
        XCTAssertEqual(ExplorerKeyCommand.rightArrow, KeyEquivalent.rightArrow.character)
        XCTAssertEqual(ExplorerKeyCommand.leftArrow, KeyEquivalent.leftArrow.character)
        XCTAssertEqual(ExplorerKeyCommand.returnKey, KeyEquivalent.return.character)
    }
}
```

Add `import SwiftUI` at the top of that test file (the last test references `KeyEquivalent`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerKeyCommandTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `cannot find 'ExplorerKeyCommand' in scope`.

- [ ] **Step 3: Write `ExplorerKeyCommand`**

Create `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift`:

```swift
import Foundation

/// Pure key → Explorer-tree-command routing, so the tree's `onKeyPress`
/// handler stays a two-line call and every binding decision is testable
/// without a running view.
///
/// Deliberately NOT handling ↑/↓: SwiftUI's `List` already moves its own
/// selection (including ⇧-extend), and returning a command for those would
/// require reimplementing that correctly. `resolve` answers `nil` for them,
/// the handler returns `.ignored`, and `List` gets the key.
enum ExplorerKeyCommand: Equatable {
    case expand
    case collapse
    case open

    /// The AppKit function-key scalars SwiftUI's `KeyEquivalent` constants
    /// carry (`NSRightArrowFunctionKey` = 0xF703, `NSLeftArrowFunctionKey` =
    /// 0xF702). Named here rather than inlined so `ExplorerKeyCommandTests`
    /// can pin them against `KeyEquivalent.rightArrow.character` — a wrong
    /// literal would otherwise show up only as dead arrow keys in the app.
    static let rightArrow: Character = "\u{F703}"
    static let leftArrow: Character = "\u{F702}"
    static let returnKey: Character = "\r"

    /// `command` is whether ⌘ was held. Command-modified keys are never claimed
    /// here: ⌘←/⌘→ are macOS line-navigation chords, and ⌘⏎ is reserved.
    static func resolve(character: Character, command: Bool) -> ExplorerKeyCommand? {
        guard !command else { return nil }
        switch character {
        case rightArrow: return .expand
        case leftArrow:  return .collapse
        case returnKey:  return .open
        default:         return nil
        }
    }
}
```

- [ ] **Step 4: Add `onToggleChevron` to `TreeRowLabel`**

In `mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift`, add one stored property after `gitStatus`:

```swift
    /// When non-nil (Explorer's `List`-based tree), the disclosure chevron
    /// becomes its own button, so expanding a folder does NOT go through the
    /// row's click. That separation is what makes ⌘/⇧ multi-select work on
    /// folders — clicking a folder's body selects it like any other row
    /// instead of also toggling it. `nil` (Library's `FileTreePanel`) keeps
    /// the previous static chevron and needs no change.
    var onToggleChevron: (() -> Void)? = nil
```

Then, in `body`'s `if isFolder` branch, replace the single chevron `Image(...)` with:

```swift
                if let onToggleChevron {
                    Button(action: onToggleChevron) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 10)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isExpanded ? "Collapse \(name)" : "Expand \(name)")
                } else {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 10)
                }
```

- [ ] **Step 5: Write `ExplorerTreeList`**

Create `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`:

```swift
import SwiftUI
import AppKit

/// Everything the Explorer tree can DO, injected as closures.
///
/// The list and its rows stay presentation-only: they never touch the
/// filesystem, never present a sheet, and never own tab state — all of that
/// belongs to `ExplorerView`, which builds this bundle. That is what keeps the
/// tree renderable in isolation and keeps destructive work in one auditable
/// place.
struct ExplorerActions {
    var open: (URL) -> Void
    var newFile: (URL) -> Void
    var newFolder: (URL) -> Void
    var beginRename: (URL) -> Void
    var delete: ([URL]) -> Void
    var revealInFinder: ([URL]) -> Void
}

/// The file tree, as a real `List` with a `Set<URL>` selection.
///
/// Replaces the previous `ScrollView` + `LazyVStack` + per-row `Button`, which
/// could not do multi-select, had no keyboard navigation, and highlighted only
/// the label's own width instead of the full row. `List(selection:)` gives all
/// three for free — plus ⌘-click toggle and ⇧-click range — because it is the
/// same control the rest of macOS uses.
///
/// Rows come from `ExplorerTreeStore.flatten(from:)` as a FLAT array whose
/// element `ID` is the row's `URL`, which is what lets `selection` be a plain
/// `Set<URL>` with no id↔url lookup table to keep in sync. Indentation is the
/// row's `depth`, rendered by `TreeRowLabel`'s existing indent guides.
struct ExplorerTreeList: View {
    let store: ExplorerTreeStore
    let displayRoot: URL
    /// The git WORKING TREE (not the tree root) — see `ExplorerView.gitRoot`.
    let gitRoot: URL?
    let git: GitTruthStore
    let actions: ExplorerActions

    /// `List` needs a `Binding`; `store` is an `@Observable` reference type
    /// held as a plain `let`, so the binding is written out rather than
    /// obtained from `@Bindable`. Reading `store.selection` inside `body` is
    /// what registers the observation.
    private var selectionBinding: Binding<Set<URL>> {
        Binding(get: { store.selection }, set: { store.selection = $0 })
    }

    var body: some View {
        List(store.flatten(from: displayRoot), selection: selectionBinding) { row in
            ExplorerTreeRow(row: row, store: store, gitRoot: gitRoot, git: git, actions: actions)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
        }
        .listStyle(.sidebar)
        .onKeyPress(phases: .down) { press in
            guard let command = ExplorerKeyCommand.resolve(
                character: press.key.character,
                command: press.modifiers.contains(.command)) else { return .ignored }
            handle(command)
            return .handled
        }
    }

    /// The row keyboard commands act on: the FIRST selected row in display
    /// order. Resolving through `flatten` rather than `selection.first` keeps
    /// this deterministic — `Set` iteration order is not.
    private var focusedRow: ExplorerTreeStore.Row? {
        let selected = store.selection
        guard !selected.isEmpty else { return nil }
        return store.flatten(from: displayRoot).first { selected.contains($0.url) }
    }

    private func handle(_ command: ExplorerKeyCommand) {
        guard let row = focusedRow else { return }
        switch command {
        case .expand:
            guard row.isDirectory else { return }
            Task { await store.expand(row.url) }
        case .collapse:
            if row.isDirectory, store.expanded.contains(ExplorerPaths.key(row.url)) {
                store.collapse(row.url)
            } else {
                // VS Code: ← on a leaf (or an already-collapsed folder) walks
                // up to the parent and collapses it — but never past the
                // display root, which has no row of its own.
                let parent = row.url.deletingLastPathComponent()
                guard ExplorerPaths.isDescendant(parent, of: displayRoot) else { return }
                store.selection = [parent]
                store.collapse(parent)
            }
        case .open:
            if row.isDirectory {
                Task { await store.toggle(row.url) }
            } else {
                actions.open(row.url)
            }
        }
    }
}

/// One row: the shared `TreeRowLabel` plus this tree's context menu.
private struct ExplorerTreeRow: View {
    let row: ExplorerTreeStore.Row
    let store: ExplorerTreeStore
    let gitRoot: URL?
    let git: GitTruthStore
    let actions: ExplorerActions

    var body: some View {
        let decoration = gitRoot.flatMap {
            git.decoration(forAbsolute: row.url, root: $0, isDirectory: row.isDirectory)
        }
        TreeRowLabel(
            name: row.name,
            isFolder: row.isDirectory,
            isExpanded: store.expanded.contains(ExplorerPaths.key(row.url)),
            depth: row.depth,
            isSelected: store.selection.contains(row.url),
            fileExtension: row.isDirectory ? "" : row.url.pathExtension.lowercased(),
            gitStatus: decoration,
            onToggleChevron: row.isDirectory ? { Task { await store.toggle(row.url) } } : nil
        )
        .help(row.name)
        .contextMenu { contextMenuItems }
    }

    /// Right-clicking a row that is part of the current selection acts on the
    /// WHOLE selection; right-clicking outside it acts on just that row. Same
    /// rule the Source Control changes list uses, so the two panels behave
    /// identically. (SwiftUI's `List` does not select on right-click, which is
    /// why this has to be resolved explicitly.)
    private var targets: [URL] {
        store.selection.contains(row.url) ? Array(store.selection) : [row.url]
    }

    /// Where "New File"/"New Folder" create: inside a folder row, alongside a
    /// file row.
    private var enclosingDir: URL {
        row.isDirectory ? row.url : row.url.deletingLastPathComponent()
    }

    @ViewBuilder
    private var contextMenuItems: some View {
        Button("New File") { actions.newFile(enclosingDir) }
        Button("New Folder") { actions.newFolder(enclosingDir) }
        Button("Rename") { actions.beginRename(row.url) }
        Button(targets.count > 1 ? "Delete \(targets.count) Items" : "Delete",
               role: .destructive) { actions.delete(targets) }
        Divider()
        Button("Reveal in Finder") { actions.revealInFinder(targets) }
    }
}
```

- [ ] **Step 6: Rewrite `ExplorerView` onto the store**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`:

**6a — state.** Delete `@State private var expanded: Set<String> = []`, `@State private var childrenCache: [String: [FileSystemTree.Node]] = [:]`, and `@State private var selectedURL: URL?` (with their comment blocks). In their place, above the editor-tab state:

```swift
    /// The tree's model — children cache, expansion, and selection. Replaces
    /// the three `@State` properties that used to live here; `children(of:)`
    /// wrote into one of them from inside `body`, which SwiftUI forbids
    /// (design §3 finding #9).
    @State private var store = ExplorerTreeStore()
```

Change `@State private var pendingDelete: URL?` to:

```swift
    /// Pending trash targets (empty = no confirmation showing). A LIST because
    /// the tree is multi-select now.
    @State private var pendingDelete: [URL] = []
```

**6b — lifecycle.** Delete the whole `.onChange(of: root?.path) { ... }` reset block. Replace it with a `.task(id:)` that resets, loads, restores, and starts watching — placed immediately before the decoration `.task(id: gitRoot?.path)` added in Task 7:

```swift
        // Rebuild all per-project tree state when the active project changes,
        // so one project's tree/selection/tabs never show under another.
        .task(id: root?.path) {
            store.reset()
            tabs.removeAll()
            activeTab = nil
            guard let root else { store.stopWatching(); return }
            await store.loadChildren(of: root)
            let shown = store.displayRoot(for: root)
            if shown != root { await store.loadChildren(of: shown) }
            await store.restoreState(for: root)
            store.startWatching(root)
        }
        // Persist expansion/selection as they change (cheap: one small JSON
        // blob), so a crash or a force-quit doesn't lose the tree's shape.
        .onChange(of: store.expanded) { _, _ in
            if let root { store.persistState(for: root) }
        }
        .onChange(of: store.selection) { _, selection in
            if let root { store.persistState(for: root) }
            // VS Code opens on single click. `List` selection IS the click, so
            // opening happens here rather than in a tap gesture — a tap gesture
            // on a `List` row would fight the control's own selection handling.
            if selection.count == 1, let url = selection.first, !isDirectory(url) {
                open(url)
            }
        }
        .onDisappear {
            store.stopWatching()
            if let root { store.persistState(for: root) }
        }
```

**6c — tree pane.** Replace the `ScrollView { LazyVStack { ForEach(children(of: displayRoot)) { treeRow($0, depth: 0) } } ... }` block, and the `let displayRoot = effectiveDisplayRoot(root)` line above it, so `treePane` becomes:

```swift
    @ViewBuilder
    private var treePane: some View {
        if let root {
            // Single-repo case: when the root's only child is one folder (the
            // root is the project's `code/` container and its one child is the
            // clone), display AT that folder rather than wrapping it in an
            // extra collapsible row. Owned by the store now — see
            // `ExplorerTreeStore.displayRoot(for:)`.
            let displayRoot = store.displayRoot(for: root)
            VStack(spacing: 0) {
                treeToolbar(root: root, displayRoot: displayRoot)
                Divider()
                ExplorerTreeList(store: store,
                                 displayRoot: displayRoot,
                                 gitRoot: gitRoot,
                                 git: decorations,
                                 actions: actions())
            }
        } else {
            emptyState
        }
    }
```

Delete `effectiveDisplayRoot(_:)` entirely (its logic now lives in `ExplorerTreeStore.displayRoot(for:)`).

**6d — toolbar.** In `treeToolbar(root:displayRoot:)`, change the displayRoot context menu's delete line from `Button("Delete") { pendingDelete = displayRoot }` to `Button("Delete") { pendingDelete = [displayRoot] }`. Everything else in the toolbar is unchanged.

Replace `toolbarTargetDir(displayRoot:)` with:

```swift
    /// Where the toolbar's New File / New Folder buttons create: the selected
    /// folder, the parent of a selected file, or `displayRoot` when nothing is
    /// selected. With a multi-selection the FIRST row in display order wins —
    /// resolved through `flatten` rather than `selection.first`, because `Set`
    /// iteration order is not stable and the target would otherwise jump
    /// between identical clicks.
    private func toolbarTargetDir(displayRoot: URL) -> URL {
        guard let anchor = store.flatten(from: displayRoot)
            .first(where: { store.selection.contains($0.url) })?.url else { return displayRoot }
        return isDirectory(anchor) ? anchor : anchor.deletingLastPathComponent()
    }
```

**6e — delete the old row builders.** Delete `treeRow(_:depth:)`, `folderRow(_:depth:expanded:)`, and `fileRow(_:depth:)` in full. `ExplorerTreeList` replaces all three.

**6f — behavior.** Delete `children(of:)`, `toggle(_:)`, `invalidate(_:)`, and `expand(_:)`. Replace the remaining behavior section (`open`, `performFileOp`, `delete`, `refreshAll`, `collapseAll`) with:

```swift
    // MARK: - Behavior

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }

    private func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    private func refreshGit() async {
        await decorations.refresh(root: gitRoot)
    }

    /// Re-enumerate `dir` and make sure it is expanded — the standard
    /// follow-up to any operation that changed a directory's contents.
    /// `invalidate` first, because `expand` only loads a directory the cache
    /// does not already hold.
    private func reload(_ dir: URL) async {
        store.invalidate(dir)
        await store.expand(dir)
    }

    /// The action bundle handed to the tree. Rebuilt on each render, which is
    /// fine: it is six closures over `self`, not state.
    private func actions() -> ExplorerActions {
        ExplorerActions(
            open: { open($0) },
            newFile: { filePrompt = .newFile(in: $0) },
            newFolder: { filePrompt = .newFolder(in: $0) },
            beginRename: { filePrompt = .rename(url: $0) },
            delete: { pendingDelete = $0 },
            revealInFinder: { NSWorkspace.shared.activateFileViewerSelecting($0) }
        )
    }

    /// Run a create/rename op, then refresh the affected folder + git
    /// decorations. Throws up to the sheet handler so a bad name surfaces
    /// inline instead of silently failing.
    private func performFileOp(_ prompt: FilePrompt, _ name: String) throws {
        switch prompt.mode {
        case .newFile:
            let url = try ExplorerFileOps.createFile(in: prompt.dir, name: name)
            store.selection = [url]
            open(url)
            Task { await reload(prompt.dir); await refreshGit() }
        case .newFolder:
            let url = try ExplorerFileOps.createFolder(in: prompt.dir, name: name)
            store.selection = [url]
            Task { await reload(prompt.dir); await refreshGit() }
        case .rename:
            guard let url = prompt.url else { return }
            let new = try ExplorerFileOps.rename(url, to: name)
            retarget(from: url, to: new)
        }
    }

    /// Follow a renamed/moved item: open tabs, the active tab, and the
    /// selection all point at the new URL rather than a path that no longer
    /// exists.
    private func retarget(from old: URL, to new: URL) {
        tabs = tabs.map { $0 == old ? new : $0 }
        if activeTab == old { activeTab = new }
        if store.selection.contains(old) {
            store.selection.remove(old)
            store.selection.insert(new)
        }
        Task { await reload(old.deletingLastPathComponent()); await refreshGit() }
    }

    /// Trash one or more items, close any tabs under them, refresh their
    /// parents. Stops at the first failure and reports it — a partial delete
    /// is visible in the tree after the refresh, so nothing is hidden.
    private func delete(_ urls: [URL]) {
        var parents: Set<String> = []
        do {
            for url in urls {
                try ExplorerFileOps.trash(url)
                parents.insert(ExplorerPaths.key(url.deletingLastPathComponent()))
                tabs.removeAll { $0 == url || ExplorerPaths.isDescendant($0, of: url) }
                if let active = activeTab, active == url || ExplorerPaths.isDescendant(active, of: url) {
                    activeTab = tabs.last
                }
                store.selection = store.selection.filter {
                    $0 != url && !ExplorerPaths.isDescendant($0, of: url)
                }
            }
        } catch {
            deleteError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
        Task {
            for parent in parents { await reload(URL(fileURLWithPath: parent)) }
            await refreshGit()
        }
    }

    /// Full tree + git refresh (toolbar Refresh). Re-enumerates every loaded
    /// folder rather than dropping the cache, so expansion survives.
    private func refreshAll() {
        Task { await store.refreshLoaded(); await refreshGit() }
    }

    /// Collapse every expanded folder (toolbar Collapse All), VS Code-style.
    private func collapseAll() {
        store.collapseAll()
    }
```

**6g — the delete confirmation.** Replace the existing `.confirmationDialog(...)` for `pendingDelete` with the multi-item form:

```swift
        .confirmationDialog(
            pendingDelete.count == 1
                ? "Move “\(pendingDelete[0].lastPathComponent)” to the Trash?"
                : "Move \(pendingDelete.count) items to the Trash?",
            isPresented: Binding(get: { !pendingDelete.isEmpty },
                                 set: { if !$0 { pendingDelete = [] } }),
            titleVisibility: .visible
        ) {
            Button("Move to Trash", role: .destructive) {
                let targets = pendingDelete
                pendingDelete = []
                delete(targets)
            }
            Button("Cancel", role: .cancel) { pendingDelete = [] }
        } message: {
            Text("You can undo this in Finder.")
        }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerKeyCommandTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 6 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20`
Expected: `Build complete!` — and no residual errors about `selectedURL`, `childrenCache`, `expanded`, `treeRow`, `folderRow`, `fileRow`, or `effectiveDisplayRoot`.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 8: Verify the old tree code is really gone**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -n "selectedURL\|childrenCache\|effectiveDisplayRoot\|func treeRow\|func folderRow\|func fileRow" mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift \
        mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift
git commit -m "feat(mac): Explorer tree becomes a List with multi-select and keyboard navigation"
```

---

### Task 9: `ResizableDivider` + persisted tree width

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shared/ResizableDivider.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (the `.frame(width: 240)` + `Divider()` in `body`'s `HStack`)
- Test: `mac/Tests/LlmIdeMacTests/ResizableDividerTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `struct ResizableDivider: View { @Binding var width: Double; var minWidth: Double = 160; var maxWidth: Double = 520 }`
  - `static func ResizableDivider.clamp(_ proposed: Double, minWidth: Double, maxWidth: Double) -> Double`

Closes the "tree width hardcoded to 240pt and non-resizable" half of design §3 finding #10. The tree column sits OUTSIDE the `HSplitView` (its comment explains why: `HSplitView` would not honor the leading child's width cap), so it cannot use the existing `persistedPanelWidth` modifier — that one reads a rendered `HSplitView` width back through a `GeometryReader`. A drag-driven divider is the equivalent for a fixed-width column.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ResizableDividerTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

final class ResizableDividerTests: XCTestCase {

    func testClampPassesThroughAValueInRange() {
        XCTAssertEqual(ResizableDivider.clamp(300, minWidth: 160, maxWidth: 520), 300)
    }

    func testClampPinsBelowMinimum() {
        XCTAssertEqual(ResizableDivider.clamp(40, minWidth: 160, maxWidth: 520), 160)
    }

    func testClampPinsAboveMaximum() {
        XCTAssertEqual(ResizableDivider.clamp(9000, minWidth: 160, maxWidth: 520), 520)
    }

    func testClampHandlesNegativeDragOvershoot() {
        XCTAssertEqual(ResizableDivider.clamp(-500, minWidth: 160, maxWidth: 520), 160)
    }

    /// A window narrower than `minWidth` can produce maxWidth < minWidth.
    /// Minimum must win — returning a value below `minWidth` would collapse
    /// the tree to an unusable sliver with no way to drag it back.
    func testClampPrefersMinimumWhenBoundsAreInverted() {
        XCTAssertEqual(ResizableDivider.clamp(300, minWidth: 400, maxWidth: 200), 400)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ResizableDividerTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `cannot find 'ResizableDivider' in scope`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Views/Shared/ResizableDivider.swift`:

```swift
import SwiftUI
import AppKit

/// A vertical `Divider` with an invisible 8pt drag handle over it, writing a
/// clamped width back to `width`.
///
/// This is the fixed-width-column counterpart to `persistedPanelWidth`. That
/// modifier works by reading an `HSplitView` child's RENDERED width back
/// through a `GeometryReader` — useless for a column that is pinned outside
/// the split view precisely because `HSplitView` would not respect its cap
/// (see `ExplorerView.body`'s comment). Here the drag is the source of truth.
///
/// Pair it with an `@AppStorage` binding and the width persists across
/// launches with no extra plumbing.
struct ResizableDivider: View {
    @Binding var width: Double
    var minWidth: Double = 160
    var maxWidth: Double = 520

    /// Width at the moment the drag began. `DragGesture.translation` is
    /// cumulative from the gesture's start, so accumulating it onto the LIVE
    /// width would apply each delta repeatedly and make the pane fly away.
    @State private var dragStartWidth: Double?

    /// Pure so the bounds behavior is testable without a gesture. `minWidth`
    /// wins if the bounds are inverted (a window narrower than the minimum),
    /// because a value below it leaves the user with a sliver they cannot
    /// grab to drag back.
    static func clamp(_ proposed: Double, minWidth: Double, maxWidth: Double) -> Double {
        min(max(proposed, minWidth), max(minWidth, maxWidth))
    }

    var body: some View {
        Divider()
            .overlay(alignment: .center) {
                Rectangle()
                    .fill(Color.clear)
                    .frame(width: 8)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { value in
                                let start = dragStartWidth ?? width
                                if dragStartWidth == nil { dragStartWidth = start }
                                width = Self.clamp(start + Double(value.translation.width),
                                                   minWidth: minWidth, maxWidth: maxWidth)
                            }
                            .onEnded { _ in dragStartWidth = nil }
                    )
                    .accessibilityLabel("Resize file tree")
            }
    }
}
```

- [ ] **Step 4: Use it in `ExplorerView`**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`, add the stored width next to the existing `@AppStorage("EXPLORER_CHAT_PANEL_WIDTH")` declaration:

```swift
    /// Persisted file-tree width. The tree column is pinned OUTSIDE the
    /// HSplitView (see `body`), so it gets an explicit draggable divider
    /// rather than `persistedPanelWidth`.
    @AppStorage("EXPLORER_TREE_WIDTH") private var treeWidth: Double = 240
```

Then in `body`'s `HStack`, replace the fixed frame and the plain divider:

```swift
                if treeVisible {
                    treePane
                        .frame(width: CGFloat(treeWidth))
                        .transition(.move(edge: .leading))
                    ResizableDivider(width: $treeWidth)
                }
```

(The surrounding comment about `HSplitView` not honoring a leading child's width cap still applies and should stay.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ResizableDividerTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 5 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/ResizableDivider.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ResizableDividerTests.swift
git commit -m "feat(mac): Explorer file tree is resizable and remembers its width"
```

---

### Task 10: Drag & drop (⌥ copies, multi-select aware)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ExplorerDragPayload.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift` (`ExplorerActions` gains `drop`; row gains `.draggable`/`.dropDestination`; list background gains a drop target)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (rename `deleteError` → `opError`; split `retarget` into `remap` + `retarget`; add `performDrop`; extend `actions()`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerDragPayloadTests.swift`

**Interfaces:**
- Consumes: `ExplorerPaths.key(_:)` (Task 1); `ExplorerFileOps.move(from:to:)`/`copy(from:to:)` (Task 2); `ExplorerActions` (Task 8).
- Produces:
  - `enum ExplorerDragPayload` with `static func encode(_ urls: [URL]) -> String` and `static func decode(_ text: String) -> [URL]`
  - `ExplorerActions.drop: (_ sources: [URL], _ destinationDir: URL, _ copy: Bool) -> Void`
  - `ExplorerView.remap(from old: URL, to new: URL)` (extracted from Task 8's `retarget`)

The payload is a plain `String` carrying newline-joined absolute paths, matching the codebase's existing `String`-based drag idiom (`Views/Issues/RepoKanbanPanel.swift:130,148`). A `String` Transferable needs no `UTType` registration and no `NSItemProvider` plumbing.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerDragPayloadTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

final class ExplorerDragPayloadTests: XCTestCase {

    func testSingleURLRoundTrips() {
        let url = URL(fileURLWithPath: "/tmp/proj/a.txt")
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode([url]))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/proj/a.txt"])
    }

    func testMultipleURLsRoundTripInOrder() {
        let urls = [URL(fileURLWithPath: "/tmp/a"), URL(fileURLWithPath: "/tmp/b"),
                    URL(fileURLWithPath: "/tmp/c")]
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode(urls))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/a", "/tmp/b", "/tmp/c"])
    }

    /// The CRLF trap: Swift treats "\r\n" as ONE Character, so splitting on
    /// `\.isNewline` yields two paths — splitting on the literal "\n" would
    /// leave a stray "\r" welded onto the first path and target a
    /// nonexistent file.
    func testDecodeHandlesCRLFSeparators() {
        let decoded = ExplorerDragPayload.decode("/tmp/a\r\n/tmp/b")
        XCTAssertEqual(decoded.map(\.path), ["/tmp/a", "/tmp/b"])
    }

    func testDecodeIgnoresBlankLinesAndTrailingSeparator() {
        let decoded = ExplorerDragPayload.decode("/tmp/a\n\n/tmp/b\n")
        XCTAssertEqual(decoded.map(\.path), ["/tmp/a", "/tmp/b"])
    }

    func testDecodeOfEmptyStringIsEmpty() {
        XCTAssertTrue(ExplorerDragPayload.decode("").isEmpty)
        XCTAssertTrue(ExplorerDragPayload.decode("   \n  ").isEmpty)
    }

    /// Spaces are legal in macOS filenames and must survive untouched — a
    /// trim would silently retarget "/tmp/ a .txt".
    func testPathsWithSpacesSurvive() {
        let url = URL(fileURLWithPath: "/tmp/my folder/a file.txt")
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode([url]))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/my folder/a file.txt"])
    }

    /// A newline IS legal in a macOS filename but cannot survive a
    /// newline-delimited payload. Encoding drops such a path rather than
    /// emitting one that decodes into two wrong paths — dropping a drag is
    /// recoverable, moving the wrong file is not.
    func testPathsContainingNewlinesAreDroppedRatherThanCorrupted() {
        let bad = URL(fileURLWithPath: "/tmp/we\nird.txt")
        let good = URL(fileURLWithPath: "/tmp/fine.txt")
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode([bad, good]))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/fine.txt"])
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerDragPayloadTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `cannot find 'ExplorerDragPayload' in scope`.

- [ ] **Step 3: Write `ExplorerDragPayload`**

Create `mac/Sources/LlmIdeMac/Services/ExplorerDragPayload.swift`:

```swift
import Foundation

/// The drag payload for Explorer tree rows: newline-joined absolute paths,
/// carried as a plain `String`.
///
/// `String` rather than `URL` or a custom `UTType`: it is the drag idiom this
/// codebase already uses (`RepoKanbanPanel`), it needs no `Transferable`
/// conformance of our own, and it lets ONE drag carry a whole multi-selection
/// — which `.draggable` cannot express any other way, since it hands over one
/// item per dragged row.
enum ExplorerDragPayload {
    /// Paths containing a newline are DROPPED, not encoded. Such a name is
    /// legal on macOS but cannot survive a newline-delimited payload; emitting
    /// it would decode into two paths and move an unrelated file. Losing a
    /// drag is recoverable, moving the wrong file is not.
    static func encode(_ urls: [URL]) -> String {
        urls.map { ExplorerPaths.key($0) }
            .filter { !$0.contains(where: \.isNewline) }
            .joined(separator: "\n")
    }

    /// Split on `\.isNewline`, never on the literal "\n": Swift treats "\r\n"
    /// as ONE Character, so a literal split would weld a stray "\r" onto the
    /// preceding path. Whitespace is NOT trimmed — leading/trailing spaces are
    /// legal in macOS filenames — so only genuinely blank lines are dropped.
    static func decode(_ text: String) -> [URL] {
        text.split(whereSeparator: \.isNewline)
            .map(String.init)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { URL(fileURLWithPath: $0) }
    }
}
```

- [ ] **Step 4: Add the `drop` action and the drag/drop modifiers**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`:

Add one field to `ExplorerActions`, after `revealInFinder`:

```swift
    /// Drag & drop landing. `copy` is true when ⌥ was held (Finder's
    /// convention); otherwise the sources are moved.
    var drop: (_ sources: [URL], _ destinationDir: URL, _ copy: Bool) -> Void
```

In `ExplorerTreeRow`, attach both modifiers to the `TreeRowLabel` — after `.help(row.name)` and BEFORE `.contextMenu`:

```swift
        .draggable(ExplorerDragPayload.encode(targets))
        .dropDestination(for: String.self) { items, _ in
            let sources = items.flatMap { ExplorerDragPayload.decode($0) }
            guard !sources.isEmpty else { return false }
            // Dropping on a FILE targets the folder it lives in, matching
            // Finder and VS Code — a file is never itself a container.
            let destination = row.isDirectory ? row.url : row.url.deletingLastPathComponent()
            actions.drop(sources, destination, NSEvent.modifierFlags.contains(.option))
            return true
        }
```

`targets` (defined in Task 8) is already exactly the right drag set: the whole selection when the dragged row is part of it, otherwise just that row.

In `ExplorerTreeList.body`, add a drop target for the empty space below the rows, so dragging to the bottom of the list moves to the tree root. Attach it to the `List` itself, after `.listStyle(.sidebar)`:

```swift
        .dropDestination(for: String.self) { items, _ in
            let sources = items.flatMap { ExplorerDragPayload.decode($0) }
            guard !sources.isEmpty else { return false }
            actions.drop(sources, displayRoot, NSEvent.modifierFlags.contains(.option))
            return true
        }
```

- [ ] **Step 5: Implement the drop in `ExplorerView`**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`:

**5a — rename the failure alert state.** `deleteError` now carries drop/paste failures too, so rename it to `opError`. Change the declaration:

```swift
    /// Any failed destructive operation (trash, drag-move, paste) — shown in
    /// the "Couldn't complete the operation" alert.
    @State private var opError: String?
```

and update its three other uses: the alert's `isPresented:`/`Button`/`Text` (`deleteError != nil` → `opError != nil`, `deleteError = nil` → `opError = nil`, `Text(deleteError ?? "")` → `Text(opError ?? "")`), and the assignment inside `delete(_:)`'s `catch` (`deleteError = ...` → `opError = ...`).

**5b — split `retarget`.** Replace Task 8's `retarget(from:to:)` with two functions, so a drop can remap many items and reload once:

```swift
    /// Point open tabs, the active tab, and the selection at `new` instead of
    /// `old`. Pure state remap — no filesystem work, no reload — so a
    /// multi-item move can call it per item and reload once at the end.
    private func remap(from old: URL, to new: URL) {
        tabs = tabs.map { $0 == old ? new : $0 }
        if activeTab == old { activeTab = new }
        if store.selection.contains(old) {
            store.selection.remove(old)
            store.selection.insert(new)
        }
    }

    /// Single-item rename/move: remap, then refresh the containing folder.
    private func retarget(from old: URL, to new: URL) {
        remap(from: old, to: new)
        Task { await reload(old.deletingLastPathComponent()); await refreshGit() }
    }
```

**5c — add `performDrop`.** Next to `delete(_:)`:

```swift
    /// Apply a drag & drop. ⌥ copies (Finder's convention); otherwise moves.
    ///
    /// Every source's ORIGINAL parent is refreshed alongside the destination,
    /// or a moved file would keep rendering in the folder it came from until
    /// the watcher's next tick. Self-nesting and name collisions are rejected
    /// by `ExplorerFileOps` and surface in the shared alert — this never
    /// overwrites anything.
    private func performDrop(_ sources: [URL], into destinationDir: URL, copy: Bool) {
        var touched: Set<String> = [ExplorerPaths.key(destinationDir)]
        do {
            for source in sources {
                if copy {
                    _ = try ExplorerFileOps.copy(from: source, to: destinationDir)
                } else {
                    let moved = try ExplorerFileOps.move(from: source, to: destinationDir)
                    touched.insert(ExplorerPaths.key(source.deletingLastPathComponent()))
                    remap(from: source, to: moved)
                }
            }
        } catch {
            opError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
        Task {
            for dir in touched { await reload(URL(fileURLWithPath: dir)) }
            await refreshGit()
        }
    }
```

**5d — wire it.** Add one line to `actions()`, after `revealInFinder`:

```swift
            drop: { sources, destination, copy in performDrop(sources, into: destination, copy: copy) }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerDragPayloadTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 7 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -n "deleteError" mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerDragPayload.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ExplorerDragPayloadTests.swift
git commit -m "feat(mac): Explorer tree supports multi-select drag and drop, option-drag copies"
```

---

### Task 11: Cut / copy / paste — `ExplorerClipboard` + `ExplorerFileOps.paste`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ExplorerClipboard.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift` (add `paste`)
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift` (add three cases)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift` (`ExplorerActions` gains four fields; menu items; key handling)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (clipboard state + `performPaste` + `actions()`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerClipboardTests.swift`
- Test: `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift` (append)

**Interfaces:**
- Consumes: `ExplorerFileOps.move`/`copy` (Task 2); `ExplorerActions`, `ExplorerKeyCommand.resolve` (Task 8); `ExplorerView.reload`/`remap`/`refreshGit`/`opError` (Tasks 8, 10).
- Produces:
  - `@MainActor @Observable final class ExplorerClipboard` with `enum Operation: Equatable { case cut, copy }`, `private(set) var urls: [URL]`, `private(set) var operation: Operation?`, `var isEmpty: Bool`, `func cut(_ urls: [URL])`, `func copy(_ urls: [URL])`, `func clear()`
  - `@discardableResult static func ExplorerFileOps.paste(_ urls: [URL], into dir: URL, move shouldMove: Bool) throws -> [URL]`
  - `ExplorerKeyCommand` gains `.cut`, `.copy`, `.paste`
  - `ExplorerActions` gains `cut: ([URL]) -> Void`, `copy: ([URL]) -> Void`, `paste: (URL) -> Void`, `canPaste: () -> Bool`

**Why not `NSPasteboard`:** the system pasteboard is global. Cutting a file here would then paste into a text field, an email, or another app's ⌘V, and conversely any unrelated ⌘C would make the Explorer's Paste item light up pointing at garbage. The clipboard is Explorer-internal on purpose.

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/ExplorerClipboardTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ExplorerClipboardTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-clip-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    // MARK: - clipboard state

    func testNewClipboardIsEmpty() {
        let clip = ExplorerClipboard()
        XCTAssertTrue(clip.isEmpty)
        XCTAssertNil(clip.operation)
        XCTAssertTrue(clip.urls.isEmpty)
    }

    func testCutRecordsUrlsAndOperation() {
        let clip = ExplorerClipboard()
        clip.cut([URL(fileURLWithPath: "/tmp/a"), URL(fileURLWithPath: "/tmp/b")])
        XCTAssertEqual(clip.operation, .cut)
        XCTAssertEqual(clip.urls.map(\.path), ["/tmp/a", "/tmp/b"])
        XCTAssertFalse(clip.isEmpty)
    }

    func testCopyReplacesAPreviousCut() {
        let clip = ExplorerClipboard()
        clip.cut([URL(fileURLWithPath: "/tmp/a")])
        clip.copy([URL(fileURLWithPath: "/tmp/b")])
        XCTAssertEqual(clip.operation, .copy)
        XCTAssertEqual(clip.urls.map(\.path), ["/tmp/b"])
    }

    func testCuttingNothingClearsTheClipboard() {
        let clip = ExplorerClipboard()
        clip.copy([URL(fileURLWithPath: "/tmp/a")])
        clip.cut([])
        XCTAssertTrue(clip.isEmpty)
        XCTAssertNil(clip.operation)
    }

    func testClearEmptiesEverything() {
        let clip = ExplorerClipboard()
        clip.copy([URL(fileURLWithPath: "/tmp/a")])
        clip.clear()
        XCTAssertTrue(clip.isEmpty)
        XCTAssertNil(clip.operation)
    }

    // MARK: - ExplorerFileOps.paste (real filesystem)

    func testPasteWithMoveRelocatesEveryItem() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let b = try ExplorerFileOps.createFile(in: root, name: "b.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")

        let results = try ExplorerFileOps.paste([a, b], into: dest, move: true)

        XCTAssertEqual(results.map(\.lastPathComponent), ["a.txt", "b.txt"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: a.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent("b.txt").path))
    }

    func testPasteWithCopyLeavesSourcesInPlace() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")

        let results = try ExplorerFileOps.paste([a], into: dest, move: false)

        XCTAssertTrue(FileManager.default.fileExists(atPath: a.path))
        XCTAssertEqual(results.map(\.lastPathComponent), ["a.txt"])
    }

    func testPasteCopyIntoTheSameFolderUniquifies() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let results = try ExplorerFileOps.paste([a], into: root, move: false)
        XCTAssertEqual(results.map(\.lastPathComponent), ["a copy.txt"])
    }

    func testPasteMoveIntoTheSameFolderIsANoOp() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let results = try ExplorerFileOps.paste([a], into: root, move: true)
        XCTAssertEqual(results.map(\.path), [a.path])
        XCTAssertTrue(FileManager.default.fileExists(atPath: a.path))
    }

    func testPasteMoveOntoAnExistingNameThrowsWithoutOverwriting() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        try "source".write(to: a, atomically: true, encoding: .utf8)
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")
        let clash = try ExplorerFileOps.createFile(in: dest, name: "a.txt")
        try "victim".write(to: clash, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try ExplorerFileOps.paste([a], into: dest, move: true)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .alreadyExists)
        }
        XCTAssertEqual(try String(contentsOf: clash, encoding: .utf8), "victim",
                       "paste must never overwrite an existing file")
    }
}
```

Append to `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift`, inside the existing class:

```swift
    func testCommandXCVAreCutCopyPaste() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "x", command: true), .cut)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "c", command: true), .copy)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "v", command: true), .paste)
    }

    func testCommandLettersAreCaseInsensitive() {
        // ⇧⌘C reports an uppercase character; it must still mean copy rather
        // than falling through as an unhandled key.
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "X", command: true), .cut)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "C", command: true), .copy)
    }

    func testBareLettersAreNotClipboardCommands() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "x", command: false))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "v", command: false))
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerClipboardTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `cannot find 'ExplorerClipboard' in scope` and `type 'ExplorerFileOps' has no member 'paste'`.

- [ ] **Step 3: Write `ExplorerClipboard`**

Create `mac/Sources/LlmIdeMac/Services/ExplorerClipboard.swift`:

```swift
import Foundation
import Observation

/// The Explorer's own cut/copy clipboard.
///
/// Deliberately NOT `NSPasteboard`: the system pasteboard is global, so a cut
/// here would leak file paths into an unrelated ⌘V (a text field, an email,
/// another app), and any unrelated ⌘C would make the Explorer's Paste item
/// light up pointing at content it cannot use. Scope is the whole point.
///
/// A cut is NOT applied until paste: the source stays on disk and stays
/// visible in the tree, exactly like Finder and VS Code. Cancelling is just
/// never pasting.
@MainActor @Observable
final class ExplorerClipboard {
    enum Operation: Equatable { case cut, copy }

    private(set) var urls: [URL] = []
    private(set) var operation: Operation?

    var isEmpty: Bool { urls.isEmpty }

    /// Mark `urls` for a move on the next paste. An empty list CLEARS the
    /// clipboard rather than arming an empty operation — "cut nothing" must
    /// not leave a stale previous copy pasteable.
    func cut(_ urls: [URL]) {
        set(urls, operation: .cut)
    }

    /// Mark `urls` for duplication on the next paste. Same empty-list rule.
    func copy(_ urls: [URL]) {
        set(urls, operation: .copy)
    }

    func clear() {
        urls = []
        operation = nil
    }

    private func set(_ urls: [URL], operation: Operation) {
        guard !urls.isEmpty else { clear(); return }
        self.urls = urls
        self.operation = operation
    }
}
```

- [ ] **Step 4: Add `ExplorerFileOps.paste`**

Append inside `enum ExplorerFileOps`, after `copy(from:to:)`:

```swift
    /// Apply a clipboard paste into `dir`: move each item when `shouldMove`
    /// (a cut), copy it otherwise. Returns the resulting URLs in input order.
    ///
    /// Stops at the first failure and rethrows — the items already processed
    /// stay processed. That is deliberate: silently continuing past an error
    /// would leave the user unable to tell which items landed, and rolling
    /// back a partially-applied move is itself a destructive operation.
    @discardableResult
    static func paste(_ urls: [URL], into dir: URL, move shouldMove: Bool) throws -> [URL] {
        var results: [URL] = []
        for url in urls {
            results.append(shouldMove ? try move(from: url, to: dir)
                                      : try copy(from: url, to: dir))
        }
        return results
    }
```

- [ ] **Step 5: Extend `ExplorerKeyCommand`**

In `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift`, add three cases and three branches:

```swift
enum ExplorerKeyCommand: Equatable {
    case expand
    case collapse
    case open
    case cut
    case copy
    case paste
```

and replace the `resolve` body with:

```swift
    static func resolve(character: Character, command: Bool) -> ExplorerKeyCommand? {
        if command {
            // ⇧⌘C reports "C", so compare lowercased — otherwise the shifted
            // chord falls through as an unhandled key.
            switch Character(character.lowercased()) {
            case "x": return .cut
            case "c": return .copy
            case "v": return .paste
            default:  return nil
            }
        }
        switch character {
        case rightArrow: return .expand
        case leftArrow:  return .collapse
        case returnKey:  return .open
        default:         return nil
        }
    }
```

`Character(character.lowercased())` is safe here: `Character.lowercased()` returns a `String` that is a single character for every ASCII letter, which is all this switch matches.

- [ ] **Step 6: Wire the actions, menu, and keys**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`:

Add four fields to `ExplorerActions`, after `drop`:

```swift
    var cut: ([URL]) -> Void
    var copy: ([URL]) -> Void
    /// Paste into this directory.
    var paste: (URL) -> Void
    /// Whether the clipboard currently holds anything — gates the menu item.
    var canPaste: () -> Bool
```

In `ExplorerTreeRow.contextMenuItems`, insert a clipboard group after the "New Folder" button and before "Rename":

```swift
        Divider()
        Button(targets.count > 1 ? "Cut \(targets.count) Items" : "Cut") { actions.cut(targets) }
        Button(targets.count > 1 ? "Copy \(targets.count) Items" : "Copy") { actions.copy(targets) }
        Button("Paste") { actions.paste(enclosingDir) }
            .disabled(!actions.canPaste())
        Divider()
```

In `ExplorerTreeList.handle(_:)`, the clipboard commands must work with NO row focused (paste into the display root), so restructure it — handle the clipboard cases BEFORE the `guard let row`:

```swift
    private func handle(_ command: ExplorerKeyCommand) {
        // Clipboard commands are valid with no selection: paste lands in the
        // display root. So they are resolved before the focused-row guard.
        switch command {
        case .cut:
            actions.cut(selectedInDisplayOrder)
            return
        case .copy:
            actions.copy(selectedInDisplayOrder)
            return
        case .paste:
            let target = focusedRow.map { $0.isDirectory ? $0.url : $0.url.deletingLastPathComponent() }
            actions.paste(target ?? displayRoot)
            return
        case .expand, .collapse, .open:
            break
        }
        guard let row = focusedRow else { return }
        switch command {
        case .expand:
            guard row.isDirectory else { return }
            Task { await store.expand(row.url) }
        case .collapse:
            if row.isDirectory, store.expanded.contains(ExplorerPaths.key(row.url)) {
                store.collapse(row.url)
            } else {
                let parent = row.url.deletingLastPathComponent()
                guard ExplorerPaths.isDescendant(parent, of: displayRoot) else { return }
                store.selection = [parent]
                store.collapse(parent)
            }
        case .open:
            if row.isDirectory {
                Task { await store.toggle(row.url) }
            } else {
                actions.open(row.url)
            }
        case .cut, .copy, .paste:
            break   // handled above
        }
    }

    /// The selection in display order — `Set` iteration order is not stable,
    /// and a cut/copy of several rows should keep the order the user sees.
    private var selectedInDisplayOrder: [URL] {
        let selected = store.selection
        guard !selected.isEmpty else { return [] }
        return store.flatten(from: displayRoot).map(\.url).filter { selected.contains($0) }
    }
```

- [ ] **Step 7: Implement paste in `ExplorerView`**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`, add the clipboard state next to `store`:

```swift
    /// Explorer-internal cut/copy clipboard — never `NSPasteboard`.
    @State private var clipboard = ExplorerClipboard()
```

Add `performPaste` next to `performDrop`:

```swift
    /// Apply the clipboard into `dir`. A cut is consumed (cleared) on a
    /// successful paste, matching Finder/VS Code — the same cut cannot be
    /// pasted twice. A copy stays armed so it can be pasted repeatedly.
    private func performPaste(into dir: URL) {
        guard let operation = clipboard.operation, !clipboard.isEmpty else { return }
        let sources = clipboard.urls
        let isMove = operation == .cut
        var touched: Set<String> = [ExplorerPaths.key(dir)]
        do {
            let results = try ExplorerFileOps.paste(sources, into: dir, move: isMove)
            if isMove {
                for (source, result) in zip(sources, results) {
                    touched.insert(ExplorerPaths.key(source.deletingLastPathComponent()))
                    remap(from: source, to: result)
                }
                clipboard.clear()
            }
            store.selection = Set(results)
        } catch {
            opError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
        Task {
            for parent in touched { await reload(URL(fileURLWithPath: parent)) }
            await refreshGit()
        }
    }
```

Add four lines to `actions()`, after `drop`:

```swift
            cut: { clipboard.cut($0) },
            copy: { clipboard.copy($0) },
            paste: { performPaste(into: $0) },
            canPaste: { !clipboard.isEmpty }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerClipboardTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 10 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerKeyCommandTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 9 tests pass. Expected HERE: same environment failure.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 9: Verify the system pasteboard was not used**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -n "NSPasteboard" mac/Sources/LlmIdeMac/Services/ExplorerClipboard.swift mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerClipboard.swift \
        mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift \
        mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ExplorerClipboardTests.swift \
        mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift
git commit -m "feat(mac): Explorer gains cut/copy/paste over an internal clipboard"
```

---

### Task 12: Inline rename (F2, Esc cancels)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift` (add `.rename` + the F2 scalar)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift` (`ExplorerActions` gains two fields; `ExplorerTreeList` gains two properties; `ExplorerTreeRow.body` rewritten wholesale)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (rename state; `beginRename` re-points; `commitRename`/`cancelRename`)
- Test: `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift` (append)

**Interfaces:**
- Consumes: `ExplorerFileOps.rename(_:to:)` (existing); `ExplorerActions.beginRename` (Task 8); `ExplorerView.retarget` (Tasks 8, 10).
- Produces:
  - `ExplorerKeyCommand` gains `.rename` and `static let f2Key: Character`
  - `ExplorerActions` gains `commitRename: (URL, String) -> Void` and `cancelRename: () -> Void`
  - `ExplorerTreeList` gains `var renamingURL: URL?` and `@Binding var renameText: String`

**`beginRename` changes meaning here.** Task 8 wired it to the existing `FileNamePromptSheet` (`filePrompt = .rename(url:)`) so rename never regressed mid-plan. It is now re-pointed at inline editing. The sheet's `.rename` mode stays in `FilePrompt`/`FileNamePromptSheet` untouched — it is still what the tree TOOLBAR's display-root context menu uses (that header is not a tree row, so it has nothing to edit inline).

**`ExplorerTreeRow.body` is rewritten WHOLESALE, not patched.** The row becomes a two-branch view (text field while renaming, label otherwise), and Task 10's `.draggable`/`.dropDestination` plus Task 11's `.contextMenu` must all end up on the **label** branch. Patching would silently attach a drag handler to the rename text field, making the field un-clickable.

**F2, not ⏎:** ⏎ is already "open" (Task 8), which is the VS Code binding. F2 is VS Code's rename on Windows/Linux and works on macOS keyboards with the function-key row.

- [ ] **Step 1: Write the failing test**

Append to `mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift`, inside the existing class:

```swift
    func testF2Renames() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F705}", command: false), .rename)
    }

    /// ⏎ must keep meaning "open" — rename deliberately lives on F2 because
    /// ⏎ is already taken.
    func testReturnStillOpensRatherThanRenaming() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\r", command: false), .open)
    }

    func testCommandF2IsNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F705}", command: true))
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerKeyCommandTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `type 'ExplorerKeyCommand' has no member 'rename'`.

- [ ] **Step 3: Add `.rename` to `ExplorerKeyCommand`**

In `mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift`, add the case:

```swift
    case rename
```

add the scalar next to the arrow constants:

```swift
    /// `NSF2FunctionKey` (0xF705). SwiftUI has no `KeyEquivalent.f2`
    /// constant, so the AppKit scalar is named here directly.
    static let f2Key: Character = "\u{F705}"
```

and add one branch to the non-command switch in `resolve`, before `default`:

```swift
        case f2Key:      return .rename
```

- [ ] **Step 4: Extend `ExplorerActions` and `ExplorerTreeList`**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`, add two fields to `ExplorerActions`, after `canPaste`:

```swift
    /// Apply an inline rename. The `String` is the edited name only (no
    /// path); the view never touches the filesystem itself.
    var commitRename: (URL, String) -> Void
    var cancelRename: () -> Void
```

Add two properties to `ExplorerTreeList`, after `actions`:

```swift
    /// The row currently being renamed inline, if any. Owned by
    /// `ExplorerView` so a project switch or a delete can clear it.
    var renamingURL: URL?
    @Binding var renameText: String
```

Handle the new key command in `handle(_:)`. Add a `.rename` branch to the second (focused-row) switch, and add `.rename` to the first switch's pass-through list so it falls through to the guard:

```swift
        case .expand, .collapse, .open, .rename:
            break
```

```swift
        case .rename:
            actions.beginRename(row.url)
```

and update the trailing no-op branch of the second switch to `case .cut, .copy, .paste: break   // handled above`.

Pass both through to the row inside `List`'s content closure:

```swift
            ExplorerTreeRow(row: row, store: store, gitRoot: gitRoot, git: git, actions: actions,
                            renamingURL: renamingURL, renameText: $renameText)
```

- [ ] **Step 5: Rewrite `ExplorerTreeRow` wholesale**

Replace the ENTIRE `private struct ExplorerTreeRow` (from `private struct ExplorerTreeRow: View {` through its closing brace) with:

```swift
/// One row: either the shared `TreeRowLabel` (with this tree's drag, drop and
/// context menu) or, while it is being renamed, an inline text field.
///
/// Written as two explicit branches rather than a modifier chain with an `if`
/// inside it: every interaction modifier belongs to the LABEL. A `.draggable`
/// left on the shared parent would sit on top of the text field and swallow
/// the clicks that place the caret.
private struct ExplorerTreeRow: View {
    let row: ExplorerTreeStore.Row
    let store: ExplorerTreeStore
    let gitRoot: URL?
    let git: GitTruthStore
    let actions: ExplorerActions
    let renamingURL: URL?
    @Binding var renameText: String

    @FocusState private var renameFocused: Bool

    var body: some View {
        if renamingURL == row.url {
            renameField
        } else {
            label
        }
    }

    // MARK: - Rename branch

    /// Indent matches `TreeRowLabel`'s own metrics so the field opens exactly
    /// where the name was: 14pt per indent level, then 4 + 10 (chevron or its
    /// file-side spacer) + 4 + 16 (icon) + 4 = 38pt of fixed lead-in.
    private var renameField: some View {
        HStack(spacing: 0) {
            Spacer().frame(width: CGFloat(row.depth) * 14 + 38)
            TextField("", text: $renameText)
                .textFieldStyle(.plain)
                .font(Typography.filename)
                .focused($renameFocused)
                .onSubmit { actions.commitRename(row.url, renameText) }
                // Esc. `onExitCommand` is the AppKit cancel hook; a `.keyboardShortcut`
                // would not fire while a text field owns the keyboard.
                .onExitCommand { actions.cancelRename() }
                .onAppear { renameFocused = true }
                .accessibilityLabel("Rename \(row.name)")
        }
        .padding(.vertical, 2)
    }

    // MARK: - Normal branch

    private var label: some View {
        let decoration = gitRoot.flatMap {
            git.decoration(forAbsolute: row.url, root: $0, isDirectory: row.isDirectory)
        }
        return TreeRowLabel(
            name: row.name,
            isFolder: row.isDirectory,
            isExpanded: store.expanded.contains(ExplorerPaths.key(row.url)),
            depth: row.depth,
            isSelected: store.selection.contains(row.url),
            fileExtension: row.isDirectory ? "" : row.url.pathExtension.lowercased(),
            gitStatus: decoration,
            onToggleChevron: row.isDirectory ? { Task { await store.toggle(row.url) } } : nil
        )
        .help(row.name)
        .draggable(ExplorerDragPayload.encode(targets))
        .dropDestination(for: String.self) { items, _ in
            let sources = items.flatMap { ExplorerDragPayload.decode($0) }
            guard !sources.isEmpty else { return false }
            // Dropping on a FILE targets the folder it lives in, matching
            // Finder and VS Code — a file is never itself a container.
            let destination = row.isDirectory ? row.url : row.url.deletingLastPathComponent()
            actions.drop(sources, destination, NSEvent.modifierFlags.contains(.option))
            return true
        }
        .contextMenu { contextMenuItems }
    }

    /// Right-clicking a row that is part of the current selection acts on the
    /// WHOLE selection; right-clicking outside it acts on just that row. Same
    /// rule the Source Control changes list uses, so the two panels behave
    /// identically. (SwiftUI's `List` does not select on right-click, which is
    /// why this has to be resolved explicitly.)
    private var targets: [URL] {
        store.selection.contains(row.url) ? Array(store.selection) : [row.url]
    }

    /// Where "New File"/"New Folder"/"Paste" land: inside a folder row,
    /// alongside a file row.
    private var enclosingDir: URL {
        row.isDirectory ? row.url : row.url.deletingLastPathComponent()
    }

    @ViewBuilder
    private var contextMenuItems: some View {
        Button("New File") { actions.newFile(enclosingDir) }
        Button("New Folder") { actions.newFolder(enclosingDir) }
        Divider()
        Button(targets.count > 1 ? "Cut \(targets.count) Items" : "Cut") { actions.cut(targets) }
        Button(targets.count > 1 ? "Copy \(targets.count) Items" : "Copy") { actions.copy(targets) }
        Button("Paste") { actions.paste(enclosingDir) }
            .disabled(!actions.canPaste())
        Divider()
        Button("Rename") { actions.beginRename(row.url) }
        Button(targets.count > 1 ? "Delete \(targets.count) Items" : "Delete",
               role: .destructive) { actions.delete(targets) }
        Divider()
        Button("Reveal in Finder") { actions.revealInFinder(targets) }
    }
}
```

- [ ] **Step 6: Wire rename state in `ExplorerView`**

Add state next to `clipboard`:

```swift
    /// Inline rename: which row is being edited, and its live text.
    @State private var renamingURL: URL?
    @State private var renameText = ""
```

Pass both into the tree in `treePane`:

```swift
                ExplorerTreeList(store: store,
                                 displayRoot: displayRoot,
                                 gitRoot: gitRoot,
                                 git: decorations,
                                 actions: actions(),
                                 renamingURL: renamingURL,
                                 renameText: $renameText)
```

Re-point `beginRename` in `actions()` and add the two new closures after `canPaste`:

```swift
            beginRename: { url in
                renamingURL = url
                renameText = url.lastPathComponent
            },
```

```swift
            commitRename: { url, name in commitRename(url, to: name) },
            cancelRename: { renamingURL = nil },
```

Add the commit helper next to `performPaste`:

```swift
    /// Apply an inline rename. An unchanged or empty name just closes the
    /// editor. A failure (bad character, name taken) leaves the editor OPEN
    /// with the text intact so the user can correct it rather than retyping.
    private func commitRename(_ url: URL, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != url.lastPathComponent else {
            renamingURL = nil
            return
        }
        do {
            let new = try ExplorerFileOps.rename(url, to: trimmed)
            renamingURL = nil
            retarget(from: url, to: new)
        } catch {
            opError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
    }
```

Finally, make sure a rename in progress cannot outlive its row. In the `.task(id: root?.path)` block added in Task 8, add `renamingURL = nil` right after `store.reset()`; and in `delete(_:)`, inside the per-URL loop after the `store.selection` filter, add:

```swift
                if let renaming = renamingURL,
                   renaming == url || ExplorerPaths.isDescendant(renaming, of: url) {
                    renamingURL = nil
                }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ExplorerKeyCommandTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 12 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerKeyCommand.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ExplorerKeyCommandTests.swift
git commit -m "feat(mac): Explorer renames inline with F2, Esc cancels"
```

---

### Task 13: Copy Path / Copy Relative Path

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift` (`ExplorerActions` gains `copyPath`; two menu items)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (`actions()` takes `displayRoot`; add `copyPaths`)
- Test: covered by `ExplorerPathsTests.testRelativePathOfDescendant` / `…OutsideRootIsNil` (Task 1) — the only logic here is `ExplorerPaths.relativePath` plus a pasteboard write, and a pasteboard write is not unit-testable without mutating the developer's real clipboard.

**Interfaces:**
- Consumes: `ExplorerPaths.key(_:)`, `ExplorerPaths.relativePath(of:from:)` (Task 1); `ExplorerActions` (Tasks 8–12).
- Produces: `ExplorerActions.copyPath: (_ urls: [URL], _ relative: Bool) -> Void`

**`NSPasteboard` IS correct here**, in deliberate contrast to Task 11's clipboard: Copy Path exists precisely so the path can be pasted into a terminal, a chat message, or another editor. What must not go on the system pasteboard is the *cut/copy file operation*, which is Explorer-internal state.

Relative paths are computed against **`displayRoot`** — the folder whose name the tree header shows — so "Copy Relative Path" produces the path a person reading that header would expect, and matches what a repo-relative path looks like in the single-repo case.

- [ ] **Step 1: No unit test to write**

The decision logic (`relativePath`) is already covered by `ExplorerPathsTests` from Task 1; the remainder is one `NSPasteboard` write, which cannot be asserted without clobbering the developer's actual clipboard. Verified manually per the checklist at the end of this plan. Proceed to Step 2.

- [ ] **Step 2: Add the action and menu items**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`, add one field to `ExplorerActions`, after `cancelRename`:

```swift
    /// Write paths to the SYSTEM pasteboard (unlike cut/copy, which is
    /// Explorer-internal): `relative` selects display-root-relative paths
    /// over absolute ones.
    var copyPath: (_ urls: [URL], _ relative: Bool) -> Void
```

In `ExplorerTreeRow.contextMenuItems`, add a group immediately before the final `Divider()` / "Reveal in Finder":

```swift
        Divider()
        Button("Copy Path") { actions.copyPath(targets, false) }
        Button("Copy Relative Path") { actions.copyPath(targets, true) }
```

- [ ] **Step 3: Implement it in `ExplorerView`**

`actions()` needs the display root, so change its signature to `actions(displayRoot: URL)` and update the single call site in `treePane` to `actions: actions(displayRoot: displayRoot)`.

Add the closure to the bundle, after `cancelRename`:

```swift
            copyPath: { urls, relative in copyPaths(urls, relative: relative, base: displayRoot) }
```

Add the helper next to `commitRename`:

```swift
    /// Put one path per line on the system pasteboard. `relative` paths are
    /// computed against the tree's display root — the folder whose name the
    /// tree header shows — so they read the way the user sees the tree. A URL
    /// outside that root (or the root itself) falls back to its absolute
    /// path rather than silently copying nothing.
    private func copyPaths(_ urls: [URL], relative: Bool, base: URL) {
        let lines = urls.map { url -> String in
            guard relative,
                  let rel = ExplorerPaths.relativePath(of: url, from: base),
                  !rel.isEmpty else { return ExplorerPaths.key(url) }
            return rel
        }
        let text = lines.joined(separator: "\n")
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
```

- [ ] **Step 4: Verify the build**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift
git commit -m "feat(mac): Explorer context menu copies absolute and relative paths"
```

---

### Task 14: Find in Folder (`ShellState.pendingSearchInclude` → `SearchView`)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift` (add the property + consume-once accessor)
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift` (consume it on appear)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift` (`ExplorerActions` gains two fields; one menu item)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (`shell` environment, `searchRoot`, `findInFolder`)
- Test: `mac/Tests/LlmIdeMacTests/ShellStatePendingSearchTests.swift`

**Interfaces:**
- Consumes: `ExplorerPaths.includeGlob(for:root:)` (Task 1); `WorkspaceRoot.resolve(config:projectStore:)`; `ShellState.section`; `ExplorerActions` (Tasks 8–13).
- Produces:
  - `ShellState.pendingSearchInclude: String?`
  - `ShellState.takePendingSearchInclude() -> String?` (consume-once)
  - `ExplorerActions.findInFolder: (URL) -> Void`, `ExplorerActions.canFindIn: (URL) -> Bool`

**A property, not a `Notification`.** Switching to Search sets `shell.section = .search`, which is what MOUNTS `SearchView`. A notification posted in the same turn would be delivered before any observer exists. `ShellState.pendingResummarizeMeetingId` already exists for exactly this reason (its doc comment says so) — this follows that pattern.

**The root mismatch is P4's.** `SearchView` roots at `WorkspaceRoot.resolve(...)` (the project folder) while the Explorer tree roots at `activeProjectCodeDir`. Design §3 finding #10 assigns unifying them to P4. P3 does the honest thing instead: compute the glob against **Search's** root and DISABLE the menu item when the folder falls outside it, so the command is never offered in a form that would silently return nothing.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ShellStatePendingSearchTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ShellStatePendingSearchTests: XCTestCase {

    func testPendingSearchIncludeStartsNil() {
        XCTAssertNil(ShellState().pendingSearchInclude)
    }

    func testTakeReturnsTheValueAndClearsIt() {
        let shell = ShellState()
        shell.pendingSearchInclude = "app/job/"
        XCTAssertEqual(shell.takePendingSearchInclude(), "app/job/")
        XCTAssertNil(shell.pendingSearchInclude,
                     "a consumed handoff must not re-apply on the next mount")
    }

    func testTakeOnAnEmptyStateIsNil() {
        XCTAssertNil(ShellState().takePendingSearchInclude())
    }

    /// The empty string is a MEANINGFUL value here — it is what
    /// `ExplorerPaths.includeGlob` returns for the root itself ("search
    /// everything") — so it must round-trip rather than being treated as
    /// absent.
    func testEmptyStringRoundTripsAsAValue() {
        let shell = ShellState()
        shell.pendingSearchInclude = ""
        XCTAssertEqual(shell.takePendingSearchInclude(), "")
        XCTAssertNil(shell.pendingSearchInclude)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ShellStatePendingSearchTests 2>&1 | tail -20`
Expected: FAIL. On this toolchain: `no such module 'XCTest'` — did not execute; record it.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: FAIL with `value of type 'ShellState' has no member 'pendingSearchInclude'`.

- [ ] **Step 3: Add the handoff to `ShellState`**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`, after the existing `var pendingResummarizeMeetingId: String?`:

```swift
    /// Set by the Explorer's "Find in Folder" action: the `SearchView`
    /// "files to include" glob to apply on its next appearance.
    ///
    /// A property rather than a `Notification` for the same reason
    /// `pendingResummarizeMeetingId` is one: switching sections is what MOUNTS
    /// `SearchView`, so a notification posted at switch time would be
    /// delivered before any observer exists.
    var pendingSearchInclude: String?

    /// Read and clear in one step, so a handoff applies exactly once and does
    /// not re-narrow the search every time the user returns to the panel.
    /// Note `""` is a real value here (`ExplorerPaths.includeGlob` returns it
    /// for the root: "search everything"), so absence is `nil` only.
    func takePendingSearchInclude() -> String? {
        defer { pendingSearchInclude = nil }
        return pendingSearchInclude
    }
```

- [ ] **Step 4: Consume it in `SearchView`**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`, add the environment read next to the existing `@EnvironmentObject` declarations:

```swift
    @Environment(ShellState.self) private var shell
```

and attach a `.task` to `body`'s outer `VStack` (after the existing content, alongside the closing brace of the `VStack`):

```swift
        .task {
            // Explorer's "Find in Folder" handoff. `scheduleSearch()` is called
            // explicitly rather than relying on `globField`'s `onChange`,
            // because re-scoping to the SAME folder twice sets an unchanged
            // value and would fire nothing.
            if let pending = shell.takePendingSearchInclude() {
                include = pending
                scheduleSearch()
            }
        }
```

- [ ] **Step 5: Add the action and menu item**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift`, add two fields to `ExplorerActions`, after `copyPath`:

```swift
    /// Switch to Search, scoped to this folder.
    var findInFolder: (URL) -> Void
    /// Whether this folder is reachable from Search's root. Search and the
    /// Explorer tree resolve their roots differently (design §3 finding #10,
    /// assigned to P4), so a folder can legitimately be outside Search's
    /// reach — in which case the menu item is DISABLED rather than silently
    /// running a search that returns nothing.
    var canFindIn: (URL) -> Bool
```

In `ExplorerTreeRow.contextMenuItems`, add — immediately after the `Copy Relative Path` button — a directory-only entry:

```swift
        if row.isDirectory {
            Button("Find in Folder") { actions.findInFolder(row.url) }
                .disabled(!actions.canFindIn(row.url))
        }
```

- [ ] **Step 6: Implement it in `ExplorerView`**

Add the shell to the environment reads, next to `@EnvironmentObject private var config: AppConfig`:

```swift
    @Environment(ShellState.self) private var shell
```

Add the search root next to `gitRoot`:

```swift
    /// The root `SearchView` walks — a THIRD root, distinct from both `root`
    /// (the tree's `code/` container) and `gitRoot` (the git working tree).
    /// Unifying Search's root with the Explorer's is design §3 finding #10,
    /// assigned to P4; until then, Find in Folder computes against Search's
    /// actual root so the handoff is honest.
    private var searchRoot: URL? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }
```

Add the two closures to `actions(displayRoot:)`, after `copyPath`:

```swift
            findInFolder: { findInFolder($0) },
            canFindIn: { url in
                guard let searchRoot else { return false }
                return ExplorerPaths.includeGlob(for: url, root: searchRoot) != nil
            }
```

And the handler next to `copyPaths`:

```swift
    /// Scope Search to `folder` and switch to it. Setting the pending glob
    /// BEFORE changing the section matters: the section change is what mounts
    /// `SearchView`, and its `.task` reads the value on mount.
    private func findInFolder(_ folder: URL) {
        guard let searchRoot,
              let glob = ExplorerPaths.includeGlob(for: folder, root: searchRoot) else { return }
        shell.pendingSearchInclude = glob
        shell.section = .search
    }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ShellStatePendingSearchTests 2>&1 | tail -20`
Expected on a full Xcode toolchain: all 4 tests pass. Expected HERE: `no such module 'XCTest'` — did not execute; say so.

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ShellState.swift \
        mac/Sources/LlmIdeMac/Views/Search/SearchView.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerTreeList.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Tests/LlmIdeMacTests/ShellStatePendingSearchTests.swift
git commit -m "feat(mac): Explorer's Find in Folder scopes Search to the selected folder"
```

---

## End-of-phase verification

- [ ] `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build 2>&1 | tail -20` → `Build complete!`, with no new warnings in the files this plan touched.
- [ ] `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | tail -40` → no errors.
- [ ] `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test 2>&1 | tail -60` → on a full Xcode toolchain, every test from Tasks 1–12 and 14 passes. On THIS toolchain it fails with `no such module 'XCTest'`; report that as an environment limitation and never as a pass.
- [ ] The feature-excluded build still compiles (the store/helper placement rule): `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && LLMIDE_FEATURES=terminal swift build --build-tests --manifest-cache none 2>&1 | tail -20` → no errors. This is the check that catches a store accidentally placed under `Views/Explorer/`, which `Package.swift` excludes wholesale while excluding none of the new test files.
- [ ] `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -rn --include="*.swift" "GitStatusStore" mac/Sources mac/Tests` → no output.
- [ ] `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -rn --include="*.swift" "Color\.green\|Color\.red\|Color\.orange\|: \.green\|: \.red\|: \.orange" mac/Sources/LlmIdeMac/Views/Explorer mac/Sources/LlmIdeMac/Views/Shared/TreeRowLabel.swift mac/Sources/LlmIdeMac/Views/Shared/ResizableDivider.swift` → no output (no raw status colors in new or touched view code).
- [ ] `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2 && grep -rn --include="*.swift" 'split(separator: "\\n")' mac/Sources/LlmIdeMac/Services/ExplorerDragPayload.swift` → no output (the CRLF rule).
- [ ] `git log --oneline -13` shows one commit per task, in order.

## Manual Verification Checklist

Nothing below is reachable by an automated test in this environment (no XCTest runner, no UI harness), so this IS the acceptance gate. Run the app against a real git repo opened as the active project, with a mix of modified, staged, untracked, and deleted files.

1. **Git colors are alive.** Open Explorer. Modified files show in the palette's info (blue) hue with an `M` badge, untracked/added in the success (green) hue, deleted struck through in the danger (red) hue, and folders containing changes are tinted. Confirm the SAME file shows the SAME color in Source Control. (Before P3, every file rendered clean — this is the fix for design §3 finding #1.)
2. **Colors are theme-correct.** Switch Settings → Appearance through Dark, Light, and Midnight. Every decoration stays legible; nothing renders as a raw system green/red/orange.
3. **Live tree updates.** With Explorer open, create a file in the repo from a terminal (`touch newfile.txt`). It appears in the tree within ~1–2 seconds without pressing Refresh. Delete it from the terminal; it disappears. Do the same inside a nested EXPANDED folder.
4. **Unopened folders stay unwalked.** Create a file deep inside a folder that has never been expanded; the tree does not expand it or visibly churn.
5. **Multi-select.** Click a row, then ⌘-click two more — all three highlight, full row width. ⇧-click extends a contiguous range. Click empty space below the rows to clear.
6. **Keyboard navigation.** With a row selected: ↑/↓ move one row (this is `List`'s own behavior; confirm it still works). → expands a folder, ← collapses it; ← on a file jumps to and collapses its parent. ⏎ opens a file into a tab / toggles a folder. Then click into the tree toolbar's buttons and confirm the arrow keys no longer move the tree selection.
7. **Chevron vs. row click.** Clicking a folder's chevron expands/collapses it WITHOUT changing the selection. Clicking the folder's name selects it without toggling. ⌘-clicking several folders multi-selects them without expanding any.
8. **Single-click opens.** Clicking a file row opens it in the editor tab area (one click, not two).
9. **Resizable tree.** Drag the divider right of the tree: the cursor becomes a horizontal resize cursor, the tree resizes live, and it stops at roughly 160pt and 520pt. Quit and relaunch — the width is remembered.
10. **Expansion + selection persist.** Expand several folders, select a file, quit, relaunch — the same folders are open and the same file is selected. Then delete one of those folders from a terminal, relaunch, and confirm it is simply absent (no phantom row, no crash).
11. **Project switching.** Switch to a different project and back. The tree, selection, and open tabs reset to the new project's, and returning restores that project's own remembered state — never the other project's.
12. **Drag & drop — move.** Drag a file onto a folder row: it moves. Drag it onto a FILE row: it lands in that file's folder. Drag to the empty space below the list: it lands at the tree root. If the file was open in a tab, the tab keeps working after the move (it now points at the new path).
13. **Drag & drop — multi + ⌥copy.** Select three files, drag them together onto a folder — all three move. Repeat holding ⌥ — they are copied and the originals remain.
14. **Drag & drop — guards.** Drag a folder onto ITSELF and onto one of its own children: the "Can't move a folder into itself." alert appears and nothing on disk changed. Drag a file onto a folder that already has a file of that name: the "An item with this name already exists." alert appears and the existing file's contents are UNCHANGED (verify with `cat`).
15. **Cut / copy / paste.** Select a file, ⌘X, click another folder, ⌘V — it moves and the clipboard is now empty (Paste is greyed out). ⌘C a file and ⌘V twice into the same folder — you get `x copy` and `x copy 2`, and Paste stays available. Confirm the context menu's Cut/Copy/Paste do the same, and that Paste is disabled when the clipboard is empty.
16. **The clipboard did NOT leak.** After ⌘X on a file in the Explorer, click into any text field (the chat input, the search box) and press ⌘V — nothing from the Explorer is pasted.
17. **Inline rename.** Select a row, press F2: a text field opens in place, pre-filled and focused, aligned under the name. Type a new name, ⏎ — the file renames, and an open tab for it follows to the new name. Press F2 again and Esc — nothing changes. Press F2 and enter a name that already exists — the "already exists" alert appears and the editor stays open with your text so you can fix it. Confirm the context menu's Rename opens the same inline editor. **The tree must not steal the keyboard while the editor is open** (this is not probe-verifiable — the List-level `.onKeyPress` and the row's `TextField` compete for the same keys, and only a running app can settle it): with the editor open, ⏎ COMMITS the rename rather than opening the old row into a tab; ←/→ move the caret within the text rather than collapsing/expanding the tree; and ⌘X/⌘C act on the SELECTED TEXT, not on the file. Then Esc and confirm the same keys drive the tree again.
    - **Case-only rename.** F2 on `Foo.swift`, change it to `foo.swift`, ⏎ — it renames (no "An item with this name already exists." alert), `ls` in a terminal shows exactly `foo.swift`, the contents are unchanged, and no hidden `.<UUID>-Foo.swift` is left behind (`ls -a`). Repeat on a FOLDER and confirm its children are still there. Then, with both `real.txt` and a symlink `Link.txt -> real.txt` present, F2 the symlink and rename it to `real.txt`: the "already exists" alert appears, `real.txt` is untouched, and the alert does NOT quote a UUID.
18. **Rename can't outlive its row.** Start a rename, then delete that file from a terminal and wait for the watcher — the editor closes rather than editing a ghost.
19. **Delete, single and multi.** Right-click one row → Delete → the dialog names that file; confirm and it goes to the Trash. Select three rows → Delete → the dialog says "Move 3 items to the Trash?"; confirm, and all three are gone with their tabs closed.
20. **Copy Path / Copy Relative Path.** Right-click a nested file → Copy Path, paste into a terminal: a full absolute path. → Copy Relative Path: a path relative to the folder named in the tree header. Select several rows and copy — one path per line.
21. **Find in Folder.** Right-click a folder → Find in Folder: the app switches to Search with "files to include" pre-filled with that folder and results already scoped to it. Go back to Explorer and return to Search WITHOUT using the menu again — the include field is not re-narrowed (the handoff is consumed once). Confirm the menu item is absent on file rows, and is greyed out for a folder that is outside Search's root (a multi-repo project where the tree shows a clone that Search's project root does not contain).
22. **Toolbar still works.** New File / New Folder create inside the selected folder (or beside the selected file), Refresh re-reads without collapsing anything, Collapse All collapses every folder.
23. **No regression in the Library tree.** Open Library and browse its file tree (it shares `TreeRowLabel`): rows render with icons and indentation exactly as before, with a static chevron and no git badges.

---

## Self-Review

### 1. Spec coverage

| Spec requirement (§11 P3 + §6.3) | Task |
|---|---|
| `ExplorerTreeStore` (§6.3): `children`, `expanded`, `selection`, `loadChildren(of:)`, `invalidate(_:)` | 3 |
| §6.3 `persistState(for:)` / `restoreState(for:)` — "the persistence the audit found entirely absent" | 5 |
| §6.3 "moving the cache into an `@Observable` model with an explicit async load method" — fixes §3 #9 (state mutation during view-body evaluation) | 3, 8 |
| §11 "live updates via `GitTruthStore.startWatching`" — fixes §3 #5 (watcher wired to nothing) | 6 (tree structure, own watcher), 7 (git status, `GitTruthStore.startWatching`) |
| §11 "`List(selection:)`-based rows for multi-select/keyboard/full-width selection" | 4 (flat `Row` model), 8 (the `List`) |
| §11 "drag & drop … backed by `ExplorerFileOps.move`/`copy`" (§6.5) | 2 (ops), 10 (UI) |
| §11 "cut/copy/paste" | 2, 11 |
| §11 "inline rename" | 12 |
| §11 "resizable+persisted tree width" (§3 #10) | 9 |
| §11 "Copy Path" | 13 |
| §11 "Find in Folder" | 14 |
| §3 #1 — Explorer git decoration dead because the root has no `.git` | 7 |
| §6.6 / §2 — all git colors through `Theme`, correct in Dark/Light/Midnight | 7 (+ manual check 2) |
| §9 testing strategy — "`ExplorerTreeStore`: expansion/selection persistence round-trip, cache invalidation"; "`ExplorerFileOps.move`/`copy`: same validation-first pattern as existing tests" | 3, 5 (round-trip + invalidation), 2 (ops, real temp dirs) |
| §9 "Manual verification per phase" | Manual Verification Checklist |

**Deliberately NOT in P3, with the reason recorded:**
- §3 #10's Search/Explorer **root unification** — assigned to P4 by the settled rulings; Task 14 disables the affected menu item instead of guessing.
- §6.1 `GitTruthStore` and §6.2 `MonacoHost` — shipped by P0/P1/P2; P3 consumes them.
- §3 #2/#3's remaining diff work, §3 #6/#7/#8 (editor, line-jump, search cancellation) — P1/P2/P4.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add error handling", "similar to Task N", or "write tests for the above" appears in any step. Every code step carries the literal code to write. Two tasks have no unit test (13, and Task 8's view layer beyond `ExplorerKeyCommand`); each says so explicitly and names what covers it instead — never a silent omission.

### 3. Type consistency

Checked against the real source, and across tasks:

- `FileSystemTree.Node` (`url`, `name`, `isDirectory`, `id: String`) and `FileSystemTree.children(of:) -> [Node]` — verified in `Services/FileSystemTree.swift`.
- `GitTruthStore.Decoration` is the decoration type everywhere — `Theme.color(for:)` (Task 7), `TreeRowLabel.gitStatus` (Task 7), `ExplorerTreeRow` (Tasks 8, 12). `GitStatusStore.Decoration` appears nowhere after Task 7.
- `GitTruthStore.decoration(forAbsolute:root:isDirectory:)` and `refresh(root:)` (optional `URL?`) match the real signatures.
- `RepoFileWatcher(repoRoot:debounce:onChange:)` is failable and takes an `@Sendable` closure — matched in Task 6.
- `ExplorerPaths.key(_:)` is the ONE normalizer; Tasks 3, 4, 5, 6, 8, 10, 11, 12, 13 all call it, and no task defines a second one.
- `ExplorerTreeStore.Row.ID == URL` (Task 4) matches `selection: Set<URL>` (Task 3) and `List(selection:)` (Task 8).
- `ExplorerActions` final field list, accumulated in declaration order: `open, newFile, newFolder, beginRename, delete, revealInFinder` (8) · `drop` (10) · `cut, copy, paste, canPaste` (11) · `commitRename, cancelRename` (12) · `copyPath` (13) · `findInFolder, canFindIn` (14) — 17 fields. Every one is populated in `ExplorerView.actions(displayRoot:)`; `ExplorerActions` has no custom initializer, so a missing field is a compile error, not a runtime surprise.
- `ExplorerActions` is constructed in exactly one place. Its call site changes shape twice: `actions()` → `actions(displayRoot:)` in Task 13. Task 13 states the rename and updates the single `treePane` call site.
- `ExplorerKeyCommand` cases accumulate `expand, collapse, open` (8) → `+ cut, copy, paste` (11) → `+ rename` (12); each task lists exactly what it adds, and Task 11 rewrites `resolve` whole rather than patching it.
- `ExplorerFileOps` naming: `move(from:to:)`, `copy(from:to:)`, `uniqueDestination(in:name:)`, `paste(_:into:move:)` — used consistently in Tasks 2, 10, 11.
- `ExplorerView.retarget(from:to:)` is introduced in Task 8 and SPLIT into `remap(from:to:)` + `retarget(from:to:)` in Task 10; Tasks 11 and 12 use the post-split names (`remap` for multi-item, `retarget` for single).
- `ExplorerView.deleteError` is renamed to `opError` in Task 10; Tasks 11, 12, 13 use `opError` only, and Task 10 ends with a grep proving the old name is gone.
- `ExplorerView.pendingDelete` becomes `[URL]` in Task 8; both writers (`treeToolbar`'s display-root menu, `actions().delete`) and the confirmation dialog are updated in that same task.
- `Typography.filename` (Task 12's rename field) exists in `Models/Theme.swift`.
- `WorkspaceRoot.gitWorkingTree(config:projectStore:)` and `WorkspaceRoot.resolve(config:projectStore:)` are both `@MainActor static` — matched in Tasks 7 and 14.
- `ShellState` is `@Observable` and read via `@Environment(ShellState.self)` (the pattern `PanelSectionTabs` uses) — matched in Tasks 14's `ExplorerView` and `SearchView` changes.
- `SearchView.scheduleSearch(resetExpanded:)` defaults `resetExpanded` to `true`, so Task 14's bare `scheduleSearch()` is valid and correctly resets expansion for the new scope.

### 4. Fixes applied during review

- Task 3's `displayRoot(for:)` was originally going to live on the view; moved onto the store so `flatten`'s caller and `toolbarTargetDir` cannot disagree about where the tree starts.
- Task 8 originally used a tap gesture to toggle folders, which fights `List`'s own selection handling; replaced with `TreeRowLabel.onToggleChevron` (a real button on the chevron), which is also what makes ⌘/⇧ multi-select work on folder rows.
- Task 11's `handle(_:)` originally sat behind `guard let row = focusedRow`, which made ⌘V dead with nothing selected; restructured so the clipboard commands resolve before that guard and paste falls back to the display root.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-04-vscode-parity-p3-explorer.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in one session with checkpoints. REQUIRED SUB-SKILL: `superpowers:executing-plans`.
