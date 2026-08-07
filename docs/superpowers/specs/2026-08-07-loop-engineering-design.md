# Loop Engineering — Design

**Date:** 2026-08-07
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/`) only — no server (`extension/`) changes

## Goal

Generalize the app's existing single-attempt "Regression" check (re-verify `status: fixed` faults, one repair attempt, one re-verify) into a proper **iterative loop** that chains multiple named stages — Regression first, then Test, then any project-specific stage the user adds — retrying with agent-generated fixes until every stage passes or a stop condition is hit. Make it usable both from the Code Assistant chat (on demand) and as a scheduled Auto Task (unattended).

## Background — current state

- `RegressionRunner` (`mac/Sources/LlmIdeMac/Services/RegressionRunner.swift`) already re-checks every `status: fixed` `FaultReport` (markdown files under `<project>/system/faults/`) that carries an agent-authored `verify` shell command: `ShellFaultVerifier` runs it, and on failure (when `attemptRepair` is set) `AgentFaultRepairer` makes **exactly one** repair attempt via `api.codeAssist` (the agent has write tools in this deployment and edits the working tree directly — there is no separate "diff" step to apply), then re-verifies **once**. This already ships as the built-in `.regression` Auto Task (`AutoCodeUpdateService.runRegressionSweep`) and its own `RegressionView` (three-pane UI: fault list / detail / streamed log).
- `VerifyApprovalStore` already gates arbitrary shell commands behind a per-machine, per-command-hash approval (`sha256(repo, faultFile, command)`) before `RegressionRunner` will execute them — the safety mechanism for "should this shell command be allowed to run on this machine," distinct from any content/secret scanning.
- `AutoTask` (`Models/AutoCode/AutoTask.swift`) is a closed `enum` of 12 built-in cases including `.regression`; `AutoTaskSettings` holds one `@Published Bool` per case; `MobileControlManager.buildAutoTaskState()` derives the iPhone's task list from `AutoTask.allCases` automatically — adding a new case requires no separate mobile wiring.
- This is **entirely Mac-native**: no server (`extension/`) involvement beyond the existing `/code-assist` endpoint that `RegressionRunner`/`AgentFaultRepairer` already call. An earlier draft of this design proposed a new `extension/loopengine/` Node module with its own endpoints and SQLite tables — that was based on an incorrect assumption about where "regression" lives in this codebase and is **not** part of this design.
- There is no existing "detect the project's test command" logic, and no existing multi-stage or multi-iteration loop anywhere in the app — both are new.

## Decisions (from brainstorming)

- **Target of the loop:** the user's linked/target project (via the existing repo-resolution used elsewhere, e.g. `resolveBackendAndProject()`), not llm-ide's own `make regression`/`make test-mac`.
- **On stage failure:** auto-fix and retry (not verify-only-and-stop) — feed the failure output to an agent repair call, apply directly (same as today's `AgentFaultRepairer` — the agent edits in place), then retry.
- **Stage discovery:** auto-detect a sensible default stage list per project, but let the user edit/reorder/add/remove stages; saved locally per project (consistent with Repo/Issues/Gantt config already being local-per-user, never synced).
- **Fix application:** applied straight to the working tree (matches how the agent already operates), never auto-committed or auto-pushed — git itself is the review/undo mechanism. No new guardrail-scan step is introduced (see *Scope guardrails*).
- **Triggers:** a chat-panel action (button, not a fragile text-command parser — the chat has no existing slash-command dispatcher) that streams progress into the transcript, **and** a new built-in Auto Task case for unattended/scheduled runs. `.regression`'s existing single-attempt behavior is left untouched for anyone relying on it today.

## Architecture

```
Models/LoopEngine/
   LoopStage.swift          — one stage: .regressionSweep (no command) or .shellCommand(command)
   LoopEngineConfig.swift   — [LoopStage] + maxIterations + consecutiveFailureStop, per-project persistence
   LoopEngineRunResult.swift — per-run outcome (status, iterations, per-stage history) for the log/UI

Services/LoopEngine/
   LoopEngineRunner.swift     — ObservableObject driving the iteration loop (mirrors RegressionRunner's shape)
   LoopStageRepairer.swift    — protocol + AgentLoopStageRepairer adapter (generalizes AgentFaultRepairer
                                 beyond a single FaultReport)
   LoopStageDetector.swift    — sniffs gitRoot for a default Test stage command

Views/LoopEngine/
   LoopEngineView.swift       — stage editor + contract fields + Run button + log pane
                                 (three-pane layout parallel to RegressionView)

        │
        ├─ AutoCodeUpdateService.runLoopEngineeringSweep(projectRoot:, gitRoot:) — new Auto Task body
        ├─ CodeAssistantPanel — new toolbar action, streams LoopEngineRunner's log into the chat transcript
        └─ AppShell — new ShellState.Section case routes to LoopEngineView, alongside .regression
```

`LoopEngineRunner` reuses `ShellFaultVerifier`, `VerifyApprovalStore`, and (for the Regression stage specifically) `RegressionRunner` itself wholesale — it does not reimplement fault re-checking.

## Data model

`Models/LoopEngine/LoopStage.swift`:

```swift
struct LoopStage: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case regressionSweep, shellCommand }
    var id: String = UUID().uuidString
    var name: String            // "Regression", "Test", "Lint", ...
    var kind: Kind
    var command: String?        // nil for .regressionSweep, required for .shellCommand
    var order: Int
}
```

`Models/LoopEngine/LoopEngineConfig.swift`:

```swift
struct LoopEngineConfig: Codable, Equatable {
    var stages: [LoopStage]
    var maxIterations: Int = 5
    var consecutiveFailureStop: Int = 2

