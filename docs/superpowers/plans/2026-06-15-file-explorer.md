# File Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Cursor-style project file Explorer (live tree of all files/folders), closable editor tabs, and a root `.gitignore` that hides generated noise from Source Control.

**Architecture:** A lazy per-level `FileSystemTree` over the active project folder; a new `.explorer` sidebar section rendering the tree + an extracted reusable `EditorTabBar` + `FileDetailView`; a marker-guarded root `.gitignore` block written by `ProjectScaffolder`.

**Tech Stack:** Swift / SwiftUI, FileManager, swift-testing.

**Environment note:** `swift test` doesn't execute here (no XCTest runner). "Run test" = `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` (dangerouslyDisableSandbox: true). App build = `GIT_CONFIG_GLOBAL=/dev/null swift build`. Verify UI by build + launch smoke; verify tree walk + gitignore on a real dir on disk.

**Build order:** Wave 1 = Task 1 (gitignore) + Task 2 (tree model). Wave 2 = Task 3 (extract tab bar) + Task 4 (Explorer view + wiring).

---

## Task 1: Root .gitignore cleanup

**Files:** Modify `Services/ProjectScaffolder.swift`; Test `Tests/.../ProjectScaffolderTests.swift`.

- [ ] **Step 1: Write the failing test**

```swift
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
    #expect(once.contains(".code-notes/"))           // managed block added
    #expect(once.contains("# >>> LLM IDE managed"))

    // Idempotent: a second scaffold must not duplicate the block.
    try ProjectScaffolder.scaffold(at: tmp, project: sampleProject())
    let twice = try String(contentsOf: root, encoding: .utf8)
    let occurrences = twice.components(separatedBy: "# >>> LLM IDE managed").count - 1
    #expect(occurrences == 1)
}
```

(Reuse the file's existing `sampleProject()` / temp-dir helpers.)

- [ ] **Step 2: Build test target — expect failure** (`.code-notes/` not yet written to root).
Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`

- [ ] **Step 3: Implement.** In `ProjectScaffolder.swift`: replace the `gitignoreContent` constant + its `.llmide/.gitignore` write with a root-`.gitignore` managed block. Add:

```swift
private static let managedGitignoreBlock = """
# >>> LLM IDE managed (auto-generated / ephemeral) — edit your own rules above
.code-notes/
.understand-anything/
.llmide/cache/
.llmide/sync.json
.llmide/index.sqlite
.llmide/index.sqlite-shm
.llmide/index.sqlite-wal
*.partial.md
# <<< LLM IDE managed
"""

/// Ensure the project-root .gitignore contains the managed block. Creates
/// the file if absent; appends the block once if the marker is missing;
/// no-ops if already present. Never rewrites the user's own rules.
private static func ensureRootGitignore(at folderURL: URL) {
    let url = folderURL.appendingPathComponent(".gitignore")
    let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    if existing.contains("# >>> LLM IDE managed") { return }
    let combined: String
    if existing.isEmpty {
        combined = managedGitignoreBlock + "\n"
    } else {
        let sep = existing.hasSuffix("\n") ? "\n" : "\n\n"
        combined = existing + sep + managedGitignoreBlock + "\n"
    }
    do { try combined.write(to: url, atomically: true, encoding: .utf8) }
    catch { logger.error("gitignore write failed: \(error.localizedDescription, privacy: .public)") }
}
```

Call `ensureRootGitignore(at: folderURL)` inside `scaffold(at:project:)` (where the old `.llmide/.gitignore` write was). Remove the old nested-gitignore write + the `gitignoreContent` constant if now unused. (Confirm the logger name in the file.)

- [ ] **Step 4: Build test target + app build.** Both `Build complete!`.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "fix(scm): root .gitignore managed block hides generated files"`

---

## Task 2: FileSystemTree (lazy per-level walk)

**Files:** Create `Services/FileSystemTree.swift`; Test `Tests/.../FileSystemTreeTests.swift`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite struct FileSystemTreeTests {
    @Test func loadsOneLevelDirsFirstSkippingNoise() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("fst-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("node_modules"), withIntermediateDirectories: true)
        try "x".write(to: root.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        try "y".write(to: root.appendingPathComponent(".hidden"), atomically: true, encoding: .utf8)
        defer { try? fm.removeItem(at: root) }

        let nodes = FileSystemTree.children(of: root)
        let names = nodes.map(\.name)
        #expect(names == ["src", "README.md"])      // dirs first; .git/node_modules/.hidden skipped
        #expect(nodes[0].isDirectory)
        #expect(!nodes[1].isDirectory)
    }
}
```

- [ ] **Step 2: Build test target — expect compile failure** (no `FileSystemTree`).

- [ ] **Step 3: Implement**

```swift
import Foundation

/// Lazy, per-level filesystem walk for the Explorer tree. Enumerates ONE
/// directory level at a time (not recursive) so large trees stay cheap.
enum FileSystemTree {
    struct Node: Identifiable, Hashable {
        let url: URL
        let name: String
        let isDirectory: Bool
        var id: String { url.path }
    }

    /// Directories to never show (build/cache/VCS). Reuses the store's denylist.
    static var noiseNames: Set<String> { LibraryItemStore.noiseDirectoryNames }

    /// Children of `dir`, directories first then files, case-insensitive by
    /// name, skipping hidden dotfiles and noise dirs. Empty on unreadable dir.
    static func children(of dir: URL) -> [Node] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]) else { return [] }
        let nodes: [Node] = entries.compactMap { url in
            let name = url.lastPathComponent
            if noiseNames.contains(name) { return nil }
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            return Node(url: url, name: name, isDirectory: isDir)
        }
        return nodes.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory && !b.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}
