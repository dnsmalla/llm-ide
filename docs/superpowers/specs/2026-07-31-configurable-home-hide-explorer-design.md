# Configurable Home landing — make Explorer hideable

**Date:** 2026-07-31
**Branch:** `feat/configurable-home-hide-explorer`
**Surface:** macOS app shell (toolbar Home button, panel switcher, Settings)

## Problem

Explorer can't be hidden from Settings → Menu Bar even though it's in
`Section.userHideable`, because it's overloaded as **Home + the no-project
Welcome screen**, and three things hardwire it:

1. `ShellState.section` defaults to `.explorer`; the Home toolbar button hardcodes
   `shell.section = .explorer` (`AppShell.swift:417`).
2. With no project open, every non-Settings section is forced to `.explorer`
   (`AppShell.swift:91-95`) — `ExplorerView` hosts the Welcome/Recent-Projects UI.
3. `PanelSectionTabs` hardcodes `[.explorer, .sourceControl, .search]` and never
   checks `hiddenSidebarSections`, so hiding Explorer has no visible effect (the
   `redirectIfSectionHidden()` bump to Library is the only thing that fires).

## Design (Option A + (a))

Decouple "Home" from "Explorer": Home becomes "go to my chosen landing," and
Explorer becomes a normally-hideable section. The no-project Welcome screen
stays put — "hide Explorer" only takes effect once a project is open.

### 1. Configurable Home — `AppConfig`

New persisted `homeSection: String` (a `ShellState.Section` rawValue), default
`"explorer"`, mirroring the `hiddenSidebarSections` pattern (`@Published` + didSet
save + init read). On read, sanitize: fall back to `"explorer"` if the persisted
value isn't a valid Section rawValue.

### 2. Pure resolver — `ShellState.Section.resolveHome(_:hidden:)`

```
static func resolveHome(_ rawValue: String, hidden: Set<String>) -> Section
```
Returns the chosen section if it's a real case and not hidden; otherwise
`.library` (always-visible fallback — Library isn't in `userHideable`). Pure and
unit-testable; the view layer just calls it.

### 3. `AppShell.effectiveHome()` + Home button

```
private func effectiveHome() -> Section {
    if projectStore.activeProject == nil { return .explorer }   // (a): Welcome
    return .resolveHome(config.homeSection, hidden: config.hiddenSidebarSections)
}
```
The Home toolbar button calls `shell.section = effectiveHome()` instead of the
hardcoded `.explorer`. So: no project → Explorer (Welcome); with a project → the
configured landing, falling back to Library if that landing is hidden.

### 4. `PanelSectionTabs` respects the hide list

Add `@EnvironmentObject config` and filter `Self.tabs` by
`!config.hiddenSidebarSections.contains($0.rawValue)`, so hiding Explorer (or
Source Control / Search) removes it from the panel switcher too.

### 5. Settings UI — `SidebarVisibilitySection`

Add a "Home opens" `Picker` (bound to `config.homeSection`) offering every
`Section` except `.settings`/`.live`. Sits below the existing show/hide toggles.

### 6. No-project guard — unchanged

`AppShell.swift:91-95` keeps forcing `.explorer` with no project, so the Welcome
screen is unaffected. (If Explorer is hidden and there's no project, the
switcher simply won't highlight a tab — transient, accepted per (a).)

## Testing

New `ShellStateHomeTests` covering the pure resolver:
- default `"explorer"`, nothing hidden → `.explorer`
- `"explorer"` hidden → `.library`
- `"gantt"`, nothing hidden → `.gantt`; `"gantt"` hidden → `.library`
- invalid raw value → `.library`
- `"library"` → `.library` (Library can't be hidden)

`AppConfig.homeSection` persistence is covered by the existing AppConfig-defaults
style (sanitize-on-read). `swift build` clean, `swift test` green.

## Out of scope

- Extracting the Welcome screen into its own surface (Option C) — not needed for (a).
- A per-section "home" rather than a single global Home landing.
- Mobile: this is Mac-shell only.
