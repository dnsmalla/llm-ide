# Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all crash risks, silent failures, resource leaks, and UX rough edges across the LLM IDE macOS app.

**Architecture:** Changes are grouped in dependency order — crashes first, then resource management, then error propagation (infrastructure), then UX polish (consumers of that infrastructure). Each task is self-contained and commits on its own.

**Tech Stack:** Swift 5.9, SwiftUI macOS 14+, Combine, Foundation.Process, OSAllocatedUnfairLock, Swift Testing

---

## File Structure

**Modified files only — no new files:**
- `Sources/LlmIdeMac/Models/NoteAction.swift` — bounds-checked string parsing
- `Sources/LlmIdeMac/Services/LibraryItemStore.swift` — safe storeURL, os_log import
- `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — safe logsDirectory, deinit, sink, capture, file-handle defer, error properties, do/catch
- `Sources/LlmIdeMac/LlmIdeMacApp.swift` — safe registry URL, wire error callbacks
- `Sources/LlmIdeMac/Views/Shell/SidebarView.swift` — shortcut cap, accessibility labels
- `Sources/LlmIdeMac/Views/AppShell.swift` — recovery error do/catch, 30s timeout
- `Sources/LlmIdeMac/Services/GitLabClient.swift` — better error message
- `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift` — error callbacks, loadError, taskType, retry cap
- `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — error banners, confirmation, empty states, history timestamp, accessibility
- `Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` — navigation button in hint

---

### Task 1: NoteAction safe string parsing

**Files:**
- Modify: `Sources/LlmIdeMac/Models/NoteAction.swift`

Context: `NoteAction.swift` has three unsafe patterns in `extract(from:notesRoot:)` and `actionsSection(in:)`: a range subscript on a String without a bounds guard, and two `dropFirst(n)` calls without size guards. The fixes are defensive guards that skip malformed content rather than crashing.

- [ ] **Step 1: Add bounds guard on `split.bodyStart` and guard `dropFirst(4)`**

Replace the entire `NoteAction.swift` file with this safe version:

```swift
import Foundation
import CryptoKit

struct NoteAction: Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let text: String
    let meetingId: String
    let meetingTitle: String
}

enum NoteActionExtractor {
    static func extract(from rows: [MeetingIndex.Row], notesRoot: URL) -> [NoteAction] {
        var result: [NoteAction] = []
        for row in rows {
            let fileURL = notesRoot.appendingPathComponent(row.path)
            guard let contents = try? String(contentsOf: fileURL, encoding: .utf8),
                  let split = FrontmatterCoder.split(file: contents),
                  split.bodyStart <= contents.endIndex else { continue }
            let body = String(contents[split.bodyStart...])
            let items = actionsSection(in: body)
            for text in items {
                let normalized = normalize(text)
                guard !normalized.isEmpty else { continue }
                let id = sha256(normalized)
                result.append(NoteAction(id: id, text: text,
                                         meetingId: row.id,
                                         meetingTitle: row.title ?? ""))
            }
        }
        return result
    }

    static func normalize(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: .punctuationCharacters).joined(separator: " ")
            .components(separatedBy: .whitespaces).filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func actionsSection(in body: String) -> [String] {
        guard let range = body.range(of: "## Actions") else { return [] }
        let after = String(body[range.upperBound...])
        let nextHeading = after.range(of: "\n## ")?.lowerBound ?? after.endIndex
        let section = after[..<nextHeading]
        return section.split(separator: "\n")
            .filter { $0.hasPrefix("- ") }
            .compactMap { line -> String? in
                guard line.count >= 2 else { return nil }
                var s = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if s.hasPrefix("[ ] ") || s.hasPrefix("[x] ") || s.hasPrefix("[X] ") {
                    guard s.count >= 4 else { return s.isEmpty ? nil : s }
                    s = String(s.dropFirst(4))
                }
                return s.isEmpty ? nil : s
            }
    }

    private static func sha256(_ string: String) -> String {
        let data = Data(string.utf8)
        let hash = SHA256.hash(data: data)
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}
```

- [ ] **Step 2: Build to verify no errors**

Run: `cd /Users/dinesh.malla/Desktop/llm-ide/mac && swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Models/NoteAction.swift
git commit -m "fix: add bounds guards to NoteAction string parsing"
```

---

### Task 2: LibraryItemStore safe storeURL

**Files:**
- Modify: `Sources/LlmIdeMac/Services/LibraryItemStore.swift`

Context: `storeURL` force-unwraps `.first!` on the application support directory array. On sandboxed or unusual environments this crashes. Fix: make it optional and guard in callers.

- [ ] **Step 1: Replace force-unwrap with optional + guard in callers**

Replace the full file:

```swift
import Foundation
import Observation
import os.log

@MainActor
@Observable
final class LibraryItemStore {
    private(set) var items: [LibraryItem] = []

    private var storeURL: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("LLM IDE/library_items.json")
    }

    init() { load() }

    func items(for category: LibraryItem.Category) -> [LibraryItem] {
        items.filter { $0.category == category }
    }

    func add(url: URL, category: LibraryItem.Category) {
        guard !items.contains(where: { $0.path == url.path }) else { return }
        let item = LibraryItem(name: url.lastPathComponent, path: url.path, category: category)
        items.append(item)
        save()
    }

    func addFolder(url: URL, category: LibraryItem.Category) {
        let folderName = url.lastPathComponent
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for case let fileURL as URL in enumerator {
            if (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                guard !items.contains(where: { $0.path == fileURL.path }) else { continue }
                var item = LibraryItem(
                    name: fileURL.lastPathComponent,
                    path: fileURL.path,
                    category: category)
                item.folderOrigin = folderName
                items.append(item)
            }
        }
        save()
    }

    func remove(id: String) {
        items.removeAll { $0.id == id }
        save()
    }

    func syncMeetingNotes(from folder: URL) {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants]
        ) else { return }
        for case let url as URL in enumerator {
            if url.pathExtension == "md",
               !url.lastPathComponent.hasSuffix(".partial.md"),
               (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                add(url: url, category: .notes)
            }
        }
    }

    private func load() {
        guard let url = storeURL,
              let data = try? Data(contentsOf: url),
              let loaded = try? JSONDecoder().decode([LibraryItem].self, from: data) else { return }
        items = loaded
    }

    private func save() {
        guard let url = storeURL else {
            os_log(.error, "LibraryItemStore: applicationSupportDirectory unavailable, skipping save")
            return
        }
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(items) {
            try? data.write(to: url)
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Services/LibraryItemStore.swift
git commit -m "fix: replace force-unwrap in LibraryItemStore.storeURL with safe optional"
```

---

### Task 3: Safe URLs in AutoCodeUpdateService and LlmIdeMacApp

**Files:**
- Modify: `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` (logsDirectory only)
- Modify: `Sources/LlmIdeMac/LlmIdeMacApp.swift` (registry URL)

Context: Two force-subscript `[0]` patterns: `logsDirectory()` in AutoCodeUpdateService, and the registry URL construction in LlmIdeMacApp.

- [ ] **Step 1: Fix `logsDirectory()` return type**

Find this function at the bottom of `AutoCodeUpdateService.swift`:

```swift
private func logsDirectory() -> URL {
    let url = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/LLM IDE")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
```

Replace with:

```swift
private func logsDirectory() -> URL? {
    guard let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else {
        return nil
    }
    let url = base.appendingPathComponent("Logs/LLM IDE")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
```

- [ ] **Step 2: Fix call sites of `logsDirectory()` in `run()`**

In `run()`, step 4 (implement pending entries), find:

```swift
            let succeeded = await runCLI(
                issue: issue,
                localPath: localPath,
                logDir: logsDirectory()
            )
```

Replace with:

```swift
            guard let logDir = logsDirectory() else {
                log.error("logsDirectory unavailable, skipping CLI for issue \(iid)")
                registry.markFailed(id: entry.actionId)
                failedCount += 1
                continue
            }
            let succeeded = await runCLI(
                issue: issue,
                localPath: localPath,
                logDir: logDir
            )
```

In `run()`, step 6 (per-task-type CLI), find:

```swift
        if let localPath = resolvedLocalPath {
            if config.autoCodeRunReviewCode {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                 localPath: localPath,
                                 logSuffix: "review-code",
                                 logDir: logsDirectory())
            }
            if config.autoCodeRunReviewDoc {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewDoc,
                                 localPath: localPath,
                                 logSuffix: "review-doc",
                                 logDir: logsDirectory())
            }
            if config.autoCodeRunReviewConflicts {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewConflicts,
                                 localPath: localPath,
                                 logSuffix: "review-conflicts",
                                 logDir: logsDirectory())
            }
        }
```

Replace with:

```swift
        if let capturedLocalPath = resolvedLocalPath, let logDir = logsDirectory() {
            if config.autoCodeRunReviewCode {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                 localPath: capturedLocalPath,
                                 logSuffix: "review-code",
                                 logDir: logDir)
            }
            if config.autoCodeRunReviewDoc {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewDoc,
                                 localPath: capturedLocalPath,
                                 logSuffix: "review-doc",
                                 logDir: logDir)
            }
            if config.autoCodeRunReviewConflicts {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewConflicts,
                                 localPath: capturedLocalPath,
                                 logSuffix: "review-conflicts",
                                 logDir: logDir)
            }
        }
```

- [ ] **Step 3: Fix registry URL in LlmIdeMacApp**

In `LlmIdeMacApp.init()`, find:

```swift
        let registryURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LLM IDE/processed-actions.json")
```

Replace with:

```swift
        let appSupportBase = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support")
        let registryURL = appSupportBase.appendingPathComponent("LLM IDE/processed-actions.json")
```

- [ ] **Step 4: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift \
        Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "fix: replace [0] force-subscript with safe .first in URL lookups"
