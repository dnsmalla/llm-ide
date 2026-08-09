# Custom-task mutating mode + per-task cron — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give `CustomAutoTask` a `.review`/`.implement` mode (commit on an isolated `fix/custom-*` branch) and an optional per-task `cron` (scheduled alongside the 13 built-ins).

**Architecture:** Add `mode` + `cron` to `CustomAutoTask` (backward-compatible Codable); add a `persistChanges` param to `runCLI(prompt:)` that, when true, branches + commits instead of discarding; thread `task.mode` through `runCustomTask`; extend `AutoTaskSettings` + `dueTasks`/`runDue` to schedule custom tasks by id.

**Tech Stack:** Swift (macOS, SPM), XCTest, module `LlmIdeMacLib` (`@testable import LlmIdeMacLib`). Branch `feat/custom-task-mode-and-cron`, **stacked on PR #42** (`fix/auto-task-correctness`).

## Global Constraints

- `runCLI(prompt:)`'s new `persistChanges` param defaults to `false` — the 5 built-in prompt tasks and `.review` custom tasks are unchanged (still discard).
- `.implement` custom tasks run on an isolated `fix/custom-<slug>-<token>` branch and commit via `git add -A` + `git commit`; they never touch the user's working branch. Mirrors `runCLI(issue:)`'s posture, no issue-tracker wiring.
- `cron` lives on `CustomAutoTask` (nil = manual). `nextFireAt` for custom tasks is runtime state in `AutoTaskSettings`, keyed by `CustomAutoTask.id` (cron for built-ins is keyed by `AutoTask.rawValue`).
- Backward-compat: existing persisted `CustomAutoTask` payloads (no `mode`/`cron`) must decode as `.review` / nil. Use `decodeIfPresent`.
- `reviewMerge` does NOT pick up `fix/custom-*` branches (manual push, as today).
- Conventional Commits (`feat(mac): …`), one concern per commit, message ending with a blank line + `Co-Authored-By: Claude <noreply@anthropic.com>`. Run `cd /Users/dinsmallade/llm-ide/mac && swift build` / `swift test --filter <Class>`. Stale SourceKit "No such module 'XCTest'" diagnostics are an index artifact — disregard. Pre-existing failures `SCMParsersTests`/`SavedRepoPathReconcilerTests` are not ours.

---

### Task 1: `CustomAutoTask` — add `mode` + `cron` (backward-compatible Codable)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/AutoCode/CustomAutoTask.swift`
- Test: `mac/Tests/LlmIdeMacTests/CustomAutoTaskTests.swift` (extend)

**Interfaces:**
- Produces: `CustomAutoTask.Mode { case review, implement }`; `CustomAutoTask.mode` (default `.review`); `CustomAutoTask.cron: String?` (default nil); backward-compatible decode.

- [ ] **Step 1: Write failing tests** (append to `CustomAutoTaskTests.swift`)

```swift
    // MARK: - mode + cron (sub-project 2)

    func testDefaultsToReviewModeAndNilCron() {
        let t = CustomAutoTask(name: "X", template: "p")
        XCTAssertEqual(t.mode, .review)
        XCTAssertNil(t.cron)
    }

    func testModeAndCronRoundTrip() {
        var t = CustomAutoTask(name: "Refactor", template: "p")
        t.mode = .implement
        t.cron = "0 2 * * *"
        t.save(in: suite)

        let loaded = CustomAutoTask.loadAll(from: suite).first
        XCTAssertEqual(loaded?.mode, .implement)
        XCTAssertEqual(loaded?.cron, "0 2 * * *")
    }

    func testLegacyPayloadDecodesAsReviewAndNilCron() throws {
        // A payload that predates mode/cron — simulate by encoding a dict
        // without those keys.
        let legacy = """
            [{"id":"abc","name":"Old","template":"p","isEnabled":true,"createdAt":0}]
            """
        suite.data(forKey: CustomAutoTask.defaultsKey) // ensure clean
        suite.set(Data(legacy.utf8), forKey: CustomAutoTask.defaultsKey)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.mode, .review)
        XCTAssertNil(loaded.first?.cron)
    }
```

