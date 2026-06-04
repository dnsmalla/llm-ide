# Auto Code Update — Design Spec

**Date:** 2026-05-15  
**Status:** Approved  
**Scope:** macOS app (`llm-ide/mac`)

---

## Goal

When enabled, the app automatically scans recent meeting notes every hour, creates GitLab issues for any `## Actions` items not yet tracked, then invokes the selected CLI tool (Claude Code, Cursor, etc.) as a subprocess to implement each issue in the linked repo. On completion it posts a comment and closes the issue. Already-handled actions are never re-processed.

---

## Components

### 1. `AutoCodeUpdateService`

New `@MainActor final class` that mirrors `AutoCaptureService`. Lives in `LlmIdeMacApp`, injected via `@EnvironmentObject`.

**Responsibilities:**
- Owns a `Timer` firing every 3600 s (1 hour)
- Calls `run()` on each tick and on manual "Run Now"
- Exposes `@Published` state for Settings UI: `isEnabled`, `isRunning`, `lastRunDate`, `statusMessage`, `stats` (counts of created/implemented/failed)

**Dependencies:** `AppConfig`, `MeetingIndex`, `AppEnvironment` (for notes folder path), `GitLabClient`, `ProcessedActionsRegistry`

---

### 2. `NoteActionExtractor`

Stateless struct. Given a list of `MeetingIndex.Row` entries and the notes folder URL, reads each `.md` file and returns `[NoteAction]`.

```swift
struct NoteAction: Identifiable {
    let id: String          // SHA256 of normalized text — stable across runs
    let text: String        // raw bullet text (stripped of leading "- ")
    let meetingId: String
    let meetingTitle: String
}
```

Parses only the `## Actions` section (same logic as `FolderIndexer.countListItems`). Skips empty or whitespace-only bullets.

---

### 3. `ProcessedActionsRegistry`

Persists to `~/Library/Application Support/LLM IDE/processed-actions.json`.

```swift
struct RegistryEntry: Codable {
    let actionId: String
    let actionText: String
    var issueIid: Int?
    var status: Status          // pending | implementing | done | failed
    var retryCount: Int
    var processedAt: Date
    var lastUpdated: Date
}

enum Status: String, Codable {
    case pending, implementing, done, failed
}
```

**Operations:** `isKnown(id:)`, `register(action:issueIid:)`, `markImplementing(id:)`, `markDone(id:)`, `markFailed(id:)`, `pendingEntries() → [RegistryEntry]`

On `AutoCodeUpdateService.start()`, any entries in `implementing` state are reset to `pending` — they were in-flight when the app last quit and need to be retried.

---

### 4. `AutoCodeSettingsSection`

New `View` added to `SettingsView` after `AgentSettingsSection`. Uses `SettingsSectionCard`.

```
┌─ Auto Code Update ──────────────────────────────────────┐
│  Toggle: [●] Enabled                                     │
│  Scan last: [5 ▾] meetings                               │
│                                                          │
│  Status: Last run 14 min ago · 2 issues created          │
│          1 implemented · 0 failed                        │
│                                                          │
│  [ Run Now ]                                             │
└──────────────────────────────────────────────────────────┘
```

Shows a warning hint (not a hard disable) when no active+cloned GitLab project is configured.

---

### 5. `AppConfig` additions

```swift
@Published var autoCodeUpdateEnabled: Bool        // default: false
@Published var autoCodeUpdateLookbackCount: Int   // default: 5
```

Both persisted to `UserDefaults`.

---

## Data Flow

```
Timer (1 hr) → AutoCodeUpdateService.run()
  │
  ├─ 1. MeetingIndex.list() → take last N by startedAt
  │       NoteActionExtractor.extract() → [NoteAction]
  │
  ├─ 2. ProcessedActionsRegistry.isKnown() → filter to new actions only
  │
  ├─ 3. GitLabClient.fetchAllIssues() → normalize titles
  │       exact match after normalize() → register as "done", skip
  │       no match → GitLabClient.createIssue() → register as "pending"
  │
  ├─ 4. ProcessedActionsRegistry.pendingEntries()
  │       for each pending entry:
  │         write prompt to temp file
  │         spawn CLI subprocess (see CLI Invocation below)
  │         mark "implementing"
  │         await exit (timeout: 10 min)
  │         exit 0 → createNote(comment) + updateIssue(state: closed) → markDone
  │         exit ≠0 or timeout → markFailed (retry max 3×)
  │
  └─ 5. Update lastRunDate + statusMessage
```

---

## Action State Machine

```
[new, not in registry]
        │
        ▼
    PENDING ──── subprocess starts ──→ IMPLEMENTING
                                              │
                         ┌────────────────────┤
                         ▼                    ▼
                       DONE               FAILED
                 (issue closed,       (retried up to
                  comment posted)      3×, then logged)
```

---

## Duplicate Detection

Normalize function: lowercase → strip punctuation → collapse whitespace → trim.

Compare each `NoteAction.text` (normalized) against every existing GitLab issue title (normalized). Exact string equality after normalization = duplicate. No fuzzy matching — avoids false positives on similar but distinct tasks.

---

## CLI Invocation

```swift
// Working directory: project.localPath
// Command: <cli-binary> -p "<prompt>"
let prompt = """
Implement the following task in the git repository at \(localPath).
GitLab issue #\(iid): \(title)
\(description)
Create a branch named fix/\(iid)-<slug>, make the changes, commit, and push.
"""
```

CLI binary resolved from `AICliTool` (same as `CLISettingsSection`):
- Claude Code → `claude`
- Cursor → `cursor`  
- Gemini CLI → `gemini`
- GitHub Copilot → `gh copilot`

Subprocess runs with `Process`, stdout/stderr captured to log file at `~/Library/Logs/LLM IDE/auto-code-<iid>.log`.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| No active + cloned GitLab project | Skip run, status: "No linked repo — configure in GitLab settings" |
| `## Actions` empty across all scanned notes | No-op, status: "No actions found in last N meetings" |
| GitLab API error | Log, mark run failed, retry next hour |
| CLI subprocess exit ≠ 0 | Mark `failed`, retry next run (max 3×) |
| CLI timeout > 10 min | Kill process, mark `failed` |
| Issue already exists (normalized match) | Register as `done`, never re-create |

---

## Out of Scope

- Branch creation or MR opening — the CLI subprocess handles all git work
- Guardrail review UI — CLI's own safety layer applies
- Multi-project support — uses single active + cloned project only
- Scheduling outside of app-open hours — timer only runs while app is running

---

## Files to Create / Modify

| File | Change |
|---|---|
| `Services/AutoCodeUpdateService.swift` | **New** — background service, timer, run loop |
| `Models/NoteAction.swift` | **New** — `NoteAction` struct + `NoteActionExtractor` |
| `Models/ProcessedActionsRegistry.swift` | **New** — JSON-backed registry |
| `Views/Settings/AutoCodeSettingsSection.swift` | **New** — settings UI |
| `Models/Config.swift` | Add `autoCodeUpdateEnabled`, `autoCodeUpdateLookbackCount` |
| `Views/SettingsView.swift` | Add `AutoCodeSettingsSection` |
| `LlmIdeMacApp.swift` | Instantiate + inject `AutoCodeUpdateService` |
