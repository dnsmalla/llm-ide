# Project Single-Source Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active project's folder the single source of truth for every file the app shows, with a fixed canonical folder set, copy-once-on-add for external files, and all writers + menus pointed at those folders.

**Architecture:** Extend `ProjectScaffolder` with `code/` + `data/`. Rework `LibraryItemStore` so its index is a *scan* of the active project's canonical folders (plus external folder references), with copy-on-add routing for external files. Redirect the DocGen and meeting-notes writers into the project. Simplify Settings → Paths to show the project's real folders.

**Tech Stack:** Swift / SwiftUI, `FileManager`, `@Observable`. Node/Express server for the DocGen export route.

**Environment note:** `swift test` is a no-op in this environment (no XCTest runner). Every "run the test" step is therefore: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` to confirm the test **compiles** and encodes the contract, plus a manual app run for behavioural verification. Tests are still written first (they compile-fail before the code exists).

---

## File structure

- `mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift` — canonical folder set + validate (Task 1).
- `mac/Sources/LlmIdeMac/Services/ProjectPaths.swift` — **new**: pure helpers mapping a category/URL to a canonical subfolder, and resolving subfolder URLs under a project root (Task 2).
- `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift` — project-root binding, scan-as-index, copy-on-add routing, external-folder refs, migration (Tasks 3–6).
- `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Export.swift` + `Views/DocGenViewModel.swift` — DocGen export → `plans/` (Task 7).
- `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift` — `.docx` notes destination → `<project>/notes` (Task 8).
- `mac/Sources/LlmIdeMac/Views/Settings/PathsSettingsSection.swift` + `Models/Config.swift` — project-folder panel, relabel `dataRoot`, retire dead global subfolder rows (Task 9).
- `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` — wire add-file/folder call sites to the project root (Task 10).
- Tests: `mac/Tests/LlmIdeMacTests/ProjectPathsTests.swift`, `LibraryItemStoreRoutingTests.swift`, `ProjectScaffolderTests.swift` (extend if present).

---

## Task 1: Canonical folder set (`code/` + `data/`)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift:33-40`
- Test: `mac/Tests/LlmIdeMacTests/ProjectScaffolderTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite struct ProjectScaffolderCanonicalTests {
    @Test func scaffoldCreatesCodeAndDataFolders() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("proj-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let project = Project(displayName: "t")   // existing minimal init
        try ProjectScaffolder.scaffold(at: tmp, project: project)

        for dir in ["meetings", "plans", "notes", "assets", "code", "data"] {
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(
                atPath: tmp.appendingPathComponent(dir).path, isDirectory: &isDir)
            #expect(exists && isDir.boolValue, "missing \(dir)")
        }
    }
}
```

(If `Project(displayName:)` is not a valid initializer, construct it the
same way `ProjectScaffolderTests` already does — check the existing test
file first and reuse its helper.)

