# Custom Auto Tasks — Design

**Date:** 2026-08-06
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/`), mobile wire protocol (`ios_app/SharedProtocol/`)

## Goal

Let the user create their own Auto Task (a name + a prompt template) from the Auto Tasks page, alongside the 12 built-in tasks — and have it show up and run correctly from the iPhone companion app, the same as a built-in task.

## Background — current state

- `AutoTask` (`mac/Sources/LlmIdeMac/Models/AutoCode/AutoTask.swift`, moved out of `AutoCodeView.swift` in a prep commit) is a **closed** `enum: String, CaseIterable` with 12 fixed cases. Every property (`label`, `icon`, `logSuffix`, `templateBinding`, `isStructural`, `requiresLinkedRepo`) is a `switch self` enumerating all 12 — there is no `.custom(String)` case and no data-driven list anywhere in the stack.
- 5 of the 12 built-ins (`reviewCode`, `reviewDoc`, `reviewConflicts`, `generateDoc`, `updateIssues`) already work by running a stored prompt string through a **generic** function, `AutoCodeUpdateService.runCLI(prompt:localPath:logSuffix:logDir:task:)` — this is the mechanism a custom task will reuse. The other 7 are hardcoded Swift logic (git ops, API calls) and are out of scope here.
- `AutoTaskSettings` (`Models/AutoCode/AutoTaskSettings.swift`) holds per-task enable flags as 12 individually-named `@Published Bool` properties, dispatched via `switch task` in `isEnabled(task:)`/`setEnabled(_:task:)` — not generic over task identity.
- `TaskLogStore` (`Services/AutoCode/TaskLogStore.swift`) is keyed by `AutoTask` directly; all 55 existing call sites pass an `AutoTask` case literal.
- **Mobile path has no database.** Confirmed by investigation: `MobileControlManager.buildAutoTaskState()` builds `AutoTaskInfo` entries live from `AutoTask.allCases` on every request/push; the iPhone app (`AutoTaskStore.swift`, `AutoTaskView.swift`) has zero hardcoded task ids — `ForEach(state?.tasks ?? [])` is fully data-driven, with a generic icon fallback for unknown ids. `installMobilePushObservers()` already subscribes to `autoCode.objectWillChange` / `autoTaskSettings.objectWillChange` (debounced ~350ms) and auto-pushes state to a paired phone on any change — this already exists for built-in tasks today.
- A very similar problem is already solved elsewhere in this app: `CustomProvider` (`Models/CustomProvider.swift`) — named, user-created, `UserDefaults`-JSON-persisted entries with static `loadAll()`/`saveAll()` + instance `save()`/`delete()`, `isEnabled` stored directly on the struct. This is the template for `CustomAutoTask`.

## Decisions (from brainstorming)

- **Task capability:** prompt-only (mirrors the 5 template-based built-ins), not the full structural/git-ops kind — reuses `runCLI(prompt:)` as-is, no new execution engine.
- **Scheduling:** v1 is Enable + manual "Run Now" only, no cron. (The per-task-cron feature landed 2026-08-01 for built-ins only; custom tasks can adopt it in a follow-up.)
- **Enabled-state storage:** on the `CustomAutoTask` struct itself (`isEnabled: Bool`), like `CustomProvider` — not a separate dictionary on `AutoTaskSettings`. One source of truth per task.
- **Mobile sync:** built-in tasks keep their existing automatic Combine-based push. Custom tasks are a plain struct (not independently `ObservableObject`-observed), so their mutations (add/toggle/delete/run) each explicitly trigger the same underlying push — **plus** a user-visible "Refresh" button on `AutoCodeView` that calls it too, for an explicit "synced now" affordance. Both call one new small public method on `MobileControlManager`.
- **`TaskLogStore`:** add a parallel `String`-keyed overload (`append(_ id: String, ...)`, `clear(_ id: String)`, `lines(for id: String)`) rather than changing its existing `AutoTask`-typed API — zero risk to the 55 existing call sites, which all pass `AutoTask` literals unchanged.
- **File layout:** Auto Task files now live under matching `Models/AutoCode/`, `Services/AutoCode/`, `Views/AutoCode/` subfolders (landed in a prep commit before this spec) — `CustomAutoTask.swift` and the new add-task sheet land there too.

## Architecture

```
CustomAutoTask (new struct, Models/AutoCode/)
   Codable, Identifiable — id, name, template, isEnabled, createdAt
   static loadAll() / saveAll(_:)  — UserDefaults JSON, key "customAutoTasks"
   instance save() / delete()       — same shape as CustomProvider
        │
        ├─ AutoCodeView (Mac UI)
        │     "Add Task" button → AddCustomAutoTaskSheet → CustomAutoTask(...).save()
        │     "Custom" category in the task list (5th, after Pipeline/Review/Automation/Maintenance)
        │     enable toggle / tap → detail pane (name, editable template, Run Now, log) / delete
        │     "Refresh" button → mobileControl.refreshAutoTaskStateForMobile()
        │
        ├─ AutoCodeUpdateService.runCustomTask(_ task: CustomAutoTask) async
        │     resolveBackendAndProject() → runCLI(prompt: task.template, logSuffix: task.id, ...)
        │     (same pipeline the 5 built-in template tasks already use)
        │
        └─ MobileControlManager
              buildAutoTaskState() — appends CustomAutoTask.loadAll() as AutoTaskInfo entries
              handleAutoTask(run/toggle) — AutoTask(rawValue:) miss → look up in CustomAutoTask.loadAll()
              refreshAutoTaskStateForMobile() (new, public) — wraps existing pushAutoTaskStateIfPaired()
