# Loop Engineering — Skill generate stage (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `.skill` stage to Loop Engineering — a generate step that runs a chosen agent skill (optionally scoped to a target source) and always completes, while the existing regression/shell verify stages gate pass/fail.

**Architecture:** Reuse the runner's "one injected collaborator per stage family" seam: add a `LoopSkillExecuting` collaborator (mirroring `LoopStageRepairer`) whose adapter calls the existing one-shot agent path `api.codeAssist(..., skills:[skillId], ...)` (the same `/code-assist` call the repairer and chat "/" menu use — no server change). The new `case .skill` in the runner's stage switch runs the skill, logs, and falls through (no pass/fail/retry/approval); verify stages still decide termination.

**Tech Stack:** Swift 5 (SwiftUI, `@Observable`), SPM package at `mac/`, XCTest (`@testable import LlmIdeMacLib`, `@MainActor` test classes). Build/test from `mac/`.

## Global Constraints

- All work in the `mac/` SPM package. Build: `cd /Users/dinsmallade/llm-ide/mac && swift build`. Test: `cd /Users/dinsmallade/llm-ide/mac && swift test`.
- Test framework is **XCTest** (`import XCTest`, `@testable import LlmIdeMacLib`); `@MainActor` on test classes touching `@MainActor` types.
- **Conventional Commits**, one concern per commit (`feat(mac):`, `test(mac):`, `refactor(mac):`). End every commit message with a blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Do all work on a feature branch stacked on `feat/loop-engineering-regression-home` (this plan depends on that branch's `SweepOutcome` seam, `.regressionStalled`, default cap 10, and deleted Regression page). Do **not** push — the user pushes at the end.
- A skill stage is a **generate step with no pass/fail**: it always completes (or logs a non-fatal error); the loop's existing verify stages gate. Do **not** add approval, retry, or a new `LoopEngineStatus` case for skills.
- Do **not** touch `RegressionRunner`, `AgentLoopStageRepairer`'s behavior, `AutoTask.regression`, or `ActivityKind`. Do **not** add named/default templates (Phase 2) or a reorder UI (Phase 3).
- Subagents must NOT spawn their own sub-agents (they stall). SourceKit/LSP editor errors are stale here — verify ONLY via `swift build`/`swift test`.
- BASELINE: `swift test` has 2 PRE-EXISTING failures on this branch, unrelated to this work — `SCMParsersTests.testBlankLineWithinHunkIsEmptyContextRow`, `SavedRepoPathReconcilerTests.testAllNormalizationsCombinedStillMatch`. Do not touch them. A task passes if its relevant suites are green and it adds no new failures beyond those 2.

---

## Task 0: Stack a feature branch + verify baseline

**Files:** none

- [ ] **Step 1: Create the stacked branch**

Run (from repo root; current branch is `feat/loop-engineering-regression-home`):
```bash
cd /Users/dinsmallade/llm-ide
git checkout -b feat/loop-engineering-skill-stage
```
Expected: `Switched to a new branch 'feat/loop-engineering-skill-stage'`. This branch includes the Loop Engineering changes from the parent branch (`SweepOutcome`, `.regressionStalled`, cap 10, etc.) that this plan depends on.

- [ ] **Step 2: Confirm baseline**

Run:
```bash
cd mac && swift build && swift test 2>&1 | grep -E "Executed [0-9]+ tests, with [0-9]+ failure" | tail -1
```
Expected: build succeeds; tests show exactly **2 failures** (the known pre-existing `SCMParsers`/`SavedRepoPathReconciler` ones). Record the HEAD SHA as BASE for review packaging.

---

## Task 1: Add `.skill` to the `LoopStage` model (+ Codable round-trip)

Add the new kind and three optional fields. JSON-backward-compatible (additive optional fields after `order`).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopStageTests.swift`

**Interfaces:**
- Produces: `LoopStage.Kind.skill`, and `LoopStage.skillId: String?`, `LoopStage.targetPath: String?`, `LoopStage.prompt: String?`. The memberwise initializer gains trailing defaulted params (`skillId: String? = nil`, `targetPath: String? = nil`, `prompt: String? = nil`) so every existing `LoopStage(id:name:kind:command:order:)` / `LoopStage(name:kind:command:order:)` call still compiles.

- [ ] **Step 1: Write the failing test**

In `mac/Tests/LlmIdeMacTests/LoopStageTests.swift`, add a third test method (after the existing two):
```swift
    func testSkillStageRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "s1", name: "Fix Skill", kind: .skill,
                              command: nil, order: 2,
                              skillId: "skills/fix-code", targetPath: "~/src/App.swift",
                              prompt: "Fix the bug")
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertEqual(decoded.skillId, "skills/fix-code")
        XCTAssertEqual(decoded.targetPath, "~/src/App.swift")
        XCTAssertEqual(decoded.prompt, "Fix the bug")
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && swift test --filter LoopStageTests 2>&1 | tail -5`
Expected: FAIL / compile error — `.skill` does not exist and `skillId`/`targetPath`/`prompt` are not members.

- [ ] **Step 3: Add the kind + fields**

In `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`, add `skill` to `Kind` and the three optional fields after `order`:
```swift
struct LoopStage: Identifiable, Codable, Equatable {
    enum Kind: String, Codable {
        case regressionSweep
        case shellCommand
        case skill
    }
    var id: String = UUID().uuidString
    var name: String
    var kind: Kind
    var command: String?      // .shellCommand only
    var order: Int
    /// `.skill` only — the central-skill id ("<family>/<dir>") the server resolves
    /// to its SKILL.md and frames as a trusted instruction via /code-assist.
    var skillId: String? = nil
    /// `.skill` only — optional Library path the skill is scoped to (included in
    /// the agent message). Phase 3 may attach its content as a CodeAttachment.
    var targetPath: String? = nil
    /// `.skill` only — optional task text; empty → a built-in default message.
    var prompt: String? = nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mac && swift test --filter LoopStageTests`
Expected: PASS (3 tests). The two pre-existing round-trip tests still pass (their stages decode with nil for the new fields).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift mac/Tests/LlmIdeMacTests/LoopStageTests.swift
git commit -m "feat(mac): add .skill kind and input fields to LoopStage

Codable-additive: new optional skillId/targetPath/prompt fields and
the .skill Kind case. Existing stages decode unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `LoopSkillExecuting` protocol + `AgentLoopSkillExecutor` adapter

The new seam. The adapter runs the skill via the same one-shot agent path the repairer uses, threading `skills: [skillId]` explicitly (the repairer omits it).

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopSkillExecuting.swift`

**Interfaces:**
- Produces: `protocol LoopSkillExecuting: AnyObject { func execute(skillId: String, targetPath: String?, message: String) async throws }` and `AgentLoopSkillExecutor` (holds `api: LlmIdeAPIClient`, `language: String`). Task 3 injects this into the runner; tests stub it.

- [ ] **Step 1: Create the file**

Create `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopSkillExecuting.swift`:
```swift
import Foundation

/// Runs a `.skill` (generate) Loop stage by invoking a chosen central skill
/// via the same one-shot agent path `AgentLoopStageRepairer` and the chat "/"
/// menu use (`LlmIdeAPIClient.codeAssist` → POST /code-assist). The server
/// resolves the skill id ("<family>/<dir>") to its SKILL.md and frames it as a
/// trusted instruction. A skill stage has no pass/fail of its own — it always
/// "completes" (or throws on a transport error, which the runner logs without
/// ending the run); the loop's verify stages gate termination.
protocol LoopSkillExecuting: AnyObject {
    func execute(skillId: String, targetPath: String?, message: String) async throws
}

/// Production adapter. Mirrors `AgentLoopStageRepairer`: holds the API client
/// + language, calls `codeAssist` with `skills: [skillId]`, and discards the
/// reply — "made no edit" is not an error (the caller re-verifies via the loop).
@MainActor
final class AgentLoopSkillExecutor: LoopSkillExecuting {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    func execute(skillId: String, targetPath: String?, message: String) async throws {
        _ = try await api.codeAssist(
            message: message, language: language, model: nil,
            history: [], attachments: [], skills: [skillId], agentContext: nil)
    }
}
```
(No isolated unit test — `LlmIdeAPIClient` is a concrete class, not protocol-mocked, and `AgentLoopStageRepairer` sets the same precedent: its behavior is covered through the runner with a stub. The runner dispatch tests in Task 3 cover the `.skill` path; the live `codeAssist` wiring is verified by the manual smoke test.)

- [ ] **Step 2: Build to confirm it compiles**

Run: `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!` (the file compiles; nothing references the protocol yet).

- [ ] **Step 3: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopSkillExecuting.swift
git commit -m "feat(mac): add LoopSkillExecuting seam + AgentLoopSkillExecutor

Runs a .skill Loop stage via api.codeAssist(skills:[skillId]) — the
same one-shot agent path the repairer and chat '/' menu use. No
pass/fail; the loop's verify stages gate.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Runner `.skill` dispatch + `skillExecutor` wiring + tests

Add the `skillExecutor` collaborator to the runner, the `case .skill` dispatch (generate step, always completes), a `defaultSkillMessage(_:)` helper, and wire all construction sites + a `StubSkillExecutor` + dispatch tests. This task is compile-coherent: adding the init parameter forces every construction site to supply it.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift` (init, storage, stage switch, helper)
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift:71-74` (init construction)
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift:158-161` (construction)
- Test: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` (`StubSkillExecutor` + 3 tests; existing tests gain `skillExecutor:`)

**Interfaces:**
- Consumes: `LoopSkillExecuting` (Task 2), `LoopStage.Kind.skill` + fields (Task 1).
- Produces: a runner that dispatches `.skill` stages; the two production sites and all tests pass `skillExecutor:`.

- [ ] **Step 1: Add the failing dispatch test + stub**

In `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`, add this stub near `StubRepairer` (line ~25):
```swift
    private struct SkillError: Error {}
    private final class StubSkillExecutor: LoopSkillExecuting {
        private(set) var callCount = 0
        var throwOnEveryCall: Bool = false
        func execute(skillId: String, targetPath: String?, message: String) async throws {
            callCount += 1
            if throwOnEveryCall { throw SkillError() }
        }
    }
```
Add this test (mirrors `testAllStagesPassOnFirstIterationSucceeds`):
```swift
    func testSkillStageRunsOnceAndCompletesWhenVerifyPasses() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let skill = StubSkillExecutor()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertEqual(skill.callCount, 1)
        XCTAssertEqual(repairer.repairCount, 0)
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && swift test --filter testSkillStageRunsOnceAndCompletesWhenVerifyPasses 2>&1 | tail -5`
Expected: compile error — `LoopEngineRunner` has no `skillExecutor:` parameter.

- [ ] **Step 3: Add `skillExecutor` to the runner init + storage**

In `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`, add storage (after `private let regressionSweep…` near line 36):
```swift
    private let skillExecutor: LoopSkillExecuting
```
Change the `init` (lines 40-50) to add the parameter + assignment:
```swift
    init(verifier: FaultVerifier = ShellFaultVerifier(),
         stageRepairer: LoopStageRepairer,
         regressionSweep: RegressionSweepRunning,
         skillExecutor: LoopSkillExecuting,
         approvals: VerifyApprovalStore = VerifyApprovalStore(),
         stageTimeout: TimeInterval = 600) {
        self.verifier = verifier
        self.stageRepairer = stageRepairer
        self.regressionSweep = regressionSweep
        self.skillExecutor = skillExecutor
        self.approvals = approvals
        self.stageTimeout = stageTimeout
    }
```

- [ ] **Step 4: Add the `case .skill` dispatch**

In the same file, in the stage `switch stage.kind { … }` (the `for stage in orderedStages` loop), add a `case .skill:` immediately before the switch's closing brace (after the `case .shellCommand:` block):
```swift
                case .skill:
                    let skillId = stage.skillId ?? ""
                    let message = (stage.prompt?.isEmpty == false) ? stage.prompt! : Self.defaultSkillMessage(stage)
                    appendLog(.info, "  [\(stage.name)] running skill \(skillId.isEmpty ? "(none set)" : skillId) (generate)")
                    do {
                        try await skillExecutor.execute(skillId: skillId, targetPath: stage.targetPath, message: message)
                        appendLog(.info, "  [\(stage.name)] skill completed (generate)")
                    } catch is CancellationError {
                        status = .aborted
                        break iterationLoop
                    } catch {
                        // A generate step that errors is non-fatal: log it and let
                        // the loop's verify stages / iteration cap decide termination.
                        appendLog(.warn, "  [\(stage.name)] skill error: \(error.localizedDescription)")
                    }
```
(After this case the `for stage` loop naturally advances to the next stage — a generate step always "completes" and never forces a retry. The preflight approval loop `where stage.kind == .shellCommand` is intentionally unchanged — skill stages need no command approval.)

- [ ] **Step 5: Add the `defaultSkillMessage(_:)` helper**

In the same file, add this `private static` helper next to `regressionLine(_:)` (search for `private static func regressionLine`):
```swift
    /// Default agent message for a `.skill` stage with no user-written prompt:
    /// names the stage and, if set, the target source the skill is scoped to.
    private static func defaultSkillMessage(_ stage: LoopStage) -> String {
        var msg = "Apply the skill for stage \"\(stage.name)\"."
        if let target = stage.targetPath, !target.isEmpty {
            msg += " Target: \(target)."
        }
        return msg
    }
```

- [ ] **Step 6: Wire the two production construction sites**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` (the `_runner = StateObject(...)` block, lines 71-74), add the `skillExecutor:` argument:
```swift
        _runner = StateObject(wrappedValue: LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            skillExecutor: AgentLoopSkillExecutor(api: api),
            approvals: approvals))
