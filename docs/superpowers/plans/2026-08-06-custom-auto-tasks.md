# Custom Auto Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user create a named, prompt-based custom Auto Task from the Auto Tasks page, run it, see its live log, and have it appear/run correctly from the iPhone companion app — with an explicit "Refresh" affordance that pushes the current task state to a paired phone.

**Architecture:** `CustomAutoTask` is a plain `Codable` struct persisted to `UserDefaults` as JSON (same shape as the existing `CustomProvider`), execution reuses the existing generic `AutoCodeUpdateService.runCLI(prompt:...)` pipeline that 5 of the 12 built-in tasks already use, `TaskLogStore` gains a parallel `String`-keyed API so custom tasks get the same live/persisted log pane, and `MobileControlManager` merges custom tasks into the same wire snapshot it already builds from `AutoTask.allCases` — the iPhone app needs zero changes since it already renders whatever task list the Mac sends.

**Tech Stack:** Swift 6 / SwiftUI (macOS app, `mac/` — Swift Package Manager, target `LlmIdeMacLib`), XCTest (`mac/Tests/LlmIdeMacTests/`).

**Verification note for this environment:** `swift build` is the practical source of truth here — this sandboxed dev environment's Command Line Tools lack XCTest, so `swift test` silently no-ops (produces no output, exits 0, runs nothing). Every task still includes real XCTest code (for CI and anyone running this from Xcode, where `swift test`/`⌘U` does execute), but the "run test" verification step in this environment is `swift build` (confirms the test file compiles and links) — call this out at the point it matters rather than re-explaining it in every task.

---

## Prerequisite (already done)

Commit `aa31d7a` moved `AutoTaskSettings.swift` → `Models/AutoCode/`, `AutoCodeUpdateService.swift` + `TaskLogStore.swift` → `Services/AutoCode/`, and extracted `enum AutoTask` out of `AutoCodeView.swift` into `Models/AutoCode/AutoTask.swift`. This plan's new files land in those same three `AutoCode/` subfolders.

---

### Task 1: `CustomAutoTask` model

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/AutoCode/CustomAutoTask.swift`
- Test: `mac/Tests/LlmIdeMacTests/CustomAutoTaskTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

