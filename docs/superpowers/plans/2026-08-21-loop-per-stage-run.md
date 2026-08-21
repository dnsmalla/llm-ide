# Loop Per-Stage Run from iPhone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-stage ▶ run button to the iOS Loop page that runs exactly one stage of the active project's loop, routed through the Mac's existing auto-task path.

**Architecture:** A new wire message `loop_start_stage { stageId }` (new tag, NOT a field on `loop_start`, so an old Mac fails loudly instead of silently running the whole pipeline). `LoopStageInfo` gains an optional `stageId` carrying the Mac-side `LoopStage.id`. On the Mac, the inline "disable every other stage" mapping from `LoopEngineView.runLoop(only:)` moves into a shared `LoopStage.soloing` helper used by both the desktop menu and a new `onlyStageId` parameter threaded into `runLoopEngineeringSweep` via a dedicated `AutoCodeUpdateService.runSingleLoopStage(stageId:)` entry point (shares the `runTask` guard; `runSingle(_:)`/`runOne(_:)` signatures untouched).

**Tech Stack:** Swift (SwiftUI iOS app, SwiftUI Mac app, shared SPM package `ios_app/SharedProtocol`), XCTest.

**Spec:** `docs/superpowers/specs/2026-08-21-loop-per-stage-run-design.md`

**Environment notes for the executor:**
- Mac builds: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` (a real global git config breaks SwiftPM here; sandbox must be off for swift build).
- `cd mac && swift test` silently no-ops on this machine (Command Line Tools have no XCTest). Write the tests anyway — `make test-shared-protocol` DOES run (standalone SPM package), and the Mac tests run in CI/full-Xcode environments. Verify Mac changes compile via `swift build`.
- The pre-push hook runs `make regression` (mac build + extension tests). The extension is untouched by this plan.

---

## File map

| File | Change |
|---|---|
| `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` | Add `loopStartStage` tag |
| `ios_app/SharedProtocol/Sources/SharedProtocol/LoopMessages.swift` | Add `LoopStartStage`; add `LoopStageInfo.stageId` |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/LoopMessagesTests.swift` | New wire tests |
| `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift` | Add `LoopStage.soloing(_:id:)` |
| `mac/Tests/LlmIdeMacTests/LoopStageSoloingTests.swift` | New helper tests |
| `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` | `runLoop(only:)` uses the helper |
| `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift` | `runLoopEngineeringSweep` gains `onlyStageId` |
| `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift` | Add `runSingleLoopStage(stageId:)` + `runLoopStageOnly(stageId:)` |
| `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceLoopEngineeringTests.swift` | Unknown-stage-id sweep test |
| `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` | `buildLoopState` carries `stageId`; new `loop_start_stage` case |
| `ios_app/MyApp/Services/LoopStore.swift` | Add `startStage(stageId:)` |
| `ios_app/MyApp/Views/Control/LoopView.swift` | Per-stage ▶ button + footer text |
| `CLAUDE.md` | Mobile Loop feature bullet mentions single-stage runs |

---

### Task 1: SharedProtocol wire types

**Files:**
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` (tag block around line 79)
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/LoopMessages.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/LoopMessagesTests.swift`

- [ ] **Step 1: Write the failing tests**

Add to `LoopMessagesTests.swift` (inside the existing class):

```swift
    // MARK: — loop_start_stage (per-stage run)

    func testStartStageTagIsStableAndRoutes() {
        XCTAssertEqual(MobileProtocol.Tag.loopStartStage, "loop_start_stage")
        XCTAssertTrue(MobileProtocol.Tag.loopStartStage.hasPrefix("loop_"), "would not route")
    }

    func testStartStageRoundTripsAndCarriesOnlyTypeAndStageId() throws {
        let msg = LoopStartStage(stageId: "stage-uuid-1")
        let back = try roundTrip(msg)
        XCTAssertEqual(back, msg)
        XCTAssertEqual(back.type, MobileProtocol.Tag.loopStartStage)
        XCTAssertEqual(back.stageId, "stage-uuid-1")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder().encode(msg)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["type", "stageId"])
    }

    /// A stage row from a NEW Mac carries the Mac-side stage id the phone
    /// targets with loop_start_stage.
    func testStageInfoRoundTripsStageId() throws {
        let info = LoopStageInfo(name: "Test", kind: "shellCommand", severity: "blocking",
                                 enabled: false, order: 1, stageId: "stage-uuid-2")
        let back = try roundTrip(info)
        XCTAssertEqual(back.stageId, "stage-uuid-2")
    }

    /// A stage row from an OLD Mac (no stageId key) must decode with nil —
    /// the phone then hides its per-stage run button instead of failing the
    /// whole snapshot decode.
    func testStageInfoDecodesOldMacJSONWithoutStageId() throws {
        let oldMacJSON = Data("""
        {"name":"Regression","kind":"regressionSweep","severity":"blocking","enabled":true,"order":0}
        """.utf8)
        let info = try JSONDecoder().decode(LoopStageInfo.self, from: oldMacJSON)
        XCTAssertNil(info.stageId)
        XCTAssertEqual(info.name, "Regression")
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/dinesh.malla/llm-ide && make test-shared-protocol`
Expected: BUILD FAILURE — `LoopStartStage` and `Tag.loopStartStage` not defined (compile error counts as the failing state for wire-type TDD).

