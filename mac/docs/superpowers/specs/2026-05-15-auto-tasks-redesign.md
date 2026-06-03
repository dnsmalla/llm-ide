# Auto Tasks Redesign — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Scope:** macOS app (`meet-notes/mac`)

---

## Goal

Rename "Auto Code" to "Auto Tasks" throughout the app, and replace the current single-column Auto Tasks page with a two-pane layout: a left pane for task selection and run history, and a right pane for editing the CLI prompt template for each task type.

---

## Changes

### 1. Rename "Auto Code" → "Auto Tasks"

All occurrences updated:

| Location | Change |
|---|---|
| `SidebarView.swift` | Label `"Auto Code"` → `"Auto Tasks"` |
| `AutoCodeView.swift` | `.navigationTitle("Auto Code")` → `.navigationTitle("Auto Tasks")` |
| `AutoCodeSettingsSection.swift` | Card title `"Auto Code Update"` → `"Auto Tasks"` |
| `AutoCodeView.swift` | Empty-state body text updated to say "Auto Tasks" |

SF Symbol unchanged: `arrow.triangle.2.circlepath.circle`.

---

### 2. `AppConfig` — three new template properties

```swift
@Published var autoTaskTemplateReviewCode: String        // default: see below
@Published var autoTaskTemplateReviewDoc: String         // default: see below
@Published var autoTaskTemplateReviewConflicts: String   // default: see below
```

All persisted to `UserDefaults`. Defaults:

```
autoTaskTemplateReviewCode:
  "Review the recent commits in this repository. Check for bugs, security issues,
   and code style problems. Write a summary to REVIEW.md."

autoTaskTemplateReviewDoc:
  "Review the documentation in this repository. Update any docs that are out of
   date with recent code changes. Fix unclear or incomplete sections."

autoTaskTemplateReviewConflicts:
  "Check for and resolve any merge conflicts in this repository. Create a branch
   named fix/conflicts, resolve all conflicts, commit, and push."
```

---

### 3. `AutoCodeView` — two-pane layout

Replace the current single-column view with a `HSplitView` (or `NavigationSplitView` with fixed left column).

#### Left pane (~260 px, fixed)

```
┌─ Auto Tasks ──────────────────┐
│  [✓] Review Code       >      │  ← selected (highlighted)
│  [✓] Review Doc               │
│  [ ] Review Conflicts         │
│  ─────────────────────────    │
│  Run history                  │
│  ○ Fix login bug   pending    │
│  ✓ Update README   done       │
│  …                            │
│  ─────────────────────────    │
│  [ Run Now ]                  │
└───────────────────────────────┘
```

- Each task row has: checkbox toggle (on/off) + task name + icon
- Tapping anywhere on the row selects it (highlights it) and loads its template in the right pane
- Run history is the existing `ProcessedActionsRegistry` entries (status icons + text)
- "Run Now" button at the bottom — disabled while `isRunning`

#### Right pane (fills remaining space)

```
┌─────────────────────────────────────────────────────┐
│  ⬡  Review Code                                      │
│  ──────────────────────────────────────────────────  │
│  Prompt template                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ Review the recent commits in this            │   │
│  │ repository. Check for bugs, security         │   │
│  │ issues, and code style problems. Write       │   │
│  │ a summary to REVIEW.md.                      │   │
│  └──────────────────────────────────────────────┘   │
│  [ Restore Default ]                                 │
└─────────────────────────────────────────────────────┘
```

- `TextEditor` bound directly to the matching `AppConfig` template property
- Changes auto-save to `UserDefaults` on every keystroke (via `@Published` `didSet`)
- "Restore Default" button resets the property to its hardcoded default string
- Right pane shows a placeholder ("Select a task to edit its template") when nothing is selected

---

### 4. `AutoCodeUpdateService` — use templates in run loop

When `run()` fires, after processing meeting-note actions → GitLab issues, iterate over enabled task types and invoke the CLI with the task's template as the prompt:

```swift
// For each enabled task type (in order: reviewCode, reviewDoc, reviewConflicts):
if config.autoCodeRunReviewCode {
    await runCLI(prompt: config.autoTaskTemplateReviewCode, localPath: project.localPath, logSuffix: "review-code")
}
if config.autoCodeRunReviewDoc {
    await runCLI(prompt: config.autoTaskTemplateReviewDoc, localPath: project.localPath, logSuffix: "review-doc")
}
if config.autoCodeRunReviewConflicts {
    await runCLI(prompt: config.autoTaskTemplateReviewConflicts, localPath: project.localPath, logSuffix: "review-conflicts")
}
```

`runCLI` signature gains a `logSuffix: String` parameter (replaces `issue:`) so logs go to `auto-code-review-code.log` etc.

The existing meeting-note → issue → implement flow is unchanged and runs first.

---

## Files to Create / Modify

| File | Change |
|---|---|
| `Models/Config.swift` | Add 3 template `@Published` properties + `init` loading |
| `Services/AutoCodeUpdateService.swift` | Add template-based CLI runs after issue flow; update `runCLI` signature |
| `Views/AutoCode/AutoCodeView.swift` | Full rewrite to two-pane layout |
| `Views/Shell/SidebarView.swift` | Rename label |
| `Views/Settings/AutoCodeSettingsSection.swift` | Rename card title |

---

## Out of Scope

- Variable substitution in templates (`{repo_path}` etc.) — plain text only
- Per-meeting-action templates — templates are per task type, not per action item
- Import/export of templates
