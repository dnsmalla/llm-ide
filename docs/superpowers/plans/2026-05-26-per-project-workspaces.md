# Per-Project Workspaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build per-project workspaces (Phase 1 of the spec) so each opened folder maintains its own settings/state bundle and the app can switch cleanly between them.

**Architecture:** Two-layer storage — `<projectFolder>/.llmide/project.json` travels with the folder, `~/Library/Application Support/LLM IDE/projects.json` tracks recents + active. A new `ProjectStore` becomes the single source of truth for "which project is active"; every existing feature that consults `AppConfig` for project-scoped settings now consults the active Project's bundle. Server-side, `projectId` rides in the existing `meta` JSON column — no schema migration.

**Tech Stack:** Swift 5.9 + SwiftUI (Mac client); Node.js 20+ + better-sqlite3 (server); `node:test` (server tests); Swift Testing (mac tests).

**Spec:** [`docs/superpowers/specs/2026-05-25-per-project-workspaces-design.md`](../specs/2026-05-25-per-project-workspaces-design.md)

---

## File map

### New files (Mac)

| File | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/Models/Project.swift` | `Project`, `ProjectSettings` Codable models + `LinkedRepo` substruct |
| `mac/Sources/LlmIdeMac/Services/ProjectStore.swift` | `@MainActor` store: recents, active project, atomic on-disk reads/writes, posts `Notification.Name.activeProjectChanged` |
| `mac/Sources/LlmIdeMac/Services/ProjectMigrator.swift` | One-shot import from legacy `SavedGitLab/GitHubRepo` arrays |
| `mac/Sources/LlmIdeMac/Views/Welcome/WelcomeView.swift` | First-launch + no-active screen with Open Folder + recents list |
| `mac/Sources/LlmIdeMac/Views/Welcome/RecentProjectsList.swift` | Reusable list (used by Welcome and Cmd-P) |
| `mac/Sources/LlmIdeMac/Views/Shell/ProjectSwitcher.swift` | Sidebar header dropdown |
| `mac/Sources/LlmIdeMac/Views/Shell/QuickSwitcherSheet.swift` | Cmd-P HUD overlay |
| `mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift` | Bottom status bar inside the main window |

### New tests (Mac)

| File | Coverage |
|---|---|
| `mac/Tests/LlmIdeMacTests/ProjectTests.swift` | Codable round-trip, unknown-future-field tolerance |
| `mac/Tests/LlmIdeMacTests/ProjectStoreTests.swift` | Recents pruning, atomic write, schema-version refusal, corrupt-file archive |
| `mac/Tests/LlmIdeMacTests/ProjectMigratorTests.swift` | Happy path, empty input, idempotency |

### Modified files (Mac)

| File | Change |
|---|---|
| `mac/Sources/LlmIdeMac/Models/Config.swift` | Extract project-scoped fields into `defaultProjectSettings` template; mark old fields deprecated |
| `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` | `@StateObject ProjectStore`; injects into environment; wires Cmd-P shortcut |
| `mac/Sources/LlmIdeMac/Views/AppShell.swift` | Mount Welcome when `projectStore.activeProject == nil`; show project context otherwise |
| `mac/Sources/LlmIdeMac/Views/SettingsView.swift` | Split into App + Project section groups |
| `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` | `buildAgentContext` reads from active project |
| `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` | `resolveBackendAndProject` consults active project |

### Modified files (server)

| File | Change |
|---|---|
| `extension/kb/db.mjs` | `ingestMeeting`/`ingestSources` accept optional `projectId` field, store in `meta`; search hydration filters by projectId when supplied |
| `extension/llm_agent/internal/context/render-active-project.mjs` | Read from project-bundle shape, not legacy GitLab-only |
| `extension/llm_agent/internal/context/compose.mjs` | Pass through new shape |
| `extension/tests/tenancy.test.mjs` | Add cases for projectId scope |

---

## Task 1: Project + ProjectSettings models (TDD)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/Project.swift`
- Test: `mac/Tests/LlmIdeMacTests/ProjectTests.swift`

- [ ] **Step 1: Write the failing tests**

Write `mac/Tests/LlmIdeMacTests/ProjectTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("Project model")
struct ProjectTests {

    @Test func roundTripsCodable() throws {
        let p = Project(
            id: "01HBYZ123",
            displayName: "LLM IDE Mac",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            settings: ProjectSettings(
                language: "en",
                activeCLI: "claudeCode",
                linkedRepo: ProjectSettings.LinkedRepo(
                    kind: .github,
                    url: "https://github.com/owner/name",
                    remoteId: "owner/name",
                    defaultBranch: "main"
                ),
                notesFolderRelative: "Meetings",
                enabledPlugins: ["sample-summarizer"],
                graphifyBinaryOverride: "",
                regressionLookbackCount: 5,
                agentPersona: nil,
                docTemplatesActive: []
            ),
            schemaVersion: 1
        )
        let data = try AppJSON.encoder.encode(p)
        let decoded = try AppJSON.decoder.decode(Project.self, from: data)
        #expect(decoded == p)
    }

    @Test func toleratesUnknownFutureFields() throws {
        let json = """
        {
            "schemaVersion": 1,
            "id": "01HBYZ",
            "displayName": "X",
            "createdAt": "2026-05-26T00:00:00Z",
            "settings": {
                "language": "en",
                "activeCLI": "claudeCode",
                "notesFolderRelative": null,
                "enabledPlugins": [],
                "graphifyBinaryOverride": "",
                "regressionLookbackCount": 5,
                "agentPersona": null,
                "docTemplatesActive": [],
                "futureField": "ignored"
            }
        }
        """.data(using: .utf8)!
        let decoded = try AppJSON.decoder.decode(Project.self, from: json)
        #expect(decoded.id == "01HBYZ")
        #expect(decoded.settings.language == "en")
    }

    @Test func refusesNewerSchemaVersion() throws {
        let json = """
        {"schemaVersion": 999, "id": "x", "displayName": "y", "createdAt": "2026-05-26T00:00:00Z",
         "settings": {"language": "en", "activeCLI": "claudeCode", "enabledPlugins": [],
                      "graphifyBinaryOverride": "", "regressionLookbackCount": 5,
                      "docTemplatesActive": []}}
        """.data(using: .utf8)!
        #expect(throws: Project.LoadError.unsupportedSchema(version: 999)) {
            _ = try Project.fromJSON(json)
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd mac && swift build --build-tests 2>&1 | tail -10
```
Expected: compilation errors — `Project` not defined.

- [ ] **Step 3: Create Project.swift**

Write `mac/Sources/LlmIdeMac/Models/Project.swift`:

