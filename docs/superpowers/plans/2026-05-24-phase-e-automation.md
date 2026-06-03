# Phase E — Memory-Loop Automation Plan

**Goal:** Two automations on top of Phase A-D so the memory features become self-healing:

1. **Auto-flip bug status on regression** — when `RegressionRunner` detects drift on a `fixed` bug, immediately re-open it (file frontmatter + in-app badge).
2. **Menu-bar status pill** — surface open bug count + last regression-run summary in the existing `MenuBarMenu`, with click-through to the relevant tab.

**Spec:** Items 1 + 2 of the automation recommendations in this session's prior turn.

---

## Task 1: Auto-reopen regressed bugs

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Services/RegressionRunner.swift`
- Modify: `mac/Tests/MeetNotesMacTests/RegressionRunnerTests.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Regression/RegressionView.swift` (badge for "auto-reopened")

- [ ] **Step 1: Extend `RegressionRunner.Result` with an `autoReopened` flag** (defaults false).
- [ ] **Step 2: In `run(at:)`, when verdict resolves to `.regressed`, call `store.updateBugStatus(at: bugURL, to: .open)` and set `autoReopened = true` on the result.** Wrap in `try?` — file-write failure must not break the run.
- [ ] **Step 3: New test** — write a `fixed` bug, give the prompter a drifted reply, run, then `store.loadBug(at: url).status == .open` must hold.
- [ ] **Step 4: Show `(auto-reopened)` next to "REGRESSED" in `RegressionView.row` when the flag is set.**
- [ ] **Step 5: Commit.**

## Task 2: Menu-bar status pill

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Models/Config.swift` (add `lastRegressionRunAt` + `lastRegressionRegressedCount`)
- Modify: `mac/Sources/MeetNotesMac/Services/RegressionRunner.swift` (write those AppConfig fields at end of run)
- Modify: `mac/Sources/MeetNotesMac/MeetNotesMacApp.swift` (`MenuBarMenu` gains rows + click handlers)
- Modify: `mac/Sources/MeetNotesMac/Views/AppShell.swift` (Notification.Name + onReceive to switch sections)

- [ ] **Step 1: AppConfig — two new `@Published`s.**
  - `lastRegressionRunAt: Date?` (UserDefaults key `lastRegressionRunAt` as Double timeIntervalSince1970)
  - `lastRegressionRegressedCount: Int` (UserDefaults key `lastRegressionRegressedCount`)
- [ ] **Step 2: `RegressionRunner.init` accepts an `AppConfig?` (optional for test injection).** At end of `run`, set both fields to current values on the main actor.
- [ ] **Step 3: `RegressionView.init`** — pass `config` through to `RegressionRunner`.
- [ ] **Step 4: `Notification.Name.openSection`** in AppShell. AppShell `.onReceive` parses the `object` (`String` matching `ShellState.Section.rawValue`) and sets `shell.section`. Bring the window to front via `NSApp.activate(ignoringOtherApps: true)`.
- [ ] **Step 5: `MenuBarMenu`** — add `@EnvironmentObject var config: AppConfig`. Compute open bug count from `MemoryStore.listBugs(at: repo).compactMap { try? store.loadBug(at: $0) }.filter { $0.status == .open }.count`, but cache it via a `@State` refreshed on `onAppear` and a 30s timer so menu-render isn't FS-bound. Render between the recording row and the session row:
  - `🐜 N open bug reports` → opens `.graphify` (memory tab is its third sub-tab; user lands one click away)
  - `Last regression: N drifted · <relative date>` → opens `.regression`
  - Suppress each row when its value is zero AND `lastRegressionRunAt == nil`.
- [ ] **Step 6: Make `MenuBarMenu` rows clickable** — wrap each in `Button { post .openSection(rawValue) }`. Use `.buttonStyle(.plain)` so menu styling is preserved.
- [ ] **Step 7: Wire `.environmentObject(config)` on the `MenuBarExtra` content** in `MeetNotesMacApp.body` (next to existing theme/session/capture).
- [ ] **Step 8: Commit.**

## Task 3: Verification

- [ ] `swift build` clean.
- [ ] `swift test --filter "RegressionRunnerTests"` — auto-reopen test passes.
- [ ] Full suite: only the two pre-existing unrelated failures.
- [ ] Smoke: file a bug, mark fixed, mutate the agent answer (or use a stub repo), run regression → bug auto-flips to Open, menu-bar pill shows the count.

---

## Self-Review

| Requirement | Task |
|---|---|
| Drift → bug reopened automatically | Task 1 Step 2 |
| User can see it happened (not silent) | Task 1 Step 4 (badge) |
| Glanceable status from menu bar | Task 2 Steps 5-7 |
| Click-through to relevant tab | Task 2 Steps 4, 6 |
| Survives app restart | Task 2 Step 1 (UserDefaults persistence) |

No spec gaps.