- [ ] **Step 2: Build the test target to confirm it fails to satisfy the assertion**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: compiles; the `code`/`data` assertions would fail at runtime
(can't run here — proceed once it compiles).

- [ ] **Step 3: Add the folders to the canonical set**

In `ProjectScaffolder.swift:33-40`:

```swift
    static let requiredDirectories = [
        ".llmide",
        ".llmide/cache",   // runtime cache; gitignored
        "meetings",
        "plans",
        "notes",
        "assets",
        "code",
        "data",
    ]
```

- [ ] **Step 4: Leave `validate` lenient (do NOT add code/data to required)**

`validate` keeps `topLevelRequired = ["meetings", "notes", "plans"]`
(`ProjectScaffolder.swift:70`). Adding `code`/`data` there would reject
legacy projects. The idempotent `scaffold` (called on every open) fills
them in, so no validation change is needed. Add a code comment noting this.

- [ ] **Step 5: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift mac/Tests/LlmIdeMacTests/ProjectScaffolderTests.swift
git commit -m "feat(paths): add code/ and data/ to canonical project folders"
```

---

## Task 2: `ProjectPaths` routing helpers (pure, testable)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ProjectPaths.swift`
- Test: `mac/Tests/LlmIdeMacTests/ProjectPathsTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite struct ProjectPathsTests {
    @Test func imageFilesRouteToAssets() {
        #expect(ProjectPaths.subfolder(for: .notes, fileName: "diagram.png") == "assets")
        #expect(ProjectPaths.subfolder(for: .data,  fileName: "shot.JPEG")   == "assets")
    }
    @Test func nonImageFilesRouteByCategory() {
        #expect(ProjectPaths.subfolder(for: .notes, fileName: "spec.md")  == "notes")
        #expect(ProjectPaths.subfolder(for: .data,  fileName: "rows.csv") == "data")
        #expect(ProjectPaths.subfolder(for: .code,  fileName: "main.swift") == "code")
        #expect(ProjectPaths.subfolder(for: .meetings, fileName: "m.md")  == "meetings")
    }
    @Test func destinationURLJoinsRootAndSubfolder() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let dest = ProjectPaths.destinationURL(root: root, category: .data, fileName: "rows.csv")
        #expect(dest.path == "/tmp/proj/data/rows.csv")
    }
    @Test func isInsideDetectsContainment() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        #expect(ProjectPaths.isInside(URL(fileURLWithPath: "/tmp/proj/notes/a.md"), root: root))
        #expect(!ProjectPaths.isInside(URL(fileURLWithPath: "/tmp/other/a.md"), root: root))
    }
}
```

- [ ] **Step 2: Build the test target — expect compile failure (no `ProjectPaths`)**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: FAIL — "cannot find 'ProjectPaths' in scope".

- [ ] **Step 3: Implement `ProjectPaths`**

```swift
import Foundation

/// Pure path-routing rules for the single-source project layout.
/// No I/O — these decide *where* a file belongs; the store does the move.
enum ProjectPaths {
    /// Image extensions always live under assets/, regardless of the
    /// section the user added from.
    static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "bmp", "tiff", "svg"
    ]

    /// The canonical subfolder a file belongs in.
    static func subfolder(for category: LibraryItem.Category, fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.lowercased()
        if imageExtensions.contains(ext) { return "assets" }
        switch category {
        case .code:     return "code"
        case .data:     return "data"
        case .notes:    return "notes"
        case .meetings: return "meetings"
        }
    }

    /// Absolute destination for a file copied into the project.
    static func destinationURL(root: URL, category: LibraryItem.Category, fileName: String) -> URL {
        root.appendingPathComponent(subfolder(for: category, fileName: fileName), isDirectory: true)
            .appendingPathComponent(fileName)
    }

    /// True when `url` lives inside `root` (directory-boundary aware).
    static func isInside(_ url: URL, root: URL) -> Bool {
        let r = root.standardizedFileURL.path
        let p = url.standardizedFileURL.path
        return p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }
}
```

- [ ] **Step 4: Build the test target — confirm it compiles**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ProjectPaths.swift mac/Tests/LlmIdeMacTests/ProjectPathsTests.swift
git commit -m "feat(paths): add ProjectPaths routing helpers"
```

---

## Task 3: Bind `LibraryItemStore` to the active project root

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift:8-17`
- Modify: `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift` (call the binder on project change — find where `activeProject`/`.activeProjectChanged` is observed)

- [ ] **Step 1: Add the project-root property + binder**

In `LibraryItemStore` (after `private(set) var items`):

```swift
    /// Root of the active project. When set, the index is a scan of this
    /// folder's canonical subfolders; add/import route files under here.
    private(set) var projectRoot: URL?

    /// Point the store at a project root (or nil when none open) and rescan.
    func bindProject(root: URL?) {
        guard projectRoot?.standardizedFileURL != root?.standardizedFileURL else { return }
        projectRoot = root
        rescan()
    }
```

- [ ] **Step 2: Add a stub `rescan()` (filled in Task 4) so it compiles**

```swift
    /// Rebuild `items` from the project's canonical folders. (Task 4.)
    func rescan() { /* implemented in Task 4 */ }
```

- [ ] **Step 3: Call the binder when the active project changes**

In `AppEnvironment` (or wherever `ProjectStore.activeProject` is observed /
`.activeProjectChanged` is handled — confirm the exact site), after the
active project resolves, call:

```swift
libraryStore.bindProject(root: projectStore.activeProject?.localPath)
```

- [ ] **Step 4: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift mac/Sources/LlmIdeMac/Services/AppEnvironment.swift
git commit -m "feat(paths): bind LibraryItemStore to active project root"
```

---

## Task 4: Scan-as-index

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/LibraryItemStoreRoutingTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor @Suite struct LibraryItemStoreScanTests {
    private func tmpProject() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("proj-\(UUID().uuidString)")
        for d in ["notes", "data", "assets", "code", "meetings", "plans"] {
            try FileManager.default.createDirectory(
                at: root.appendingPathComponent(d), withIntermediateDirectories: true)
        }
        return root
    }

    @Test func scanIndexesFilesByFolder() throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try "hi".write(to: root.appendingPathComponent("notes/a.md"), atomically: true, encoding: .utf8)
        try "x,y".write(to: root.appendingPathComponent("data/t.csv"), atomically: true, encoding: .utf8)

        let store = LibraryItemStore()
        store.bindProject(root: root)

        #expect(store.items(for: .notes).contains { $0.name == "a.md" })
        #expect(store.items(for: .data).contains { $0.name == "t.csv" })
    }
}
```

- [ ] **Step 2: Build the test target — expect runtime-contract gap (compiles)**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: compiles; the assertions encode the contract.

- [ ] **Step 3: Implement `rescan()`**

Replace the Task-3 stub with:

```swift
    func rescan() {
        guard let root = projectRoot else { items = []; return }
        var scanned: [LibraryItem] = []

        // Canonical folder → category. Images under any folder still read
        // back under their on-disk folder's category (assets has no
        // category of its own, so assets/ files are surfaced under .data).
        let map: [(sub: String, category: LibraryItem.Category)] = [
            ("notes", .notes), ("data", .data), ("assets", .data),
            ("code", .code), ("meetings", .meetings),
        ]
        let fm = FileManager.default
        for entry in map {
            let dir = root.appendingPathComponent(entry.sub, isDirectory: true)
            guard let en = fm.enumerator(at: dir,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]) else { continue }
            for case let url as URL in en {
                let name = url.lastPathComponent
                if Self.noiseDirectoryNames.contains(name),
                   (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    en.skipDescendants(); continue
                }
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                else { continue }
                if entry.category == .code, !Self.isCodeRelevant(url: url) { continue }
                if name.hasSuffix(".partial.md") || name == "template.md" { continue }
                var item = LibraryItem(name: name, path: url.path, category: entry.category)
                item.folderOrigin = url.deletingLastPathComponent().lastPathComponent == entry.sub
                    ? nil : url.deletingLastPathComponent().lastPathComponent
                scanned.append(item)
            }
        }

        // External referenced code folders (not copied into the project).
        scanned.append(contentsOf: externalFolderItems())
        items = scanned
    }

    /// Code items from external referenced folders (config.localCodeFolders).
    /// Wired in Task 6; returns [] until then.
    private func externalFolderItems() -> [LibraryItem] { [] }
```

- [ ] **Step 4: Make `init()` not auto-load the legacy file**

Change `init() { load() }` to `init() {}`. The legacy `load()`/`save()`
and `StoreFile` are retained only for the one-time migration (Task 6);
the live index now comes from `rescan()`.

- [ ] **Step 5: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift mac/Tests/LlmIdeMacTests/LibraryItemStoreRoutingTests.swift
git commit -m "feat(paths): make LibraryItemStore index a scan of project folders"
```

---

## Task 5: Copy-on-add routing (external files copied, in-project referenced, replace on conflict)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift:23-65`
- Test: `mac/Tests/LlmIdeMacTests/LibraryItemStoreRoutingTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
@MainActor @Suite struct LibraryItemStoreAddTests {
    private func tmpProject() throws -> URL { /* same helper as Task 4 */ 
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("proj-\(UUID().uuidString)")
        for d in ["notes","data","assets","code","meetings","plans"] {
            try FileManager.default.createDirectory(
                at: root.appendingPathComponent(d), withIntermediateDirectories: true)
        }
        return root
    }

    @Test func externalFileIsCopiedIntoSubfolder() throws {
        let root = try tmpProject(); defer { try? FileManager.default.removeItem(at: root) }
        let ext = FileManager.default.temporaryDirectory.appendingPathComponent("ext-\(UUID()).md")
        try "hello".write(to: ext, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: ext) }

        let store = LibraryItemStore(); store.bindProject(root: root)
        store.add(url: ext, category: .notes)

        let dest = root.appendingPathComponent("notes/\(ext.lastPathComponent)")
        #expect(FileManager.default.fileExists(atPath: dest.path))      // copied in
        #expect(FileManager.default.fileExists(atPath: ext.path))       // original kept
        #expect(store.items(for: .notes).contains { $0.path == dest.path })
    }

    @Test func inProjectFileIsReferencedNotCopied() throws {
        let root = try tmpProject(); defer { try? FileManager.default.removeItem(at: root) }
        let inside = root.appendingPathComponent("data/keep.csv")
        try "a,b".write(to: inside, atomically: true, encoding: .utf8)

        let store = LibraryItemStore(); store.bindProject(root: root)
        store.add(url: inside, category: .data)

        #expect(store.items(for: .data).filter { $0.path == inside.path }.count == 1)
    }

    @Test func sameNameIsReplaced() throws {
        let root = try tmpProject(); defer { try? FileManager.default.removeItem(at: root) }
        try "old".write(to: root.appendingPathComponent("notes/dup.md"), atomically: true, encoding: .utf8)
        let ext = FileManager.default.temporaryDirectory.appendingPathComponent("dup.md")
        try "new".write(to: ext, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: ext) }

        let store = LibraryItemStore(); store.bindProject(root: root)
        store.add(url: ext, category: .notes)

        let dest = root.appendingPathComponent("notes/dup.md")
        #expect((try? String(contentsOf: dest, encoding: .utf8)) == "new")
    }
}
```

- [ ] **Step 2: Build the test target (compiles, encodes contract)**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`

- [ ] **Step 3: Rewrite `add(url:category:)`**

```swift
    /// Add a single file. External files are copied once into the matching
    /// canonical subfolder (replacing a same-named file); files already in
    /// the project are indexed in place. No-op when no project is bound.
    func add(url: URL, category: LibraryItem.Category) {
        guard let root = projectRoot else { return }
        let fm = FileManager.default
        if ProjectPaths.isInside(url, root: root) {
            rescan()   // already in the project; the scan will surface it
            return
        }
        let dest = ProjectPaths.destinationURL(root: root, category: category, fileName: url.lastPathComponent)
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }  // replace
            try fm.copyItem(at: url, to: dest)
        } catch {
            os_log(.error, "LibraryItemStore.add copy failed: %{public}@", error.localizedDescription)
            return
        }
        rescan()
    }
