# Per-task Cron Auto Tasks (Claude-schedule mirror) — Design

**Date:** 2026-08-01
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/`)

## Goal

Replace the Auto Tasks' single shared run interval (`intervalMinutes`) with a **per-task cron expression**, mirroring Claude Code's `/schedule` model: each of the 12 Auto Tasks runs on its own cron schedule, shows its next-fire time, and is independently enableable. The global interval setting is removed.

## Background — current state

- `AutoTaskSettings` (`mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift`) holds the master `enabled` toggle, a single shared `intervalMinutes`, lookback/regression options, and a per-task enable flag for each of 12 tasks (`runReviewCode`, `runSourceUpdate`, …). All enabled tasks share the one interval.
- `AutoCodeUpdateService` (`mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`) arms a single repeating `Timer` at `intervalMinutes * 60`s that calls `runNow()` → runs every enabled task. It exposes `runNow()` (all) and `runSingle(task)`. The timer is re-armed when `intervalMinutes` changes.
- `AutoTask` enum is `CaseIterable, Identifiable` (defined in `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift:540`); 12 cases.
- UI: `AutoCodeView` (the Auto Tasks page), `AutoCodeSettingsSection` (Settings), `MenuBarAutoTaskView` (menu-bar popover showing "Every X min", Run/Stop, last-run stats).

## Decisions (from brainstorming)

- **Schedule type:** cron expression per task (exact Claude-Code `/schedule` mirror) — not interval-per-task, not time-of-day.
- **Scheduler mechanism:** a ~60-second tick that evaluates each enabled task's cron and runs due tasks (Approach A), **not** per-task timers. Acceptance: ~1-minute scheduling granularity is fine for these tasks.
- **Manual runs are schedule-independent:** `runNow()` / `runSingle(task)` do **not** change `nextFireAt`; the cron cadence is unaffected by manual triggers.
- **Catch-up policy:** after a long sleep, an overdue task runs **once**, then `nextFireAt` realigns to the future (no burst of make-up runs).
- **Remove the global interval:** `intervalMinutes` + its UI are removed. Master `enabled`, per-task enables, lookback, and regression options stay.
- **No external dependency:** a small built-in 5-field cron parser/`nextFire` (matches the repo's dependency-light style).

## Architecture

```
AutoTaskSettings                                  ← per-task: cron (String) + nextFireAt (Date?) + enabled
   │
   ▼
CronExpression (new, pure, Sendable)              ← parse("0 9 * * 1-5") → nextFire(after:, now:) -> Date?
   │
   ▼
AutoCodeUpdateService — 60s tick (Timer)
   on tick, for each task where settings.enabled && settings.isEnabled(task):
      if let next = settings.nextFireAt(for: task), Date() >= next:
         runSingle(task)
         repeat { settings.advanceNextFire(for: task) } while settings.nextFireAt(for: task)! <= Date()
   runNow() / runSingle(task) unchanged (manual; do not touch nextFireAt)