```

(`.skipsHiddenFiles` already drops `.hidden`/`.git`; the `noiseNames` filter additionally drops `node_modules` etc. Note `LibraryItemStore` is `@MainActor` — if `noiseDirectoryNames` is a `static let` it's reachable nonisolated; if access complains, inline a local copy of the denylist here instead.)

- [ ] **Step 4: Build test target — confirm compiles.** `Build complete!`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(explorer): lazy per-level FileSystemTree walk"`

---

## Task 3: Extract reusable EditorTabBar from ReviewView

**Files:** Create `Views/Shared/EditorTabBar.swift`; Modify `Views/ReviewView.swift`.

- [ ] **Step 1: Read `ReviewView.swift`** lines ~315-411 (`EditorTabBar`, `EditorTab`, `close(_:)`, the tab `@State` and `onChange(of: treeSelectedURL)` open logic).

- [ ] **Step 2: Move `EditorTabBar` + `EditorTab`** into `Views/Shared/EditorTabBar.swift` as reusable views. Public surface:

```swift
struct EditorTabBar: View {
    @Binding var tabs: [URL]
    @Binding var activeTab: URL?
    // ...same body as the ReviewView version (tab buttons + close)...
}
```

Keep `EditorTab` private to the file. Preserve the exact close behavior (remove tab, re-select neighbor) — copy it verbatim. If `close` lived in ReviewView, move the logic into the bar (operate on the bindings) or expose an `onClose` closure; pick the smaller change. Theme/typography unchanged.

- [ ] **Step 3: Update `ReviewView`** to use the extracted `EditorTabBar` (delete its now-duplicated local copy). No behavior change.

- [ ] **Step 4: Build + launch smoke.** `Build complete!`; launch; open Review Code, confirm tabs still open/close (smoke = no crash).

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(editor): extract reusable EditorTabBar"`

---

## Task 4: ExplorerView + sidebar section

**Files:** Create `Views/Explorer/ExplorerView.swift`; Modify `Services/ShellState.swift`, `Views/Shell/SidebarView.swift`, `Views/AppShell.swift`.

- [ ] **Step 1: Sidebar section.** In `ShellState.swift` add a `Section` case `explorer` with all switch arms: `label` "Explorer", `systemImage` "folder", a tint (e.g. a blue), `category` "Code" (or a new group), add to `userHideable` if appropriate. Route in `AppShell.sectionView`: `case .explorer: ExplorerView(api: api)`. Add to `SidebarView.codeSections`. Grep every `switch` over `Section` and add the case (avoid non-exhaustive build break).

- [ ] **Step 2: ExplorerView.** Create the view:
  - `@EnvironmentObject var config: AppConfig`, `@EnvironmentObject var projectStore: ProjectStore` (confirm how to reach the active project root — `projectStore.activeProject?.localPath`), `@EnvironmentObject var theme: ThemeStore`.
  - `root: URL?` = active project folder.
  - Left pane: a recursive tree. Maintain `@State expanded: Set<String>` (node id), `@State childrenCache: [String: [FileSystemTree.Node]]`. Render top-level `FileSystemTree.children(of: root)`; each folder row toggles expansion (lazy-load + cache children on first expand); each file row sets selection → opens a tab. Use a `List`/`OutlineGroup`-style indented rows or recursive row views; reuse `RepoFileTreeRow` visual style if it fits, else a simple `DisclosureGroup`-free manual indent (folder chevron + icon + name).
  - Right pane: `EditorTabBar(tabs: $tabs, activeTab: $activeTab)` + `FileDetailView` for `activeTab` (match how ReviewView instantiates FileDetailView — pass the same params). `@State tabs: [URL] = []`, `@State activeTab: URL?`.
  - Selecting a file: if not in `tabs`, append; set `activeTab`.
  - Empty state when `root == nil`.
  - `HSplitView { tree (minWidth 220) ; editor (minWidth 360) }`.

- [ ] **Step 3: Build.** Iterate to `Build complete!`; fix `FileDetailView` init param mismatches, theme names, Section switch exhaustiveness.

- [ ] **Step 4: Runtime verify + smoke.** Confirm `FileSystemTree.children(of:)` against a real folder (e.g. the project dir) via a quick check; launch `.build/debug/LlmIdeMac`, confirm alive.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(explorer): project file tree + tabbed editor section"`

---

## Self-review (completed)

- **Spec coverage:** gitignore cleanup (T1), live tree model (T2), reusable tabs (T3), Explorer section with tree+tabs+editor (T4). All mapped.
- **Placeholder scan:** pure logic (FileSystemTree, gitignore block) has complete code + tests; UI steps carry explicit "confirm against codebase" notes (FileDetailView init, Section switches, theme names) rather than vague directions.
- **Type consistency:** `FileSystemTree.Node`/`children(of:)` (T2) used by ExplorerView (T4); `EditorTabBar(tabs:activeTab:)` bindings (T3) used by ExplorerView (T4) and ReviewView; `ensureRootGitignore` (T1) self-contained.
- **Confirm-against-codebase flags:** ProjectScaffolder logger name; `LibraryItemStore.noiseDirectoryNames` nonisolated access; ReviewView tab-close logic shape; `FileDetailView` init params; every `ShellState.Section` switch.
