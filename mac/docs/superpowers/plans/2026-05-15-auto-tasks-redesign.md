# Auto Tasks Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename "Auto Code" to "Auto Tasks" everywhere, add per-task-type editable CLI prompt templates to `AppConfig`, update `AutoCodeUpdateService` to invoke the CLI with those templates, and rewrite `AutoCodeView` as a two-pane layout (task list + template editor).

**Architecture:** Three new `@Published` template strings in `AppConfig` (persisted to `UserDefaults`). `AutoCodeUpdateService.run()` gains a second `runCLI` overload that accepts a raw prompt string and a log suffix, called once per enabled task type after the existing issue flow. `AutoCodeView` becomes a two-pane split: left pane owns task rows + run history + Run Now; right pane owns the `TextEditor` for the selected task's template.

**Tech Stack:** SwiftUI, `Foundation.UserDefaults`, `@Published`/`ObservableObject`, `Foundation.Process`

---

## File Map

| File | Change |
|---|---|
| `Sources/MeetNotesMac/Models/Config.swift` | Add 3 template `@Published` String properties + init loading |
| `Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift` | Add `runCLI(prompt:localPath:logSuffix:logDir:)` overload; call it for each enabled task type at end of `run()` |
| `Sources/MeetNotesMac/Views/AutoCode/AutoCodeView.swift` | Full rewrite: two-pane HSplitView |
| `Sources/MeetNotesMac/Views/Shell/SidebarView.swift` | Rename label "Auto Code" → "Auto Tasks" |
| `Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift` | Rename card title "Auto Code Update" → "Auto Tasks" |

---

## Task 1: Add template properties to AppConfig

**Files:**
- Modify: `Sources/MeetNotesMac/Models/Config.swift`
- Test: `Tests/MeetNotesMacTests/AppConfigAutoTaskTemplatesTests.swift`

- [ ] **Step 1: Write failing tests**

Create `Tests/MeetNotesMacTests/AppConfigAutoTaskTemplatesTests.swift`:

```swift
import Testing
@testable import MeetNotesMac

@Suite("AppConfig Auto Task Templates")
struct AppConfigAutoTaskTemplatesTests {

    @Test func reviewCodeTemplateDefaultIsNonEmpty() {
        UserDefaults.standard.removeObject(forKey: "autoTaskTemplateReviewCode")
        #expect(!AppConfig.shared.autoTaskTemplateReviewCode.isEmpty)
    }

    @Test func reviewDocTemplateDefaultIsNonEmpty() {
        UserDefaults.standard.removeObject(forKey: "autoTaskTemplateReviewDoc")
        #expect(!AppConfig.shared.autoTaskTemplateReviewDoc.isEmpty)
    }

    @Test func reviewConflictsTemplateDefaultIsNonEmpty() {
        UserDefaults.standard.removeObject(forKey: "autoTaskTemplateReviewConflicts")
        #expect(!AppConfig.shared.autoTaskTemplateReviewConflicts.isEmpty)
    }
}
```

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test --filter AppConfigAutoTaskTemplatesTests 2>&1 | tail -10`
Expected: compile error — properties don't exist yet.

- [ ] **Step 2: Add the three properties to Config.swift**

Find the block ending with:
```swift
    @Published var autoCodeRunReviewConflicts: Bool {
        didSet { defaults.set(autoCodeRunReviewConflicts, forKey: "autoCodeRunReviewConflicts") }
    }