```
In `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift` (lines 158-161), add the `skillExecutor:` argument (`language` is in scope):
```swift
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api, language: language),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            skillExecutor: AgentLoopSkillExecutor(api: api, language: language)
        )
```

- [ ] **Step 7: Update the existing runner tests to pass `skillExecutor:`**

In `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`, every `LoopEngineRunner(…)` construction must gain a `skillExecutor:` argument. For tests that don't exercise a skill stage, pass `skillExecutor: StubSkillExecutor()`. Concretely, in each existing construction (e.g. `testAllStagesPassOnFirstIterationSucceeds`, `testConsecutiveIdenticalFailuresGivesUpBeforeMaxIterations`, `testFailingRegressionStageRetriesWithoutCallingStageRepairer`, `testRegressionStallGivesUpBeforeMaxIterations`, `testCancelledRegressionSweepOnlyRunMapsToAborted`, etc.), insert this line among the arguments:
```swift
            skillExecutor: StubSkillExecutor(),
```
(Use `grep -n "LoopEngineRunner(" mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` to find every site; the compiler will also flag each one.)

- [ ] **Step 8: Add two more dispatch tests**

In the same test file, add:
```swift
    /// A skill stage re-runs every iteration (generate) until a verify stage
    /// gates the run — here a constant-failing regression sweep burns both
    /// iterations, so the skill runs twice.
    func testSkillStageReRunsEachIteration() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let skill = StubSkillExecutor()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 1)
        ], maxIterations: 2, consecutiveFailureStop: 5)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: skill,
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(skill.callCount, 2)   // ran once per iteration, before the regression gate
    }

    /// A skill that throws a transport error must NOT end the run — it's logged
    /// and the verify stages still decide.
    func testSkillStageErrorIsNonFatal() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let skill = StubSkillExecutor()
        skill.throwOnEveryCall = true
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)     // verify stage still passed despite the skill error
        XCTAssertEqual(skill.callCount, 1)
    }