```swift
import Foundation

/// On-disk per-project bundle. Stored at <projectFolder>/.llmide/project.json.
struct Project: Codable, Equatable, Identifiable {
    let schemaVersion: Int
    let id: String
    var displayName: String
    let createdAt: Date
    var settings: ProjectSettings

    static let currentSchemaVersion = 1

    init(id: String, displayName: String, createdAt: Date,
         settings: ProjectSettings, schemaVersion: Int = currentSchemaVersion) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.displayName = displayName
        self.createdAt = createdAt
        self.settings = settings
    }

    enum LoadError: Error, Equatable {
        case unsupportedSchema(version: Int)
        case invalidJSON(reason: String)
    }

    static func fromJSON(_ data: Data) throws -> Project {
        let p: Project
        do { p = try AppJSON.decoder.decode(Project.self, from: data) }
        catch { throw LoadError.invalidJSON(reason: String(describing: error)) }
        guard p.schemaVersion <= currentSchemaVersion else {
            throw LoadError.unsupportedSchema(version: p.schemaVersion)
        }
        return p
    }

    func toJSON() throws -> Data {
        try AppJSON.encoder.encode(self)
    }
}

/// Per-project settings bundle. All fields except `language` are optional
/// in the sense that they default to AppConfig values when omitted —
/// see ProjectStore.createFromDefaults().
struct ProjectSettings: Codable, Equatable {
    var language: String
    var activeCLI: String
    var linkedRepo: LinkedRepo?
    var notesFolderRelative: String?
    var enabledPlugins: [String]
    var graphifyBinaryOverride: String
    var regressionLookbackCount: Int
    var agentPersona: String?
    var docTemplatesActive: [String]

    struct LinkedRepo: Codable, Equatable {
        enum Kind: String, Codable {
            case github, gitlab
        }
        let kind: Kind
        let url: String
        let remoteId: String         // "owner/name" for GH, numeric str for GL
        let defaultBranch: String?
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
swift test --filter ProjectTests 2>&1 | tail -10
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Project.swift mac/Tests/LlmIdeMacTests/ProjectTests.swift
git commit -m "feat(mac): Project + ProjectSettings Codable models

Phase 1 of per-project workspaces (spec
docs/superpowers/specs/2026-05-25-per-project-workspaces-design.md).

Codable round-trip, schemaVersion gating (rejects > 1), unknown-
future-field tolerance. No store/persistence yet — that's Task 2.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: ProjectStore — recents + active + atomic disk writes

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ProjectStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/ProjectStoreTests.swift`

- [ ] **Step 1: Write failing tests**

Write `mac/Tests/LlmIdeMacTests/ProjectStoreTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("ProjectStore")
@MainActor
struct ProjectStoreTests {

    private func tmpRoot() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ps-test-\(UUID().uuidString)")
    }

    @Test func startsWithNoActiveAndEmptyRecents() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: root)
        #expect(store.activeProject == nil)
        #expect(store.recents.isEmpty)
    }

    @Test func opensFolderCreatesProjectAndPersists() throws {
        let root = tmpRoot()
        let proj = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)
        let defaults = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: nil, notesFolderRelative: nil,
            enabledPlugins: [], graphifyBinaryOverride: "",
            regressionLookbackCount: 5, agentPersona: nil,
            docTemplatesActive: [])

        let store = ProjectStore(stateDirectory: root, defaults: defaults)
        try store.openFolder(at: proj)

        #expect(store.activeProject != nil)
        #expect(store.activeProject?.localPath == proj.path)
        #expect(FileManager.default.fileExists(
            atPath: proj.appendingPathComponent(".llmide/project.json").path))

        // Persistence: a fresh store reads it back.
        let reborn = ProjectStore(stateDirectory: root, defaults: defaults)
        #expect(reborn.activeProject?.localPath == proj.path)
    }

    @Test func recentsAreSortedByLastOpenedDesc() throws {
        let root = tmpRoot()
        let a = tmpRoot(); let b = tmpRoot(); let c = tmpRoot()
        for u in [root, a, b, c] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        try store.openFolder(at: a); try store.openFolder(at: b); try store.openFolder(at: c)
        // Most recently opened first
        #expect(store.recents.first?.path == c.path)
        #expect(store.recents.last?.path  == a.path)
    }

    @Test func recentsCapAt20() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        for _ in 0..<25 {
            let p = tmpRoot()
            try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
            try store.openFolder(at: p)
        }
        #expect(store.recents.count == 20)
    }

    @Test func corruptStateFileIsArchived() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let statePath = root.appendingPathComponent("projects.json")
        try "{ not json".data(using: .utf8)!.write(to: statePath)

        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        #expect(store.activeProject == nil)

        // The corrupt file is archived sidecar-style.
        let siblings = try FileManager.default.contentsOfDirectory(atPath: root.path)
        #expect(siblings.contains(where: { $0.hasPrefix("projects.corrupt.") }))
    }
}

extension ProjectSettings {
    static let testDefaults = ProjectSettings(
        language: "en", activeCLI: "claudeCode", linkedRepo: nil,
        notesFolderRelative: nil, enabledPlugins: [],
        graphifyBinaryOverride: "", regressionLookbackCount: 5,
        agentPersona: nil, docTemplatesActive: [])
}
```

- [ ] **Step 2: Run failing tests**

```bash
swift build --build-tests 2>&1 | tail -5
```
Expected: `ProjectStore` not defined.

- [ ] **Step 3: Create ProjectStore.swift**

Write `mac/Sources/LlmIdeMac/Services/ProjectStore.swift`:

```swift
import Foundation
import Combine

extension Notification.Name {
    static let activeProjectChanged = Notification.Name("activeProjectChanged")
}

/// App-wide recents + active project record. Kept in
/// `<stateDirectory>/projects.json`. The active Project is fully
/// hydrated from its own `<folder>/.llmide/project.json` on demand.
@MainActor
final class ProjectStore: ObservableObject {

    struct ActiveProject: Equatable {
        let bundle: Project       // the loaded contents
        let localPath: String     // resolved folder URL.path
    }

    struct RecentEntry: Codable, Equatable, Identifiable {
        let id: String            // project id
        let path: String
        let displayName: String
        let lastOpenedAt: Date
    }

    @Published private(set) var activeProject: ActiveProject?
    @Published private(set) var recents: [RecentEntry] = []

    private let stateDirectory: URL
    private let defaults: ProjectSettings
    private let stateFile: URL
    private static let recentsCap = 20

    init(stateDirectory: URL,
         defaults: ProjectSettings = ProjectStore.fallbackDefaults) {
        self.stateDirectory = stateDirectory
        self.defaults = defaults
        self.stateFile = stateDirectory.appendingPathComponent("projects.json")
        loadStateFromDisk()
    }

    /// Defaults used when no AppConfig is supplied (only happens in
    /// some test paths). Production wiring always passes real defaults.
    static let fallbackDefaults = ProjectSettings(
        language: "en", activeCLI: "claudeCode", linkedRepo: nil,
        notesFolderRelative: nil, enabledPlugins: [],
        graphifyBinaryOverride: "", regressionLookbackCount: 5,
        agentPersona: nil, docTemplatesActive: [])

    // MARK: - Public API

    func openFolder(at url: URL) throws {
        let projectJSON = url.appendingPathComponent(".llmide/project.json")
        let project: Project
        if FileManager.default.fileExists(atPath: projectJSON.path) {
            let data = try Data(contentsOf: projectJSON)
            project = try Project.fromJSON(data)
        } else {
            project = createFromDefaults(folder: url)
            try writeProjectJSON(project, to: projectJSON)
        }
        activeProject = ActiveProject(bundle: project, localPath: url.path)
        bumpRecent(id: project.id, path: url.path, displayName: project.displayName)
        try persistState()
        NotificationCenter.default.post(name: .activeProjectChanged, object: nil)
    }

    func switchTo(recent entry: RecentEntry) throws {
        try openFolder(at: URL(fileURLWithPath: entry.path))
    }

    func closeActive() throws {
        activeProject = nil
        try persistState()
        NotificationCenter.default.post(name: .activeProjectChanged, object: nil)
    }

    // MARK: - Internals

    private func createFromDefaults(folder: URL) -> Project {
        Project(
            id: ULID.generate(),
            displayName: folder.lastPathComponent,
            createdAt: Date(),
            settings: defaults)
    }

    private func bumpRecent(id: String, path: String, displayName: String) {
        var list = recents.filter { $0.id != id }
        list.insert(RecentEntry(id: id, path: path,
                                displayName: displayName,
                                lastOpenedAt: Date()),
                    at: 0)
        if list.count > Self.recentsCap { list = Array(list.prefix(Self.recentsCap)) }
        recents = list
    }

    private func loadStateFromDisk() {
        guard FileManager.default.fileExists(atPath: stateFile.path) else { return }
        do {
            let data = try Data(contentsOf: stateFile)
            let state = try AppJSON.decoder.decode(StateFile.self, from: data)
            recents = state.recents
            if let activeId = state.activeId,
               let entry = state.recents.first(where: { $0.id == activeId }) {
                try? rehydrateActive(from: entry)
            }
        } catch {
            archiveCorruptStateFile()
        }
    }

    private func rehydrateActive(from entry: RecentEntry) throws {
        let projectJSON = URL(fileURLWithPath: entry.path)
            .appendingPathComponent(".llmide/project.json")
        let data = try Data(contentsOf: projectJSON)
        let project = try Project.fromJSON(data)
        activeProject = ActiveProject(bundle: project, localPath: entry.path)
    }

    private func archiveCorruptStateFile() {
        let stamp = Int(Date().timeIntervalSince1970)
        let dst = stateDirectory.appendingPathComponent("projects.corrupt.\(stamp).json")
        try? FileManager.default.moveItem(at: stateFile, to: dst)
    }

    private func persistState() throws {
        let state = StateFile(
            schemaVersion: 1,
            activeId: activeProject?.bundle.id,
            recents: recents)
        try FileManager.default.createDirectory(
            at: stateDirectory, withIntermediateDirectories: true)
        let tmp = stateFile.appendingPathExtension("tmp")
        let data = try AppJSON.encoder.encode(state)
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(stateFile, withItemAt: tmp)
    }

    private func writeProjectJSON(_ project: Project, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let tmp = url.appendingPathExtension("tmp")
        let data = try project.toJSON()
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }

    struct StateFile: Codable {
        let schemaVersion: Int
        let activeId: String?
        let recents: [RecentEntry]
    }
}

// MARK: - ULID generator (stable across renames)
enum ULID {
    static func generate() -> String {
        let ts = UInt64(Date().timeIntervalSince1970 * 1000)
        var bytes = [UInt8](repeating: 0, count: 10)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let tsHex = String(ts, radix: 32, uppercase: false)
        let randHex = bytes.map { String(format: "%02x", $0) }.joined()
        return "\(tsHex)\(randHex)"
    }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
swift test --filter ProjectStoreTests 2>&1 | tail -10
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ProjectStore.swift mac/Tests/LlmIdeMacTests/ProjectStoreTests.swift
git commit -m "feat(mac): ProjectStore with atomic disk writes + recents

@MainActor store for recents/active. Reads project.json on demand,
writes app-state projects.json atomically (tmp + replaceItemAt).
Corrupt state file archived to projects.corrupt.<unix>.json.
Recents cap at 20, sorted most-recent-first.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: ProjectMigrator — import legacy saved repos

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ProjectMigrator.swift`
- Test: `mac/Tests/LlmIdeMacTests/ProjectMigratorTests.swift`

- [ ] **Step 1: Failing tests**

Write `mac/Tests/LlmIdeMacTests/ProjectMigratorTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("ProjectMigrator")
@MainActor
struct ProjectMigratorTests {

    @Test func importsActiveGitLabAndGitHubProjects() throws {
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mig-\(UUID().uuidString)")
        let glPath = stateRoot.appendingPathComponent("gl-proj")
        let ghPath = stateRoot.appendingPathComponent("gh-repo")
        for u in [stateRoot, glPath, ghPath] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }

        let glSaved = SavedGitLabProject(
            url: "https://gitlab.com/a/b", displayName: "GL one",
            resolvedId: 100, isActive: true)
        var glSavedWithPath = glSaved
        glSavedWithPath.localPath = glPath.path

        let ghSaved = SavedGitHubRepo(
            url: "https://github.com/c/d", displayName: "GH one",
            resolvedId: 200, isActive: false)
        var ghSavedWithPath = ghSaved
        ghSavedWithPath.localPath = ghPath.path

        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, defaults: .testDefaults)
        let result = migrator.runOnce(
            gitLab: [glSavedWithPath],
            gitHub: [ghSavedWithPath])

        #expect(result.imported == 2)
        #expect(store.recents.count == 2)
        // Active GitLab → activeProject
        #expect(store.activeProject?.localPath == glPath.path)
    }

    @Test func isIdempotent() throws {
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mig-idem-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, defaults: .testDefaults)

        let first = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(first.alreadyCompleted == false)
        let second = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(second.alreadyCompleted == true)
    }

    @Test func emptyInputIsNoOp() throws {
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mig-empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        let migrator = ProjectMigrator(store: store, defaults: .testDefaults)
        let result = migrator.runOnce(gitLab: [], gitHub: [])
        #expect(result.imported == 0)
        #expect(store.activeProject == nil)
    }
}
```

- [ ] **Step 2: Run — expect failure**

```bash
swift build --build-tests 2>&1 | tail -5
```
Expected: `ProjectMigrator` not defined.

- [ ] **Step 3: Create ProjectMigrator.swift**

Write `mac/Sources/LlmIdeMac/Services/ProjectMigrator.swift`:

```swift
import Foundation

/// One-shot importer that walks legacy SavedGitLab/GitHubRepo arrays
/// (where each has a localPath) and registers each as a Project via
/// ProjectStore. The most-recently-active becomes the new
/// activeProject. Records its own completion in a sidecar file so a
/// second invocation is a no-op.
@MainActor
final class ProjectMigrator {

    struct Result {
        let imported: Int
        let alreadyCompleted: Bool
    }

    private let store: ProjectStore
    private let defaults: ProjectSettings
    private let completionMarker: URL

    init(store: ProjectStore,
         defaults: ProjectSettings,
         markerDirectory: URL? = nil) {
        self.store = store
        self.defaults = defaults
        let dir = markerDirectory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                .appendingPathComponent("LLM IDE")
        self.completionMarker = dir.appendingPathComponent(".project-migration-complete")
    }

    func runOnce(gitLab: [SavedGitLabProject],
                 gitHub: [SavedGitHubRepo]) -> Result {
        if FileManager.default.fileExists(atPath: completionMarker.path) {
            return Result(imported: 0, alreadyCompleted: true)
        }

        var imported = 0
        var preferredActivePath: String?

        for p in gitLab where (p.localPath?.isEmpty == false) {
            guard let path = p.localPath else { continue }
            do {
                try store.openFolder(at: URL(fileURLWithPath: path))
                imported += 1
                if p.isActive { preferredActivePath = path }
            } catch {
                // Best-effort: log + continue. Migration shouldn't
                // block startup over a single bad legacy row.
                NSLog("[ProjectMigrator] gitlab '\(p.displayName)' failed: \(error)")
            }
        }
        for r in gitHub where (r.localPath?.isEmpty == false) {
            guard let path = r.localPath else { continue }
            do {
                try store.openFolder(at: URL(fileURLWithPath: path))
                imported += 1
                if r.isActive && preferredActivePath == nil {
                    preferredActivePath = path
                }
            } catch {
                NSLog("[ProjectMigrator] github '\(r.displayName)' failed: \(error)")
            }
        }

        // The active winner is reopened LAST so it ends up as the
        // activeProject (openFolder sets it).
        if let p = preferredActivePath {
            try? store.openFolder(at: URL(fileURLWithPath: p))
        }

        try? FileManager.default.createDirectory(
            at: completionMarker.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: completionMarker.path, contents: Data())

        return Result(imported: imported, alreadyCompleted: false)
    }
}
```

- [ ] **Step 4: Tests pass**

```bash
swift test --filter ProjectMigratorTests 2>&1 | tail -10
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ProjectMigrator.swift mac/Tests/LlmIdeMacTests/ProjectMigratorTests.swift
git commit -m "feat(mac): ProjectMigrator imports legacy SavedGitLab/HubRepo

One-shot importer. Walks each saved repo that has a non-empty
localPath, calls store.openFolder, designates the most-recently-
active as the new activeProject. Records completion in a sidecar
marker so a second invocation is a no-op. Best-effort: a single
bad row doesn't block migration of the rest.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: AppConfig extracts default project settings

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift`

- [ ] **Step 1: Add a computed defaultProjectSettings property**

Open `mac/Sources/LlmIdeMac/Models/Config.swift`. Find the end of the `AppConfig` class. Add this computed property (before the closing `}`):

```swift
extension AppConfig {
    /// Snapshot of current AppConfig values projected into a
    /// ProjectSettings shape. Used by ProjectStore.openFolder when
    /// it materialises `<folder>/.llmide/project.json` for the
    /// first time. After Phase 1, AppConfig retains these fields for
    /// back-compat but project-scoped call sites consult the active
    /// Project's bundle instead.
    var defaultProjectSettings: ProjectSettings {
        ProjectSettings(
            language: prefsLanguage,
            activeCLI: activeCLI,
            linkedRepo: nil,                // user picks via Settings on first run
            notesFolderRelative: nil,
            enabledPlugins: [],
            graphifyBinaryOverride: graphifyBinaryOverride,
            regressionLookbackCount: autoCodeUpdateLookbackCount,
            agentPersona: nil,
            docTemplatesActive: [])
    }
}
```

- [ ] **Step 2: Add a no-op test to lock the shape**

Append to `mac/Tests/LlmIdeMacTests/AppConfigPathsTests.swift` (or create a new test file if cleaner):

```swift
@Test func defaultProjectSettingsMirrorsAppConfig() async {
    await MainActor.run {
        let cfg = AppConfig.shared
        let snap = cfg.defaultProjectSettings
        #expect(snap.language == cfg.prefsLanguage)
        #expect(snap.activeCLI == cfg.activeCLI)
        #expect(snap.graphifyBinaryOverride == cfg.graphifyBinaryOverride)
        #expect(snap.regressionLookbackCount == cfg.autoCodeUpdateLookbackCount)
    }
}
```

- [ ] **Step 3: Build + test**

```bash
swift build --build-tests 2>&1 | tail -3
swift test --filter defaultProjectSettings 2>&1 | tail -5
```
Expected: build + 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Config.swift mac/Tests/LlmIdeMacTests/AppConfigPathsTests.swift
git commit -m "feat(mac): AppConfig.defaultProjectSettings snapshot for ProjectStore

Computed property projects current global AppConfig values into a
ProjectSettings shape. ProjectStore.openFolder uses this when
materialising .llmide/project.json for the first time, so a
freshly-opened folder inherits the user's current global prefs as
defaults.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Wire ProjectStore into LlmIdeMacApp + Welcome view

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Welcome/WelcomeView.swift`
- Create: `mac/Sources/LlmIdeMac/Views/Welcome/RecentProjectsList.swift`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`

- [ ] **Step 1: Create RecentProjectsList.swift**

```swift
import SwiftUI

/// Reusable list — used by WelcomeView and QuickSwitcherSheet.
struct RecentProjectsList: View {
    @EnvironmentObject var theme: ThemeStore
    let entries: [ProjectStore.RecentEntry]
    let onPick: (ProjectStore.RecentEntry) -> Void

    var body: some View {
        let t = theme.current
        if entries.isEmpty {
            Text("No recent projects yet.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(entries) { entry in
                    Button { onPick(entry) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.displayName).font(Typography.body)
                            Text(entry.path)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(t.textMuted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
                }
            }
        }
    }
}
```

- [ ] **Step 2: Create WelcomeView.swift**

```swift
import SwiftUI
import AppKit

/// Shown when no project is active. Open Folder + recent list.
struct WelcomeView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    @State private var error: String?

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Text("LLM IDE")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(t.text)
            Text("Open a project folder to get started. Each folder becomes its own workspace.")
                .foregroundStyle(t.textMuted)
                .padding(.bottom, Spacing.md)

            Button {
                pickFolder()
            } label: {
                Label("Open Folder…", systemImage: "folder.badge.plus")
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, Spacing.sm)
            }
            .buttonStyle(.borderedProminent)

            if !projectStore.recents.isEmpty {
                Divider().padding(.vertical, Spacing.md)
                Text("Recent projects")
                    .font(Typography.caption.bold())
                    .foregroundStyle(t.textMuted)
                RecentProjectsList(entries: projectStore.recents) { entry in
                    do { try projectStore.switchTo(recent: entry) }
                    catch { self.error = error.localizedDescription }
                }
            }

            if let err = error {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
            }
            Spacer()
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 720, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .center)
        .background(t.body)
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Project"
        if panel.runModal() == .OK, let url = panel.url {
            do { try projectStore.openFolder(at: url) }
            catch { self.error = error.localizedDescription }
        }
    }
}
```

- [ ] **Step 3: Wire ProjectStore into the app**

Modify `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`. Inside the `init()` (after the registry construction, before the `self._config = ...` block) add:

```swift
let projectStoreInstance: ProjectStore = {
    let appSupport = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSHomeDirectory())
    let stateDir = appSupport.appendingPathComponent("LLM IDE")
    return ProjectStore(stateDirectory: stateDir, defaults: cfg.defaultProjectSettings)
}()
```

Add the `@StateObject` declaration alongside the others:

```swift
@StateObject private var projectStore: ProjectStore
```

And the assignment in `init()`:

```swift
self._projectStore = StateObject(wrappedValue: projectStoreInstance)
```

In the `Window` body, add the environment object:

```swift
.environmentObject(projectStore)
```

- [ ] **Step 4: Mount Welcome from AppShell**

Modify `mac/Sources/LlmIdeMac/Views/AppShell.swift` body. Find the top of `body: some View`. Wrap the existing content in a Group that switches on active project:

```swift
@EnvironmentObject var projectStore: ProjectStore

var body: some View {
    Group {
        if projectStore.activeProject == nil {
            WelcomeView()
        } else {
            existingShellContent   // wrap your previous body into a private @ViewBuilder var
        }
    }
    // …existing modifiers stay below…
}
```

(Pull the prior body into a `@ViewBuilder private var existingShellContent: some View { … }`.)

- [ ] **Step 5: Build, launch, smoke-test**

```bash
cd mac && bash Scripts/build.sh && open LlmIdeMac.app
```
Expected behavior:
- Fresh launch (no projects.json yet) → WelcomeView appears
- Click "Open Folder…" → pick any folder → app switches to existing shell
- Quit + relaunch → app reopens the same project