```

Add immediately after it:

```swift
    // Default prompt templates for each auto task type.
    static let defaultTemplateReviewCode = "Review the recent commits in this repository. Check for bugs, security issues, and code style problems. Write a summary to REVIEW.md."
    static let defaultTemplateReviewDoc = "Review the documentation in this repository. Update any docs that are out of date with recent code changes. Fix unclear or incomplete sections."
    static let defaultTemplateReviewConflicts = "Check for and resolve any merge conflicts in this repository. Create a branch named fix/conflicts, resolve all conflicts, commit, and push."

    @Published var autoTaskTemplateReviewCode: String {
        didSet { defaults.set(autoTaskTemplateReviewCode, forKey: "autoTaskTemplateReviewCode") }
    }
    @Published var autoTaskTemplateReviewDoc: String {
        didSet { defaults.set(autoTaskTemplateReviewDoc, forKey: "autoTaskTemplateReviewDoc") }
    }
    @Published var autoTaskTemplateReviewConflicts: String {
        didSet { defaults.set(autoTaskTemplateReviewConflicts, forKey: "autoTaskTemplateReviewConflicts") }
    }
```

- [ ] **Step 3: Load from UserDefaults in init**

Find the lines:
```swift
        self.autoCodeRunReviewConflicts = defaults.object(forKey: "autoCodeRunReviewConflicts") as? Bool ?? false
```

Add immediately after:
```swift
        self.autoTaskTemplateReviewCode = defaults.string(forKey: "autoTaskTemplateReviewCode") ?? Self.defaultTemplateReviewCode
        self.autoTaskTemplateReviewDoc = defaults.string(forKey: "autoTaskTemplateReviewDoc") ?? Self.defaultTemplateReviewDoc
        self.autoTaskTemplateReviewConflicts = defaults.string(forKey: "autoTaskTemplateReviewConflicts") ?? Self.defaultTemplateReviewConflicts
```

- [ ] **Step 4: Build**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | tail -5
```
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac
git add Sources/MeetNotesMac/Models/Config.swift Tests/MeetNotesMacTests/AppConfigAutoTaskTemplatesTests.swift
git commit -m "feat: add autoTaskTemplate properties to AppConfig"
```

---

## Task 2: Add prompt-based runCLI overload to AutoCodeUpdateService

**Files:**
- Modify: `Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift`

The current `runCLI(issue:localPath:logDir:)` builds a prompt from a `GitLabIssue`. Add a second overload that accepts a raw prompt string and a log file suffix, sharing the same subprocess-launch logic.

- [ ] **Step 1: Add the overload**

In `Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift`, after the closing `}` of the existing `runCLI(issue:localPath:logDir:)` method, add:

```swift
    private func runCLI(prompt: String, localPath: String, logSuffix: String, logDir: URL) async -> Bool {
        let cliTool = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
        let cliCommand = cliTool.cliExecutable
        let components = cliCommand.split(separator: " ").map(String.init)
        guard let executable = components.first else { return false }

        let logURL = logDir.appendingPathComponent("auto-task-\(logSuffix).log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)

        let process = Process()
        if executable.hasPrefix("/") {
            process.executableURL = URL(fileURLWithPath: executable)
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        }

        var args: [String] = []
        if process.executableURL?.path == "/usr/bin/env" {
            args.append(executable)
        }
        args += components.dropFirst()
        args += ["-p", prompt]

        process.arguments = args
        process.currentDirectoryURL = URL(fileURLWithPath: localPath)

        var logFileHandle: FileHandle? = nil
        if let fh = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = fh
            process.standardError = fh
            logFileHandle = fh
        }

        let timeout: TimeInterval = 600
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let resumed = OSAllocatedUnfairLock(initialState: false)

            process.terminationHandler = { p in
                let alreadyResumed = resumed.withLock { state -> Bool in
                    if state { return true }
                    state = true
                    return false
                }
                guard !alreadyResumed else { return }
                continuation.resume(returning: p.terminationStatus == 0)
            }

            do {
                try process.run()
            } catch {
                let alreadyResumed = resumed.withLock { state -> Bool in
                    if state { return true }
                    state = true
                    return false
                }
                if !alreadyResumed {
                    continuation.resume(returning: false)
                }
                return
            }

            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                let alreadyResumed = resumed.withLock { state -> Bool in
                    if state { return true }
                    state = true
                    return false
                }
                guard !alreadyResumed else { return }
                process.terminate()
                continuation.resume(returning: false)
            }
        }

        logFileHandle?.closeFile()
        return result
    }
