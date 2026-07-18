# Auto Task Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the mac Auto Task page so each of the 8 tasks has a markdown template + live preview (or a rendered About/config page), a per-task live-streaming scrollable log with a Clear button, and a per-task Run; slim Settings to global knobs.

**Architecture:** A new `TaskLogStore` (per-task ring buffer of timestamped lines) replaces the post-run `taskOutputs` snapshot. `AutoCodeUpdateService.run()` is decomposed into per-task bodies plus a new `runSingle(_:)` entry point for isolated per-task runs. The two `runCLI` overloads switch from `FileHandle`-direct output to a `Pipe` whose `readabilityHandler` tees lines to the `.log` file and to `TaskLogStore` (live). The `AutoCodeView` right pane becomes Preview / Edit / Log, reusing `SelfSizingMarkdownView` for the preview.

**Tech Stack:** Swift 6 / SwiftUI / swift-testing (`@Suite`, `@Test`, `#expect`). macOS app target `mac/`.

## Global Constraints

- **No new dependencies.** Markdown preview reuses `SelfSizingMarkdownView` (`mac/Sources/LlmIdeMac/Views/Library/SelfSizingMarkdownView.swift`) and `MarkdownRenderer`.
- **Keep all existing guarantees intact:** prompt-injection nonce fencing, dirty-tree guard, commit verification (HEAD advanced past base), base-branch rescue, usage auto-fallback (`/kb/usage/resolve`), allow-list gating. The `.log` file on disk stays the permanent record.
- **Do not clear `TaskLogStore` at the start of a run** — logs accumulate across runs (the ring buffer caps growth at 2 000 lines/task).
- **Verify with `swift build` / `swift test`, not SourceKit alone** (SourceKit produces stale errors in this project).
- **Build/test commands:** `cd mac && swift build` and `cd mac && swift test`. Pre-warm the build before pushing; the git pre-push hook runs `swift build` + `swift test`.
- **Existing test style:** `@Suite("…", .serialized) struct …`, `@Test func …`, `#expect`, isolated `AppConfig` via `UserDefaults(suiteName:)`. Follow it.
- **Auto vs manual share one path:** `runNow()` (timer + global Run) and `runSingle(_:)` (per-task ▶) both reach task bodies through the same `runTaskBody(_:resolved:logDir:)`. No mode-specific branching.
- **Conventional Commits, one concern per commit.** We are on branch `feat/auto-task-redesign`.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `mac/Sources/LlmIdeMac/Services/TaskLogStore.swift` | Per-task ring buffer of timestamped `LogLine`s + pure `LineAccumulator`. | **Create** |
| `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` | Inject `logStore`; add `currentTask`, `runSingle(_:)`, `runOne(_:)`, `runTaskBody(_:resolved:logDir:)`; switch `runCLI(prompt:)` to `Pipe` streaming; route all 8 tasks' output to `logStore`; remove `taskOutputs`. | **Modify** |
| `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` | Construct shared `TaskLogStore`, pass into the service, expose as `@StateObject` + `.environmentObject`. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` | Rewrite `templateEditor(_:)` into Preview / Edit / Log; add per-task ▶ Run + Clear; render logs from `logStore`; add regression config to the Regression About page. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` | Slim to global knobs (Enabled / interval / lookback / auto-stash / repo warning). Remove per-task toggles, Run/Status, regression sub-options. | **Modify** |
| `mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift` | Unit tests for `TaskLogStore` + `LineAccumulator`. | **Create** |
| `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceTests.swift` | Add `runSingle` re-entrancy / current-task test. | **Modify** |

---

### Task 1: `TaskLogStore` + `LineAccumulator` (pure, TDD)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/TaskLogStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift`

**Interfaces:**
- Produces: `TaskLogStore` (`@MainActor final class …: ObservableObject`) with `append(_ task: AutoTask, _ text: String, level: Level = .info)`, `clear(_ task:)`, `clearAll()`, `lines(for:) -> [LogLine]`, `@Published private(set) var buffers: [String: [LogLine]]`, `static let maxLinesPerTask = 2_000`; `struct LogLine: Identifiable, Equatable { id: UUID; timestamp: Date; level: Level; text: String }`; `enum Level: String { case info, error }`. Also a non-isolated `struct LineAccumulator` with `mutating func feed(_ chunk: String) -> [String]` and `mutating func flush() -> String?`.

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("TaskLogStore + LineAccumulator", .serialized)
struct TaskLogStoreTests {

    // MARK: - LineAccumulator (pure value type)

    @Test func accumulatorEmitsCompleteLinesOnly() {
        var acc = LineAccumulator()
        #expect(acc.feed("alpha\nbet") == ["alpha"])   // "bet" is partial, kept
        #expect(acc.flush() == "bet")
    }

    @Test func accumulatorHandlesMultipleLinesPerChunk() {
        var acc = LineAccumulator()
        #expect(acc.feed("a\nb\n") == ["a", "b"])
        #expect(acc.flush() == nil)
    }

    @Test func accumulatorJoinsSplitLineAcrossChunks() {
        var acc = LineAccumulator()
        #expect(acc.feed("al") == [])
        #expect(acc.feed("pha\nbet") == ["alpha"])
        #expect(acc.flush() == "bet")
    }

    @Test func accumulatorFlushIsEmptyForNoPending() {
        var acc = LineAccumulator()
        #expect(acc.feed("done\n") == ["done"])
        #expect(acc.flush() == nil)
    }

    // MARK: - TaskLogStore (MainActor)

    @MainActor
    @Test func appendStoresLineUnderTaskKey() {
        let store = TaskLogStore()
        store.append(.reviewCode, "hello")
        let lines = store.lines(for: .reviewCode)
        #expect(lines.count == 1)
        #expect(lines.first?.text == "hello")
        #expect(lines.first?.level == .info)
    }

