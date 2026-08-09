# Explorer file ops + Source Control stage/unstage-all — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cursor-style Explorer file operations (new file, new folder, rename, delete-to-trash) and an Unstage All action to the Source Control panel; verify Stage All.

**Architecture:** A stateless `ExplorerFileOps` helper does the mutating `FileManager` work (create/rename/trash), called from `ExplorerView` which owns the tree cache, editor tabs, and git-status decorations. `SourceControlService` gains `unstageAll` through its existing local-git chokepoint; `SourceControlView` generalizes its group helper to render the mirror button. All git runs locally via `RepoManager.runGit` (`/usr/bin/git`); no backend changes.

**Tech Stack:** Swift / SwiftUI (`@Observable`), AppKit `FileManager`/`NSWorkspace`, XCTest, real `git` in temp dirs.

## Global Constraints

- **Build:** `cd mac && swift build`. **Test:** `cd mac && swift test --filter <Name>`.
- **Test framework:** XCTest, `@testable import LlmIdeMacLib`, `@MainActor final class X: XCTestCase`. Temp dirs: `FileManager.default.temporaryDirectory.appendingPathComponent("name-\(UUID().uuidString)")`; remove in `tearDown`.
- **Type suffixes** per CLAUDE.md (`*Service`, etc.). `ExplorerFileOps` is a plain `enum` of static helpers (FileManager is thread-safe; calling from the `@MainActor` view is fine).
- **Git is local-only** on the Mac (`RepoManager.runGit(_ args: [String], at: URL) async throws -> String`). No `:3456` endpoints are involved.
- **Conventional Commits**, one concern per commit. Do NOT push.
- **Naming/product:** code types `LlmIde…` per ADR 0016.

## Prerequisites

- Work on a fresh feature branch off `main` (e.g. `feat/explorer-file-ops`).
- The working tree must be clean first. The earlier mobile-chat provider fix is currently uncommitted in the tree (`extension/kb/routes/agent.mjs`, two `mac/…/MobileControlManager.swift`+`LlmIdeAPIClient+Agent.swift`, `extension/tests/agent-ask-provider.test.mjs`). Commit those separately (e.g. `fix(mac): forward model/provider through mobile chat`) on `main` BEFORE branching, so this feature's commits stay clean.

---

## File Structure

- **Create** `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift` — `enum ExplorerFileOps` (createFile/createFolder/rename/trash) + `enum ExplorerFileError`. Pure FileManager; testable without UI.
- **Create** `mac/Sources/LlmIdeMac/Views/Explorer/FileNamePromptSheet.swift` — reusable name-entry sheet (new file / new folder / rename) with an inline error binding.
- **Modify** `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` — tree toolbar (New File / New Folder / Refresh), context menus (New/Rename/Delete/Reveal), sheet + delete-confirm wiring, and post-op refresh + tab sync helpers.
- **Modify** `mac/Sources/LlmIdeMac/Services/SourceControlService.swift` — add `unstageAll(root:)` (one line, through the existing `run` chokepoint).
- **Modify** `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` — `fileGroup(…, showUnstageAll:)` + `−` header button; wire `showUnstageAll: true` on "Staged Changes".
- **Create** `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift`.
- **Create** `mac/Tests/LlmIdeMacTests/SourceControlStageAllTests.swift`.

---

### Task 1: `ExplorerFileOps` helper + tests (TDD)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift`
- Test: `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift`

**Interfaces:**
- Produces: `enum ExplorerFileError: LocalizedError, Equatable { emptyName; invalidName; alreadyExists; writeFailed }`, and `enum ExplorerFileOps` with `@discardableResult static func createFile(in dir: URL, name: String) throws -> URL`, `createFolder(in:name:) throws -> URL`, `rename(_ url: URL, to newName: String) throws -> URL`, `static func trash(_ url: URL) throws`.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