```

- [ ] **Step 9: Build + run the runner suite**

Run: `cd mac && swift build && swift test --filter LoopEngineRunnerTests`
Expected: build succeeds; all `LoopEngineRunnerTests` pass (the 3 new skill tests + all pre-existing, now with `skillExecutor:`). `testSkillStageReRunsEachIteration` confirms the runner re-invokes the skill each iteration; `testSkillStageErrorIsNonFatal` confirms a thrown error does not abort.

- [ ] **Step 10: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift \
        mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift \
        mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "feat(mac): dispatch .skill generate stages in the Loop runner

Inject a LoopSkillExecuting collaborator; the new .skill case runs the
skill (generate, always completes; non-fatal on error) and falls
through. Verify stages still gate. Wires both production runner sites
and adds StubSkillExecutor + 3 dispatch tests.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Authoring UI — kind-picker add menu, skill/source/prompt editor, icon

Make `.skill` authorable in `LoopEngineView`: replace the hardcoded `+ → .shellCommand` button with a kind-picker `Menu`; give the skill stage its own icon; and add a `.skill` branch to the detail pane with a live skill picker, a target-source picker (from `LibraryItemStore`), and a prompt field.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` (add button → menu; icon line; detail-pane branch; new `@State` for the skill catalog + `@Environment` `LibraryItemStore` + a `.task` to load skills)