- [ ] **Step 3: Implement the wire types**

In `MobileProtocol.swift`, after `public static let loopStart = "loop_start"` (line 79):

```swift
        public static let loopStartStage = "loop_start_stage"
```

In `LoopMessages.swift`, change `LoopStageInfo` (keep everything else identical — only the new property, doc comment, and init parameter are added):

```swift
public struct LoopStageInfo: Codable, Equatable, Identifiable {
    public let name: String
    /// `LoopStage.Kind` raw value — "regressionSweep" | "shellCommand" | …
    public let kind: String
    /// `LoopStageSeverity` raw value — whether a failure blocks the run.
    public let severity: String
    public let enabled: Bool
    public let order: Int
    /// Mac-side `LoopStage.id` — the handle `loop_start_stage` targets.
    /// Optional: an older Mac's snapshot omits it, and the phone then hides
    /// its per-stage run buttons rather than sending an id it doesn't have.
    public let stageId: String?
    public var id: String { "\(order)-\(name)" }

    public init(name: String, kind: String, severity: String, enabled: Bool, order: Int,
                stageId: String? = nil) {
        self.name = name
        self.kind = kind
        self.severity = severity
        self.enabled = enabled
        self.order = order
        self.stageId = stageId
    }
}
```

In `LoopMessages.swift`, after the `LoopStart` struct:

```swift
/// Run exactly one stage of the active project's loop — the Mac force-enables
/// it and disables every other stage for this one run, the same semantics as
/// the desktop's "Run this stage only" menu action. A NEW tag rather than an
/// optional field on `LoopStart`: an older Mac ignores unknown JSON fields, so
/// a one-stage request would silently run the WHOLE pipeline; an unknown tag
/// gets no reply at all, which the phone already surfaces as "the Mac didn't
/// answer".
public struct LoopStartStage: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopStartStage
    public let stageId: String
    public init(stageId: String) { self.stageId = stageId }
    private enum CodingKeys: String, CodingKey { case type, stageId }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/dinesh.malla/llm-ide && make test-shared-protocol`
Expected: all SharedProtocol tests PASS, including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol
git commit -m "feat(mobile): loop_start_stage wire message + stage ids in loop snapshots"
```

---

### Task 2: Mac solo-mapping helper

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift:1123-1136` (`runLoop(only:)`)
- Create: `mac/Tests/LlmIdeMacTests/LoopStageSoloingTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/LoopStageSoloingTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The one shared implementation of "Run this stage only" — the desktop menu
/// action and the phone-triggered sweep both use it, so its contract is
/// pinned here: force-enable the target (even a disabled one), disable every
/// other stage, keep the full list (the journal must record the real
/// pipeline, not a fabricated one-stage config), nil for an unknown id.
final class LoopStageSoloingTests: XCTestCase {

    private func stage(_ name: String, enabled: Bool, order: Int) -> LoopStage {
        LoopStage(name: name, kind: .shellCommand, command: "true", order: order,
                  enabled: enabled)
    }

    func testSoloingDisablesEveryOtherStageAndKeepsTheFullList() throws {
        let stages = [stage("A", enabled: true, order: 0),
                      stage("B", enabled: true, order: 1),
                      stage("C", enabled: true, order: 2)]
        let soloed = try XCTUnwrap(LoopStage.soloing(stages, id: stages[1].id))
        XCTAssertEqual(soloed.count, 3, "full list survives — journal records the real pipeline")
        XCTAssertEqual(soloed.map(\.enabled), [false, true, false])
        XCTAssertEqual(soloed.map(\.name), ["A", "B", "C"], "order and identity untouched")
    }

    func testSoloingForceEnablesADisabledTarget() throws {
        let stages = [stage("A", enabled: true, order: 0),
                      stage("B", enabled: false, order: 1)]
        let soloed = try XCTUnwrap(LoopStage.soloing(stages, id: stages[1].id))
        XCTAssertEqual(soloed.map(\.enabled), [false, true])
    }

    func testSoloingReturnsNilForAnUnknownId() {
        let stages = [stage("A", enabled: true, order: 0)]
        XCTAssertNil(LoopStage.soloing(stages, id: "no-such-stage"))
    }
}
```