```

- [ ] **Step 2: Call it at end of run() for each enabled task type**

Find this block in `run()`:
```swift
        statusMessage = parts.isEmpty ? "Done — nothing to do" : parts.joined(separator: " · ")
        allEntries = registry.allEntries()
    }
```

Replace with:
```swift
        // 6. Run per-task-type CLI prompts for enabled task types
        if let project = resolvedProject {
            if config.autoCodeRunReviewCode {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                 localPath: project.localPath,
                                 logSuffix: "review-code",
                                 logDir: logsDirectory())
            }
            if config.autoCodeRunReviewDoc {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewDoc,
                                 localPath: project.localPath,
                                 logSuffix: "review-doc",
                                 logDir: logsDirectory())
            }
            if config.autoCodeRunReviewConflicts {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewConflicts,
                                 localPath: project.localPath,
                                 logSuffix: "review-conflicts",
                                 logDir: logsDirectory())
            }
        }

        statusMessage = parts.isEmpty ? "Done — nothing to do" : parts.joined(separator: " · ")
        allEntries = registry.allEntries()
    }
```

**Important:** You need to capture `project` earlier in `run()` so it's in scope here. Find the guard that resolves the project near the top of `run()`:

```swift
        guard let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
```

Change `let project` to store it — currently it is already stored as `project`. Read the file to find the exact variable name used and ensure `project` (or whatever the local variable is named) remains in scope through to step 6. If it goes out of scope (e.g., it's declared inside an inner `guard`), extract it to a `var resolvedProject: SavedGitLabProject? = nil` at the top of `run()` and assign it when the guard passes.

- [ ] **Step 3: Build**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | tail -5
```
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac
git add Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift
git commit -m "feat: add prompt-based runCLI overload, invoke per-task-type templates in run()"
```

---

## Task 3: Rewrite AutoCodeView as two-pane layout

**Files:**
- Modify: `Sources/MeetNotesMac/Views/AutoCode/AutoCodeView.swift`

The current file is a single-column VStack. Replace it entirely with a two-pane HSplitView.

- [ ] **Step 1: Replace AutoCodeView.swift with the two-pane implementation**

Overwrite `Sources/MeetNotesMac/Views/AutoCode/AutoCodeView.swift` with:

```swift
import SwiftUI

struct AutoCodeView: View {
    @EnvironmentObject private var autoCode: AutoCodeUpdateService
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var theme: ThemeStore

    @State private var selectedTask: AutoTask? = .reviewCode

