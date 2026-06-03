# Auto Code Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background service that scans recent meeting note `## Actions` items every hour, creates GitLab issues for untracked ones, invokes the selected CLI tool to implement each issue, then comments and closes it.

**Architecture:** `NoteActionExtractor` parses actions from `.md` files → `ProcessedActionsRegistry` (JSON file) tracks which have been handled → `AutoCodeUpdateService` runs the hourly loop: check issues, create missing ones, spawn CLI subprocess per pending action, post comment + close on success. A Settings section exposes the toggle, lookback count, status, and a manual "Run Now" trigger.

**Tech Stack:** Swift 5.9, SwiftUI, Swift Testing (`import Testing`), `Foundation.Process` for CLI subprocesses, `JSONEncoder`/`JSONDecoder` for registry persistence, existing `GitLabClient`, `MeetingIndex`, `AICliTool`.

---

## File Map

| File | Action |
|---|---|
| `Sources/MeetNotesMac/Models/NoteAction.swift` | **Create** — `NoteAction` struct + `NoteActionExtractor` |
| `Sources/MeetNotesMac/Models/ProcessedActionsRegistry.swift` | **Create** — JSON-backed registry with status tracking |
| `Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift` | **Create** — hourly timer, run loop, CLI subprocess dispatch |
| `Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift` | **Create** — toggle, status, Run Now button |
| `Sources/MeetNotesMac/Models/Config.swift` | **Modify** — add `autoCodeUpdateEnabled`, `autoCodeUpdateLookbackCount` |
| `Sources/MeetNotesMac/Models/AICliTool.swift` | **Modify** — add `cliExecutable: String` |
| `Sources/MeetNotesMac/Views/SettingsView.swift` | **Modify** — add `AutoCodeSettingsSection()` |
| `Sources/MeetNotesMac/MeetNotesMacApp.swift` | **Modify** — instantiate + inject `AutoCodeUpdateService` |
| `Tests/MeetNotesMacTests/NoteActionExtractorTests.swift` | **Create** |
| `Tests/MeetNotesMacTests/ProcessedActionsRegistryTests.swift` | **Create** |

---

## Task 1: NoteAction model + NoteActionExtractor

**Files:**
- Create: `Sources/MeetNotesMac/Models/NoteAction.swift`
- Create: `Tests/MeetNotesMacTests/NoteActionExtractorTests.swift`

- [ ] **Step 1.1: Write failing tests**

Create `Tests/MeetNotesMacTests/NoteActionExtractorTests.swift`:

```swift
import Testing
@testable import MeetNotesMac
import Foundation

final class NoteActionExtractorTests {

    let tempRoot: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("nae-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: tempRoot) }

    // MARK: - Helpers

    private func write(filename: String, id: String, title: String, body: String) throws -> URL {
        let url = tempRoot.appendingPathComponent(filename)
        let content = """
        ---
        id: \(id)
        title: "\(title)"
        started_at: "2026-05-15T10:00:00Z"
        ---
        \(body)
        """
        try content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func makeRow(id: String, title: String, filename: String) -> MeetingIndex.Row {
        MeetingIndex.Row(
            id: id, path: filename, title: title,
            startedAt: 1747296000000, endedAt: nil, durationSec: nil,
            gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 0, fileSize: 0,
            indexedAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    @Test func extractsActionsFromMeeting() throws {
        let body = """
        ## Actions
        - Fix login bug
        - Add unit tests
        ## Decisions
        - Use PostgreSQL
        """
        try write(filename: "meeting1.md", id: "AAA", title: "Sprint 1", body: body)
        let rows = [makeRow(id: "AAA", title: "Sprint 1", filename: "meeting1.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.count == 2)
        #expect(actions.map(\.text).contains("Fix login bug"))
        #expect(actions.map(\.text).contains("Add unit tests"))
        #expect(actions.allSatisfy { $0.meetingId == "AAA" })
        #expect(actions.allSatisfy { $0.meetingTitle == "Sprint 1" })
    }

    @Test func skipsEmptyActionsSection() throws {
        let body = "## Actions\n\n## Decisions\n- Use Redis\n"
        try write(filename: "meeting2.md", id: "BBB", title: "Empty", body: body)
        let rows = [makeRow(id: "BBB", title: "Empty", filename: "meeting2.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.isEmpty)
    }

    @Test func skipsNoteWithNoActionsSection() throws {
        let body = "## Decisions\n- Use Redis\n"
        try write(filename: "meeting3.md", id: "CCC", title: "NoActions", body: body)
        let rows = [makeRow(id: "CCC", title: "NoActions", filename: "meeting3.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.isEmpty)
    }

    @Test func actionIdIsStableAcrossRuns() throws {
        let body = "## Actions\n- Stable task\n"
        try write(filename: "meeting4.md", id: "DDD", title: "M", body: body)
        let rows = [makeRow(id: "DDD", title: "M", filename: "meeting4.md")]
        let first  = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        let second = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(first[0].id == second[0].id)
    }

    @Test func combinesActionsFromMultipleMeetings() throws {
        try write(filename: "m1.md", id: "E1", title: "M1", body: "## Actions\n- Task A\n")
        try write(filename: "m2.md", id: "E2", title: "M2", body: "## Actions\n- Task B\n")
        let rows = [
            makeRow(id: "E1", title: "M1", filename: "m1.md"),
            makeRow(id: "E2", title: "M2", filename: "m2.md"),
        ]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.count == 2)
        #expect(Set(actions.map(\.text)) == Set(["Task A", "Task B"]))
    }
}
```

