# Unify GitLab + GitHub repo views (Issues + Gantt)

**Date:** 2026-06-29
**Status:** Design — approved, pending implementation plan
**Builds on:** [`2026-06-27-github-issue-board-gantt-parity-design.md`](2026-06-27-github-issue-board-gantt-parity-design.md)

## Problem

The Mac app carries **two parallel view families** for the same surfaces:

| Surface | Legacy (GitLab-only) | Unified (`RepoBackend`, both providers) |
|---|---|---|
| Issues / board | `IssueBoardView`, `IssueKanbanPanel`, `IssueDetailPanel`, `IssueCreateSheet` | `RepoIssuesView`, `RepoKanbanPanel`, `RepoIssueDetailSheet`, `RepoProjectDropdown` |
| Gantt | `GanttContainerView`, `GanttView` (+`GanttFilterBar`) | `RepoGanttView`, `IssueScheduleEditorSheet` |

`AppShell` routes **GitHub → unified `Repo*` views** and **GitLab → legacy views**
(`AppShell.swift` `issuesRoute` / `ganttRoute`, the `case .github where hasGitHub` arms).
The result: every issue/Gantt feature is implemented twice, the two drift, and a
fix or feature has to be applied in both places.

Goal: **one shared code path per surface that serves both providers identically**,
with no regression to GitLab's richer affordances.

## Key finding: the backend is already unified

The divergence is entirely in the **view layer**. `RepoBackend`
(`Services/Repo/RepoBackend.swift`) already provides a complete, provider-neutral
surface — `listIssues` / `getIssue` / `createIssue` / `updateIssue`,
`listMilestones`, `listNotes` / `createNote`, `createBranch` /
`createMergeRequest` / `listOpenMergeRequests` — and already carries **capability
flags** (`canWriteIssues`, `canCreateMergeRequests`). The neutral models are also
nearly complete: `RepoMilestone` has both `startDate` and `dueDate`; `RepoIssue`
has `dueDate`, `milestone`, `labels`, `assignees`, `commentCount`.

So this is a **view-layer unification extending an existing pattern**, not a
backend rewrite. Both `GitLabClient` and `GitHubClient` already conform to
`RepoBackend`.

## Approach (chosen: A — capability-flagged unification)

Route **both** providers through the `Repo*` views; port the legacy GitLab-only
affordances into those views gated by capability flags; delete the legacy views.

Alternatives rejected:
- **B — drop GitLab-only features.** Truly identical instantly, but regresses
  GitLab (loses weight, native date editing, milestone filter, MR UI). Rejected:
  unnecessary downgrade for existing users.
- **C — extract shared sub-components behind per-provider wrappers.** Keeps two
  wrappers, so it shares pieces but not the path; adds an abstraction layer
  without achieving the stated goal. Rejected.

A is the only option that delivers genuinely identical, shared code **without**
regressing GitLab, and it extends the capability-flag pattern the codebase
already uses (`canWriteIssues`), so it is the least architecturally surprising.

## Design

### 1. Capability surface (`RepoBackend`)

Add two flags alongside the existing `canWriteIssues` / `canCreateMergeRequests`:

| Flag | GitLab | GitHub | Gates |
|---|---|---|---|
| `supportsWeight` | `true` | `false` | Weight badge on cards + weight editor in the detail sheet |
| `usesScheduleOverlay` | `false` | `true` | Date *source*: native `dueDate`/milestone dates (GitLab) vs the `/kb/issue-schedule` overlay (GitHub) |

No milestone-filter flag: **both** providers have milestones, so the unified
view surfaces milestone filtering unconditionally (the current `RepoIssuesView`
merely omitted it).

### 2. Model (`RepoIssue`)

Add one optional field: `weight: Int?` — GitLab adapter populates it from the
API; GitHub adapter leaves it `nil`. Update the `bumping(commentCount:)` helper
and both `asRepoIssue` adapters. No date-model changes needed.

### 3. Unified Issues (`RepoIssuesView` / `RepoKanbanPanel` / `RepoIssueDetailSheet`)

Fold the legacy affordances in, each flag-gated:
- **Milestone filter** added beside the existing label filter (both providers).
- **Weight** badge on cards + editor in the detail sheet — shown when
  `supportsWeight`.
- **Due-date editing** in the detail sheet — native `updateIssue(dueDate:)` when
  `!usesScheduleOverlay` (GitLab); the schedule-overlay editor when
  `usesScheduleOverlay` (GitHub).
- **MR/PR-creation UI** surfaced when `canCreateMergeRequests` (backend already
  has `createBranch` / `createMergeRequest`).
- **Comments** already work for both via `listNotes` / `createNote` — no change.

### 4. Unified Gantt (`RepoGanttView`)

Already implements the GitHub overlay path. Add the GitLab branch: when
`!usesScheduleOverlay`, draw bars from native `issue.dueDate` and milestone
`startDate`→`dueDate`, and a bar tap edits the **native** due date via
`updateIssue` instead of opening the overlay editor. This fully replaces
`GanttContainerView` + `GanttView`.

### 5. Routing (`AppShell`)

`issuesRoute` and `ganttRoute` drop their `case .github` special-cases and
**always** render `RepoIssuesView` / `RepoGanttView`. The provider switch stays
on top when both providers are configured. The unified views' empty /
"not connected" states become provider-neutral: default `activeBackend` to
whichever provider is actually configured rather than the hard-coded `.github`,
and word the empty state for either provider.

### 6. Deletions

Remove `IssueBoardView`, `IssueKanbanPanel`, `IssueDetailPanel`,
`IssueCreateSheet`, `GanttContainerView`, `GanttView`. Remove `GanttFilterBar`
**only after** confirming `RepoGanttView` does not reuse it. Before each
deletion, grep the repo (views, deep links, tests) for remaining references.

### 7. Testing

- Adapter unit tests: the new `weight` mapping (GitLab populates, GitHub `nil`)
  and the two new capability flags per provider.
- Behavioral coverage: GitLab still shows weight + native date editing +
  milestone filter; GitHub shows the overlay editor; both show milestone
  filtering and MR actions; both kanban boards derive columns from labels.
- `swift build` + `swift test` green at every step (the git pre-push hook
  enforces this).

### 8. Migration strategy

Land on this branch incrementally, each step building green:
1. Model field + capability flags (+ adapter wiring).
2. Unify Issues (port affordances into `Repo*` issue views).
3. Unify Gantt (add the GitLab native-date branch to `RepoGanttView`).
4. Flip `AppShell` routing to always-unified.
5. Delete the legacy views after a **feature-by-feature audit** of each old view
   against its unified replacement.

This keeps the app working at every step and makes the final deletion safe.

## Out of scope

- Any change to the `RepoBackend` network/auth layer or the providers' adapters
  beyond the `weight` field and flag values.
- The GitHub token-permission issue (separate; tracked operationally).
- New tracker providers (the flag pattern leaves room, but none are added here).
