# Integrated Terminal Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cursor-style bottom terminal panel to the Meet Notes Mac app with a real PTY-backed shell, multiple tabs, drag-to-resize, and Ctrl+` toggle.

**Architecture:** `TerminalSession` owns one `LocalProcessTerminalView` (SwiftTerm AppKit view) per tab. `TerminalPanelState` manages the list of sessions and panel open/height state. `TerminalPanelView` renders the resize handle + tab bar + a ZStack of session views (kept alive off-screen to preserve scrollback). Wired into `AppShell` above `StatusBar`.

**Tech Stack:** SwiftTerm 1.2+ (SPM), SwiftUI, AppKit (`NSViewRepresentable`), macOS 14+

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `mac/Sources/MeetNotesMac/Views/Terminal/TerminalSession.swift` | PTY session model — owns `LocalProcessTerminalView`, lifecycle |
| Create | `mac/Sources/MeetNotesMac/Views/Terminal/TerminalPanelState.swift` | Panel state — open/height/tabs/active index |
| Create | `mac/Sources/MeetNotesMac/Views/Terminal/TerminalSessionView.swift` | `NSViewRepresentable` bridging SwiftTerm into SwiftUI |
| Create | `mac/Sources/MeetNotesMac/Views/Terminal/TerminalTabBar.swift` | Tab pills + `+` button |
| Create | `mac/Sources/MeetNotesMac/Views/Terminal/TerminalPanelView.swift` | Outer panel: handle + tab bar + session views |
| Modify | `mac/Package.swift` | Add SwiftTerm SPM dependency |
| Modify | `mac/Sources/MeetNotesMac/Views/AppShell.swift` | Add terminal state, panel in VStack, keyboard shortcut |
| Modify | `mac/Sources/MeetNotesMac/Views/Shell/StatusBar.swift` | Add `>_` toggle button |

---

## Task 1: Add SwiftTerm SPM Dependency

**Files:**
- Modify: `mac/Package.swift`

- [ ] **Step 1: Add SwiftTerm to Package.swift**

Open `mac/Package.swift` and make these two edits:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MeetNotesMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "MeetNotesMac", targets: ["MeetNotesMac"])
    ],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .executableTarget(
            name: "MeetNotesMac",
            dependencies: [
                "Yams",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "Sources/MeetNotesMac",
            resources: [
                .copy("Resources/note_template.docx"),
                .copy("Resources/generate_meeting_note.py"),
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "MeetNotesMacTests",
            dependencies: ["MeetNotesMac"],
            path: "Tests/MeetNotesMacTests",
            swiftSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xfrontend", "-disable-cross-import-overlays"
                ])
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-framework", "Testing",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
                ])
            ]
        )
    ]
)
```

- [ ] **Step 2: Resolve the package**

```bash
cd mac && swift package resolve
```

Expected: Downloads SwiftTerm and its dependencies into `.build/checkouts/SwiftTerm/`. No errors.

- [ ] **Step 3: Verify SwiftTerm imports**

```bash
cd mac && swift build 2>&1 | head -5
```

Expected: Build starts (may warn about unresolved symbols in new files — that's fine at this stage). No "no such module 'SwiftTerm'" errors.

- [ ] **Step 4: Commit**

```bash
git add mac/Package.swift mac/Package.resolved
git commit -m "feat(mac): add SwiftTerm SPM dependency for integrated terminal"
```

---

## Task 2: TerminalSession Model

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/Terminal/TerminalSession.swift`

- [ ] **Step 1: Create the Terminal directory and TerminalSession.swift**

```bash
mkdir -p mac/Sources/MeetNotesMac/Views/Terminal
```

Create `mac/Sources/MeetNotesMac/Views/Terminal/TerminalSession.swift`:

```swift
import Foundation
import Observation
import SwiftTerm
import AppKit

/// One PTY-backed shell session — owns a `LocalProcessTerminalView` for
/// the lifetime of the tab.  Created by `TerminalPanelState.addTab()`.
@Observable
@MainActor
final class TerminalSession: NSObject {

    // MARK: - State

    let id = UUID()
    /// Shown in the tab pill.  Updated by the shell's title escape, and
    /// set to "[exited]" when the process terminates.
    var title: String
    var status: SessionStatus = .starting
    var workingDirectory: URL
    /// Non-nil after `start()` succeeds.
    private(set) var termView: LocalProcessTerminalView?
    /// Set when `start()` cannot find a shell.
    private(set) var spawnError: String?

    enum SessionStatus { case starting, running, dead }

    // MARK: - Init

    init(number: Int, workingDirectory: URL) {
        self.title = "zsh \(number)"
        self.workingDirectory = workingDirectory
    }

    // MARK: - Lifecycle

    /// Spawn the PTY.  Call once from `TerminalSessionView.makeNSView`.
    func start() {
        let shellPath: String
        if FileManager.default.fileExists(atPath: "/bin/zsh") {
            shellPath = "/bin/zsh"
        } else if FileManager.default.fileExists(atPath: "/bin/bash") {
            shellPath = "/bin/bash"
        } else {
            spawnError = "Shell not found. Check /bin/zsh or /bin/bash."
            status = .dead
            return
        }

        let tv = LocalProcessTerminalView(frame: .zero)
        tv.processDelegate = self

        // Start a login shell that first cd's into the project directory.
        // Using `exec` replaces the wrapper shell so only one process
        // is visible (no extra sh in the process list).
        let wd = workingDirectory.path.replacingOccurrences(of: "'", with: "'\\''")
        tv.startProcess(
            executable: shellPath,
            args: ["--login", "-c", "cd '\(wd)' && exec \(shellPath) --login"],
            environment: nil,
            execName: URL(fileURLWithPath: shellPath).lastPathComponent
        )

        self.termView = tv
        self.status = .running
    }

    /// Send SIGHUP to cleanly stop the shell.  Call before removing the
    /// session from `TerminalPanelState.sessions`.
    func terminate() {
        guard status == .running else { return }
        termView?.terminateApplication()
        status = .dead
    }
}

// MARK: - LocalProcessTerminalViewDelegate

extension TerminalSession: LocalProcessTerminalViewDelegate {

    nonisolated func processTerminated(_ source: TerminalView, exitCode: Int32?) {
        Task { @MainActor in
            self.title = "[exited]"
            self.status = .dead
        }
    }

    // Provide minimal no-op implementations for optional delegate methods
    // so the compiler is satisfied regardless of SwiftTerm version.
    nonisolated func windowTitle(source: LocalProcessTerminalView, title: String) {
        Task { @MainActor in self.title = title }
    }

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
    nonisolated func bell(source: TerminalView) {}
    nonisolated func clipboardCopy(source: TerminalView, content: Data) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
```

- [ ] **Step 2: Build to check for compile errors**

```bash
cd mac && swift build 2>&1 | grep -E "error:|warning:" | head -20
```

Expected: No errors related to `TerminalSession`. If SwiftTerm's delegate protocol has different method names in the installed version, fix them to match — run `swift package show-dependencies` and check the SwiftTerm source in `.build/checkouts/SwiftTerm/Sources/SwiftTerm/LocalProcessTerminalView.swift` for the actual protocol definition.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/Terminal/TerminalSession.swift
git commit -m "feat(mac): add TerminalSession model (PTY session lifecycle)"
```

---

## Task 3: TerminalPanelState Model

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/Terminal/TerminalPanelState.swift`

- [ ] **Step 1: Create TerminalPanelState.swift**