- [ ] **Step 1.2: Run tests — expect failure**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test --filter NoteActionExtractorTests 2>&1 | tail -10
```

Expected: compile error — `NoteActionExtractor` not defined yet.

- [ ] **Step 1.3: Create `NoteAction.swift`**

Create `Sources/MeetNotesMac/Models/NoteAction.swift`:

```swift
import Foundation
import CryptoKit

struct NoteAction: Identifiable {
    let id: String           // SHA256 of normalized text — stable across runs
    let text: String         // raw bullet text
    let meetingId: String
    let meetingTitle: String
}

enum NoteActionExtractor {
    /// Reads each meeting's .md file from `notesRoot` and returns all
    /// `## Actions` bullet items across all provided rows.
    static func extract(from rows: [MeetingIndex.Row], notesRoot: URL) -> [NoteAction] {
        var result: [NoteAction] = []
        for row in rows {
            let fileURL = notesRoot.appendingPathComponent(row.path)
            guard let contents = try? String(contentsOf: fileURL, encoding: .utf8),
                  let split = FrontmatterCoder.split(file: contents) else { continue }
            let body = String(contents[split.bodyStart...])
            let items = actionsSection(in: body)
            for text in items {
                let normalized = normalize(text)
                guard !normalized.isEmpty else { continue }
                let id = sha256(normalized)
                result.append(NoteAction(id: id, text: text,
                                         meetingId: row.id,
                                         meetingTitle: row.title))
            }
        }
        return result
    }

    // MARK: - Internal helpers

    static func normalize(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: .punctuationCharacters).joined(separator: " ")
            .components(separatedBy: .whitespaces).filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func actionsSection(in body: String) -> [String] {
        guard let range = body.range(of: "## Actions") else { return [] }
        let after = String(body[range.upperBound...])
        let nextHeading = after.range(of: "\n## ")?.lowerBound ?? after.endIndex
        let section = after[..<nextHeading]
        return section.split(separator: "\n")
            .filter { $0.hasPrefix("- ") }
            .map { String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
    }

    private static func sha256(_ string: String) -> String {
        let data = Data(string.utf8)
        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }
}
```

- [ ] **Step 1.4: Run tests — expect pass**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test --filter NoteActionExtractorTests 2>&1 | tail -5
```

Expected: `Test run with 5 tests passed`.

- [ ] **Step 1.5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add Sources/MeetNotesMac/Models/NoteAction.swift Tests/MeetNotesMacTests/NoteActionExtractorTests.swift && git commit -m "feat: add NoteAction model and NoteActionExtractor"
```

---

## Task 2: ProcessedActionsRegistry

**Files:**
- Create: `Sources/MeetNotesMac/Models/ProcessedActionsRegistry.swift`
- Create: `Tests/MeetNotesMacTests/ProcessedActionsRegistryTests.swift`

- [ ] **Step 2.1: Write failing tests**

Create `Tests/MeetNotesMacTests/ProcessedActionsRegistryTests.swift`:

```swift
import Testing
@testable import MeetNotesMac
import Foundation

final class ProcessedActionsRegistryTests {

    var registry: ProcessedActionsRegistry!
    let tempFile: URL

    init() throws {
        tempFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("par-\(UUID().uuidString).json")
        registry = ProcessedActionsRegistry(storeURL: tempFile)
    }