final class ExplorerFileOpsTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-ops-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    func testCreateFileMakesEmptyFile() throws {
        let url = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual((try? String(contentsOf: url, encoding: .utf8)) ?? "x", "")
    }

    func testCreateFolderMakesDirectory() throws {
        let url = try ExplorerFileOps.createFolder(in: root, name: "sub")
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
    }

    func testDuplicateNameThrowsAlreadyExists() throws {
        _ = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        XCTAssertThrowsError(try ExplorerFileOps.createFile(in: root, name: "a.txt")) { err in
            XCTAssertEqual(err as? ExplorerFileError, .alreadyExists)
        }
    }

    func testEmptyNameThrowsEmptyName() {
        XCTAssertThrowsError(try ExplorerFileOps.createFile(in: root, name: "   ")) { err in
            XCTAssertEqual(err as? ExplorerFileError, .emptyName)
        }
    }

    func testRenameMovesAndReturnsNewURL() throws {
        let old = try ExplorerFileOps.createFile(in: root, name: "old.txt")
        let new = try ExplorerFileOps.rename(old, to: "new.txt")
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: new.path))
        XCTAssertEqual(new.lastPathComponent, "new.txt")
    }

    func testTrashRemovesItem() throws {
        let url = try ExplorerFileOps.createFile(in: root, name: "gone.txt")
        try ExplorerFileOps.trash(url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build` (test target won't compile — `ExplorerFileOps` / `ExplorerFileError` undefined).
Expected: compile error — "cannot find 'ExplorerFileOps' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift`:

```swift
import Foundation

/// Surfaced name/fs failures from Explorer file operations. Inline-able in the
/// name sheet; mapped to a user-facing string via `errorDescription`.
enum ExplorerFileError: LocalizedError, Equatable {
    case emptyName
    case invalidName
    case alreadyExists
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .emptyName: return "Name can’t be empty."
        case .invalidName: return "Name can’t contain “/” or be “.”/“..”."
        case .alreadyExists: return "An item with this name already exists."
        case .writeFailed: return "Couldn’t create the item."
        }
    }
}

/// Stateless mutating file operations for the Explorer tree. All paths are
/// validated and existence-checked here so the view can stay declarative and
/// the logic is testable without UI. Delete uses `trashItem` (Finder Trash,
/// undoable) — never `removeItem`.
enum ExplorerFileOps {
    /// Throws if `name` is empty/whitespace, or contains "/" or is "." / "..".
    private static func validate(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ExplorerFileError.emptyName }
        guard trimmed != ".", trimmed != "..", !trimmed.contains("/") else {
            throw ExplorerFileError.invalidName
        }
        return trimmed
    }

    @discardableResult
    static func createFile(in dir: URL, name: String) throws -> URL {
        let trimmed = try validate(name)
        let url = dir.appendingPathComponent(trimmed)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw ExplorerFileError.alreadyExists }
        guard FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: nil) else {
            throw ExplorerFileError.writeFailed
        }
        return url
    }

    @discardableResult
    static func createFolder(in dir: URL, name: String) throws -> URL {
        let trimmed = try validate(name)
        let url = dir.appendingPathComponent(trimmed)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw ExplorerFileError.alreadyExists }
        do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
        catch { throw ExplorerFileError.writeFailed }
        return url
    }

    /// Rename `url` to `newName` (same parent). Returns the new URL. No-op
    /// (returns the original) when the name is unchanged.
    @discardableResult
    static func rename(_ url: URL, to newName: String) throws -> URL {
        let trimmed = try validate(newName)
        let dest = url.deletingLastPathComponent().appendingPathComponent(trimmed)
        if dest == url { return url }
        guard !FileManager.default.fileExists(atPath: dest.path) else { throw ExplorerFileError.alreadyExists }
        try FileManager.default.moveItem(at: url, to: dest)
        return dest
    }

    /// Move `url` (file or folder, recursively) to the Trash.
    static func trash(_ url: URL) throws {
        var result: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &result)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter ExplorerFileOpsTests`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift
git commit -m "feat(mac): add ExplorerFileOps helper for create/rename/trash"
```

---

### Task 2: `FileNamePromptSheet` view

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Explorer/FileNamePromptSheet.swift`

**Interfaces:**
- Produces: `struct FileNamePromptSheet: View` with `enum Mode { newFile; newFolder; rename }`, initialiser `init(mode:initialName:error:onConfirm:onCancel:)` where `error: Binding<String?>`, `onConfirm: (String) -> Void`, `onCancel: () -> Void`. The parent owns the error binding and decides whether to dismiss (success) or set the error (failure).

- [ ] **Step 1: Create the view**

Create `mac/Sources/LlmIdeMac/Views/Explorer/FileNamePromptSheet.swift`:

```swift
import SwiftUI

/// Reusable name-entry sheet for Explorer create/rename. The parent owns the
/// `error` binding: on confirm it attempts the op, dismisses on success or
/// sets `error` to keep the sheet open with an inline message.
struct FileNamePromptSheet: View {
    enum Mode { case newFile, newFolder, rename }

    let mode: Mode
    let initialName: String
    @Binding var error: String?
    let onConfirm: (String) -> Void
    let onCancel: () -> Void

    @State private var name: String

    init(mode: Mode, initialName: String = "", error: Binding<String?>,
         onConfirm: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.mode = mode
        self.initialName = initialName
        self._error = error
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        _name = State(initialValue: initialName)
    }

    private var title: String {
        switch mode {
        case .newFile: return "New File"
        case .newFolder: return "New Folder"
        case .rename: return "Rename"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(title).font(Typography.headline)
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit { onConfirm(name) }
            if let error {
                Text(error).font(Typography.caption).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button(mode == .rename ? "Rename" : "Create") { onConfirm(name) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(Spacing.md)
        .frame(width: 320)
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd mac && swift build`
Expected: Build complete. (If `Spacing`/`Typography` resolve elsewhere in the module, they already do — same symbols used in `ExplorerView`.)

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Explorer/FileNamePromptSheet.swift
git commit -m "feat(mac): add FileNamePromptSheet for explorer name entry"
```

---

### Task 3: Wire file ops into `ExplorerView`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (add state at ~line 22; rewrite `treePane` at 144-160; add context-menu items to `folderRow` 196-200 and `fileRow` 221-225; attach `.sheet`/`.confirmationDialog`/`.alert` near 111-112; add behavior helpers after `open(_:)` 290-293)

**Interfaces:**
- Consumes: `ExplorerFileOps` (Task 1), `FileNamePromptSheet` (Task 2).

**Scope note (deviation from spec, v1):** there is no folder-selection state today, so the **toolbar** New File/Folder creates in the tree `root`; the **context menu** is contextual (right-click a folder → create inside it; right-click a file → create in its parent). This satisfies the spec's intent without adding selection state.

- [ ] **Step 1: Add view state**

In `ExplorerView`, after the `@State private var activeTab: URL?` line (~22), add:

```swift
    // File-op prompt state: a create/rename sheet, a delete confirmation, and
    // an inline error for the sheet / an alert for delete failures.
    @State private var filePrompt: FilePrompt?
    @State private var fileOpError: String?
    @State private var pendingDelete: URL?
    @State private var deleteError: String?
```

And add the `FilePrompt` model as a private nested type at the end of the struct (before the closing brace, after `open(_:)`):

```swift
    private struct FilePrompt: Identifiable {
        enum Mode { case newFile, newFolder, rename }
        let mode: Mode
        let dir: URL
        let url: URL?
        let initialName: String
        var id: String { "\(mode):\(url?.path ?? dir.path)" }

        static func newFile(in dir: URL) -> FilePrompt {
            FilePrompt(mode: .newFile, dir: dir, url: nil, initialName: "")
        }
        static func newFolder(in dir: URL) -> FilePrompt {
            FilePrompt(mode: .newFolder, dir: dir, url: nil, initialName: "")
        }
        static func rename(url: URL) -> FilePrompt {
            FilePrompt(mode: .rename, dir: url.deletingLastPathComponent(), url: url, initialName: url.lastPathComponent)
        }
    }
```

- [ ] **Step 2: Add the tree toolbar + rewrite `treePane`**

Replace the existing `treePane` (lines 144-160) with a version that prepends a slim action row:

```swift
    @ViewBuilder
    private var treePane: some View {
        if let root {
            VStack(spacing: 0) {
                treeToolbar(root: root)
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(children(of: root)) { node in
                            treeRow(node, depth: 0)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Color(NSColor.windowBackgroundColor))
            }
        } else {
            emptyState
        }
    }

    private func treeToolbar(root: URL) -> some View {
        HStack(spacing: 2) {
            Button { filePrompt = .newFile(in: root) } label: {
                Image(systemName: "doc.badge.plus")
            }
            .buttonStyle(.borderless).help("New File")
            Button { filePrompt = .newFolder(in: root) } label: {
                Image(systemName: "folder.badge.plus")
            }
            .buttonStyle(.borderless).help("New Folder")
            Button { refreshAll() } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless).help("Refresh")
            Spacer()
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
    }
```

- [ ] **Step 3: Extend the context menus**

In `folderRow`'s `.contextMenu` (currently only "Reveal in Finder", lines 196-200), replace with:

```swift
        .contextMenu {
            Button("New File") { filePrompt = .newFile(in: node.url) }
            Button("New Folder") { filePrompt = .newFolder(in: node.url) }
            Button("Rename") { filePrompt = .rename(url: node.url) }
            Button("Delete") { pendingDelete = node.url }
            Divider()
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
```

In `fileRow`'s `.contextMenu` (lines 221-225), replace with (creates in the file's parent):

```swift
        .contextMenu {
            Button("New File") { filePrompt = .newFile(in: node.url.deletingLastPathComponent()) }
            Button("New Folder") { filePrompt = .newFolder(in: node.url.deletingLastPathComponent()) }
            Button("Rename") { filePrompt = .rename(url: node.url) }
            Button("Delete") { pendingDelete = node.url }
            Divider()
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
```

- [ ] **Step 4: Attach the sheet + delete confirmation + delete-error alert**

In `body`, immediately after the existing `.firstLaunchOpenChat(…)` modifier (line 111-112), add:

```swift
        .sheet(item: $filePrompt) { prompt in
            FileNamePromptSheet(mode: prompt.mode, initialName: prompt.initialName,
                                error: $fileOpError) { name in
                do {
                    try performFileOp(prompt, name)
                    filePrompt = nil
                    fileOpError = nil
                } catch {
                    fileOpError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
                }
            } onCancel: {
                filePrompt = nil
                fileOpError = nil
            }
        }
        .confirmationDialog(
            pendingDelete.map { "Move “\($0.lastPathComponent)” to the Trash?" } ?? "",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Move to Trash", role: .destructive) {
                if let url = pendingDelete { delete(url) }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("You can undo this in Finder.")
        }
        .alert("Couldn’t complete the operation",
               isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })) {
            Button("OK", role: .cancel) { deleteError = nil }
        } message: {
            Text(deleteError ?? "")
        }
```

- [ ] **Step 5: Add the behavior helpers**

After `open(_:)` (line 290-293), add:

```swift
    /// Run a create/rename op, then refresh the affected folder + git
    /// decorations. Throws up to the sheet handler so a bad name surfaces inline.
    private func performFileOp(_ prompt: FilePrompt, _ name: String) throws {
        switch prompt.mode {
        case .newFile:
            let url = try ExplorerFileOps.createFile(in: prompt.dir, name: name)
            invalidate(prompt.dir); expand(prompt.dir); open(url)
        case .newFolder:
            _ = try ExplorerFileOps.createFolder(in: prompt.dir, name: name)
            invalidate(prompt.dir); expand(prompt.dir)
        case .rename:
            guard let url = prompt.url else { return }
            let new = try ExplorerFileOps.rename(url, to: name)
            invalidate(url.deletingLastPathComponent())
            tabs = tabs.map { $0 == url ? new : $0 }
            if activeTab == url { activeTab = new }
        }
        Task { await decorations.refresh(root: root) }
    }

    /// Delete (trash) a file/folder, close tabs under it, refresh.
    private func delete(_ url: URL) {
        do {
            try ExplorerFileOps.trash(url)
            invalidate(url.deletingLastPathComponent())
            tabs.removeAll { $0 == url || $0.path.hasPrefix(url.path + "/") }
            if let active = activeTab, active == url || active.path.hasPrefix(url.path + "/") {
                activeTab = tabs.last
            }
            Task { await decorations.refresh(root: root) }
        } catch {
            deleteError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Drop the cached children of `dir` so the next render re-enumerates.
    private func invalidate(_ dir: URL) {
        childrenCache.removeValue(forKey: dir.path)
    }

    /// Ensure `dir` is expanded and its children are loaded.
    private func expand(_ dir: URL) {
        if childrenCache[dir.path] == nil {
            childrenCache[dir.path] = FileSystemTree.children(of: dir)
        }
        expanded.insert(dir.path)
    }

    /// Full tree + git refresh (toolbar Refresh).
    private func refreshAll() {
        childrenCache.removeAll()
        Task { await decorations.refresh(root: root) }
    }
```

- [ ] **Step 6: Build**

Run: `cd mac && swift build`
Expected: Build complete. (SourceKit "cannot find type" noise during indexing is stale — `swift build` is the source of truth.)

- [ ] **Step 7: Manual verification (UI has no unit tests)**

Launch the app on a project with a code folder, and in the Explorer tree confirm:
- Toolbar New File → name sheet → empty file appears + opens in a tab; shows as untracked (`U`) after git refresh.
- Toolbar New Folder → folder appears.
- Right-click a folder → New File creates inside it; Rename renames; Delete → confirm → item gone to Trash, its tab closed.
- Right-click a file → Rename repoints its open tab; Delete closes the tab.
- Duplicate name / empty name → inline red error in the sheet, sheet stays open.
- Refresh button re-reads the tree.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift
git commit -m "feat(mac): wire explorer file ops (new/rename/delete) into the tree"
```

---

### Task 4: `SourceControlService.unstageAll` + tests (TDD)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SourceControlService.swift` (add one method after `stageAll`, line 120)
- Test: `mac/Tests/LlmIdeMacTests/SourceControlStageAllTests.swift`

**Interfaces:**
- Produces: `func unstageAll(root: URL) async` on `SourceControlService` — runs `git reset` via the existing private `run(_:_)` chokepoint (sets `isBusy`, clears `opError`, refreshes on success+failure).
- Note: the `testStageAllStagesEveryChange` test below also satisfies the spec's "verify Stage All" requirement — if it passes, Stage All is confirmed working and needs no code change.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SourceControlStageAllTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceControlStageAllTests: XCTestCase {
    private var repoRoot: URL!
    private let repo = RepoManager()
    private var scm: SourceControlService!

    override func setUp() async throws {
        try await super.setUp()
        repoRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("scm-stage-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
        _ = try await repo.runGit(["init"], at: repoRoot)
        _ = try? await repo.runGit(["config", "user.email", "test@example.com"], at: repoRoot)
        _ = try? await repo.runGit(["config", "user.name", "Test"], at: repoRoot)
        scm = SourceControlService(repo: repo)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: repoRoot)
        try await super.tearDown()
    }

    /// Verifies the EXISTING stageAll path (spec: "verify Stage All").
    func testStageAllStagesEveryChange() async throws {
        try "hello".write(to: repoRoot.appendingPathComponent("a.txt"),
                          atomically: true, encoding: .utf8)
        await scm.stageAll(root: repoRoot)
        await scm.refresh(root: repoRoot)
        XCTAssertEqual(scm.stagedFiles.count, 1)
        XCTAssertEqual(scm.unstagedFiles.count, 0)
    }

    /// Drives the NEW unstageAll path. `git reset` unstages the whole index
    /// (working tree untouched); the file drops back to untracked/unstaged.
    func testUnstageAllClearsTheIndex() async throws {
        try "hello".write(to: repoRoot.appendingPathComponent("a.txt"),
                          atomically: true, encoding: .utf8)
        await scm.stageAll(root: repoRoot)
        await scm.refresh(root: repoRoot)
        XCTAssertEqual(scm.stagedFiles.count, 1)

        await scm.unstageAll(root: repoRoot)
        await scm.refresh(root: repoRoot)
        XCTAssertEqual(scm.stagedFiles.count, 0)
        XCTAssertEqual(scm.unstagedFiles.count, 1)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build`
Expected: compile error — "value of type 'SourceControlService' has no member 'unstageAll'".

- [ ] **Step 3: Add the one-line method**

In `mac/Sources/LlmIdeMac/Services/SourceControlService.swift`, immediately after `stageAll` (line 120), add:

```swift
    /// Unstage everything (`git reset`, a mixed reset to HEAD — working tree
    /// untouched), then refresh. Cursor-style "Unstage All". `git reset` on an
    /// unborn repo (no commits yet) resets the index to the empty tree, which
    /// is exactly "unstage all" for freshly-added files.
    func unstageAll(root: URL) async { await run(["reset"], root) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter SourceControlStageAllTests`
Expected: 2 tests PASS. (If `testStageAllStagesEveryChange` fails here, Stage All has a real runtime bug — investigate the `run`/refresh path before proceeding; do not change the git command.)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceControlService.swift mac/Tests/LlmIdeMacTests/SourceControlStageAllTests.swift
git commit -m "feat(mac): add Unstage All to SourceControlService"
```

---

### Task 5: "Unstage All" button in the Source Control panel

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` (`fileGroup` signature at 498-499; add button after the `showStageAll` block at 512; wire `showUnstageAll:` at call site 309)

**Interfaces:**
- Consumes: `SourceControlService.unstageAll(root:)` (Task 4).

- [ ] **Step 1: Generalize `fileGroup`**

In `SourceControlView.swift`, change the `fileGroup` signature (line 498-499) from:

```swift
    @ViewBuilder private func fileGroup(_ title: String, _ files: [FileChange], _ root: URL,
                                        showStageAll: Bool = false) -> some View {
```

to:

```swift
    @ViewBuilder private func fileGroup(_ title: String, _ files: [FileChange], _ root: URL,
                                        showStageAll: Bool = false,
                                        showUnstageAll: Bool = false) -> some View {
```

- [ ] **Step 2: Add the `−` button**

Immediately after the `showStageAll` block (the closing brace at line 512), add:

```swift
                if showUnstageAll {
                    Button { Task { await scm.unstageAll(root: root) } } label: {
                        Image(systemName: "minus")
                    }
                    .buttonStyle(.plain)
                    .disabled(scm.isBusy)
                    .help("Unstage All")
                }
```

- [ ] **Step 3: Wire it on "Staged Changes"**

At the call site (line 309), change:

```swift
                    fileGroup("Staged Changes", scm.stagedFiles, root)
```

to:

```swift
                    fileGroup("Staged Changes", scm.stagedFiles, root, showUnstageAll: true)
```

(The "Changes" call at line 310 stays as `showStageAll: true`.)

- [ ] **Step 4: Build**

Run: `cd mac && swift build`
Expected: Build complete.

- [ ] **Step 5: Manual verification**

On a repo with staged changes, open Source Control: a `−` button appears on the "Staged Changes" header; clicking it moves every file back to "Changes" (and the diff pane empties/updates). Stage All (`+` on "Changes") still moves them back. Confirm both buttons are disabled while an op is in flight.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift
git commit -m "feat(mac): add Unstage All button to Source Control panel"
```

---

## Self-Review (run after writing)

- **Spec coverage:** Explorer create/rename/delete → Tasks 1-3 ✓. Unstage All (new) → Tasks 4-5 ✓. Stage All verify → Task 4 `testStageAllStagesEveryChange` ✓. Tests → Tasks 1 & 4 ✓. Out-of-scope items (drag-drop, duplicate, FSEvents) intentionally absent ✓.
- **Type consistency:** `ExplorerFileError` cases (`emptyName/invalidName/alreadyExists/writeFailed`) match between Task 1 impl and tests ✓. `FilePrompt`/`performFileOp`/`delete`/`invalidate`/`expand`/`refreshAll` names match between Steps ✓. `unstageAll(root:)` matches between Task 4 impl and Task 5 call ✓.
- **Placeholders:** none.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-06-explorer-file-ops-and-stage-all.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
