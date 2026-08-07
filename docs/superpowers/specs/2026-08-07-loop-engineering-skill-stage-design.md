# Loop Engineering — Skill generate stage (Phase 1)

**Date:** 2026-08-07
**Surface:** macOS app (`mac/`)
**Status:** Approved design → awaiting implementation plan
**Builds on:** the Loop Engineering changes in branch `feat/loop-engineering-regression-home`
(`SweepOutcome` seam, `.regressionStalled`, default cap 10, non-hideable Loop Engineering,
deleted standalone Regression page). Phase 1 assumes those are present.

## Goal

Add a new **skill stage** to Loop Engineering: a *generate* step that runs a chosen agent
skill (optionally scoped to a target source) and always completes. The loop's existing
*verify* stages (regression sweep, shell command) gate pass/fail, so a run becomes
**generate → verify → generate → verify … until all verify stages pass.** This is the first
of three phases toward user-composable Loop templates; Phase 1 ships the skill stage and the
pickers to author one on the existing per-project Loop config.

## Why

Today a Loop stage can only be `.regressionSweep` (verify) or `.shellCommand` (verify). The
runner's only *generate/repair* arm is the implicit `stageRepairer` call on a shell-stage
failure — users can't choose *what* generates/fixes. A skill stage makes a chosen library
skill (e.g. a codegen/fix skill) an explicit, ordered generate step, so a Loop can be
"run fix-skill X on this source → `swift test` → regression sweep, looping until green."

## Scope

**In (Phase 1):**
- `LoopStage.Kind.skill` + fields to bind a skill and an optional target.
- A `LoopSkillExecuting` collaborator + production adapter that runs the skill via the
  existing one-shot agent path (`api.codeAssist` → `/code-assist` with `skills:[id]`).
- Runner dispatch for `.skill` (always completes; verify stages gate).
- Authoring UI in `LoopEngineView`: a kind-picker "add" menu, a skill picker, an optional
  target-source picker, an optional prompt field, a skill-stage icon.
- Tests (model round-trip, runner dispatch, loop integration, executor wiring).

**Out (later phases):**
- **Named/reusable Loop templates + a default starter template + template store** — Phase 2.
- **Reorder UI, apply-template-to-project, richer section rendering** — Phase 3.
- Per-skill auto-detection in `LoopStageDetector` (skills are user-chosen, not detected).
- A Mac-side skill catalog cache (the picker fetches `skillLibrary()` live, like the chat
  "/" menu).
- New verify stage kinds. "Source" is **not** its own stage kind — it is the optional target
  of a skill stage.

## Architecture

The runner already follows a "inject one collaborator per stage family" seam
(`regressionSweep: RegressionSweepRunning`, `stageRepairer: LoopStageRepairer`). A skill
stage adds one more: `skillExecutor: LoopSkillExecuting`. The skill stage is a **generate**
step with no pass/fail — it runs and the loop continues; the existing verify stages decide
termination. This mirrors how shell-stage failure already invokes `stageRepairer.repair(...)`
and retries, except a skill stage is an explicit, always-run generate step the user authors.

### Execution path (feasibility — confirmed)

Both the repairer (`AgentLoopStageRepairer.repair`) and the chat "/" skill menu resolve to one
call: `LlmIdeAPIClient.codeAssist(...)` POSTing `/code-assist`. The chat path passes
`skills: [skillId]`; the repairer passes `skills: []`. The server resolves each skill id
(`<family>/<dir>`) → its `SKILL.md` → a trusted instruction. So "run agent with skill X" is
`api.codeAssist(message:…, skills:["<family>/<dir>"], …)` — directly reusable. **No server
change, no `claude` CLI shell-out, no `:3456` direct call.**

## Components

### 1. Model — `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`

`Kind` is `String`-rawValue `Codable`, so adding `case skill` is JSON-backward-compatible.
Additive optional fields mirror the existing `command: String?`:

```swift
enum Kind: String, Codable {
    case regressionSweep
    case shellCommand
    case skill
}
var id: String = UUID().uuidString
var name: String
var kind: Kind
var command: String?      // .shellCommand only
var skillId: String?      // .skill only — "<family>/<dir>"
var targetPath: String?   // .skill only — optional Library file/repo path scoped to the skill
var prompt: String?       // .skill only — optional task text; defaults to a built-in message
var order: Int
```

### 2. Collaborator — new file `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopSkillExecuting.swift`

Mirrors `RegressionSweepRunning.swift` (protocol + `@MainActor` adapter):

```swift
protocol LoopSkillExecuting: AnyObject {
    func execute(skillId: String, targetPath: String?, message: String, repoRoot: URL) async throws
}

@MainActor
final class AgentLoopSkillExecutor: LoopSkillExecuting {
    private let api: LlmIdeAPIClient
    private let language: String
    init(api: LlmIdeAPIClient, language: String = "en") { self.api = api; self.language = language }

    func execute(skillId: String, targetPath: String?, message: String, repoRoot: URL) async throws {
        var attachments: [CodeAttachment] = []
        if let path = targetPath { attachments = [.init(path: path, /* content resolved server-side */ )] }
        _ = try await api.codeAssist(
            message: message, language: language, model: nil,
            history: [], attachments: attachments, agentContext: nil, skills: [skillId])
    }
}
```

