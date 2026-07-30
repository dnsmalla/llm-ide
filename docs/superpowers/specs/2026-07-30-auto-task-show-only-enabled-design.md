# Auto Tasks — "Show only enabled" filter

**Date:** 2026-07-30
**Branch:** `feat/auto-task-show-only-enabled`
**Surface:** macOS app (Auto Tasks page) + mobile mirror

## Goal

Add an on/off setting so the Auto Tasks page shows only the tasks the user has
toggled **on** ("necessary"), hiding off-task rows and the category headers that
become empty as a result. This declutters the page to the active task set.

## Background

- `AutoTaskSettings` (`mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift`) is the
  single source of truth: 12 `run*` `@Published` flags, each with `didSet`→save,
  `init` read, and `userDefaultsDidChange` sync. Generic accessors
  `isEnabled(task:)` / `setEnabled(_:task:)` already exist.
- `AutoCodeView` (`mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`) renders
  the page: an Enable/Disabled header, then 4 hand-written category blocks
  (Pipeline / Review / Automation / Maintenance) of `taskRow`s, then Model & Limits,
  history, and Run Now. Every task is always shown.
- `AutoTask` (defined in `AutoCodeView.swift`) is `CaseIterable` with `label` and
  `icon` properties that already match the labels/icons the view passes by hand.
- `MobileControlManager.buildAutoTaskState()` sends `AutoTask.allCases.map { … }`
  to the iPhone, so the mobile Auto Tasks view is driven by that snapshot.

## Design

### 1. New persisted setting — `AutoTaskSettings`

Add `@Published var showOnlyEnabledTasks: Bool`, following the exact existing
pattern (didSet→`save`, `init` read, `userDefaultsDidChange` re-read).

- UserDefaults key: `autoCodeShowOnlyEnabledTasks`
- Default: `false` (preserves today's "show everything" behavior)

### 2. Auto Tasks page — `AutoCodeView` left pane

- Add a compact **"Show only enabled"** toggle row directly under the
  Enabled/Disabled header (before the task list), bound to
  `$autoTaskSettings.showOnlyEnabledTasks`.
- Replace the 4 static category blocks with a data-driven
  `groups: [(title: String, tasks: [AutoTask])]` constant. For each group:
  - Compute `visible = group.tasks.filter { !showOnlyEnabledTasks || isEnabled(task: $0) }`.
  - Render the category header + its rows **only when `!visible.isEmpty`**
    (empty category headers disappear automatically).
  - Rows use `task.label` / `task.icon` and a generic binding built from
    `isEnabled` / `setEnabled` (no per-task duplication).
- **Empty state:** when the filter is on and zero tasks are enabled, show a muted
  hint: *"No enabled tasks — turn off 'Show only enabled' to manage all tasks."*
- `selectedTask` is left as-is; if the selected task becomes hidden it still
  renders in the right pane (not broken, just not re-selectable while hidden).

### 3. Mobile sync — `MobileControlManager.buildAutoTaskState`

When `showOnlyEnabledTasks` is on, filter the `infos` array to enabled tasks only,
so the iPhone mirrors the same filtered list. Re-enabling a hidden task is done on
the Mac with the filter off (consistent with the Mac UX).

### 4. Test — new `mac/Tests/LlmIdeMacTests/AutoTaskSettingsTests.swift`

Round-trip the flag through a temporary `UserDefaults` suite (matching the existing
`ChatSessionStoreTests` / `KeychainStoreCacheTests` style):

- default is `false` on a fresh defaults instance
- setting `showOnlyEnabledTasks = true` persists across a new `AutoTaskSettings`
  instance backed by the same defaults

(View-level filtering is not unit-tested; the setting + `isEnabled` logic is.)

## Out of scope

- A per-task "visibility" flag (the task's own on/off state drives visibility).
- Sending the flag as a wire field for the iPhone to filter client-side (we filter
  Mac-side instead — simpler, one codebase).
- Changing menu-bar summary behavior.

## Testing checklist (manual)

- [ ] Default: page shows all 12 tasks across 4 categories (unchanged).
- [ ] Toggle "Show only enabled" on: only enabled-task rows remain; a category with
      no enabled tasks hides its header too.
- [ ] Filter survives quit/relaunch.
- [ ] Empty state shows when filter on + nothing enabled.
- [ ] iPhone Auto Tasks view mirrors the filtered set when paired.
- [ ] `swift build` clean; `swift test` green.
