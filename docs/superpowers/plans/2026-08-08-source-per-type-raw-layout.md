# Source per-type raw layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move raw source data under `<project>/source/<type>/YYYY/MM/` (meetings, emails, documents, connectors like slack), mirroring the existing `llm-doc/<type>/` processed tree.

**Architecture:** Extend `ProjectLayout` with a `sourceRawDir(for:)` helper; retarget each raw writer to its type folder (`MeetingFileStore`→`source/meetings/`, `EmailSource`→`source/emails/`, `SourceConnector`→`source/<noteType>/`); pre-create the canonical subdirs in `ProjectScaffolder`; ship an idempotent `SourceFolderMigration` that moves existing raw into place at launch. The Library scanner needs no change (it already scans `source/` recursively and classifies by frontmatter `platform`).

**Tech Stack:** Swift (macOS app, SPM), XCTest, module `LlmIdeMacLib` (`@testable import LlmIdeMacLib`).

## Global Constraints

- **Folder names reuse `NoteType.directoryName`** (`meeting`→`meetings`, `email`→`emails`, `document`→`documents`, else rawValue). No new name literals.
- **`SourceContext.root` is `source/`** (set to `env.notesConfig.currentFolder`, which `ProjectStore.openFolder` binds to `<project>/source/`). Therefore source writers append the type segment *directly* to `ctx.root` — never wrap in `ProjectLayout(root: ctx.root)` (that would double the `source/` segment).
- **`MeetingFileStore.root` is `source/`** at every call site (AppShell/CaptionScraper pass `notesConfig.currentFolder`; SlackSource passes `ctx.root`). `MeetingSummarizationService` passes `root` only to `writeSummary(into:)`, which does not use `monthFolder` — unaffected.
- **Migration is move-only, idempotent, never clobbers** (skip entries whose dest already exists). Runs at launch in `AppEnvironment.init`.
- **`data/` unchanged** (user misc files/images). Existing documents in `data/` are NOT migrated (can't auto-classify); only newly-ingested docs go to `source/documents/`.
- **`rawFile` metadata is write-only** (`grep -rn '\.rawFile' mac/Sources` shows no reads), so there is **no resolver task** — deviation from spec, justified by the grep evidence. Migration moves folders only.
- Commits: one concern per commit, Conventional Commits (`feat(mac): …`). On `main`, branch first (e.g. `feat/source-per-type-raw`). End each commit message with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Run a single test class with: `cd mac && swift test --filter <ClassName>`. Pre-existing failing tests (`SCMParsers`, `SavedRepoPathReconciler`) are not ours — do not treat as regressions.

**Spec deviation noted in Global Constraints:** the approved spec lists a "`rawFile` resolver" task and `rawFile` rewriting in migration. Both are dropped because `NoteMetadata.rawFile` is never read in the Mac sources (verified by grep). If a reader is added later, a resolver can map old prefixes then.

---

### Task 1: `ProjectLayout.sourceRawDir(for:)`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ProjectLayout.swift:19-24` (add helper after `sourceDir`)
- Test: `mac/Tests/LlmIdeMacTests/ProjectLayoutSourceRawTests.swift` (Create)

**Interfaces:**
- Consumes: `NoteType.directoryName` (existing, tested in `NoteTypeTests`).
- Produces: `ProjectLayout.sourceRawDir(for type: NoteType) -> URL` = `<root>/source/<type.directoryName>/`. Used by Task 5 (scaffolder, which holds the project root). The raw writers (Tasks 3–4) hold `source/` as their root and append `directoryName` directly instead.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/ProjectLayoutSourceRawTests.swift
import XCTest
@testable import LlmIdeMacLib

final class ProjectLayoutSourceRawTests: XCTestCase {
    func testSourceRawDirUsesDirectoryName() {
        let root = URL(fileURLWithPath: "/tmp/llmide-proj")
        let layout = ProjectLayout(root: root)
        XCTAssertEqual(layout.sourceRawDir(for: .meeting).path,   "/tmp/llmide-proj/source/meetings")
        XCTAssertEqual(layout.sourceRawDir(for: .email).path,     "/tmp/llmide-proj/source/emails")
        XCTAssertEqual(layout.sourceRawDir(for: .document).path,  "/tmp/llmide-proj/source/documents")
        XCTAssertEqual(layout.sourceRawDir(for: NoteType("slack")).path, "/tmp/llmide-proj/source/slack")
    }

    func testSourceRawDirSymmetricWithNotesDir() {
        let root = URL(fileURLWithPath: "/tmp/llmide-proj")
        let layout = ProjectLayout(root: root)
        // raw and processed share the <type.directoryName> segment.
        let type = NoteType("slack")
        XCTAssertEqual(layout.sourceRawDir(for: type).lastPathComponent,
                       layout.notesDir.appendingPathComponent(type.directoryName).lastPathComponent)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter ProjectLayoutSourceRawTests`
Expected: FAIL — `sourceRawDir` does not exist / "cannot find 'sourceRawDir' in scope".

- [ ] **Step 3: Write minimal implementation**

In `mac/Sources/LlmIdeMac/Services/ProjectLayout.swift`, add immediately after the `notesDir` property (after line 22):

```swift
    /// Raw source directory for a note type: `<root>/source/<type.directoryName>/`.
    /// Mirrors `notesDir` so raw and processed trees stay symmetric for every
    /// type: `source/<type>/YYYY/MM/` (raw) ↔ `llm-doc/<type>/YYYY/MM/` (processed).
    /// Callers that already hold `source/` as their root (the raw writers) append
    /// `type.directoryName` directly instead — using this helper on `source/`
    /// would double the `source/` segment.
    func sourceRawDir(for type: NoteType) -> URL {
        sourceDir.appendingPathComponent(type.directoryName, isDirectory: true)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter ProjectLayoutSourceRawTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ProjectLayout.swift mac/Tests/LlmIdeMacTests/ProjectLayoutSourceRawTests.swift
git commit -m "feat(mac): add ProjectLayout.sourceRawDir(for:) for per-type raw layout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `MeetingFileStore` writes under `meetings/`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift:185-191` (`monthFolder`)
- Test: `mac/Tests/LlmIdeMacTests/MeetingFileStoreRawDirTests.swift` (Create)

**Interfaces:**
- Consumes: none new.
- Produces: meeting raw transcripts now at `<root>/meetings/YYYY/MM/` (was `<root>/YYYY/MM/`). Since every caller's `root` is `source/` in project mode, this lands at `source/meetings/YYYY/MM/`.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/MeetingFileStoreRawDirTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MeetingFileStoreRawDirTests: XCTestCase {
    func testCreatePartialWritesUnderMeetingsMonthFolder() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mfs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = MeetingFileStore(root: root)
        let date = Date()
        let cal = Calendar(identifier: .iso8601)
        let c = cal.dateComponents([.year, .month], from: date)

        let handle = try store.createPartial(id: "abc12345", startedAt: date,
                                             platform: "google-meet", language: "")
        try handle.close()

        let expected = root.appendingPathComponent("meetings", isDirectory: true)
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
        XCTAssertEqual(handle.url.deletingLastPathComponent().path, expected.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: handle.url.path))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter MeetingFileStoreRawDirTests`
Expected: FAIL — `handle.url` resolves under `<root>/YYYY/MM/`, not `<root>/meetings/YYYY/MM/`.

- [ ] **Step 3: Write minimal implementation**

Replace `monthFolder` in `mac/Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift` (lines 185-191):

```swift
    private func monthFolder(for date: Date) -> URL {
        let cal = Calendar(identifier: .iso8601)
        let comps = cal.dateComponents([.year, .month], from: date)
        // Raw transcripts live under `<root>/meetings/YYYY/MM/` so the project
        // layout is `source/meetings/...` (root is bound to `source/` on project
        // open). Mirrors `llm-doc/meetings/` for the processed .docx.
        return root
            .appendingPathComponent("meetings", isDirectory: true)
            .appendingPathComponent(String(format: "%04d", comps.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", comps.month ?? 0), isDirectory: true)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter MeetingFileStoreRawDirTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift mac/Tests/LlmIdeMacTests/MeetingFileStoreRawDirTests.swift
git commit -m "feat(mac): write meeting transcripts under source/meetings/

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `EmailSource` writes raw under `emails/`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Sources/EmailSource.swift:35` (`inboxRoot`) and `:118` (`rawFile`)
- Test: `mac/Tests/LlmIdeMacTests/EmailSourceRawDirTests.swift` (Create)

**Interfaces:**
- Consumes: `NoteType.email.directoryName` (= `"emails"`).
- Produces: raw emails at `source/emails/YYYY/MM/` (was `source/EmailInbox/YYYY-MM/`, since `InboxStore` buckets `YYYY/MM/` and `ctx.root` is `source/`). `rawFile` metadata becomes `emails/YYYY/MM/<file>` (was `EmailInbox/…`).

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/EmailSourceRawDirTests.swift
import XCTest
@testable import LlmIdeMacLib

final class EmailSourceRawDirTests: XCTestCase {
    func testRawInboxRootIsSourceEmails() {
        let sourceRoot = URL(fileURLWithPath: "/tmp/proj/source")
        XCTAssertEqual(EmailSource.rawInboxRoot(sourceRoot: sourceRoot).path,
                       "/tmp/proj/source/emails")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter EmailSourceRawDirTests`
Expected: FAIL — `EmailSource.rawInboxRoot(sourceRoot:)` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `mac/Sources/LlmIdeMac/Sources/EmailSource.swift`:

Add this static helper inside `struct EmailSource` (e.g. just above `fetchAndIngest`):

```swift
    /// Raw email folder under the source root: `<sourceRoot>/emails/`.
    /// `sourceRoot` is `ctx.root`, which is already `source/`, so the segment
    /// is appended directly (not via `ProjectLayout`, which would double it).
    static func rawInboxRoot(sourceRoot: URL) -> URL {
        sourceRoot.appendingPathComponent(NoteType.email.directoryName, isDirectory: true)
    }
```

Change line 35 from:

```swift
        let inboxRoot = ctx.root.appendingPathComponent("EmailInbox", isDirectory: true)
```

to:

```swift
        let inboxRoot = Self.rawInboxRoot(sourceRoot: ctx.root)
```

Change line 118 (inside `generateNote`) from:

```swift
        let rawFile = "EmailInbox/\(monthPath)/\(rawFileName)"
```

to:

```swift
        let rawFile = "\(NoteType.email.directoryName)/\(monthPath)/\(rawFileName)"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter EmailSourceRawDirTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Sources/EmailSource.swift mac/Tests/LlmIdeMacTests/EmailSourceRawDirTests.swift
git commit -m "feat(mac): write raw emails under source/emails/

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `SourceConnector` writes raw under `<noteType>/`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift:42` (`ensureSetup`) and `:60` (`fetchAndIngest`)
- Modify: doc comments `mac/Sources/LlmIdeMac/Models/Config.swift:433` and `mac/Sources/LlmIdeMac/Sources/InputSource.swift:32`
- Test: `mac/Tests/LlmIdeMacTests/SourceConnectorRawDirTests.swift` (Create)

**Interfaces:**
- Consumes: `manifest.noteType`, `NoteType(_:).directoryName`.
- Produces: connector raw at `<root>/<noteType.directoryName>/` (was `<root>/<inboxFolder>/`). Since the connector base root is `source/`, this is `source/<noteType>/`. `manifest.inboxFolder` is kept on the `Codable` struct (so bundled JSON still decodes) but is no longer used as the raw location.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/SourceConnectorRawDirTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceConnectorRawDirTests: XCTestCase {
    private func makeSlackManifest() -> SourceConnectorManifest {
        SourceConnectorManifest(
            id: "slack", displayName: "Slack", icon: "message", emptyText: "No messages",
            platforms: ["slack"], mode: .fetch,
            inboxFolder: "SlackArchive",     // legacy; must NOT be used as raw location
            noteType: "slack",
            endpoints: .init(test: "/t", fetch: "/f", seen: "/s", classify: "/c"),
            adapter: "SlackAdapter", configFields: [], rawHeaders: [:], noiseFilter: nil)
    }

    func testEnsureSetupCreatesNoteTypeFolderNotInboxFolder() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let connector = SourceConnector(manifest: makeSlackManifest(), adapterFactory: {
            fatalError("adapter not constructed in this test")
        })
        try connector.ensureSetup(at: root)

        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("slack").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("SlackArchive").path))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter SourceConnectorRawDirTests`
Expected: FAIL — `ensureSetup` creates `SlackArchive/`, not `slack/`.

- [ ] **Step 3: Write minimal implementation**

In `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift`, change line 42 inside `ensureSetup(at:)` from:

```swift
        let inbox = root.appendingPathComponent(manifest.inboxFolder, isDirectory: true)
```

to:

```swift
        let inbox = root.appendingPathComponent(NoteType(manifest.noteType).directoryName, isDirectory: true)
```

Change line 60 inside `fetchAndIngest(_:)` from:

```swift
        let inboxRoot = ctx.sourceConnectorRoot.appendingPathComponent(manifest.inboxFolder, isDirectory: true)
```

to:

```swift
        let inboxRoot = ctx.sourceConnectorRoot.appendingPathComponent(NoteType(manifest.noteType).directoryName, isDirectory: true)
```

Update the two doc comments to drop the `inboxFolder` raw-path wording:

`mac/Sources/LlmIdeMac/Models/Config.swift:433` — change:
```
    /// data (`<root>/<inboxFolder>/`, `<root>/llm-doc/<noteType>/`). Optional
```
to:
```
    /// data (`<root>/<noteType>/`, `<root>/llm-doc/<noteType>/`). Optional
```

`mac/Sources/LlmIdeMac/Sources/InputSource.swift:32` — change:
```
    /// Base path for all Source Connectors (`<root>/<inboxFolder>/`,
```
to:
```
    /// Base path for all Source Connectors (`<root>/<noteType>/`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter SourceConnectorRawDirTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift mac/Sources/LlmIdeMac/Models/Config.swift mac/Sources/LlmIdeMac/Sources/InputSource.swift mac/Tests/LlmIdeMacTests/SourceConnectorRawDirTests.swift
git commit -m "feat(mac): write connector raw under source/<noteType>/, drop inboxFolder as raw location

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `ProjectScaffolder` pre-creates raw subdirs + updates doc trees

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift:33-90` (`requiredDirectories`, `.gitkeep` loop, doc-comment tree, generated README tree, agent-entry table)
- Test: `mac/Tests/LlmIdeMacTests/ProjectScaffolderSourceSubdirsTests.swift` (Create)

**Interfaces:**
- Consumes: Task 1's `ProjectLayout.sourceRawDir(for:)` (scaffolder holds the project root, so this is the correct helper here).
- Produces: a freshly-scaffolded project contains empty `source/meetings/`, `source/emails/`, `source/documents/` (each with `.gitkeep`). Connector types (`slack/`) are still created on-demand by connector setup.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/ProjectScaffolderSourceSubdirsTests.swift
import XCTest
@testable import LlmIdeMacLib

final class ProjectScaffolderSourceSubdirsTests: XCTestCase {
    func testRequiredDirectoriesIncludeSourceSubdirs() {
        // The scaffolder iterates `requiredDirectories` with
        // createDirectory(withIntermediateDirectories: true), so listing the
        // subdirs here is what creates them on every project open.
        let dirs = Set(ProjectScaffolder.requiredDirectories)
        XCTAssertTrue(dirs.contains("source/meetings"))
        XCTAssertTrue(dirs.contains("source/emails"))
        XCTAssertTrue(dirs.contains("source/documents"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter ProjectScaffolderSourceSubdirsTests`
Expected: FAIL — `requiredDirectories` does not contain the three subdirs.

- [ ] **Step 3: Write minimal implementation**

In `mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift`:

Change the `requiredDirectories` array (lines 34-38) from:

```swift
    static let requiredDirectories = [
        "source", "code", "data", "llm-doc", "templates",
        "system", "system/faults", "system/graph", "system/cache",
        ".claude",
    ]
```

to:

```swift
    static let requiredDirectories = [
        "source",
        "source/meetings", "source/emails", "source/documents",
        "code", "data", "llm-doc", "templates",
        "system", "system/faults", "system/graph", "system/cache",
        ".claude",
    ]
```

Change the `.gitkeep` loop (lines 86-90) from:

```swift
        for dir in ["llm-doc", "data"] {
            writeIfAbsent(
                at: folderURL.appendingPathComponent("\(dir)/.gitkeep"),
                content: "")
        }
```

to:

```swift
        for dir in ["llm-doc", "data", "source/meetings", "source/emails", "source/documents"] {
            writeIfAbsent(
                at: folderURL.appendingPathComponent("\(dir)/.gitkeep"),
                content: "")
        }
```

Update the **doc-comment tree** (around line 13-18) — change the `source/` line:

```swift
/// ├── source/     ← meeting & email transcripts (your Sources)
```

to:

```swift
/// ├── source/     ← raw inputs (your Sources)
/// │   ├── meetings/   ← raw meeting transcripts
/// │   ├── emails/     ← raw emails
/// │   └── documents/  ← raw ingested documents
```

Update the **generated README tree** (around line 256) — change:

```
        ├── source/     ← meeting & email transcripts (your Sources)
```

to:

```
        ├── source/     ← raw inputs (your Sources: meetings/emails/documents/…)
```

Update the **agent-entry file table** (around line 466) — change:

```
        | `source/` | Meeting & email transcripts |
```

to:

```
        | `source/` | Raw inputs (meetings/emails/documents/…) |
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter ProjectScaffolderSourceSubdirsTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift mac/Tests/LlmIdeMacTests/ProjectScaffolderSourceSubdirsTests.swift
git commit -m "feat(mac): scaffold source/{meetings,emails,documents} raw subdirs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `SourceFolderMigration` — move existing raw at launch

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/NotesFolder/SourceFolderMigration.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift:23-29` (run it after `NotesToLlmDocMigration`)
- Test: `mac/Tests/LlmIdeMacTests/SourceFolderMigrationTests.swift` (Create)

**Interfaces:**
- Consumes: `SourceConnectorManifest` (`inboxFolder`, `noteType`) for the connector move mapping; `NoteType(_:).directoryName`.
- Produces: `SourceFolderMigration.run(in:sourceRoot:connectors:)` (`@MainActor`, idempotent). Moves (merge-style, no clobber):
  - `<sourceRoot>/EmailInbox/` → `<sourceRoot>/emails/`
  - each connector `<sourceRoot>/<inboxFolder>/` → `<sourceRoot>/<noteType.directoryName>/`
  - flat meeting raw `<sourceRoot>/<4-digit-year>/` → `<sourceRoot>/meetings/<year>/`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/SourceFolderMigrationTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceFolderMigrationTests: XCTestCase {
    private func makeRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("sfm-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
    private func write(_ root: URL, _ rel: String, _ body: String = "x") throws {
        let url = root.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try Data(body.utf8).write(to: url)
    }
    private func slackManifest() -> SourceConnectorManifest {
        SourceConnectorManifest(id: "slack", displayName: "Slack", icon: "message",
            emptyText: "—", platforms: ["slack"], mode: .fetch,
            inboxFolder: "SlackArchive", noteType: "slack",
            endpoints: .init(test: "/t", fetch: "/f", seen: "/s", classify: "/c"),
            adapter: "SlackAdapter", configFields: [], rawHeaders: [:], noiseFilter: nil)
    }

    func testMovesEmailFlatMeetingsAndConnectorRaw() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        try write(root, "EmailInbox/2026/05/a.txt")
        try write(root, "2026/05/m.md")              // flat meeting raw
        try write(root, "SlackArchive/2026/06/s.txt") // connector raw

        SourceFolderMigration.run(in: root, connectors: [slackManifest()])

        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("emails/2026/05/a.txt").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("meetings/2026/05/m.md").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("slack/2026/06/s.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("EmailInbox").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("SlackArchive").path))
    }

    func testIdempotentAndDoesNotClobber() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        try write(root, "emails/2026/05/keep.txt", "keep")   // already migrated
        try write(root, "EmailInbox/2026/05/keep.txt", "new") // would conflict

        SourceFolderMigration.run(in: root, connectors: [slackManifest()])
        SourceFolderMigration.run(in: root, connectors: [slackManifest()])

        // Existing dest preserved (no clobber); src removed once empty-ish.
        let kept = try String(contentsOf: root.appendingPathComponent("emails/2026/05/keep.txt"), encoding: .utf8)
        XCTAssertEqual(kept, "keep")
    }

    func testNoOpOnCleanTree() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        SourceFolderMigration.run(in: root, connectors: [slackManifest()]) // must not throw
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter SourceFolderMigrationTests`
Expected: FAIL — `SourceFolderMigration` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `mac/Sources/LlmIdeMac/Services/NotesFolder/SourceFolderMigration.swift`:

```swift
import Foundation
import os.log

/// One-time, idempotent move of legacy raw-source folders into the canonical
/// `source/<type>/` layout. Runs at launch on the source root (which
/// `ProjectStore.openFolder` binds to `<project>/source/`). Move-only — never
/// deletes content, never clobbers an existing destination entry.
///
/// Moves:
///   <root>/EmailInbox/            → <root>/emails/
///   <root>/<inboxFolder>/         → <root>/<noteType.directoryName>/   (per connector)
///   <root>/<4-digit-year>/        → <root>/meetings/<year>/            (flat meeting raw)
enum SourceFolderMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "SourceFolderMigration")

    /// Merge-move every legacy raw folder under `sourceRoot` into its canonical
    /// `source/<type>/` location. `connectors` is injected so tests can drive the
    /// connector mapping without bundled resources; production passes
    /// `SourceConnectorManifest.loadBundled()`.
    @MainActor
    static func run(in sourceRoot: URL,
                    connectors: [SourceConnectorManifest] = SourceConnectorManifest.loadBundled()) {
        let fm = FileManager.default

        // 1. Email
        mergeMove(fm,
                  from: sourceRoot.appendingPathComponent("EmailInbox", isDirectory: true),
                  to:   sourceRoot.appendingPathComponent(NoteType.email.directoryName, isDirectory: true))

        // 2. Each connector: <inboxFolder>/ → <noteType.directoryName>/
        for m in connectors {
            mergeMove(fm,
                      from: sourceRoot.appendingPathComponent(m.inboxFolder, isDirectory: true),
                      to:   sourceRoot.appendingPathComponent(NoteType(m.noteType).directoryName, isDirectory: true))
        }

        // 3. Flat meeting raw: top-level 4-digit year dirs → meetings/<year>/
        let meetings = sourceRoot.appendingPathComponent("meetings", isDirectory: true)
        let entries = (try? fm.contentsOfDirectory(atPath: sourceRoot.path)) ?? []
        for name in entries {
            if name.count == 4, name.allSatisfy(\.isNumber) {
                mergeMove(fm,
                          from: sourceRoot.appendingPathComponent(name, isDirectory: true),
                          to:   meetings.appendingPathComponent(name, isDirectory: true))
            }
        }
    }

    /// Move the contents of `src` into `dest` (creating `dest` if needed),
    /// skipping any entry that already exists under `dest` (no clobber), then
    /// remove the now-empty `src`. No-op if `src` does not exist.
    private static func mergeMove(_ fm: FileManager, from src: URL, to dest: URL) {
        guard fm.fileExists(atPath: src.path) else { return }
        try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
        let entries = (try? fm.contentsOfDirectory(atPath: src.path)) ?? []
        for e in entries {
            let s = src.appendingPathComponent(e)
            let d = dest.appendingPathComponent(e)
            guard !fm.fileExists(atPath: d.path) else { continue }   // idempotent, no clobber
            do {
                try fm.moveItem(at: s, to: d)
            } catch {
                log.error("source migration move failed \(s.lastPathComponent, privacy: .public) → \(d.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        // Best-effort removal of the now-empty legacy folder.
        try? fm.removeItem(at: src)
    }
}
```

Wire it into `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift`. After the existing `NotesToLlmDocMigration` calls (lines 27-28), add a `SourceFolderMigration` call on the source root (`folder`):

```swift
        NotesToLlmDocMigration.run(in: folder)
        if let project = indexRootURL { NotesToLlmDocMigration.run(in: project) }
        SourceFolderMigration.run(in: folder)   // ← add this line
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter SourceFolderMigrationTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NotesFolder/SourceFolderMigration.swift mac/Sources/LlmIdeMac/Services/AppEnvironment.swift mac/Tests/LlmIdeMacTests/SourceFolderMigrationTests.swift
git commit -m "feat(mac): migrate legacy raw folders into source/<type>/ at launch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Docs — publish the `source/<type>/` raw layout

**Files:**
- Modify: `docs/reference/project-layout.md` (the `source/` row + a new raw subsection)
- Modify: `mac/Sources/LlmIdeMac/Services/NoteService.swift:3-6` (architecture comment)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update `docs/reference/project-layout.md`**

In the "Canonical tree" section, expand the `source/` line to show the type children:

```
├── source/        raw inputs (your Sources)
│   ├── meetings/    YYYY/MM/<ts>-<slug>.md
│   ├── emails/      YYYY/MM/<ts>-<slug>
│   ├── documents/   YYYY/MM/…
│   └── <noteType>/  YYYY/MM/…   (connectors, e.g. slack/)
```

In the "Folders at a glance" table, change the `source/` row Purpose from "raw transcripts (meetings, email inboxes, doc sources)" to "raw inputs — per-type: `meetings/`, `emails/`, `documents/`, `<connector>/`".

Add a short subsection after the `llm-doc/` section:

```markdown
## source/ — raw inputs

`source/` is the single home for **raw** inputs, one child folder per source type
(mirroring `llm-doc/` for processed output). `ProjectStore.openFolder` binds the
notes folder to `<project>/source/`, so `MeetingFileStore`, the email/connector
writers, and the Library scanner all resolve here.

### Structure

\`\`\`
<project>/source/
├── meetings/    YYYY/MM/<file>.md     raw transcripts (MeetingFileStore)
├── emails/      YYYY/MM/<file>        raw emails (EmailSource via InboxStore)
├── documents/   YYYY/MM/…             raw ingested docs
└── <noteType>/  YYYY/MM/…             connectors, e.g. slack/ (on-demand)
\`\`\`

A one-time `SourceFolderMigration` (run at launch) moves legacy raw locations
(`source/EmailInbox/`, `<inboxFolder>/`, flat `source/<year>/`) into this layout.
`data/` remains for user-added misc files and images.
```

- [ ] **Step 2: Update the `NoteService` architecture comment**

In `mac/Sources/LlmIdeMac/Services/NoteService.swift:3-6`, change:

```swift
// - Raw data stays in source folders (meetings/, EmailInbox/, Documents/)
// - Generated notes go to the unified llm-doc/ folder (llm-doc/meetings/, llm-doc/emails/, llm-doc/documents/)
```

to:

```swift
// - Raw data stays under source/<type>/ (source/meetings/, source/emails/, source/documents/, source/<connector>/)
// - Generated notes go to the unified llm-doc/ folder (llm-doc/meetings/, llm-doc/emails/, llm-doc/documents/)
```

- [ ] **Step 3: Verify docs**

Run: `cd /Users/dinsmallade/llm-ide && make docs-check` (if the docs venv is available — requires `pytest`/`mkdocs`). If the toolchain is absent in the environment, instead verify the new page's internal links resolve:

```bash
cd /Users/dinsmallade/llm-ide
test -f docs/spec/macos-app.md && test -f docs/reference/database-schema.md && echo "links OK"
```
Expected: `links OK`.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/project-layout.md mac/Sources/LlmIdeMac/Services/NoteService.swift
git commit -m "docs(mac): document source/<type>/ raw layout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full build + targeted tests**

```bash
cd mac && swift build
cd mac && swift test --filter ProjectLayoutSourceRawTests
cd mac && swift test --filter MeetingFileStoreRawDirTests
cd mac && swift test --filter EmailSourceRawDirTests
cd mac && swift test --filter SourceConnectorRawDirTests
cd mac && swift test --filter ProjectScaffolderSourceSubdirsTests
cd mac && swift test --filter SourceFolderMigrationTests
```

Expected: build succeeds; all six new test classes pass. (`SCMParsers` / `SavedRepoPathReconciler` may still fail — pre-existing, not ours.)