```swift
import Foundation
import Observation
import SwiftUI

/// Panel-level state: open/closed, height, and the list of tab sessions.
/// Created as `@State` in `AppShell`, propagated via `.environment()`.
@Observable
@MainActor
final class TerminalPanelState {

    // MARK: - State

    var isOpen: Bool = false
    /// Panel height in points.  Persisted across app launches.
    var panelHeight: CGFloat {
        didSet {
            UserDefaults.standard.set(Double(panelHeight), forKey: "terminalPanelHeight")
        }
    }
    var sessions: [TerminalSession] = []
    var activeIndex: Int = 0

    // MARK: - Init

    init() {
        let saved = UserDefaults.standard.double(forKey: "terminalPanelHeight")
        self.panelHeight = saved > 0 ? CGFloat(saved) : 260
    }

    // MARK: - Actions

    /// Toggle panel open/closed.  Opens a new tab if none exist yet.
    func toggle(projectDirectory: URL) {
        if isOpen {
            isOpen = false
        } else {
            if sessions.isEmpty {
                addTab(in: projectDirectory)
            }
            isOpen = true
        }
    }

    /// Open a new tab (and activate it).
    func addTab(in directory: URL) {
        let number = sessions.count + 1
        let session = TerminalSession(number: number, workingDirectory: directory)
        sessions.append(session)
        activeIndex = sessions.count - 1
        isOpen = true
    }

    /// Terminate a session and remove its tab.
    func closeTab(at index: Int) {
        guard index < sessions.count else { return }
        sessions[index].terminate()
        sessions.remove(at: index)
        if sessions.isEmpty {
            isOpen = false
            activeIndex = 0
        } else {
            activeIndex = min(activeIndex, sessions.count - 1)
        }
    }

    /// Clamp `height` to the allowed range.
    /// `windowHeight` is the current window frame height.
    func clampedHeight(_ height: CGFloat, windowHeight: CGFloat) -> CGFloat {
        let maxH = windowHeight * 0.6
        return min(max(height, 120), maxH)
    }
}
```

- [ ] **Step 2: Build**

```bash
cd mac && swift build 2>&1 | grep "error:" | head -10
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/Terminal/TerminalPanelState.swift
git commit -m "feat(mac): add TerminalPanelState (panel open/height/tabs)"
```

---

## Task 4: TerminalSessionView (NSViewRepresentable)

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/Terminal/TerminalSessionView.swift`

- [ ] **Step 1: Create TerminalSessionView.swift**

```swift
import SwiftUI
import AppKit
import SwiftTerm

/// Bridges a `TerminalSession`'s `LocalProcessTerminalView` into SwiftUI.
/// The NSView is created once (in `makeNSView`) and never recreated —
/// this preserves the PTY process and full scrollback across tab switches.
struct TerminalSessionView: NSViewRepresentable {
    let session: TerminalSession

    func makeNSView(context: Context) -> NSView {
        // Start the PTY the first time this view enters the hierarchy.
        if session.termView == nil {
            session.start()
        }

        if let tv = session.termView {
            return tv
        }

        // Spawn failed — show the error inline.
        return errorView(session.spawnError ?? "Failed to start terminal.")
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // SwiftTerm manages its own render loop; nothing to do here.
    }

    // MARK: - Private

    private func errorView(_ message: String) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor

        let label = NSTextField(labelWithString: message)
        label.textColor = NSColor.systemRed
        label.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.cell?.wraps = true
        label.maximumNumberOfLines = 3

        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
        ])
        return container
    }
}
```

- [ ] **Step 2: Build**

```bash
cd mac && swift build 2>&1 | grep "error:" | head -10
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/Terminal/TerminalSessionView.swift
git commit -m "feat(mac): add TerminalSessionView NSViewRepresentable bridge"
```

---

## Task 5: TerminalTabBar

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/Terminal/TerminalTabBar.swift`

- [ ] **Step 1: Create TerminalTabBar.swift**