"Made no edit" is not an error (return discarded), matching `AgentLoopStageRepairer`. (Exact
`CodeAttachment` construction follows the chat path's shape — confirmed at
`LlmIdeAPIClient+CodeAssist.swift`; the implementer matches its field names. If a target
path's content must be read client-side, follow whatever the chat attachment path does.)

### 3. Runner — `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`

Add `skillExecutor: LoopSkillExecuting` to `init` (alongside `stageRepairer`/
`regressionSweep`). Add the compiler-forced case to the stage dispatch `switch stage.kind`:

```swift
case .skill:
    let id = stage.skillId ?? ""
    let message = stage.prompt?.isEmpty == false ? stage.prompt! : Self.defaultSkillMessage(stage)
    appendLog(.info, "  [\(stage.name)] running skill \(id) (generate)")
    do {
        try await skillExecutor.execute(skillId: id, targetPath: stage.targetPath,
                                        message: message, repoRoot: gitRoot ?? faultsRoot)
        appendLog(.info, "  [\(stage.name)] skill completed (generate)")
    } catch is CancellationError {
        status = .aborted; break iterationLoop
    } catch {
        // A generate step that errors is treated like a verify failure: log and let the
        // loop's verify stages / iteration cap decide. Do not end the run for a skill error.
        appendLog(.warn, "  [\(stage.name)] skill error: \(error.localizedDescription)")
    }
    // No pass/fail, no retry, no approval — fall through to the next stage.
```

`defaultSkillMessage(_:)` returns e.g. `"Apply the skill for stage \"\(stage.name)\"."`. The
preflight approval loop (currently `where stage.kind == .shellCommand`) is **unchanged** —
skill stages need no command approval.

### 4. Construction sites (3)

Pass `skillExecutor: AgentLoopSkillExecutor(api: api)` (and `language:` where the site has
it) at:
- `LoopEngineView.init` (`Views/LoopEngine/LoopEngineView.swift:57-75`) — same `api` in scope.
- `runLoopEngineeringFromChat` (`Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift:158`).
- Tests (`Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`) — a `StubSkillExecutor` double
  (mirroring `StubRepairer`/`StubRegressionSweep`).

### 5. UI — `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`

- **Add menu**: replace the hardcoded `+ → .shellCommand` button with a `Menu` offering
  *Shell command*, *Regression sweep*, *Skill*. Each appends a `LoopStage` of that kind with
  the next `order`.
- **Stage-row icon** (line ~157): add `case .skill → "sparkles"` (or similar) to the
  kind→icon mapping.
- **Detail pane** (line ~231): add a `.skill` branch with:
  - A **skill picker** — fetches `api.skillLibrary()` (live; mirror
    `CompletionController.loadMetaIfNeeded()`) and lists `SkillLibraryEntry` by name; selecting
    sets `stage.skillId` (and stage name if unset).
  - An optional **target-source picker** — lists `LibraryItemStore` items (reuse the
    `DocGenSource`/`LibraryItem` pattern); selecting sets `stage.targetPath` to the item's
    path. Optional/clearable.
  - An optional **prompt** `TextField` bound to `stage.prompt`.
- **Approval-warning triangle** (line ~164): stays gated on `.shellCommand` (skill stages
  aren't approval-gated) — no change needed beyond confirming the existing condition.

### 6. `shouldPersist` — `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift:29`

Unchanged and already correct: `stages.contains { $0.kind != .regressionSweep }` — a `.skill`
stage makes a config persistable (it's "real tooling" beyond bare Regression), which is
desired.

## Data flow

1. User opens Loop Engineering, picks **Skill** from the add menu → new `.skill` stage.
2. Detail pane: picks a skill (→ `skillId`) and optionally a target source (→ `targetPath`)
   and prompt.
3. **Run** → runner iterates the ordered stages. At the `.skill` stage it calls
   `AgentLoopSkillExecutor.execute` → `api.codeAssist(skills:[skillId], attachments: target)`
   → the server runs the agent with the skill as a trusted instruction, scoped to the target.
   The stage logs and completes.
4. Subsequent verify stages (`.shellCommand`/`.regressionSweep`) gate. On failure the loop
   re-runs every stage from the top (so the skill runs again) until all verify stages pass in
   one iteration, or a give-up fires (`.maxIterations` / `.repeatedFailure` /
   `.regressionStalled`).

## Testing (XCTest, TDD)

- **`LoopStageTests`**: `.skill` + `skillId`/`targetPath`/`prompt` Codable round-trip
  (encode/decode equality); decoding an old config (no `skill` cases) still works.
- **`LoopEngineRunnerTests`**:
  - `StubSkillExecutor` double (records calls; optionally throws).
  - `.skill` dispatch: a run with a `.skill` stage + a passing `.shellCommand` stage succeeds
    on iteration 1; the executor is called exactly once.
  - `.skill` + a failing-then-passing verify stage: the executor is called each iteration
    until the verify stage passes (assert call count == iterations used).
  - A skill stage that `throws` does NOT end the run (logged as warn; loop continues to
    verify/iteration cap).
  - Cancellation mid-skill-stage → `.aborted`.
- **`AgentLoopSkillExecutorTests`** (new, mirror `RegressionRunnerSweepAdapterTests`'s use of
  a stub `LlmIdeAPIClient` if one exists; otherwise assert the request shape via a small
  capturing stub): `execute` calls `codeAssist` with `skills == [skillId]` and the target as
  an attachment.

## Non-goals / later phases

- Phase 2: named `LoopTemplate` + `LoopTemplateStore` (mirror `DocTemplateStore`) + a default
  starter template + save/load/duplicate.
- Phase 3: reorder UI (`.onMove`), apply-template-to-project, richer section rendering.

## Verification (manual, after Phase 1 ships)

- Loop Engineering → add menu shows **Skill**; selecting it creates a skill stage.
- Detail pane lists skills (from `skillLibrary()`); picking one + a target + Run streams
  `[<name>] running skill <id> (generate)` then `skill completed`, followed by the verify
  stages' lines; a failing verify loops and re-runs the skill each iteration.
- A skill-error is logged as a warning and does not abort the run.
- Existing regression/shell-only runs behave unchanged.

## Self-review

- Placeholders: none. The one "follow the chat attachment shape" note in §2 is an
  implementation detail the plan resolves against `LlmIdeAPIClient+CodeAssist.swift`; it does
  not block the design.
- Consistency: the skill stage is consistently a no-pass/fail generate step across model,
  runner, and UI; verify gating is unchanged.
- Scope: Phase 1 is a single, independently-shippable plan (skill stage + pickers); templates
  are explicitly Phase 2.
- Ambiguity: "source" is resolved as the optional `targetPath` of a skill stage, not a stage
  kind — made explicit in Scope and Components.