```

## Data model

`Models/AutoCode/CustomAutoTask.swift`:

```swift
struct CustomAutoTask: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    var template: String       // the prompt — same role as autoTaskTemplateReviewCode etc.
    var isEnabled: Bool = true
    var createdAt: Date = Date()
}

extension CustomAutoTask {
    static let defaultsKey = "customAutoTasks"
    static func loadAll() -> [CustomAutoTask]
    static func saveAll(_ tasks: [CustomAutoTask])
    func save()     // upsert by id, mirrors CustomProvider.save()
    func delete()
}
```

No separate "category" — custom tasks render under one flat "Custom" section, not grouped like the 4 built-in categories (Pipeline/Review/Automation/Maintenance).

## Execution

New method on `AutoCodeUpdateService`:

```swift
func runCustomTask(_ task: CustomAutoTask) async {
    // Same resolveBackendAndProject() + logDir + runCLI(prompt:) pipeline
    // the 5 built-in prompt tasks use in runTaskBody's switch — this is
    // effectively that one branch, generalized to take the prompt and
    // logSuffix as parameters instead of switching on a fixed case.
}
```

Reuses `hasResolvableBackend` (already side-effect-free, added for the Settings-freeze fix) for a "no linked repo" guard consistent with built-in tasks.

## Mac UI (`AutoCodeView`)

- **"Add Task" button** in the left-pane header (next to the enable toggle / "Show only enabled" row) opens `AddCustomAutoTaskSheet` — name field + multi-line prompt `TextEditor`, styled like `FileNamePromptSheet`. Save → `CustomAutoTask(name:template:).save()` → reload `customTasks` → `mobileControl.refreshAutoTaskStateForMobile()`.
- **"Refresh" button** next to it: calls `mobileControl.refreshAutoTaskStateForMobile()` directly — no local state change, purely a "push to phone now" action.
- **Left-pane list:** custom tasks appended as a 5th, flat "Custom" section after the 4 existing categories. Each row: enable toggle, name, tap-to-select. Context menu or swipe: Delete (→ `.delete()` → reload → push).
- **Detail pane** (parallel `@State private var selectedCustomTask: CustomAutoTask?` alongside the existing `selectedTask: AutoTask?` — only one is non-nil at a time, avoiding a deeper refactor of the existing selection type): name (read-only after creation, v1), editable template `TextEditor` (saved on change, debounced or on-blur), Run Now button (`await autoCode.runCustomTask(task)`), and a log view backed by the new `TaskLogStore` string-keyed overload.

## Mobile wire protocol

- `MobileControlManager.buildAutoTaskState()`: after building `allInfos` from `AutoTask.allCases`, append `CustomAutoTask.loadAll().map { AutoTaskInfo(id: $0.id, label: $0.name, enabled: $0.isEnabled, lastError: nil) }` before applying the existing "show only enabled" filter — custom tasks participate in that filter identically to built-ins.
- `handleAutoTask` run/toggle: `AutoTask(rawValue: idString)` failing falls through to `CustomAutoTask.loadAll().first { $0.id == idString }`; toggle mutates + `.save()`s the struct and calls `refreshAutoTaskStateForMobile()`; run calls `autoCode.runCustomTask(_:)`.
- `buildAutoTaskLogsReply()`: append custom tasks' logs the same way, via the new string-keyed `TaskLogStore` overload.
- No `AutoTaskInfo` shape change needed — `id` was already documented as "AutoTask.rawValue" but is really just an opaque string on the wire; custom task ids (UUIDs) satisfy that shape unchanged.

## `TaskLogStore` generalization

Internal storage becomes `[String: [LogLine]]` (was `[AutoTask: [LogLine]]`). Existing methods become thin wrappers:

```swift
func append(_ task: AutoTask, _ text: String, level: Level = .info) { append(task.rawValue, text, level: level) }
func append(_ id: String, _ text: String, level: Level = .info) { /* real implementation */ }
// same pattern for clear(_:) and lines(for:)
```

All 55 existing call sites (which pass `AutoTask` literals) are untouched.

## Edge cases

- **Empty name or empty template on Add** → Save disabled (mirrors `FileNamePromptSheet`'s inline validation), no silent empty task.
- **Delete while running** → the Delete action is disabled (not just hidden) whenever `autoCode.currentTask` matches that custom task's id, mirroring the disabled-state pattern already used elsewhere in this view. The in-flight run is left alone; deletion becomes available again once it finishes.
- **No linked repo** → `runCustomTask` guards on `hasResolvableBackend` exactly like the 5 built-in template tasks; same warning banner path (already added to `AutoCodeView` in the Settings-cleanup work) covers custom tasks too since it's not task-specific.
- **iPhone requests a run for a since-deleted custom task id** → lookup miss → same "not configured"/error reply path `handleAutoTask` already uses for unknown ids.
- **Duplicate name** → allowed (matches `CustomProvider`, which also permits duplicate names — id is the real identity).

## Testing

- `CustomAutoTaskTests` — round-trip `save()`/`loadAll()`/`delete()` via a throwaway `UserDefaults` suite (mirrors however `CustomProvider` is tested, if it has existing tests — otherwise this is the first coverage for the pattern).
- `TaskLogStoreTests` — new string-keyed `append`/`clear`/`lines` behave correctly; existing `AutoTask`-keyed calls still route to the same underlying storage (an `AutoTask` and its `.rawValue` string see the same log lines).
- `AutoCodeUpdateServiceCustomTaskTests` — `runCustomTask` follows the same resolve/guard/runCLI path as a built-in template task (can likely reuse whatever test doubles exist for `runCLI`/`resolveBackendAndProject`, if any).
- Manual verification (noted in plan, since mobile end-to-end can't be driven from this environment): pair an iPhone, add a custom task on Mac, confirm it appears on iPhone without restarting the phone app, toggle/run it from the phone, confirm the Mac reflects the run.

## Scope guardrails / deferred

- No scheduling/cron for custom tasks in v1.
- No non-prompt (structural/git-ops) custom tasks.
- No editing the *name* after creation in v1 (template is editable; recreate to rename — cheap to add later if wanted).
- No import/export or sharing of custom tasks across machines.
- No limit enforced on the number of custom tasks (matches `CustomProvider`, which has none either).
- No creating or deleting a custom task from the phone — `MobileControlManager` only wires up run/toggle for custom tasks; the iOS `AutoTaskView` row UI has no add/delete affordance either. Creation and deletion are Mac-only in v1.