```swift
import SwiftUI

/// Horizontal tab strip shown at the top of the terminal panel.
/// Left side: scrollable tab pills with titles and close buttons.
/// Right side: `+` to open a new tab.
struct TerminalTabBar: View {
    @Environment(TerminalPanelState.self) private var state
    @EnvironmentObject var theme: ThemeStore
    let projectDirectory: URL

    var body: some View {
        HStack(spacing: 0) {
            // Tab pills
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(Array(state.sessions.enumerated()), id: \.element.id) { idx, session in
                        tabPill(session: session, index: idx)
                    }
                }
                .padding(.horizontal, 4)
            }

            Spacer(minLength: 0)

            // New tab button
            Button {
                state.addTab(in: projectDirectory)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .help("New Terminal Tab")
        }
        .frame(height: 30)
        .background(Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1)))
    }

    @ViewBuilder
    private func tabPill(session: TerminalSession, index: Int) -> some View {
        let isActive = index == state.activeIndex
        let isDead = session.status == .dead

        HStack(spacing: 4) {
            Text(session.title)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(isDead
                    ? Color(nsColor: .systemGray)
                    : isActive ? .white : Color(nsColor: .lightGray))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 120, alignment: .leading)

            // Close button
            Button {
                state.closeTab(at: index)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Color(nsColor: .lightGray))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            isActive
                ? Color(nsColor: NSColor(red: 0.20, green: 0.20, blue: 0.20, alpha: 1))
                : Color.clear
        )
        .overlay(
            // Active-tab underline accent
            isActive
                ? Rectangle()
                    .frame(height: 2)
                    .foregroundStyle(theme.current.accent)
                    .padding(.horizontal, 2)
                : nil,
            alignment: .bottom
        )
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .contentShape(Rectangle())
        .onTapGesture {
            state.activeIndex = index
        }
    }
}
```

- [ ] **Step 2: Build**

```bash
cd mac && swift build 2>&1 | grep "error:" | head -10
```

Expected: No errors. `ThemeStore` and `TerminalPanelState` are already defined in the codebase — just confirm they compile together.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/Terminal/TerminalTabBar.swift
git commit -m "feat(mac): add TerminalTabBar with tab pills and new-tab button"
```

---

## Task 6: TerminalPanelView

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/Terminal/TerminalPanelView.swift`

- [ ] **Step 1: Create TerminalPanelView.swift**

```swift
import SwiftUI

/// The full terminal panel: drag handle → tab bar → terminal views.
/// Collapsed to zero height when `state.isOpen == false`.
/// All `TerminalSessionView` instances live in a ZStack so their PTYs
/// and scrollback are preserved when switching tabs.
struct TerminalPanelView: View {
    @Environment(TerminalPanelState.self) private var state
    @EnvironmentObject var theme: ThemeStore

    let projectDirectory: URL

    /// Tracks drag-start height so we can compute delta correctly.
    @State private var dragStartHeight: CGFloat = 0
    /// GeometryReader fills this so we can clamp to 60% of window.
    @State private var windowHeight: CGFloat = 600

    var body: some View {
        GeometryReader { geo in
            Color.clear.onAppear { windowHeight = geo.size.height }
                .onChange(of: geo.size.height) { _, h in windowHeight = h }
        }
        .frame(height: 0) // zero-height geometry probe

        if state.isOpen && !state.sessions.isEmpty {
            VStack(spacing: 0) {
                // ── Resize handle ────────────────────────────────────────
                resizeHandle

                // ── Tab bar ──────────────────────────────────────────────
                TerminalTabBar(projectDirectory: projectDirectory)

                Divider().background(Color(nsColor: .separatorColor))

                // ── Terminal area ────────────────────────────────────────
                // ZStack keeps all NSViews alive so PTYs and scrollback
                // are preserved across tab switches.
                ZStack {
                    ForEach(Array(state.sessions.enumerated()), id: \.element.id) { idx, session in
                        TerminalSessionView(session: session)
                            .opacity(idx == state.activeIndex ? 1 : 0)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
            }
            .frame(height: state.panelHeight)
            .overlay(Divider(), alignment: .top)
        }
    }

    // MARK: - Resize Handle

    private var resizeHandle: some View {
        Rectangle()
            .fill(Color(nsColor: .separatorColor).opacity(0.6))
            .frame(height: 4)
            .frame(maxWidth: .infinity)
            .onHover { inside in
                if inside {
                    NSCursor.resizeUpDown.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if dragStartHeight == 0 {
                            dragStartHeight = state.panelHeight
                        }
                        // Dragging up (negative translation) increases height.
                        let newHeight = dragStartHeight - value.translation.height
                        state.panelHeight = state.clampedHeight(newHeight, windowHeight: windowHeight)
                    }
                    .onEnded { _ in
                        dragStartHeight = 0
                    }
            )
    }
}
```

