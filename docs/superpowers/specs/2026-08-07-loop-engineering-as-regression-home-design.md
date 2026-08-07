# Loop Engineering as the permanent home for regression

**Date:** 2026-08-07
**Surface:** macOS app (`mac/`)
**Status:** Approved (revised) design → awaiting implementation plan
**Supersedes:** `2026-08-07-hide-regression-menu-redirect-to-loop-engineering-design.md` (redirect-only; deleted)

## Goal

Make **Loop Engineering** the single, permanent, non-hideable home for regression. A user
opens Loop Engineering, hits Run, and the engine runs the regression sweep and **loops
until all faults pass** (or gives up clearly). The standalone **Regression** menu, its
Settings toggle, the `RegressionView` page, and the `.regression` nav case are **deleted**.
`RegressionRunner` stays — Loop Engineering depends on it.

## Why

Loop Engineering already loops the regression sweep until all stages pass (`LoopEngineRunner`
iteration loop, `LoopEngineRunner.swift:132`), capped at `maxIterations`. Regression-the-page
is therefore redundant. The gaps the user wants closed: (1) Regression is still a separate,
hideable menu; (2) Loop Engineering itself is hideable; (3) a regression-sweep stage isn't
guaranteed as the out-of-box default; (4) the run log hides regressed/passed counts; (5) the
loop gives up only on the iteration cap or repeated identical *shell* failures — a regression
stage that keeps regressing the same faults burns all iterations without a clear "stalled"
verdict.

## Requirements (user-confirmed)

1. **Delete Regression entirely** — toolbar menu button, Settings toggle, `RegressionView`,
   and the `ShellState.Section.regression` case. `RegressionRunner` + adapter stay.
2. **Loop Engineering is permanent / non-deletable** — always visible, not user-hideable
   (like Library/Settings).
3. **Default regression-sweep stage + show counts** — a fresh Loop config includes a
   regression-sweep stage, and the run log/status surfaces "N regressed / M passed".
4. **Stronger loop** — raise the default iteration cap and add regression-stall detection
   (give up early when the regressed count stops shrinking), mirroring the existing
   `consecutiveFailureStop`.

## Context (current state)

- Nav enum `ShellState.Section` (`Services/ShellState.swift`); ordered toolbar buttons
  `toolOrder` (`Views/AppShell.swift:410`); route switch `sectionView(for:)` (line ~607).
- `.regression` → `RegressionView` (`Views/Regression/RegressionView.swift`); `.loopEngine`
  → `LoopEngineView`. Both currently in `userHideable` (`ShellState.swift:58`).
- `LoopEngineConfig` (`Models/LoopEngine/LoopEngineConfig.swift`): `stages`, `maxIterations = 5`,
  `consecutiveFailureStop = 2`. Per-project UserDefaults JSON. Auto-detect via
  `LoopStageDetector.detectDefaultStages` (always includes a regressionSweep stage).
  `shouldPersist(_:)` refuses to save an all-regression config.
- `LoopEngineRunner.run()` (`Services/LoopEngine/LoopEngineRunner.swift`) iterates the ordered
  stage list. `.regressionSweep` branch (lines 148–158) calls
  `regressionSweep.sweepPassed(...) -> Bool`, logs "passed/failed", retries on fail, gives up
  `.maxIterations` on the last iteration. `.shellCommand` branch (160–223) has hash-based
  `consecutiveFailureStop` stall detection that regression lacks.
- `RegressionSweepRunning` protocol + `RegressionRunnerSweepAdapter`
  (`Services/LoopEngine/RegressionSweepRunning.swift`) collapse the sweep to a single `Bool`.
- `LoopEngineStatus.GivenUpReason` (`Models/LoopEngine/LoopEngineStatus.swift`):
  `.maxIterations`, `.repeatedFailure`. `.summary` is the single human-readable source.
- Menu-bar status pill posts `.openSection` with `Section.regression.rawValue`
  (`LlmIdeMacApp.swift:581`). All notification nav funnels through `AppShell.swift:89`.
