# Loop Engineering — independent named loops (Mac core) — design

Date: 2026-08-21
Status: approved

## Problem

The Loop page (`LoopEngineView.swift`) holds exactly one `LoopEngineConfig`
per project — one ordered stage list, one set of budgets, one log, one run
history. Every stage the user wants verified (tests, lint, a refactor skill)
is forced into that single pipeline. There is no way to keep two unrelated
efforts (e.g. "fix flaky tests" vs "refactor auth") as separate, independently
run and tracked loops the way Auto Tasks' task list already lets unrelated
recurring jobs live side by side.

This spec makes a **Loop** a first-class, independently configured and run
entity — a project can hold several, each with its own stages, budgets, goal/
acceptance criteria, optional path scope, log, and run history — while
leaving Auto Tasks' own UI, task list, and behavior untouched. Auto Task's
list+detail layout is used only as the visual reference for the Loop page's
new list+detail structure.

This is **Spec A** of two. **Spec B** (separate, later) extends the Mac↔iOS
`SharedProtocol` and the iOS Loop screen, and adds an Auto Task "which loop"
picker for the scheduled sweep, so the phone and the scheduler can target any
named loop instead of only the Primary one. Spec B depends on the shapes this
spec introduces (loop `id`, the loop list) and is out of scope here.

## Data model

`LoopEngineConfig` (stages, budgets, `protectedPathPolicy`, etc.) is
unchanged — it keeps meaning exactly what it means today. A new wrapper gives
it identity and the richer per-loop contract fields:

```swift
struct LoopDefinition: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var isPrimary: Bool = false
    var goal: String? = nil
    var acceptanceCriteria: String? = nil
    var scopeGlobs: [String] = []
    var config: LoopEngineConfig
}

struct LoopEngineProjectStore: Codable, Equatable {
    var loops: [LoopDefinition]
}
```

- **`isPrimary`**: exactly one loop per project is Primary. It is the loop
  the scheduled `.loopEngineering` Auto Task and (today, pre-Spec-B) the
  phone target. `LoopEngineProjectStore` does not enforce the invariant at
  the type level; call sites that read it fall back to `loops.first` if none
  is marked, and the UI never allows unsetting the only Primary without
  designating a new one first (setting a different loop Primary clears the
  flag on the old one in the same edit).
- **`goal` / `acceptanceCriteria`**: free text, optional. When set, both are
  appended to the prompt built for a `.skill` stage and for
  `AgentLoopStageRepairer`'s repair prompt — the loop's "done" signal stops
  being purely mechanical (stages pass) and includes what the loop is
  actually trying to achieve. `nil`/empty changes nothing about today's
  prompts.