    deinit { try? FileManager.default.removeItem(at: tempFile) }

    @Test func newActionIsUnknown() {
        #expect(!registry.isKnown(id: "abc"))
    }

    @Test func registerMakesActionKnown() {
        let action = NoteAction(id: "aaa", text: "Fix bug", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 42)
        #expect(registry.isKnown(id: "aaa"))
    }

    @Test func registeredActionStartsAsPending() {
        let action = NoteAction(id: "bbb", text: "Add tests", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 10)
        let entries = registry.pendingEntries()
        #expect(entries.count == 1)
        #expect(entries[0].status == .pending)
        #expect(entries[0].issueIid == 10)
    }

    @Test func markDoneRemovesFromPending() {
        let action = NoteAction(id: "ccc", text: "Deploy", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 5)
        registry.markDone(id: "ccc")
        #expect(registry.pendingEntries().isEmpty)
    }

    @Test func markFailedIncrementsRetryCount() {
        let action = NoteAction(id: "ddd", text: "Refactor", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 7)
        registry.markFailed(id: "ddd")
        let entries = registry.pendingEntries()
        #expect(entries[0].retryCount == 1)
        #expect(entries[0].status == .failed)
    }

    @Test func failedActionsUnder3RetriesAreRetried() {
        let action = NoteAction(id: "eee", text: "Write docs", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 9)
        registry.markFailed(id: "eee")
        registry.markFailed(id: "eee")
        // 2 retries — still appears in pendingEntries
        #expect(registry.pendingEntries().count == 1)
    }

    @Test func failedActionsAt3RetriesAreExcluded() {
        let action = NoteAction(id: "fff", text: "Exhausted", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 11)
        registry.markFailed(id: "fff")
        registry.markFailed(id: "fff")
        registry.markFailed(id: "fff")
        // 3 retries — no longer retried
        #expect(registry.pendingEntries().isEmpty)
    }

    @Test func persistsAndLoadsAcrossInstances() {
        let action = NoteAction(id: "ggg", text: "Persist me", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 20)
        registry.markDone(id: "ggg")

        let loaded = ProcessedActionsRegistry(storeURL: tempFile)
        #expect(loaded.isKnown(id: "ggg"))
        #expect(loaded.pendingEntries().isEmpty)
    }

