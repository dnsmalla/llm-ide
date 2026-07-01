---
title: Library sidebar visual refresh
status: draft
date: 2026-06-17
---

# Library sidebar visual refresh

## Goal

Give the macOS Library sidebar (`Views/Library/LibraryView.swift`) one coherent,
theme-aware visual system. The sections added in the recent Sources / nested
code-tree / collapsible Agents·Skills·Plugins work are functionally complete but
render in two divergent header styles with hardcoded colors. This refresh
unifies the chrome and routes all color through the active `Theme`.

**No functional behavior changes** beyond making every section collapsible
(an affordance unification, see §3). Selection, add/import menus, swipe-delete,
the data model, and persistence are untouched.

## Problems being fixed

1. **Two header systems.** File-tree sections (Sources, Code, Data, Notes) use
   `sectionHeader()` — not collapsible, "+" menu, color from `category.uiColor`.
   Agents / Skills / Plugins use three bespoke headers — collapsible chevron,
   each hardcoding its own color.
2. **Raw / hardcoded colors** (`.blue`, `.purple`, `.teal`, RGB literals in
   `LibraryView.swift` and `LibraryItem+UI.swift`). This violates the rule added
   in `Theme.swift` ("never use raw system colors … they look wrong in
   Midnight") — the new sections do not adapt to the active palette.
3. **Three sub-group styles.** Sources sub-groups use a `DisclosureGroup`
   (chevron); Agents/Skills sub-groups are plain inline labels (no chevron).
4. **Inconsistent empty states.** "No X files yet" / "Loading skills…" are each
   styled ad hoc and don't match the polished "No Meetings Yet" card.

## Design

### 1. Unified `SectionHeader`

A single header builder replaces `sectionHeader()`, `agentsHeader`,
`skillsHeader`, and `pluginsHeader`. Signature (conceptual):

```
SectionHeader(
  title: String,            // "SOURCES", "CODE", "AGENTS", …
  icon: String,             // SF Symbol
  tint: Color,              // resolved from the theme (see §2)
  count: Int,               // shown as a count pill when > 0
  isExpanded: Binding<Bool>,// every section is collapsible (see §3)
  trailing: () -> Menu?     // optional "+" / install menu, far right
)
```

Chrome (identical for all 7 sections): a left collapse chevron rotating
0°→90°, an 18×18 tinted icon chip (`tint.opacity(0.12)` rounded rect bg),
an 11pt heavy uppercase label with 0.5 tracking in `tint`, a count pill in
`tint.opacity(0.6)`, a spacer, then the optional trailing menu button.
Top padding 12, bottom 3 (matches current rhythm).

### 2. Theme-aware category hues

`LibraryView` gains `@EnvironmentObject private var theme: ThemeStore` (the
established pattern across `Views/Library/`). A small resolver maps each section
family to a hue **derived from the active `Theme`** so it shifts across
Dark/Light/Midnight while keeping categories visually distinct:

| Section family        | Theme source                          |
|-----------------------|----------------------------------------|
| Sources, Notes (blue) | `theme.info` (accent2)                 |
| Code, Skills (green)  | `theme.success` (accent3)              |
| Data (purple)         | purple derived from palette luminance¹ |
| Agents                | `theme.accent` (brand)                 |
| Plugins (teal)        | `theme.accent` shifted / `accent2` mix¹|

¹ The palette has no purple/teal slot. A `Theme.categoryHue(_:)` helper returns
palette tokens where they fit and, for purple/teal, a fixed hue blended toward
the theme's text luminance so it reads correctly on each background rather than
a raw `.purple`/`.teal`. Exact blend tuned during implementation against all
three themes. `LibraryItem+UI.swift`'s `uiColor`/`folderTint` are updated to
consume the same resolver (passed the active theme) so folder tints match.

### 3. Uniform collapse

All seven sections are collapsible with the same chevron. File-tree sections
(Sources/Code/Data/Notes) gain a persisted expand state; they default to
expanded (they are primary content). Agents/Skills/Plugins keep their current
collapsed-by-default behavior. Expand state persists via `@AppStorage` keyed by
section so it survives relaunch.

### 4. Unified sub-group rows

One `subGroupRow` style for Sources (Meetings/Mail), Agents (Built-in/Personas/
Plugins), and Skills (Global/Core/Plugins): small SF icon in the family tint,
caption label, count, consistent 16pt indent. The collapsible ones (Sources)
keep their chevron; the always-shown labels (Agents/Skills) read as quiet
group headers in the same metrics.

### 5. Consistent empty states

A single `emptyRow(icon:text:)` helper: small tertiary SF icon + muted caption,
used for every "No … yet" / loading row. The top "No Meetings Yet" card style is
kept as the section-level empty state.

## Out of scope

- No change to selection tags, the detail pane, or `ShellState`.
- No change to add/import/delete actions or the data model.
- The extension Help Guide refresh is a **separate** spec/cycle.

## Risk & verification

Low risk — one view file plus the `LibraryItem+UI.swift` color resolver and a
small `Theme` helper. `ShellState.Section` and exhaustive switches are not
touched. Verify by compiling the mac target (`GIT_CONFIG_GLOBAL=/dev/null` build
outside the sandbox) — `swift test` does not run on this machine, so correctness
is verified by reading + a clean build. Visual check across Dark/Light/Midnight
in the running app.
