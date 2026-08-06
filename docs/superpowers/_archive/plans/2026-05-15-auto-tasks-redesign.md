# Auto Tasks Redesign — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Scope:** macOS app (`llm-ide/mac`)

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