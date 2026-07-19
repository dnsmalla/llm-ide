# Auto Tasks — Live Logs, Preview/Edit Toggle, Run-Now Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Auto Tasks live: stream each task's CLI output into its log section line-by-line as it runs, replace the stacked Preview+Edit with an Edit|Preview toggle, and auto-follow the running task during a global Run Now.

**Architecture:** `runCLI(prompt:)` switches from writing stdout/stderr straight to a file handle, to a `Pipe` whose `readabilityHandler` tees each decoded line (via the existing `LineAccumulator`) to BOTH the `.log` file and `logStore[task]` — so logs fill in real time and `appendTail` is removed. The per-task page gains a segmented Edit|Preview toggle, and the body observes `currentTask` to auto-select the running task during Run Now.

**Tech Stack:** Swift 6 / SwiftUI / swift-testing. macOS app target `mac/`. `LineAccumulator` (already in `mac/Sources/LlmIdeMac/Services/TaskLogStore.swift`) is the line-splitting helper.

## Global Constraints

- **No new dependencies.** Reuse `LineAccumulator`, `TaskLogStore`, existing `runCLI` machinery.
- **Verify with `swift build` / `swift test`, not SourceKit alone** (SourceKit produces stale errors in this project).
- **Build/test commands:** `cd mac && swift build` and `cd mac && swift test`. Pre-warm before pushing (pre-push hook runs both).
- **No new unit tests for `runCLI`/view orchestration** — this codebase unit-tests pure helpers only (`LineAccumulator` is already covered; `TaskLogStoreTests` passes). Subprocess orchestration (`runCLI`) and SwiftUI (`AutoCodeView`) are verified via `swift build` + the manual smoke, matching the prior auto-task redesign's precedent. Do NOT fabricate a Process-based unit test.
- **The `.log` file stays the permanent record** (`~/Library/Logs/LLM IDE/auto-task-<suffix>.log`, with `rotateLog`). The live buffer is the on-screen view; the file is the tee target.
- **Do NOT touch `runCLI(issue:)`** — it stays on the FileHandle (issue runs aren't one of the 8 tasks).
- **Conventional Commits, one concern per commit.** Suggested branch: `feat/auto-task-live-logs` (from `main`).

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` | `runCLI(prompt:)` Pipe+tee streaming (add `task:` param); `runTaskBody` passes `task:`, drops `appendTail`, start marker "Running X…"; delete `appendTail`. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` | Edit|Preview segmented toggle (default Edit); `.onChange(of: currentTask)` auto-follows the running task. | **Modify** |

---

### Task 1: Live-stream task output into the log (Pipe + tee)

Switch `runCLI(prompt:)` from FileHandle-direct output to a `Pipe` whose `readabilityHandler` tees each line to the `.log` file AND `logStore[task]`. Drop `appendTail` (streaming replaces it). Make the start marker read "Running X…".

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — `runCLI(prompt:)` (`:1118-1245`, esp. the FileHandle block `:1177-1190`), `runTaskBody` (`:207-252`), delete `appendTail` (`:258-263`).

**Interfaces:**
- Consumes: `LineAccumulator` (`TaskLogStore.swift` — `mutating feed(_ chunk:) -> [String]`, `mutating flush() -> String?`); `logStore: TaskLogStore` (service property); `AutoTask` enum.
- Produces: `runCLI(prompt:localPath:logSuffix:logDir:task:) async -> Bool` (new `task:` param).

- [ ] **Step 1: Add the `task:` parameter to `runCLI(prompt:)`**

At `AutoCodeUpdateService.swift:1118`, change the signature:

```swift
    private func runCLI(prompt: String, localPath: String, logSuffix: String, logDir: URL,
                        task: AutoTask) async -> Bool {
```

- [ ] **Step 2: Replace the FileHandle-direct output block with the Pipe tee**

Replace the block at lines `:1177-1190` (the `let logFileHandle: FileHandle?` … `process.standardInput = FileHandle.nullDevice` block) with:

```swift
        // Stream stdout+stderr LIVE: tee each decoded line to the log file
        // AND append it to the task's in-memory buffer so the Auto Task page
        // shows output as it happens (not only the post-run tail). The file
        // handle is owned by the readabilityHandler and closed at EOF — there
        // is no `defer` close, which would race the handler's final write.
        let logFileHandle: FileHandle?
        do {
            logFileHandle = try FileHandle(forWritingTo: logURL)
        } catch {
            log.error("Failed to open auto-task log file \(logURL.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            logFileHandle = nil
        }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        let store = logStore
        var accumulator = LineAccumulator()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            // availableData is empty ONLY at EOF (Apple contract).
            if data.isEmpty {
                handle.readabilityHandler = nil
                if let rest = accumulator.flush() {
                    logFileHandle?.write((rest + "\n").data(using: .utf8) ?? Data())
                    let captured = rest
                    Task { @MainActor in store.append(task, captured) }
                }
                logFileHandle?.closeFile()
                return
            }
            logFileHandle?.write(data)
            guard let chunk = String(data: data, encoding: .utf8) else { return }
            for line in accumulator.feed(chunk) {
                let captured = line
                Task { @MainActor in store.append(task, captured) }
            }
        }
        // Detach stdin so a stray permission prompt can never hang the run.
        process.standardInput = FileHandle.nullDevice
```

Leave the `withCheckedContinuation` / `terminationHandler` / `try process.run()` / timeout watchdog (`:1196-1233`) and the `activeProcess = nil` / discard / `recordRun` / `return result` (`:1235-1244`) **unchanged** — the readabilityHandler drains to EOF independently and self-clears; the terminationHandler still resumes the continuation on exit.

- [ ] **Step 3: Update the 5 call sites in `runTaskBody` + drop `appendTail`**

In `runTaskBody` (`:207-252`), each of the 5 prompt cases calls `runCLI(prompt:…)` then `appendTail(to:suffix:logDir:)`. For each case: add `task: task` to the `runCLI` call and **delete** the `appendTail(...)` line. Example for `.reviewCode` (the other four follow the identical pattern with their own prompt + suffix):

```swift
        case .reviewCode:
            currentStep = "Running Review Code"
            let ok = await runCLI(prompt: config.autoTaskTemplateReviewCode,
                                  localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                  logDir: logDir, task: task)
            finishPromptTask(task, ok: ok)
```

Apply the same to `.reviewDoc`, `.reviewConflicts`, `.generateDoc`, `.updateIssues` — add `task: task`, remove the `appendTail(to: task, suffix: task.logSuffix, logDir: logDir)` line after each. The 3 structural cases (`.regression`, `.generateKnowledge`, `.updatePlanStatus`) are unchanged.

- [ ] **Step 4: Delete the `appendTail` method**

Delete the whole method (`:258-263`):

```swift
    private func appendTail(to task: AutoTask, suffix: String, logDir: URL) {
        let tail = logTail(suffix: suffix, logDir: logDir)
        tail.split(separator: "\n", omittingEmptySubsequences: true).forEach {
            logStore.append(task, String($0))
        }
    }
```

(Leave `logTail(suffix:logDir:maxChars:)` — it's still used by `cliLogTail` for the code-workflow sheets.)

- [ ] **Step 5: Make the start marker read "Running X…"**

In `runTaskBody` (`:208`), change:

```swift
        logStore.append(task, "— run started —")
```

to:

```swift
        logStore.append(task, "Running \(task.label)…")
```

- [ ] **Step 6: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean. (`runCLI(issue:)` is untouched — only `runCLI(prompt:)` and `runTaskBody` changed.)

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `cd mac && swift test`
Expected: PASS — the existing suite (incl. `TaskLogStoreTests` / `LineAccumulator`) stays green. No new test (subprocess orchestration; see Global Constraints).

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
git commit -m "feat(auto-task): stream prompt-task CLI output live into TaskLogStore"
```

---

### Task 2: Edit | Preview toggle (replace stacked layout)

Replace the stacked `previewSection` + `editSection` with a segmented toggle so one is visible at a time (default Edit). Structural tasks (no template) keep the About/config view with no toggle.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — `templateEditor` content (`:301-312`), plus a new `@State` + enum near the other state (`:12-15`).

**Interfaces:**
- Consumes: `previewSection(_:)`, `editSection(template:)`, `structuralConfigSection(_:)`, `task.templateBinding(config:)` (all already defined in this file).

- [ ] **Step 1: Add the toggle state + mode enum**

Near the other `@State` declarations (around `:12-15`, next to `selectedTask`/`taskToReset`), add:

```swift
    private enum EditPreviewMode { case edit, preview }
    /// Which pane the per-task page shows for prompt tasks. Default Edit.
    @State private var editPreview: EditPreviewMode = .edit
```

- [ ] **Step 2: Replace the stacked Preview+Edit with the toggle**

In `templateEditor`, replace the `ScrollView` content block (`:302-312`):

```swift
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    previewSection(task)
                    if let template = task.templateBinding(config: config) {
                        editSection(template: template)
                    } else {
                        structuralConfigSection(task)
                    }
                }
                .padding(20)
            }