/// CustomAutoTask persistence — mirrors CustomProvider's shape (Codable
/// struct, UserDefaults-JSON list), with an injectable UserDefaults so
/// tests use a throwaway suite instead of touching the app's real defaults
/// (CustomProvider itself hardcodes .standard; this is a small, deliberate
/// improvement, not an unexplained deviation).
final class CustomAutoTaskTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "custom-auto-task-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLoadAllIsEmptyByDefault() {
        XCTAssertEqual(CustomAutoTask.loadAll(from: suite), [])
    }

    func testSaveThenLoadAllRoundTrips() {
        let task = CustomAutoTask(name: "Nightly Cleanup", template: "Clean up stray branches.")
        task.save(in: suite)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.id, task.id)
        XCTAssertEqual(loaded.first?.name, "Nightly Cleanup")
        XCTAssertEqual(loaded.first?.template, "Clean up stray branches.")
        XCTAssertTrue(loaded.first?.isEnabled ?? false)
    }

    func testSaveTwiceUpsertsByIdInsteadOfDuplicating() {
        var task = CustomAutoTask(name: "Original", template: "prompt A")
        task.save(in: suite)

        task.name = "Renamed"
        task.template = "prompt B"
        task.save(in: suite)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.name, "Renamed")
        XCTAssertEqual(loaded.first?.template, "prompt B")
    }

    func testDeleteRemovesOnlyThatTask() {
        let a = CustomAutoTask(name: "A", template: "prompt A")
        let b = CustomAutoTask(name: "B", template: "prompt B")
        a.save(in: suite)
        b.save(in: suite)

        a.delete(from: suite)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.id, b.id)
    }

    func testToggleIsEnabledPersists() {
        var task = CustomAutoTask(name: "Toggle Me", template: "prompt")
        task.save(in: suite)

        task.isEnabled = false
        task.save(in: suite)

        XCTAssertEqual(CustomAutoTask.loadAll(from: suite).first?.isEnabled, false)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: FAIL — `error: cannot find type 'CustomAutoTask' in scope` (the model doesn't exist yet; in this environment `swift build` failing to compile the test target is the "test fails" signal, since `swift test` doesn't execute — see the Verification note above).

- [ ] **Step 3: Write the model**

```swift
import Foundation

/// User-created Auto Task: a name + a prompt template, run through the same
/// generic CLI pipeline the 5 built-in template tasks (Review Code, Review
/// Doc, Review Conflicts, Generate Documentation, Update Issues) already
/// use. Unlike `AutoTask` (a closed, compiled enum with exactly 12 cases),
/// this is an open, user-extensible, runtime-created task — persisted the
/// same way `CustomProvider` persists named custom AI providers.
struct CustomAutoTask: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    /// The prompt run via `AutoCodeUpdateService.runCLI(prompt:...)` — same
    /// role as `AppConfig.autoTaskTemplateReviewCode` etc.
    var template: String
    var isEnabled: Bool = true
    var createdAt: Date = Date()

    init(id: String = UUID().uuidString, name: String, template: String,
         isEnabled: Bool = true, createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.template = template
        self.isEnabled = isEnabled
        self.createdAt = createdAt
    }
}

// MARK: - Persistence

extension CustomAutoTask {
    static let defaultsKey = "customAutoTasks"

    static func loadAll(from defaults: UserDefaults = .standard) -> [CustomAutoTask] {
        guard let data = defaults.data(forKey: defaultsKey) else { return [] }
        do {
            return try JSONDecoder().decode([CustomAutoTask].self, from: data)
        } catch {
            return []
        }
    }

    static func saveAll(_ tasks: [CustomAutoTask], to defaults: UserDefaults = .standard) {
        do {
            let data = try JSONEncoder().encode(tasks)
            defaults.set(data, forKey: defaultsKey)
        } catch {
            // Silent fail — validation happens in the UI (non-empty name/template).
        }
    }

    func save(in defaults: UserDefaults = .standard) {
        var all = CustomAutoTask.loadAll(from: defaults)
        if let idx = all.firstIndex(where: { $0.id == id }) {
            all[idx] = self
        } else {
            all.append(self)
        }
        CustomAutoTask.saveAll(all, to: defaults)
    }

    func delete(from defaults: UserDefaults = .standard) {
        var all = CustomAutoTask.loadAll(from: defaults)
        all.removeAll { $0.id == id }
        CustomAutoTask.saveAll(all, to: defaults)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!` (compiles clean; if you have full Xcode available, `swift test --filter CustomAutoTaskTests` should show 5/5 passing).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/AutoCode/CustomAutoTask.swift mac/Tests/LlmIdeMacTests/CustomAutoTaskTests.swift
git commit -m "feat(mac): add CustomAutoTask model with UserDefaults persistence"
```

---

### Task 2: Generalize `TaskLogStore` to a parallel `String`-keyed API

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/TaskLogStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift` (new)

The internal storage is already `[String: [LogLine]]` keyed by `task.rawValue` — this task adds `String`-typed overloads that operate on that storage directly, and makes the existing `AutoTask`-typed methods thin wrappers. All 55 existing call sites (which pass `AutoTask` literals like `.reviewCode`) are unaffected.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class TaskLogStoreTests: XCTestCase {
    func testStringAppendAndLinesRoundTrip() {
        let store = TaskLogStore()
        store.append("custom-123", "hello")
        let lines = store.lines(for: "custom-123")
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines.first?.text, "hello")
        XCTAssertEqual(lines.first?.level, .info)
    }

    func testStringClearEmptiesOnlyThatId() {
        let store = TaskLogStore()
        store.append("custom-a", "line a")
        store.append("custom-b", "line b")

        store.clear("custom-a")

        XCTAssertEqual(store.lines(for: "custom-a").count, 0)
        XCTAssertEqual(store.lines(for: "custom-b").count, 1)
    }

    func testAutoTaskAndItsRawValueShareTheSameBuffer() {
        let store = TaskLogStore()
        store.append(.reviewCode, "via enum")
        store.append("reviewCode", "via string")

        let viaEnum = store.lines(for: AutoTask.reviewCode)
        let viaString = store.lines(for: "reviewCode")
        XCTAssertEqual(viaEnum.count, 2)
        XCTAssertEqual(viaString.count, 2)
        XCTAssertEqual(viaEnum.map(\.text), viaString.map(\.text))
    }

    func testEmptyOrWhitespaceOnlyTextIsIgnored() {
        let store = TaskLogStore()
        store.append("custom-x", "   \n  ")
        XCTAssertEqual(store.lines(for: "custom-x").count, 0)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: FAIL — `store.append("custom-123", "hello")` doesn't match the existing overload (`append(_ task: AutoTask, ...)` requires an `AutoTask`, not a `String`). Expected error: `error: cannot convert value of type 'String' to expected argument type 'AutoTask'`.

- [ ] **Step 3: Add the `String`-keyed overloads**

Replace the four methods in `TaskLogStore` (lines 25-46 of the current file) with:

```swift
    func append(_ id: String, _ text: String, level: Level = .info) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var lines = buffers[id] ?? []
        lines.append(LogLine(id: UUID(), timestamp: Date(), level: level, text: trimmed))
        if lines.count > Self.maxLinesPerTask {
            lines.removeFirst(lines.count - Self.maxLinesPerTask)
        }
        buffers[id] = lines
    }

    func append(_ task: AutoTask, _ text: String, level: Level = .info) {
        append(task.rawValue, text, level: level)
    }

    func clear(_ id: String) {
        buffers[id] = []
    }

    func clear(_ task: AutoTask) {
        clear(task.rawValue)
    }

    func clearAll() {
        buffers = [:]
    }

    func lines(for id: String) -> [LogLine] {
        buffers[id] ?? []
    }

    func lines(for task: AutoTask) -> [LogLine] {
        lines(for: task.rawValue)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCode/TaskLogStore.swift mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift
git commit -m "feat(mac): add String-keyed TaskLogStore overloads for custom tasks"
```

---

### Task 3: `AutoCodeUpdateService.runCustomTask` + `runSingleCustom`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift`
- Test: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCustomTaskTests.swift` (new)

`runCLI(prompt:localPath:logSuffix:logDir:task:)`'s ONLY use of its `task: AutoTask` parameter is two `store.append(task, captured)` calls inside its stdout/stderr streaming handler (lines ~1465, ~1474) — everything else in that function already uses the separate `logSuffix: String` parameter. Rename that parameter to `logStoreId: String` (existing callers pass `task.rawValue` instead of `task`), then add `runCustomTask`/`runSingleCustom` alongside `runOne`/`runSingle`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoCodeUpdateServiceCustomTaskTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "svc-custom-task-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    /// No projectStore wired -> resolveBackendAndProject() returns nil ->
    /// runCustomTask must guard out early with a task-specific error,
    /// exactly like runOne(_:) does for a built-in task with no linked repo.
    /// This mirrors AutoCodeUpdateServiceCronTests.makeService()'s minimal
    /// construction style (scheduling/guard tests, not full CLI execution).
    private func makeService() -> AutoCodeUpdateService {
        let settings = AutoTaskSettings(defaults: suite)
        let registry = ProcessedActionsRegistry(
            storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json"))
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: settings,
            registry: registry,
            logStore: TaskLogStore())
    }

    func testRunCustomTaskWithNoLinkedRepoSetsTaskErrorAndDoesNotCrash() async {
        let svc = makeService()
        let task = CustomAutoTask(name: "No Repo Task", template: "do something")

        await svc.runCustomTask(task)

        XCTAssertFalse(svc.isRunning)
        XCTAssertNil(svc.currentCustomTaskId)
        XCTAssertEqual(svc.statusMessage, "No linked repo")
        XCTAssertNotNil(svc.taskErrors[task.id])
    }

    func testRunSingleCustomReturnsFalseWhileAlreadyRunning() {
        let svc = makeService()
        let task = CustomAutoTask(name: "Task", template: "prompt")

        // runSingle/runSingleCustom share the same runTask re-entrancy guard.
        XCTAssertTrue(svc.runSingle(.reviewCode))
        XCTAssertFalse(svc.runSingleCustom(task))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: FAIL — `error: value of type 'AutoCodeUpdateService' has no member 'runCustomTask'` (and `runSingleCustom`, `currentCustomTaskId`).

- [ ] **Step 3: Add `currentCustomTaskId` next to the existing `currentTask`**

In `AutoCodeUpdateService`, find (around line 28):

```swift
    @Published private(set) var currentTask: AutoTask? = nil
```

Add immediately after it:

```swift
    /// Parallel to `currentTask` for the open, user-created task set —
    /// `AutoTask` is a closed enum and can't represent a custom task's id.
    /// At most one of `currentTask`/`currentCustomTaskId` is non-nil at a time.
    @Published private(set) var currentCustomTaskId: String? = nil
```

- [ ] **Step 4: Rename `runCLI`'s `task:` parameter to `logStoreId:` and update its two call sites**

In `runCLI` (around line 1376-1377), change:

```swift
    private func runCLI(prompt: String, localPath: String, logSuffix: String, logDir: URL,
                        task: AutoTask) async -> Bool {
```

to:

```swift
    private func runCLI(prompt: String, localPath: String, logSuffix: String, logDir: URL,
                        logStoreId: String) async -> Bool {
```

Then inside the same function, change both streaming-handler call sites (around lines 1465 and 1474):

```swift
                    Task { @MainActor in store.append(task, captured) }
```

to (both occurrences):

```swift
                    Task { @MainActor in store.append(logStoreId, captured) }
```

Then update the 5 existing callers inside `runTaskBody`'s switch (the `reviewCode`/`reviewDoc`/`reviewConflicts`/`generateDoc`/`updateIssues` cases, around lines 289-316) — each currently ends its `runCLI(...)` call with `task: task)`; change each to `logStoreId: task.rawValue)`. For example, the `reviewCode` case:

```swift
            case .reviewCode:
                currentStep = "Running Review Code"
                let ok = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                      localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                      logDir: logDir, logStoreId: task.rawValue)
                finishPromptTask(task, ok: ok)
```

(Apply the same `task: task)` → `logStoreId: task.rawValue)` edit to the other 4 cases — `reviewDoc`, `reviewConflicts`, `generateDoc`, `updateIssues` — leaving everything else in each case unchanged.)

- [ ] **Step 5: Add `runCustomTask` and `runSingleCustom`**

Immediately after `runSingle(_:)` (after line 185, before the `// MARK: - Cron-driven scheduling` comment), add:

