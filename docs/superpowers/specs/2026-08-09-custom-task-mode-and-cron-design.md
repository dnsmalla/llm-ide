# Custom-task mutating mode + per-task cron

**Status:** Approved (design) — 2026-08-09
**Stacked on:** PR #42 (`fix/auto-task-correctness`) — both touch `runCLI`; this branch develops against the corrected prompt-arg mapping.

## Goal

Give `CustomAutoTask` two capabilities it lacks today:
1. **Mutating mode** — a custom task can persist (commit) its changes instead of being silently read-only.
2. **Per-task cron** — a custom task can be scheduled (cron) like the 13 built-in `AutoTask`s, not just manual ▶.

## Background

Today `CustomAutoTask` is `{ name, template, isEnabled, createdAt, id }` — a single-shot, **manual-only** prompt task. `runCustomTask` feeds the template to `runCLI(prompt:)`, which **unconditionally** calls `discardWorkingTreeChanges` after the run, so a custom task whose template edits files silently reverts everything and still reports success. And there is no scheduling path for custom tasks — `dueTasks`/`runDue` iterate only the 13 built-in `AutoTask` cases.

## Design decisions (approved)

- **Mutating mode:** a `mode: Mode { case review, implement }` field (default `.review`). `.review` = read-only (discard, current behavior). `.implement` = run on an isolated `fix/custom-<slug>-<ts>` branch and **commit** changes (no discard). The branch is isolated — it never touches the user's working branch.
- **Cron:** a `cron: String?` field (nil = manual-only, default). Parsed by the existing `CronExpression`; the scheduler runs enabled custom tasks whose cron is due alongside the built-ins.

## Data model — `CustomAutoTask`

Add two fields (backward-compatible decode — existing persisted tasks read as `.review` / nil):
- `mode: Mode` where `enum Mode: String, Codable { case review, implement }`.
- `cron: String?`.

The custom Codable/init must `decodeIfPresent` both (existing payloads predate them). Encode the full set.

## Behavior — `runCustomTask` + `runCLI(prompt:)`

- `.review` → today's path: `runCLI(prompt:)` + discard.
- `.implement` → `runCLI(prompt:, persistChanges: true)`, which:
  1. dirty-tree guard (already present),
  2. creates + checks out `fix/custom-<slug>-<ts>` (slug from the task name; ts for uniqueness),
  3. runs the CLI (same prompt/arg/model path as today),
  4. **skips** `discardWorkingTreeChanges`,
  5. commits any working-tree changes (`git add -A` + `git commit`) on that branch.

`runCLI(prompt:)` gains a `persistChanges: Bool = false` parameter. Default `false` preserves today's behavior for the 5 built-in prompt tasks and `.review` custom tasks. The branch/commit steps mirror `runCLI(issue:)`'s posture but are prompt-driven, with no issue-tracker wiring.

## Scheduling — cron for custom tasks

`AutoTaskSettings` already owns per-built-in cron + `nextFireAt` (keyed by `AutoTask.rawValue`). Add the parallel for custom tasks, keyed by `CustomAutoTask.id`:
- `customCronNextFireAt(for id:) -> Date?` / `setCustomCronNextFireAt(_:for:)`.
- `dueTasks(now:)` extended to also yield enabled custom tasks whose `cron != nil` and `nextFireAt <= now`.
- `runDue` runs due custom tasks via the existing `runSingleCustom` re-entrancy path (shares the `runTask` guard with built-ins).
- `realignNextFire` extended to push a due custom task's next fire into the future before running (same anti-double-fire logic as built-ins).

Manual ▶ (`runSingleCustom`) is unchanged and works regardless of cron.

## UI

`AddCustomAutoTaskSheet` (+ edit path) gains:
- a **mode** picker (Review / Implement),
- an optional **cron** text field (with the same validation/helper the built-in cron editor uses).

The custom-task row surfaces mode + cron so the user can tell scheduled/mutating tasks apart at a glance.

## Testing

- `CustomAutoTask` Codable round-trip: mode + cron set; **backward-compat** decode of an old payload (no mode/cron) → `.review` / nil.
- `dueTasks` / `realignNextFire` for custom tasks (extend `AutoTaskSettingsCronTests`): a custom task with cron is due at the right time; manual (cron=nil) custom task is never auto-scheduled.
- Branch-name helper (`fix/custom-<slug>-<ts>`) as a pure, tested function.
- The commit path itself is hard to drive end-to-end (hardcoded `Process`), so it is not unit-tested — covered by the pure helpers + manual smoke.

## Out of scope

- `reviewMerge` does **not** pick up `fix/custom-*` branches — a custom implement task's branch is pushed/MR'd manually (same as today's manual custom flow).
- Per-custom-task model override — custom tasks use the resolved run model.
- Editing the cron schedule from the row (the edit sheet covers it).

## References

- [CustomAutoTask.swift](mac/Sources/LlmIdeMac/Models/AutoCode/CustomAutoTask.swift)
- [AutoCodeUpdateService.swift](mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift) — `runCustomTask`, `runSingleCustom`, `runDue`/`dueTasks`/`realignNextFire`
- [AutoCodeUpdateService+CLI.swift](mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+CLI.swift) — `runCLI(prompt:)` / `runCLI(issue:)`
- [AutoTaskSettings.swift](mac/Sources/LlmIdeMac/Services/AutoCode/AutoTaskSettings.swift) — cron + `nextFireAt`
- [AddCustomAutoTaskSheet.swift](mac/Sources/LlmIdeMac/Views/AutoCode/AddCustomAutoTaskSheet.swift)