```

with:

```swift
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let template = task.templateBinding(config: config) {
                        Picker("", selection: $editPreview) {
                            Text("Edit").tag(EditPreviewMode.edit)
                            Text("Preview").tag(EditPreviewMode.preview)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        if editPreview == .edit {
                            editSection(template: template)
                        } else {
                            previewSection(task)
                        }
                    } else {
                        structuralConfigSection(task)
                    }
                }
                .padding(20)
            }
```

(`previewSection` reads `previewMarkdown(for:)` live — the template's current value — so switching to Preview reflects any edits immediately.)

- [ ] **Step 3: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat(auto-task): Edit|Preview toggle on the task page"
```

---

### Task 3: Auto-follow the running task during Run Now

When a global Run Now walks the enabled tasks, the right pane should auto-select whichever task is currently running so the user watches each log fill.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — the `body`'s `HStack`/`.background` (`:17-28`).

**Interfaces:**
- Consumes: `autoCode.currentTask: AutoTask?` (already `@Published`), `selectedTask`, `showModelLimits` (existing `@State`).

- [ ] **Step 1: Add `.onChange(of: currentTask)` to the body**

In `body` (`:17-28`), the `HStack { … }.background(theme.current.body)` — append `.onChange` after `.background`:

```swift
        .background(theme.current.body)
        .onChange(of: autoCode.currentTask) { _, new in
            // During a global Run Now the orchestrator advances currentTask
            // task-by-task; follow it so the user watches each log fill.
            // Per-task ▶ Run leaves currentTask == the viewed task (no jump).
            if let new {
                selectedTask = new
                showModelLimits = false
            }
        }
```

