# Project Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project folder layout with `source/`, `code/`, `data/`, `notes/` (mirroring the Library's four sections) plus a single visible `system/` folder for all generated/system data (settings, faults, graph, index, cache), routed through one `ProjectLayout` source of truth.

**Architecture:** Introduce `ProjectLayout` (vends every canonical project path); replace the ~15 hardcoded folder-name literals with it; the rename then lives in one file. Fresh start — no migration; old-layout projects no longer validate.

**Tech Stack:** Swift 5.9 / SwiftUI / Swift Testing.

**Spec:** [docs/superpowers/specs/2026-06-21-project-layout-redesign-design.md](../specs/2026-06-21-project-layout-redesign-design.md)

**Build/verify note:** `swift build`/`swift test` need `dangerouslyDisableSandbox: true` in this environment. Run tests in the FOREGROUND.

---

## File Structure

| Path | Change |
|---|---|
| `Sources/LlmIdeMac/Services/ProjectLayout.swift` | **Create** — single source of truth for project paths. |
| `Services/ProjectPaths.swift` | Route via ProjectLayout names; images → `data/` (not `assets/`). |
| `Services/ProjectScaffolder.swift` | New dirs, marker `system/project.json`, README, gitignore. |
| `Services/ProjectStore.swift` | Marker read/write at `system/project.json`; meetings→source. |
| `Services/LibraryItemStore.swift` | `scanFolders` = source/code/data/notes. |
| `Services/ProjectExporter.swift` | meetings→`source/`, sync→`system/sync.json`, drop `plans/`. |
| `Services/AppEnvironment.swift` | index → `system/index.sqlite`; notes output unchanged name. |
| `CodeGraph/MemoryStore.swift` | `memorySubdir` default → `system/faults`. |
| `CodeNotes/CodeNoteGenerator.swift`, `CodeNotes/AnalyzePhase.swift` | `.code-notes` → `system/graph`. |
| `Services/IgnoreList.swift`, `Services/SourceControlService.swift` | artifact dirs → `system/graph`. |
| `Views/Regression/RegressionView.swift`, `Views/AutoCode/AutoCodeView.swift`, `Views/CodeAssistant/ReportFaultSheet.swift` | fault paths via layout. |
| `Models/Config.swift`, `Models/Project.swift`, `Models/PathValidator.swift` | remove `uaBinaryOverride` + memorySubdir warning. |
| `Views/Settings/PathsSettingsSection.swift`, `Views/Welcome/WelcomeView.swift` | UI tree + copy. |

---