```swift
    /// Custom-task counterpart to `runSingle(_:)` — shares the same
    /// `runTask` re-entrancy guard, so a built-in run and a custom run
    /// can't overlap either.
    @discardableResult
    func runSingleCustom(_ task: CustomAutoTask) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.runCustomTask(task)
            self?.runTask = nil
        }
        return true
    }

    /// Custom-task counterpart to `runOne(_:)` — the same resolve/guard/
    /// runCLI pipeline the 5 built-in prompt tasks use (reviewCode etc. in
    /// `runTaskBody`), generalized to take an arbitrary `CustomAutoTask`
    /// instead of switching on a fixed `AutoTask` case. Every custom task
    /// requires a linked repo (there is no source-ingest-only custom task,
    /// unlike the built-in `sourceUpdate`).
    func runCustomTask(_ task: CustomAutoTask) async {
        guard !isRunning else { return }
        isRunning = true
        currentCustomTaskId = task.id
        defer {
            isRunning = false
            currentCustomTaskId = nil
            currentStep = nil
            lastRunDate = Date()
        }
        guard let logDir = logsDirectory() else {
            statusMessage = "Logs directory unavailable"
            return
        }
        guard let resolved = resolveBackendAndProject() else {
            let reason = lastResolveDiagnosis ?? "No linked repo — configure in GitLab or GitHub settings"
            statusMessage = "No linked repo"
            logStore.append(task.id, "⚠ \(reason)", level: .error)
            taskErrors[task.id] = reason
            return
        }
        currentStep = "Running \(task.name)"
        logStore.append(task.id, "Running \(task.name)…")
        let ok = await runCLI(prompt: task.template, localPath: resolved.gitRoot,
                              logSuffix: task.id, logDir: logDir, logStoreId: task.id)
        if ok {
            taskErrors.removeValue(forKey: task.id)
            logStore.append(task.id, "— run finished —")
        } else {
            taskErrors[task.id] = "\(task.name) task failed. Check ~/Library/Logs/\(AppIdentity.logsDirName)/auto-task-\(task.id).log"
            logStore.append(task.id, "— run failed —", level: .error)
        }
        statusMessage = "\(task.name) — done"
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd mac && swift build 2>&1 | tail -30`
Expected: `Build complete!`

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCustomTaskTests.swift
git commit -m "feat(mac): add AutoCodeUpdateService.runCustomTask via the shared runCLI pipeline"
```

---

### Task 4: `AddCustomAutoTaskSheet` view

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/AutoCode/AddCustomAutoTaskSheet.swift`