- [ ] **Step 2: Verify the failing state**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests 2>&1 | tail -5`
Expected: FAILS — `LoopStage.soloing` not defined. (If `--build-tests` is unavailable in this SwiftPM, `swift test` compiling the test target reports the same error; on machines without XCTest, treat the compile error from `swift build --build-tests` as the failing state.)

- [ ] **Step 3: Implement the helper**

Add to `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift` (inside `struct LoopStage`, e.g. after the `severity` property):

```swift
    /// "Run this stage only": force-enable the stage carrying `id` and disable
    /// every other stage, for one run. The FULL list is kept (rather than
    /// fabricating a one-stage config) so the journal snapshot records the
    /// project's real pipeline with the skipped stages marked disabled — not a
    /// record that reads as "the user deleted their whole pipeline". Returns
    /// nil when no stage carries `id`, so callers refuse the run instead of
    /// silently running everything. Shared by the desktop's "Run this stage
    /// only" menu action and the phone's `loop_start_stage`.
    static func soloing(_ stages: [LoopStage], id: String) -> [LoopStage]? {
        guard stages.contains(where: { $0.id == id }) else { return nil }
        return stages.map { stage in
            var copy = stage
            copy.enabled = (stage.id == id)
            return copy
        }
    }
```

- [ ] **Step 4: Refactor the desktop call site to use it**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`, `runLoop(only:)` — replace this block:

```swift
        var runConfig = currentConfig
        if let solo = single {
            // "Run this stage only" = run with every OTHER stage disabled for
            // this one run. Keeping the full stage list (rather than
            // fabricating a one-stage config) means the journal snapshot
            // records the project's real pipeline with the skipped stages
            // marked disabled — not a record that reads as "the user deleted
            // their whole pipeline".
            runConfig.stages = runConfig.stages.map { stage in
                var copy = stage
                copy.enabled = (stage.id == solo.id)
                return copy
            }
        }
```

with:

```swift
        var runConfig = currentConfig
        if let solo = single,
           let soloed = LoopStage.soloing(runConfig.stages, id: solo.id) {
            // "Run this stage only" — see LoopStage.soloing for why the full
            // stage list is kept with the others disabled.
            runConfig.stages = soloed
        }
```

- [ ] **Step 5: Build + run tests**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -3 && swift test --filter LoopStageSoloingTests 2>&1 | tail -3`
Expected: `Build complete!`; tests PASS (or silently no-op on machines without XCTest — the build succeeding is the local gate).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift mac/Tests/LlmIdeMacTests/LoopStageSoloingTests.swift
git commit -m "refactor(mac): extract the Run-this-stage-only mapping into LoopStage.soloing"
```

---

### Task 3: Thread `onlyStageId` through the auto-task sweep

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift` (`runLoopEngineeringSweep`, signature ~line 618, config block ~line 683)
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift` (after `runSingle(_:)`, ~line 203)
- Test: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceLoopEngineeringTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `AutoCodeUpdateServiceLoopEngineeringTests.swift`:

```swift
    /// A phone can ask for a stage that was deleted or renamed after its
    /// snapshot. The sweep must refuse with a task error and never start the
    /// runner — not fall back to running the whole pipeline.
    func testUnknownOnlyStageIdRefusesTheRunWithATaskError() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-eng-solo-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let service = makeService()
        await service.runLoopEngineeringSweep(
            projectRoot: tempDir.path,
            gitRoot: tempDir.path,
            projectId: "solo-test-\(UUID().uuidString)",
            defaults: suite,
            onlyStageId: "no-such-stage-id")

        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue],
                       "Loop skipped — the requested stage no longer exists.")
    }
```