- **`scopeGlobs`**: optional path allowlist, empty by default (unrestricted —
  today's behavior for every existing and migrated loop). Checked inside
  `RepairScopeGuard.withScopeGuard` alongside the existing protected-path
  denylist: a changed path must match `scopeGlobs` (when non-empty) or it is
  treated as a scope violation using the same `protectedPathPolicy`
  (revert/warn/stop) the denylist already uses. The denylist always wins —
  a path can be in-scope and still protected. Implemented entirely inside
  `LoopEngineRunner.withScopeGuard` (not `RepairScopeGuard.swift`'s own
  protocol) — Swift protocol requirements can't carry default arguments, and
  this avoids updating every existing call site in `RepairScopeGuardTests.swift`
  for a check that belongs to the runner's policy layer, not the guard itself.

## Storage & migration

`system/loop.json`'s schema moves from a bare `LoopEngineConfig` to
`LoopEngineProjectStore`. `LoopEngineConfigStore.load` gets one more fallback
step, in the same spirit as its existing file→legacy-UserDefaults chain:

1. Try decoding `LoopEngineProjectStore`.
2. On failure, try decoding the old bare `LoopEngineConfig`. If that
   succeeds, wrap it as `LoopDefinition(name: "Main Loop", isPrimary: true,
   config: legacy)`, write the file back in the new schema immediately, and
   return the wrapped list.
3. On failure, fall through to today's legacy-UserDefaults check, wrapped the
   same way.

This mirrors the existing migration comment's intent exactly: "a project
configured before this existed becomes portable the first time it is opened,
with no action from the user." `LoopEngineConfigStore`'s public surface
changes to load/save `LoopEngineProjectStore` (a `[LoopDefinition]`); a new
`LoopEngineConfigStore.primaryLoop(projectRoot:projectId:)` convenience
resolves the Primary loop for the two call sites (see "Auto Task and mobile
touch points" below) that only need one loop's config, not the whole list.

## Runner, journal, and log threading

- **`LoopEngineRunner.run(...)`** gains `loopId: String` and `loopName:
  String`, threaded through every call that constructs a `LoopRunRecord`
  exactly as `projectId` already is.
- **Concurrency stays per-`gitRoot`, not per-loop.** `isRunActive(gitRoot:)`
  continues to guard the whole working tree — only one loop, of however many
  a project defines, may run against a given `gitRoot` at a time. Two loops
  mutating the same working tree concurrently is a correctness hazard (races
  on the same files/branch) not worth solving with scope-aware concurrency in
  this spec. A loop refused because another loop is running shows the same
  "already in progress" message the single-loop case shows today.
- **Which loop owns an active run** is recorded alongside the existing
  process-wide `activeRoots` guard — a parallel `activeLoopIds: [String:
  String]` (gitRoot path → loopId), set/cleared at the same two points
  `activeRoots` already is. A new static `LoopEngineRunner.activeLoopId(
  gitRoot:) -> String?` lets the list pane's running dot land on the correct
  loop regardless of whether the run was started from this page, another
  window, or the Auto Task scheduler — mirroring the reasoning
  `MobileControlManager.buildLoopState()` already documents for `running`
  itself ("a run started on the desktop or by the scheduler is reported
  honestly instead of appearing idle to the phone").
- **`LoopRunRecord`** gains `loopId: String?` and `loopName: String?`
  (`decodeIfPresent`, defaulting to `nil` — old journal entries predate loops
  and are understood as "the legacy/primary loop"). `LoopRunIndexEntry`
  mirrors both fields so the Past Runs list can filter by the selected loop.
- **Log key**: `TaskLogStore` is keyed by plain `String`, not exclusively the
  `AutoTask` enum, so per-loop log lines use the composite key
  `"loopEngineering:\(loopId)"` in place of the bare
  `AutoTask.loopEngineering.rawValue`. `AutoTask.loopEngineering` still names
  one Auto Task category; call sites that append to it now pass the
  loop-scoped key. `LoopEngineView`'s own `onLog` mirror (into the shared log
  store, see file header comment) updates to use this composite key for
  whichever loop is selected.

## Mac UI redesign

`LoopEngineView` gains a new left-most pane, list-of-loops, ahead of today's
three-pane workspace:

- **Loop list pane (new)**: each project's `[LoopDefinition]`, showing name,
  a ★ badge on the Primary loop, and a running/idle dot (reading the shared
  `isRunActive(gitRoot:)` guard plus which loop currently owns the active
  run). Toolbar `+` creates a new loop — name it, then optionally continue
  into the existing `NewLoopWizardView` to pick a starter template. Each
  row's `⋯` menu: `Set as Primary`, `Duplicate`, `Delete` (refuses to delete
  the last remaining loop or the Primary loop without first requiring another
  be designated Primary).
- **Everything currently in `LoopEngineView`** — the Stages pane, the detail
  pane's OVERVIEW / TEMPLATE / PROCESS / SETTINGS / OUTPUT sections, the log
  pane, Past Runs — becomes the detail view for **whichever loop is selected**
  in the new list pane. Internals are unchanged; they're re-scoped from "the
  project's one config" to "the selected `LoopDefinition`'s config."
- **OVERVIEW** gains two fields: Goal (single-line `TextField`) and
  Acceptance Criteria (multi-line, matching the section's existing text-field
  style).
- **SETTINGS** gains an optional Scope editor (a list of glob strings,
  editable the same way `extraProtectedGlobs` is today) beside the existing
  protected-path policy picker.
- Autosave / flush-on-disappear / flush-on-quit logic is unchanged in
  mechanism, keyed by `(projectId, loopId)` instead of only `projectId`.
- The top-level "New Loop" toolbar button is removed from the detail pane
  (superseded by the list pane's `+`); the detail pane's toolbar keeps Run /
  Stop / status text, now describing the selected loop's run.

## Auto Task and mobile touch points (mechanical only)

Two existing call sites read `LoopEngineConfigStore`'s old single-config API
and must adapt to the new shape. Neither gains new UI, settings, or
user-visible behavior in this spec — both keep working exactly as they do
today, resolved against the Primary loop:

- **`AutoCodeUpdateService+PipelineTasks.swift`**, `runLoopEngineeringSweep`:
  switches its `LoopEngineConfigStore.load` call to
  `LoopEngineConfigStore.primaryLoop(...)` and threads the resolved loop's
  `id`/`name` into `LoopEngineRunner.run`. No change to Auto Task's own UI,
  task list, custom tasks, or scheduling surface.
- **`MobileControlManager.resolveLoopConfig` / `buildLoopState`**: same
  switch to `primaryLoop(...)`. The phone continues to see one loop's status
  exactly as it does today. Extending it to list/target any loop is Spec B.

## Testing

- **Migration**: unit tests for the three-step decode fallback (new schema →
  legacy bare-config file → legacy UserDefaults), confirming a pre-existing
  project's stages/budgets survive unchanged inside the new "Main Loop"
  wrapper, and that it is marked Primary.
- **`LoopDefinition` / `LoopEngineProjectStore`**: `Codable` round-trip tests
  for the new optional fields, matching `LoopStage`'s existing
  `decodeIfPresent`-with-default pattern.
- **`RepairScopeGuard`**: a test for the new allowlist check — a changed path
  inside `scopeGlobs` passes; a changed path outside an explicitly non-empty
  `scopeGlobs` is treated as a violation under the loop's
  `protectedPathPolicy`; an empty `scopeGlobs` changes nothing (regression
  guard against today's tests).
- **Runner/journal**: a run against a project with 2+ loops records the
  correct `loopId`/`loopName` on its `LoopRunRecord`, and the log store
  receives lines under that loop's composite key only.
- **UI**: manual verification per this repo's testing conventions (no
  automated SwiftUI test suite) — create a second loop, confirm independent
  stages/log/history from the first; confirm a migrated project shows one ★
  Primary loop with its prior stages intact; confirm Auto Task's own screens
  are visually and behaviorally unchanged.

## Out of scope (Spec B)

- `SharedProtocol` wire changes (`loop_list`, `loopId` on existing
  requests/replies) and the iOS Loop screen becoming a loop list + per-loop
  detail.
- An Auto Task settings picker for "which loop the scheduled sweep runs."
