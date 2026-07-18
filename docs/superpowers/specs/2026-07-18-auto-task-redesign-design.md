# Auto Task Page Redesign — Design

- **Date:** 2026-07-18
- **Status:** Approved (design); pending implementation plan
- **Owner:** dinesh
- **Related:** `AUTO_TASK_AUDIT_REPORT.md` (2026-07-15), `AUTO_TASK_SETTINGS_UNIFICATION.md`

## Context

The Auto Task feature (mac app; code identifiers still say "AutoCode") runs an automated
pipeline: scan meeting notes for action items → create issues → implement pending issues via
CLI → run per-task-type review prompts → regression sweep → knowledge report → plan-status
refresh.

Three problems motivated this redesign:

1. **"It always processes the same task" — and we can't tell what's going on.** The current log
   surface is a 220-pt "Findings (last run)" card that shows a 6 000-char file tail, per task,
   for only the most recent run. Mid-run there is nothing to see. Investigation found no
   server-side task queue — the feature is 100 % mac-client-driven
   (`AutoCodeUpdateService.run()`). Candidate root causes are documented in
   §10 (follow-up); this redesign delivers the per-task live observability needed to *confirm*
   which candidate is real, but intentionally does **not** bundle an unconfirmed behavior fix.
2. **Template editing has no markdown awareness.** Each template task's right pane is a bare
   `TextEditor`; the user wants markdown with a rendered preview.
3. **Heavy duplication across surfaces.** Enabled toggle, per-task toggles, Run Now/Stop, status,
   and interval each appear in 2–3 of {Auto Task page, Settings, Menu Bar}.

The user also requested a new **Resource auto-task** (fetch email/Slack/record meeting →
generate note → add to graph/issues). That is a separate, backend-heavy piece and is explicitly
out of scope here (§9).

## Goals

1. Each of the 8 tasks gets a redesigned right-pane page: **markdown template + live preview**
   (5 prompt tasks) or a **rendered About/config page** (3 structural tasks), plus a **per-task
   live log**.
2. Each task's log is **live-streamed** (lines appear as the CLI runs), **accumulates across
   runs** (timestamped), is **scrollable and resizable**, and has a **Clear** button.
