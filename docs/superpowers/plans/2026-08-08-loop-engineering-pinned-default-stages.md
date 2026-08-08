# Loop Engineering — pinned default stages + row ⋯ menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default Regression + Test stages pinned and undeletable (always present, re-ensured on load), and move deletion of user-added stages behind a ⋯ (three-dot) menu on each stage row (Duplicate for all; Delete for non-pinned only).

**Architecture:** Add a per-stage `isDefault` flag the detector sets on the stages it seeds; add a shared `LoopStageDetector.ensureDefaultStages(in:gitRoot:)` helper that the three config-load sites call so the invariant holds for saved and legacy configs too. Replace the always-visible "Remove Stage" button with a row-level ⋯ Menu (Duplicate always; Delete only when `!isDefault`); pinned rows show a lock badge.

**Tech Stack:** Swift 5 (SwiftUI, `@Observable`), SPM package at `mac/`, XCTest (`@testable import LlmIdeMacLib`). Build/test from `mac/`.

## Global Constraints

- All work in the `mac/` SPM package. Build: `cd /Users/dinsmallade/llm-ide/mac && swift build`. Test: `cd /Users/dinsmallade/llm-ide/mac && swift test`.
- Test framework is **XCTest** with `@testable import LlmIdeMacLib` (the lib module, not the app target). `@MainActor` on test classes touching `@MainActor` types.
- **Conventional Commits**, one concern per commit. End every commit message with a blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Do all work on a feature branch off `main`. Do **not** push.
- `LoopStage.isDefault` must be appended **last** (after `prompt`) with `= false` so every existing `LoopStage(id:name:kind:command:order:)` call site still compiles and old JSON decodes with `false`.
- Pinned stages are **editable, not deletable**. Do not lock editing. Do not add templates (Phase 2) or a reorder UI (Phase 3). Do not change runner execution or `shouldPersist`.
- Subagents must NOT spawn their own sub-agents. SourceKit/LCP errors are stale here — verify ONLY via `swift build`/`swift test`.
- BASELINE: `swift test` has 2 PRE-EXISTING failures on `main`, unrelated — `SCMParsersTests.testBlankLineWithinHunkIsEmptyContextRow`, `SavedRepoPathReconcilerTests.testAllNormalizationsCombinedStillMatch`. Do not touch them. A task passes if its relevant suites are green and it adds no new failures beyond those 2.

---

## Task 0: Branch + baseline

**Files:** none

- [ ] **Step 1: Branch off `main`**

Run:
```bash
cd /Users/dinsmallade/llm-ide
git checkout main
git checkout -b feat/loop-pinned-default-stages
```
Expected: `Switched to a new branch 'feat/loop-pinned-default-stages'`. Record HEAD as BASE.

- [ ] **Step 2: Confirm baseline**

Run:
```bash
cd mac && swift build && swift test 2>&1 | grep -E "Executed [0-9]+ tests, with [0-9]+ failure" | tail -1
```
Expected: build succeeds; exactly **2 failures** (the known pre-existing ones).

---

## Task 1: `LoopStage.isDefault` field (+ Codable round-trip)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopStageTests.swift`

**Interfaces:**
- Produces: `LoopStage.isDefault: Bool` (default `false`), appended after `prompt`. Later tasks: the detector sets it `true`; the UI gates Delete on `!isDefault`.

- [ ] **Step 1: Add the failing tests**

In `mac/Tests/LlmIdeMacTests/LoopStageTests.swift`, append two tests inside the class:
```swift
    func testIsDefaultRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0, isDefault: true)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertTrue(decoded.isDefault)
    }

    func testOldPayloadWithoutIsDefaultDecodesFalse() throws {
        // A stage saved before isDefault existed must decode as a normal, deletable stage.
        let json = """
        {"id":"t1","name":"Test","kind":"shellCommand","command":"swift test","order":1,
         "skillId":null,"targetPath":null,"prompt":null}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LoopStage.self, from: json)
        XCTAssertEqual(decoded.isDefault, false)
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd mac && swift test --filter LoopStageTests 2>&1 | tail -6`
Expected: FAIL / compile error — `isDefault` is not a member and the extra arg is rejected.

- [ ] **Step 3: Add the field (last, with a default)**