Styled like `mac/Sources/LlmIdeMac/Views/Explorer/FileNamePromptSheet.swift` (a small, focused sheet the parent presents via `.sheet(item:)`), but with a name field AND a multi-line prompt editor.

- [ ] **Step 1: Write the view**

```swift
import SwiftUI

/// "Add Task" sheet for the Auto Tasks page — name + prompt template.
/// Styled like FileNamePromptSheet (Explorer's create/rename sheet): the
/// parent owns error display via the `onConfirm` closure's throw-free
/// contract here (validation is inline, Save is disabled until valid).
struct AddCustomAutoTaskSheet: View {
    let onConfirm: (String, String) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @State private var template: String = ""

    private var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("New Custom Task").font(Typography.title)

            Text("Name").font(Typography.caption).foregroundStyle(.secondary)
            TextField("e.g. \"Nightly Cleanup\"", text: $name)
                .textFieldStyle(.roundedBorder)

            Text("Prompt").font(Typography.caption).foregroundStyle(.secondary)
            TextEditor(text: $template)
                .font(Typography.mono)
                .frame(minHeight: 160)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1))
                .cornerRadius(6)

            HStack {
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Create") { onConfirm(name, template) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
            }
        }
        .padding(Spacing.md)
        .frame(width: 420)
    }
}
```

- [ ] **Step 2: Run to verify it compiles**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AutoCode/AddCustomAutoTaskSheet.swift
git commit -m "feat(mac): add AddCustomAutoTaskSheet for creating custom Auto Tasks"
```

---

### Task 5: Wire the sheet + Custom task list + detail pane into `AutoCodeView`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

- [ ] **Step 1: Add state for custom tasks, the sheet, and the selected custom task**

In the state block near the top of `AutoCodeView` (after line 21, `@State private var editPreview: EditPreviewMode = .edit`), add:

```swift
    @State private var customTasks: [CustomAutoTask] = []
    @State private var showingAddCustomTask = false
    @State private var selectedCustomTask: CustomAutoTask? = nil
    @State private var customTaskPendingDelete: CustomAutoTask? = nil
    @Environment(MobileControlManager.self) private var mobileControl
```

- [ ] **Step 2: Load custom tasks on appear and keep `selectedCustomTask` in sync with runs**

In `body` (the `HStack { leftPane ... rightPane ... }` block, right after the existing `.onChange(of: autoCode.currentTask) { ... }` at line 34-42), add:

```swift
        .onAppear { customTasks = CustomAutoTask.loadAll() }
        .onChange(of: autoCode.currentCustomTaskId) { _, newId in
            // Mirrors the built-in onChange above: during a custom task's
            // run, jump the right pane to follow it.
            if let newId, let task = customTasks.first(where: { $0.id == newId }) {
                selectedCustomTask = task
                selectedTask = nil
                showModelLimits = false
            }
        }
```

- [ ] **Step 3: Add a small helper that persists + reloads + pushes to mobile, used by every mutation**

Add this private method near the other behavior helpers (right after `taskEnabledBinding(_:)`, around line 248):

```swift
    /// Every custom-task mutation (add/toggle/delete) goes through here:
    /// persist, reload the in-memory list so the UI reflects it immediately,
    /// then push the change to a paired iPhone. Built-in tasks push
    /// automatically via Combine observers on autoCode/autoTaskSettings;
    /// CustomAutoTask is a plain struct with no such observation, so this
    /// explicit push is the real mechanism for it (the "Refresh" button
    /// calls the same underlying method for a manual, visible re-sync).
    private func persistCustomTasksChange() {
        customTasks = CustomAutoTask.loadAll()
        mobileControl.refreshAutoTaskStateForMobile()
    }
```

- [ ] **Step 4: Add the "Add Task" and "Refresh" buttons to the left-pane header**

In `leftPane`, change the enable-toggle header block (lines 49-68) from:

```swift
            HStack {
                // Bound to the shared AutoTaskSettings (single source of truth)
                // so this stays live with the Menu bar + Settings. Arming the
                // scheduler is the service's job — it observes `enabled`.
                Toggle("", isOn: $autoTaskSettings.enabled)
                .toggleStyle(.switch)
                .labelsHidden()

                Text(autoTaskSettings.enabled ? "Enabled" : "Disabled")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(autoTaskSettings.enabled
                        ? theme.current.accent : theme.current.textMuted)

                Spacer()

                if autoCode.isRunning {
                    ProgressView().controlSize(.mini)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.current.surface)
```

to:

```swift
            HStack {
                // Bound to the shared AutoTaskSettings (single source of truth)
                // so this stays live with the Menu bar + Settings. Arming the
                // scheduler is the service's job — it observes `enabled`.
                Toggle("", isOn: $autoTaskSettings.enabled)
                .toggleStyle(.switch)
                .labelsHidden()

                Text(autoTaskSettings.enabled ? "Enabled" : "Disabled")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(autoTaskSettings.enabled
                        ? theme.current.accent : theme.current.textMuted)

                Spacer()

                if autoCode.isRunning {
                    ProgressView().controlSize(.mini)
                }

                Button { showingAddCustomTask = true } label: {
                    Image(systemName: "plus.circle")
                }
                .buttonStyle(.borderless)
                .help("Add Custom Task")

                Button { mobileControl.refreshAutoTaskStateForMobile() } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.borderless)
                .help("Push current state to a paired iPhone now")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.current.surface)