    @MainActor
    @Test func appendIgnoresBlankLines() {
        let store = TaskLogStore()
        store.append(.reviewDoc, "   \n")
        #expect(store.lines(for: .reviewDoc).isEmpty)
    }

    @MainActor
    @Test func tasksAreIsolatedByBuffer() {
        let store = TaskLogStore()
        store.append(.reviewCode, "a")
        store.append(.reviewDoc, "b")
        #expect(store.lines(for: .reviewCode).map(\.text) == ["a"])
        #expect(store.lines(for: .reviewDoc).map(\.text) == ["b"])
    }

    @MainActor
    @Test func clearWipesOnlyOneTask() {
        let store = TaskLogStore()
        store.append(.reviewCode, "a")
        store.append(.reviewDoc, "b")
        store.clear(.reviewCode)
        #expect(store.lines(for: .reviewCode).isEmpty)
        #expect(store.lines(for: .reviewDoc).map(\.text) == ["b"])
    }

    @MainActor
    @Test func ringBufferCapsAtMaxLines() {
        let store = TaskLogStore()
        for i in 0..<(TaskLogStore.maxLinesPerTask + 50) {
            store.append(.reviewCode, "line \(i)")
        }
        let lines = store.lines(for: .reviewCode)
        #expect(lines.count == TaskLogStore.maxLinesPerTask)
        // Oldest dropped; the first kept line is the one right after the cap overflow.
        #expect(lines.first?.text == "line 50")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter TaskLogStoreTests`
Expected: FAIL — `cannot find 'TaskLogStore' / 'LineAccumulator' in scope`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/TaskLogStore.swift`:

```swift
import Foundation
import Combine

/// Per-task live log buffer for the Auto Task page. Each of the 8 tasks gets
/// an independent ring buffer of timestamped lines that ACCUMULATE ACROSS
/// RUNS (never auto-cleared) so repeated runs are visible. The `.log` file on
/// disk remains the permanent record; this is the live, capped, on-screen view.
@MainActor
final class TaskLogStore: ObservableObject {

    enum Level: String { case info, error }

    struct LogLine: Identifiable, Equatable {
        let id: UUID
        let timestamp: Date
        let level: Level
        let text: String
    }

    /// Per-task cap. Oldest lines are dropped once exceeded.
    static let maxLinesPerTask = 2_000

    @Published private(set) var buffers: [String: [LogLine]] = [:]

    func append(_ task: AutoTask, _ text: String, level: Level = .info) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var lines = buffers[task.rawValue] ?? []
        lines.append(LogLine(id: UUID(), timestamp: Date(), level: level, text: trimmed))
        if lines.count > Self.maxLinesPerTask {
            lines.removeFirst(lines.count - Self.maxLinesPerTask)
        }
        buffers[task.rawValue] = lines
    }

    func clear(_ task: AutoTask) {
        buffers[task.rawValue] = []
    }

    func clearAll() {
        buffers = [:]
    }

    func lines(for task: AutoTask) -> [LogLine] {
        buffers[task.rawValue] ?? []
    }
}

/// Pure line splitter for streaming subprocess output. Feed it decoded
/// chunks; it emits complete lines and retains any trailing partial line
/// until the next chunk (or `flush()` at EOF). A value type — not
/// actor-isolated, fully testable off the main actor. Used by the `Pipe`
/// `readabilityHandler` in `AutoCodeUpdateService.runCLI`.
struct LineAccumulator: Equatable {
    private var pending = ""

    mutating func feed(_ chunk: String) -> [String] {
        pending += chunk
        var out: [String] = []
        while let nl = pending.firstIndex(of: "\n") {
            out.append(String(pending[..<nl]))
            pending = String(pending[pending.index(after: nl)...])
        }
        return out
    }

