# Per-Project Workspaces — Design

**Status:** approved 2026-05-25
**Owner:** Dinesh
**Phase:** 1 (this spec) → Phase 2 (sketched, separate spec when scheduled)

## Why

Today Meet Notes is configured globally: one notes folder, one set of linked
repos, one active CLI, one set of plugins enabled. A user with three side
projects has to switch the GitLab "active" flag, swap notes folder, possibly
re-enable a different plugin — every time they context-switch.

The intent is Cursor-style isolation: open folder X → app is in "project X
mode" with X's settings, repo, memory, agent context. Open folder Y → app
switches to Y's bundle. Multiple projects coexist with separate persisted
state.

The user's words: *"manage each project separate way so each project can
control consistent way. when we open project each need to have current
setting and control so we can work separately many project."*

## Core concept

A **Project** is a (folder, settings-bundle) pair. The app tracks a list of
projects; one is *active* at any time. Every existing feature that today
consults `AppConfig` for a project-scoped setting will instead consult the
active Project's bundle.

Two storage locations:

| Location | Contents | Rationale |
|---|---|---|
| `<projectFolder>/.meetnotes/project.json` | identity + bundle (see schema below) | Travels with the folder. User can git-track it. Move folder → settings move with it. |
| `~/Library/Application Support/MeetNotes/projects.json` | recent-projects list, active id, app-wide migration state | App-wide bookkeeping. Survives folder moves. |

## Data shapes

### `project.json` (per-folder)

```json
{
  "schemaVersion": 1,
  "id": "01HBYZ...",                     // ULID-like, stable
  "displayName": "Meet Notes Mac",
  "createdAt": "2026-05-25T11:00:00Z",
  "settings": {
    "language": "en",
    "activeCLI": "claudeCode",            // or "ghCopilot", "cursor", etc.
    "linkedRepo": {
      "kind": "github",                   // or "gitlab"
      "url": "https://github.com/owner/name",
      "remoteId": "owner/name",           // numeric for GitLab, owner/name for GitHub
      "defaultBranch": "main"
    },
    "notesFolderRelative": "Meetings",    // relative to projectFolder; null = use app default
    "plugins": {
      "enabled": ["sample-summarizer"]
    },
    "graphifyBinaryOverride": "",
    "regressionLookbackCount": 5,
    "agentPersona": null,                 // overrides app default when set
    "docTemplatesActive": []
  }
}
```

ID is stable across renames — used in `projects.json` and never derived from
the folder path. The folder path is authoritative for "where the project
lives"; the id is authoritative for "which project this is in the recents
list". A folder move updates the path in `projects.json` but the id stays.

### `projects.json` (per-user)

```json
{
  "schemaVersion": 1,
  "activeId": "01HBYZ...",                // null = Welcome screen
  "recents": [
    { "id": "01HBYZ...", "path": "/Users/.../meet-notes", "lastOpenedAt": "2026-05-25T11:00:00Z" },
    { "id": "01HBZ0...", "path": "/Users/.../other-proj", "lastOpenedAt": "2026-05-24T16:30:00Z" }
  ],
  "migrationCompleted": false              // see Migration section
}
```

Atomic writes (tmp file + rename), same as `plugin-state.json`.

## What's global vs per-project

**Stays in `AppConfig` (global):**
- `serverURL`, `themeID`, account/session, `autoCaptureOnMeeting`, `pollIntervalMs`, `bodyLimitMB`
- The user-level plugin enable state (kept; per-project override layers on top — see Phase 2)

**Moves to `Project.settings`:**
- `activeCLI`, `language`
- Linked repo (replaces the active-flag-on-saved-projects scheme)
- Notes folder location (relative to project root by default)
- Graphify binary override
- Regression lookback count
- Agent persona
- Doc templates active

`AppConfig` retains these fields for backward compat but stops being read by
project-scoped call sites once Phase 1 lands. They become "defaults inherited
when creating a new Project."

## UI surface

### 1. Welcome screen (when `activeId == null`)

Shown at app launch when no project is active OR after the user explicitly
closes the active project. Contains:

- Big "Open Folder…" button (`NSOpenPanel` directory chooser)
- Recent projects list — name + path + last-opened-at + open/remove actions
- "Import from legacy" affordance (only visible if `migrationCompleted == false`
  and there's importable data)

This replaces the existing app-launch behavior where the sidebar shows
"Library" with no project context.

### 2. Sidebar header — project chip

Above the existing sidebar sections, a chip showing the current project name.
Tap → dropdown:
- Switch to <project A>, <project B>, … (top N recents)
- Open another folder…
- Reveal in Finder
- Close project (→ Welcome screen)

### 3. Settings re-bucketing

Existing Settings sections split into two top-level groups:

- **App** (always shown): Account, Server, Appearance, Capture, Sidebar
  visibility, About
- **Project** (only when active): Paths (notes folder), GitHub/GitLab linked
  repo, CLI, Preferences (language), Generate Plan defaults, Agent persona,
  Auto-code, Graphify binary, Regression, Plugins enabled, Doc templates

When no project is active the Project group is hidden (Welcome screen shows
instead of Settings anyway).

### 4. Status bar

Existing menu-bar pill stays as-is. Add a bottom status bar inside the main
window showing:
- Project name + abbreviated path
- Linked-repo badge (GitHub/GitLab icon + repo name)
- Open-bug count for this project (already computed)
- Last regression run badge

### 5. Cmd-P quick switcher

Cmd-P opens a HUD overlay listing recent projects with type-to-filter. Enter
switches. Esc cancels. (Reuses the same data as the sidebar dropdown.)

## Behavior

### Opening a folder

1. User picks folder via `NSOpenPanel` or recent-list click.
2. If `<folder>/.meetnotes/project.json` exists: load it. Validate schema
   version; refuse-and-show-error if newer than what we understand.
3. If missing: create defaults inherited from `AppConfig` (today's "global"
   values become this new project's defaults). Show a one-time "Set up" sheet
   asking the user to pick linked repo + confirm CLI/language. User can skip
   and use defaults.
4. Set `activeId` in `projects.json`. Update recents.
5. Trigger background:
   - Graphify install/update (existing flow, scoped to this folder)
   - KB connect-git for indexing
   - Memory load into agent context
6. UI swaps to project mode — every sidebar tab refreshes from the new context.

### Switching projects

1. Persist any in-flight unsaved state for the leaving project.
2. Update `activeId` + lastOpenedAt for the entering project.
3. Re-bind `@EnvironmentObject` for the project context.
4. Each visible panel observes the change and refetches.

No window destruction — same NSWindow, just a context swap. (Phase 2 may
introduce per-window projects.)

### Closing a project

1. `activeId = null`.
2. Show Welcome screen.
3. Don't unload the project from memory immediately — keep its last state
   warm for ~5 minutes in case the user re-opens.

### Where chat history, plans, etc. live

Server-side data already keyed by `userId`. Phase 1 adds `projectId` as an
optional scope filter on these queries — when active, results are narrowed to
the active project. Server doesn't need to know about projects directly; the
Mac client passes `projectId` along with each request and the server stores it
in the existing `meta` JSON column. No migration needed for existing rows
(they're seen as "unscoped" and shown only when no project is active OR via a
"show legacy" toggle in Library).

This is a deliberate tradeoff: tightly-coupled would mean a `project_id` FK on
every server table, but that's a destructive schema change. The meta-tag
approach is reversible.

## Migration of existing data

`migrationCompleted` flag in `projects.json` gates a one-time pass:

1. Enumerate `config.gitLabSavedProjects` and `config.gitHubSavedRepos`.
2. For each entry with a non-empty `localPath` AND `isActive`, create a
   Project at that path (writes `.meetnotes/project.json` with settings
   inherited from current `AppConfig`).
3. The most-recently-active becomes the new `activeId`.
4. Set `migrationCompleted = true`.
5. Leave the old `SavedGitLabProject` / `SavedGitHubRepo` arrays intact —
   they become read-only legacy data, surfaced in Settings → App → "Legacy
   linked projects" for users to prune manually.

If a user has zero saved-projects-with-localPath, migration is a no-op and
they see Welcome on first launch.

## Component breakdown

New files:

| File | Purpose |
|---|---|
| `Sources/MeetNotesMac/Models/Project.swift` | Codable `Project` struct + `ProjectSettings` |
| `Sources/MeetNotesMac/Services/ProjectStore.swift` | `@MainActor`, owns recents + active, reads/writes both JSON files atomically, posts `Notification.Name.activeProjectChanged` |
| `Sources/MeetNotesMac/Services/ProjectMigrator.swift` | One-shot migration from legacy saved-projects |
| `Sources/MeetNotesMac/Views/Welcome/WelcomeView.swift` | First-launch + no-active screen |
| `Sources/MeetNotesMac/Views/Welcome/RecentProjectsList.swift` | Reusable list (also used in Cmd-P) |
| `Sources/MeetNotesMac/Views/Shell/ProjectSwitcher.swift` | Sidebar dropdown |
| `Sources/MeetNotesMac/Views/Shell/QuickSwitcherSheet.swift` | Cmd-P HUD |
| `Sources/MeetNotesMac/Views/Shell/StatusBar.swift` | Bottom status bar |

Touched files (boundaries shift, not full rewrite):

| File | Change |
|---|---|
| `Models/Config.swift` | Move project-scoped @Published fields into a `defaultProjectSettings` substruct (kept as inheritance template) |
| `Views/SettingsView.swift` | Split into App vs Project section bins |
| `Views/AppShell.swift` | Mount Welcome when active is nil; otherwise existing shell |
| `Views/CodeAssistantPanel.swift` | `buildAgentContext` reads from active project, not `config.gitLabSavedProjects` |
| `Services/AutoCodeUpdateService.swift` | `resolveBackendAndProject` reads active project |
| `MeetNotesMacApp.swift` | Inject `ProjectStore` into environment; wire keyboard shortcut for Cmd-P |

## Error handling

| Failure | Behavior |
|---|---|
| `project.json` corrupt | Archive as `.corrupt.<unix>.json`; offer to reinitialize from defaults (same pattern as `ProcessedActionsRegistry`) |
| `project.json` schema version newer than client supports | Refuse to load; show "Update Meet Notes to open this project." message |
| Folder no longer exists when user clicks recent | Mark recent as `unreachable: true`; offer "Remove from recents" |
| Folder permission denied | Surface NSError to status bar; allow re-pick |
| `projects.json` corrupt | Same archive pattern as `project.json` |
| Concurrent Open Folder during in-flight switch | Queue the second one; UI shows spinner until first settles |

## Testing strategy

Unit tests for:
- `Project` codable round-trip including unknown-future-field tolerance
- `ProjectStore` recents pruning (cap at 20, sort by lastOpenedAt)
- `ProjectMigrator` happy path + empty input + already-completed idempotency
- Project schema version refusal
- Atomic write recovery (tmp file orphaned after crash → write cleans it)

Integration scenarios (manual smoke list):
1. Fresh install → Welcome → Open Folder → see project mode
2. Two projects, switch between them, settings differ correctly
3. Quit app, relaunch → resumes active project
4. Delete folder of active project → next launch falls back to Welcome with a warning
5. Migration from legacy: 3 saved repos → 3 imported projects, active = most-recent
6. Cmd-P opens HUD; filter narrows; Enter switches; Esc cancels
7. Settings panel: App section persists across projects, Project section is per-project

## Out of scope for Phase 1

Listed here so reviewers don't expect them:

- Multi-window (one project per window)
- Per-project plugin enable set (currently per-user only)
- Per-project regression baselines stored in `<project>/.meetnotes/regression/`.
  Phase 1 keeps the current location (`<project>/graphify-out/memory/bugs/`),
  which is already effectively per-project since the path is repo-relative —
  no functional change for Phase 1. Phase 2 standardizes the path.
- File-tree explorer / text editor / diff view / terminal — explicitly NOT
  building a Cursor editor; user agreed
- Project-aware FTS sharding (server keeps single FTS index; project filter is
  applied at hydration via `meta.projectId`)
- Workspace-trust prompt (Cursor's "do you trust this folder") — defer

## Estimated work

| Section | Files | Rough effort |
|---|---|---|
| Models + Store + on-disk schema | 3 new | 1 day |
| Migration | 1 new | 0.5 day |
| Welcome view + recents list | 2 new | 0.5 day |
| Sidebar project chip + dropdown | 1 new + 1 edit | 0.5 day |
| Settings split | 1 edit | 1 day (touches many sections) |
| Wire CodeAssistantPanel + AutoCodeUpdateService | 2 edits | 0.5 day |
| Cmd-P quick switcher | 1 new | 0.5 day |
| Status bar | 1 new + 1 edit | 0.5 day |
| Tests | new suite | 1 day |
| Server `projectId` meta plumbing | minor edits to ingest + search hydration | 1 day |
| Polish, bug bash, docs | — | 1 day |
| **Total** | ~13 new/edited files | **~1 week** |

## Open questions parked for later

These don't block Phase 1 but are worth tracking:

1. When the user opens a folder that's a SUBDIRECTORY of an existing project,
   should we auto-detect and open the parent? Default: no, treat as new
   project — explicit > magic.
2. Should plugins have per-project enable in addition to per-user, or is
   per-user fine? Defer to Phase 2.
3. Workspace-trust prompt on first open (defer).
4. iCloud sync of `project.json` if user enables it (defer).
