# Production Hardening Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all crash risks, silent failures, resource leaks, and UX rough edges across the LLM IDE macOS app to reach production quality.

**Architecture:** Issues are fixed in dependency order — crash prevention first (nothing else matters if the app crashes), then error propagation infrastructure (services surface errors), then resource management (cleanup on all paths), then UX polish (banners, confirmations, accessibility) that consumes the error infrastructure.

**Tech Stack:** Swift 5.9, SwiftUI macOS, Combine, Foundation.Process, OSAllocatedUnfairLock

---

## Section 1: Crash Prevention

### 1.1 `AutoCodeUpdateService.logsDirectory()`

**File:** `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Problem:** `FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]` — subscript `[0]` on an array that could theoretically be empty. Crashes if the system returns no library directory.

**Fix:** Replace with `guard let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }`. Change return type to `URL?` and guard at all call sites.

### 1.2 `LibraryItemStore.storeURL`

**File:** `Sources/LlmIdeMac/Services/LibraryItemStore.swift`

**Problem:** `FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!` — force-unwrap. Will crash on sandboxed environments where the directory cannot be resolved.

**Fix:** Return `URL?`, propagate nil to callers with a guard. If nil, the store is inoperable — log an `os_log` error and disable persistence gracefully.

### 1.3 `NoteAction.swift` string parsing

**File:** `Sources/LlmIdeMac/Models/NoteAction.swift`

**Problem 1:** `String(contents[split.bodyStart...])` — `split.bodyStart` is not bounds-checked against `contents.endIndex`. If the parser returns an out-of-range index, this crashes.

**Problem 2:** `.dropFirst(2)` on lines from `.split(separator: "\n")` — empty or single-char lines produce an empty substring, not a crash in Swift (safe), but downstream code that assumes non-empty content silently produces wrong results. Add a guard `guard line.count > 2` before use.

**Problem 3:** `.dropFirst(4)` for checkbox prefix `"[x] "` — assumes exactly 4 chars. Fix: use `String(line.dropFirst(4))` wrapped with a `guard line.count >= 4`.

**Fix:** Add range validation before all `String(contents[index...])` operations. Replace bare `.dropFirst(n)` with guarded versions.

### 1.4 Sidebar keyboard shortcut character conversion

**File:** `Sources/LlmIdeMac/Views/Shell/SidebarView.swift`

**Problem:** `Character("\(idx + 1)")` — if `idx + 1 > 9`, this creates a two-digit string `"10"`, which cannot be converted to a single `Character`. `KeyEquivalent(Character("10"))` takes only the first character silently but the intent is wrong.

**Fix:** `guard idx < 9 else { continue }` — only register shortcuts for the first 9 sidebar items. Items beyond 9 get no shortcut.

---

## Section 2: Error Propagation

### 2.1 `AutoCodeUpdateService` — surface errors to UI

**File:** `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Problem:** Multiple `try?` calls in `run()` swallow errors. If MeetingIndex, NoteActionExtractor, or GitLab fetch fail, `statusMessage` is updated but the user sees no actionable error.

**Fix:**
- Add `@Published var lastError: String? = nil` to `AutoCodeUpdateService`.
- Replace `try?` in `run()` with `do/catch`. On catch, set `lastError = error.localizedDescription` and return early.
- Reset `lastError = nil` at the start of each `run()` call.
- Add `@Published var taskErrors: [String: String] = [:]` (keyed by `AutoTask.rawValue`) to record per-task CLI failures. Set when `runCLI(prompt:...)` returns a non-zero exit code or throws.

### 2.2 `ProcessedActionsRegistry` — surface load/save errors

**File:** `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift`

**Problem:** Both `load()` and `save()` use `try?` with no user notification. Failed persistence silently loses action history.