```

- [ ] **Step 4: Rewrite `addFolder(url:category:)` to register an external reference**

```swift
    /// Reference a folder in place (e.g. a code repo) — never copied.
    /// Persists the path as an external reference and rescans.
    func addFolder(url: URL, category: LibraryItem.Category) {
        guard category == .code else { return }   // only code folders are referenced today
        if !externalCodeFolders.contains(url.path) {
            externalCodeFolders.append(url.path)
            saveExternalFolders()
        }
        rescan()
    }
```

(Define `externalCodeFolders: [String]` backed by the same persistence the
old `config.localCodeFolders` used — see Task 6 for the binding; for now
add `private var externalCodeFolders: [String] = []` and a no-op
`saveExternalFolders()` so it compiles.)

- [ ] **Step 5: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift mac/Tests/LlmIdeMacTests/LibraryItemStoreRoutingTests.swift
git commit -m "feat(paths): copy external files into project subfolders on add"
```

---

## Task 6: External folder references + one-time migration

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift`

- [ ] **Step 1: Implement `externalFolderItems()` (replaces the Task-4 stub)**

```swift
    private func externalFolderItems() -> [LibraryItem] {
        let fm = FileManager.default
        var out: [LibraryItem] = []
        for path in externalCodeFolders {
            let folder = URL(fileURLWithPath: path)
            let name = folder.lastPathComponent
            guard let en = fm.enumerator(at: folder,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]) else { continue }
            for case let url as URL in en {
                if Self.noiseDirectoryNames.contains(url.lastPathComponent),
                   (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    en.skipDescendants(); continue
                }
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                      Self.isCodeRelevant(url: url) else { continue }
                var item = LibraryItem(name: url.lastPathComponent, path: url.path, category: .code)
                item.folderOrigin = name
                out.append(item)
            }
        }
        return out
    }