- [ ] **Step 2: Verify the failing state**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests 2>&1 | tail -5`
Expected: FAILS — `runLoopEngineeringSweep` has no `onlyStageId` parameter.

- [ ] **Step 3: Extend the sweep**

In `AutoCodeUpdateService+PipelineTasks.swift`:

(a) Signature — add the parameter after `defaults` and document it:

```swift
    /// - Parameter onlyStageId: When set, run just this one stage — the
    ///   phone's `loop_start_stage` counterpart to the desktop's "Run this
    ///   stage only". Applied AFTER the config is loaded and
    ///   `ensureDefaultStages` runs, via the same `LoopStage.soloing` mapping
    ///   the desktop uses: the target is force-enabled, every other stage is
    ///   disabled for this run only, and the saved config is untouched. An id
    ///   that matches no stage refuses the run — falling back to the full
    ///   pipeline would silently do far more than the user asked for.
    func runLoopEngineeringSweep(
        projectRoot: String, gitRoot: String, projectId: String?,
        defaults: UserDefaults = .standard, onlyStageId: String? = nil
    ) async {
```

(b) Where the config is finalized, change `let` to `var` and apply the solo mapping. Replace:

```swift
        let projectConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRootURL)
```

with:

```swift
        var projectConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRootURL)
        if let onlyStageId {
            guard let soloed = LoopStage.soloing(projectConfig.stages, id: onlyStageId) else {
                taskErrors[AutoTask.loopEngineering.rawValue] =
                    "Loop skipped — the requested stage no longer exists."
                logStore.append(.loopEngineering,
                                "Loop skipped — single-stage run asked for a stage that no longer exists.",
                                level: .error)
                return
            }
            projectConfig.stages = soloed
        }
```

The existing `enabledStageCount` computation directly below stays as-is — a soloed config has exactly one enabled stage, so the "every stage disabled → parked" guard passes and the success message ("all 1 enabled stage(s) passed … (N disabled stage(s) skipped)") stays coherent.

(c) In `AutoCodeUpdateService.swift`, after `runSingle(_:)` (~line 203), add the dedicated entry point. It follows the file's existing pattern of per-entry-point shells (`runOne(_:)` and `runCustomTask(_:)` are siblings with the same shape):

```swift
    /// Phone-triggered "Run this stage only" (`loop_start_stage`). A dedicated
    /// entry point rather than a parameter on `runSingle(_:)`: no other task
    /// has a use for a stage id, and this keeps the generic signatures
    /// untouched. Shares the `runTask` re-entrancy guard, so it can never
    /// overlap a global run, a per-task run, or a custom run.
    @discardableResult
    func runSingleLoopStage(stageId: String) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.runLoopStageOnly(stageId: stageId)
            self?.runTask = nil
        }
        return true
    }

    /// Body for `runSingleLoopStage(stageId:)` — the `.loopEngineering` slice
    /// of `runOne(_:)` with the stage filter threaded through. Kept separate
    /// for the same reason `runCustomTask(_:)` is: the resolve/guard shell is
    /// per-entry-point state management, not shareable logic.
    private func runLoopStageOnly(stageId: String) async {
        guard !isRunning else { return }
        isRunning = true
        defer {
            isRunning = false
            currentTask = nil
            currentStep = nil
            lastRunDate = Date()
        }
        guard let resolved = resolveBackendAndProject() else {
            let reason = lastResolveDiagnosis ?? "No linked repo — configure in GitLab or GitHub settings"
            statusMessage = "No linked repo"
            logStore.append(.loopEngineering, "⚠ \(reason)", level: .error)
            taskErrors[AutoTask.loopEngineering.rawValue] = reason
            return
        }
        currentTask = .loopEngineering
        currentStep = "Running Loop stage"
        logStore.append(.loopEngineering, "Running Loop (single stage)…")
        await runLoopEngineeringSweep(projectRoot: resolved.projectRoot,
                                      gitRoot: resolved.gitRoot,
                                      projectId: projectStore?.activeProject?.bundle.id,
                                      onlyStageId: stageId)
    }