In `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`, append after the `prompt` field (after line 28):
```swift
    /// True for the detector-seeded default stages (Regression + Test). Default stages are
    /// always present (re-ensured on load) and cannot be deleted; they remain editable.
    /// User-added stages (the `+` menu, duplicates) are `false`.
    var isDefault: Bool = false
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mac && swift test --filter LoopStageTests`
Expected: PASS (5 tests — the 3 existing + 2 new). Existing positional call sites still compile (the new trailing defaulted param is omitted).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift mac/Tests/LlmIdeMacTests/LoopStageTests.swift
git commit -m "feat(mac): add isDefault field to LoopStage

Codable-additive (default false, appended last). Marks detector-seeded
default stages as pinned/undeletable; user-added stages stay false.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Detector pins defaults + `ensureDefaultStages` helper + wire load sites

The detector marks its seeded stages `isDefault = true`. A new `ensureDefaultStages(in:gitRoot:)` helper makes the "one pinned Regression always; one pinned Test iff tooling detected" invariant hold for every config (including legacy ones saved before the flag). All three config-load sites call it.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` (`loadConfig()`, ~L437)
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift` (~L142)
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift` (~L549)
- Test: `mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift`, `mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift`

**Interfaces:**
- Consumes: `LoopStage.isDefault` (Task 1).
- Produces: `LoopStageDetector.ensureDefaultStages(in: LoopEngineConfig, gitRoot: URL?) -> LoopEngineConfig` — pure, idempotent. The three load sites call it; the UI (Task 3) consumes `stage.isDefault`.

- [ ] **Step 1: Add the failing detector + ensure tests**

In `mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift`, add (the class already has a `tempDir` + `write(_:_:)` helper):
```swift
    func testDetectorMarksRegressionAsDefault() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.first?.isDefault, true)
    }

    func testDetectorMarksTestAsDefaultWhenToolingDetected() throws {
        try write("Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let testStage = stages.first { $0.kind == .shellCommand }
        XCTAssertNotNil(testStage)
        XCTAssertEqual(testStage?.isDefault, true)
    }
```

In `mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift`, add (the class already has an isolated `suite` + setUp/tearDown):
```swift
    func testEnsurePinsRegressionAndPreservesCommand() throws {
        // Legacy config: stages saved before isDefault — both unpinned.
        var config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0),
            LoopStage(name: "My Tests", kind: .shellCommand, command: "custom-runner", order: 1)
        ])
        // tempDir has no project markers → no Test default expected; Regression is the only default.
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: nil)
        // Regression pinned in place…
        XCTAssertEqual(ensured.stages.first { $0.kind == .regressionSweep }?.isDefault, true)
        // …and the user's shell stage is left UNpinned (no tooling → no pinned Test) and unchanged.
        let shell = ensured.stages.first { $0.kind == .shellCommand }
        XCTAssertEqual(shell?.command, "custom-runner")
        XCTAssertEqual(shell?.isDefault, false)
        _ = config // silence unused where needed
    }

    func testEnsureAddsRegressionIfMissing() {
        let config = LoopEngineConfig(stages: [
            LoopStage(name: "My Tests", kind: .shellCommand, command: "x", order: 0)
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: nil)
        XCTAssertTrue(ensured.stages.contains { $0.kind == .regressionSweep && $0.isDefault })
    }

    func testEnsurePinsExistingTestWhenToolingDetected() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ensure-tooling-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "Package.swift".write(to: dir.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)

        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0),
            LoopStage(name: "My Tests", kind: .shellCommand, command: "npm test", order: 1)  // user's own command
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: dir)
        XCTAssertEqual(ensured.stages.first { $0.kind == .regressionSweep }?.isDefault, true)
        // Tooling detected → the existing shell stage is pinned in place; its command is NOT overwritten.
        let shell = ensured.stages.first { $0.kind == .shellCommand }
        XCTAssertEqual(shell?.isDefault, true)
        XCTAssertEqual(shell?.command, "npm test")
    }

    func testEnsureAddsTestIfToolingButMissing() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ensure-add-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "Package.swift".write(to: dir.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)

        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: dir)
        XCTAssertTrue(ensured.stages.contains { $0.kind == .shellCommand && $0.isDefault })
    }

    func testEnsureIsIdempotent() {
        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ])
        let once = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: nil)
        let twice = LoopStageDetector.ensureDefaultStages(in: once, gitRoot: nil)
        XCTAssertEqual(once.stages.count, twice.stages.count)
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd mac && swift test --filter LoopStageDetectorTests --filter LoopEngineConfigTests 2>&1 | tail -8`
Expected: FAIL — `isDefault` not set by the detector (the regression-isDefault test fails), and `ensureDefaultStages` does not exist.

- [ ] **Step 3: Refactor the detector to pin defaults + add the helper**

Replace the body of `detectDefaultStages` and add the helper in `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift`. The full updated file:
```swift
import Foundation

