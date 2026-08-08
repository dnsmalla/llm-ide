# Loop Engineering — pinned default stages + row ⋯ menu

**Date:** 2026-08-08
**Surface:** macOS app (`mac/`)
**Status:** Approved design → awaiting implementation plan
**Builds on:** `main` after the Loop Engineering + skill-stage work (`LoopStage` has
`regressionSweep`/`shellCommand`/`skill`; `LoopStageDetector` seeds Regression + Test;
`LoopEngineView` has a `+` kind-picker menu and an always-visible "Remove Stage" button).

## Goal

The **default Regression + Test stages are pinned and undeletable** — they're always
necessary. **User-added stages stay deletable, but via a ⋯ (three-dot) menu on the stage row**
(Duplicate / Delete) instead of the always-visible "Remove Stage" button. Everything stays
editable inline.

## Why

Today every stage — including the detector-seeded Regression and Test — has an always-visible
"Remove Stage" button, so a user can accidentally delete the core verify stages and break the
loop. The defaults should be permanent (re-ensured on load), and deletion should be a
deliberate act behind a row ⋯ for the stages the user actually chose to add.

## Scope (user-confirmed)

- **Pinned set** = the detector-seeded defaults: **Regression** (always) + **Test** (only when
  the detector finds test tooling). Anything added via the `+` menu (extra shell commands, a
  Skill stage, even a second Regression/Test) is **not** pinned.
- **Pinned stages are editable, just not deletable** — rename, change the Test command, etc.
- **⋯ menu lives on each stage row** in the sidebar: **Duplicate** (all stages) +
  **Delete** (non-pinned only). Editing stays inline (clicking a row opens the detail editor).
- Pinned rows show a small "default" indicator so it's clear why Delete is absent.

## Non-goals

- Named/default **templates** and a template store (Phase 2).
- **Reorder** UI / move up-down (Phase 3).
- Changing what the detector detects, or the runner's execution.
- Locking editability — pinned stages remain fully editable.
- Forcing a Test stage when no test tooling is detected.

## Architecture

Add a per-stage **`isDefault`** flag (the "pinned" marker). The detector sets it on the stages
it seeds; the `+` menu does not. A shared **load-time ensure** step makes the invariant
"one pinned Regression always; one pinned Test iff tooling detected" hold for every config —
including legacy configs saved before the flag existed. Deletion is gated on `!isDefault` and
moves behind a row ⋯ Menu; the detail-pane "Remove Stage" button is removed.

## Components

### 1. Model — `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`

Add an additive optional-default field (after the existing skill fields), Codable-backward-
compatible (old configs decode with `false`):

```swift
/// True for the detector-seeded default stages (Regression + Test). Default stages are
/// always present (re-ensured on load) and cannot be deleted; they remain editable.
/// User-added stages (the `+` menu, duplicates) are `false`.
var isDefault: Bool = false
```

### 2. Detector — `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift`

`detectDefaultStages(gitRoot:)` seeds its stages with `isDefault: true`:

```swift
var stages: [LoopStage] = [
    LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0, isDefault: true)
]
if let testCommand = detectTestCommand(gitRoot: gitRoot) {
    stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand, order: 1, isDefault: true))
}
```

### 3. Load-time ensure — shared helper

New helper that normalizes any config to the pinned-defaults invariant. Lives as a static on
`LoopEngineConfig` (so all three load paths share one definition), e.g.
`func ensuringDefaultStages(gitRoot: URL?) -> LoopEngineConfig`:

1. **Regression** — find the first `regressionSweep`. If none, prepend a pinned Regression
   (`order` 0, others shifted). If present but `!isDefault`, set it `isDefault = true`.
2. **Test** — re-run `LoopStageDetector.detectTestCommand(gitRoot:)`.
   - If tooling **is** detected: find the first `shellCommand`. If none, append a pinned Test.
     If present but `!isDefault`, pin it.
   - If tooling is **not** detected: leave existing shell stages as-is (unpinned); add nothing.
3. Return the (possibly mutated) config. User-added stages and the user's edited commands are
   preserved throughout.