## Task 1: `ProjectLayout` — single source of truth

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ProjectLayout.swift`
- Test: `mac/Tests/LlmIdeMacTests/ProjectLayoutTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectLayoutTests {
    private let root = URL(fileURLWithPath: "/tmp/proj")
    private var L: ProjectLayout { ProjectLayout(root: root) }

    @Test func userFoldersAreUnderRoot() {
        #expect(L.sourceDir.path == "/tmp/proj/source")
        #expect(L.codeDir.path   == "/tmp/proj/code")
        #expect(L.dataDir.path   == "/tmp/proj/data")
        #expect(L.notesDir.path  == "/tmp/proj/notes")
    }
    @Test func systemPathsAreUnderSystem() {
        #expect(L.systemDir.path   == "/tmp/proj/system")
        #expect(L.projectJSON.path == "/tmp/proj/system/project.json")
        #expect(L.faultsDir.path   == "/tmp/proj/system/faults")
        #expect(L.graphDir.path    == "/tmp/proj/system/graph")
        #expect(L.indexDB.path     == "/tmp/proj/system/index.sqlite")
        #expect(L.syncJSON.path    == "/tmp/proj/system/sync.json")
        #expect(L.cacheDir.path    == "/tmp/proj/system/cache")
    }
    @Test func userFoldersListMirrorsLibrarySections() {
        let names = ProjectLayout.userFolders.map(\.name)
        #expect(names == ["source", "code", "data", "notes"])
        let cats = ProjectLayout.userFolders.map(\.category)
        #expect(cats == [.meetings, .code, .data, .notes])
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`cd mac && swift test --filter ProjectLayoutTests`): no `ProjectLayout`.

- [ ] **Step 3: Implement**

```swift
// mac/Sources/LlmIdeMac/Services/ProjectLayout.swift
import Foundation

/// Single source of truth for every canonical path inside a LLM IDE project.
/// All folder-name string literals live HERE and nowhere else, so the layout
/// can be changed in one place.
///
/// ```
/// <root>/
/// ├── source/   code/   data/   notes/     ← user content (= Library sections)
/// └── system/                              ← generated / system data
///     ├── project.json  (marker + settings)
///     ├── faults/   graph/   cache/
///     └── index.sqlite   sync.json
/// ```
struct ProjectLayout {
    let root: URL

    // User content — mirrors the Library's four sections.
    var sourceDir: URL { root.appendingPathComponent("source", isDirectory: true) }
    var codeDir:   URL { root.appendingPathComponent("code", isDirectory: true) }
    var dataDir:   URL { root.appendingPathComponent("data", isDirectory: true) }
    var notesDir:  URL { root.appendingPathComponent("notes", isDirectory: true) }

    // System / generated data — one visible container.
    var systemDir:   URL { root.appendingPathComponent("system", isDirectory: true) }
    var projectJSON: URL { systemDir.appendingPathComponent("project.json") }
    var faultsDir:   URL { systemDir.appendingPathComponent("faults", isDirectory: true) }
    var graphDir:    URL { systemDir.appendingPathComponent("graph", isDirectory: true) }
    var indexDB:     URL { systemDir.appendingPathComponent("index.sqlite") }
    var syncJSON:    URL { systemDir.appendingPathComponent("sync.json") }
    var cacheDir:    URL { systemDir.appendingPathComponent("cache", isDirectory: true) }

    /// Memory subdir (relative) used by MemoryStore for faults + q&a.
    static let faultsSubdir = "system/faults"

    /// User-content folders mirroring the Library sections, paired with the
    /// LibraryItem.Category the scanner/import-router uses.
    static let userFolders: [(name: String, category: LibraryItem.Category)] = [
        ("source", .meetings),
        ("code",   .code),
        ("data",   .data),
        ("notes",  .notes),
    ]
}
```

- [ ] **Step 4: Run — expect PASS (3/3).**
- [ ] **Step 5: Commit** `git add … && git commit -m "feat(project): ProjectLayout single source of truth"`

---

## Task 2: `ProjectPaths` — route via the new layout

**Files:** Modify `mac/Sources/LlmIdeMac/Services/ProjectPaths.swift`; Test `mac/Tests/LlmIdeMacTests/ProjectPathsTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectPathsTests {
    private let root = URL(fileURLWithPath: "/tmp/proj")
    @Test func codeRoutesToCode() {
        #expect(ProjectPaths.destinationURL(root: root, category: .code, fileName: "a.swift").path == "/tmp/proj/code/a.swift")
    }
    @Test func dataRoutesToData() {
        #expect(ProjectPaths.destinationURL(root: root, category: .data, fileName: "x.csv").path == "/tmp/proj/data/x.csv")
    }
    @Test func imageRoutesToData() {   // images fold into data/ now (assets removed)
        #expect(ProjectPaths.destinationURL(root: root, category: .data, fileName: "p.png").path == "/tmp/proj/data/p.png")
        #expect(ProjectPaths.destinationURL(root: root, category: .code, fileName: "p.png").path == "/tmp/proj/data/p.png")
    }
    @Test func noteRoutesToNotes() {
        #expect(ProjectPaths.destinationURL(root: root, category: .notes, fileName: "n.md").path == "/tmp/proj/notes/n.md")
    }
    @Test func meetingsRoutesToSource() {
        #expect(ProjectPaths.destinationURL(root: root, category: .meetings, fileName: "m.md").path == "/tmp/proj/source/m.md")
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (image currently → `assets`, meetings → `meetings`).

- [ ] **Step 3: Replace `subfolder(for:fileName:)`** in `ProjectPaths.swift`:

```swift
    /// The canonical subfolder a file belongs in. Images fold into data/.
    static func subfolder(for category: LibraryItem.Category, fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.lowercased()
        if imageExtensions.contains(ext) { return "data" }
        switch category {
        case .code:     return "code"
        case .data:     return "data"
        case .notes:    return "notes"
        case .meetings: return "source"
        }
    }
```
(Leave `imageExtensions`, `destinationURL`, `isInside` unchanged. Update the doc comment on `imageExtensions` from "assets/" to "data/".)

- [ ] **Step 4: Run — expect PASS (5/5).**
- [ ] **Step 5: Commit** `git commit -m "feat(project): route imports into source/code/data/notes"`

---

## Task 3: `ProjectScaffolder` — new tree, marker, gitignore, README

**Files:** Modify `mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift`; Test `mac/Tests/LlmIdeMacTests/ProjectScaffolderLayoutTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectScaffolderLayoutTests {
    private func tmp() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("scaf-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private func project(_ root: URL) -> Project { Project.makeDefault(folder: root) }

    @Test func scaffoldCreatesNewLayout() throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try ProjectScaffolder.scaffold(at: root, project: project(root))
        let fm = FileManager.default
        for d in ["source", "code", "data", "notes", "system", "system/faults", "system/graph", "system/cache"] {
            var isDir: ObjCBool = false
            #expect(fm.fileExists(atPath: root.appendingPathComponent(d).path, isDirectory: &isDir) && isDir.boolValue)
        }
        // No legacy folders.
        for d in ["meetings", "plans", "assets", ".llmide", ".understand-anything", ".code-notes"] {
            #expect(!fm.fileExists(atPath: root.appendingPathComponent(d).path))
        }
    }

    @Test func validateAcceptsNewMarkerAndEmpty_rejectsOldLayout() throws {
        let fm = FileManager.default
        // empty → ok
        let empty = try tmp(); defer { try? fm.removeItem(at: empty) }
        #expect(throws: Never.self) { try ProjectScaffolder.validate(at: empty) }
        // new marker → ok
        let marked = try tmp(); defer { try? fm.removeItem(at: marked) }
        try fm.createDirectory(at: marked.appendingPathComponent("system"), withIntermediateDirectories: true)
        try "{}".write(to: marked.appendingPathComponent("system/project.json"), atomically: true, encoding: .utf8)
        #expect(throws: Never.self) { try ProjectScaffolder.validate(at: marked) }
        // old layout (meetings/notes/plans, no system marker) → reject
        let old = try tmp(); defer { try? fm.removeItem(at: old) }
        for d in ["meetings", "notes", "plans"] { try fm.createDirectory(at: old.appendingPathComponent(d), withIntermediateDirectories: true) }
        #expect(throws: (any Error).self) { try ProjectScaffolder.validate(at: old) }
    }
}
```

NOTE: the test uses `Project.makeDefault(folder:)`. If the real factory has a different name, the implementer adapts the test to the actual `Project` factory used elsewhere (grep `createFromDefaults`/`Project(`); the scaffold only reads `project.displayName`/`settings` for the README.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Rewrite `requiredDirectories`:**

```swift
    static let requiredDirectories = [
        "source", "code", "data", "notes",
        "system", "system/faults", "system/graph", "system/cache",
    ]
```

- [ ] **Step 4: Rewrite `validate(at:)`** — accept only the new marker or an empty folder (drop the `.llmide`/`.meetnotes`/meetings-heuristic acceptors):

```swift
    static func validate(at folderURL: URL) throws {
        let fm = FileManager.default
        // 1. New-layout project marker.
        if fm.fileExists(atPath: folderURL.appendingPathComponent("system/project.json").path) { return }
        // 2. Empty folder — new project to scaffold.
        let contents = (try? fm.contentsOfDirectory(atPath: folderURL.path)) ?? []
        if contents.isEmpty { return }
        throw ProjectStoreError.invalidFolderStructure(folderURL.lastPathComponent)
    }
```

- [ ] **Step 5: Update `.gitkeep` loop** (notes + a data placeholder) and the **README folder-structure block** + **managed gitignore block**:

Change the `.gitkeep` dirs line to:
```swift
        for dir in ["notes", "data"] {
```
Replace `managedGitignoreBlock` with:
```swift
    private static let managedGitignoreBlock = """
    # >>> LLM IDE managed (auto-generated / ephemeral) — edit your own rules above
    system/cache/
    system/index.sqlite
    system/index.sqlite-shm
    system/index.sqlite-wal
    system/graph/
    system/sync.json
    *.partial.md
    # <<< LLM IDE managed
    """
```
In `makeReadme(...)`, replace the `## Folder Structure` fenced block with:
```
\(name)/
├── source/   ← meeting & email transcripts (your Sources)
├── code/     ← code files
├── data/     ← documents, data files, images
├── notes/    ← notes generated from meetings/email
└── system/   ← LLM IDE managed: settings, faults, graph, index (most git-ignored)
```
(Drop the Plans section of the README; keep the Meetings section but point it at `source/`.)

- [ ] **Step 6: Run — expect PASS.** Then `cd mac && swift build 2>&1 | tail -3` (other files still reference old paths — expect compile errors only if scaffolder referenced removed symbols; it doesn't, so build should pass for this file).

- [ ] **Step 7: Commit** `git commit -m "feat(project): scaffold source/code/data/notes/system + new marker"`

---

## Task 4: `ProjectStore` — marker at `system/project.json`, meetings→source

**Files:** Modify `mac/Sources/LlmIdeMac/Services/ProjectStore.swift`

- [ ] **Step 1:** Replace every `appendingPathComponent(".llmide/project.json")` (lines ~80, 132, 279, 306) with `appendingPathComponent("system/project.json")`. Remove the `.meetnotes/project.json` legacy fallback (line ~281) and the `migrateLegacyMarker` call at line ~73 + the `.meetnotes` recents check.

- [ ] **Step 2:** Line ~107 — the notes/meetings folder sync: change
```swift
        let meetingsFolder = url.appendingPathComponent("meetings", isDirectory: true)
        try? NotesFolderConfig().setFolderFromPath(meetingsFolder)
```
to
```swift
        let sourceFolder = url.appendingPathComponent("source", isDirectory: true)
        try? NotesFolderConfig().setFolderFromPath(sourceFolder)
```
- [ ] **Step 3:** Line ~335 — any other `appendingPathComponent("meetings", ...)` → `"source"`.

- [ ] **Step 4:** Build: `cd mac && swift build 2>&1 | tail -5`. Other files may still fail to compile — that's fine; this task's file should be internally consistent. If `migrateLegacyMarker` is now unused, delete the method.

- [ ] **Step 5: Commit** `git commit -m "feat(project): project marker at system/project.json; meetings→source"`

---

## Task 5: `LibraryItemStore.scanFolders`

**Files:** Modify `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift`

- [ ] **Step 1:** Replace the `scanFolders` array (lines ~90-96) with:
```swift
    nonisolated private static let scanFolders: [(subfolder: String, category: LibraryItem.Category)] = [
        ("source", .meetings),
        ("code",   .code),
        ("data",   .data),
        ("notes",  .notes),
    ]
```
(Removes the `meetings`/`assets` entries; images now live in `data/`, captured transcripts in `source/`.)

- [ ] **Step 2:** Grep this file for any other `"meetings"`/`"assets"` literal and update (the meeting-vs-mail frontmatter classifier comment referencing `meetings/` is cosmetic; the logic keys off frontmatter, not the folder name — leave logic, fix comment).

- [ ] **Step 3:** Build. **Commit** `git commit -m "feat(library): scan source/code/data/notes"`

---

## Task 6: `ProjectExporter` — meetings→source, sync→system, drop plans

**Files:** Modify `mac/Sources/LlmIdeMac/Services/ProjectExporter.swift`

- [ ] **Step 1:** Line ~94 `appendingPathComponent("meetings")` → `appendingPathComponent("source")`.
- [ ] **Step 2:** Remove the plans-export block (lines ~130-164: `plansRoot`, the `.md`/`.json`/`_index.json` writes, and the `"plans": planIndexEntries` entry). Plans are no longer a project folder; DocGen exports route to `data/` (Task 9 handles DocGen).
- [ ] **Step 3:** The `sync.json` write (line ~172 area, currently `.llmide/sync.json`) → `system/sync.json`. The index-entries JSON (`meetings`/`plans` keys, line ~125/162) — keep the `meetings` entry (now sourced from `source/`); drop the `plans` key.
- [ ] **Step 4:** Build. **Commit** `git commit -m "feat(export): export to source/ + system/sync.json; drop plans export"`

---

## Task 7: `AppEnvironment` — index at `system/index.sqlite`

**Files:** Modify `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift`

- [ ] **Step 1:** Lines ~31, 34 — `appendingPathComponent(".llmide")` → `"system"`, and `appendingPathComponent(".llmide/index.sqlite")` → `"system/index.sqlite"`. Update surrounding comments (`.llmide/` → `system/`).
- [ ] **Step 2:** Lines ~89, 92 — the notes output folder is already `"notes"`; leave unchanged (notes/ stays). Verify the indexer root: it reads `NotesFolderConfig().currentFolder`, which ProjectStore now points at `source/` (Task 4) — no change needed here.
- [ ] **Step 3:** Build. **Commit** `git commit -m "feat(env): meeting index at system/index.sqlite"`

---

## Task 8: `MemoryStore` — faults under `system/faults`

**Files:** Modify `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift`, `Models/Config.swift`, `Models/PathValidator.swift`; fault-path UI sites.

- [ ] **Step 1:** `MemoryStore.swift` — change the default `memorySubdir` (init default + the empty-fallback, lines ~24, 28) from `".understand-anything/memory"` to `ProjectLayout.faultsSubdir` (`"system/faults"`). Update the legacy `bugs`→`faults` migration comment only (keep the rename logic).
- [ ] **Step 2:** `Config.swift` — `defaultMemorySubdir` (line ~299) → `"system/faults"`.
- [ ] **Step 3:** `PathValidator.swift` — remove the memorySubdir "Understand-Anything skill expects" warning (lines ~61-63); keep the basic path validation (no absolute/`..`).
- [ ] **Step 4:** Replace hardcoded fault paths with `ProjectLayout(root: repo).faultsDir`:
  - `Views/Regression/RegressionView.swift` lines ~229, 242: `appendingPathComponent(".understand-anything/memory/faults")` → `ProjectLayout(root: repo).faultsDir`.
  - `Views/AutoCode/AutoCodeView.swift` line ~342 + `Services/AutoCodeUpdateService.swift` comments: update the help text/comment to `system/faults/`.
  - `Views/CodeAssistant/ReportFaultSheet.swift` lines ~5,20 comments → `system/faults/`.
- [ ] **Step 5:** Run `cd mac && swift test --filter "MemoryStore|RegressionGate|RegressionPipeline"` (faults now write under `system/faults`; the MemoryStore tests construct their own store so they pass with the new default). Build.
- [ ] **Step 6: Commit** `git commit -m "feat(faults): faults live under system/faults"`

---

## Task 9: Graph under `system/graph` + DocGen → data/

**Files:** Modify `CodeNotes/CodeNoteGenerator.swift`, `CodeNotes/AnalyzePhase.swift`, `Services/IgnoreList.swift`, `Services/SourceControlService.swift`, `ViewModels/DocGenViewModel.swift` (+ its export callsite passing `projectRoot`).

- [ ] **Step 1:** `CodeNoteGenerator.swift` — replace every `".code-notes/notes"` → `"system/graph/notes"` and `".code-notes"` → `"system/graph"` (lines ~26, 32, 142, 204). `AnalyzePhase.swift:40` `notesDir: ".code-notes/notes"` → `"system/graph/notes"`. Update the doc comments accordingly.
- [ ] **Step 2:** `IgnoreList.swift:8` — replace `".understand-anything", ".code-notes"` in the ignore set with `"system"` (the whole system dir is ignored for code-scan purposes). `SourceControlService.swift:386` — the generated-artifact dirs loop `[".code-notes", ".understand-anything"]` → `["system/graph", "system/cache"]`.
- [ ] **Step 3:** DocGen export target — `DocGenViewModel.exportMarkdown` writes to `<projectRoot>/plans/` via `api.exportMarkdown(..., projectRoot:)`. Change the destination so it lands in `data/`: locate where `api.exportMarkdown` builds the path (grep `exportMarkdown` impl) and route the project-root case to `ProjectLayout(root: projectRoot).dataDir`. If the path is built inside the API client, update there; otherwise pass `dataDir` from the caller.
- [ ] **Step 4:** Build + `cd mac && swift test --filter "CodeNote|Graph"` if such suites exist. **Commit** `git commit -m "feat(graph): code graph under system/graph; DocGen exports to data/"`

---

## Task 10: Remove the vestigial UA-binary setting

**Files:** Modify `Models/Config.swift`, `Models/Project.swift`, `Services/ProjectStore.swift`, `Views/Settings/PathsSettingsSection.swift`.

- [ ] **Step 1:** `Config.swift` — remove the `uaBinaryOverride` `@Published` property (line ~282 area) + its `defaults` write-through + its init line. Grep `uaBinaryOverride` and remove all references.
- [ ] **Step 2:** `Project.swift` / `ProjectStore.swift` (line ~61 `uaBinaryOverride: ""`) — remove the field from `ProjectSettings`/`defaultProjectSettings` (and its Codable key if present). NOTE: dropping a Codable field is safe with `decodeIfPresent`; verify ProjectSettings uses `decodeIfPresent` or remove the key cleanly.
- [ ] **Step 3:** `PathsSettingsSection.swift` — remove the `uaBinaryRow` view + its call site (lines ~374-385 + the Divider before it).
- [ ] **Step 4:** Build (expect clean). **Commit** `git commit -m "chore(project): remove vestigial understand-anything CLI setting"`

---

## Task 11: Paths UI + Welcome copy

**Files:** Modify `Views/Settings/PathsSettingsSection.swift`, `Views/Welcome/WelcomeView.swift`.

- [ ] **Step 1:** `PathsSettingsSection.swift` — the `projectPathsPanel` lists folder rows (`meetings/ plans/ notes/ assets/ code/ data/`, lines ~97-162). Replace with rows for `source/ code/ data/ notes/ system/` using `ProjectLayout`:
```swift
        projectFolderRow(label: "source/", icon: "waveform", url: L.sourceDir, note: "Meeting & email transcripts", accent: t.accent)
        projectFolderRow(label: "code/",   icon: "chevron.left.forwardslash.chevron.right", url: L.codeDir, note: "Code files", accent: t.textMuted)
        projectFolderRow(label: "data/",   icon: "tablecells", url: L.dataDir, note: "Documents, data, images", accent: t.textMuted)
        projectFolderRow(label: "notes/",  icon: "note.text", url: L.notesDir, note: "Generated notes", accent: t.textMuted)
        projectFolderRow(label: "system/", icon: "gearshape", url: L.systemDir, note: "Settings, faults, graph, index (managed)", accent: t.textMuted)
```
where `let L = ProjectLayout(root: projectURL)`. Update the "Per-repo memory" row label/help that referenced `.understand-anything/memory` → `system/faults` (and drop the "Understand-Anything skill expects" sentence). Remove the `meetingsURL/plansURL/assetsURL` locals that are no longer used.
- [ ] **Step 2:** `WelcomeView.swift` — update the doc comment in `newProject()` that lists `meetings/plans/notes/…` to the new folder names (cosmetic).
- [ ] **Step 3:** Build. **Commit** `git commit -m "feat(settings): Paths panel shows source/code/data/notes/system"`

---

## Task 12: Full verification + fresh-project smoke

- [ ] **Step 1:** Full suite: `cd mac && swift test 2>&1 | tail -5` — expect all green (no NEW failures vs. baseline; some old layout-specific tests may need updating — fix any that assert old folder names, e.g. existing `MemoryStoreCSVTests`, `ProjectTests`, `ProjectStoreTests`; grep tests for `"meetings"`/`.llmide`/`.understand-anything`/`.code-notes` and update assertions to the new paths).
- [ ] **Step 2:** Build the app: `bash mac/Scripts/build.sh 2>&1 | tail -2`.
- [ ] **Step 3:** Manual smoke (the implementer reports the steps; a human runs them): New Project → confirm the created folder contains exactly `source/ code/ data/ notes/ system/` + `system/project.json` + `README.md` + `.gitignore`; open it → Explorer shows those folders; add a file via Library → lands in the right folder; file a fault → appears under `system/faults/`.
- [ ] **Step 4:** Final commit if smoke fixes were needed.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `ProjectLayout` single source of truth | Task 1 |
| Top level = source/code/data/notes (Library mirror) | Tasks 1, 3, 5 |
| Images fold into data/ | Task 2 |
| `system/` holds settings+faults+graph+index+cache | Tasks 3, 7, 8, 9 |
| Project marker `system/project.json` | Tasks 3, 4 |
| Faults under `system/faults` | Task 8 |
| Graph under `system/graph` | Task 9 |
| DocGen → data/ (plans removed) | Tasks 6, 9 |
| gitignore: faults committed, graph/cache/index ignored | Task 3 |
| Fresh start: validate rejects old layout | Task 3 |
| Remove vestigial UA binary + memorySubdir warning | Tasks 8, 10 |
| Paths UI + Welcome copy | Task 11 |

**Placeholder scan:** The two soft spots are Task 3 (`Project.makeDefault` factory name) and Task 9 Step 3 (`api.exportMarkdown` path-build location) — both name the exact symbol to grep and the exact target (`dataDir`), so the implementer resolves them against real code rather than guessing.

**Type consistency:** `ProjectLayout` property names (`sourceDir`, `dataDir`, `faultsDir`, `graphDir`, `systemDir`, `projectJSON`, `indexDB`, `syncJSON`, `cacheDir`) and `ProjectLayout.userFolders` / `faultsSubdir` are used consistently across Tasks 2–11.

**Note on existing tests:** several suites (`ProjectStoreTests`, `ProjectTests`, `MemoryStoreCSVTests`, `RegressionGateTests` helpers) construct or assert old paths. Task 12 Step 1 explicitly folds in updating them — grep tests for the old literals.