/// Sniffs a repo's root for common test-command conventions to propose a
/// default stage list, the first time a project has no saved
/// `LoopEngineConfig`. The user edits/overrides from there — this only
/// ever runs once per project (see `LoopEngineView`).
enum LoopStageDetector {
    static func detectDefaultStages(gitRoot: URL) -> [LoopStage] {
        defaultStages(gitRoot: gitRoot)
    }

    /// The canonical default stage list, each marked `isDefault = true`:
    /// Regression always; a Test (`shellCommand`) only when test tooling is
    /// detected at `gitRoot`. `gitRoot == nil` ⇒ Regression only (no tooling
    /// to detect).
    private static func defaultStages(gitRoot: URL?) -> [LoopStage] {
        var stages: [LoopStage] = [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0, isDefault: true)
        ]
        if let gitRoot, let testCommand = detectTestCommand(gitRoot: gitRoot) {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand, order: 1, isDefault: true))
        }
        return stages
    }

    /// Ensure `config` contains the detector's default stages, each pinned
    /// (`isDefault = true`): Regression always; a Test only when tooling is
    /// detected at `gitRoot`. The first existing stage of each default kind
    /// is pinned IN PLACE (its command/edits preserved); a default is appended
    /// only if no stage of that kind exists. User-added stages and their
    /// commands are never modified. Pure + idempotent. Called by all three
    /// config-load sites so saved and legacy configs honor the pinned-defaults
    /// invariant (one shared helper, mirroring `shouldPersist`'s rationale).
    static func ensureDefaultStages(in config: LoopEngineConfig, gitRoot: URL?) -> LoopEngineConfig {
        var stages = config.stages
        for def in defaultStages(gitRoot: gitRoot) {
            if let idx = stages.firstIndex(where: { $0.kind == def.kind }) {
                stages[idx].isDefault = true
            } else {
                stages.append(def)
            }
        }
        return LoopEngineConfig(stages: stages,
                                maxIterations: config.maxIterations,
                                consecutiveFailureStop: config.consecutiveFailureStop)
    }

    private static func detectTestCommand(gitRoot: URL) -> String? {
        let fm = FileManager.default

        if fm.fileExists(atPath: gitRoot.appendingPathComponent("Package.swift").path) {
            return "swift test"
        }

        if let data = try? Data(contentsOf: gitRoot.appendingPathComponent("package.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let scripts = obj["scripts"] as? [String: Any],
           scripts["test"] != nil {
            return "npm test"
        }

        if let makefile = try? String(
            contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8
        ), makefile.range(of: #"(?m)^(test|regression):"#, options: .regularExpression) != nil {
            return "make test"
        }

        let pytestMarkers = ["pytest.ini", "pyproject.toml", "setup.cfg"]
        for marker in pytestMarkers {
            let path = gitRoot.appendingPathComponent(marker)
            if fm.fileExists(atPath: path.path) {
                if marker == "pytest.ini" { return "pytest" }
                if let contents = try? String(contentsOf: path, encoding: .utf8),
                   contents.contains("pytest") {
                    return "pytest"
                }
            }
        }

        return nil
    }
}
```

- [ ] **Step 4: Wire `LoopEngineView.loadConfig()` saved path**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` `loadConfig()` (~L437), wrap the saved config so pinned defaults are ensured. Replace:
```swift
        if let saved = LoopEngineConfig.load(for: projectId) {
            stages = saved.stages
            maxIterations = saved.maxIterations
            consecutiveFailureStop = saved.consecutiveFailureStop
        } else if let gitRoot = activeGitRootURL {
```
with:
```swift
        if let saved = LoopEngineConfig.load(for: projectId) {
            let ensured = LoopStageDetector.ensureDefaultStages(in: saved, gitRoot: activeGitRootURL)
            stages = ensured.stages
            maxIterations = ensured.maxIterations
            consecutiveFailureStop = ensured.consecutiveFailureStop
        } else if let gitRoot = activeGitRootURL {
```
(The `else if` detection branch is unchanged — `detectDefaultStages` already marks its output `isDefault`.)

- [ ] **Step 5: Wire the chat panel load**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift` (~L142), wrap the load-or-detect so saved configs are ensured too. Replace:
```swift
        let loopConfig = LoopEngineConfig.load(for: projectId) ?? {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            let detected = LoopEngineConfig(stages: detectedStages)
            // Only persist when detection found real tooling beyond the bare
            // Regression stage — same policy as the Auto Task sweep's own
            // guard and LoopEngineView.loadConfig(), so this chat path can't
            // permanently lock in a Regression-only config if it happens to
            // run first against a not-yet-fully-detectable repo.
            if LoopEngineConfig.shouldPersist(detectedStages) {
                detected.save(for: projectId)
            }
            return detected
        }()
```
with:
```swift
        let raw = LoopEngineConfig.load(for: projectId) ?? {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            let detected = LoopEngineConfig(stages: detectedStages)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                detected.save(for: projectId)
            }
            return detected
        }()
        let loopConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRoot)