**Fix:**
- `load()`: Replace `try?` with `do/catch`. On decode failure, log with `os_log(.error, ...)` and call a stored `onLoadError: ((Error) -> Void)?` closure (injected at init, optional so existing callers don't break).
- `save()`: Replace `try?` with `do/catch`. On failure, log and call an `onSaveError` closure.
- `LlmIdeMacApp.swift`: Wire these closures to set `autoCodeUpdate.lastError`.

### 2.3 `AutoCodeView` — display `lastError` and `taskErrors`

**File:** `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

**Problem:** No UI path for errors from the service.

**Fix:**
- In the right pane `templateEditor(_:)`, below the `TextEditor`, add a conditional `taskErrorBanner(for: task)` view: a red-tinted rounded rectangle with the error string and a dismiss button that clears `autoCode.taskErrors[task.rawValue]`.
- In the left pane footer (above Run Now), add a `lastErrorBanner` view: shows `autoCode.lastError` with a dismiss button. Appears between the history list and the Run Now button.

### 2.4 `GitLabClient` network error messages

**File:** `Sources/LlmIdeMac/Services/GitLabClient.swift`

**Problem:** On decode failure, error message falls back to `String(data: data.prefix(200), encoding: .utf8) ?? "Unknown error"`. The fallback `"Unknown error"` loses all diagnostic context.

**Fix:** Change fallback to `"HTTP \(statusCode): \(String(data: data.prefix(500), encoding: .utf8) ?? "<binary response>")"` so the status code is always included.

### 2.5 `AppShell` — surface scan/recovery errors

**File:** `Sources/LlmIdeMac/Views/AppShell.swift`

**Problem:** `try? rec.scanOrphans()` and `try? appEnv?.indexer.fullScan()` swallow errors silently.

**Fix:** Replace with `do/catch`. On error, set a `@State var indexError: String?` and show it in a `.alert` on the root view. This is a one-time startup error — an alert is appropriate (not a banner).

---

## Section 3: Resource Management

### 3.1 File handle leak in `runCLI` (both overloads)

**File:** `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Problem:** Both `runCLI` overloads open a `FileHandle` before `process.run()`. If `run()` throws, the local handle variable goes out of scope without being closed (it was never assigned to `logFileHandle`).

**Fix:** Restructure both overloads:
```swift
let tempHandle = try? FileHandle(forWritingTo: logURL)
logFileHandle = tempHandle
defer { logFileHandle?.closeFile(); logFileHandle = nil }
do {
    try process.run()
} catch {
    // handle is closed by defer
    throw error
}
```

### 3.2 Timer leak in `AutoCodeUpdateService.deinit`

**File:** `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Problem:** No `deinit`. If the service is deallocated while a timer is active, the timer fires into a deallocated object.

**Fix:** Add `deinit { timer?.invalidate(); timer = nil }`.

### 3.3 Combine sink doesn't call `stop()`

**File:** `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Problem:** The `config.$autoCodeUpdateEnabled` sink only updates `isEnabled` when disabled. The timer keeps running.

**Fix:** In the sink, when `enabled == false`, call `self.stop()` instead of only setting `isEnabled`.

### 3.4 `localPath` capture race in `run()`

**File:** `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Problem:** `localPath` / `resolvedLocalPath` is read from config before the first `await`, but used after multiple `await` points. If the user changes config during a run, the value could be inconsistent.

**Fix:** Capture to a `let` before the first suspension point:
```swift
let capturedLocalPath = resolvedLocalPath
```
Use `capturedLocalPath` for all subsequent steps.

### 3.5 Background task timeout in `AppShell`

**File:** `Sources/LlmIdeMac/Views/AppShell.swift`

**Problem:** `Task.detached(priority: .background)` recovery scan has no timeout. Network-mounted drives or permission issues could hang it indefinitely.

**Fix:** Wrap the body in a `withThrowingTaskGroup` with a second task that calls `Task.sleep(for: .seconds(30))` then throws `TimeoutError()`. First-to-finish cancels the other.

---

## Section 4: UX Polish

### 4.1 "Restore Default" confirmation dialog

**File:** `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

**Problem:** Clicking "Restore Default" immediately overwrites the template with no warning.

**Fix:** Add `@State private var showResetConfirm = false`. Change the button to set this flag. Add `.confirmationDialog("Reset template to default?", isPresented: $showResetConfirm, titleVisibility: .visible)` with a destructive "Reset" action that calls `task.resetTemplate(config: config)`.

### 4.2 Empty state messages

**File:** `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

**Current:** "No actions yet"
**Fix:** "No actions found yet. Run Auto Tasks or record a meeting with action items."

**Current:** "Select a task to edit its template"
**Fix:** "Select a review task from the left to edit its AI prompt."

### 4.3 Auto Tasks history row — add task type and timestamp

**File:** `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

**Problem:** History rows show only status icon + action text. No timestamp, no task type label. Hard to scan.

**Fix:** Update `historyRow(_:)` to show:
- Status icon (existing)
- Action text truncated to 1 line (existing)
- Timestamp in relative format (e.g. "2h ago") — right-aligned, `.caption` font, muted color
- Derive task type from `entry.taskType` if available, or parse from `entry.actionText` prefix

**Required:** Add `taskType: String?` field to `ProcessedActionsRegistry.RegistryEntry` (optional, backwards-compatible with existing JSON). Populate it in `AutoCodeUpdateService` when creating entries.

### 4.4 "No linked repo" hint — add navigation button

**File:** `Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`

**Problem:** Warning hint has no action. User must manually navigate to GitLab settings.

**Fix:** Replace `SettingsHint(...)` with a custom view that includes a `Button("Open GitLab Settings") { shell.section = .settings }`. Requires injecting `shell: ShellState` as `@Environment(ShellState.self)`.

### 4.5 Accessibility labels

**Files:** `SidebarView.swift`, `AutoCodeView.swift`

**Problem:** Icon-only compact-mode sidebar buttons and Auto Tasks status icons have no accessibility labels. Screen readers cannot identify them.

**Fix:**
- In `SidebarView`: Add `.accessibilityLabel(label)` to the icon-only `HStack` in compact mode (already has `.help(label)` — add matching accessibility label).
- In `AutoCodeView.statusIcon(_:)`: Add `.accessibilityLabel(...)` to each image — e.g. `.accessibilityLabel("Pending")`, `"Implementing"`, `"Done"`, `"Failed"`.
- Record/Stop buttons in `SidebarView.recordButton`: Add `.accessibilityLabel("Stop recording")` / `.accessibilityLabel("Start recording")`.

### 4.6 `ProcessedActionsRegistry` retry cap

**File:** `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift`

**Problem:** Entries stuck in `.implementing` reset to `.pending` indefinitely. A crashed CLI will retry forever.

**Fix:** Add `retryCount: Int` (default 0) to `RegistryEntry`. In `resetStuckImplementing()`, increment `retryCount`. If `retryCount >= 3`, set status to `.failed` with `actionText` prefixed with `"[max retries] "` instead of resetting to pending. This caps infinite retry loops.

---

## File Structure

**Modified files:**
- `Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — error propagation, resource fixes, capture race
- `Sources/LlmIdeMac/Models/ProcessedActionsRegistry.swift` — error closures, retry cap, `taskType` field, `retryCount` field
- `Sources/LlmIdeMac/Services/LibraryItemStore.swift` — safe URL, nil propagation
- `Sources/LlmIdeMac/Models/NoteAction.swift` — bounds checks, guarded dropFirst
- `Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — error banners, confirmation dialog, empty states, accessibility, history row
- `Sources/LlmIdeMac/Views/Shell/SidebarView.swift` — shortcut cap, accessibility labels
- `Sources/LlmIdeMac/Views/AppShell.swift` — error alert, task timeout
- `Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` — navigation button in hint
- `Sources/LlmIdeMac/LlmIdeMacApp.swift` — wire registry error closures

**No new files required** — all changes are targeted edits to existing files.