```

- [ ] **Step 4: Build + run tests**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -3 && swift test --filter AutoCodeUpdateServiceLoopEngineeringTests 2>&1 | tail -3`
Expected: `Build complete!`; tests PASS (or no-op without XCTest — build is the local gate).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCode mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceLoopEngineeringTests.swift
git commit -m "feat(mac): single-stage loop runs through the auto-task path (runSingleLoopStage)"
```

---

### Task 4: MobileControlManager — stage ids out, `loop_start_stage` in

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (`buildLoopState` ~line 925; `handleLoop` ~line 865, before the `loopStop` case)

- [ ] **Step 1: Carry `stageId` in the snapshot**

In `buildLoopState()`, extend the stage mapping (only the `stageId:` argument is new):

```swift
            stages: (loopConfig?.stages ?? [])
                .sorted { $0.order < $1.order }
                .map {
                    LoopStageInfo(name: $0.name, kind: $0.kind.rawValue,
                                  severity: $0.severity.rawValue,
                                  enabled: $0.enabled ?? true, order: $0.order,
                                  stageId: $0.id)
                }
```

(If the compiler reports that `$0.enabled` is non-optional and `?? true` fails to build, keep whatever the current file has for that argument — this task changes ONLY the `stageId:` line.)

- [ ] **Step 2: Handle `loop_start_stage`**

In `handleLoop(type:data:)`, add a new case between `loopStart` and `loopStop`:

```swift
        case MobileProtocol.Tag.loopStartStage:
            guard let req = try? decoder.decode(LoopStartStage.self, from: data),
                  !req.stageId.isEmpty else {
                reply(CommandError(commandId: "loop_start_stage",
                                   message: "Malformed loop_start_stage payload."))
                return
            }
            guard let autoCode else {
                append(.stderr, "loop_start_stage: auto-code service not wired")
                reply(CommandError(commandId: "loop_start_stage",
                                   message: "The Mac app can't run a loop right now — its auto-code service isn't wired up."))
                return
            }
            let state = buildLoopState()
            guard state.configured else {
                append(.stderr, "loop_start_stage: no project or no saved loop config")
                reply(LoopAck(accepted: false,
                              message: "No loop is set up for the active project. Create one on the Mac first."))
                return
            }
            guard !state.running else {
                append(.info, "loop_start_stage ignored — a run is already in flight")
                reply(LoopAck(accepted: false, message: "A loop run is already in progress."))
                return
            }
            // The stage can vanish between the phone's snapshot and this tap
            // (deleted or replaced on the Mac). Refuse by name-able identity
            // rather than letting the sweep discover it later — the phone gets
            // an actionable message instead of a task error it can't see.
            guard let stage = state.stages.first(where: { $0.stageId == req.stageId }) else {
                append(.stderr, "loop_start_stage: unknown stage id")
                reply(LoopAck(accepted: false,
                              message: "That stage no longer exists — refresh and try again."))
                return
            }
            let started = autoCode.runSingleLoopStage(stageId: req.stageId)
            loopStartedHere = started
            append(started ? .info : .stderr,
                   "loop_start_stage \(started ? "accepted" : "declined by scheduler") — \(stage.name)")
            reply(LoopAck(accepted: started,
                          message: started ? "Stage \"\(stage.name)\" started."
                                           : "The Mac declined to start a run right now."))
```

- [ ] **Step 3: Build**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobileControlManager.swift
git commit -m "feat(mac): handle loop_start_stage from the phone; snapshots carry stage ids"
```

---

### Task 5: iOS — per-stage ▶ button

**Files:**
- Modify: `ios_app/MyApp/Services/LoopStore.swift` (after `start()`, ~line 74)
- Modify: `ios_app/MyApp/Views/Control/LoopView.swift` (`stagesSection`, lines 155-179)

- [ ] **Step 1: Add the sender**

In `LoopStore.swift`, after `start()`:

```swift
    /// Run exactly one stage. The Mac force-enables it and disables the rest
    /// for this run — the same semantics as the desktop's "Run this stage
    /// only" menu action. Declines (already running, stage vanished) arrive as
    /// a `LoopAck` with `accepted: false`, shown as a status like `start()`'s.
    func startStage(stageId: String) {
        lastError = nil
        connection?.sendEncodable(LoopStartStage(stageId: stageId))
    }
```

- [ ] **Step 2: Add the button**

In `LoopView.swift`, replace the whole `stagesSection` with:

```swift
    @ViewBuilder
    private func stagesSection(_ s: LoopState) -> some View {
        if !s.stages.isEmpty {
            Section("Stages (\(s.stages.count))") {
                ForEach(s.stages) { stage in
                    HStack {
                        Image(systemName: stage.enabled ? "checkmark.circle" : "circle.slash")
                            .foregroundStyle(stage.enabled
                                             ? DesignSystem.Colors.primary
                                             : DesignSystem.Colors.textTertiary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(stage.name).font(DesignSystem.Typography.bodyFont)
                            Text("\(stage.kind) · \(stage.severity)")
                                .font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        Spacer()
                        // Only a Mac new enough to send stage ids can run one
                        // stage — hide the button entirely on older snapshots
                        // rather than showing a control that cannot work.
                        // Enabled even for disabled stages: the Mac
                        // force-enables the target for a solo run, matching
                        // the desktop's "Run this stage only".
                        if let stageId = stage.stageId {
                            Button {
                                loopStore.startStage(stageId: stageId)
                            } label: {
                                Image(systemName: "play.circle")
                            }
                            .buttonStyle(.borderless)
                            .disabled(s.running || !isConnected)
                            .accessibilityLabel("Run \(stage.name) only")
                        }
                    }
                }
                Text("Edit stages on the Mac. ▶ runs just that stage.")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
    }
```

- [ ] **Step 3: Compile check**

Run: `cd /Users/dinesh.malla/llm-ide/ios_app && xcodebuild -list -project MyApp.xcodeproj 2>/dev/null | head -20`
Then build with the scheme that listing shows (expected scheme `MyApp`):
`xcodebuild -project MyApp.xcodeproj -scheme MyApp -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -5`
Expected: `BUILD SUCCEEDED`. If `xcodebuild` is unavailable or no simulator SDK is installed, open `MyApp.xcodeproj` in Xcode and build (Cmd-B) — record the result honestly either way.

- [ ] **Step 4: Commit**

```bash
git add ios_app/MyApp/Services/LoopStore.swift ios_app/MyApp/Views/Control/LoopView.swift
git commit -m "feat(ios): per-stage run button on the Loop page"
```

---

### Task 6: Docs, final verification, push

**Files:**
- Modify: `CLAUDE.md` (Mobile Control System → Features bullet for Loop)

- [ ] **Step 1: Update the feature bullet**

In `CLAUDE.md`, change:

```markdown
- **Loop** — Start/stop the active project's Loop, watch the live log, read finished runs (control only; stages and budgets are edited on the Mac)
```

to:

```markdown
- **Loop** — Start/stop the active project's Loop — the whole run or a single stage — watch the live log, read finished runs (control only; stages and budgets are edited on the Mac)
```

(Match the exact current wording in the file; the change is inserting "— the whole run or a single stage —".)

- [ ] **Step 2: Full local verification**

```bash
cd /Users/dinesh.malla/llm-ide && make test-shared-protocol
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -3
```
Expected: SharedProtocol tests PASS; `Build complete!`.

- [ ] **Step 3: Manual device verification (requires the user or a simulator + the Mac app running)**

- [ ] Stages list shows a ▶ next to each stage (paired with an updated Mac)
- [ ] Tapping ▶ on one stage starts a run; status flips to Running; live log shows only that stage's lines
- [ ] The run's success line reads "all 1 enabled stage(s) passed … (N disabled stage(s) skipped)"
- [ ] ▶ on a DISABLED stage still runs it (force-enable semantics)
- [ ] While running, every ▶ and Start are disabled; Stop works
- [ ] Finished single-stage run appears in Recent runs
- [ ] Mac desktop Loop page's own "Run this stage only" still works (helper refactor)

- [ ] **Step 4: Commit docs and push**

```bash
git add CLAUDE.md
git commit -m "docs: mobile Loop feature bullet covers single-stage runs"
git push
```
Expected: pre-push regression gate (mac build + extension tests) passes; push succeeds.

---

## Self-review notes (already applied)

- Spec coverage: wire types (Task 1), solo helper + desktop refactor (Task 2), sweep threading + dedicated entry point (Task 3), snapshot stageId + handler with all four error cases (Task 4), iOS store/view (Task 5), docs + manual checklist (Task 6). The spec's "old Mac + new phone" case needs no task — it is the absence of a handler, verified by the existing watchdog banner.
- Type consistency: `LoopStage.soloing(_:id:) -> [LoopStage]?` is used with that exact signature in Tasks 2, 3; `runSingleLoopStage(stageId: String) -> Bool` in Tasks 3, 4; `LoopStartStage(stageId:)` and `LoopStageInfo(... stageId:)` in Tasks 1, 4, 5.
- `LoopStage`'s memberwise init in the helper tests relies on its defaulted properties (`id`, `enabled`, etc. all have defaults); the test constructs with `name/kind/command/order/enabled`, all real members.