    static func load(for projectId: String) -> LoopEngineConfig?   // UserDefaults JSON, key "loopEngineConfig_\(projectId)"
    func save(for projectId: String)
}
```

Same on-disk idiom as `CustomAutoTask`/`CustomProvider` (UserDefaults JSON, no new persistence layer).

## Stage auto-detection

`LoopStageDetector.detectDefaultStages(gitRoot: URL) -> [LoopStage]` runs once, only when no saved `LoopEngineConfig` exists for a project:

1. Always start with `LoopStage(name: "Regression", kind: .regressionSweep, order: 0)`.
2. Probe `gitRoot` in order and add **one** Test stage from the first match: `Package.swift` → `swift test`; `package.json` with a `"test"` script → `npm test`; a `Makefile` with a `test` or `regression` target → `make test`; `pytest.ini`/`pyproject.toml`/`setup.cfg` with pytest config → `pytest`.
3. No match → Regression only; the user adds further stages manually in `LoopEngineView`.

The result is immediately saved via `LoopEngineConfig.save(for:)` so it becomes the editable baseline, and each `.shellCommand` stage starts **unapproved** — `VerifyApprovalStore` (extended with a stage-scoped hash, e.g. `sha256(repo, "loopstage:\(stage.id)", command)`) must be approved once per machine in `LoopEngineView` before the loop will run it, exactly like today's fault verify commands.

## Execution (`LoopEngineRunner`)

```
running = true; iteration = 0; consecutiveSameFailures = 0; lastFailureHash = nil
loop {
    iteration += 1
    for stage in config.stages.sorted(by: \.order) {
        switch stage.kind {
        case .regressionSweep:
            await regressionRunner.run(faultsRoot:, gitRoot:, attemptRepair: true)
            // regressionRunner's OWN one-shot repair already ran per fault; if any fault is
            // still .regressed/.repairFailed/.needsApproval, this stage fails for this iteration.
            // Re-running the sweep next iteration is itself the "retry" — no extra repair call here.
        case .shellCommand:
            guard approvals.isApproved(...) else { record .needsApproval; stop immediately }
            outcome = try await verifier.verify(command: stage.command!, repoRoot: gitRoot, timeout: stageTimeout)
            // failure → break out of the stage loop for this iteration
        }
    }
    all stages passed this iteration → status = .success; break
    failing stage was .shellCommand →
        hash failure output; bump/reset consecutiveSameFailures against lastFailureHash
        consecutiveSameFailures >= consecutiveFailureStop → status = .givenUp(reason: .repeatedFailure); break
        iteration >= maxIterations → status = .givenUp(reason: .maxIterations); break
        else: await stageRepairer.repair(stageName:, command:, failureOutput:, repoRoot:) ; continue
    failing stage was .regressionSweep →
        iteration >= maxIterations → status = .givenUp(reason: .maxIterations); break
        else: continue   // next iteration's sweep retries still-failing faults itself
}
running = false
```

**Every iteration re-runs every stage from the top**, not just the one that failed — slower, but guarantees a fix to stage N didn't silently break stage 1..N-1, matching how a regression gate is supposed to behave (this mirrors the decision already made and confirmed for this design).

`LoopStageRepairer` (`Services/LoopEngine/LoopStageRepairer.swift`) generalizes `AgentFaultRepairer` to a stage instead of a `FaultReport`:

```swift
protocol LoopStageRepairer: AnyObject {
    func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws
}