```

---

### Task 4: Sidebar keyboard shortcut cap at 9

**Files:**
- Modify: `Sources/LlmIdeMac/Views/Shell/SidebarView.swift`

Context: `Character("\(idx + 1)")` creates a multi-character string if there are 10+ sidebar items. `KeyEquivalent` silently takes only the first char. Guard at 9.

- [ ] **Step 1: Add `if idx < 9` guard around shortcut registration**

In `SidebarView.globalShortcuts`, find:

```swift
        return VStack(spacing: 0) {
            ForEach(Array(ShellState.Section.allCases.enumerated()), id: \.element) { (idx, sec) in
                Button("") { shell.section = sec }
                    .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
                    .frame(width: 0, height: 0)
            }
```

Replace with:

```swift
        return VStack(spacing: 0) {
            ForEach(Array(ShellState.Section.allCases.enumerated()), id: \.element) { (idx, sec) in
                if idx < 9 {
                    Button("") { shell.section = sec }
                        .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
                        .frame(width: 0, height: 0)
                }
            }
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Views/Shell/SidebarView.swift
git commit -m "fix: cap sidebar keyboard shortcuts at 9 to avoid multi-char Character"
```

---

### Task 5: AutoCodeUpdateService resource management

**Files:**
- Modify: `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

Context: Three resource issues: (1) no `deinit` — timer fires into deallocated object; (2) Combine sink doesn't call `stop()` when disabled; (3) `localPath` in step 4 of `run()` uses the guard-bound name while step 6 uses `resolvedLocalPath` — unify to a single `let capturedLocalPath` for clarity.

- [ ] **Step 1: Add `deinit`**

After the closing brace of `stop()` and before `// MARK: - Main run loop`, add:

```swift
    deinit {
        timer?.invalidate()
        timer = nil
    }
```

- [ ] **Step 2: Fix Combine sink to call `stop()` when disabled**

Find the sink in `init`:

```swift
        cancellable = config.$autoCodeUpdateEnabled
            .sink { [weak self] value in
                self?.isEnabled = value
            }
```

Replace with:

```swift
        cancellable = config.$autoCodeUpdateEnabled
            .sink { [weak self] value in
                guard let self else { return }
                self.isEnabled = value
                if !value { self.stop() }
            }
```

- [ ] **Step 3: Unify `localPath` capture in `run()`**

In the guard clause at the top of `run()`, find:

```swift
        guard let savedProject = config.gitLabSavedProjects.first(where: { $0.isActive }),
              let projectId = savedProject.resolvedId,
              let localPath = savedProject.localPath, !localPath.isEmpty else {
            statusMessage = "No linked repo — configure in GitLab settings"
            return
        }
        resolvedLocalPath = localPath
```

Replace with:

```swift
        guard let savedProject = config.gitLabSavedProjects.first(where: { $0.isActive }),
              let projectId = savedProject.resolvedId,
              let capturedLocalPath = savedProject.localPath, !capturedLocalPath.isEmpty else {
            statusMessage = "No linked repo — configure in GitLab settings"
            return
        }
        resolvedLocalPath = capturedLocalPath
```

Then in step 4 (implement pending entries), find the `runCLI` call for issue-based work:

```swift
            let succeeded = await runCLI(
                issue: issue,
                localPath: localPath,
                logDir: logDir
            )
```

Replace `localPath` with `capturedLocalPath`:

```swift
            let succeeded = await runCLI(
                issue: issue,
                localPath: capturedLocalPath,
                logDir: logDir
            )
```

- [ ] **Step 4: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
git commit -m "fix: add deinit, fix sink stop(), unify localPath capture in AutoCodeUpdateService"
```

---

### Task 6: File handle cleanup with defer in runCLI

**Files:**
- Modify: `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

Context: Both `runCLI` overloads open a `FileHandle` before calling `process.run()`. Using a `defer` makes the cleanup unconditional and explicit. Also convert `var logFileHandle` to `let` for clarity.

- [ ] **Step 1: Refactor file handle setup in `runCLI(issue:localPath:logDir:)`**

Find in `runCLI(issue:localPath:logDir:)`:

```swift
        // Capture stdout+stderr to log file
        var logFileHandle: FileHandle? = nil
        if let fh = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = fh
            process.standardError = fh
            logFileHandle = fh
        }
```

And at the end of that function:

```swift
        logFileHandle?.closeFile()
        return result
```

Replace the setup block with:

```swift
        // Capture stdout+stderr to log file
        let logFileHandle = try? FileHandle(forWritingTo: logURL)
        defer { logFileHandle?.closeFile() }
        if let fh = logFileHandle {
            process.standardOutput = fh
            process.standardError = fh
        }
```

Remove the old `logFileHandle?.closeFile()` line at the end (defer handles it now):

```swift
        return result
```

- [ ] **Step 2: Same refactor in `runCLI(prompt:localPath:logSuffix:logDir:)`**

Find:

```swift
        var logFileHandle: FileHandle? = nil
        if let fh = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = fh
            process.standardError = fh
            logFileHandle = fh
        }
```

And at the end:

```swift
        logFileHandle?.closeFile()
        return result
```

Apply the same replacement — setup becomes:

```swift
        let logFileHandle = try? FileHandle(forWritingTo: logURL)
        defer { logFileHandle?.closeFile() }
        if let fh = logFileHandle {
            process.standardOutput = fh
            process.standardError = fh
        }
```

Remove the manual close line, keep only `return result`.

- [ ] **Step 3: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
git commit -m "fix: use defer for FileHandle cleanup in runCLI to prevent leaks"
```

---

### Task 7: AppShell recovery background task timeout

**Files:**
- Modify: `Sources/LlmIdeMac/Views/AppShell.swift`

Context: `recover(_:)` uses `Task.detached(priority: .background)` with no timeout. If the file operation hangs (network drive, permission issue), it runs indefinitely. Add a 30-second timeout using `withThrowingTaskGroup`.

- [ ] **Step 1: Add `RecoveryTimeoutError` type and refactor `recover(_:)` with timeout**

Add the error type just before `AppShell`:

```swift
private struct RecoveryTimeoutError: Error {}
```

Replace the entire `recover(_:)` function:

```swift
    private func recover(_ o: PartialRecovery.Orphan) {
        recoveryError = nil
        pendingOrphan = nil
        guard let env = appEnv else { return }
        let url = URL(fileURLWithPath: o.path)
        let root = env.notesConfig.currentFolder
        Task.detached(priority: .background) {
            do {
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        let recovery = PartialRecovery(root: root)
                        guard FileManager.default.fileExists(atPath: url.path) else {
                            try? recovery.cleanup(id: o.id)
                            return
                        }
                        let store = MeetingFileStore(root: root)
                        _ = try store.finalize(
                            partialAt: url,
                            title: "Recovered",
                            endedAt: Date(),
                            participants: [])
                        try recovery.cleanup(id: o.id)
                        await rescanIndex()
                        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(30))
                        throw RecoveryTimeoutError()
                    }
                    _ = try await group.next()
                    group.cancelAll()
                }
            } catch is RecoveryTimeoutError {
                await MainActor.run { recoveryError = "Recovery timed out after 30 seconds." }
            } catch {
                let msg = error.localizedDescription
                await MainActor.run { recoveryError = msg }
            }
        }
    }
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Views/AppShell.swift
git commit -m "fix: add 30s timeout to AppShell recovery background task"
```

---

### Task 8: AutoCodeUpdateService error properties and do/catch in run()

**Files:**
- Modify: `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