- `shell.section` is not persisted (defaults to `.explorer`). `config.homeSection` is
  persisted; Settings Home picker iterates `Section.allCases` (`SidebarVisibilitySection.swift:26`).
- Tests: `LoopEngineRunnerTests` (has `StubRegressionSweep` double, line 58),
  `RegressionRunnerSweepAdapterTests` (4 sites asserting `Bool`), `LoopEngineConfigTests`,
  `LoopStageDetectorTests`, plus AutoTask/LoopEngineering test files.

## Design

### A. Delete Regression (nav + view + enum case)

| File | Change |
|---|---|
| `Services/ShellState.swift` | Remove `.regression` from the `Section` enum (line 9) and its `label`/`systemImage`/`tint` arms (compiler-enforced once the case is gone). Remove `.regression` from `userHideable` (line 59). |
| `Views/AppShell.swift` | Remove `.regression` from `toolOrder` (line 412) and the `case .regression: RegressionView(api:)` route arm (~line 607). |
| `Views/Regression/RegressionView.swift` | **Delete the file.** Verify no other construction (grep `RegressionView(`) — expected single site is the route arm above. |
| `LlmIdeMacApp.swift:581` | Menu-bar pill now posts `Section.loopEngine.rawValue` (required — the `.regression` case no longer exists). Pill label/styling unchanged; it still reports `lastRegressionRunAt`/`lastRegressionRegressedCount`. |
| `Views/Settings/SidebarVisibilitySection.swift:26` | Home picker filter no longer needs the `.regression` exclusion (case gone) — leave as-is or simplify. |
| `Views/HelpGuideView.swift` | Remove the `HelpTopic.Section.regression` topic + its content/label/icon/tint arms (separate enum) so docs don't describe a deleted page. |

Persisted-string safety: any stored `"regression"` in `homeSection`/`hiddenSidebarSections`
fails `Section(rawValue:)` and falls back (`.library` / pruned by the `userHideable`
allow-list). Optional one-line migration in `Config.swift` init to map a stored Home of
`"regression"` → `"loopEngine"` (nice-to-have; the fallback already prevents breakage).

### B. Make Loop Engineering permanent

| File | Change |
|---|---|
| `Services/ShellState.swift:59` | Remove `.loopEngine` from `userHideable`. It is already in `toolOrder` and not feature-gated, so it becomes always-visible and un-hideable. |

(Settings "Menu Bar" card and Home picker automatically stop offering a hide toggle for it
because both key off `userHideable` / `allCases`.)

### C. Widen the sweep seam so counts are visible

New `SweepOutcome` and protocol change in `Services/LoopEngine/RegressionSweepRunning.swift`:

```swift
struct SweepOutcome: Equatable {
    let passed: Bool
    let total: Int
    let regressed: Int
    let unchanged: Int
    let repaired: Int
    let repairFailed: Int
    let needsApproval: Int
    let failed: Int
    let pending: Int
}

protocol RegressionSweepRunning {
    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome
}
```

`RegressionRunnerSweepAdapter.sweep(...)` runs the inner `RegressionRunner` (as today) and
derives `SweepOutcome` from `runner.results` by filtering verdicts. `passed` keeps the existing
fail-closed definition (no `.pending/.regressed/.repairFailed/.needsApproval/.failed`).

Call-site/test updates required:
- `LoopEngineRunner.swift:149` — call `sweep(...)`, consume `outcome.passed` + log counts.
- `LoopEngineRunnerTests` `StubRegressionSweep` (line 58) — return `SweepOutcome`.
- `RegressionRunnerSweepAdapterTests` (4 sites) — assert `SweepOutcome` fields.

### D. Surface counts in the run log

In `LoopEngineRunner`'s `.regressionSweep` branch, replace the plain "passed/failed" line with
a count line, e.g.:

```
[Regression Sweep] failed — 2 regressed / 13 passed of 15   (or "passed — 15 of 15")
```

(Counts come from `SweepOutcome`. `unchanged + repaired` = "passed"; the rest are broken out
only when non-zero, to keep the log readable.)

### E. Stronger loop — higher default cap + regression-stall detection