```

- [ ] **Step 5: Render a "Custom" category after the 4 built-in ones**

In `leftPane`'s task-list block, change:

```swift
                } else {
                    ForEach(Self.taskGroups) { group in
                        let visible = group.tasks.filter { isTaskVisible($0) }
                        if !visible.isEmpty {
                            taskCategoryHeader(group.title)
                            ForEach(visible, id: \.self) { task in
                                taskRow(task, label: task.label, icon: task.icon,
                                        enabled: taskEnabledBinding(task))
                            }
                        }
                    }
                }
```

to:

```swift
                } else {
                    ForEach(Self.taskGroups) { group in
                        let visible = group.tasks.filter { isTaskVisible($0) }
                        if !visible.isEmpty {
                            taskCategoryHeader(group.title)
                            ForEach(visible, id: \.self) { task in
                                taskRow(task, label: task.label, icon: task.icon,
                                        enabled: taskEnabledBinding(task))
                            }
                        }
                    }
                    let visibleCustom = customTasks.filter { !autoTaskSettings.showOnlyEnabledTasks || $0.isEnabled }
                    if !visibleCustom.isEmpty {
                        taskCategoryHeader("Custom Tasks")
                        ForEach(visibleCustom) { task in
                            customTaskRow(task)
                        }
                    }
                }
```

- [ ] **Step 6: Add `customTaskRow`, right after the existing `taskRow(_:label:icon:enabled:)` (after line 278)**

```swift
    @ViewBuilder
    private func customTaskRow(_ task: CustomAutoTask) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(
                get: { task.isEnabled },
                set: { newValue in
                    var updated = task
                    updated.isEnabled = newValue
                    updated.save()
                    persistCustomTasksChange()
                }
            ))
            .toggleStyle(.checkbox)
            .labelsHidden()

            Label(task.name, systemImage: "sparkles")
                .font(Typography.body)
                .foregroundStyle(task.isEnabled ? theme.current.text : theme.current.textMuted)

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selectedCustomTask?.id == task.id
            ? theme.current.accent.opacity(0.12)
            : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { selectedCustomTask = task; selectedTask = nil; showModelLimits = false }
        .overlay(alignment: .leading) {
            if selectedCustomTask?.id == task.id {
                Rectangle().fill(theme.current.accent).frame(width: 3)
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive) { customTaskPendingDelete = task }
        }
    }
```

- [ ] **Step 7: Route the right pane to a custom-task detail view, and add the sheet + delete confirmation**

Change `rightPane` (lines 331-350) from:

```swift
    private var rightPane: some View {
        Group {
            if showModelLimits {
                ModelLimitsPanel(api: api)
            } else if let task = selectedTask {
                templateEditor(task)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.2.circlepath.circle")
                        .font(.system(size: 36))
                        .foregroundStyle(theme.current.textMuted)
                    Text("Select a review task from the left to edit its AI prompt.")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.current.body)
            }
        }
    }