**Interfaces:**
- Consumes: `LlmIdeAPIClient.skillLibrary()` → `[SkillLibraryEntry]`; `LibraryItemStore.items(for:)` → `[LibraryItem]`; `LoopStage.skillId/targetPath/prompt`.

- [ ] **Step 1: Add skill-catalog state + LibraryItemStore + a loader**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`, near the other `@State` declarations (around line 50), add:
```swift
    @State private var skillCatalog: [LlmIdeAPIClient.SkillLibraryEntry] = []
    @State private var skillsLoaded = false
```
Add the environment object alongside the other `@EnvironmentObject`/`@Environment` declarations (search for `@EnvironmentObject var config`):
```swift
    @Environment(LibraryItemStore.self) private var itemStore
```
Add a loader method near `loadConfig()`:
```swift
    /// Live-fetch the central skill catalog (best-effort, latched on success)
    /// for the skill-stage picker — mirrors CompletionController.loadMetaIfNeeded.
    private func loadSkillsIfNeeded() async {
        guard !skillsLoaded else { return }
        if let skills = try? await api.skillLibrary(), !skills.isEmpty {
            skillCatalog = skills
            skillsLoaded = true
        }
    }
```
And trigger it from the existing `.onAppear`/`.task` that calls `loadConfig()` — add `Task { await loadSkillsIfNeeded() }` next to wherever `loadConfig()` is invoked on appear (search for `loadConfig()`).

- [ ] **Step 2: Replace the `+` button with a kind-picker `Menu`**

In `LoopEngineView.swift`, replace the add button (lines 112-121) with:
```swift
                Menu {
                    Button("Shell command") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "New Stage", kind: .shellCommand, command: "", order: nextOrder))
                    }
                    Button("Regression sweep") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: nextOrder))
                    }
                    Button("Skill (generate)") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "New Skill Stage", kind: .skill, command: nil, order: nextOrder))
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .help("Add a stage")
                .accessibilityLabel("Add stage")