- [ ] **Step 2: Run — expect FAIL** (no `mode`/`cron`). `cd /Users/dinsmallade/llm-ide/mac && swift test --filter CustomAutoTaskTests`

- [ ] **Step 3: Implement** — replace the `CustomAutoTask` struct (lines 9-26) with:

```swift
struct CustomAutoTask: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    /// The prompt run via `AutoCodeUpdateService.runCLI(prompt:...)` — same
    /// role as `AppConfig.autoTaskTemplateReviewCode` etc.
    var template: String
    var isEnabled: Bool = true
    var createdAt: Date = Date()
    /// `.review` (default) discards the CLI's edits; `.implement` commits them
    /// on an isolated `fix/custom-<slug>-<token>` branch.
    var mode: Mode = .review
    /// Cron schedule (nil = manual ▶ only). Parsed by `CronExpression`.
    var cron: String?

    enum Mode: String, Codable, CaseIterable { case review, implement }

    init(id: String = UUID().uuidString, name: String, template: String,
         isEnabled: Bool = true, createdAt: Date = Date(),
         mode: Mode = .review, cron: String? = nil) {
        self.id = id; self.name = name; self.template = template
        self.isEnabled = isEnabled; self.createdAt = createdAt
        self.mode = mode; self.cron = cron
    }

    // MARK: Backward-compatible Codable (mode/cron predate existing payloads)

    enum CodingKeys: String, CodingKey {
        case id, name, template, isEnabled, createdAt, mode, cron
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        template = try c.decode(String.self, forKey: .template)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        mode = try c.decodeIfPresent(Mode.self, forKey: .mode) ?? .review
        cron = try c.decodeIfPresent(String.self, forKey: .cron)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name)
        try c.encode(template, forKey: .template); try c.encode(isEnabled, forKey: .isEnabled)
        try c.encode(createdAt, forKey: .createdAt); try c.encode(mode, forKey: .mode)
        try c.encodeIfPresent(cron, forKey: .cron)
    }
}
```
(Also delete the now-stale doc comment claiming "exactly 12 cases" for `AutoTask`.)

- [ ] **Step 4: Run — expect PASS.** `swift test --filter CustomAutoTaskTests`
- [ ] **Step 5: Commit** `feat(mac): add CustomAutoTask.mode + cron (backward-compatible Codable)`

---

### Task 2: `runCLI(prompt:)` — `persistChanges` (branch + commit instead of discard)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+CLI.swift` (signature ~`:415`, discard ~`:572`; add a branch-name helper + commit git helper)
- Test: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCLITests.swift` (Create) — pure helpers only (the `Process` body stays untested)

**Interfaces:**
- Produces: `runCLI(prompt:localPath:logSuffix:logDir:logStoreId:persistChanges:)` (new last param, default `false`); `static func customImplementBranch(slug:token:) -> String`; `static func commitAll(at:message:) -> Bool`.

- [ ] **Step 1: Write failing tests** (new file `AutoCodeUpdateServiceCLITests.swift`)

```swift
import XCTest
@testable import LlmIdeMacLib

final class AutoCodeUpdateServiceCLITests: XCTestCase {
    func testCustomImplementBranchFormat() {
        let b = AutoCodeUpdateService.customImplementBranch(slug: "nightly-cleanup", token: "a1b2")
        XCTAssertEqual(b, "fix/custom-nightly-cleanup-a1b2")
    }