```

to:

```swift
    private var rightPane: some View {
        Group {
            if showModelLimits {
                ModelLimitsPanel(api: api)
            } else if let task = selectedTask {
                templateEditor(task)
            } else if let custom = selectedCustomTask {
                customTaskEditor(custom)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.2.circlepath.circle")
                        .font(.system(size: 36))
                        .foregroundStyle(theme.current.textMuted)
                    Text("Select a review task from the left to edit its AI prompt.")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.current.body)
            }
        }
        .sheet(isPresented: $showingAddCustomTask) {
            AddCustomAutoTaskSheet(
                onConfirm: { name, template in
                    let task = CustomAutoTask(name: name, template: template)
                    task.save()
                    persistCustomTasksChange()
                    selectedCustomTask = task
                    selectedTask = nil
                    showModelLimits = false
                    showingAddCustomTask = false
                },
                onCancel: { showingAddCustomTask = false }
            )
        }
        .confirmationDialog(
            customTaskPendingDelete.map { "Delete \"\($0.name)\"?" } ?? "",
            isPresented: Binding(
                get: { customTaskPendingDelete != nil },
                set: { if !$0 { customTaskPendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let task = customTaskPendingDelete {
                    task.delete()
                    persistCustomTasksChange()
                    if selectedCustomTask?.id == task.id { selectedCustomTask = nil }
                }
                customTaskPendingDelete = nil
            }
            Button("Cancel", role: .cancel) { customTaskPendingDelete = nil }
        }
    }
```

- [ ] **Step 8: Add `customTaskEditor`, right after `templateEditor(_:)`'s closing brace (after line 458)**

```swift
    @ViewBuilder
    private func customTaskEditor(_ task: CustomAutoTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
                Text(task.name)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Button { _ = autoCode.runSingleCustom(task) } label: {
                    Label(autoCode.currentCustomTaskId == task.id
                          ? (autoCode.currentStep ?? "Running…")
                          : "Run",
                          systemImage: autoCode.currentCustomTaskId == task.id ? "ellipsis.circle" : "play.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(autoCode.isRunning)
                Button("Delete", role: .destructive) { customTaskPendingDelete = task }
                    .buttonStyle(.borderless)
                    .font(Typography.caption)
                    .disabled(autoCode.currentCustomTaskId == task.id)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(theme.current.surface)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Edit template")
                        .font(Typography.section)
                        .foregroundStyle(theme.current.textMuted)
                    TextEditor(text: Binding(
                        get: { task.template },
                        set: { newValue in
                            var updated = task
                            updated.template = newValue
                            updated.save()
                            customTasks = CustomAutoTask.loadAll()
                            if selectedCustomTask?.id == task.id { selectedCustomTask = updated }
                        }
                    ))
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.text)
                    .scrollContentBackground(.hidden)
                    .background(theme.current.surface)
                    .frame(minHeight: 180)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                    .cornerRadius(6)
                }
                .padding(20)
            }

            if let error = autoCode.taskErrors[task.id] {
                StatusBanner(severity: .error, message: error, onDismiss: { autoCode.dismissTaskError(forId: task.id) })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            customTaskLogSection(task.id)

            if let last = autoCode.lastRunDate {
                Divider()
                Text("Last run \(last, style: .relative) ago · \(autoCode.statusMessage)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(theme.current.surface)
            }
        }
        .background(theme.current.body)
    }

    /// Live, scrollable log for a custom task — same layout as `logSection`
    /// but keyed by the task's string id via the TaskLogStore string overload.
    @ViewBuilder
    private func customTaskLogSection(_ id: String) -> some View {
        let lines = logStore.lines(for: id)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Log · live")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
                Button { logStore.clear(id) } label: {
                    Label("Clear", systemImage: "trash")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.current.textMuted)
                .font(Typography.caption)
                .disabled(lines.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(line.timestamp, format: .dateTime.hour().minute().second())
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.textMuted)
                            Text(line.text)
                                .font(Typography.mono)
                                .foregroundStyle(line.level == .error ? theme.current.danger : theme.current.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 8)
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 320)
            .background(theme.current.surface)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
            .cornerRadius(6)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }
```

- [ ] **Step 9: Add `dismissTaskError(forId:)` to `AutoCodeUpdateService`**

`customTaskEditor` above calls `autoCode.dismissTaskError(forId: task.id)`. The existing `AutoTask`-typed method (around line 366) is:

```swift
    func dismissTaskError(for task: AutoTask) {
        taskErrors.removeValue(forKey: task.rawValue)
    }
```

Add a `String`-keyed sibling directly after it:

```swift
    func dismissTaskError(forId id: String) {
        taskErrors.removeValue(forKey: id)
    }
```

- [ ] **Step 10: Build**

Run: `cd mac && swift build 2>&1 | tail -40`
Expected: `Build complete!` — if there are errors, they are almost certainly one of: (a) `dismissTaskError(forId:)` not yet added (Step 9), (b) a typo in one of the pasted blocks — fix and re-run.

- [ ] **Step 11: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift
git commit -m "feat(mac): wire Add/Refresh buttons and custom task list+detail into AutoCodeView"
```

---

### Task 6: Mobile wire protocol — custom tasks visible + runnable from iPhone

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift`

- [ ] **Step 1: Add the public "push now" method the Refresh button and AutoCodeView both call**

Right after `private func pushAutoTaskStateIfPaired() { ... }` (around line 848-851), add:

```swift
    /// Explicit "push now" for the Auto Tasks page's Refresh button, and for
    /// every custom-task mutation (add/toggle/delete/run) — CustomAutoTask is
    /// a plain struct, not independently Combine-observed like autoCode/
    /// autoTaskSettings, so this is the actual sync mechanism for it. Built-in
    /// tasks already auto-push via installMobilePushObservers(); this just
    /// gives an explicit, visible "synced now" affordance on top of that.
    func refreshAutoTaskStateForMobile() {
        pushAutoTaskStateIfPaired()
    }
```

- [ ] **Step 2: Include custom tasks in `buildAutoTaskState()`**

Change (around lines 749-769):

```swift
    private func buildAutoTaskState() -> AutoTaskState? {
        guard let ac = autoCode, let s = autoTaskSettings else { return nil }
        let allInfos = AutoTask.allCases.map { t in
            AutoTaskInfo(id: t.rawValue, label: t.label,
                         enabled: s.isEnabled(task: t),
                         lastError: ac.taskErrors[t.rawValue])
        }
        // Mirror the Mac "Show only enabled" filter: when on, the phone sees
        // only the active task set (re-enabling a hidden task is done on Mac).
        let infos = s.showOnlyEnabledTasks ? allInfos.filter { $0.enabled } : allInfos
        return AutoTaskState(masterEnabled: s.enabled,
                             isRunning: ac.isRunning || ac.hasScheduledRun,
                             currentTask: ac.currentTask?.rawValue,
                             currentStep: ac.currentStep,
                             statusMessage: ac.statusMessage,
                             lastRunDate: ac.lastRunDate?.timeIntervalSince1970,
                             createdCount: ac.createdCount,
                             implementedCount: ac.implementedCount,
                             failedCount: ac.failedCount,
                             tasks: infos)
    }