    var body: some View {
        HSplitView {
            leftPane
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 300)
            rightPane
                .frame(minWidth: 300)
        }
        .background(theme.current.body)
        .navigationTitle("Auto Tasks")
    }

    // MARK: - Left pane

    private var leftPane: some View {
        VStack(spacing: 0) {
            // Enable toggle header
            HStack {
                Toggle("", isOn: Binding(
                    get: { config.autoCodeUpdateEnabled },
                    set: { on in
                        config.autoCodeUpdateEnabled = on
                        if on { autoCode.start() } else { autoCode.stop() }
                    }
                ))
                .toggleStyle(.switch)
                .labelsHidden()

                Text(config.autoCodeUpdateEnabled ? "Enabled" : "Disabled")
                    .font(Typography.bodyStrong)
                    .foregroundStyle(config.autoCodeUpdateEnabled
                        ? theme.current.accent : theme.current.textMuted)

                Spacer()

                if autoCode.isRunning {
                    ProgressView().controlSize(.mini)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.current.surface)

            Divider()

            // Task type rows
            VStack(spacing: 0) {
                taskRow(.reviewCode,      label: "Review Code",      icon: "checkmark.shield",
                        enabled: $config.autoCodeRunReviewCode)
                taskRow(.reviewDoc,       label: "Review Doc",       icon: "doc.text.magnifyingglass",
                        enabled: $config.autoCodeRunReviewDoc)
                taskRow(.reviewConflicts, label: "Review Conflicts", icon: "exclamationmark.triangle",
                        enabled: $config.autoCodeRunReviewConflicts)
            }
            .padding(.vertical, 4)

            Divider()

            // Run history
            Text("History")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 4)

            if autoCode.allEntries.isEmpty {
                Text("No actions yet")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(autoCode.allEntries, id: \.actionId) { entry in
                            historyRow(entry)
                        }
                    }
                }
            }

            Spacer(minLength: 0)
            Divider()

            // Run Now
            Button {
                Task { await autoCode.run() }
            } label: {
                Label(autoCode.isRunning ? "Running…" : "Run Now",
                      systemImage: autoCode.isRunning ? "ellipsis.circle" : "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(autoCode.isRunning)
            .controlSize(.regular)
            .padding(12)
        }
        .background(theme.current.surface)
    }

    @ViewBuilder
    private func taskRow(_ task: AutoTask, label: String, icon: String,
                         enabled: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: enabled)
                .toggleStyle(.checkbox)
                .labelsHidden()

            Label(label, systemImage: icon)
                .font(Typography.body)
                .foregroundStyle(enabled.wrappedValue ? theme.current.text : theme.current.textMuted)

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selectedTask == task
            ? theme.current.accent.opacity(0.12)
            : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { selectedTask = task }
        .overlay(alignment: .leading) {
            if selectedTask == task {
                Rectangle()
                    .fill(theme.current.accent)
                    .frame(width: 3)
            }
        }
    }

    private func historyRow(_ entry: ProcessedActionsRegistry.RegistryEntry) -> some View {
        HStack(spacing: 8) {
            statusIcon(entry.status).frame(width: 14)
            Text(entry.actionText)
                .font(Typography.caption)
                .foregroundStyle(theme.current.text)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
    }

    // MARK: - Right pane

    private var rightPane: some View {
        Group {
            if let task = selectedTask {
                templateEditor(task)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.2.circlepath.circle")
                        .font(.system(size: 36))
                        .foregroundStyle(theme.current.textMuted)
                    Text("Select a task to edit its template")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.current.body)
            }
        }
    }

    @ViewBuilder
    private func templateEditor(_ task: AutoTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                Image(systemName: task.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
                Text(task.label)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Button("Restore Default") {
                    task.resetTemplate(config: config)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.current.textMuted)
                .font(Typography.caption)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(theme.current.surface)

            Divider()

            Text("Prompt template")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 6)

            TextEditor(text: task.templateBinding(config: config))
                .font(Typography.mono)
                .foregroundStyle(theme.current.text)
                .scrollContentBackground(.hidden)
                .background(theme.current.surface)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(theme.current.border, lineWidth: 1)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                )

            Spacer(minLength: 0)

            // Last run status
            if let last = autoCode.lastRunDate {
                Divider()
                HStack {
                    Text("Last run \(last, style: .relative) ago · \(autoCode.statusMessage)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(theme.current.surface)
            }
        }
        .background(theme.current.body)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func statusIcon(_ status: ProcessedActionsRegistry.EntryStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle.dotted").foregroundStyle(theme.current.textMuted)
        case .implementing:
            ProgressView().controlSize(.mini)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(theme.current.danger)
        }
    }
}

// MARK: - AutoTask enum

enum AutoTask: String, CaseIterable, Identifiable {
    case reviewCode
    case reviewDoc
    case reviewConflicts

    var id: String { rawValue }

    var label: String {
        switch self {
        case .reviewCode:      return "Review Code"
        case .reviewDoc:       return "Review Doc"
        case .reviewConflicts: return "Review Conflicts"
        }
    }