1. **Default cap**: `LoopEngineConfig.maxIterations` default `5 → 10`. (Stepper range is
   `1...20`, so no UI change; verify `LoopEngineView`'s `@State maxIterations` default tracks
   the config/struct default.) Existing persisted configs keep their saved value; only new
   configs get 10.

2. **New give-up reason**: add `.regressionStalled` to `LoopEngineStatus.GivenUpReason` and a
   matching `.summary` line, e.g. `"given up (regressions stopped shrinking)"`. The AutoCode
   pipeline consumes `.givenUp` via `.summary` (`AutoCodeUpdateService+PipelineTasks.swift:584`),
   so it is covered without further changes.

3. **Stall tracking** in `LoopEngineRunner` (mirror shell-stage logic at lines 193–204). Before
   the loop: `var lastRegressed: Int? = nil`, `var regressionStallCount = 0`. In the
   `.regressionSweep` branch, when `!outcome.passed`:
   - "Stops shrinking" = the regressed count did not decrease vs. the previous iteration.
     If `lastRegressed != nil && outcome.regressed >= lastRegressed!` →
     `regressionStallCount += 1`; else reset to `0` (progress: regressed went down). Always
     set `lastRegressed = outcome.regressed` afterward.
   - If `regressionStallCount >= config.consecutiveFailureStop` →
     `status = .givenUp(.regressionStalled)`; `break iterationLoop`.
   - Else if last iteration → `.givenUp(.maxIterations)`; else `continue iterationLoop`.

   Rationale: if the same N faults keep regressing across `consecutiveFailureStop` iterations,
   the one-shot internal repair isn't converging — stop with a precise verdict instead of
   burning the remaining cap.

### F. Default regression-sweep stage (verify, minimal code)

`LoopStageDetector.detectDefaultStages` already always includes a regressionSweep stage, so
fresh/auto-detected configs already satisfy "default sweep." **Verify in the plan** that the
empty/no-tooling path still yields a regressionSweep stage; if any path produces a stage-less
or regression-less default, add it there. Expected: little to no code change.

## Non-goals

- Do **not** delete `RegressionRunner` or `RegressionRunnerSweepAdapter` (Loop Engineering
  depends on them).
- Do **not** change `RegressionRunner` internals, the verdict model, or fault scanning.
- Do **not** touch `AutoTask.regression` (background Auto Task) or the `.regressionDone`
  activity-feed kind.
- Do **not** add a per-stage result table UI (counts land in the run log/status only — net-new
  aggregate panel is out of scope).
- Do **not** change the chat-panel Loop button or the AutoCode Loop sweep call paths beyond
  what the protocol rename forces.

## Testing

- Update `StubRegressionSweep` + the 4 `RegressionRunnerSweepAdapterTests` sites for the
  `SweepOutcome` return type; keep their pass/fail semantics as `outcome.passed`.
- Add `LoopEngineRunnerTests` cases: (a) regression stall → `.givenUp(.regressionStalled)`
  after `consecutiveFailureStop` identical regressed counts; (b) regressed count decreasing
  resets the stall counter and keeps looping; (c) the higher default cap is reflected.
- Update any test asserting `toolOrder`/`Section.allCases` no longer contains `.regression`,
  and that `.loopEngine` is absent from `userHideable`.
- `LoopEngineStatus` summary snapshot for `.regressionStalled`.
- Build the whole `mac/` package: removing `.regression` from a `CaseIterable` enum with
  exhaustive switches must compile cleanly (any missed switch site is a compile error — the
  desired safety net).

## Verification (manual)

- Toolbar: no Regression button; Loop Engineering always present and not hideable in Settings.
- Delete a persisted Loop config, open Loop Engineering fresh → a regression-sweep stage is
  present; Run streams "N regressed / M passed of T" lines.
- A project with persistently-regressing faults stops early with "given up (regressions
  stopped shrinking)" instead of burning 10 iterations.
- Menu-bar "regressions" pill opens Loop Engineering (not a dead page).
- Existing user with Home = Regression lands on Library (or Loop Engineering if the optional
  migration is added), never a missing page.