Quit the app between checks. If the previous .llmide/project.json exists in the picked folder you may want a clean test folder.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Welcome/*.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift mac/Sources/LlmIdeMac/Views/AppShell.swift
git commit -m "feat(mac): WelcomeView + ProjectStore wiring

ProjectStore is now in the environment; AppShell shows WelcomeView
when no project is active, the existing shell otherwise. Open
Folder uses NSOpenPanel directory mode; recent projects appear
once you've opened at least one.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Sidebar project header + switcher dropdown

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shell/ProjectSwitcher.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Shell/SidebarView.swift`

- [ ] **Step 1: Create ProjectSwitcher.swift**

```swift
import SwiftUI
import AppKit

struct ProjectSwitcher: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    var body: some View {
        let t = theme.current
        let active = projectStore.activeProject
        Menu {
            Section("Recent") {
                ForEach(projectStore.recents.filter { $0.id != active?.bundle.id }) { entry in
                    Button(entry.displayName) {
                        try? projectStore.switchTo(recent: entry)
                    }
                }
            }
            Divider()
            Button("Open Folder…") { openFolderPanel() }
            if let active {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: active.localPath)])
                }
                Button("Close Project") {
                    try? projectStore.closeActive()
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "folder.fill")
                    .foregroundStyle(t.accent)
                Text(active?.bundle.displayName ?? "No project")
                    .font(Typography.body)
                    .foregroundStyle(t.text)
                    .lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9))
                    .foregroundStyle(t.textMuted)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            try? projectStore.openFolder(at: url)
        }
    }
}
```

- [ ] **Step 2: Slot it into SidebarView**

In `mac/Sources/LlmIdeMac/Views/Shell/SidebarView.swift`, find the top of the sidebar body. Insert above the existing section list:

```swift
ProjectSwitcher()
    .padding(.horizontal, 8)
    .padding(.top, 8)
Divider().padding(.vertical, 4)
```

- [ ] **Step 3: Build + manual smoke**

```bash
bash Scripts/build.sh && open LlmIdeMac.app
```
Open two folders in sequence. Switch between them via the chip dropdown. Verify each switch shows the new name in the chip and the sidebar tabs reflect the new project context (this will be a no-op visually until Task 8 wires the panels — but the chip text and recents-list update should both work).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shell/ProjectSwitcher.swift mac/Sources/LlmIdeMac/Views/Shell/SidebarView.swift
git commit -m "feat(mac): sidebar project switcher chip

Menu surfaces recent projects + Open Folder + Reveal in Finder +
Close Project. Sits at the top of the sidebar above the section
list. Wires through the ProjectStore environment object.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Cmd-P quick switcher

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shell/QuickSwitcherSheet.swift`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` (add the keyboard shortcut + sheet)

- [ ] **Step 1: Create QuickSwitcherSheet.swift**

```swift
import SwiftUI

struct QuickSwitcherSheet: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore
    @Binding var isPresented: Bool
    @State private var filter: String = ""

    var filtered: [ProjectStore.RecentEntry] {
        guard !filter.isEmpty else { return projectStore.recents }
        let needle = filter.lowercased()
        return projectStore.recents.filter {
            $0.displayName.lowercased().contains(needle) ||
            $0.path.lowercased().contains(needle)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("Switch project — type to filter", text: $filter)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .padding(Spacing.md)
            Divider()
            ScrollView {
                RecentProjectsList(entries: filtered) { entry in
                    try? projectStore.switchTo(recent: entry)
                    isPresented = false
                }
                .padding(Spacing.md)
            }
            .frame(maxHeight: 320)
        }
        .frame(minWidth: 540, maxWidth: 600)
        .background(theme.current.surface)
        // Esc closes
        .onExitCommand { isPresented = false }
    }
}
```

- [ ] **Step 2: Hook the shortcut + sheet in LlmIdeMacApp**

In `LlmIdeMacApp.swift`, add an `@State private var quickSwitcherShown = false`. In the Window's `.commands { ... }` block (the one we added in the Sparkle pass), add a new CommandGroup:

```swift
CommandGroup(after: .windowList) {
    Button("Quick Switch Project…") { quickSwitcherShown = true }
        .keyboardShortcut("p", modifiers: .command)
}
```

In the Window's body (after the existing `.environmentObject(...)` chain), add:

```swift
.sheet(isPresented: $quickSwitcherShown) {
    QuickSwitcherSheet(isPresented: $quickSwitcherShown)
        .environmentObject(theme)
        .environmentObject(projectStore)
}
```

- [ ] **Step 3: Build + smoke**

```bash
bash Scripts/build.sh && open LlmIdeMac.app
```
Open app, ensure ≥2 projects in recents. Press Cmd-P → HUD opens. Type a substring → list filters. Enter / click → switch. Esc → close.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shell/QuickSwitcherSheet.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat(mac): Cmd-P quick switcher HUD

Modal sheet with a text field + filtered recent list. Esc cancels;
Enter or click switches. Wired via CommandGroup so it appears in
the Window menu as well.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Wire CodeAssistantPanel.buildAgentContext to active project

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`

- [ ] **Step 1: Replace the activeProject derivation**

Find `private func buildAgentContext() -> AgentContext` in `CodeAssistantPanel.swift` (around line 1090). The current code reads `config.gitLabSavedProjects.first(where: { $0.isActive })`. Replace with:

```swift
private func buildAgentContext() -> AgentContext {
    let activeProject: AgentContext.Project? = projectStore.activeProject.flatMap { ap in
        guard let linked = ap.bundle.settings.linkedRepo else { return nil }
        return AgentContext.Project(
            name: ap.bundle.displayName,
            url: linked.url,
            defaultBranch: linked.defaultBranch)
    }
    // existing indexedRepos logic stays — they're library items, not
    // the active project. Don't conflate.
    let codeItems = library.items(for: .code)
    // …rest unchanged…
}
```

Add the `projectStore` env declaration at the top of the view (near the other `@EnvironmentObject` declarations):

```swift
@EnvironmentObject var projectStore: ProjectStore
```

- [ ] **Step 2: Add a sanity test**

In a new `mac/Tests/LlmIdeMacTests/CodeAssistantAgentContextTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("CodeAssistantPanel agent context")
@MainActor
struct CodeAssistantAgentContextTests {
    @Test func projectLinkedRepoSurfacesAsAgentProject() throws {
        // smoke shape: AgentContext.Project mirrors LinkedRepo when set.
        // Real wiring is exercised at runtime; this asserts the type
        // conversion shape compiles + maps fields correctly.
        let lr = ProjectSettings.LinkedRepo(
            kind: .github, url: "https://github.com/o/n",
            remoteId: "o/n", defaultBranch: "main")
        let p = AgentContext.Project(
            name: "n", url: lr.url, defaultBranch: lr.defaultBranch)
        #expect(p.name == "n")
        #expect(p.defaultBranch == "main")
    }
}
```

- [ ] **Step 3: Build + run**

```bash
swift test --filter CodeAssistantAgentContextTests 2>&1 | tail -5
```
Expected: 1 passes.

- [ ] **Step 4: Manual smoke**

```bash
bash Scripts/build.sh && open LlmIdeMac.app
```
Open a project with no linked repo (Welcome → pick a fresh folder). Open Code Assistant panel — chat should work, agent context has `activeProject: null`. Then set the project's linked repo via Settings → Project → GitHub/GitLab → save (Task 9 wiring) — agent context now surfaces the repo. Defer this last bit until Task 9 lands; for now just confirm the unlinked path doesn't crash.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift mac/Tests/LlmIdeMacTests/CodeAssistantAgentContextTests.swift
git commit -m "feat(mac): CodeAssistantPanel uses active project for agent context

buildAgentContext() now reads from projectStore.activeProject's
linkedRepo instead of config.gitLabSavedProjects. When no project
is linked, activeProject is nil and the agent's system context
sees '(none configured)'. indexedRepos (library) stays as-is —
that's a different surface.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Wire AutoCodeUpdateService.resolveBackendAndProject to active project

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

- [ ] **Step 1: Inject ProjectStore**

Add to the dependencies block at the top of `AutoCodeUpdateService`:

```swift
private let projectStore: ProjectStore?
```

Modify the init to accept it (default nil for back-compat with tests):

```swift
init(config: AppConfig, backend: RepoBackend? = nil,
     registry: ProcessedActionsRegistry,
     projectStore: ProjectStore? = nil) {
    self.config = config
    self.backendOverride = backend
    self.registry = registry
    self.projectStore = projectStore
    // …rest unchanged…
}
```

- [ ] **Step 2: Update resolveBackendAndProject**

Replace the body of `resolveBackendAndProject()` (currently around lines 600-660). New version:

```swift
private func resolveBackendAndProject() -> ResolvedRepo? {
    // Prefer the active project's linkedRepo if there is one.
    if let active = projectStore?.activeProject,
       let linked = active.bundle.settings.linkedRepo {
        let local = active.localPath
        switch linked.kind {
        case .gitlab:
            guard !config.gitLabToken.isEmpty else { return nil }
            return .init(client: backendOverride ?? GitLabClient(config: config),
                         projectId: linked.remoteId, localPath: local)
        case .github:
            guard !config.gitHubToken.isEmpty else { return nil }
            return .init(client: backendOverride ?? GitHubClient(config: config),
                         projectId: linked.remoteId, localPath: local)
        }
    }
    // Fallback: legacy SavedGitLab/HubRepo arrays (pre-migration).
    // The same code we already had — kept for users who haven't
    // hit the migration path yet.
    if !config.gitLabToken.isEmpty,
       let p = config.gitLabSavedProjects.first(where: { $0.isActive }),
       let id = p.resolvedId,
       let local = p.localPath, !local.isEmpty {
        return .init(client: backendOverride ?? GitLabClient(config: config),
                     projectId: String(id), localPath: local)
    }
    if !config.gitHubToken.isEmpty,
       let r = config.gitHubSavedRepos.first(where: { $0.isActive }),
       let (owner, name) = GitHubClient.ownerAndName(from: r.url),
       let local = r.localPath, !local.isEmpty {
        return .init(client: backendOverride ?? GitHubClient(config: config),
                     projectId: "\(owner)/\(name)", localPath: local)
    }
    return nil
}
```

- [ ] **Step 3: Pass projectStore into the constructor**

In `LlmIdeMacApp.swift`, update the AutoCodeUpdateService construction:

```swift
let autoCode = AutoCodeUpdateService(
    config: cfg,
    gitLabClient: GitLabClient(),
    registry: registry,
    projectStore: projectStoreInstance)
```

- [ ] **Step 4: Build + verify existing tests still pass**

```bash
swift test --filter AutoCodeUpdateServiceTests 2>&1 | tail -5
```
Expected: existing tests still green (we kept backwards compatibility for the projectStore-less init).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat(mac): AutoCodeUpdateService prefers active project's linkedRepo

resolveBackendAndProject now checks projectStore.activeProject first
and only falls back to legacy SavedGitLab/HubRepo arrays if no
active project has a linkedRepo set. Constructor accepts the store
as optional for back-compat with tests.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Settings — split into App vs Project sections

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/SettingsView.swift`

- [ ] **Step 1: Re-bucket sections**

Open `SettingsView.swift`. The current body is a flat `VStack` listing every section. Wrap them in two groups:

```swift
var body: some View {
    ScrollView {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            // App-wide settings — apply to every project.
            Group {
                Text("App").font(Typography.title).foregroundStyle(theme.current.textMuted)
                AccountSettingsSection()
                ServerSettingsSection()
                BackendSettingsSection()
                AppearanceSettingsSection()
                SidebarVisibilitySection()
                CaptureSettingsSection()
                UpdatesSettingsSection()
                AboutSettingsSection()
            }

            // Project-scoped settings — only visible when a project is active.
            if projectStore.activeProject != nil {
                Group {
                    Divider().padding(.vertical, Spacing.md)
                    Text("Project").font(Typography.title).foregroundStyle(theme.current.textMuted)
                    PathsSettingsSection()
                    GitLabSettingsSection()
                    GitHubSettingsSection()
                    CLISettingsSection()
                    PreferencesSettingsSection(api: api, language: $prefsLanguage)
                    AgentSettingsSection(api: api)
                    AutoCodeSettingsSection()
                    GeneratePlanSettingsSection(api: api, prefsLanguage: prefsLanguage)
                    PluginsSettingsSection(api: api)
                }
            }
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 720, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
    }
    .background(theme.current.body)
}
```

Add the env declaration at the top of `SettingsView`:

```swift
@EnvironmentObject var projectStore: ProjectStore
```

- [ ] **Step 2: Build + manual smoke**

```bash
bash Scripts/build.sh && open LlmIdeMac.app
```
With no active project (Welcome): Settings is not reachable (existing AppShell only renders Settings via the section). With an active project: Settings shows both groups.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SettingsView.swift
git commit -m "feat(mac): split Settings into App + Project groups

App: Account, Server, Backend, Appearance, Sidebar, Capture,
Updates, About. Project (only when active): Paths, GitLab/GitHub,
CLI, Preferences, Agent, AutoCode, GeneratePlan, Plugins.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Run migrator at app startup

**Files:**
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`

- [ ] **Step 1: Add migration trigger to the launch task**

In the `.task` modifier on ContentView (where bootstrap currently runs `templateStore.bootstrap()` etc.), add at the start:

```swift
.task {
    // One-shot import of legacy SavedGitLab/HubRepo entries with
    // localPath. No-op after first successful run (recorded by a
    // sidecar marker).
    let migrator = ProjectMigrator(store: projectStore,
                                   defaults: config.defaultProjectSettings)
    let result = migrator.runOnce(
        gitLab: config.gitLabSavedProjects,
        gitHub: config.gitHubSavedRepos)
    if result.imported > 0 {
        NSLog("[Migration] Imported \(result.imported) legacy projects")
    }
    // existing bootstrap continues below…
    templateStore.bootstrap()
    // …
}
```

- [ ] **Step 2: Manual smoke (only relevant if the running test machine has legacy data)**

Quit + relaunch. If the user has SavedGitLab/HubRepo entries with localPath in their existing UserDefaults, the first launch after this commit should import them; subsequent launches do nothing.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat(mac): run ProjectMigrator at first launch

Idempotent. Imports legacy SavedGitLab/HubRepo entries whose
localPath is set into ProjectStore, then writes a sidecar marker
so subsequent launches no-op.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Server-side projectId in meta

**Files:**
- Modify: `extension/kb/db.mjs`
- Test: `extension/tests/tenancy.test.mjs`

- [ ] **Step 1: Add a failing test for projectId scoping**

Append to `extension/tests/tenancy.test.mjs`:

```js
test('search filters by projectId when supplied', () => {
  const db = openTestDb();
  // user A has two meetings, one tagged with project "P1", one untagged
  kb.ingestMeeting('userA', {
    id: 'm1', title: 'P1 meeting',
    transcript: 'The product roadmap discussion',
    projectId: 'P1',
  });
  kb.ingestMeeting('userA', {
    id: 'm2', title: 'untagged',
    transcript: 'The product roadmap discussion',
  });
  const all  = kb.search('userA', { q: 'roadmap' });
  const p1   = kb.search('userA', { q: 'roadmap', projectId: 'P1' });
  assert.equal(all.length, 2);
  assert.equal(p1.length,  1);
  assert.equal(p1[0].meetingId, 'm1');
});
```

- [ ] **Step 2: Confirm it fails**

```bash
cd extension && node --test tests/tenancy.test.mjs 2>&1 | tail -10
```
Expected: `search filters by projectId when supplied` fails (the option isn't honored).

- [ ] **Step 3: Wire projectId into ingestMeeting + ingestSources**

In `extension/kb/db.mjs`, find `ingestMeeting`. The function currently writes meta as `JSON.stringify(input.meta || {})`. Update to merge projectId into meta:

```js
export function ingestMeeting(userId, input) {
  requireUser(userId);
  if (!input?.id) throw errValidation('Meeting id is required');
  const meta = {
    ...(input.meta || {}),
    ...(input.projectId ? { projectId: String(input.projectId).slice(0, 64) } : {}),
  };
  // …rest of existing logic but use the new `meta` variable…
}
```

Same shape for `ingestSources`. Each item gets `item.meta = { ...item.meta, ...(item.projectId ? { projectId } : {}) }` before the insert.

- [ ] **Step 4: Wire search()'s projectId filter**

In `db.mjs`'s `search()`, accept a new option AND extend the meeting hydration to pull `meta`. Two concrete edits.

First, change the function signature and the meeting-hydration `SELECT` (around line 305):

```js
export function search(userId, { q, kind, limit = 20, projectId } = {}) {
  // …existing logic up through `meetingIds` computation unchanged…
  if (meetingIds.length > 0) {
    const placeholders = meetingIds.map(() => '?').join(',');
    const meetings = db.prepare(
      `SELECT id, title, date, meta FROM meetings WHERE user_id = ? AND id IN (${placeholders})`,
    ).all(userId, ...meetingIds);
    for (const m of meetings) meetingMap.set(m.id, m);
  }
  // …existing source/plan/task/outcome hydration unchanged…
```

Second, augment the final filter (around line 397) with a projectId check applied after the existing tenancy gate:

```js
  return rows.map((r) => {
    // …existing SOURCE_KINDS handling produces `out`…
    // (unchanged through plan/task/outcome branches)

    // NEW: projectId filter applies after everything else. We accept
    // a row if either:
    //   - no projectId was requested, OR
    //   - the row's resolved meta has a matching projectId
    if (projectId) {
      let rowMeta = null;
      if (SOURCE_KINDS.has(r.kind)) {
        rowMeta = sourceMap.get(r.entity_id)?.meta;
      } else if (ENTITY_KINDS.has(r.kind)) {
        rowMeta = meetingMap.get(r.meeting_id)?.meta;
      }
      // plan/task/outcome: project tag lives on the parent plan's meta;
      // we don't fetch it here (avoid an extra join). They're scoped by
      // user already; projectId narrows ENTITY/SOURCE rows only.
      const parsed = typeof rowMeta === 'string' ? safeParseMeta(rowMeta) : (rowMeta || {});
      if (parsed?.projectId !== projectId) return null;
    }
    return out;
  }).filter(Boolean);
```

(Pull the row's `out` object construction up into a `let out` declared above the branch so the projectId filter can reference it.)

- [ ] **Step 5: Re-run tests until green**

```bash
node --test tests/tenancy.test.mjs 2>&1 | tail -10
```
Expected: all tenancy tests pass including the new one.

- [ ] **Step 6: Commit**

```bash
git add extension/kb/db.mjs extension/tests/tenancy.test.mjs
git commit -m "feat(server): projectId scoping via meta JSON

ingestMeeting + ingestSources accept an optional projectId field
and persist it inside the existing meta JSON column. search()
accepts {projectId} and filters hydrated rows via
json_extract(meta, '\$.projectId'). No schema migration: the
column already exists. Reversible.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: Mac client passes projectId on every KB write

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+*.swift` (the ingest call sites)

- [ ] **Step 1: Locate ingest call sites**

```bash
grep -rn "kb/ingest\|/kb/ingest" mac/Sources/LlmIdeMac
```

For each call site that POSTs to `/kb/ingest`, add `projectId: projectStore.activeProject?.bundle.id` to the request payload.

- [ ] **Step 2: Same for /kb/connect-git**

The connect-git endpoint also accepts a meta dict. Pass `projectId` through.

- [ ] **Step 3: Smoke: full E2E with two projects**

```bash
# Boot the server
lsof -ti :3456 | xargs kill -9 2>/dev/null; sleep 1
(cd extension && node server.mjs >/tmp/srv.log 2>&1 &)
sleep 3

# Build + launch mac
bash mac/Scripts/build.sh && open mac/LlmIdeMac.app
```

In the app: open project A, ingest a meeting via the recording flow. Switch to project B (via cmd-P). Search the KB — expect only project A's meeting to NOT appear in B's search (KB search is now project-scoped client-side via the projectId parameter; until the Mac search UI plumbs it through, this can be verified via curl).

```bash
TOK=...   # from /auth/login
curl -s -G --data-urlencode 'q=roadmap' "http://127.0.0.1:3456/kb/search?projectId=A" \
  -H "Authorization: Bearer $TOK"
```

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/
git commit -m "feat(mac): pass projectId on KB ingest + connect-git

Every write that materialises a meeting or source on the server
now carries the active project's id so server-side search can
scope by project. Reads (search) still default to no-filter; the
Mac client will pass projectId once we wire the UI in Phase 2.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: Status bar (bottom of main window)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`

- [ ] **Step 1: Create StatusBar.swift**

```swift
import SwiftUI

struct StatusBar: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    var body: some View {
        let t = theme.current
        let active = projectStore.activeProject
        HStack(spacing: 12) {
            if let active {
                Image(systemName: "folder.fill")
                    .foregroundStyle(t.accent)
                Text(active.bundle.displayName).font(Typography.caption.bold())
                Text(active.localPath)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1).truncationMode(.middle)
                if let linked = active.bundle.settings.linkedRepo {
                    Spacer().frame(width: 8)
                    Image(systemName: linked.kind == .github ? "circle.dashed" : "g.square")
                        .foregroundStyle(t.textMuted)
                    Text(linked.remoteId).font(.system(size: 11))
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                }
            } else {
                Text("No project").foregroundStyle(t.textMuted)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(t.surface)
        .frame(maxWidth: .infinity, minHeight: 24)
        .overlay(Divider(), alignment: .top)
    }
}
```

- [ ] **Step 2: Mount StatusBar at the bottom of AppShell**

In `AppShell.swift`, in the existing shell body, wrap the main content in a VStack and append:

```swift
VStack(spacing: 0) {
    existingShellContent
    StatusBar()
}
```

- [ ] **Step 3: Build + smoke**

```bash
bash Scripts/build.sh && open LlmIdeMac.app
```
A thin row at the bottom shows the project name + path + (if linked) the repo identifier. Switching projects updates it live.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift mac/Sources/LlmIdeMac/Views/AppShell.swift
git commit -m "feat(mac): status bar at the bottom of the main window

Project name + abbreviated path + linked-repo badge. Updates live
on project switch via the ProjectStore environment.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: Update render-active-project on the server

**Files:**
- Modify: `extension/llm_agent/internal/context/render-active-project.mjs`

- [ ] **Step 1: Accept the new bundle shape**

The current renderer reads `agentContext.activeProject.{name, url, defaultBranch}` — that shape is what the Mac client now produces from `linkedRepo`. The change here is cosmetic: rename the section heading from "Active GitLab project" to "Active project" so it matches multi-backend reality.

Edit the markdown heading line in `extension/llm_agent/internal/context/render-active-project.mjs`:

```js
const lines = ['## Active project'];
```

- [ ] **Step 2: Run server tests**

```bash
cd extension && npm test 2>&1 | tail -10
```
Expected: 221/221 still pass.

- [ ] **Step 3: Commit**

```bash
git add extension/llm_agent/internal/context/render-active-project.mjs
git commit -m "chore(server): rename agent-context heading to 'Active project'

Now that the Mac client sends linkedRepo (GitHub or GitLab) instead
of a GitLab-only ActiveProject shape, the heading shouldn't claim
'GitLab project'. Cosmetic but reduces user confusion.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: End-to-end smoke checklist

- [ ] **Step 1: Fresh install path**

Wipe `~/Library/Application Support/LLM IDE/projects.json` and `.project-migration-complete` markers. Launch app → Welcome appears. Open Folder → app enters project mode. Quit + relaunch → reopens the same project.

- [ ] **Step 2: Switch between projects**

Open two distinct folders. Sidebar chip + Cmd-P both switch cleanly. The Code Assistant panel's agent-context payload differs by active project (verified via the server's request log).

- [ ] **Step 3: Settings split is visible**

Settings shows App group always. Project group appears only when active. Closing the project hides the Project group.

- [ ] **Step 4: Migration**

If the test machine has legacy SavedGitLab/HubRepo entries with localPath: those projects appear in recents after first launch; the marker file exists; second launch makes no new entries.

- [ ] **Step 5: Server-side scoping**

```bash
# Boot server. Two users, two projects each.
# User A ingests meetings tagged projectId="P1" via the Mac app.
# curl /kb/search?projectId=P1 returns only P1's rows.
# curl /kb/search (no projectId) returns all rows for that user.
```

- [ ] **Step 6: Final commit**

```bash
git commit --allow-empty -m "chore: per-project workspaces Phase 1 complete

Closes spec docs/superpowers/specs/2026-05-25-per-project-workspaces-design.md.
Phase 1 ships: Project model + ProjectStore + Welcome + sidebar
switcher + Cmd-P quick switch + Settings split + Mac/server
projectId scoping + legacy migration. Phase 2 (multi-window,
per-project plugin enable, regression-baseline path standardisation)
deferred to a separate spec.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-review checklist

After implementing all tasks, walk through the spec section by section:

| Spec section | Plan task |
|---|---|
| Data model — project.json | Task 1 |
| Data model — projects.json | Task 2 |
| Global vs per-project field split | Task 4 |
| Welcome screen | Task 5 |
| Sidebar header / dropdown | Task 6 |
| Cmd-P quick switcher | Task 7 |
| Settings re-bucket | Task 10 |
| Behavior: opening a folder | Task 5 (open) + Task 11 (auto-trigger background work — deferred to Phase 2; index/memory load not yet automated) |
| Behavior: switching | Task 6/7 |
| Migration | Task 3 + Task 11 |
| Server-side projectId | Task 12 + Task 15 (cosmetic header) + Task 13 (Mac sender) |
| Component breakdown | All file-map entries present |
| Status bar | Task 14 |
| Testing strategy unit tests | Tasks 1/2/3 each include tests |
| Testing strategy integration smoke | Task 16 |

## What's intentionally NOT in this plan

- Multi-window (Phase 2)
- Per-project plugin enable layer (Phase 2)
- Auto-trigger background indexing on project open (Phase 2 — the openFolder flow today just creates the JSON; KB indexing is still a manual `/kb/connect-git` call from the existing UI)
- Move regression baselines to `<project>/.llmide/regression/` (Phase 2)