```

- [ ] **Step 6: Wire the Auto Task sweep load**

In `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift` (~L549), ensure the final config. Replace:
```swift
        let projectConfig: LoopEngineConfig
        if let saved = LoopEngineConfig.load(for: projectId, defaults: defaults) {
            projectConfig = saved
        } else {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRootURL)
            let detected = LoopEngineConfig(stages: detectedStages)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                detected.save(for: projectId, defaults: defaults)
            }
            projectConfig = detected
        }
```
with:
```swift
        let raw: LoopEngineConfig
        if let saved = LoopEngineConfig.load(for: projectId, defaults: defaults) {
            raw = saved
        } else {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRootURL)
            let detected = LoopEngineConfig(stages: detectedStages)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                detected.save(for: projectId, defaults: defaults)
            }
            raw = detected
        }
        let projectConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRootURL)
```

- [ ] **Step 7: Build + run the relevant suites**

Run:
```bash
cd mac && swift build && swift test --filter LoopStageDetectorTests && swift test --filter LoopEngineConfigTests && swift test --filter LoopStageTests
```
Expected: build succeeds; all three suites green (the 2 new detector tests + 5 new ensure tests + existing, all passing). The existing detector tests still pass (their assertions on `.first`/`.count`/`.command` are unaffected by the added `isDefault`).

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift \
        mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift \
        mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift \
        mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift \
        mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift
git commit -m "feat(mac): pin detector default stages; ensure them on every load

Detector seeds Regression (+ Test iff tooling) with isDefault=true. New
ensureDefaultStages(in:gitRoot:) re-ensures the pinned defaults for saved
and legacy configs (pins first-of-kind in place, preserves user edits);
all three config-load sites call it.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Row ⋯ menu (Duplicate/Delete) + lock badge; remove detail "Remove Stage"

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` (stage row, detail-pane button, add two helper methods)

**Interfaces:**
- Consumes: `stage.isDefault` (Tasks 1–2). Delete is gated on `!stage.isDefault`; Duplicate always sets `isDefault = false` on the copy.

- [ ] **Step 1: Add the stage-row ⋯ menu + lock badge**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`, replace the `stageRow(_:)` body (~L168-L190):
```swift
    @ViewBuilder
    private func stageRow(_ stage: LoopStage) -> some View {
        let t = theme.current
        HStack(spacing: 6) {
            Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle"
                  : stage.kind == .shellCommand ? "terminal" : "sparkles")
                .foregroundStyle(t.textMuted)
            Text(stage.name)
                .font(Typography.filename)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if stage.kind == .shellCommand,
               let command = stage.command,
               let gitRoot = activeGitRootURL,
               !approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .help("Command not yet approved on this machine")
            }
            if stage.isDefault {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .help("Default stage — can't be deleted")
            }
            Menu {
                Button("Duplicate") { duplicateStage(stage) }
                if !stage.isDefault {
                    Button("Delete", role: .destructive) { deleteStage(stage) }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.borderless)
        }
    }