```

to:

```swift
    private func buildAutoTaskState() -> AutoTaskState? {
        guard let ac = autoCode, let s = autoTaskSettings else { return nil }
        let allInfos = AutoTask.allCases.map { t in
            AutoTaskInfo(id: t.rawValue, label: t.label,
                         enabled: s.isEnabled(task: t),
                         lastError: ac.taskErrors[t.rawValue])
        }
        let customInfos = CustomAutoTask.loadAll().map { t in
            AutoTaskInfo(id: t.id, label: t.name, enabled: t.isEnabled,
                         lastError: ac.taskErrors[t.id])
        }
        // Mirror the Mac "Show only enabled" filter: when on, the phone sees
        // only the active task set (re-enabling a hidden task is done on Mac).
        // Custom tasks participate identically to built-ins.
        let combined = allInfos + customInfos
        let infos = s.showOnlyEnabledTasks ? combined.filter { $0.enabled } : combined
        return AutoTaskState(masterEnabled: s.enabled,
                             isRunning: ac.isRunning || ac.hasScheduledRun,
                             currentTask: ac.currentTask?.rawValue ?? ac.currentCustomTaskId,
                             currentStep: ac.currentStep,
                             statusMessage: ac.statusMessage,
                             lastRunDate: ac.lastRunDate?.timeIntervalSince1970,
                             createdCount: ac.createdCount,
                             implementedCount: ac.implementedCount,
                             failedCount: ac.failedCount,
                             tasks: infos)
    }
```

- [ ] **Step 3: Handle toggling a custom task from the phone**

Change the `MobileProtocol.Tag.autoTaskToggle` case (around lines 464-483) from:

```swift
        case MobileProtocol.Tag.autoTaskToggle:
            // Flip the master enable (task == nil) or a single per-task flag.
            // Routes through AutoTaskSettings.setEnabled / .enabled so the
            // @Published didSet persists + arms/disarms the scheduler exactly
            // as the on-Mac Settings toggle would.
            if let m = try? decoder.decode(AutoTaskToggle.self, from: data) {
                if let taskName = m.task, let t = AutoTask(rawValue: taskName) {
                    autoTaskSettings?.setEnabled(m.enabled, task: t)
                    append(.info, "Auto-task toggle \(t.rawValue)=\(m.enabled)")
                } else {
                    autoTaskSettings?.enabled = m.enabled
                    append(.info, "Auto-task master=\(m.enabled)")
                }
                replyAutoTaskStateOrAck()
            } else {
                let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
                append(.stderr, "auto_task_toggle decode failed: \(preview)")
                reply(CommandError(commandId: "auto_task_toggle",
                                   message: "Invalid auto-task toggle request from phone."))
            }
```

to:

```swift
        case MobileProtocol.Tag.autoTaskToggle:
            // Flip the master enable (task == nil), a built-in per-task flag,
            // or (new) a custom task's isEnabled. Routes through
            // AutoTaskSettings.setEnabled / .enabled for built-ins so the
            // @Published didSet persists + arms/disarms the scheduler exactly
            // as the on-Mac Settings toggle would; custom tasks persist via
            // CustomAutoTask.save() directly (they have no AutoTaskSettings
            // entry — enabled-state lives on the struct itself).
            if let m = try? decoder.decode(AutoTaskToggle.self, from: data) {
                if let taskName = m.task, let t = AutoTask(rawValue: taskName) {
                    autoTaskSettings?.setEnabled(m.enabled, task: t)
                    append(.info, "Auto-task toggle \(t.rawValue)=\(m.enabled)")
                } else if let taskName = m.task,
                          var custom = CustomAutoTask.loadAll().first(where: { $0.id == taskName }) {
                    custom.isEnabled = m.enabled
                    custom.save()
                    append(.info, "Custom auto-task toggle \(custom.name)=\(m.enabled)")
                } else if m.task == nil {
                    autoTaskSettings?.enabled = m.enabled
                    append(.info, "Auto-task master=\(m.enabled)")
                } else {
                    append(.stderr, "auto_task_toggle: unknown task id \(m.task ?? "?")")
                }
                replyAutoTaskStateOrAck()
            } else {
                let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
                append(.stderr, "auto_task_toggle decode failed: \(preview)")
                reply(CommandError(commandId: "auto_task_toggle",
                                   message: "Invalid auto-task toggle request from phone."))
            }