    var icon: String {
        switch self {
        case .reviewCode:      return "checkmark.shield"
        case .reviewDoc:       return "doc.text.magnifyingglass"
        case .reviewConflicts: return "exclamationmark.triangle"
        }
    }

    func templateBinding(config: AppConfig) -> Binding<String> {
        switch self {
        case .reviewCode:      return Binding(get: { config.autoTaskTemplateReviewCode },
                                              set: { config.autoTaskTemplateReviewCode = $0 })
        case .reviewDoc:       return Binding(get: { config.autoTaskTemplateReviewDoc },
                                              set: { config.autoTaskTemplateReviewDoc = $0 })
        case .reviewConflicts: return Binding(get: { config.autoTaskTemplateReviewConflicts },
                                              set: { config.autoTaskTemplateReviewConflicts = $0 })
        }
    }

    func resetTemplate(config: AppConfig) {
        switch self {
        case .reviewCode:      config.autoTaskTemplateReviewCode = AppConfig.defaultTemplateReviewCode
        case .reviewDoc:       config.autoTaskTemplateReviewDoc = AppConfig.defaultTemplateReviewDoc
        case .reviewConflicts: config.autoTaskTemplateReviewConflicts = AppConfig.defaultTemplateReviewConflicts
        }
    }
}
```

- [ ] **Step 2: Build**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | grep -E "error:|Build complete" | head -20
```
Expected: `Build complete!`

Fix any compiler errors. Common issues:
- `Typography.bodyStrong` — check if it exists in the codebase: `grep -rn "bodyStrong" Sources/`. If absent, use `Typography.body` with `.weight(.semibold)`.
- `Typography.title` — verify it exists. If not, use `.title2.weight(.semibold)`.
- `Typography.mono` — verify it exists. Check `grep -rn "static let mono" Sources/`.

- [ ] **Step 3: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac
git add Sources/MeetNotesMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat: rewrite AutoCodeView as two-pane layout with template editor"
```

---

## Task 4: Rename labels

**Files:**
- Modify: `Sources/MeetNotesMac/Views/Shell/SidebarView.swift`
- Modify: `Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift`

- [ ] **Step 1: Rename in SidebarView.swift**

Find:
```swift
                sidebarRow(label: "Auto Code", systemImage: "arrow.triangle.2.circlepath.circle",
                           section: .autoCode)
```

Change to:
```swift
                sidebarRow(label: "Auto Tasks", systemImage: "arrow.triangle.2.circlepath.circle",
                           section: .autoCode)
```

- [ ] **Step 2: Rename in AutoCodeSettingsSection.swift**

Find:
```swift
        SettingsSectionCard(icon: "arrow.triangle.2.circlepath.circle", title: "Auto Code Update") {
```

Change to:
```swift
        SettingsSectionCard(icon: "arrow.triangle.2.circlepath.circle", title: "Auto Tasks") {
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | tail -5
```
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac
git add Sources/MeetNotesMac/Views/Shell/SidebarView.swift Sources/MeetNotesMac/Views/Settings/AutoCodeSettingsSection.swift
git commit -m "feat: rename Auto Code → Auto Tasks in sidebar and settings"
```

---

## Task 5: Build app and smoke test

- [ ] **Step 1: Build the .app bundle**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes/mac && bash build_app.sh 2>&1 | grep -E "✓|error:" | head -10
```
Expected: `✓ Build Successful!`

- [ ] **Step 2: Open the app**

```bash
open /Users/dinesh.malla/Desktop/meet-notes/mac/MeetNotesMac.app
```

- [ ] **Step 3: Verify**

- Sidebar shows "Auto Tasks" (not "Auto Code")
- Clicking "Auto Tasks" opens the two-pane view
- Left pane shows three task rows with checkboxes and a "Run Now" button
- Clicking a task row selects it (left accent bar) and loads its template in the right pane
- Editing the template in the right pane persists (quit and relaunch — template is still there)
- "Restore Default" resets the template to the default text
- Settings → Auto Tasks section shows the renamed card title
