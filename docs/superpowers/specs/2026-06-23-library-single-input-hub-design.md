# Library as the Single Input Hub — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorm)
**Component:** macOS app (`mac/`)

## Goal

Make the **Library** the only place a file or folder enters a project. Every other
panel that needs content stops opening its own file picker and instead **selects
from items already in the Library**, filtered to the categories relevant to that
panel.

## Background — current state

The Library (`LibraryItemStore` + `LibraryView`) already indexes a project's
content under four categories (`code`, `data`, `notes`, `meetings`/Sources) with
explicit per-section **Add File / Add Folder** buttons (copy-on-add for files;
external code folders referenced in place via `AppConfig.localCodeFolders`).

Mapping the five content-consuming panels showed the scope is small:

| Panel | Today | Action |
|-------|-------|--------|
| `ReviewView` | Selects within an embedded Library tree (no own picker) | **No change** — already conforms |
| `UAGraphView` (Code Graph) | Reads `LibraryItemStore.items` filtered by mode | **No change** — already conforms |
| `RegressionView` | Reads Library tree + on-disk fault reports | **No change** — already conforms |
| `CodeAssistantPanel` | `NSOpenPanel` attaches arbitrary disk files/folders into `attachments[]`, bypassing the Library | **Convert** |
| `DocGenSourcePanel` | `fileImporter` adds source files via its own picker | **Convert** (template import stays) |

So "convert all consumers in one plan" = build one shared picker + convert **two**
panels, and document that the other three already satisfy the rule.

## Decisions (from brainstorming)

- Other panels' pickers are **replaced** by a "pick from Library" selector (not kept as a fallback).
- The Library keeps **explicit per-category Add** buttons (the user picks code/data/notes/source).
- The selector is **filtered to the categories relevant** to each consumer.
- All consumer conversions land in **one implementation plan**.
- **No "Browse…" fallback** in the selector — the strict single-add-point rule. If an item isn't in the Library, the user adds it via the Library first.

## Architecture

A single reusable `LibraryPicker` sheet, driven by the existing
`LibraryItemStore` (the source of truth). Two panels adopt it; the three
already-conforming panels are left unchanged.

## Components

### 1. `LibraryPicker` (new) — `mac/Sources/LlmIdeMac/Views/Library/LibraryPicker.swift`

A SwiftUI sheet.

- **Inputs:** `allowed: [LibraryItem.Category]`, `mode: SelectionMode` (`.single` | `.multi`), `title: String`, and an `onConfirm: ([LibraryItem]) -> Void` completion.
- Reads `LibraryItemStore` from the environment, filters items to `allowed`, groups by category, reuses existing row rendering (`LibraryFileRow`-style).
- Confirm / Cancel buttons; `.multi` shows checkable rows, `.single` confirms on tap.
- **Empty state:** "No {category names} in the Library yet — add them from the Library." No control that adds content from inside the picker.
- **Pure, testable core:** `static func filter(_ items: [LibraryItem], allowed: Set<LibraryItem.Category>) -> [LibraryItem]` (and a grouping helper) so selection logic is unit-tested without the UI, mirroring `FileClassifier`.

### 2. `CodeAssistantPanel` — convert

- Remove both `NSOpenPanel`s (attach file ~`:1292`, attach folder ~`:1313`).
- Add one **"Add from Library"** action presenting `LibraryPicker(allowed: [.code, .notes, .data], mode: .multi)`.
- Selected items populate `attachments[]` via their in-project `path`/`url`. De-dupe against attachments already present.

### 3. `DocGenSourcePanel` — convert

- Remove the **source** `fileImporter` (~`:38`) that adds source files.
- Add **"Add from Library"** presenting `LibraryPicker(allowed: [.notes, .data, .meetings], mode: .multi)`; selected items become DocGen sources.
- Leave the **template** `fileImporter` (~`:47`) unchanged — templates are app assets, not project content.

*(The per-consumer `allowed` sets are the "relevant" filter and are easily tuned later.)*

## Data flow

```
Library menu (per-category Add, copy-on-add / external-folder reference)
        │
        ▼
LibraryItemStore.items   ← single source of truth (@Observable, in environment)
        │  filter(allowed)
        ▼
LibraryPicker (sheet)  ──onConfirm──▶  consumer stores selected items' in-project paths
```

No copying happens in consumers — copy-on-add already occurred at Library add
time. External code folders already surface as `.code` items, so they are
pickable without special handling.

## Error handling / edge cases

- **Empty category:** picker shows the empty state pointing back to the Library; there is no in-picker add.
- **Picked item later removed from the Library:** the consumer skips the now-missing path. `CodeAssistantPanel` already tolerates missing attachments; `DocGenSourcePanel` guards before use.
- **No project bound:** Library is empty and its Add buttons are disabled (existing behavior); the picker shows the empty state.
- **Multi-select:** the picker returns the chosen set; each consumer de-dupes against what it already holds so the same item isn't added twice.

## Testing

- **Unit:** `LibraryPicker.filter(_:allowed:)` and the grouping helper — pure functions, covered like `FileClassifierTests`.
- **Build:** `swift build` verifies compilation of the sheet + both conversions.
- **GUI behavior** (sheet presentation, attachment/source wiring) is verified manually / on CI with full Xcode — the dev box has no `xctest` runner, so test targets can't execute locally.

## Out of scope

- Changing the Library's own Add UX (stays explicit per-category).
- The three already-conforming panels (`ReviewView`, `UAGraphView`, `RegressionView`).
- DocGen's template import.
- A browse-and-add-to-Library shortcut inside the picker (deliberately excluded; can be revisited if the strict rule proves too rigid).