Context: `run()` uses `try?` to open MeetingIndex, silently dropping errors. Add `@Published var lastError` and `taskErrors` to surface failures to the UI, replace `try?` with `do/catch`, and add a `setError(_:)` helper for external callers (e.g., registry error wiring in Task 9).

- [ ] **Step 1: Add error-tracking published properties to `AutoCodeUpdateService`**

In the `// MARK: - Published state` section, after `@Published private(set) var allEntries`, add:

```swift
    @Published private(set) var lastError: String? = nil
    @Published private(set) var taskErrors: [String: String] = [:]
```

- [ ] **Step 2: Add `setError(_:)` and `dismissLastError()` and `dismissTaskError(for:)` methods**

After the `stop()` function and before `deinit`, add:

```swift
    func setError(_ message: String) {
        lastError = message
    }

    func dismissLastError() {
        lastError = nil
    }

    func dismissTaskError(for task: AutoTask) {
        taskErrors.removeValue(forKey: task.rawValue)
    }
```

- [ ] **Step 3: Reset errors at start of `run()` and fix MeetingIndex do/catch**

At the top of `run()`, after the `defer` block, add `lastError = nil`:

```swift
    func run() async {
        guard !isRunning else { return }
        isRunning = true
        createdCount = 0
        implementedCount = 0
        failedCount = 0
        lastError = nil
        defer {
            isRunning = false
            lastRunDate = Date()
        }
```

Find the `try?` MeetingIndex guard:

```swift
        guard let index = try? MeetingIndex(url: indexURL) else {
            statusMessage = "Could not open meeting index"
            return
        }
```

Replace with:

```swift
        let index: MeetingIndex
        do {
            index = try MeetingIndex(url: indexURL)
        } catch {
            statusMessage = "Could not open meeting index"
            lastError = "Meeting index unavailable: \(error.localizedDescription)"
            return
        }
```

- [ ] **Step 4: Record task errors from step 6 runCLI calls**

Find the step 6 block (after `// 6. Run per-task-type CLI prompts`):

```swift
        if let capturedLocalPath = resolvedLocalPath, let logDir = logsDirectory() {
            if config.autoCodeRunReviewCode {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                 localPath: capturedLocalPath,
                                 logSuffix: "review-code",
                                 logDir: logDir)
            }
            if config.autoCodeRunReviewDoc {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewDoc,
                                 localPath: capturedLocalPath,
                                 logSuffix: "review-doc",
                                 logDir: logDir)
            }
            if config.autoCodeRunReviewConflicts {
                _ = await runCLI(prompt: config.autoTaskTemplateReviewConflicts,
                                 localPath: capturedLocalPath,
                                 logSuffix: "review-conflicts",
                                 logDir: logDir)
            }
        }
```

Replace with:

```swift
        if let capturedLocalPath = resolvedLocalPath, let logDir = logsDirectory() {
            if config.autoCodeRunReviewCode {
                let ok = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                      localPath: capturedLocalPath,
                                      logSuffix: "review-code",
                                      logDir: logDir)
                if ok {
                    taskErrors.removeValue(forKey: AutoTask.reviewCode.rawValue)
                } else {
                    taskErrors[AutoTask.reviewCode.rawValue] = "Review Code task failed. Check ~/Library/Logs/LLM IDE/auto-task-review-code.log"
                }
            }
            if config.autoCodeRunReviewDoc {
                let ok = await runCLI(prompt: config.autoTaskTemplateReviewDoc,
                                      localPath: capturedLocalPath,
                                      logSuffix: "review-doc",
                                      logDir: logDir)
                if ok {
                    taskErrors.removeValue(forKey: AutoTask.reviewDoc.rawValue)
                } else {
                    taskErrors[AutoTask.reviewDoc.rawValue] = "Review Doc task failed. Check ~/Library/Logs/LLM IDE/auto-task-review-doc.log"
                }
            }
            if config.autoCodeRunReviewConflicts {
                let ok = await runCLI(prompt: config.autoTaskTemplateReviewConflicts,
                                      localPath: capturedLocalPath,
                                      logSuffix: "review-conflicts",
                                      logDir: logDir)
                if ok {
                    taskErrors.removeValue(forKey: AutoTask.reviewConflicts.rawValue)
                } else {
                    taskErrors[AutoTask.reviewConflicts.rawValue] = "Review Conflicts task failed. Check ~/Library/Logs/LLM IDE/auto-task-review-conflicts.log"
                }
            }
        }
```

- [ ] **Step 5: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
git commit -m "feat: add lastError/taskErrors to AutoCodeUpdateService, replace try? with do/catch"
```

---

### Task 9: ProcessedActionsRegistry error callbacks and LlmIdeMacApp wiring

**Files:**
- Modify: `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift`
- Modify: `Sources/LlmIdeMac/LlmIdeMacApp.swift`

Context: `load()` and `save()` silently swallow errors. Add optional error callbacks and a `loadError` property (for init-time errors that fire before callbacks are wired). Wire in `LlmIdeMacApp` to forward errors to `AutoCodeUpdateService.lastError`.

- [ ] **Step 1: Add error callbacks and `loadError` to `ProcessedActionsRegistry`**

After `private let storeURL: URL` and before `private var entries`, add:

```swift
    var onSaveError: ((Error) -> Void)? = nil
    private(set) var loadError: Error? = nil
```

- [ ] **Step 2: Update `load()` to use do/catch and fire callback**

Replace the current `load()`:

```swift
    private func load() {
        guard let data = try? Data(contentsOf: storeURL),
              let decoded = try? JSONDecoder().decode([String: RegistryEntry].self, from: data)
        else { return }
        entries = decoded
    }
```

With:

```swift
    private func load() {
        guard FileManager.default.fileExists(atPath: storeURL.path) else { return }
        do {
            let data = try Data(contentsOf: storeURL)
            entries = try JSONDecoder().decode([String: RegistryEntry].self, from: data)
        } catch {
            log.error("processed_actions_registry_load_failed: \(error, privacy: .public)")
            loadError = error
        }
    }
```

- [ ] **Step 3: Update `save()` to use do/catch and fire callback**

Replace the current `save()`:

```swift
    private func save() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        do {
            try data.write(to: storeURL, options: .atomic)
        } catch {
            log.error("processed_actions_registry_save_failed: \(error, privacy: .public)")
        }
    }
```

With:

```swift
    private func save() {
        do {
            let data = try JSONEncoder().encode(entries)
            try FileManager.default.createDirectory(
                at: storeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: storeURL, options: .atomic)
        } catch {
            log.error("processed_actions_registry_save_failed: \(error, privacy: .public)")
            onSaveError?(error)
        }
    }
```

- [ ] **Step 4: Wire callbacks in `LlmIdeMacApp.init()`**

After:

```swift
        let registry = ProcessedActionsRegistry(storeURL: registryURL)
        let autoCode = AutoCodeUpdateService(config: cfg, gitLabClient: GitLabClient(), registry: registry)
```

Add:

```swift
        // Forward registry errors to the service so AutoCodeView can display them
        if let loadErr = registry.loadError {
            autoCode.setError("Action history failed to load: \(loadErr.localizedDescription)")
        }
        registry.onSaveError = { [weak autoCode] error in
            Task { @MainActor in
                autoCode?.setError("Action history failed to save: \(error.localizedDescription)")
            }
        }
```

- [ ] **Step 5: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift \
        Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat: add error callbacks to ProcessedActionsRegistry, wire to AutoCodeUpdateService"
```

---

### Task 10: GitLabClient better error message

**Files:**
- Modify: `Sources/LlmIdeMac/Services/GitLabClient.swift`

Context: The fallback error message loses the HTTP status code when JSON decode fails. Always include the status code.

- [ ] **Step 1: Improve fallback error message**

In `executeWithHeaders(_:)`, find:

```swift
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["message"]
                ?? String(data: data.prefix(200), encoding: .utf8)
                ?? "Unknown error"
            throw GitLabError.httpError(http.statusCode, msg)
```

Replace with:

```swift
            let jsonMsg = (try? JSONDecoder().decode([String: String].self, from: data))?["message"]
            let bodyPreview = String(data: data.prefix(500), encoding: .utf8)
            let msg = jsonMsg ?? bodyPreview.map { "HTTP \(http.statusCode): \($0)" }
                ?? "HTTP \(http.statusCode): <binary response>"
            throw GitLabError.httpError(http.statusCode, msg)
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Services/GitLabClient.swift
git commit -m "fix: include HTTP status code in GitLabClient fallback error message"
```

---

### Task 11: AppShell scan and rescan error handling

**Files:**
- Modify: `Sources/LlmIdeMac/Views/AppShell.swift`

Context: `checkRecovery()` swallows orphan scan errors with `try?`. `rescanIndex()` swallows full-scan errors. Both should set `recoveryError` (already displayed via the existing bottom banner).

- [ ] **Step 1: Fix `checkRecovery()` to use do/catch**

Replace:

```swift
    private func checkRecovery() async {
        guard let env = appEnv else { return }
        let rec = PartialRecovery(root: env.notesConfig.currentFolder)
        if let o = try? rec.scanOrphans().first {
            pendingOrphan = o
        }
    }
```

With:

```swift
    private func checkRecovery() async {
        guard let env = appEnv else { return }
        let rec = PartialRecovery(root: env.notesConfig.currentFolder)
        do {
            if let o = try rec.scanOrphans().first {
                pendingOrphan = o
            }
        } catch {
            recoveryError = "Could not scan for partial recordings: \(error.localizedDescription)"
        }
    }
```

- [ ] **Step 2: Fix `rescanIndex()` to use do/catch**

Replace:

```swift
    @MainActor
    private func rescanIndex() async {
        try? appEnv?.indexer.fullScan()
    }
```

With:

```swift
    @MainActor
    private func rescanIndex() async {
        do {
            try appEnv?.indexer.fullScan()
        } catch {
            recoveryError = "Index scan failed: \(error.localizedDescription)"
        }
    }
```

- [ ] **Step 3: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add Sources/LlmIdeMac/Views/AppShell.swift
git commit -m "fix: surface checkRecovery and rescanIndex errors to AppShell banner"
```

---

### Task 12: AutoCodeView error banners

**Files:**
- Modify: `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

Context: `AutoCodeUpdateService` now publishes `lastError` and `taskErrors` but nothing displays them. Add a reusable `errorBanner` helper and wire it into the left pane (run errors) and right pane template editor (per-task CLI errors).

- [ ] **Step 1: Add `errorBanner` helper to `AutoCodeView`**

In the `// MARK: - Helpers` section (after `statusIcon`), add:

```swift
    @ViewBuilder
    private func errorBanner(message: String, onDismiss: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(theme.current.danger)
                .font(.system(size: 12))
                .accessibilityHidden(true)
            Text(message)
                .font(Typography.caption)
                .foregroundStyle(theme.current.text)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(theme.current.danger.opacity(0.1))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(theme.current.danger.opacity(0.3), lineWidth: 1)
                .padding(.horizontal, 12)
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
```

- [ ] **Step 2: Wire `lastError` banner into left pane (above Run Now button)**

In `leftPane`, find:

```swift
            Spacer(minLength: 0)
            Divider()

            // Run Now
            Button {
```

Replace with:

```swift
            Spacer(minLength: 0)

            if let error = autoCode.lastError {
                errorBanner(message: error) { autoCode.dismissLastError() }
            }

            Divider()

            // Run Now
            Button {
```

- [ ] **Step 3: Wire `taskErrors` banner into right pane template editor**

In `templateEditor(_:)`, find:

```swift
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
```

Replace with:

```swift
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

            if let error = autoCode.taskErrors[task.rawValue] {
                errorBanner(message: error) { autoCode.dismissTaskError(for: task) }
            }

            Spacer(minLength: 0)
```

- [ ] **Step 4: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat: add error banners to AutoCodeView for run and per-task CLI failures"
```

---

### Task 13: "Restore Default" confirmation dialog

**Files:**
- Modify: `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

Context: The "Restore Default" button immediately overwrites customized templates with no warning. Add a `confirmationDialog` so the user must confirm the destructive action.

- [ ] **Step 1: Add `taskToReset` state and confirmation dialog to `templateEditor`**

At the top of `AutoCodeView`, after `@State private var selectedTask`, add:

```swift
    @State private var taskToReset: AutoTask? = nil
```

In `templateEditor(_:)`, find the "Restore Default" button:

```swift
                Button("Restore Default") {
                    task.resetTemplate(config: config)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.current.textMuted)
                .font(Typography.caption)
```

Replace with:

```swift
                Button("Restore Default") {
                    taskToReset = task
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.current.textMuted)
                .font(Typography.caption)
```

At the end of `templateEditor(_:)` (before the closing brace, after the last-run status section), add a `.confirmationDialog` modifier on the returned `VStack`:

The `templateEditor` returns a `VStack`. Add the modifier to its closing:

```swift
        .background(theme.current.body)
        .confirmationDialog(
            "Reset \"\(task.label)\" template to default?",
            isPresented: Binding(
                get: { taskToReset == task },
                set: { if !$0 { taskToReset = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Reset to Default", role: .destructive) {
                task.resetTemplate(config: config)
                taskToReset = nil
            }
            Button("Cancel", role: .cancel) {
                taskToReset = nil
            }
        } message: {
            Text("Your custom prompt will be permanently replaced.")
        }
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat: add confirmation dialog to Restore Default button in AutoCodeView"
```

