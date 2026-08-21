# Loop per-stage run from iPhone — design

Date: 2026-08-21
Status: approved

## Problem

The iOS Loop page has one Start button that runs the active project's whole
loop (every enabled stage) via the Mac's `loopEngineering` auto task. Stages
are listed read-only. The user wants to run each stage separately from the
phone — the same capability the Mac desktop already has as "Run this stage
only" (`LoopEngineView.swift:344`).

A secondary question — whether loop info should cross Mac↔iPhone as JSON like
Explorer does — needed no work: `LoopMessages.swift` already uses the same
JSON `Codable` wire-type pattern.

## Approach (chosen: A)

Route the phone's per-stage run through the existing auto-task path
(`AutoCodeUpdateService` → `runLoopEngineeringSweep`) with a stage filter,
exactly as `loop_start` already routes full runs. Rejected alternatives:

- **B — MobileControlManager calls a runner directly**: violates the
  handler's stated "no second runner construction" principle and loses log
  streaming to the shared per-task buffer, which the phone's live log reads.
- **C — optional field on the existing `loop_start`**: version-skew hazard.
  An older Mac ignores unknown JSON fields, so a "run one stage" request
  would silently run the whole pipeline. A new tag makes an old Mac fail
  loudly (no reply → the phone's existing "Mac never answered" banner).

## Wire protocol (`ios_app/SharedProtocol`)

- `MobileProtocol.Tag` gains `loopStartStage = "loop_start_stage"`.
- New message `LoopStartStage: Codable { type, stageId: String }`. The reply
  is the existing `LoopAck`.
- `LoopStageInfo` gains `stageId: String?` — the Mac-side `LoopStage.id`
  UUID string. Optional because an older Mac's snapshot omits it; the phone
  hides per-stage run buttons when it is nil. The synthetic list-identity
  `id` (`"order-name"`) stays unchanged.

## Mac side

- **Shared solo-mapping helper**: extract the inline "force-enable the
  target, disable every other stage" mapping from
  `LoopEngineView.runLoop(only:)` (lines ~1124–1135) into one helper (e.g.
  `LoopStage.soloing(_:id:)`). Both the desktop menu action and the sweep
  use this single implementation. Journal snapshots keep recording the full
  pipeline with skipped stages marked disabled.
- **`AutoCodeUpdateService`**: add a dedicated entry point
  `runSingleLoopStage(stageId: String) -> Bool` that shares the existing
  `runTask` re-entrancy guard with `runSingle(_:)` and threads
  `onlyStageId: String?` into `runLoopEngineeringSweep` (the generic
  `runSingle(_:)`/`runOne(_:)` signatures stay untouched — other tasks have
  no use for a stage id). After the config is
  loaded and `ensureDefaultStages` runs: unknown stage id → `taskErrors`
  entry and no run; otherwise apply the solo mapping and continue as today.
  A solo run force-enables its target, so the "every stage disabled → parked"
  guard does not block it.
- **`MobileControlManager.handleLoop`**: new `loopStartStage` case with the
  same guards as `loopStart` (service wired, configured, not running) plus a
  stage-existence check against the current config — a vanished stage gets
  `LoopAck(accepted: false, "That stage no longer exists — refresh.")`. A
  successful start sets `loopStartedHere = true`.
- **`buildLoopState()`** includes `stageId` on each `LoopStageInfo`.

## iOS side

- **`LoopStore.startStage(stageId:)`** mirrors `start()` — same send, ack
  handling, and no-answer timeout machinery.
- **`LoopView`** stage rows gain a trailing ▶ button. Shown only when
  `stage.stageId != nil`; disabled while a run is in flight or disconnected.
  Enabled even for disabled stages — matching the Mac's force-enable solo
  semantics. Footer becomes "Edit stages on the Mac. ▶ runs just that stage."
- `actionStatus` reuse for run feedback, as with full Start.

## Error handling

| Case | Behavior |
|---|---|
| Old Mac + new phone | Unknown tag → Mac logs "Unhandled loop type", no reply → existing no-answer banner (commit b849ae8) |
| Stage deleted since snapshot | `LoopAck(accepted: false)` with explicit message |
| Run already in flight | Same "run in progress" ack as full start; button also disabled client-side |

## Testing

- **SharedProtocol** (`make test-shared-protocol`): `LoopStartStage`
  round-trip; `LoopStageInfo` decodes older-Mac JSON (no `stageId`) as nil.
- **Mac**: sweep-level test — 3-stage config + `onlyStageId` → runner
  receives only the target enabled (force-enabled when it was disabled);
  unknown id → error and no run. Unit test for the solo-mapping helper.
- **iOS**: manual verification on simulator/device — button visibility, a
  per-stage run, live log during the run.
- Server (`extension/`) is untouched.