```

- [ ] **Step 2: Back `externalCodeFolders` with persistence**

Persist to a small JSON next to the old store (or reuse
`AppConfig.localCodeFolders` — pick one source). Recommended: keep reading
`AppConfig.localCodeFolders` so existing references migrate for free. Inject
the list via `bindProject` or a setter `setExternalCodeFolders(_:)` called
alongside `bindProject`. Implement `saveExternalFolders()` to write back to
that same source.

- [ ] **Step 3: One-time migration of the legacy library index**

Add `migrateLegacyIndexIfNeeded(root:)`, called once inside `bindProject`
when a non-nil root is first set and the legacy `library_items.json` exists:

```swift
    private func migrateLegacyIndexIfNeeded(root: URL) {
        guard let url = storeURL, FileManager.default.fileExists(atPath: url.path) else { return }
        let legacy: [LibraryItem]
        if let data = try? Data(contentsOf: url),
           let file = try? AppJSON.decoder.decode(StoreFile.self, from: data) {
            legacy = file.items
        } else { legacy = [] }
        for item in legacy where item.category != .meetings {
            let u = URL(fileURLWithPath: item.path)
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
            guard exists else { continue }
            if isDir.boolValue { addFolder(url: u, category: .code); continue }
            if !ProjectPaths.isInside(u, root: root) {
                add(url: u, category: item.category)   // copy external file in
            }
        }
        // Rename the legacy file aside so migration runs once.
        let done = url.deletingLastPathComponent().appendingPathComponent("library_items.migrated.json")
        try? FileManager.default.moveItem(at: url, to: done)
    }
