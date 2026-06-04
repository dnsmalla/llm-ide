# Phase F — Regression three-pane layout

**Goal:** Replace the single-pane Regression list with a three-pane workspace:

1. **Left — Sources.** Two sections:
   - **Bug reports (N)** — every `<repo>/graphify-out/memory/bugs/*.md` listed as a row with a checkbox. Status pill on each row. User clicks the row to preview; toggles the checkbox to mark it for the next run.
   - **Repo files** — read-only recursive directory listing of the active repo (capped depth, common ignores). Click a file to preview it in the middle pane.
   - Header: a small "📂 Bugs folder" affordance that opens `bugs/` in Finder, plus the path printed below for transparency.

2. **Middle — Detail.** Shows the selected source (bug report or code file). Above the content:
   - **Run** button — runs the regression check against the currently-checked bug rows (or all fixed bugs if none checked). Becomes "Running…" + disabled while a run is active.
   - Verdict pill, if the selected bug has a known verdict from this session.

3. **Right — Log.** Newest-first stream of log lines from the most recent run: which prompt we're sending, the verdict that came back, any errors, total elapsed.

---

## Task 1: `RegressionRunner` streams log lines + accepts a filtered URL list

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/RegressionRunner.swift`
- Modify: `mac/Tests/LlmIdeMacTests/RegressionRunnerTests.swift`

- [ ] `@Published private(set) var log: [LogLine] = []` with `struct LogLine { let id = UUID(); let at: Date; let text: String; let level: Level (info|warn|error) }`.
- [ ] `run(at:)` accepts an optional `only: Set<URL>? = nil`. When non-nil, only bugs whose URL is in the set get re-asked.
- [ ] Append log lines:
  - `info` — "Run started · N fixed bugs · M selected"
  - `info` — "[i/N] asking: <prompt prefix 60 chars>"
  - `info` — "  → unchanged" / `warn` "  → REGRESSED" / `error` "  → failed: \(why)"
  - `info` — "Run complete · regressed: N · unchanged: M · failed: K · elapsed: 1.2s"
- [ ] Test: `run(at:only:)` with a one-URL set only invokes the prompter for that prompt.
- [ ] Test: after a run, `runner.log` is non-empty and the last line starts with `"Run complete"`.

## Task 2: Three-pane `RegressionView`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift`

Split the file into four `View` types in the same file so it stays navigable:

- `RegressionView` (root) — owns the runner + selection state + provides `HSplitView` body.
- `RegressionSourcesPane` — left column.
- `RegressionDetailPane` — middle column.
- `RegressionLogPane` — right column.

Shared state lives on the root:
```swift
@StateObject private var runner
@State private var selectedSource: SourceSelection?   // .bug(URL) | .file(URL)
@State private var checkedBugs: Set<URL> = []
@State private var allBugs: [URL] = []                  // all bugs/*.md, not just fixed
@State private var bugStatuses: [URL: BugStatus] = [:]  // decoded once on refresh
```

- [ ] **Left pane** — `RegressionSourcesPane`:
  - Header HStack: title "REGRESSION", "📂 Bugs folder" `Button` (calls `NSWorkspace.shared.activateFileViewerSelecting([bugsDir])`).
  - Below header: `Text(bugsDir.path).font(.system(size: 9, design: .monospaced)).foregroundStyle(textMuted)` for "where to add BugReport".
  - List with two `Section`s:
    - `Bug reports (N)` — every `.md` under `bugs/`. Each row: `Toggle("", isOn: binding)` + status pill from `bugStatuses[url]` + filename (truncate middle). Tap row body (not the toggle) → `selectedSource = .bug(url)`.
    - `Repo files` — recursive listing rooted at `activeRepoRoot`, depth-capped at 3, with an ignore list (`.git`, `graphify-out`, `node_modules`, `.build`, `DerivedData`). Expandable folders; tap file → `selectedSource = .file(url)`.

- [ ] **Middle pane** — `RegressionDetailPane`:
  - Top toolbar HStack:
    - `Button { Task { await runSelected() } } label: { Label(runner.running ? "Running…" : "Run", systemImage: "play.fill") }` — disabled when running or no repo. Tooltip: "Runs against the \(checkedBugs.count) checked bug\(s), or all fixed bugs if none checked".
    - Spacer.
    - If the selected source is a bug whose URL appears in `runner.results`: show its verdict pill (`unchanged` / `REGRESSED` / `pending` / `failed`).
  - Content:
    - `.bug(url)`: load `BugReport` via `MemoryStore`; render frontmatter as a key/value list (severity, status, reported_at, git_head, app_version, agent, tags) + horizontal rule + notes body. If user hits `View diff` on a regressed bug, open the existing `diffSheet`.
    - `.file(url)`: `ScrollView { Text(try? String(contentsOf: url)) }.monospaced` — read-only preview, capped at first 200 lines (append "… truncated" if longer).
    - Nil: a centered placeholder "Select a bug report or file on the left."

- [ ] **Right pane** — `RegressionLogPane`:
  - Header: "RUN LOG" + "Clear" `Button` (sets `runner.log = []`; protocol it via a runner method `clearLog()`).
  - `ScrollView` of `runner.log` lines, newest at bottom. Each line: `HStack { Text(time).monospaced.opacity(0.5); levelIcon(level); Text(text) }`. Auto-scroll to bottom on new entry.

- [ ] **Run dispatch:**

```swift
private func runSelected() async {
    guard let repo = activeRepoRoot else { return }
    let only = checkedBugs.isEmpty ? nil : checkedBugs
    await runner.run(at: repo, only: only)
    await refresh()
}
```

- [ ] **Refresh** populates `allBugs` and `bugStatuses` from `MemoryStore.listBugs` on `task(id: repo.path)` and after each run (so auto-reopen flips are reflected).

## Task 3: Verify

- [ ] `swift build` clean.
- [ ] All RegressionRunnerTests pass (8 → 10 after Task 1 adds the two new tests).
- [ ] Full suite: only the 2 pre-existing unrelated failures.
- [ ] Smoke:
  - Open Regression tab. Left pane lists bugs with checkboxes. Path to `bugs/` visible.
  - Click a bug row → middle pane shows frontmatter + notes.
  - Click "📂 Bugs folder" → Finder opens the directory.
  - Check two bugs → click **Run** → log streams in the right pane → verdicts appear in left rows as pills.
  - If all checkboxes are off, **Run** falls back to "all fixed bugs".

---

## Self-Review

| Requirement (user-stated) | Where addressed |
|---|---|
| File tree showing code + bug-reports | Task 2 left pane — two sections, both visible |
| Per bug-report checkbox | Task 2 left pane — `Toggle` on each row |
| Middle pane shows selected bug-report | Task 2 detail pane |
| Run button at the top of the middle pane | Task 2 middle pane toolbar |
| Third pane shows the run log | Task 2 right pane |
| "Add the path where to add BugReport" | Task 2 left pane header — Finder button + path string |
| Selection drives only-these-bugs run | Task 1 `only:` param + Task 2 `runSelected()` |

No spec gap.