Call it in all three config-load sites, after load/detect, before use:
- `LoopEngineView.loadConfig()` (`mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`)
- `runLoopEngineeringFromChat` (`mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift`)
- `runLoopEngineeringSweep` (`mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift`)

### 4. Row ⋯ menu + pinned indicator — `LoopEngineView.swift` stage row

On each stage row in the sidebar, add a trailing `Menu` (`⋯` label):
- **Duplicate** — appends `LoopStage(...)` with a new `id`, `isDefault: false`, and the next
  `order` (a copy of the source stage's kind/command/skill fields). Always shown.
- **Delete** — shown only when `!stage.isDefault`; removes the stage (mirrors the current
  remove logic).
- Pinned rows additionally show a small lock icon (e.g. `lock.fill`, `foregroundStyle(.secondary)`)
  with `.help("Default stage — can't be deleted")`.

### 5. Detail pane — remove the "Remove Stage" button

Delete the always-visible "Remove Stage" button from `stageDetail(index:)`. Deletion now lives
in the row ⋯ (non-pinned only). Editing (name/command/skill fields) is unchanged for every
stage, pinned included.

### 6. `+` add menu / `shouldPersist` — unchanged

The `+` menu still adds stages of each kind; they are created with `isDefault: false` (the
default). `LoopEngineConfig.shouldPersist` is unchanged (a pinned-only config still reads as
"no real tooling" — though with a pinned Test that's now `shellCommand`, `shouldPersist` is
already true, which is fine/desired).

## Data flow

1. Open Loop Engineering → `loadConfig()` loads the saved config (or detects defaults) →
   `ensuringDefaultStages(gitRoot:)` guarantees the pinned Regression (+ Test iff tooling).
2. Sidebar rows render with a ⋯; pinned rows show the lock badge and a ⋯ without Delete.
3. User edits a pinned stage inline (e.g. changes the Test command) — allowed; `isDefault`
   stays true.
4. User clicks ⋯ → Duplicate on any stage (copy is non-default, deletable) or Delete on a
   non-pinned stage.
5. Run uses the config as today; the runner is unchanged.

## Testing (XCTest, TDD)

- **`LoopStageTests`**: `isDefault` Codable round-trip (true and false); an old payload
  (no `isDefault` key) decodes with `isDefault == false`.
- **`LoopStageDetectorTests`**: `detectDefaultStages` marks Regression `isDefault == true`
  always, and Test `isDefault == true` when tooling is detected (extend an existing
  tooling-found test).
- **`LoopEngineConfigTests`** (new, for the ensure helper): given a legacy config (stages with
  `isDefault == false`), `ensuringDefaultStages` pins the first regressionSweep and (iff
  tooling) the first shellCommand; given a config missing Regression, it adds a pinned one;
  given a config with tooling but no shellCommand, it adds a pinned Test; given no tooling, it
  does not add/pin a Test; user-added extra stages and edited commands are preserved.
- **Row ⋯ predicate**: a small test that the Delete action's availability is `!stage.isDefault`
  (the UI gating is covered by the manual smoke; the predicate is unit-testable if factored
  into a computed `canDelete` property on the stage/view).

## Verification (manual)

- Loop Engineering: Regression (+ Test if tooling) rows show a lock badge and a ⋯ with no
  Delete; user-added stages' ⋯ has Delete + Duplicate.
- The detail pane no longer has a "Remove Stage" button.
- A pinned stage's command is still editable inline.
- Duplicate any stage → a deletable copy appears.
- Quit/relaunch: the pinned defaults remain (and a legacy project's Regression/Test are now
  pinned after the first load).

## Self-review

- Placeholders: none. The ensure-helper algorithm is fully specified.
- Consistency: "pinned = `isDefault` set by detector + re-ensured on load" is used uniformly
  across model, detector, load paths, and UI.
- Scope: single focused plan (pin defaults + row ⋯); templates/reorder explicitly deferred.
- Ambiguity: "Test pinned only when tooling detected" is made explicit in the ensure algorithm
  (step 2) — no tooling ⇒ no pinned Test, existing shell stages left as-is.
