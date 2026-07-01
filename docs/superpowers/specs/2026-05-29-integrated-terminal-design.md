# Integrated Terminal Panel — Design Spec

**Date:** 2026-05-29  
**Status:** Approved

---

## Goal

Add a Cursor-style integrated terminal panel to the LLM IDE Mac app: a resizable bottom panel with a real PTY-backed shell, multiple tabs, and a `Ctrl+\`` keyboard shortcut to toggle it.

## Architecture

Four new Swift files in `mac/Sources/LlmIdeMac/Views/Terminal/`:

### `TerminalSession.swift`
`@Observable` class owning one PTY session.

- Wraps SwiftTerm's `LocalProcess`
- Properties: `id: UUID`, `title: String`, `workingDirectory: URL`, `status: SessionStatus` (`.running` | `.dead`)
- `func start(in directory: URL)` — forks the PTY, launches `/bin/zsh` (fallback `/bin/bash`)
- `func terminate()` — sends `SIGHUP` to the shell process
- `processTerminated` callback from SwiftTerm sets `status = .dead` and updates title to `"[exited]"`

### `TerminalPanelState.swift`
`@Observable` class managing panel-level state. Injected as `@Environment` at `AppShell`.

- `isOpen: Bool` — panel visible or not
- `panelHeight: CGFloat` — persisted in `UserDefaults` key `"terminalPanelHeight"`, default `260`, clamped `[120, windowHeight × 0.6]`
- `sessions: [TerminalSession]` — all open tabs
- `activeIndex: Int` — which tab is shown
- `func toggle()` — flips `isOpen`; creates first session if `sessions` is empty
- `func addTab(in directory: URL)` — appends new session, sets it active
- `func closeTab(at index: Int)` — terminates session, removes from array; if last tab, sets `isOpen = false`

### `TerminalTabBar.swift`
SwiftUI view.

- Left: horizontal `ScrollView` of tab pills — each shows title + `×` close button
- Active tab pill: accent-colored underline
- Right: `+` button calls `state.addTab(in: projectDirectory)`
- `×` on last remaining tab closes the panel (`state.isOpen = false`)

### `TerminalPanelView.swift`
SwiftUI outer panel container.

- **Resize handle:** 4pt `Rectangle` at the top, `.cursor(.resizeUpDown)` on hover. `DragGesture` updates `state.panelHeight` live, clamped to bounds.
- **Tab bar:** `TerminalTabBar` below the handle
- **Terminal area:** `TerminalSessionView` for `sessions[activeIndex]` — switches instantly on tab change (SwiftTerm views are kept alive off-screen to preserve scrollback)
- Background: `Color.black` — matches Cursor's terminal aesthetic regardless of app theme

### `TerminalSessionView.swift`
`NSViewRepresentable` bridging SwiftTerm's `LocalProcessTerminalView` into SwiftUI.

- `makeNSView`: creates `LocalProcessTerminalView`, calls `session.start(in:)` on first appear
- `updateNSView`: no-op (SwiftTerm manages its own render loop)
- Error banner: if `session.status == .dead` on first appear (spawn failed), shows a red inline label with the error message

---

## SwiftTerm Dependency

Add to `mac/Package.swift` (or `LlmIdeMac.xcodeproj`):

```swift
.package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0")
```

Target dependency: `SwiftTerm`

---

## Integration in AppShell

### Layout change
`AppShell.body` `VStack` becomes:
```
existingShellContent        (unchanged)
TerminalPanelView           (new — zero height when isOpen = false)
StatusBar                   (unchanged)
```

`TerminalPanelState` created as `@State` in `AppShell`, passed via `.environment(terminalState)`.

### Keyboard shortcut
In `AppShell.onAppear`:
```swift
NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
    if event.keyCode == 50 && event.modifierFlags.contains(.control) {
        terminalState.toggle()
        return nil // consume event
    }
    return event
}
```
KeyCode 50 = `` ` `` on US keyboard layout.

### StatusBar toggle button
Add a `>_` icon button on the right side of `StatusBar` that calls `terminalState.toggle()`. Provides visual affordance for users who don't know the shortcut.

### Working directory
```swift
let dir = projectStore.activeProject?.localPath
    .flatMap { URL(string: $0) }
    ?? FileManager.default.homeDirectoryForCurrentUser
```

---

## UI Specification

| Property | Value |
|---|---|
| Default height | 260 pt |
| Minimum height | 120 pt |
| Maximum height | 60% of window height |
| Handle height | 4 pt |
| Tab font | `.monospacedSystemFont(ofSize: 12)` |
| Terminal font | Menlo 13pt (SwiftTerm default) |
| Background | `Color.black` |
| Toggle shortcut | `Ctrl+\`` (keyCode 50 + `.control`) |
| UserDefaults key | `"terminalPanelHeight"` |

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `/bin/zsh` and `/bin/bash` not found | Red inline label: *"Shell not found. Check /bin/zsh or /bin/bash."* |
| `LocalProcess.startProcess()` throws | Red inline banner inside terminal area; tab stays open |
| Shell exits cleanly (`exit` command) | Tab title → `"[exited]"` in grey; scrollback preserved |
| Shell crashes unexpectedly | Same as clean exit via `processTerminated` callback |
| Drag handle outside bounds | Height clamped to `[120, windowHeight × 0.6]`; no error |
| Project directory doesn't exist | Falls back to `~` silently |

---

## Out of Scope

- Shell selection UI (always uses zsh → bash fallback)
- Environment variable customisation
- Terminal profiles / colour themes
- Split panes within a tab
- Search in scrollback
- Copy-paste beyond system defaults (SwiftTerm handles this natively)