- [ ] **Step 2: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean. (`AutoTask` is a `String` enum → `Equatable`; `Optional<AutoTask>` is `Equatable`, so `.onChange` compiles.)

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat(auto-task): auto-follow the running task during Run Now"
```

---

### Task 4: Full verification + smoke notes

**Files:** none (verification only).

- [ ] **Step 1: Clean build + full test**

Run: `cd mac && swift build && swift test`
Expected: builds clean; full suite passes (incl. `TaskLogStoreTests`).

- [ ] **Step 2: Confirm `appendTail` is gone and `logTail` is retained**

Run:
```bash
cd mac && grep -n "appendTail" Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift || echo "appendTail removed ✓"
cd mac && grep -n "func logTail\|cliLogTail" Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
```
Expected: "appendTail removed ✓"; `logTail` + `cliLogTail` still present.

- [ ] **Step 3: Manual smoke (run the app)**

Build via the project's build script (per project memory, the raw `.build` binary won't run the auto-updater — use `build_app.sh`):

```bash
cd mac && ./build_app.sh && open mac/LlmIdeMac.app   # confirm exact path from build_app.sh
```

Then verify:
- Open a **prompt task** (e.g. Review Code). The page shows an **Edit | Preview** segmented toggle, default Edit; switching to Preview renders the template markdown live.
- Click **▶ Run** → the log section shows "**Running Review Code…**" immediately, then the CLI output streams in **line-by-line** as it runs (not a single dump at the end), then a "— run finished —" / "— run failed —" marker.
- Click **Run Now** in the left pane (global run) → the right pane **auto-follows** each enabled task as it runs; each task's log fills its own section.
- Clear button still wipes only the on-screen buffer; the `.log` file in `~/Library/Logs/LLM IDE/` keeps the full record.
- Structural tasks (Regression / Knowledge / Update Plan Status) show the About/config view with **no** Edit|Preview toggle.

- [ ] **Step 4: Commit smoke-fixes (if any), then ask before pushing**

```bash
git add -A
git commit -m "test(auto-task): verification fixes"   # only if needed
```

Pre-warm the build before pushing — the pre-push hook runs `swift build` + `swift test`. Push only after the user confirms.

---

## Self-Review notes

- **Spec coverage:** Task 1 = live streaming (`runCLI` Pipe+tee, `task:` param, remove `appendTail`, "Running X…" marker). Task 2 = Edit|Preview toggle (default Edit; structural tasks no toggle). Task 3 = Run-Now auto-follow (`.onChange(of: currentTask)`). Task 4 = verify + smoke. Every spec section maps to a task.
- **Type consistency:** `runCLI(prompt:localPath:logSuffix:logDir:task:)` signature matches across Task 1's definition and call sites. `EditPreviewMode` enum + `editPreview` state defined once (Task 2 Step 1) and used in Task 2 Step 2. `LineAccumulator.feed`/`flush` match the Task 1 handler code.
- **Why build-verified not TDD:** `runCLI` is `Process` orchestration; the toggle + `onChange` are SwiftUI — the codebase unit-tests pure helpers only (`LineAccumulator` already covered). Matches the prior auto-task redesign's stated precedent.
- **Known follow-up (out of scope):** streaming the 3 structural tasks (they append summary lines directly, not via the CLI pipe — already live enough); `runCLI(issue:)` stays on FileHandle.