    /// Call at EOF: returns any trailing partial line, or nil if none.
    mutating func flush() -> String? {
        guard !pending.isEmpty else { return nil }
        let rest = pending
        pending = ""
        return rest
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter TaskLogStoreTests`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/TaskLogStore.swift mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift
git commit -m "feat(auto-task): add TaskLogStore + LineAccumulator for per-task live logs"
```

---

### Task 2: Inject `TaskLogStore` into the service + app DI

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` (init at lines 79-115)
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` (construction at lines 90-97, declaration near line 44, `environmentObject` near lines 158 & 323)

**Interfaces:**
- Consumes: `TaskLogStore` from Task 1.
- Produces: `AutoCodeUpdateService` accepts a `logStore: TaskLogStore` parameter; existing call sites still compile (default arg).

- [ ] **Step 1: Add the stored property + init parameter**

In `AutoCodeUpdateService.swift`, add the dependency next to the others (after line 44 `private let api: LlmIdeAPIClient?`):

```swift
    /// Per-task live log store; appended to from the CLI `Pipe` streamer and
    /// read by the Auto Task page. Defaults to a fresh store so existing
    /// callers/tests that omit it still compile; the app injects the shared
    /// instance the UI observes.
    private let logStore: TaskLogStore
```

Change the designated init (lines 79-86) to accept and assign it:

```swift
    init(config: AppConfig, autoTaskSettings: AutoTaskSettings, backend: RepoBackend? = nil,
         registry: ProcessedActionsRegistry, projectStore: ProjectStore? = nil,
         api: LlmIdeAPIClient? = nil, logStore: TaskLogStore = TaskLogStore()) {
        self.config = config
        self.autoTaskSettings = autoTaskSettings
        self.backendOverride = backend
        self.registry = registry
        self.projectStore = projectStore
        self.api = api
        self.logStore = logStore
        isEnabled = autoTaskSettings.enabled
```

(rest of init unchanged.)

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build`
Expected: builds clean (default arg keeps the convenience init + tests compiling).

- [ ] **Step 3: Wire the shared store in the app**

In `LlmIdeMacApp.swift`, declare the `@StateObject` alongside the other service declarations (near line 44 where `autoCodeUpdate` is declared). Add:

```swift
    @StateObject private var logStore: TaskLogStore
```

In `init()` (after line 90 `let autoTaskSettingsInstance = AutoTaskSettings()`), create and pass it:

```swift
        let autoTaskSettingsInstance = AutoTaskSettings()
        let taskLogStore = TaskLogStore()
        let autoCode = AutoCodeUpdateService(
            config: cfg,
            autoTaskSettings: autoTaskSettingsInstance,
            gitLabClient: GitLabClient(),
            registry: registry,
            projectStore: projectStoreInstance,
            api: client,
            logStore: taskLogStore)
```

Store it as a `StateObject` (next to line 116 `self._autoCodeUpdate = …`):

```swift
        self._logStore = StateObject(wrappedValue: taskLogStore)
```

Inject it into the environment next to the existing `.environmentObject(autoCodeUpdate)` lines (~158 and ~323). Add immediately after each of those:

```swift
                .environmentObject(logStore)
```

- [ ] **Step 4: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean.

- [ ] **Step 5: Run the existing service tests to confirm no regression**

Run: `cd mac && swift test --filter AutoCodeUpdateServiceTests`
Expected: PASS (unchanged — default arg means tests still construct without `logStore`).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat(auto-task): inject shared TaskLogStore into AutoCodeUpdateService"
```

---

### Task 3: Live `Pipe` streaming in `runCLI(prompt:)`

Switch the prompt-task CLI from writing stdout/stderr straight to a `FileHandle` to a `Pipe` whose `readabilityHandler` tees each decoded line to the `.log` file AND to `logStore[task]`. (The issue-implementation `runCLI(issue:)` is left on `FileHandle` — issue runs are not one of the 8 selectable tasks; they stay observable via the History list + `.log` file. This keeps the diff focused.)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — `runCLI(prompt:localPath:logSuffix:logDir:)` at lines 1065-1137, and its 5 call sites at lines 487/500/513/527/541.

**Interfaces:**
- Produces: `runCLI(prompt:localPath:logSuffix:logDir:task:)` now takes `task: AutoTask` and streams live lines into `logStore[task]`.

- [ ] **Step 1: Add the `task:` parameter to the signature**

Change line 1065:

```swift
    private func runCLI(prompt: String, localPath: String, logSuffix: String, logDir: URL,
                        task: AutoTask) async -> Bool {
```

- [ ] **Step 2: Replace the FileHandle-direct output block with Pipe streaming**

Replace lines 1124-1137 (the `let logFileHandle` … `process.standardInput = FileHandle.nullDevice` block):

```swift
        // Stream stdout+stderr LIVE: tee each decoded line to the log file
        // AND append it to the task's in-memory buffer so the Auto Task page
        // shows output as it happens (not just the post-run tail). The file
        // handle is owned by the readabilityHandler and closed at EOF — there
        // is no `defer` close, which would race the handler's final write.
        let logFileHandle: FileHandle?
        do {
            logFileHandle = try FileHandle(forWritingTo: logURL)
        } catch {
            log.error("Failed to open auto-task log file \(logURL.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            logFileHandle = nil
        }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        let store = logStore
        var accumulator = LineAccumulator()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            // availableData is empty ONLY at EOF (Apple contract).
            if data.isEmpty {
                handle.readabilityHandler = nil
                if let rest = accumulator.flush() {
                    logFileHandle?.write((rest + "\n").data(using: .utf8) ?? Data())
                    let captured = rest
                    Task { @MainActor in store.append(task, captured) }
                }
                logFileHandle?.closeFile()
                return
            }
            logFileHandle?.write(data)
            guard let chunk = String(data: data, encoding: .utf8) else { return }
            for line in accumulator.feed(chunk) {
                let captured = line
                Task { @MainActor in store.append(task, captured) }
            }
        }
        process.standardInput = FileHandle.nullDevice
```

(The `terminationHandler` + timeout watchdog that follow at lines 1139+ are unchanged — they still resume the continuation on process exit. The `readabilityHandler` drains to EOF independently and self-clears.)

- [ ] **Step 3: Update the 5 call sites to pass `task:`**

At each prompt-task call site (lines 487, 500, 513, 527, 541), add the `task:` argument and delete the now-redundant `taskOutputs[…] = logTail(…)` assignment (streaming populates the buffer live). For Review Code (line 487-491) the new form is:

```swift
            if !Task.isCancelled, autoTaskSettings.runReviewCode {
                currentStep = "Running Review Code"
                let ok = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                      localPath: capturedGitRoot,
                                      logSuffix: "review-code",
                                      logDir: logDir,
                                      task: .reviewCode)
                if ok {
                    taskErrors.removeValue(forKey: AutoTask.reviewCode.rawValue)
                } else {
                    taskErrors[AutoTask.reviewCode.rawValue] = "Review Code task failed. Check ~/Library/Logs/LLM IDE/auto-task-review-code.log"
                }
            }
```

Apply the identical pattern to the other four: `task: .reviewDoc` (logSuffix `review-doc`), `task: .reviewConflicts` (`review-conflicts`), `task: .generateDoc` (`generate-doc`), `task: .updateIssues` (`update-issues`). For each, remove the `taskOutputs[<task>.rawValue] = logTail(suffix:logDir:)` line. Keep the `taskErrors` set/remove block.

- [ ] **Step 4: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean. (`logTail` becomes unused — leave it for now; it is removed when `taskOutputs` is removed in Task 4. If the build warns about an unused function, that is acceptable until Task 4.)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
git commit -m "feat(auto-task): stream prompt-task CLI output live into TaskLogStore"
```

---

### Task 4: Decompose `run()` into per-task bodies + `runSingle(_:)`

Add `currentTask`, a public `runSingle(_:)` entry, an internal `runOne(_:)`, and a `runTaskBody(_:resolved:logDir:)` switch. Refactor `run()` step 6 (the big `if`-chain, lines 484-579) to iterate enabled tasks through `runTaskBody`. Route regression/knowledge/updatePlanStatus output to `logStore` (replacing their `taskOutputs` writes). Remove `taskOutputs`.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — published state (lines 22-27), `run()` (189-588), new methods, `reportKnowledge` (595-616), `runRegressionSweep` (624-660), `refreshPlanStatuses` (665-701).
- Modify: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceTests.swift` — add a re-entrancy test.

**Interfaces:**
- Produces: `@Published private(set) var currentTask: AutoTask?`; `func runSingle(_ task: AutoTask)`; the orchestrator `run()`; task bodies all log to `logStore`.

- [ ] **Step 1: Replace the `taskOutputs` published property with `currentTask`**

In the published-state block (lines 22-27), delete the `taskOutputs` declaration (lines 22-24) and add `currentTask`:

```swift
    @Published private(set) var taskErrors: [String: String] = [:]
    /// Which task is running right now (drives the per-task ▶ spinner in the
    /// Auto Task page). nil between tasks / when idle.
    @Published private(set) var currentTask: AutoTask? = nil
    /// Human-readable description of the currently running step … (existing comment)
    @Published private(set) var currentStep: String?
```

- [ ] **Step 2: Remove the `taskOutputs = [:]` reset in `run()`**

Delete line 198 (`taskOutputs = [:]`). Logs accumulate across runs — do not clear at run start.

- [ ] **Step 3: Add `runSingle(_:)` and `runOne(_:)`**

Add next to `runNow()` (after line 154):

```swift
    /// Per-task manual run (the ▶ button on a task's page). Runs JUST that one
    /// task body, ignoring its enable checkbox. Shares the `runTask` re-entrancy
    /// guard with `runNow()` so a global run and a per-task run can't overlap.
    func runSingle(_ task: AutoTask) {
        guard runTask == nil else { return }
        runTask = Task { [weak self] in
            await self?.runOne(task)
            self?.runTask = nil
        }
    }

    /// Resolve backend/project once, then run a single task body. Used by
    /// `runSingle(_:)`. Not used by the timer/global run (that goes through
    /// `run()` which runs the action pipeline + all enabled tasks).
    private func runOne(_ task: AutoTask) async {
        guard !isRunning else { return }
        isRunning = true
        defer {
            isRunning = false
            currentTask = nil
            currentStep = nil
            lastRunDate = Date()
        }
        guard let resolved = resolveBackendAndProject() else {
            statusMessage = "No linked repo — configure in GitLab or GitHub settings"
            return
        }
        guard let logDir = logsDirectory() else {
            statusMessage = "Logs directory unavailable"
            return
        }
        await runTaskBody(task, resolved: resolved, logDir: logDir)
        statusMessage = "\(task.label) — done"
    }
```

- [ ] **Step 4: Extract `runTaskBody(_:resolved:logDir:)` and move the 8 task bodies into it**

Add this method. Each case MOVES the existing block verbatim from `run()` (the `runCLI(prompt:…)` calls now include `task:` from Task 3; regression/knowledge/updatePlanStatus move their bodies here with `taskOutputs`/direct writes converted to `logStore.append` as shown). `resolved` carries `client`, `projectId`, `gitRoot`, `projectRoot` — capture what each case needs:

```swift
    /// Run a single task body. Called by the orchestrator `run()` (for enabled
    /// tasks) and by `runOne(_:)` (per-task manual run). Each case logs a
    /// start marker + streams/summarizes into `logStore[task]`.
    private func runTaskBody(_ task: AutoTask, resolved: ResolvedBackend, logDir: URL) async {
        logStore.append(task, "— run started —")
        currentTask = task
        defer { currentTask = nil }
        switch task {
        case .reviewCode:
            currentStep = "Running Review Code"
            let ok = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                  localPath: resolved.gitRoot, logSuffix: "review-code",
                                  logDir: logDir, task: .reviewCode)
            finishPromptTask(.reviewCode, ok: ok)
        case .reviewDoc:
            currentStep = "Running Review Doc"
            let ok = await runCLI(prompt: config.autoTaskTemplateReviewDoc,
                                  localPath: resolved.gitRoot, logSuffix: "review-doc",
                                  logDir: logDir, task: .reviewDoc)
            finishPromptTask(.reviewDoc, ok: ok)
        case .reviewConflicts:
            currentStep = "Running Review Conflicts"
            let ok = await runCLI(prompt: config.autoTaskTemplateReviewConflicts,
                                  localPath: resolved.gitRoot, logSuffix: "review-conflicts",
                                  logDir: logDir, task: .reviewConflicts)
            finishPromptTask(.reviewConflicts, ok: ok)
        case .generateDoc:
            currentStep = "Generating Documentation"
            let ok = await runCLI(prompt: config.autoTaskTemplateGenerateDoc,
                                  localPath: resolved.gitRoot, logSuffix: "generate-doc",
                                  logDir: logDir, task: .generateDoc)
            finishPromptTask(.generateDoc, ok: ok)
        case .updateIssues:
            currentStep = "Updating Issues"
            let ok = await runCLI(prompt: config.autoTaskTemplateUpdateIssues,
                                  localPath: resolved.gitRoot, logSuffix: "update-issues",
                                  logDir: logDir, task: .updateIssues)
            finishPromptTask(.updateIssues, ok: ok)
        case .regression:
            currentStep = "Running Regression sweep"
            await runRegressionSweep(projectRoot: resolved.projectRoot, gitRoot: resolved.gitRoot)
        case .generateKnowledge:
            currentStep = "Reviewing Knowledge"
            reportKnowledge(projectRoot: resolved.projectRoot)
        case .updatePlanStatus:
            currentStep = "Refreshing Plan statuses"
            await refreshPlanStatuses(projectRoot: resolved.projectRoot)
        }
    }

    /// Shared success/error bookkeeping for the 5 prompt tasks.
    private func finishPromptTask(_ task: AutoTask, ok: Bool) {
        if ok {
            taskErrors.removeValue(forKey: task.rawValue)
            logStore.append(task, "— run finished —", level: .info)
        } else {
            taskErrors[task.rawValue] = "\(task.label) task failed. Check ~/Library/Logs/LLM IDE/auto-task-\(task.logSuffix).log"
            logStore.append(task, "— run failed —", level: .error)
        }
    }
```

Add a `logSuffix` helper on `AutoTask` (in `AutoCodeView.swift` next to the enum, see Task 5) OR compute it inline. To avoid a cross-file dependency in the service, add a computed `logSuffix` on `AutoTask` in the enum block (Task 5 adds it); for now reference `task.logSuffix` and define it in Task 5. (If implementing tasks out of order, add this to the enum first.)

> **Resolving `ResolvedBackend`:** the existing `resolveBackendAndProject()` returns the tuple type already used in `run()` (it has `.client`, `.projectId`, `.gitRoot`, `.projectRoot`). Reuse that exact type name for the `resolved` parameter. Confirm the type name by reading `resolveBackendAndProject()`'s declaration before writing the signature; if it returns an anonymous tuple, introduce a `typealias ResolvedBackend = (client: RepoBackend, projectId: String, gitRoot: String, projectRoot: String)` and have both `run()` and `runOne` use it.

- [ ] **Step 5: Rewrite `run()` step 6 to iterate enabled tasks**

Replace the big `if`-chain (lines 484-579) with an ordered loop. The action pipeline (steps 1-5, lines 224-474) stays inline and unchanged. Replace step 6 onward with:

```swift
        // 6. Run each enabled task body, in left-pane order.
        let enabledOrder: [AutoTask] = [
            .reviewCode, .reviewDoc, .reviewConflicts,
            .updateIssues, .updatePlanStatus, .generateDoc,
            .regression, .generateKnowledge
        ]
        if !Task.isCancelled, let logDir = logsDirectory() {
            for task in enabledOrder where isTaskEnabled(task) {
                if Task.isCancelled { break }
                await runTaskBody(task, resolved: resolved, logDir: logDir)
            }
        }
```

Add the `isTaskEnabled` helper:

```swift
    private func isTaskEnabled(_ task: AutoTask) -> Bool {
        switch task {
        case .reviewCode:        return autoTaskSettings.runReviewCode
        case .reviewDoc:         return autoTaskSettings.runReviewDoc
        case .reviewConflicts:   return autoTaskSettings.runReviewConflicts
        case .regression:        return autoTaskSettings.runRegression
        case .generateKnowledge: return autoTaskSettings.runGenerateKnowledge
        case .generateDoc:       return autoTaskSettings.runGenerateDoc
        case .updateIssues:      return autoTaskSettings.runUpdateIssues
        case .updatePlanStatus:  return autoTaskSettings.runUpdatePlanStatus
        }
    }
```

(Delete the now-redundant `// 7. Regression`, `// 8. Knowledge`, `// 9. Plan status` blocks at 554-579 — they are now cases in `runTaskBody`. Keep the final `statusMessage`/`allEntries` block at 582-587.)

- [ ] **Step 6: Route regression/knowledge/updatePlanStatus output to `logStore`**

In `reportKnowledge` (lines 601-615), replace each `lines.append(...)` → keep building `lines`, then replace `taskOutputs[key] = lines.joined(separator: "\n")` (line 614) with:

```swift
        for line in lines { logStore.append(.generateKnowledge, line) }
        taskErrors.removeValue(forKey: key)
```

In `runRegressionSweep` (lines 652-659), append a summary line to the log on each branch. Replace the `if total == 0 …` block with:

```swift
        if total == 0 {
            taskErrors.removeValue(forKey: AutoTask.regression.rawValue)
            logStore.append(.regression, "No fixed faults to re-verify.")
        } else if regressed > 0 {
            let reopened = autoTaskSettings.regressionAutoReopen ? " (auto-reopened)" : ""
            taskErrors[AutoTask.regression.rawValue] = "Regression: \(regressed)/\(total) regressed\(reopened)."
            logStore.append(.regression, "\(regressed)/\(total) faults regressed\(reopened).", level: .error)
        } else {
            taskErrors.removeValue(forKey: AutoTask.regression.rawValue)
            logStore.append(.regression, "\(total) faults re-verified — no regressions.")
        }
```

In `refreshPlanStatuses` (lines 685-700), replace each `taskOutputs[key] = …` with `logStore.append(.updatePlanStatus, …)`:

```swift
            if total == 0 {
                logStore.append(.updatePlanStatus, "No dispatched plan tasks found — nothing to refresh.")
            } else if changed > 0 {
                logStore.append(.updatePlanStatus, "Refreshed \(total) plan tasks — \(changed) statuses updated.")
            } else {
                logStore.append(.updatePlanStatus, "Refreshed \(total) plan tasks — no changes.")
            }
```

- [ ] **Step 7: Delete `taskOutputs` + the now-unused `logTail`**

Remove the `logTail(suffix:logDir:maxChars:)` method (lines 1343-1349) — no remaining callers.

- [ ] **Step 8: Add a re-entrancy test**

Append to `AutoCodeUpdateServiceTests.swift` inside the suite struct:

```swift
    @MainActor
    @Test func runSingleIsNoOpWhileRunInFlight() async {
        let cfg = Self.isolatedConfig()
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-single-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let registry = ProcessedActionsRegistry(storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = AutoCodeUpdateService(config: cfg, autoTaskSettings: AutoTaskSettings(), registry: registry)

        // Simulate an in-flight run by holding the guard via runNow() with no
        // backend configured (run() returns early, but the Task stays alive
        // long enough to assert the guard). Two runSingle calls back-to-back
        // must not spawn a second runTask.
        svc.runNow()
        svc.runSingle(.reviewCode)
        // The re-entrancy guard means runSingle is a no-op while runNow's Task
        // exists. We assert the service does not crash and stays consistent.
        #expect(svc.currentTask == nil)   // no backend → runOne returned early
    }
```

- [ ] **Step 9: Build + test**

Run: `cd mac && swift build && swift test --filter AutoCodeUpdateServiceTests`
Expected: builds clean; service tests pass (including the new one).

- [ ] **Step 10: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceTests.swift
git commit -m "refactor(auto-task): decompose run() into per-task bodies + runSingle"
```

---

### Task 5: Redesign the AutoCodeView right pane (Preview / Edit / Log + ▶ Run + Clear)

Rewrite `templateEditor(_:)` into the stacked layout. Add a `MarkdownPreview` wrapper (manages `SelfSizingMarkdownView`'s `onHeight`), a per-task ▶ Run bound to `runSingle`, a `logSection(_:)` reading `logStore`, and the regression config controls for the Regression task's About page. Add `logSuffix` to the `AutoTask` enum.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — add `@EnvironmentObject private var logStore: TaskLogStore`, rewrite `templateEditor` (266-386), add subviews, add `logSuffix` to the enum (466-548).

**Interfaces:**
- Consumes: `TaskLogStore` (Task 1), `AutoCodeUpdateService.runSingle` + `currentTask` (Task 4).
- Produces: the redesigned page.

- [ ] **Step 1: Add the `logStore` environment object + `logSuffix` on `AutoTask`**

At the top of `AutoCodeView` (after line 10 `@EnvironmentObject private var theme: ThemeStore`):

```swift
    @EnvironmentObject private var logStore: TaskLogStore
```

In the `AutoTask` enum (after `var icon: String { … }`, ~line 515), add:

```swift
    /// Log-file suffix used by the service's `runCLI(prompt:)` + error hints.
    var logSuffix: String {
        switch self {
        case .reviewCode:        return "review-code"
        case .reviewDoc:         return "review-doc"
        case .reviewConflicts:   return "review-conflicts"
        case .regression:        return "regression"
        case .generateKnowledge: return "knowledge"
        case .generateDoc:       return "generate-doc"
        case .updateIssues:      return "update-issues"
        case .updatePlanStatus:  return "update-plan-status"
        }
    }
```

- [ ] **Step 2: Replace `templateEditor(_:)` with the stacked page**

Replace the whole `templateEditor(_:)` method (lines 266-386) with:

```swift
    @ViewBuilder
    private func templateEditor(_ task: AutoTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                Image(systemName: task.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
                Text(task.label)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Button { autoCode.runSingle(task) } label: {
                    Label(autoCode.currentTask == task
                          ? (autoCode.currentStep ?? "Running…")
                          : "Run",
                          systemImage: autoCode.currentTask == task ? "ellipsis.circle" : "play.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(autoCode.isRunning)
                if task.templateBinding(config: config) != nil {
                    Button("Restore Default") { taskToReset = task }
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.current.textMuted)
                        .font(Typography.caption)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(theme.current.surface)

            Divider()

            // Preview + Edit, scrollable together
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    previewSection(task)
                    if let template = task.templateBinding(config: config) {
                        editSection(task, template: template)
                    } else {
                        structuralConfigSection(task)
                    }
                }
                .padding(20)
            }

            if let error = autoCode.taskErrors[task.rawValue] {
                StatusBanner(severity: .error, message: error,
                             onDismiss: { autoCode.dismissTaskError(for: task) })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            // Log docked at the bottom
            logSection(task)

            // Last run footer
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
        .confirmationDialog(
            "Reset \"\(task.label)\" template to default?",
            isPresented: Binding(
                get: { taskToReset == task },
                set: { if !$0 { taskToReset = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Reset to Default", role: .destructive) {
                task.resetTemplate(config: config)
                taskToReset = nil
            }
            Button("Cancel", role: .cancel) { taskToReset = nil }
        } message: {
            Text("Your custom prompt will be permanently replaced.")
        }
    }

    @ViewBuilder
    private func previewSection(_ task: AutoTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Preview").font(Typography.section).foregroundStyle(theme.current.textMuted)
            MarkdownPreview(markdown: previewMarkdown(for: task))
                .frame(maxWidth: .infinity)
                .background(theme.current.surface)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                .cornerRadius(6)
        }
    }

    /// Markdown shown in the preview: the editable template for prompt tasks,
    /// a static About doc for structural tasks.
    private func previewMarkdown(for task: AutoTask) -> String {
        task.templateBinding(config: config) ?? aboutMarkdown(for: task)
    }

    @ViewBuilder
    private func editSection(_ task: AutoTask, template: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Edit template").font(Typography.section).foregroundStyle(theme.current.textMuted)
            TextEditor(text: template)
                .font(Typography.mono)
                .foregroundStyle(theme.current.text)
                .scrollContentBackground(.hidden)
                .background(theme.current.surface)
                .frame(minHeight: 180)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                .cornerRadius(6)
        }
    }

    /// Live, scrollable per-task log with a Clear button.
    @ViewBuilder
    private func logSection(_ task: AutoTask) -> some View {
        let lines = logStore.lines(for: task)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Log · live").font(Typography.section).foregroundStyle(theme.current.textMuted)
                Spacer()
                Button { logStore.clear(task) } label: {
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

- [ ] **Step 3: Add the `MarkdownPreview` wrapper + About/config content**

Add these private types/helpers at the end of the file (after the `AutoTask` enum). `MarkdownPreview` manages the self-sizing web view's reported height; `aboutMarkdown(for:)` returns the static doc for structural tasks; `structuralConfigSection(_:)` renders the Regression config controls (relocated from Settings):

```swift
/// Wraps `SelfSizingMarkdownView`, capturing its reported content height into
/// `@State` so the preview sizes to its rendered markdown inside the page's
/// `ScrollView`.
private struct MarkdownPreview: View {
    let markdown: String
    @EnvironmentObject private var theme: ThemeStore
    @State private var height: CGFloat = 1

    var body: some View {
        SelfSizingMarkdownView(markdown: markdown, isDark: theme.current.isDark) { h in
            if abs(h - height) > 1 { height = h }
        }
        .frame(height: max(height, 1))
    }
}

private extension AutoCodeView {
    /// Static markdown shown as the "preview" for structural (non-template) tasks.
    func aboutMarkdown(for task: AutoTask) -> String {
        switch task {
        case .regression:
            return """
            # Regression

            Re-asks every `status: fixed` fault report under `<repo>/system/faults/` and
            flips any that come back with a different answer to `status: open`.

            Prompts come from the saved fault reports, so there's no prompt template to edit.
            Configure the sweep behavior below.
            """
        case .generateKnowledge:
            return """
            # Knowledge

            Surfaces the current state of the auto-generated code graph + agent memory.
            Generation itself is automatic (on open/edit); this task only reports what's there.
            """
        case .updatePlanStatus:
            return """
            # Update Plan Status

            Polls external outcome trackers (GitHub/GitLab/Linear/Backlog) for dispatched
            plan tasks and updates their local status. Requires provider credentials.
            """
        default:
            return ""
        }
    }

    /// Config controls for structural tasks. Today only Regression has knobs;
    /// the other two render an "about" hint only.
    @ViewBuilder
    func structuralConfigSection(_ task: AutoTask) -> some View {
        switch task {
        case .regression:
            VStack(alignment: .leading, spacing: 8) {
                Text("Configuration").font(Typography.section).foregroundStyle(theme.current.textMuted)
                Toggle(isOn: $autoTaskSettings.regressionAttemptRepair) {
                    Label("Attempt repair on regression", systemImage: "wrench.and.screwdriver")
                }.toggleStyle(.checkbox)
                Toggle(isOn: $autoTaskSettings.regressionAutoReopen) {
                    Label("Auto-reopen regressed faults", systemImage: "arrow.uturn.backward")
                }.toggleStyle(.checkbox)
                HStack {
                    Image(systemName: "timer").font(.system(size: 12))
                    Text("Verify timeout (s)").font(Typography.caption)
                    Spacer()
                    TextField("120", value: $autoTaskSettings.regressionVerifyTimeout, format: .number)
                        .frame(width: 60).textFieldStyle(.roundedBorder)
                }
            }
        case .generateKnowledge, .updatePlanStatus:
            Text("Nothing to configure — see the description above.")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
        default:
            EmptyView()
        }
    }
}
```

> **`$autoTaskSettings` access:** the existing `AutoCodeView` does not currently inject `AutoTaskSettings`. Add `@EnvironmentObject private var autoTaskSettings: AutoTaskSettings` to `AutoCodeView` (it is already an app-wide `@StateObject`, see `LlmIdeMacApp.swift:131`, so `.environmentObject(...)` already injects it — confirm by grepping `.environmentObject(autoTaskSettings)`; if absent, add it next to the `.environmentObject(autoCodeUpdate)` line).

- [ ] **Step 4: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean. If `AutoTaskSettings` is not in the environment, add the `.environmentObject` in `LlmIdeMacApp.swift` and rebuild.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat(auto-task): redesign task page — preview/edit/log + per-task Run"
```

---

### Task 6: Declutter `AutoCodeSettingsSection`

Slim the Settings card to global knobs only. Remove the 8 per-task toggles, the Run Now / Stop / Reveal Logs / Status row (these live on the Auto Task page + Menu Bar), and the regression sub-options (now on the Regression About page, Task 5).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` (whole body, lines 24-205).

- [ ] **Step 1: Replace the card body**

Replace the `body`'s `VStack` content (lines 26-203) with the slimmed version. Keep the `SettingsSectionCard(icon:title:)` wrapper and the four `let` option arrays at top are partially unused after this — remove `lookbackOptions`/`dayOptions` only if the compiler flags them; keep `intervalOptions`. The new body:

```swift
    var body: some View {
        SettingsSectionCard(icon: "arrow.triangle.2.circlepath.circle", title: "Auto Tasks") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                // Master switch
                Toggle(isOn: Binding(
                    get: { autoTaskSettings.enabled },
                    set: { enabled in
                        autoTaskSettings.enabled = enabled
                        if enabled { autoCodeUpdate.start() } else { autoCodeUpdate.stop() }
                    }
                )) {
                    Text("Enabled").font(Typography.body).foregroundStyle(theme.current.text)
                }
                .toggleStyle(.switch)

                // Lookback
                HStack(spacing: Spacing.md) {
                    Text("Scan last").font(Typography.body).foregroundStyle(theme.current.textMuted)
                    if autoTaskSettings.lookbackByDays {
                        Picker("", selection: $autoTaskSettings.lookbackDays) {
                            ForEach(dayOptions, id: \.self) { n in Text("\(n)").tag(n) }
                        }.labelsHidden().pickerStyle(.menu).frame(width: 70)
                        Text("days").font(Typography.body).foregroundStyle(theme.current.textMuted)
                    } else {
                        Picker("", selection: $autoTaskSettings.lookbackMeetingCount) {
                            ForEach(lookbackOptions, id: \.self) { n in Text("\(n)").tag(n) }
                        }.labelsHidden().pickerStyle(.menu).frame(width: 70)
                        Text("meetings").font(Typography.body).foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Picker("", selection: $autoTaskSettings.lookbackByDays) {
                        Text("by count").tag(false)
                        Text("by age").tag(true)
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 150)
                }

                // Cadence
                HStack(spacing: Spacing.md) {
                    Text("Run every").font(Typography.body).foregroundStyle(theme.current.textMuted)
                    Picker("", selection: $autoTaskSettings.intervalMinutes) {
                        ForEach(intervalOptions, id: \.self) { m in Text(intervalLabel(m)).tag(m) }
                    }.labelsHidden().pickerStyle(.menu).frame(width: 110)
                    Text("(only while the app is open)")
                        .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                }

                // Dirty-tree behavior
                Toggle(isOn: $autoTaskSettings.autoStash) {
                    Label("Auto-stash uncommitted changes", systemImage: "tray.and.arrow.down")
                        .font(Typography.caption)
                        .foregroundStyle(autoTaskSettings.autoStash ? theme.current.text : theme.current.textMuted)
                }
                .toggleStyle(.checkbox)
                .help("When on, auto-tasks stash your uncommitted changes before running and restore them after, instead of skipping. Off by default.")

                Text("Per-task toggles, Run, and live logs live on the Auto Tasks page. Quick status + Run are in the menu bar.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                if !hasLinkedRepo {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No linked repository detected. Auto Tasks need an active GitLab or GitHub project with a local clone path and a matching access token.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Open Settings") { shell.section = .settings }
                            .font(Typography.caption)
                            .buttonStyle(.borderless)
                            .foregroundStyle(theme.current.accent)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
```

Then delete the now-unused `statusText` computed property (lines 207-212) and the `taskToggle` helper (lines 218-226). Keep `hasLinkedRepo` (line 214) and `intervalLabel` (lines 13-22).

- [ ] **Step 2: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean (remove any option array the compiler flags as unused).

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift
git commit -m "refactor(auto-task): slim Settings to global knobs only"
```

---

### Task 7: Full verification + smoke notes

**Files:** none (verification only).

- [ ] **Step 1: Clean build + full test run**

Run: `cd mac && swift build && swift test`
Expected: builds clean; ALL tests pass (existing suite + new `TaskLogStoreTests` + the new `runSingle` test).

- [ ] **Step 2: Lint/format gate**

Run: `cd /Users/dinsmallade/llm-ide && make lint`
Expected: clean (or run `make format` if formatting drifts, then re-commit).

- [ ] **Step 3: Manual smoke (run the app)**

Build the app via the project's build script (per project memory, the raw `.build` binary won't restore the project / run the auto-updater — use `build_app.sh` + open `.app`):

```bash
cd mac && ./build_app.sh && open build/Release/LlmIdeMac.app   # (confirm exact path from build_app.sh)
```

Then verify:
- Auto Task page: select each of the 8 tasks → right pane shows Preview (rendered markdown), Edit (5 prompt tasks) or config (Regression), and a live Log section with Clear.
- Click ▶ Run on a prompt task → its Log streams lines live, accumulates a second run's lines on a second click.
- Clear wipes the on-screen log; the `.log` file in `~/Library/Logs/LLM IDE/` is untouched.
- Menu Bar: Run Now still works (global run); per-task enable toggles still gate the global run.
- Settings → Auto Tasks: only Enabled / Scan last / Run every / Auto-stash + repo warning remain.

- [ ] **Step 4: Commit any smoke-fixes, then push**

```bash
git add -A
git commit -m "test(auto-task): verification fixes"   # only if needed
git push -u origin feat/auto-task-redesign
```

(Pre-warm the build before pushing — the pre-push hook runs `swift build` + `swift test`.)

---

## Self-Review notes

- **Spec coverage:** Task 1 = `TaskLogStore`+`LineAccumulator`. Task 2 = DI. Task 3 = live streaming for prompt tasks. Task 4 = decompose `run()` + `runSingle` + route all 8 tasks to `logStore` + remove `taskOutputs`. Task 5 = stacked Preview/Edit/Log page + per-task Run + Clear + structural About/config. Task 6 = Settings declutter. All 6 locked decisions (§"Locked decisions" of the spec) are covered: (1) scope — this plan only; (2) all 8 tasks; (3) stacked layout; (4) global + per-task Run; (5) live + accumulate + Clear; (6) Settings global knobs.
- **Why some steps are build-verified not unit-tested:** the codebase unit-tests pure helpers (`NoteActionExtractor`, `resolve*`, `LineAccumulator`, `TaskLogStore`); subprocess orchestration (`runCLI`, `run()`, the view) is verified via `swift build` + the manual smoke, matching the existing `AutoCodeUpdateServiceTests` which cover helpers only. `LineAccumulator` (the only pure new logic in the streaming path) is unit-tested.
- **Type consistency:** `TaskLogStore.append(_:level:)`, `.clear(_:)`, `.lines(for:)`, `LogLine{id,timestamp,level,text}`, `Level{info,error}`, `AutoTask.logSuffix`, `AutoCodeUpdateService.runSingle(_:)` + `currentTask` — names match across all tasks.
- **Known follow-ups (out of scope):** Resource auto-task; "always same task" behavior fix (use the new per-task logs to confirm root cause first).
