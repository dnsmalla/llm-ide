# Auto Tasks — Live Logs, Preview/Edit Toggle, Run-Now Surfacing

## Goal

Make the Auto Tasks page feel live and unambiguous when tasks run: stream each task's CLI output into its log section line-by-line as it happens (instead of a single dump after the run), switch the per-task page between Edit and Preview via a toggle (instead of showing both stacked), and auto-follow the currently-running task during a global Run Now.

## Background (current state)

- `AutoCodeUpdateService.runCLI(prompt:)` (`mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift:1118`) writes the CLI's stdout/stderr straight to a `FileHandle` (`~/Library/Logs/LLM IDE/auto-task-<suffix>.log`). Nothing reaches the in-memory `TaskLogStore` until `appendTail` (`:258`) reads that file's tail **after the CLI exits**. So during a run the log shows at most "— run started —"; the real output appears only at the end.
- `runTaskBody` (`:207`) appends a start marker, sets `currentTask`, runs the CLI, calls `appendTail`, then a finish marker (`finishPromptTask`).
- `AutoCodeView.templateEditor` (`mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift:266`) stacks `previewSection` + `editSection` in one `ScrollView` (Preview above Edit). Structural tasks (Regression / Knowledge / Update Plan Status) have no template → render `structuralConfigSection` + an About doc.
- The orchestrator `run()` already iterates enabled tasks via `runTaskBody`, setting `currentTask` per task; each task's output already routes to its own `logStore[task]` buffer. The left pane highlights the user-selected task but does not follow `currentTask`.
- `LineAccumulator` (`mac/Sources/LlmIdeMac/Services/TaskLogStore.swift`) already splits streamed chunks into complete lines + a trailing partial — built for exactly this but unused so far.

## Locked decisions

1. **Live streaming via `Pipe` + `readabilityHandler` tee** (Approach A). Each decoded line goes to BOTH the `.log` file (permanent record) and `logStore[task]` (live). `appendTail` is removed — streaming replaces it.
2. **Edit | Preview segmented toggle**, default **Edit**. One visible at a time. Structural tasks keep the About/config view (no toggle).
3. **Auto-follow `currentTask`** during a run (`.onChange(of: currentTask)` → `selectedTask = currentTask`), so Run Now walks the page task-by-task.
4. The `.log` file, the Clear button, the per-task buffers, and the core run function are unchanged.

## Design

### 1. Live streaming in `runCLI(prompt:)`

- Add a `task: AutoTask` parameter (so the handler knows which buffer to stream into). Update the 5 call sites in `runTaskBody`.
- Replace the FileHandle-direct output block (`:1177-1190`) with a `Pipe`:
  - Open the `.log` `FileHandle` for writing as before (the tee target).
  - `let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe`.
  - `pipe.fileHandleForReading.readabilityHandler = { handle in … }`:
    - `let data = handle.availableData`; if empty → EOF → flush the accumulator's trailing partial, write it to the file, append to the store, close the file handle, clear the handler, return.
    - Else → write `data` to the file; decode UTF-8; feed through a `LineAccumulator`; for each complete line, `Task { @MainActor in logStore.append(task, line) }`.
  - **No `defer { closeFile() }`** — the handler owns the handle and closes it at EOF (a defer would race the handler's final write, as noted in the original plan).
- The `terminationHandler` + timeout watchdog that follow are unchanged — they resume the continuation on process exit; the readabilityHandler drains to EOF independently and self-clears.
- The `.log` file keeps its current name/path/rotation (`auto-task-<suffix>.log`, `rotateLog`).

### 2. `runTaskBody` + markers

- Remove `appendTail(to:suffix:logDir:)` and its 5 call sites (streaming populates the buffer live).
- Start marker becomes `logStore.append(task, "Running \(task.label)…")` (was "— run started —") so "running…" is visible the instant a task starts.
- `finishPromptTask` keeps its "— run finished —" / "— run failed —" markers.

### 3. Preview/Edit toggle (`AutoCodeView`)

- Add `@State private var editPreview: EditPreviewMode = .edit` with `enum EditPreviewMode { case edit, preview }`.
- In `templateEditor`, replace the stacked `previewSection` + `editSection` with:
  - A segmented `Picker("", selection: $editPreview) { Text("Edit").tag(...); Text("Preview").tag(...) }.pickerStyle(.segmented)` at the top of the content.
  - `if editPreview == .edit { editSection(template:) } else { previewSection(task) }`.
- For structural tasks (`templateBinding == nil`), no toggle — show `structuralConfigSection` + About as today.
- `previewSection` already reads `previewMarkdown(for:)` live (the template's current value), so Preview reflects edits the moment you switch.

### 4. Run-Now surfacing (`AutoCodeView`)

- Add `.onChange(of: autoCode.currentTask) { _, new in if let new { selectedTask = new } }` on the right-pane container (or the body). During a global Run Now, `currentTask` changes per task → the page follows. During per-task `▶ Run`, `currentTask == task` so no jump. `showModelLimits` is left untouched.

## Data flow

- **Run starts** → `runTaskBody` appends "Running X…" + sets `currentTask` → page auto-selects X → log shows "Running X…".
- **CLI produces a line** → Pipe readabilityHandler → file (permanent) + `logStore.append(task, line)` (live) → `logSection(task)` re-renders.
- **CLI exits** → handler drains to EOF, closes file → `terminationHandler` resumes → `finishPromptTask` appends done/failed marker.
- **Global Run Now** → `run()` walks enabled tasks; `currentTask` advances; the page follows each task.

## Edge cases

- **Partial line at EOF** — `LineAccumulator.flush()` returns the trailing partial; the handler writes + appends it (no lost tail).
- **CLI produces no output** — log still shows "Running X…" + the finish marker (you know it ran).
- **Skipped run (dirty tree / provider paused)** — `runCLI` returns false before launching; `finishPromptTask` appends "— run failed —" + sets `taskErrors` (the StatusBanner shows why). The "Running X…" marker still appears (the task body started).
- **Threading** — `readabilityHandler` fires on a background queue; all `logStore.append` calls hop to `@MainActor` via `Task { @MainActor in … }`.
- **Clear during run** — `logStore.clear(task)` wipes the on-screen buffer; the `.log` file and the in-flight stream are untouched; new lines keep appending.

## Testing

- `LineAccumulator` is already unit-tested (Task 1). The streaming wiring (Pipe + handler + tee) is build-verified + a manual smoke (run a prompt task, watch the log fill line-by-line) — it's subprocess orchestration, matching the existing test style which covers helpers, not `Process` plumbing.
- The toggle and the `.onChange` auto-follow are build-verified + smoke.

## Out of scope

- The issue-implementation `runCLI(issue:)` (stays on FileHandle — not one of the 8 tasks).
- Streaming the regression / knowledge / plan-status tasks (they append summary lines directly, not via the CLI pipe — already "live enough").
- Restructuring the left pane.
