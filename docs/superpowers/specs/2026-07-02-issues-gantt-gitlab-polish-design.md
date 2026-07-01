# Issues list + Gantt: GitLab-professional visual redesign

**Date:** 2026-07-02
**Status:** Design — approved, pending implementation plan
**Builds on:** [`2026-06-29-unify-repo-provider-views-design.md`](2026-06-29-unify-repo-provider-views-design.md)

## Problem

Two gaps, one shared root cause — the Issues and Gantt surfaces don't look or
behave like the tool they're modeled on:

1. **Issues** renders as a sparse single-column kanban board (`RepoKanbanPanel`)
   with minimal metadata per card. GitLab's actual Issues page is a **list**
   (rows), not a board — GitLab's kanban is a separate "Boards" feature this
   app never had a reason to imitate here.
2. **Gantt** regressed to GitLab-only after `2026-06-29`'s unification: the
   `1793b41 feat(mac): restore the rich GitLab Gantt view` commit rebuilt
   `GanttView`/`GanttViewModel`/`GanttContainerView` concretely typed on
   `GitLabClient`/`GitLabProject`/`GitLabIssue`, so GitHub silently fell back to
   the older, plainer `RepoGanttView`. Both providers should get the same rich
   view — this is a re-unification, on top of the richer visual bar it landed
   with.

Goal: a GitLab-professional Issues list and Gantt chart, identical for GitHub
and GitLab, built on the existing `RepoBackend` abstraction (no backend changes
needed — `RepoIssue`/`RepoMilestone` already carry every field required).

## Approach (chosen: retype the existing rich Gantt onto `RepoBackend`)

Alternatives considered:
- **Full rewrite of both views.** Throws away working, tested rendering code
  (canvas bar drawing, zoom-level math, today-marker positioning) for no
  benefit over adapting it. Rejected.
- **Adapter shim wrapping GitHub issues as fake `GitLabIssue` structs.** Faster
  to write, but leaves a misleading type standing in for GitHub data — exactly
  the kind of confusing indirection the `2026-06-29` unification was trying to
  eliminate elsewhere. Rejected.

Retyping is the smallest change that reaches full parity and matches the
pattern the codebase already uses (`RepoIssuesView`, `RepoBackend` capability
flags like `usesScheduleOverlay`, `supportsWeight`).

## Design

### 1. Issues — `RepoIssueListView` replaces `RepoKanbanPanel`

A vertical list of GitLab-classic two-line rows, backend-agnostic via the
existing `RepoBackend` protocol (already serves both providers — no protocol
changes needed here).

Per row:
- **State dot** — green (open) / gray (closed), top-aligned to the title line.
- **Title line** — bold title + inline colored label pills (`RepoLabel.color`).
- **Meta line** (muted, smaller) — `#number` · relative "opened Nd ago" ·
  milestone icon + name (omitted entirely when the issue has no milestone —
  no empty placeholder).
- **Right side** — comment-count bubble (`RepoIssue.commentCount`), then a
  single assignee avatar (small "+N" overflow chip when more than one).
- **Weight badge** — GitLab only, gated on `client.supportsWeight`; hidden
  (not shown-empty) on GitHub.

Rows use theme tokens (`theme.current.surface` / `border` / `rowAlt`) — never
literal GitLab purple/white — so all three themes (Dark/Light/Midnight) stay
correct. Row tap opens the existing `RepoIssueDetailSheet` unchanged. The
existing filter bar (search, state, milestone, label, assignee) is unchanged —
it already matches a row-list model better than it matched kanban columns.

`RepoKanbanPanel` and its drag-to-recolumn logic are deleted once
`RepoIssueListView` is wired into `RepoIssuesView` — no remaining call sites,
and GitLab's own Issues page doesn't have drag-status columns either, so this
isn't a regression relative to the thing being emulated.

### 2. Gantt — retype onto `RepoBackend`, apply visual polish

**Retyping.** `GanttViewModel` moves from `[GitLabIssue]` / `GitLabClient` to
`[RepoIssue]` / `RepoBackend`. Date sourcing branches on the existing
`usesScheduleOverlay` capability flag: GitLab reads `milestone.dueDate` /
`issue.dueDate` natively; GitHub uses the same overlay mechanism the deleted
`RepoGanttView` already established, so a GitHub issue without a native due
date still places sensibly on the timeline instead of disappearing.
`GanttContainerView`'s project list moves from GitLab-saved-projects-only
resolution to `RepoProject`-based resolution, mirroring `RepoIssuesView`'s
project dropdown.

**Visual polish** (structure unchanged: same zoom levels — day/week/month —
same canvas rendering, today marker, and scroll behavior):
- Bars: rounded pill shape, soft drop shadow, label-derived fill color
  (falls back to `theme.accent` when the issue has no color-bearing label).
- Milestone due dates: diamond marker layered at the relevant point on the
  bar.
- Weekend columns: subtle tint (`theme.current.gridLine` at reduced opacity)
  in day/week zoom only — skipped in month zoom, where day-level shading is
  visual noise at that scale.
- Row banding: faint zebra striping via the existing `theme.current.rowAlt`
  token (already used elsewhere in the app; just needs applying to Gantt
  rows).
- Today marker: unchanged (existing accent/red vertical line).

`RepoGanttView` (the old GitHub-only fallback) is deleted once `GanttView`
covers both providers — no dead code left behind, same reasoning as deleting
`RepoKanbanPanel`.

### 3. Capability gating (no `RepoBackend` protocol changes)

Both surfaces reuse capability flags that already exist on `RepoBackend` —
`supportsWeight` (Issues weight badge) and `usesScheduleOverlay` (Gantt date
source). No new protocol methods or flags are required; this is purely a
view-layer change consuming data the backend abstraction already exposes.

### 4. Testing

- `RepoIssueListView` gets a snapshot-style unit test (row rendering given a
  fixed `[RepoIssue]` fixture) mirroring how `RepoKanbanPanel`'s tests are
  structured today, so the row-composition logic (label pills, weight
  gating, avatar overflow) is covered without needing a live backend.
- `GanttViewModel`'s date-sourcing branch (native vs. overlay) gets a unit
  test per provider — this is the highest-risk logic in the retype, since a
  bug there silently drops issues off the timeline rather than crashing.
- Existing `RepoBackendCapabilityTests` (mac test suite) is extended to cover
  `supportsWeight` / `usesScheduleOverlay` consumption from the new views'
  perspective, not just the flags' existence.
- Manual verification: build + run the app against both a GitHub and a
  GitLab project, confirm Issues list and Gantt render equivalently for each.

## Out of scope

- Kanban/board view entirely (GitLab's own Issues page doesn't have it here;
  a future "Boards" surface would be a separate spec if ever requested).
- Renaming the app bundle/module or touching `Application Support/LLM IDE`
  storage paths (unrelated, flagged as a separate future task in a prior
  session).
- Milestone-grouped Gantt rows (structural change) — explicitly deferred;
  this pass is visual polish only, no regrouping.