---

### Task 14: Empty state messages and history row timestamp

**Files:**
- Modify: `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`
- Modify: `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift`

Context: "No actions yet" is vague. The history row shows no timestamp. `RegistryEntry` already has `lastUpdated: Date` — use it. Also add an optional `taskType: String?` field to RegistryEntry for forward-compatibility.

- [ ] **Step 1: Add `taskType` field to `RegistryEntry`**

In `ProcessedActionsRegistry.swift`, find:

```swift
    struct RegistryEntry: Codable {
        let actionId: String
        let actionText: String
        var issueIid: Int?
        var status: EntryStatus
        var retryCount: Int
        var registeredAt: Date
        var lastUpdated: Date
    }
```

Replace with:

```swift
    struct RegistryEntry: Codable {
        let actionId: String
        let actionText: String
        var issueIid: Int?
        var status: EntryStatus
        var retryCount: Int
        var registeredAt: Date
        var lastUpdated: Date
        var taskType: String?
    }
```

- [ ] **Step 2: Update empty state message in left pane**

In `leftPane`, find:

```swift
                Text("No actions yet")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
```

Replace with:

```swift
                Text("No actions found yet. Run Auto Tasks or record a meeting with action items.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
```

- [ ] **Step 3: Update placeholder message in right pane**

In `rightPane`, find:

```swift
                    Text("Select a task to edit its template")
```

Replace with:

```swift
                    Text("Select a review task from the left to edit its AI prompt.")
```

- [ ] **Step 4: Update `historyRow` to include relative timestamp**

Replace the current `historyRow` function:

```swift
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
```

With:

```swift
    private func historyRow(_ entry: ProcessedActionsRegistry.RegistryEntry) -> some View {
        HStack(spacing: 8) {
            statusIcon(entry.status).frame(width: 14)
            Text(entry.actionText)
                .font(Typography.caption)
                .foregroundStyle(theme.current.text)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(entry.lastUpdated, style: .relative)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
    }
```

- [ ] **Step 5: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift \
        Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift
git commit -m "feat: improve empty state messages and add timestamp to AutoTasks history row"
```

---

### Task 15: ProcessedActionsRegistry retry cap in resetStuckImplementing

**Files:**
- Modify: `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift`

Context: `resetStuckImplementing()` resets `.implementing` entries to `.pending` on every launch without incrementing `retryCount`. A CLI that always crashes would retry forever. Fix: increment `retryCount` during reset, and if `retryCount >= 3`, mark `.failed` instead.

- [ ] **Step 1: Update `resetStuckImplementing()` to respect retry cap**

Replace the current `resetStuckImplementing()`:

```swift
    private func resetStuckImplementing() {
        var changed = false
        for key in entries.keys where entries[key]?.status == .implementing {
            entries[key]?.status = .pending
            entries[key]?.lastUpdated = Date()
            changed = true
        }
        if changed { save() }
    }
```

With:

```swift
    private func resetStuckImplementing() {
        var changed = false
        for key in entries.keys where entries[key]?.status == .implementing {
            guard var entry = entries[key] else { continue }
            entry.retryCount += 1
            if entry.retryCount >= 3 {
                entry.status = .failed
                entry.actionText = "[max retries] \(entry.actionText)"
            } else {
                entry.status = .pending
            }
            entry.lastUpdated = Date()
            entries[key] = entry
            changed = true
        }
        if changed { save() }
    }
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift
git commit -m "fix: cap retry count at 3 in ProcessedActionsRegistry.resetStuckImplementing"
```

---

### Task 16: "No linked repo" hint with navigation button

**Files:**
- Modify: `Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`

Context: The existing `SettingsHint` tells the user to configure GitLab settings but provides no way to navigate there. Add a `Button("Open GitLab Settings")` that sets `shell.section = .settings`. `ShellState` is accessed via `@Environment(ShellState.self)` (same pattern as `SidebarView`).

- [ ] **Step 1: Inject `ShellState` and replace the hint**

At the top of `AutoCodeSettingsSection`, after the existing `@EnvironmentObject` lines, add:

```swift
    @Environment(ShellState.self) private var shell
```

Replace the hint block:

```swift
                // Warning hint when no active+cloned GitLab project is configured
                if !hasLinkedRepo {
                    SettingsHint("No linked repository detected. Configure an active GitLab project with a local clone path in GitLab settings to use Auto Code Update.")
                }
```

With:

```swift
                // Warning hint when no active+cloned GitLab project is configured
                if !hasLinkedRepo {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No linked repository detected. An active GitLab project with a local clone path is required.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Open GitLab Settings") {
                            shell.section = .settings
                        }
                        .font(Typography.caption)
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.current.accent)
                    }
                    .padding(.vertical, 2)
                }
```

- [ ] **Step 2: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift
git commit -m "feat: add Open GitLab Settings navigation button to AutoCode settings hint"
```