    func testCommitAllReturnsFalseOutsideGitRepo() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("cli-commit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        // Not a git repo → commit fails (non-zero).
        XCTAssertFalse(AutoCodeUpdateService.commitAll(at: tmp.path, message: "x"))
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`customImplementBranch`/`commitAll` don't exist).

- [ ] **Step 3: Implement**
  - Add two `nonisolated static` git helpers near the existing ones (after `rescueCommitToBranch`, ~`:105`):

```swift
    /// Branch name for a `.implement` custom auto-task: `fix/custom-<slug>-<token>`.
    /// `token` disambiguates same-named tasks across runs (caller passes a short id/timestamp).
    nonisolated static func customImplementBranch(slug: String, token: String) -> String {
        "fix/custom-\(slug)-\(token)"
    }

    /// Stage all changes and commit on the current branch. Returns false on any
    /// git failure (incl. nothing-to-commit, which `git commit` reports non-zero).
    nonisolated static func commitAll(at localPath: String, message: String) -> Bool {
        let add = git(["add", "-A"], at: localPath)
        guard add.code == 0 else { return false }
        let commit = git(["commit", "-m", message], at: localPath)
        return commit.code == 0
    }
```
  - Change the `runCLI(prompt:)` signature (~`:415`) to add the param:

```swift
    func runCLI(prompt: String, localPath: String, logSuffix: String, logDir: URL,
                logStoreId: String, persistChanges: Bool = false) async -> Bool {
```
  - When `persistChanges` is true, before launching the CLI create + check out the branch (after the dirty-tree guard passes), and after the run **skip** the discard and commit instead. Gate the discard (~`:572`):

```swift
        if persistChanges {
            let slug = Self.customTaskSlug(from: logSuffix)   // sanitize the task id/name
            let branch = Self.customImplementBranch(slug: slug, token: Self.shortToken())
            _ = await Task.detached { Self.checkoutNew(branch, at: localPath) }.value
            // … existing CLI launch …
            _ = await Task.detached { Self.commitAll(at: localPath, message: "Auto task: \(logSuffix)") }.value
        } else {
            // existing review path (incl. discard at the end)
        }
```
  (Concretely: the implementer should keep the existing review path intact and add the `persistChanges` branch with minimal duplication — create branch right after the dirty-tree guard, run the same CLI launch, then commit instead of discard. Add `checkoutNew(_ branch:, at:)` = `git checkout -b <branch>` and `customTaskSlug(from:)`/`shortToken()` small helpers. The discard call becomes `if !persistChanges { await Task.detached { Self.discardWorkingTreeChanges(at: localPath) }.value }`.)

- [ ] **Step 4: Run — expect PASS** (the two pure-helper tests; the runCLI body is exercised only by manual smoke). `swift test --filter AutoCodeUpdateServiceCLITests`
- [ ] **Step 5: Commit** `feat(mac): runCLI(prompt:) persistChanges — branch+commit for implement-mode tasks`

---

### Task 3: `runCustomTask` — pass `persistChanges` by mode

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift:247` (the `runCLI(prompt:...)` call in `runCustomTask`)

- [ ] **Step 1:** Change the call to pass `persistChanges:` based on mode:

```swift
        let ok = await runCLI(prompt: task.template, localPath: resolved.gitRoot,
                              logSuffix: task.id, logDir: logDir, logStoreId: task.id,
                              persistChanges: task.mode == .implement)
```

- [ ] **Step 2:** `swift build` (no new test — wiring; the mode→persistChanges mapping is trivial and the runCLI body is covered by Task 2's helper tests). Confirm build green.
- [ ] **Step 3: Commit** `feat(mac): route implement-mode custom tasks through persistChanges`

---

### Task 4: `AutoTaskSettings` — custom-task `nextFireAt` store

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/AutoCode/AutoTaskSettings.swift` (add `customNextFireKey`/`customNextFireAt(for:)`/`setCustomNextFireAt(_:for:)` near `nextFireAt(for:)` ~`:255`)
- Test: `mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift` (extend)

- [ ] **Step 1: Write failing test** (append to `AutoTaskSettingsCronTests.swift`, using its existing `suite` setUp pattern):

```swift
    func testCustomNextFireAtPersistsById() {
        let s = AutoTaskSettings(defaults: suite)
        XCTAssertNil(s.customNextFireAt(for: "task-1"))
        let d = Date(timeIntervalSince1970: 1_700_000_000)
        s.setCustomNextFireAt(d, for: "task-1")
        XCTAssertEqual(s.customNextFireAt(for: "task-1"), d)
        s.setCustomNextFireAt(nil, for: "task-1")
        XCTAssertNil(s.customNextFireAt(for: "task-1"))
    }
```

- [ ] **Step 2: Run — expect FAIL** (`customNextFireAt` doesn't exist).
- [ ] **Step 3: Implement** — near the existing `nextFireAt(for:)`:

```swift
    private static func customNextFireKey(_ id: String) -> String { "autoCodeCustomNextFireAt.\(id)" }

    /// nextFireAt for a custom auto-task (cron lives on `CustomAutoTask.cron`).
    func customNextFireAt(for id: String) -> Date? {
        defaults.object(forKey: Self.customNextFireKey(id)) as? Date
    }
    func setCustomNextFireAt(_ date: Date?, for id: String) {
        if let date { defaults.set(date, forKey: Self.customNextFireKey(id)) }
        else { defaults.removeObject(forKey: Self.customNextFireKey(id)) }
    }
```

- [ ] **Step 4: Run — expect PASS.** `swift test --filter AutoTaskSettingsCronTests`
- [ ] **Step 5: Commit** `feat(mac): per-custom-task nextFireAt store in AutoTaskSettings`

---

### Task 5: Schedule custom tasks — `dueCustomTasks` + `runDue`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift` (`dueTasks` ~`:263`, `runDue` ~`:288`)
- Test: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCronTests.swift` (extend)

**Interfaces:**
- Produces: `dueCustomTasks(now:) -> [CustomAutoTask]`; `realignCustomNextFire(for:now:)`; `runDue` runs both built-in and custom due tasks.

- [ ] **Step 1: Write failing tests** (extend `AutoTaskSettingsCronTests.swift` or a new `AutoCodeCustomSchedulingTests.swift`; build the service with a `suite` + a seeded custom task). Key assertions:
  - A custom task with `cron = "0 * * * *"` and a past `customNextFireAt` is returned by `dueCustomTasks(now:)`.
  - A custom task with `cron = nil` is NEVER returned by `dueCustomTasks` (manual-only).
  - A disabled custom task (`isEnabled = false`) is never due.
  - `realignCustomNextFire` pushes `customNextFireAt` strictly after `now`.

```swift
    @MainActor
    func testDueCustomTasksRequiresCronAndPastFire() {
        let s = makeService()   // helper: AutoCodeUpdateService with `suite`; see existing cron tests
        var t = CustomAutoTask(name: "Scheduled", template: "p")
        t.cron = "0 * * * *"
        t.save(in: suite)
        s.autoTaskSettings.setEnabled(true, task: .reviewCode) // enable master flag path
        s.autoTaskSettings.setEnabled(true, task: .reviewCode)
        // master enable
        // (set master `enabled` true via the settings the service holds)
        XCTAssertFalse(s.dueCustomTasks(now: Date()).contains { $0.id == t.id }) // no nextFireAt yet
        s.autoTaskSettings.setCustomNextFireAt(Date(timeIntervalSince1970: 0), for: t.id)
        XCTAssertTrue(s.dueCustomTasks(now: Date()).contains { $0.id == t.id })
    }

    @MainActor
    func testManualCustomTaskNeverDue() {
        let s = makeService()
        var t = CustomAutoTask(name: "Manual", template: "p")   // cron nil
        t.save(in: suite)
        s.autoTaskSettings.setCustomNextFireAt(Date(timeIntervalSince1970: 0), for: t.id)
        XCTAssertFalse(s.dueCustomTasks(now: Date()).contains { $0.id == t.id })
    }
```
(Adjust the master-enabled guard to match how the existing `AutoTaskSettingsCronTests` enables the service; the implementer should mirror that test's `makeService`/enabled setup.)

- [ ] **Step 2: Run — expect FAIL** (`dueCustomTasks` doesn't exist).
- [ ] **Step 3: Implement** — in `AutoCodeUpdateService.swift`, next to `dueTasks`:

```swift
    /// Enabled custom tasks with a cron whose nextFireAt is at/before `now`.
    func dueCustomTasks(now: Date = Date()) -> [CustomAutoTask] {
        guard autoTaskSettings.enabled else { return [] }
        return CustomAutoTask.loadAll(from: config.userDefaults).filter { task in
            guard task.isEnabled, task.cron != nil,
                  let next = autoTaskSettings.customNextFireAt(for: task.id) else { return false }
            return now >= next
        }
    }

    func realignCustomNextFire(for task: CustomAutoTask, now: Date) {
        guard let cron = task.cron,
              let expr = CronExpression.parse(cron),
              let next = expr.nextFire(after: now, now: now) else {
            autoTaskSettings.setCustomNextFireAt(nil, for: task.id); return
        }
        autoTaskSettings.setCustomNextFireAt(next, for: task.id)
    }
```
  - Extend `runDue(now:)` to also run due custom tasks via `runCustomTask` inside the same `runTask`:

```swift
    @discardableResult
    func runDue(now: Date = Date()) -> Bool {
        let dueBI = dueTasks(now: now)
        let dueC = dueCustomTasks(now: now)
        guard !(dueBI.isEmpty && dueC.isEmpty), runTask == nil else { return false }
        for t in dueBI { realignNextFire(for: t, now: now) }
        for c in dueC { realignCustomNextFire(for: c, now: now) }
        runTask = Task { [weak self] in
            for t in dueBI { await self?.runOne(t) }
            for c in dueC { await self?.runCustomTask(c) }
            self?.runTask = nil
        }
        return true
    }
```
  (Note: `config.userDefaults` — confirm `AppConfig` exposes its `UserDefaults`; if not, use `UserDefaults.standard` and note it. `CustomAutoTask.loadAll(from:)` defaults to `.standard`; the implementer should thread the same defaults the service/settings use.)

- [ ] **Step 4: Run — expect PASS.** `swift test --filter AutoCodeCustomSchedulingTests` (and re-run `AutoTaskSettingsCronTests`).
- [ ] **Step 5: Commit** `feat(mac): schedule custom auto-tasks by cron (dueCustomTasks + runDue)`

---

### Task 6: UI — mode picker + cron field in `AddCustomAutoTaskSheet`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AutoCode/AddCustomAutoTaskSheet.swift` (add `@State mode` + `@State cron`; a `Picker` for mode and a `TextField` for cron; pass them into the `CustomAutoTask` on save). Also surface mode+cron on the custom-task row in `AutoCodeView` if the row exists (optional, low-risk).
- No unit test (SwiftUI sheet — manual smoke). Verify with `swift build`.

- [ ] **Step 1:** Add `@State private var mode: CustomAutoTask.Mode = .review` and `@State private var cron: String = ""`. Add a `Picker("Mode", selection: $mode) { ... }` and a `TextField("Cron (optional, e.g. 0 * * * *)", text: $cron)`. On save, set `task.mode = mode; task.cron = cron.isEmpty ? nil : cron`.
- [ ] **Step 2:** `swift build` (confirm green).
- [ ] **Step 3: Commit** `feat(mac): mode + cron fields in AddCustomAutoTaskSheet`

---

## Final verification

- [ ] `cd /Users/dinsmallade/llm-ide/mac && swift build`
- [ ] `swift test --filter CustomAutoTaskTests`
- [ ] `swift test --filter AutoCodeUpdateServiceCLITests`
- [ ] `swift test --filter AutoTaskSettingsCronTests`
- [ ] `swift test --filter AutoCodeCustomSchedulingTests`
- [ ] Full `swift test` — expect only the 2 pre-existing failures.
- [ ] Manual smoke (controller can't drive GUI): create an `.implement` custom task + a cron-scheduled one in the running app, confirm the branch/commit and the scheduled fire. Left for the user.

## Notes for the executor
- This branch is **stacked on PR #42**. When #42 merges, rebase onto `main`.
- `config.userDefaults` may not exist on `AppConfig`; if so, custom-task scheduling reads from `UserDefaults.standard` (where `CustomAutoTask` persists by default). Confirm and keep the scheduling read consistent with the persistence write.