    @Test func implementingEntriesAreResetToPendingOnInit() {
        let action = NoteAction(id: "hhh", text: "In flight", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 30)
        registry.markImplementing(id: "hhh")
        // Simulate crash-restart: load fresh instance from same file
        let reloaded = ProcessedActionsRegistry(storeURL: tempFile)
        let entries = reloaded.pendingEntries()
        #expect(entries.count == 1)
        #expect(entries[0].status == .pending)
    }
}
```

- [ ] **Step 2.2: Run tests — expect failure**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test --filter ProcessedActionsRegistryTests 2>&1 | tail -5
```

Expected: compile error — `ProcessedActionsRegistry` not defined yet.

- [ ] **Step 2.3: Create `ProcessedActionsRegistry.swift`**

Create `Sources/MeetNotesMac/Models/ProcessedActionsRegistry.swift`:

```swift
import Foundation

final class ProcessedActionsRegistry {

    // MARK: - Types

    enum EntryStatus: String, Codable {
        case pending, implementing, done, failed
    }

    struct RegistryEntry: Codable {
        let actionId: String
        let actionText: String
        var issueIid: Int?
        var status: EntryStatus
        var retryCount: Int
        var processedAt: Date
        var lastUpdated: Date
    }

    // MARK: - State

    private let storeURL: URL
    private var entries: [String: RegistryEntry] = [:]

    // MARK: - Init

    init(storeURL: URL) {
        self.storeURL = storeURL
        load()
        resetStuckImplementing()
    }

    // MARK: - Public API

    func isKnown(id: String) -> Bool {
        entries[id] != nil
    }

    func register(action: NoteAction, issueIid: Int?) {
        guard !isKnown(id: action.id) else { return }
        let entry = RegistryEntry(
            actionId: action.id,
            actionText: action.text,
            issueIid: issueIid,
            status: .pending,
            retryCount: 0,
            processedAt: Date(),
            lastUpdated: Date()
        )
        entries[action.id] = entry
        save()
    }

    func markImplementing(id: String) {
        update(id: id) { $0.status = .implementing }
    }

    func markDone(id: String) {
        update(id: id) { $0.status = .done }
    }

    func markFailed(id: String) {
        update(id: id) {
            $0.retryCount += 1
            $0.status = .failed
        }
    }

    /// Returns entries eligible for a CLI implementation run.
    /// Includes `pending` and `failed` entries with fewer than 3 retries.
    func pendingEntries() -> [RegistryEntry] {
        entries.values.filter { entry in
            switch entry.status {
            case .pending:         return true
            case .failed:          return entry.retryCount < 3
            case .implementing, .done: return false
            }
        }
    }

    // MARK: - Private

    private func update(id: String, mutation: (inout RegistryEntry) -> Void) {
        guard var entry = entries[id] else { return }
        mutation(&entry)
        entry.lastUpdated = Date()
        entries[id] = entry
        save()
    }

    private func resetStuckImplementing() {
        var changed = false
        for key in entries.keys where entries[key]?.status == .implementing {
            entries[key]?.status = .pending
            entries[key]?.lastUpdated = Date()
            changed = true
        }
        if changed { save() }
    }

    private func load() {
        guard let data = try? Data(contentsOf: storeURL),
              let decoded = try? JSONDecoder().decode([String: RegistryEntry].self, from: data)
        else { return }
        entries = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try? data.write(to: storeURL, options: .atomic)
    }
}
```

- [ ] **Step 2.4: Run tests — expect pass**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test --filter ProcessedActionsRegistryTests 2>&1 | tail -5
```

Expected: `Test run with 8 tests passed`.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add Sources/MeetNotesMac/Models/ProcessedActionsRegistry.swift Tests/MeetNotesMacTests/ProcessedActionsRegistryTests.swift && git commit -m "feat: add ProcessedActionsRegistry with JSON persistence"
```

---

## Task 3: AppConfig + AICliTool additions

**Files:**
- Modify: `Sources/MeetNotesMac/Models/Config.swift`
- Modify: `Sources/MeetNotesMac/Models/AICliTool.swift`

- [ ] **Step 3.1: Add `autoCodeUpdateEnabled` and `autoCodeUpdateLookbackCount` to AppConfig**

In `Sources/MeetNotesMac/Models/Config.swift`, add after the `defaultModelId` property (around line 60):

```swift
    /// When true, the hourly Auto Code Update loop is active.
    @Published var autoCodeUpdateEnabled: Bool {
        didSet { defaults.set(autoCodeUpdateEnabled, forKey: "autoCodeUpdateEnabled") }
    }

    /// How many of the most-recent meetings to scan for ## Actions items.
    @Published var autoCodeUpdateLookbackCount: Int {
        didSet { defaults.set(autoCodeUpdateLookbackCount, forKey: "autoCodeUpdateLookbackCount") }
    }
```

In the `private init`, after the `self.defaultModelId = ...` line, add:

```swift
        self.autoCodeUpdateEnabled = defaults.object(forKey: "autoCodeUpdateEnabled") as? Bool ?? false
        self.autoCodeUpdateLookbackCount = defaults.object(forKey: "autoCodeUpdateLookbackCount") as? Int ?? 5
```

- [ ] **Step 3.2: Add `cliExecutable` to AICliTool**

In `Sources/MeetNotesMac/Models/AICliTool.swift`, add after the `defaultModelId` computed property:

```swift
    /// The shell binary name used to invoke this CLI non-interactively.
    /// Only Claude Code supports `-p <prompt>` for fully non-interactive use;
    /// other tools use the same flag pattern but may open an interactive session.
    var cliExecutable: String {
        switch self {
        case .claudeCode: return "claude"
        case .cursor:     return "cursor"
        case .copilot:    return "gh"
        case .gemini:     return "gemini"
        }
    }
```

- [ ] **Step 3.3: Build to confirm no compile errors**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!`

- [ ] **Step 3.4: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add Sources/MeetNotesMac/Models/Config.swift Sources/MeetNotesMac/Models/AICliTool.swift && git commit -m "feat: add autoCodeUpdate config fields and AICliTool.cliExecutable"
```

---

## Task 4: AutoCodeUpdateService

**Files:**
- Create: `Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift`

- [ ] **Step 4.1: Create the service**

Create `Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift`:

```swift
import Foundation
import os.log

@MainActor
final class AutoCodeUpdateService: ObservableObject {

    // MARK: - Run statistics

    struct RunStats {
        var issuesCreated: Int = 0
        var implemented: Int = 0
        var failed: Int = 0
    }

    // MARK: - Published state

    @Published private(set) var isRunning = false
    @Published private(set) var lastRunDate: Date?
    @Published private(set) var statusMessage: String = "Not yet run"
    @Published private(set) var stats = RunStats()

    // MARK: - Dependencies

    private let config: AppConfig
    private let gitlab: GitLabClient
    private let registry: ProcessedActionsRegistry
    private var timer: Timer?
    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "AutoCodeUpdate")

    // MARK: - Init

    init(config: AppConfig) {
        self.config = config
        self.gitlab = GitLabClient()
        let storeURL = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MeetNotes/processed-actions.json")
        self.registry = ProcessedActionsRegistry(storeURL: storeURL)
    }

    // MARK: - Lifecycle

    func start() {
        scheduleTimer()
        log.info("auto_code_update_service_started")
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func runNow() {
        Task { await run() }
    }

    // MARK: - Timer

    private func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                guard self.config.autoCodeUpdateEnabled else { return }
                await self.run()
            }
        }
    }

    // MARK: - Main run loop

    private func run() async {
        guard !isRunning else { return }
        guard let project = config.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned }),
              let projectId = project.resolvedId,
              let localPath = project.localPath else {
            statusMessage = "No linked repo — configure in GitLab settings"
            return
        }

        isRunning = true
        stats = RunStats()
        log.info("auto_code_update_run_start projectId=\(projectId, privacy: .public)")

        defer {
            isRunning = false
            lastRunDate = Date()
            log.info("auto_code_update_run_end created=\(self.stats.issuesCreated) implemented=\(self.stats.implemented) failed=\(self.stats.failed)")
        }

        // 1. Extract actions from recent notes
        let actions = extractRecentActions()
        guard !actions.isEmpty else {
            statusMessage = "No actions found in last \(config.autoCodeUpdateLookbackCount) meetings"
            return
        }

        // 2. Filter to truly new (not in registry)
        let newActions = actions.filter { !registry.isKnown(id: $0.id) }

        // 3. Fetch existing GitLab issues once for dedup
        let existingIssues = (try? await gitlab.fetchAllIssues(projectId: projectId)) ?? []
        let normalizedTitles = Set(existingIssues.map { NoteActionExtractor.normalize($0.title) })

        // 4. Create issues for new, non-duplicate actions
        for action in newActions {
            let normalizedText = NoteActionExtractor.normalize(action.text)
            if normalizedTitles.contains(normalizedText) {
                // Already tracked in GitLab — register as done, skip
                registry.register(action: action, issueIid: nil)
                registry.markDone(id: action.id)
                continue
            }
            do {
                let payload = GitLabIssuePayload(
                    title: action.text,
                    description: "From meeting: **\(action.meetingTitle)**\n\nAuto-generated by Meet Notes Auto Code Update."
                )
                let issue = try await gitlab.createIssue(projectId: projectId, payload: payload)
                registry.register(action: action, issueIid: issue.iid)
                stats.issuesCreated += 1
                log.info("auto_code_update_issue_created iid=\(issue.iid, privacy: .public) title=\(action.text, privacy: .public)")
            } catch {
                log.error("auto_code_update_create_issue_failed: \(error, privacy: .public)")
            }
        }

        // 5. Implement pending entries via CLI subprocess
        let pending = registry.pendingEntries().filter { $0.issueIid != nil }
        for entry in pending {
            guard let iid = entry.issueIid else { continue }
            registry.markImplementing(id: entry.actionId)
            let success = await invokeCI(
                iid: iid,
                title: entry.actionText,
                localPath: localPath,
                projectId: projectId
            )
            if success {
                do {
                    let comment = "✅ Auto Code Update implemented this issue via \(activeCLIName())."
                    try await gitlab.createNote(projectId: projectId, iid: iid, body: comment)
                    try await gitlab.updateIssue(projectId: projectId, iid: iid,
                                                  payload: GitLabIssuePayload(title: entry.actionText,
                                                                               stateEvent: "close"))
                    registry.markDone(id: entry.actionId)
                    stats.implemented += 1
                } catch {
                    log.error("auto_code_update_post_comment_failed iid=\(iid): \(error, privacy: .public)")
                    registry.markFailed(id: entry.actionId)
                    stats.failed += 1
                }
            } else {
                registry.markFailed(id: entry.actionId)
                stats.failed += 1
            }
        }

        statusMessage = buildStatusMessage()
    }

    // MARK: - Notes extraction

    private func extractRecentActions() -> [NoteAction] {
        let notesFolderConfig = NotesFolderConfig()
        let folder = notesFolderConfig.currentFolder
        let indexURL = folder.appendingPathComponent(".meetnotes/index.sqlite")
        guard let index = try? MeetingIndex(url: indexURL) else { return [] }
        let rows = ((try? index.list()) ?? [])
            .sorted { $0.startedAt > $1.startedAt }
            .prefix(config.autoCodeUpdateLookbackCount)
        return NoteActionExtractor.extract(from: Array(rows), notesRoot: folder)
    }

    // MARK: - CLI subprocess

    private func invokeCI(iid: Int, title: String, localPath: String, projectId: Int) async -> Bool {
        guard let cli = AICliTool(rawValue: config.activeCLI) else { return false }

        let prompt = """
        Implement the following task in the git repository at \(localPath).
        GitLab issue #\(iid): \(title)
        Create a branch named fix/\(iid)-\(slugify(title)), make the changes, commit, and push.
        """

        let logDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/MeetNotes")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("auto-code-\(iid).log")
        // FileHandle(forWritingTo:) requires the file to already exist
        FileManager.default.createFile(atPath: logURL.path, contents: nil)

        return await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            if cli == .copilot {
                process.arguments = ["gh", "copilot", "suggest", "-t", "git", prompt]
            } else {
                process.arguments = [cli.cliExecutable, "-p", prompt]
            }
            process.currentDirectoryURL = URL(fileURLWithPath: localPath)
            process.standardOutput = try? FileHandle(forWritingTo: logURL)
            process.standardError  = process.standardOutput

            let timeoutTask = Task {
                try? await Task.sleep(for: .seconds(600))
                if process.isRunning {
                    process.terminate()
                    log.warning("auto_code_update_cli_timeout iid=\(iid, privacy: .public)")
                }
            }

            process.terminationHandler = { p in
                timeoutTask.cancel()
                continuation.resume(returning: p.terminationStatus == 0)
            }

            do {
                try process.run()
            } catch {
                log.error("auto_code_update_cli_launch_failed: \(error, privacy: .public)")
                timeoutTask.cancel()
                continuation.resume(returning: false)
            }
        }
    }

    // MARK: - Helpers

    private func slugify(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: .alphanumerics.inverted).joined(separator: "-")
            .components(separatedBy: "-").filter { !$0.isEmpty }.prefix(6).joined(separator: "-")
    }

    private func activeCLIName() -> String {
        AICliTool(rawValue: config.activeCLI)?.displayName ?? config.activeCLI
    }

    private func buildStatusMessage() -> String {
        var parts: [String] = []
        if stats.issuesCreated > 0 { parts.append("\(stats.issuesCreated) issue\(stats.issuesCreated == 1 ? "" : "s") created") }
        if stats.implemented > 0   { parts.append("\(stats.implemented) implemented") }
        if stats.failed > 0        { parts.append("\(stats.failed) failed") }
        return parts.isEmpty ? "Nothing new to do" : parts.joined(separator: " · ")
    }
}
```

- [ ] **Step 4.2: Build to confirm it compiles**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!`

- [ ] **Step 4.3: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift && git commit -m "feat: add AutoCodeUpdateService with hourly timer and CLI subprocess dispatch"
```

---

## Task 5: AutoCodeSettingsSection UI

**Files:**
- Create: `Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift`

- [ ] **Step 5.1: Create the settings section**

Create `Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift`:

```swift
import SwiftUI

struct AutoCodeSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var autoCodeUpdate: AutoCodeUpdateService

    private var activeProject: SavedGitLabProject? {
        config.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned })
    }

    var body: some View {
        SettingsSectionCard(icon: "wand.and.stars", title: "Auto Code Update") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Scans recent meeting actions every hour, creates GitLab issues for untracked items, and invokes the active CLI to implement each one.")

                if activeProject == nil {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .font(.system(size: 11))
                        Text("No cloned repo linked — configure in GitLab Settings first.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }

                // Enable toggle
                HStack(spacing: Spacing.md) {
                    Text("Enabled")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 130, alignment: .leading)
                    Toggle("", isOn: $config.autoCodeUpdateEnabled)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .onChange(of: config.autoCodeUpdateEnabled) { _, enabled in
                            if enabled { autoCodeUpdate.start() } else { autoCodeUpdate.stop() }
                        }
                }

                // Lookback picker
                HStack(spacing: Spacing.md) {
                    Text("Scan last")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 130, alignment: .leading)
                    Picker("", selection: $config.autoCodeUpdateLookbackCount) {
                        Text("3 meetings").tag(3)
                        Text("5 meetings").tag(5)
                        Text("10 meetings").tag(10)
                        Text("20 meetings").tag(20)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 140)
                }

                Divider().background(theme.current.border)

                // Status + Run Now
                HStack(spacing: Spacing.md) {
                    VStack(alignment: .leading, spacing: 3) {
                        if autoCodeUpdate.isRunning {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.mini)
                                Text("Running…")
                                    .font(Typography.caption)
                                    .foregroundStyle(theme.current.textMuted)
                            }
                        } else {
                            Text(autoCodeUpdate.statusMessage)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.textMuted)
                            if let date = autoCodeUpdate.lastRunDate {
                                Text("Last run: \(date.formatted(.relative(presentation: .named)))")
                                    .font(Typography.caption)
                                    .foregroundStyle(theme.current.textMuted)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Run Now") { autoCodeUpdate.runNow() }
                        .disabled(autoCodeUpdate.isRunning || activeProject == nil)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }
}
```

- [ ] **Step 5.2: Build to confirm it compiles**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!`

- [ ] **Step 5.3: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift && git commit -m "feat: add AutoCodeSettingsSection UI"
```

---

## Task 6: Wire into App

**Files:**
- Modify: `Sources/MeetNotesMac/Views/SettingsView.swift`
- Modify: `Sources/MeetNotesMac/MeetNotesMacApp.swift`

- [ ] **Step 6.1: Add section to SettingsView**

In `Sources/MeetNotesMac/Views/SettingsView.swift`, add `AutoCodeSettingsSection()` after `AgentSettingsSection(api: api)`:

```swift
                AgentSettingsSection(api: api)
                AutoCodeSettingsSection()
                GeneratePlanSettingsSection(api: api, prefsLanguage: prefsLanguage)
```

- [ ] **Step 6.2: Add service to MeetNotesMacApp**

In `Sources/MeetNotesMac/MeetNotesMacApp.swift`:

**a)** Add the state object declaration after `@StateObject private var liveMirror: LiveSessionMirror`:

```swift
    @StateObject private var autoCodeUpdate: AutoCodeUpdateService
```

**b)** In `init()`, after `self.autoCapture = AutoCaptureService(capture: orchestrator, config: cfg)`, add:

```swift
        self._autoCodeUpdate = StateObject(wrappedValue: AutoCodeUpdateService(config: cfg))
```

**c)** In the `Window` body, add `.environmentObject(autoCodeUpdate)` alongside the other environment objects:

```swift
                .environmentObject(autoCodeUpdate)
```

**d)** In the `.task` block, after `autoCapture.start()`, add:

```swift
                    if config.autoCodeUpdateEnabled { autoCodeUpdate.start() }
```

**e)** In the `.onChange(of: session.isAuthenticated)` block, add stop on sign-out:

```swift
                .onChange(of: session.isAuthenticated) { _, authed in
                    if authed { liveMirror.start() } else { liveMirror.stop(); autoCodeUpdate.stop() }
                }
```

- [ ] **Step 6.3: Build**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!`

- [ ] **Step 6.4: Run all tests**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add Sources/MeetNotesMac/Views/SettingsView.swift Sources/MeetNotesMac/MeetNotesMacApp.swift && git commit -m "feat: wire AutoCodeUpdateService into app and settings"
```

---

## Task 7: Build app and smoke test

- [ ] **Step 7.1: Build the .app bundle**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && bash build_app.sh 2>&1 | grep -E "error:|✓|FAILED"
```

Expected: `✓ Build Successful!`

- [ ] **Step 7.2: Smoke test in the running app**

1. Open Settings → scroll to **Auto Code Update** section
2. Confirm toggle is off by default
3. Confirm warning badge shows if no cloned repo is linked
4. Enable the toggle — confirm no crash
5. Click **Run Now** — confirm the spinner appears and `statusMessage` updates after a few seconds
6. Disable the toggle — confirm timer is stopped (no background activity in Console.app for `AutoCodeUpdate` category)

- [ ] **Step 7.3: Final commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && git add -A && git status
# Only commit if there are unexpected stray changes
```