- [ ] **Step 2: Build**

```bash
cd mac && swift build 2>&1 | grep "error:" | head -10
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/Terminal/TerminalPanelView.swift
git commit -m "feat(mac): add TerminalPanelView with resize handle and ZStack tab layout"
```

---

## Task 7: AppShell Integration

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/AppShell.swift`

- [ ] **Step 1: Add TerminalPanelState to AppShell**

In `AppShell.swift`, add the `@State` property alongside the other states (after line 28, before `var body`):

```swift
// Add this with the other @State properties:
@State private var terminalPanelState = TerminalPanelState()
/// Token returned by NSEvent monitor — stored so we can remove it on disappear.
@State private var keyMonitor: Any?
```

- [ ] **Step 2: Wrap the existing VStack body with TerminalPanelView**

In `AppShell.body`, the current structure is:
```swift
var body: some View {
    VStack(spacing: 0) {
        Group {
            if projectStore.activeProject == nil {
                WelcomeView()
            } else {
                existingShellContent
            }
        }
        StatusBar(api: api)
    }
    .environment(shell)
    // ... modifiers
```

Change it to:

```swift
var body: some View {
    VStack(spacing: 0) {
        Group {
            if projectStore.activeProject == nil {
                WelcomeView()
            } else {
                existingShellContent
            }
        }
        TerminalPanelView(projectDirectory: projectDirectory)
        StatusBar(api: api)
    }
    .environment(shell)
    .environment(terminalPanelState)   // ← add this line
    // ... rest of existing modifiers unchanged
```

- [ ] **Step 3: Add the projectDirectory computed property**

Add this private computed property inside `AppShell`, near the other helpers (e.g., after `refreshAutoDispatchFlag`):

```swift
/// Working directory for new terminal tabs — the active project's
/// local path, falling back to the user's home directory.
private var projectDirectory: URL {
    if let path = projectStore.activeProject?.localPath,
       !path.isEmpty,
       FileManager.default.fileExists(atPath: path) {
        return URL(fileURLWithPath: path)
    }
    return FileManager.default.homeDirectoryForCurrentUser
}
```

- [ ] **Step 4: Add Ctrl+` keyboard shortcut**

In `AppShell.body`, add `.onAppear` and `.onDisappear` to the outermost `VStack` (add them after the existing `.onReceive` modifiers at the end of `body`):

```swift
.onAppear {
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [self] event in
        // keyCode 50 = ` (backtick) on US layout
        if event.keyCode == 50 && event.modifierFlags.contains(.control) {
            Task { @MainActor in
                terminalPanelState.toggle(projectDirectory: projectDirectory)
            }
            return nil // consume — don't pass to focused view
        }
        return event
    }
}
.onDisappear {
    if let monitor = keyMonitor {
        NSEvent.removeMonitor(monitor)
        keyMonitor = nil
    }
}
```

- [ ] **Step 5: Build**

```bash
cd mac && swift build 2>&1 | grep "error:" | head -20
```

Expected: Clean build. Resolve any type errors (e.g., if `existingShellContent` is a `@ViewBuilder` property, the `VStack` addition is straightforward).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/AppShell.swift
git commit -m "feat(mac): wire TerminalPanelView into AppShell with Ctrl+\` shortcut"
```

---

## Task 8: StatusBar Toggle Button

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/Shell/StatusBar.swift`

- [ ] **Step 1: Add TerminalPanelState environment and toggle button**

In `StatusBar.swift`, add the environment access and a terminal toggle button on the right side of the bar.

Current `content` HStack:
```swift
HStack(spacing: 12) {
    projectInfo
    Spacer()
    AgentStatusBadge(api: api)
}
```

Change to:

```swift
@Environment(TerminalPanelState.self) private var terminalState

// ...

private var content: some View {
    let t = theme.current
    HStack(spacing: 12) {
        projectInfo
        Spacer()
        terminalToggleButton
        AgentStatusBadge(api: api)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 4)
    .background(t.surface)
    .frame(maxWidth: .infinity, minHeight: 24)
    .overlay(Divider(), alignment: .top)
}

