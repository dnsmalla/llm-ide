# GitHub Issue Board + Gantt Parity

**Date:** 2026-06-27
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/github-issue-board-gantt-parity`

## Problem

The Mac app gives GitLab repos a rich **issue board** (kanban) and **gantt**, but
GitHub repos effectively have neither:

1. **Reachability.** `AppShell.issuesRoute` / `ganttRoute` pick a view by *which
   token is configured, GitLab-first* (`mac/.../Views/AppShell.swift:464,480`).
   Any user with a GitLab token never reaches the GitHub views, even when working
   in a GitHub repo.
2. **Data richness.** Even when reached, GitHub's views are weak:
   - `RepoIssuesView` is a **flat list**, not a kanban board
     (`Views/Issues/RepoIssuesView.swift:347`).
   - GitHub issues carry **no due date, start date, estimate, or dependencies**,
     so `RepoGanttView` can only draw coarse milestone bars — no real scheduling.

GitLab encodes board status in **scoped labels** (`status::value`) and scheduling
in native fields (`dueDate`, milestone `startDate`, `weight`). GitHub has neither
concept natively.

## Goal

**Consistency.** GitHub's board and gantt should look and behave like GitLab's,
with our own system supplying whatever GitHub lacks. One board UI and one gantt
UI serve both providers through the existing `RepoBackend` abstraction.

Non-goal: replacing GitHub Issues with an in-app tracker. Issues stay in GitHub;
we only add the board-status and scheduling layers GitHub is missing.

## Architecture

### Principle: one board + one gantt, both providers behind `RepoBackend`

The board and gantt become single backend-agnostic components. Each provider
plugs in through `RepoBackend`, which grows two capabilities. Where a provider
can't supply data natively, our backend overlay fills the gap. The GitLab-only
`IssueBoardView` / `GanttContainerView` may remain as-is initially; the new
shared components reach parity and become the path GitHub (and, later, GitLab)
flows through.

### Capability A — Board status (drives kanban columns)

Consistency model, identical to GitLab today: **"columns come from labels; drag
rewrites a label."**

- **GitLab:** scoped labels `status::value`. Existing `IssueKanbanPanel` column
  logic (`Views/Issues/IssueKanbanPanel.swift:39`) is lifted into the shared
  board component unchanged.
- **GitHub:** flat-label convention `status:value` (no scoped labels exist).
  Status labels are auto-created on first use; drag-to-move rewrites the label
  via the GitHub API. Fallback when no `status:` labels: Open / Closed columns
  (mirrors GitLab's fallback).

Board state therefore lives in each provider's own labels — portable and visible
on the provider's web UI — and the column model is identical across providers.

### Capability B — Scheduling (drives the gantt bars)

Per-issue `startDate`, `dueDate`, `estimateDays`, `dependsOn` (issue numbers).

- **GitLab:** native `dueDate`, milestone `startDate`, `weight` (existing).
- **GitHub:** a per-user **backend overlay**, keyed by `(provider, repo, issue
  number)`. The overlay is the only place GitHub scheduling lives; it is editable
  in-app and rendered into bars identically to GitLab.

## Components

### 1. Backend (extension, Node + SQLite)

**Migration:** new table `issue_schedule`:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `genId('isch')` |
| `user_id` | TEXT NOT NULL | FK `users(id)` ON DELETE CASCADE — tenancy |
| `provider` | TEXT NOT NULL | `'github'` (kept generic for future providers) |
| `repo` | TEXT NOT NULL | `owner/name` |
| `issue_number` | INTEGER NOT NULL | provider issue number |
| `start_date` | TEXT | `YYYY-MM-DD` or null |
| `due_date` | TEXT | `YYYY-MM-DD` or null |
| `estimate_days` | REAL | ≥ 0 or null |
| `depends_on` | TEXT (JSON) | array of issue numbers, default `[]` |
| `updated_at` | TEXT | ISO 8601 |

`UNIQUE(user_id, provider, repo, issue_number)` — one overlay row per issue per
user.

**Module** `extension/kb/issue-schedule.mjs` (mirrors `plans.mjs` conventions):
- `listIssueSchedules(userId, { provider, repo })` → array
- `upsertIssueSchedule(userId, { provider, repo, issueNumber, startDate, dueDate, estimateDays, dependsOn })` → row.
  Validates: dates match `^\d{4}-\d{2}-\d{2}$` or null; `estimateDays` ≥ 0 or
  null; `dependsOn` an array of integers. `null` clears a field.
- `deleteIssueSchedule(userId, { provider, repo, issueNumber })` → bool

Re-exported from `kb/db.mjs`. Added to the per-user delete sweep in `db.mjs`.

**Routes** (registered in the KB router, all `user_id`-scoped / IDOR-safe):
- `GET /kb/issue-schedule?provider=github&repo=owner/name` → `{ schedules: [...] }`
- `PUT /kb/issue-schedule` (body: `{ provider, repo, issueNumber, startDate?, dueDate?, estimateDays?, dependsOn? }`) → upserted row
- `DELETE /kb/issue-schedule` (body: `{ provider, repo, issueNumber }`) → `{ deleted: bool }`

Documented in `docs/spec/` so `make docs-check` (API-coverage guard) stays green.

### 2. Mac — RepoBackend extension

`RepoBackend` gains:
- **Board:** `boardColumns(projectId) -> [BoardColumn]` and
  `setIssueColumn(issue, column)`. GitLab adapter = scoped-label logic; GitHub
  adapter = `status:` flat-label logic (auto-create + rewrite). Capability flag
  `canEditBoardStatus`.
- **Scheduling:** `issueSchedule(for: issue)` and `setIssueSchedule(...)`. GitLab
  adapter reads native fields (read-only for now); GitHub adapter reads/writes
  the backend overlay via a new API client extension.

New `LlmIdeAPIClient+IssueSchedule.swift`: Codable `IssueSchedule` + `list` /
`upsert` / `delete` calls against the routes above.

### 3. Mac — shared UI

- **Board:** promote `RepoIssuesView` into a kanban `RepoIssueBoardView` matching
  GitLab's header (project dropdown, Open/Closed chips, refresh, New Issue),
  filter bar (search + label/assignee/milestone pills), and columns (drag to
  move). Reuses the lifted column logic.
- **Gantt:** extend `RepoGanttView` to merge the schedule overlay into a
  `ScheduledIssue { issue, schedule? }`, compute bars from `schedule.start →
  schedule.due` (falling back to the current milestone/`createdAt` logic), and
  add **form-based** schedule editing (Start / Due / Estimate / Depends-on) from
  a row popover and the issue detail sheet.

### 4. Reachability

A persisted `issueProvider` preference (`gitlab` | `github`). When **both**
tokens are configured, the Issues and Gantt sections show a segmented control
(GitLab | GitHub). GitLab keeps its existing rich views; GitHub flows into the
new shared board/gantt. GitLab users lose nothing; GitHub becomes reachable.

## Data flow (GitHub gantt)

1. User selects GitHub in the provider switch and opens Gantt.
2. View model loads, in parallel: `backend.listIssues()` (GitHub API) and
   `api.listIssueSchedules(provider: .github, repo:)` (our backend).
3. Merge by issue number → `ScheduledIssue[]`; compute bars.
4. Edit a schedule → `api.upsertIssueSchedule(...)` → model updates → bar
   re-renders.

## Error handling

- Backend validates dates/estimate/dependsOn → `400 VALIDATION_FAILED`
  (existing envelope) on bad input.
- Overlay load failure → gantt still renders with the milestone fallback and a
  quiet "schedules unavailable" notice; never blocks the board/gantt.
- Board label auto-create failure → drag is reverted and an error surfaced; no
  silent data loss.
- Tenancy: every query is `user_id`-scoped; no cross-user reads/writes.

## Testing

- **Backend:** unit tests for `issue-schedule.mjs` (upsert/list/delete,
  date/estimate/dependsOn validation, tenancy isolation, null-clears) + route
  tests (`node --test`, existing harness). Doc entries for the 3 endpoints.
- **Mac:** `swift build` green via the push build gate; Codable round-trip tests
  for `IssueSchedule` where a pattern exists.
- Full extension suite + `make docs-check` stay green.

## Phasing

- **P1 — GitHub gets a real gantt:** backend overlay (table + module + routes +
  tests + docs), Mac API client, `RepoGanttView` overlay merge + form editing,
  reachability switch.
- **P2 — Boards reach parity:** `RepoBackend` board-status capability (GitLab
  scoped-label logic lifted + GitHub `status:` labels), shared
  `RepoIssueBoardView` kanban with drag-to-move.

## Decisions

- **GitHub board columns come from labels** (`status:` convention), not the
  overlay — keeps the *data model* consistent with GitLab (status in labels for
  both), not just the UI. Scheduling uses the overlay because GitHub has no
  native equivalent.
- **Overlay stored in the backend**, not Mac-local — per-user, persistent,
  cross-device, consistent with how the Mac app already stores plans/meetings.
- **Form-based schedule editing for MVP.** Deferred to a later iteration:
  drag-to-reschedule on gantt bars, dependency arrow rendering, an
  activity-feed event, and pushing overlay data back into GitHub issue bodies.