```

- [ ] **Step 3: Add a skill-stage icon**

Replace the stage-row icon line (line 157):
```swift
            Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle" : "terminal")
```
with a three-way choice:
```swift
            Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle"
                  : stage.kind == .shellCommand ? "terminal" : "sparkles")
```

- [ ] **Step 4: Add the `.skill` branch to the detail pane**

In `stageDetail(index:)` (lines 231-269), convert the `if … == .shellCommand { … } else { … }` into three branches. Replace the whole `if stages[index].kind == .shellCommand { … } else { … }` block (lines 231-269) with:
```swift
            if stages[index].kind == .shellCommand {
                Text("Command").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("e.g. swift test", text: Binding(
                    get: { stages[index].command ?? "" },
                    set: { stages[index].command = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, design: .monospaced))

                if let gitRoot = activeGitRootURL {
                    if let command = stages[index].command, !command.isEmpty {
                        let approved = approvals.isStageApproved(repo: gitRoot, stageId: stages[index].id, command: command)
                        Button(approved ? "Approved" : "Approve & enable") {
                            approvals.approveStage(repo: gitRoot, stageId: stages[index].id, command: command)
                            selectedStageId = stages[index].id
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(approved)
                    } else {
                        Text("Enter a command for this stage.")
                            .font(Typography.caption).foregroundStyle(t.textMuted)
                    }
                } else {
                    Text("Open a project with a cloned repo to approve or run shell-command stages.")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                }
            } else if stages[index].kind == .skill {
                Text("Skill").font(Typography.caption).foregroundStyle(t.textMuted)
                if skillCatalog.isEmpty {
                    Text(skillsLoaded ? "No library skills found." : "Loading skills…")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                } else {
                    Picker("Skill", selection: Binding(
                        get: { stages[index].skillId ?? "" },
                        set: { stages[index].skillId = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("None").tag("")
                        ForEach(skillCatalog) { s in
                            Text("\(s.name) · \(s.family)").tag(s.id)
                        }
                    }
                }

                Text("Target source (optional)").font(Typography.caption).foregroundStyle(t.textMuted)
                let allItems = LibraryItem.Category.allCases.flatMap { itemStore.items(for: $0) }
                Picker("Target", selection: Binding(
                    get: { stages[index].targetPath ?? "" },
                    set: { stages[index].targetPath = $0.isEmpty ? nil : $0 }
                )) {
                    Text("None").tag("")
                    ForEach(allItems) { item in
                        Text(item.name).tag(item.path)
                    }
                }

                Text("Prompt (optional)").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("Defaults to: apply this skill", text: Binding(
                    get: { stages[index].prompt ?? "" },
                    set: { stages[index].prompt = $0.isEmpty ? nil : $0 }
                ), axis: .vertical)
                .textFieldStyle(.roundedBorder)

                Text("Runs the skill as a generate step each iteration; the loop's verify stages decide pass/fail.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            } else {
                Text("Re-runs the Regression sweep (fault reports + repo checks) with repair attempted on failure.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
```

- [ ] **Step 5: Build + run the full suite**

Run: `cd mac && swift build && swift test 2>&1 | grep -E "Executed [0-9]+ tests, with [0-9]+ failure" | tail -1`
Expected: build succeeds; tests show only the **2 known pre-existing failures** (the UI change adds no test failures — SwiftUI view code is covered by the runner/model tests; the pickers are exercised in the manual smoke).

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift
git commit -m "feat(mac): author .skill stages in the Loop Engineering UI

Add-menu becomes a kind picker (shell/regression/skill); skill stage
gets a sparkles icon and a detail editor with a live skill picker, an
optional Library target-source picker, and an optional prompt field.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Final verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Clean build + full suite**

Run:
```bash
cd mac && swift build && swift test 2>&1 | grep -E "Executed [0-9]+ tests, with [0-9]+ failure" | tail -1
```
Expected: build succeeds; exactly the **2 known pre-existing failures**, zero new.

- [ ] **Step 2: Manual smoke (build the app, click)**

Run (from repo root): `cd mac && bash build_app.sh && open "$(find .build -name LlmIdeMac.app -type d | head -1)"` (grant Accessibility if prompted). In Loop Engineering:
- The add `+` is now a **menu** with *Shell command / Regression sweep / Skill (generate)*.
- Add a **Skill** stage → detail pane shows a skill picker (populated from the central library), an optional target-source picker (Library items), an optional prompt.
- Add a shell-command verify stage (e.g. `swift test`) + approve it; put the skill stage before it; **Run**. The log shows `[<skill>] running skill <id> (generate)` → `[<skill>] skill completed (generate)` each iteration, then the verify stage's line; a failing verify loops and re-runs the skill.
- A skill with no `skillId` selected logs `running skill (none set)` and still completes (non-fatal).

- [ ] **Step 3: Note Phase 2/3 follow-ups (no commit unless asked)**

Phase 2 = named `LoopTemplate` + `LoopTemplateStore` + default starter template. Phase 3 = reorder UI, attach target-source content as a `CodeAttachment`, apply-template-to-project. These are out of scope for this plan.

---

## Self-review

- **Spec coverage:** model + fields (Task 1) ✓; `LoopSkillExecuting` + adapter via `codeAssist(skills:[id])` (Task 2) ✓; runner `.skill` dispatch (generate, always completes, non-fatal error) + `skillExecutor` wiring at all sites (Task 3) ✓; authoring UI — kind picker, skill picker, target source picker, prompt, icon (Task 4) ✓; the spec's blast-radius sites (icon line 157, detail pane 231, `+` button 112, `shouldPersist` already correct, preflight unchanged) all covered; tests (round-trip + 3 dispatch tests) ✓.
- **Placeholder scan:** none — every step shows exact code or exact commands.
- **Type consistency:** `LoopSkillExecuting.execute(skillId:targetPath:message:)` matches across Task 2 (definition), Task 3 (runner call + `StubSkillExecutor`), and the `defaultSkillMessage` helper. `LoopStage.skillId/targetPath/prompt` match across Task 1 (model), Task 3 (tests), Task 4 (UI bindings). `AgentLoopSkillExecutor(api:language:)` matches across Task 2 (init) and Task 3 (both production sites).
- **Scope:** Phase 1 only — no templates, no reorder, no new verify kinds, no `LoopEngineStatus` case. "Source" is the optional `targetPath` of a skill stage (a Library-backed picker), not a stage kind.