---

### Task 17: Accessibility labels throughout

**Files:**
- Modify: `Sources/LlmIdeMac/Views/Shell/SidebarView.swift`
- Modify: `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

Context: Compact-mode sidebar rows, record/stop buttons, and Auto Tasks status icons all lack `.accessibilityLabel`. Screen readers only see the SF Symbol name or nothing.

- [ ] **Step 1: Add `.accessibilityLabel` to compact sidebar rows**

In `SidebarView.sidebarRow(label:systemImage:section:trailing:)`, find the compact branch:

```swift
        if isCompact {
            HStack {
                Spacer(minLength: 0)
                Image(systemName: systemImage)
                    .font(.system(size: 16))
                    .frame(width: 22, height: 22)
                Spacer(minLength: 0)
                if let trailing = trailing { trailing }
            }
            .tag(section)
            .help(label)
        }
```

Replace with:

```swift
        if isCompact {
            HStack {
                Spacer(minLength: 0)
                Image(systemName: systemImage)
                    .font(.system(size: 16))
                    .frame(width: 22, height: 22)
                Spacer(minLength: 0)
                if let trailing = trailing { trailing }
            }
            .tag(section)
            .help(label)
            .accessibilityLabel(label)
        }
```

- [ ] **Step 2: Add `.accessibilityLabel` to Record/Stop buttons**

In `SidebarView.recordButton`, the stop button ends with:

```swift
            .buttonStyle(.plain)
            .help("Stop & Save")
```

Add:

```swift
            .buttonStyle(.plain)
            .help("Stop & Save")
            .accessibilityLabel("Stop recording and save")
```

The record button ends with:

```swift
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
            .help("Start recording (⌘N)")
```

Add:

```swift
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
            .help("Start recording (⌘N)")
            .accessibilityLabel("Start recording")
```

- [ ] **Step 3: Add `.accessibilityLabel` to status icons in `AutoCodeView.statusIcon`**

Replace the entire `statusIcon` function:

```swift
    @ViewBuilder
    private func statusIcon(_ status: ProcessedActionsRegistry.EntryStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle.dotted")
                .foregroundStyle(theme.current.textMuted)
                .accessibilityLabel("Pending")
        case .implementing:
            ProgressView()
                .controlSize(.mini)
                .accessibilityLabel("Implementing")
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(theme.current.danger)
                .accessibilityLabel("Failed")
        }
    }
```

- [ ] **Step 4: Build**

Run: `swift build 2>&1 | grep -E "error:|Build complete"`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add Sources/LlmIdeMac/Views/Shell/SidebarView.swift \
        Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat: add accessibilityLabel to sidebar rows, record buttons, and status icons"
```

---

### Task 18: Build app and verify

**Files:** None modified — verification only.

- [ ] **Step 1: Full production build**

Run: `bash /Users/dinesh.malla/Desktop/llm-ide/mac/build_app.sh 2>&1 | tail -10`
Expected: `✓ Build Successful!`

- [ ] **Step 2: Open app and smoke test**

Run: `open /Users/dinesh.malla/Desktop/llm-ide/mac/LlmIdeMac.app`

Verify:
- Auto Tasks sidebar entry present, clicking it shows two-pane layout
- Clicking each task row (Review Code/Doc/Conflicts) highlights it with accent bar and shows template in right pane
- "Restore Default" shows confirmation dialog, not immediate reset
- History row shows relative timestamp on the right
- Settings → Auto Tasks shows "Open GitLab Settings" button when no repo linked
- Compact sidebar (drag width below 160pt): rows show only icons, still have tooltips
- No crash on launch

- [ ] **Step 3: Final commit if any verification fixes were needed**

```bash
git add -p   # stage only intentional changes
git commit -m "fix: post-verification corrections"
```

---

## Self-Review

**Spec coverage check:**
- §1.1 logsDirectory safe URL → Task 3 ✓
- §1.2 LibraryItemStore force-unwrap → Task 2 ✓
- §1.3 NoteAction string parsing → Task 1 ✓
- §1.4 Sidebar shortcut cap → Task 4 ✓
- §2.1 AutoCodeUpdateService lastError/taskErrors → Task 8 ✓
- §2.2 ProcessedActionsRegistry error callbacks → Task 9 ✓
- §2.3 AutoCodeView error banners → Task 12 ✓
- §2.4 GitLabClient error message → Task 10 ✓
- §2.5 AppShell scan errors → Task 11 ✓
- §3.1 File handle leak → Task 6 ✓
- §3.2 Timer deinit → Task 5 ✓
- §3.3 Combine sink stop() → Task 5 ✓
- §3.4 localPath capture → Task 5 ✓
- §3.5 Background task timeout → Task 7 ✓
- §4.1 Restore Default confirmation → Task 13 ✓
- §4.2 Empty state messages → Task 14 ✓
- §4.3 History row timestamp → Task 14 ✓
- §4.4 No linked repo navigation button → Task 16 ✓
- §4.5 Accessibility labels → Task 17 ✓
- §4.6 Retry cap → Task 15 ✓

All 20 spec requirements have a corresponding task. No placeholders. Type names are consistent across all tasks.