```

`nextFireAt` is recomputed (`expr.nextFire(after: now)`) whenever a task's cron is edited or it becomes enabled. Master `enabled` off → tick is a no-op.

## Cron engine

New file `mac/Sources/LlmIdeMac/Services/CronExpression.swift`:

- `struct CronExpression: Sendable, Equatable` — parsed 5-field value.
- `static func parse(_ s: String) -> CronExpression?` — fields: `minute hour day-of-month month day-of-week`. Supports `*`, comma lists (`1,5,10`), ranges (`1-5`), step (`*/15`, `9-17/2`). Returns `nil` for malformed input.
- `func nextFire(after: Date, now: Date = Date()) -> Date?` — next matching whole-minute strictly after `after`; `now` is an injectable parameter (no hidden clock → testable). `nil` only when the cron can never match (e.g. `0 0 30 2 *` — Feb 30).
- `var describe: String` — human label ("Every 30 min", "At 09:00", "At 09:00, Mon–Fri") for UI hints.

Pure (no I/O, no singletons); the `now` parameter is the only time dependency.

## Components

**New:**
- `mac/Sources/LlmIdeMac/Services/CronExpression.swift` — cron parser + `nextFire` + `describe`.

**Changed:**
- `mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift` — add per-task `cron` + `nextFireAt` (persisted) with generic accessors `cron(for:)`/`setCron(_:for:)`/`nextFireAt(for:)`/`setNextFireAt(_:for:)`/`advanceNextFire(for:)`; add the one-time `intervalMinutes → cron` migration in `init`; **remove** `intervalMinutes`, `intervalDescription`, and their persistence/`didChange` plumbing.
- `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — replace the single repeating-interval `Timer` with the 60s cron tick; recompute `nextFireAt` on cron-edit/enable; keep `runNow()`/`runSingle(task)` semantics (manual, schedule-independent).
- `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — each task row gains a cron `TextField` (validated), a `describe` hint, and a next-fire label; rows sit above the "Run All Now" button.
- `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` — remove the global interval picker.
- `mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarAutoTaskView.swift` — replace "Every X min" with the soonest upcoming fire ("Next: Review Code — Mon 09:00"); keep Run/Stop/status.

**Untouched:** the 12 task bodies (`runTaskBody`, `runOne`, etc.), `AutoTask` enum cases, connectors, mobile mirror wire format (the mobile surface reads `enabled` + per-task enable; it can adopt cron display in a follow-up).

## Migration

One-time, in `AutoTaskSettings.init`: if the old `autoCodeIntervalMinutes` UserDefaults key exists **and** per-task cron keys do not, seed **every** task's cron from the interval, persist, then delete the old key:

| Old `intervalMinutes` | Seed cron |
|---|---|
| `<60` (N) | `*/N * * * *` |
| `60` | `0 * * * *` |
| `1440` | `0 0 * * *` |
| other (H hours) | `0 */H * * *` |

Disabled tasks get the same seed but stay disabled (per-task enable unchanged), so a user who later enables one gets a sane default cron. Users with no prior interval (fresh install) get `0 * * * *` (hourly) as the default cron for every task.

## UI

- **`AutoCodeView` task row** (above the page-level "Run All Now"):
  `[enable toggle] [task name] [cron TextField] [next-fire label]`, with the `describe` hint under the field. Cron is validated on edit (`CronExpression.parse`); an invalid string shows a red "invalid cron" hint and is **not** saved (the field reverts to the last valid cron on commit). Next-fire formatted via a `DateFormatter` ("next: Mon 09:00").
- **Removed:** the global interval picker in `AutoCodeSettingsSection`; the "Every X min" line in `MenuBarAutoTaskView`.
- **Menu bar popover:** shows the soonest `nextFireAt` across enabled tasks ("Next: Review Code — Mon 09:00"); if none enabled, "No tasks scheduled".

## Edge cases

- **Invalid cron** → not saved, task flagged, never scheduled.
- **Impossible cron / no next fire** → next-fire label shows "no upcoming fire"; task skipped by the tick.
- **Long sleep** → on wake the next tick runs the overdue task once, then realigns `nextFireAt` to the future (the `repeat…while` loop).
- **Manual Run Now / Run Single** → does not modify `nextFireAt`.
- **Master disabled** → tick is a no-op.
- **Per-task disabled** → that task skipped.
- **Cron edited while armed** → recompute that task's `nextFireAt = expr.nextFire(after: now)` immediately.
- **Backward compatibility** → migrated interval becomes an equivalent cron; existing users see no change in cadence.

## Testing

- `CronExpressionTests` — `parse` + `nextFire` for `*`, lists, ranges, steps, DOW (`* * * * 1-5`), month; invalid strings → `nil`; impossible cron → `nil`; all via an injected `now` for determinism.
- `AutoTaskSettingsCronTests` — per-task `cron`/`nextFireAt` persistence (round-trip via a throwaway `UserDefaults` suite); the migration matrix (60 → `0 * * * *`, 30 → `*/30 * * * *`, 1440 → `0 0 * * *`, 120 → `0 */2 * * *`); `intervalMinutes` is gone after migration.
- `AutoCodeUpdateServiceCronTests` — with a fake clock / injectable `now`: overdue task → runs once + `nextFireAt` advances to the future; multi-interval gap → exactly one run then realign; disabled task / master-off → no-op; `runSingle` does not shift `nextFireAt`; cron edit recomputes `nextFireAt`.

Verify with `swift build` / `swift test` from `mac/` — the editor's SourceKit "errors" are stale in this repo; the build is the source of truth.

## Scope guardrails / deferred

- No new tasks added; the 12 existing tasks keep their bodies.
- Mobile mirror adopts the cron/next-fire display in a follow-up (the wire format carries `enabled` + per-task enable today; cron is mac-local state for now).
- No cron import/export or cloud sync of schedules.
- `describe` covers common shapes; exotic crons fall back to the raw expression string.