```

Call it from `bindProject` before `rescan()` when `root != nil`.

- [ ] **Step 4: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 5: Manual verification**

Run the app (`build_app.sh` or the debug binary), open a project that has a
legacy `library_items.json`, confirm out-of-project files appear under the
right sections and a `library_items.migrated.json` is left behind.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift
git commit -m "feat(paths): external folder refs + one-time legacy index migration"
```

---

## Task 7: DocGen export → `plans/`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Export.swift:209-223`
- Modify: `mac/Sources/LlmIdeMac/Views/DocGenViewModel.swift:78-89`

- [ ] **Step 1: Thread a destination directory into the export**

`exportMarkdown` currently writes to `~/Downloads`. Change the writer to
accept a destination directory and default to the active project's `plans/`:

```swift
// DocGenViewModel.exportMarkdown — compute destination
let dir = projectStore.activeProject?.localPath
    .appendingPathComponent("plans", isDirectory: true)
    ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let dest = dir.appendingPathComponent("\(safeName).md")
```

Update `LlmIdeAPIClient+Export.swift` so the hardcoded `~/Downloads` URL is
replaced by the passed-in `dest` (or move the file-write into the view
model entirely and have the API method just return the markdown string).

- [ ] **Step 2: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 3: Manual verification**

Generate a doc in Doc Gen with a project open → confirm the `.md` lands in
`<project>/plans/` and appears (after rescan) — and that with no project
open it still falls back to `~/Downloads`.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Export.swift mac/Sources/LlmIdeMac/Views/DocGenViewModel.swift
git commit -m "feat(paths): DocGen export writes into project plans/"
```

---

## Task 8: Meeting notes (.docx) → `<project>/notes`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift:77-88`

- [ ] **Step 1: Align the notes-output folder to the project**

`notesOutputFolder` currently derives `currentFolder/../notes`. When a
project is active, make it `<project>/notes` explicitly:

```swift
var notesOutputFolder: URL {
    if let root = projectStore.activeProject?.localPath {
        return root.appendingPathComponent("notes", isDirectory: true)
    }
    return meetingsFolder.deletingLastPathComponent().appendingPathComponent("notes")
}
```