final class AgentLoopStageRepairer: LoopStageRepairer {
    // Same shape as AgentFaultRepairer.repair — builds a prompt from
    // stageName/command/failureOutput instead of a FaultReport, sends it
    // through api.codeAssist. The agent edits the working tree directly.
}
```

## Auto Task integration

- New built-in case `AutoTask.loopEngineering` (alongside the existing 12), with its own `AutoTaskSettings.runLoopEngineering: Bool`.
- `AutoCodeUpdateService` gets a `.loopEngineering` branch calling a new `runLoopEngineeringSweep(projectRoot:, gitRoot:)`, mirroring `runRegressionSweep`: loads (or auto-detects) `LoopEngineConfig`, runs `LoopEngineRunner`, logs via the existing `TaskLogStore` (`AutoTask`-keyed, no new storage needed), and reports a new `ActivityStore` kind (`.loopEngineeringDone`) parallel to `.regressionDone`.
- No mobile-side changes needed — `MobileControlManager.buildAutoTaskState()` derives from `AutoTask.allCases`, so the new case appears on a paired iPhone automatically, same as any other built-in task.

## Chat integration

- `CodeAssistantPanel` gets a new toolbar action ("Run Loop Engineering") rather than parsing free-text chat for a command — there is no existing slash-command dispatcher in the chat UI, and inventing fragile NL-intent detection isn't worth it for a single well-defined action.
- The action resolves the active project/repo the same way other chat actions do, loads/auto-detects `LoopEngineConfig`, and runs `LoopEngineRunner` sharing the panel's existing `api`/`language`.
- `LoopEngineRunner`'s log lines stream into the active `ChatSessionStore` session as they're appended (same append API the transcript already uses for streamed replies) so the user sees stage-by-stage progress live; the final message states the stop reason and lists changed files (`git diff --name-only`) for review.

## Mac UI (`LoopEngineView`)

Three-pane layout parallel to `RegressionView`:
- **Stages pane** — ordered list of `LoopStage`s; add/remove/reorder; each `.shellCommand` stage shows an "Approve & enable" control identical to `RegressionView`'s existing pattern when unapproved.
- **Detail pane** — contract fields (`maxIterations`, `consecutiveFailureStop`) and the selected stage's command (editable).
- **Log pane** — `LoopEngineRunner`'s streamed log, newest-bottom, same as `RegressionView`'s Log pane.

`AppShell.swift` gets a new `ShellState.Section` case routed to `LoopEngineView(api: api)`, alongside the existing `case .regression: RegressionView(api: api)`.

## Error handling

- **Unapproved shell-command stage** → the run stops immediately with `.needsApproval` (does not consume an iteration) — surfaced identically in chat and Auto Task history, pointing at which stage needs approval.
- **Stage command timeout** (default 10 min, matching the existing `AutoCodeUpdateService` subprocess timeout convention) prevents a hung command wedging the loop; counts as a failure for that iteration.
- **Concurrent runs on the same project** — `LoopEngineRunner.running` guards re-entrancy (mirrors `RegressionRunner`'s `guard !running else { return }`); a chat-triggered run and a scheduled Auto Task run racing on the same project is rejected the same way.
- **Codegen/repair transport error** (`AgentLoopStageRepairer` throws) → run ends with `.error(reason)`, not a silent stop.
- **No linked repo/`gitRoot`** — same guard the 5 prompt-based Auto Tasks already use (`hasResolvableBackend`); the chat action and Auto Task run both refuse to start rather than running with an unresolved `gitRoot`.

## Testing

- `LoopStageTests` / `LoopEngineConfigTests` — `Codable` round-trip, ordering, per-project UserDefaults load/save.
- `LoopStageDetectorTests` — each auto-detect branch (`Package.swift`, `package.json` with/without a `test` script, `Makefile` with/without a matching target, pytest config) against throwaway temp directories.
- `LoopEngineRunnerTests` — fake `FaultVerifier`/`LoopStageRepairer`/`RegressionPrompter` doubles (same style as `RegressionRunner`'s own protocol-based fakes, which have no existing test file today — this is first coverage for the pattern) driving: all-pass-first-iteration, one-fix-then-pass, `maxIterations` give-up, `consecutiveFailureStop` give-up, immediate stop on `.needsApproval`.
- `AutoCodeUpdateServiceLoopEngineeringTests` — new case wiring, mirroring the existing `AutoCodeUpdateServiceCronTests`/`AutoCodeUpdateServiceCustomTaskTests` pattern.
- Manual: point `LoopEngineView` at a small repo with a deliberately broken test, confirm the loop converges or gives up cleanly from both the chat action and a scheduled Auto Task run, and that the Auto Task history / chat transcript both reflect the outcome.

## Scope guardrails / deferred

- **No secret/PII guardrail-scan step.** The agent edits the working tree directly (same as today's `AgentFaultRepairer` — there's no discrete "diff" object to scan before it's applied), and nothing is auto-committed or auto-pushed, so git review remains the safety net, unchanged from today's Regression behavior. Revisit if this loop is used on repos where that's not sufficient.
- **No changes to `.regression`'s existing single-attempt behavior or `RegressionView`** — `.loopEngineering` is additive.
- No cross-machine sync of `LoopEngineConfig` (matches Repo/Issues/Gantt config already being local-per-user).
- No editing `LoopEngineConfig` from the iPhone app — Auto Task run/toggle only, consistent with how built-in tasks work on mobile today.
- No new server (`extension/`) module, endpoints, or SQLite tables.
- No arbitrary number of concurrent loop runs across different projects — out of scope to design multi-project concurrency; single-run-per-project is the only guard specified here.