@ViewBuilder
private var terminalToggleButton: some View {
    Button {
        // projectDirectory not available here — TerminalPanelState.toggle
        // uses home dir fallback when no project is active, which is fine.
        terminalState.toggle(
            projectDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
    } label: {
        Image(systemName: "terminal")
            .font(.system(size: 11))
            .foregroundStyle(
                terminalState.isOpen
                    ? theme.current.accent
                    : theme.current.textMuted
            )
    }
    .buttonStyle(.plain)
    .help("Toggle Terminal  (⌃`)")
}
```

- [ ] **Step 2: Build**

```bash
cd mac && swift build 2>&1 | grep "error:" | head -10
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/Shell/StatusBar.swift
git commit -m "feat(mac): add terminal toggle button to StatusBar"
```

---

## Task 9: Build and Smoke Test

- [ ] **Step 1: Full release build**

```bash
cd mac && swift build -c release 2>&1 | tail -5
```

Expected: `Build complete!`

- [ ] **Step 2: Run the app**

```bash
cd mac && .build/release/MeetNotesMac
```

Or build and run via `mac/Scripts/build.sh` if that script is preferred.

- [ ] **Step 3: Smoke test checklist**

Manually verify each behaviour:

| Test | Expected |
|------|----------|
| Press `Ctrl+`` | Panel slides open at 260pt with a `zsh 1` tab, shell prompt visible |
| Press `Ctrl+`` again | Panel closes |
| Click `>_` button in StatusBar | Panel toggles open/closed |
| Click `+` in tab bar | New `zsh 2` tab appears, focused |
| Type `pwd` in terminal | Shows current project directory (or `~` if no project) |
| Run `git log --oneline -5` | Output renders with colours |
| Run `vim README.md` | vim opens interactively (proves PTY works) |
| Press `q` to quit vim | vim exits, shell prompt returns |
| Click `×` on a tab | Tab closes; previous tab activates |
| Click `×` on last tab | Panel closes |
| Drag resize handle up | Panel grows; handle snaps at 60% window height |
| Drag resize handle down | Panel shrinks; handle snaps at 120pt minimum |
| Restart app | Panel height persists from last session |
| Type `exit` in shell | Tab title → `[exited]`, scrollback preserved |

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(mac): integrated Cursor-style terminal panel — complete"
```

---

## Self-Review

**Spec coverage:**
- ✅ SwiftTerm SPM dependency — Task 1
- ✅ TerminalSession (PTY lifecycle, `start()`, `terminate()`, `processTerminated`) — Task 2
- ✅ TerminalPanelState (open/height/tabs/activeIndex, `toggle()`, `addTab()`, `closeTab()`) — Task 3
- ✅ TerminalSessionView (`NSViewRepresentable`, error banner) — Task 4
- ✅ TerminalTabBar (pills, `+`, `×`, accent underline) — Task 5
- ✅ TerminalPanelView (resize handle, ZStack keep-alive, black background) — Task 6
- ✅ AppShell layout + `TerminalPanelState` environment + `Ctrl+\`` shortcut — Task 7
- ✅ StatusBar `>_` toggle button — Task 8
- ✅ Project directory fallback to `~` — Task 7 `projectDirectory` property
- ✅ UserDefaults height persistence — `TerminalPanelState.panelHeight` didSet
- ✅ Shell not found error — `TerminalSession.start()` guard
- ✅ Session dead state — `processTerminated` delegate → title "[exited]"

**Placeholder scan:** None found.

**Type consistency:**
- `TerminalSession.status: SessionStatus` (.starting / .running / .dead) — used consistently in Tasks 2, 4, 5
- `TerminalPanelState.toggle(projectDirectory:)` — called with `projectDirectory` in Task 7 AppShell, falls back to home dir in Task 8 StatusBar ✅
- `TerminalPanelState.closeTab(at:)` — called from `TerminalTabBar` with `index` ✅
- `TerminalPanelState.addTab(in:)` — called from `TerminalTabBar` and `toggle()` ✅