3. **Per-task Run** (▶ in a task's header) runs just that one task in isolation, in addition to
   the existing global Run Now (timer auto + manual).
4. **Settings decluttered** to global knobs only; per-task surfaces live on the Auto Task page,
   quick status/run stays in the Menu Bar.
5. Both modes — auto (timer) and manual (Run Now / per-task ▶) — share one execution path and
   behave identically.

## Non-goals

- The Resource auto-task (email/Slack/meeting → note/graph/issues) — separate follow-up spec.
- The "always same task" behavior fix — fast-follow after the new logs confirm root cause
  (§10). No unconfirmed fix is bundled into this work.
- Rewriting the proven pipeline logic (git stash/restore, branch rescue, prompt-injection
  fencing, dirty-tree guard, commit verification, usage auto-fallback). Those stay intact.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Sequencing | Redesign first (this spec); Resource task is a follow-up. |
| 2 | Task coverage | All 8 tasks get the new page. 5 prompt tasks → editable md template + preview; 3 structural (Regression, Knowledge, Update Plan Status) → rendered About/config page; all get the live log. |
| 3 | Page layout | Stacked: **Preview / Edit / Log** (top → bottom). Log section resizable + collapsible. |
| 4 | Run model | Global Run Now (timer auto + manual) **plus** per-task ▶ Run (runs one task, ignores its enable checkbox). |
| 5 | Log behavior | **Live** streaming + **accumulate across runs** (timestamped), in-memory ring buffer (~2 000 lines/task), **Clear** wipes on-screen history only (`.log` file kept). |
| 6 | Settings | Global knobs only (Enabled / Run every / Scan last / Auto-stash / repo warning). Per-task toggles, Run/Status, regression sub-options move out. |
| Approach | Implementation | **Approach 1** — per-task `TaskLogStore` + decompose `run()` into per-task methods + `Pipe`-based live streaming + reuse `SelfSizingMarkdownView` for preview. |

## Architecture

The feature becomes a **per-task system**. Each task is a first-class unit: identity
(icon/label), enable toggle, template+preview or About/config, a per-task live log, and a
runnable body. Surfaces de-duplicate by responsibility:

| Surface | Owns |
|---|---|
| Auto Task page | Per-task identity, enable toggles, template editor + preview, live log, per-task ▶ Run, global Run, history |
| Settings | Global knobs: Enabled, interval, lookback, auto-stash, repo warning |
| Menu Bar | Quick status + global Run Now/Stop + View Logs (unchanged) |

Manual (global Run, per-task ▶) and auto (timer) both reach the engine through the same
per-task methods, so any engine fix affects both modes identically.

## Components

### `TaskLogStore` *(new — `mac/Sources/LlmIdeMac/Services/TaskLogStore.swift`)*

`@MainActor final class TaskLogStore: ObservableObject` — the single source of truth for live
logs, replacing the current `taskOutputs: [String: String]` post-run snapshot.

- `@Published private(set) var buffers: [String: [LogLine]]` keyed by `AutoTask.rawValue`.
- `struct LogLine: Identifiable { let id: UUID; let timestamp: Date; let level: Level; let text: String }`
  with `enum Level { case info, error }`.
- Ring buffer: caps each task at the last **~2 000 lines** (drop oldest). Lines **accumulate
  across runs** — never auto-cleared — so repeated runs of the same task are visible.
- API: `append(_ task: AutoTask, text: String, level: Level = .info)`,
  `clear(_ task: AutoTask)` (on-screen only; the `.log` file is untouched), `clearAll()`.
- `append` is fed from the CLI `Pipe` `readabilityHandler` (a background queue); it hops to
  `@MainActor` before mutating `buffers`.

### `AutoCodeUpdateService` refactor *(existing — `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`)*

- Holds an injected `let logStore: TaskLogStore`. Adds
  `@Published private(set) var currentTask: AutoTask?` (drives the per-task spinner / "running
  now" indicator in the page).
- **Naming note:** the existing stored `Task` handle is `private var runTask: Task<Void, Never>?`
  (the re-entrancy guard). The new per-task method is named `runSingle(_:)` to avoid clashing
  with it.
- Decompose the monolithic `run()` (~lines 189–588) into per-task bodies
  (`runReviewCode()`, `runReviewDoc()`, `runReviewConflicts()`, `runGenerateDoc()`,
  `runUpdateIssues()`, `runRegression()`, `runKnowledge()`, `runUpdatePlanStatus()`) plus the
  existing action-extract → create-issue → implement pipeline. `run()` becomes a thin
  orchestrator that runs the pipeline then iterates **enabled** tasks in the fixed left-pane
  order. Public entry points:
  - `runNow()` — **unchanged** public global-run entry (timer, Menu Bar, page, Settings all
    already call it). It still sets the `runTask` re-entrancy guard and delegates to the
    refactored `run()` orchestrator. No call-site churn.
  - `runSingle(_ task:)` — **new** per-task ▶: resolve backend/project + usage-limit check,
    then run **only** that task's body, **ignoring its enable checkbox**. Shares the same
    `runTask == nil` re-entrancy guard.
- Each task body logs a start line, streams CLI output, and logs a done/error line to
  `logStore[task]`.
- **Subprocess streaming:** change `runCLI(issue:)` (~line 997) and `runCLI(prompt:)`
  (~line 1124) from `process.standardOutput/standardError = logFileHandle` to a `Pipe` whose
  `readabilityHandler` decodes `availableData` into lines, **tees** them to the `.log` file
  **and** to `logStore.append(task, …)`. The file therefore remains the full persistent record;
  the in-memory buffer is the live, capped, on-screen view. All existing guarantees stay intact:
  prompt-injection nonce fencing, dirty-tree guard, commit verification (HEAD advanced past
  base), base-branch rescue, usage auto-fallback via `/kb/usage/resolve`, allow-list gating.

### `AutoCodeView` right-pane page *(existing — `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`)*

Per the locked stacked layout, `templateEditor(_ task:)` becomes:

- **Header:** task icon + label + **▶ Run** (`runSingle(task)`) + Restore Default
  (templates only). Shows `currentStep` while this task is the running one.
- **Preview (top):** `SelfSizingMarkdownView(markdown: template)` (reused from
  `Views/Library/`) for the 5 template tasks. For the 3 structural tasks, a rendered
  About/config view (replaces the current `structuralTaskDescription`).
- **Edit (middle):** `TextEditor` (mono) bound to the template (templates only). Structural
  tasks show their config controls here — the **Regression** options (attempt-repair /
  auto-reopen / verify-timeout) relocate from Settings into this section.
- **Log (bottom):** `ScrollView` + `LazyVStack` of timestamped `LogLine`s from
  `logStore.buffers[task.rawValue]`, mono. Header row "Log · live" + **Clear** button
  (`logStore.clear(task)`). Default height materially larger than today's 220 pt; resizable via
  a drag handle and collapsible.
- **Footer:** last-run status (unchanged).

### `AutoCodeSettingsSection` *(existing — `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`)*

Slim to global knobs only. **Keep:** Enabled, Run every (interval), Scan last (lookback count /
days), Auto-stash, no-linked-repo warning. **Remove:** the 8 per-task toggles (already on the
Auto Task page left pane), Run Now / Stop / Reveal Logs / Status row (on the page + menu bar),
Regression sub-options (→ Regression About/config page).

### `MenuBarAutoTaskView` *(existing)* — unchanged.

## Data flow

```
Timer (auto) ─┐
Global Run ───┼─▶ runNow()  ─▶ run() [pipeline] ─▶ for each enabled task: runSingle(task)
Per-task ▶ ───┘                                  └─▶ (or) runSingle(task) directly
                                                │
                              runCLI(...) ─ Pipe.readabilityHandler ─┐
                                                │                     │
                                  tee ──────────┤                     │
                                                │                     ▼
                                          .log file           logStore.append(task)
                                                                    │ (@Published)
                                                                    ▼
                                              open task's Log ScrollView re-renders live
```

- **Clear** → `logStore.clear(task)` → buffer empties on screen; `.log` file persists.

## Error handling

- CLI non-zero exit / no-commit / dirty-tree / usage-paused / pipe-read failure: each appends an
  **error `LogLine`** (`.error`, rendered red) to that task's buffer **and** sets the existing
  `taskErrors[task]` banner — so failures are visible both in the stream and as a banner.
- Ring-buffer cap drops the oldest lines silently; the `.log` file retains full history.
- On app restart, in-memory buffers reset (the file is the persistent record). Acceptable, since
  Clear is on-screen only by design.
- Re-entrancy: a second trigger while a task is in flight is dropped (`runTask == nil` guard),
  unchanged.

## Testing

- `TaskLogStoreTests` — append, ring-buffer cap (oldest dropped), `clear`/`clearAll`,
  per-task isolation.
- `AutoCodeUpdateServiceTests` — `runSingle` runs **only** the chosen task; `runNow()` (via the
  orchestrator) iterates enabled tasks in order; per-task logs land in the correct buffer;
  usage-paused skips the task; cancel mid-task stops the stream.
- A tiny "emit N lines then exit" helper subprocess to assert streamed lines arrive in order
  with timestamps, for both `runCLI(issue:)` and `runCLI(prompt:)` paths.
- Settings: existing `AppConfigAutoCodeTests` still pass (defaults unchanged); verify regression
  options are bound at their new location on the Regression About page.
- Per project convention: verify with `swift build` / `swift test`, not SourceKit alone (stale
  SourceKit errors are known here).

## File touch list

| File | Change |
|---|---|
| `mac/Sources/LlmIdeMac/Services/TaskLogStore.swift` | **New.** Per-task ring-buffer log store. |
| `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` | Inject `logStore`; add `currentTask`, `runSingle(_:)`; decompose `run()` into per-task methods; switch both `runCLI` overloads to `Pipe` + tee. |
| `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` | Redesign `templateEditor` into Preview / Edit / Log; add per-task ▶ Run + Clear; bind to `logStore`; relocate regression config for the Regression task. |
| `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` | Slim to global knobs; remove per-task toggles, Run/Status, regression sub-options. |
| `mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarAutoTaskView.swift` | Unchanged. |
| `mac/Tests/LlmIdeMacTests/TaskLogStoreTests.swift` | **New.** |
| `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceTests.swift` | Extend for `runAll` / `runSingle` / streaming. |

## Follow-ups (explicitly out of scope)

### 9. Resource auto-task
New task type: fetch email / Slack / record meeting → generate note → add to graph / issues.
Heavy backend (source connectors, email/Slack auth, meeting capture, KB writes). Its own spec,
built on top of the per-task surface introduced here.

### 10. "Always same task" behavior fix
Once the per-task live logs land, use them to **confirm** which candidate is the real root cause
(systematic debugging — no fix without confirmed root cause). Documented candidates from the
investigation:

1. **Review/Doc/Generate prompts re-run every tick with no change-detection**
   (`AutoCodeUpdateService.swift` ~lines 485–551). The leading suspect: on the auto loop the
   identical Review Code prompt runs every interval forever. After confirmation, gate these on
   "something changed since last run" (new commits / new docs) or make the recurrence explicit
   and visible.
2. **Failed issues retry up to 3× across runs** (`ProcessedActionsRegistry.pendingEntries()`,
   lines 98–106) — bounded, but contributes to "same issue again."
3. **Unregistered actions when `createIssue` is allow-list-blocked** (~lines 332–358): actions
   are only `register`-ed inside the gated loop, so `isKnown` stays false and the same meeting
   actions are re-extracted every tick.
4. **Stuck-implementing reset only at bootstrap** (`resetStuckImplementing`, lines 122–138): an
   entry stuck `.implementing` is hidden from `pendingEntries()` until next app launch.

The fix chosen will be a small follow-up spec/plan after the logs confirm the cause.