(Confirm `projectStore` is reachable here; if not, pass the root in when
`AppEnvironment` is rebuilt on `.activeProjectChanged`.)

- [ ] **Step 2: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 3: Manual verification**

Generate a note from a meeting → confirm the `.docx` lands in
`<project>/notes/` and shows under the Notes section.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AppEnvironment.swift
git commit -m "feat(paths): meeting notes write into project notes/"
```

---

## Task 9: Settings → Paths panel + Config relabel

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/PathsSettingsSection.swift`
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift`

- [ ] **Step 1: Show the full canonical set in the locked project panel**

In `projectPathsPanel` (`PathsSettingsSection.swift:94`), render all six
canonical folders (`meetings/ plans/ notes/ assets/ code/ data/`) derived
from `ap.localPath`, each with a Reveal button, plus a single
**Rebuild missing folders** action that calls `ProjectScaffolder.scaffold`.

- [ ] **Step 2: Remove the dead global subfolder rows**

Delete the Notes / Documents / InfiniteBrain `subfolderRow`s from
`subfoldersSection` (they're not consumed). Keep Repo clones, UA binary,
per-repo memory.

- [ ] **Step 3: Relabel `dataRoot`**

Change the root row label/hint to "Default location for new projects" and
keep validation. In `Config.swift`, update the `dataRoot` doc comment to
reflect the new meaning. Remove `notesSubdir`/`docsSubdir`/
`infiniteBrainSubdir` resolvers (`resolvedNotesURL`, `resolvedDocsURL`,
`resolvedInfiniteBrainURL`, `allResolvedSubfolders`) and any now-unused
"Create missing folders" code that referenced them. Leave `clonesSubdir`/
`effectiveClonesURL` and `memorySubdir`.

- [ ] **Step 4: Build (fix any references to removed resolvers)**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!` — grep for `resolvedNotesURL`/`resolvedDocsURL`
first and remove call sites.

- [ ] **Step 5: Manual verification**

Open Settings → Paths with a project active → all six folders show with
Reveal; no Notes/Docs/InfiniteBrain global rows; root row reads "Default
location for new projects".

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/PathsSettingsSection.swift mac/Sources/LlmIdeMac/Models/Config.swift
git commit -m "feat(paths): Paths panel shows project canonical folders; retire dead global subdirs"
```

---

## Task 10: Wire add-file/folder call sites

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift:308-329`

- [ ] **Step 1: Confirm the add actions hit the bound store**

The `+` menu's Add file / Add folder already call
`itemStore.add(url:category:)` / `itemStore.addFolder(url:category:)`. With
Tasks 3–5 those now route correctly. Verify the `itemStore` here is the
same `@Environment` instance that was bound to the project root; if a
project isn't open, disable the add actions (since there's no destination).

- [ ] **Step 2: Disable add when no project is open**

Gate the Add file / Add folder menu items on
`projectStore.activeProject != nil`, with a tooltip "Open a project first".

- [ ] **Step 3: Build + manual verification**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` → `Build complete!`
Run the app: add an external `.md` from the Notes section → it copies into
`<project>/notes/` and appears once; add an image → lands in `assets/`; add
a code folder → referenced, not duplicated.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift
git commit -m "feat(paths): route Library add actions through the project root"
```

---

## Self-review (completed)

- **Spec coverage:** canonical set (T1), single index/scan (T4), copy-once-on-add + replace (T5), folders referenced (T5/T6), migration (T6), writer redirects (T7/T8), Settings panel + dataRoot relabel (T9), add call sites (T10). All spec sections map to a task.
- **Type consistency:** `ProjectPaths.subfolder/destinationURL/isInside`, `LibraryItemStore.bindProject/rescan/externalCodeFolders/externalFolderItems` are named consistently across tasks.
- **Open confirmations for the implementer:** the exact `AppEnvironment`/`ProjectStore` observation site for `bindProject` (T3/T8), and whether `LlmIdeAPIClient+Export` writes the file or returns the string (T7) — verify against current code before editing.