```

- [ ] **Step 4: Handle running a custom task from the phone**

Change the `MobileProtocol.Tag.autoTaskRun` case (around lines 484-518) from:

```swift
            if let m = try? decoder.decode(AutoTaskRun.self, from: data) {
                let started: Bool
                if let raw = m.task, let t = AutoTask(rawValue: raw) {
                    started = ac.runSingle(t)
                    if started {
                        append(.info, "Auto-task run single: \(t.rawValue)")
                    }
                } else {
                    started = ac.runNow()
                    if started {
                        append(.info, "Auto-task run now")
                    }
                }
                if started {
                    replyAutoTaskStateOrAck()
                } else {
                    append(.info, "Auto-task run ignored — already running on Mac")
                    reply(AutoTaskAck(ok: false,
                                      message: "Auto Tasks is already running on your Mac. Tap Stop first."))
                }
            } else {
```

to:

```swift
            if let m = try? decoder.decode(AutoTaskRun.self, from: data) {
                // Four-way branch, mirroring the toggle handler above:
                // built-in task / custom task / no task = global run / an
                // unrecognized non-nil id (e.g. the phone still shows a
                // since-deleted custom task) — the last case must NOT fall
                // through to a global run-all, which would be a surprising
                // and wrong response to "run this one specific task".
                var started = false
                var unrecognized = false
                if let raw = m.task, let t = AutoTask(rawValue: raw) {
                    started = ac.runSingle(t)
                    if started {
                        append(.info, "Auto-task run single: \(t.rawValue)")
                    }
                } else if let raw = m.task,
                          let custom = CustomAutoTask.loadAll().first(where: { $0.id == raw }) {
                    started = ac.runSingleCustom(custom)
                    if started {
                        append(.info, "Custom auto-task run: \(custom.name)")
                    }
                } else if m.task == nil {
                    started = ac.runNow()
                    if started {
                        append(.info, "Auto-task run now")
                    }
                } else {
                    unrecognized = true
                    append(.stderr, "auto_task_run: unknown task id \(m.task ?? "?")")
                }
                if unrecognized {
                    reply(CommandError(commandId: "auto_task_run",
                                       message: "That task no longer exists on your Mac. Refresh the task list."))
                } else if started {
                    replyAutoTaskStateOrAck()
                } else {
                    append(.info, "Auto-task run ignored — already running on Mac")
                    reply(AutoTaskAck(ok: false,
                                      message: "Auto Tasks is already running on your Mac. Tap Stop first."))
                }
            } else {
```

- [ ] **Step 5: Include custom tasks' logs in `buildAutoTaskLogsReply()`**

Change (around lines 782-796):

```swift
    private func buildAutoTaskLogsReply() -> AutoTaskLogsReply? {
        guard let logStore else { return nil }
        let current = autoCode?.currentTask?.rawValue
        let tasks = AutoTask.allCases.map { task in
            let lines = logStore.lines(for: task).map { line in
                AutoTaskLogLine(id: line.id.uuidString,
                                timestamp: line.timestamp.timeIntervalSince1970,
                                level: line.level.rawValue,
                                text: line.text)
            }
            return AutoTaskTaskLogs(id: task.rawValue, label: task.label, lines: lines)
        }
        return AutoTaskLogsReply(currentTask: current, tasks: tasks)
    }
```

to:

```swift
    private func buildAutoTaskLogsReply() -> AutoTaskLogsReply? {
        guard let logStore else { return nil }
        let current = autoCode?.currentTask?.rawValue ?? autoCode?.currentCustomTaskId
        let builtIn = AutoTask.allCases.map { task in
            let lines = logStore.lines(for: task).map { line in
                AutoTaskLogLine(id: line.id.uuidString,
                                timestamp: line.timestamp.timeIntervalSince1970,
                                level: line.level.rawValue,
                                text: line.text)
            }
            return AutoTaskTaskLogs(id: task.rawValue, label: task.label, lines: lines)
        }
        let custom = CustomAutoTask.loadAll().map { task in
            let lines = logStore.lines(for: task.id).map { line in
                AutoTaskLogLine(id: line.id.uuidString,
                                timestamp: line.timestamp.timeIntervalSince1970,
                                level: line.level.rawValue,
                                text: line.text)
            }
            return AutoTaskTaskLogs(id: task.id, label: task.name, lines: lines)
        }
        return AutoTaskLogsReply(currentTask: current, tasks: builtIn + custom)
    }
```

- [ ] **Step 6: Build**

Run: `cd mac && swift build 2>&1 | tail -40`
Expected: `Build complete!`

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobileControlManager.swift
git commit -m "feat(mac): surface custom Auto Tasks over the mobile wire protocol"
```

---

### Task 7: Manual end-to-end verification (not scriptable from this environment)

**Files:** none — this is a verification checklist, run by a human with a physical iPhone paired to this Mac.

- [ ] **Step 1: Full regression build**

Run: `cd mac && swift build 2>&1 | tail -5`
Expected: `Build complete!`

- [ ] **Step 2: Rebuild the .app and relaunch**

Run: `cd mac && ./Scripts/build.sh 2>&1 | tail -10`
Expected: `[build] ok — /Users/<you>/llm-ide/mac/LlmIdeMac.app`

- [ ] **Step 3: On the Mac — create and run a custom task**

1. Open the app, go to the Auto Tasks page.
2. Click the new "+" (Add Custom Task) button in the left-pane header. Enter a name (e.g. "Say Hi") and a trivial prompt (e.g. "Print the current date and say hello."). Click Create.
3. Confirm the new task appears under a "Custom Tasks" category in the left pane, and its detail pane shows on the right (name, editable prompt, Run button, empty log).
4. Click Run. Confirm the log pane fills with live output and the button shows the running state, then "— run finished —" (or "— run failed —" with a reason, if no repo is linked — that's expected and matches built-in task behavior).

- [ ] **Step 4: On the iPhone — confirm visibility and control**

1. Pair the iPhone to this Mac (existing pairing flow, unchanged by this feature).
2. Open Auto Tasks on the iPhone. Confirm the custom task from Step 3 appears in the list (generic icon is expected — iOS falls back to one for unrecognized ids, per `AutoTaskView.swift`'s existing `taskIcon(_:)` `default:` case).
3. Toggle it off/on from the phone. Confirm the Mac's left-pane checkbox reflects the change (may take up to ~1s if relying on the phone's own next poll, or instantly if the Mac's Refresh button was tapped).
4. Tap Run on the phone. Confirm the Mac starts the run (progress indicator, log filling) and the phone's own run screen shows the log lines.

- [ ] **Step 5: Delete cleanup**

On the Mac, right-click (or swipe) the custom task and Delete. Confirm it disappears from both the Mac list and, after a Refresh tap or the phone's next request, the iPhone list.

- [ ] **Step 6: Final commit (if Steps 1-5 surfaced any fixes)**

If any manual-verification step required a code fix, commit it now with a message describing what broke and why — do not fold silent fixes into an earlier task's commit.