```

- [ ] **Step 2: Add `duplicateStage` and `deleteStage` helpers**

Add these two `private` methods to `LoopEngineView` (e.g. alongside `resetStagesToDefaults`/`saveConfig`, ~L476):
```swift
    /// Append a non-default copy of `stage` (new id, cleared isDefault, next order).
    private func duplicateStage(_ stage: LoopStage) {
        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
        var copy = stage
        copy.id = UUID().uuidString
        copy.isDefault = false
        copy.order = nextOrder
        stages.append(copy)
    }

    /// Remove a stage by id (row ⋯ → Delete). Pinned stages never offer Delete, so this
    /// is only reachable for non-default stages. Clears the selection if it was deleted.
    private func deleteStage(_ stage: LoopStage) {
        let id = stage.id
        stages.removeAll { $0.id == id }
        if selectedStageId == id { selectedStageId = nil }
    }
```

- [ ] **Step 3: Remove the detail-pane "Remove Stage" button**

In `stageDetail(index:)`, delete the "Remove Stage" button block (~L318-L329):
```swift
            Button("Remove Stage", role: .destructive) {
                // Capture the id BEFORE mutating `stages` — reading
                // `stages[index]` again from inside removeAll's predicate
                // (which holds exclusive access to `stages` for the
                // duration of the call) would be a mutate-while-reading
                // access to the same @State storage.
                let id = stages[index].id
                stages.removeAll { $0.id == id }
                selectedStageId = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
```
(Deletion now lives in the row ⋯. The surrounding `VStack` in `stageDetail` is unchanged.)

- [ ] **Step 4: Build + run the full suite**

Run:
```bash
cd mac && swift build && swift test 2>&1 | grep -E "Executed [0-9]+ tests, with [0-9]+ failure" | tail -1
```
Expected: build succeeds; only the **2 known pre-existing failures** (the UI change adds no test failures — the row ⋯ / lock badge are covered by the manual smoke; `isDefault` gating is covered by the Task 2 detector/ensure tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift
git commit -m "feat(mac): row ⋯ menu for stage delete/duplicate; pin defaults

Each stage row gets a ⋯ (Duplicate for all; Delete only for non-default
stages) and pinned rows show a lock badge. Removes the always-visible
'Remove Stage' button from the detail pane — deletion is now a deliberate
act behind the row ⋯ and default stages can't be removed.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Final verification + manual smoke

**Files:** none

- [ ] **Step 1: Clean build + full suite**

Run:
```bash
cd mac && swift build && swift test 2>&1 | grep -E "Executed [0-9]+ tests, with [0-9]+ failure" | tail -1
```
Expected: build succeeds; exactly the **2 known pre-existing failures**, zero new.

- [ ] **Step 2: Manual smoke (build the app, click)**

Run (from repo root): `cd mac && bash build_app.sh && open "$(find .build -name LlmIdeMac.app -type d | head -1)"` (grant Accessibility if prompted). In Loop Engineering:
- The default **Regression** (+ **Test** if the project has test tooling) rows show a **lock badge** and their **⋯ has no Delete** (only Duplicate).
- A stage you add via `+` (Shell/Regression/Skill) has a **⋯ with Duplicate + Delete**.
- The detail pane **no longer has a "Remove Stage" button**.
- A pinned stage's command is **still editable** inline (e.g. change `swift test`).
- **Duplicate** any stage → a deletable copy appears.
- Quit/relaunch: the pinned defaults remain (and a project whose saved config predated the flag now shows Regression/Test pinned after the first load).

- [ ] **Step 3: Note follow-ups (no commit unless asked)**

Phase 2 = named/default templates + store; Phase 3 = reorder UI, richer source pickers. Out of scope here.

---

## Self-review

- **Spec coverage:** `isDefault` model (Task 1) ✓; detector pins defaults + `ensureDefaultStages` helper (Task 2) ✓; ensure wired at all three load sites (Task 2 steps 4–6) ✓; row ⋯ Duplicate/Delete + lock badge + detail-button removal (Task 3) ✓; pinned stages stay editable (no edit-locking added) ✓; `+` menu adds `isDefault = false` via the field default (no change needed) ✓; `shouldPersist` unchanged ✓.
- **Placeholder scan:** none — every step shows exact code or exact commands.
- **Type consistency:** `LoopStage.isDefault: Bool` matches across Task 1 (field), Task 2 (detector/ensure/tests), Task 3 (UI `stage.isDefault` + `copy.isDefault = false`). `LoopStageDetector.ensureDefaultStages(in:gitRoot:) -> LoopEngineConfig` matches across Task 2 (definition + tests) and the three wiring sites. `defaultStages(gitRoot: URL?)` is private to the detector.
- **Scope:** single focused plan (pin defaults + row ⋯); templates/reorder explicitly deferred; runner/`shouldPersist` untouched.
