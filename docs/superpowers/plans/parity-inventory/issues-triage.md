# Issues / Gantt / Review Conflicts parity triage (verified)

Date: 2026-11-02. Input: 50 Mac labels from `scripts/parity-inventory.mjs` (Features/Issues incl. Gantt, Features/ReviewConflicts) with no text match in `ui/screens/{issues,gantt,review,shell}` or `ui/kit/src`. A Haiku pass classified them; this Opus pass checked every REAL_GAP call chain on the Mac, every claimed absence on the desktop, the core routes, and 16 of 17 REWORDED rows. Per-label results: scratchpad `triage/issues-verified.json` (same schema plus `verifiedBy`, `changed`).

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REAL_GAP | 31 (13 features) | 30 (14 features) |
| REWORDED | 16 | 17 |
| RUNTIME | 3 | 3 |
| MAC_ONLY | 0 | 0 |
| DEAD_ON_MAC | 0 | 0 |

7 rows changed: 4 class changes, 1 `needs` correction (core to ui), 3 risk corrections counted as one feature-level change (existing-issue-picker). Unlike Chat, nothing here is dead on the Mac.

## Reachability (Mac, all live)

- Issues: `AppShell.swift:827` -> `FeatureCatalog.issuesPane` (`FeatureCatalog.swift:212`) -> `RepoIssuesView` -> `.sheet(item: $detailIssue)` `RepoIssueDetailSheet` (`RepoIssuesView.swift:111`).
- Gantt: `AppShell.swift:836` -> `FeatureCatalog.ganttPane` (`:220`) -> `GanttContainerView` -> `GanttView`.
- Review: `AppShell.swift:729` -> `ReviewView(config: .conflicts)`; `newChangeMenu` shows when `CodeWorkflowTarget.resolveActive` finds an active cloned repo (`ReviewView.swift:69-72, 183`) and opens Chat's `CodeWorkflowSheet` / `QuickFixSheet` through the seam installed by `FeatureCatalog.installChatSeams` (`FeatureCatalog.swift:263-277`, called `LlmIdeMacApp.swift:286`). These two sheets are NOT among the dead Chat sheets (CreateIssueSheet, PRCreationSheet, ...): they are live from Review.
- Provider writes really reach the network: `RepoIssuesView.swift:209` createIssue, `RepoIssueDetailSheet.swift:658` createNote, `:681/:695/:753/:768` updateIssue (state, metadata, GitLab due date), `:900/:911` createBranch + createMergeRequest, `RepoKanbanPanel.swift:148` dropDestination -> `:255` updateIssue, `CodeWorkflowService.swift:213/699/708`. Clients are `GitHubClient`/`GitLabClient` through `RepoBackend` (`canWriteIssues`/`canCreateMergeRequests` both true) wrapped by `AllowlistedRepoBackend`. The per-provider allow-list defaults to ALL operations enabled (`Config.swift:404-409`), and the Mac asks for no confirmation: the click is the write.

## Core today (what exists)

- `GET /kb/issues` (`extension/routes/router.mjs:322-357`): reads cached `ticket` rows via `kb.search(..., limit: 1000)`, filters provider/repo/state in JS, returns at most `Math.min(limit, 100)`, no offset or cursor. Fields: id, title, body, url, provider, repo, number, state, labels, author, createdAt, updatedAt, isPR.
- `POST /kb/connect-github-issues` (`router.mjs:547`): GitHub only, vault `github.token` fallback; importer `connectors/issues.mjs` pages 100 x `MAX_PAGES 10` (1 000 issues max per repo) and stores no milestone, assignees or comments, although the GitHub list response already carries `milestone` and `assignees`. No GitLab import and no GitLab vault key.
- `/kb/issue-schedule` GET/PUT/DELETE (`routes/issue-schedule.mjs:23-59`): overlay startDate, dueDate, estimateDays, dependsOn.
- Writes: only `POST /kb/dispatch` (`routes/planning.mjs:182`, plan tasks -> GitHub issues) and `POST /kb/review/approve` (`routes/review.mjs:129`, reviewed codegen -> GitHub PR). No free-form create, edit, comment, close, branch or MR route; nothing for GitLab.
- `docs/superpowers/plans/2026-10-31-issues-gantt-core-plan.md` already designs the full set (section 3): `GET /kb/repo/issues` with cursor/assignee/milestone (IC2 cache + IC3 route), `/kb/repo/milestones|assignees` (IC3), `GET /kb/repo/issues/:key/comments` (IC3), `POST /kb/repo/issues`, `PATCH /kb/repo/issues/:key` with `baseUpdatedAt` and 409, `POST .../comments` with `idempotencyKey` (IC3), GitLab adapter (IC1), vault keys `repo.gitlab.token|host` (section 6, IC3), native due-date write-back (Q-I2), token migration (Q-I1), persistent cache (Q-I3). It does NOT cover branch creation, MR/PR creation or the Review code-change workflow.

## Merged table by feature

| Feature | Final class | Labels | Evidence | Missing / needs / effort / risky | Safe now |
|---|---|---|---|---|---|
| gantt-page-header | RUNTIME | 1 | "Gantt Chart" static heading | none | n/a |
| mr-create placeholders | RUNTIME | 2 | "feature/issue-", "main" TextField placeholders | belong to mr-create | n/a |
| gantt-issue-search | REWORDED | 2 | `GanttScreen.tsx:185` type=search, native clear | none | n/a |
| gantt-date-filter | REWORDED | 2 | From/Until inputs `GanttScreen.tsx:191-192` | none | n/a |
| error-retry | REWORDED | 1 | Refresh `GanttScreen.tsx:181`, error text `:203` | none | n/a |
| refresh-shortcut | REWORDED | 1 | Cmd/Ctrl+R `GanttScreen.tsx:144`, `IssuesScreen.tsx:124` | none | n/a |
| gantt-schedule-editor | REWORDED | 4 | editor dialog `GanttScreen.tsx:370`, due-before-start `:342`, Clear dates `:387` DELETE | none | n/a |
| gantt-dependencies | REWORDED | 2 | field `:382`, parse `:322-334`, arrows `:226-237` | none (helper caption only) | n/a |
| issues-search | REWORDED | 1 | `issues-model.ts:170` matches title + body | none | n/a |
| issues-label-filter | REWORDED | 1 | All labels `IssuesScreen.tsx:175` | none | n/a |
| review-linked-repo | REWORDED | 1 | `ReviewScreen.tsx:125-128` | none | n/a |
| project-picker | REWORDED | 2 | Mac list = saved repos only; desktop Repository / Saved repository selects | none | n/a |
| gantt-project-picker | REAL_GAP | 1 | `GanttContainerView.swift:172` | Gantt lists only cached repos, no search; use saved repos + filter box; ui, S, not risky | yes (A) |
| gantt-row-detail | REAL_GAP | 1 | `GanttView.swift:509` | no in-app detail from Gantt; reuse Issues detail dialog; ui, S | yes (A) |
| issue-detail-meta | REAL_GAP | 1 | `RepoIssueDetailSheet.swift:290` | opened date; `createdAt` already decoded; ui, S | yes (A) |
| issue-due-date-overlay | REAL_GAP | 1 | `RepoIssueDetailSheet.swift:463-474` (GitHub branch) | schedule editor from Issues detail; overlay route exists; ui, S | yes (A) |
| milestones | REAL_GAP | 3 | `GanttViewModel.swift:96`, `RepoIssuesView.swift:399` | milestone filter, legend diamonds; core must store and return milestone {title, dueOn}; core read + ui, M | after B core |
| assignees | REAL_GAP | 2 | `GanttView.swift:477-482`, `RepoIssuesView.swift:468` | assignee filter/avatar; core must store and return assignees; core read + ui, M | after B core |
| issue-comments (read) | REAL_GAP | 2 | `RepoIssueDetailSheet.swift:119, 646` listNotes | comment thread; new live GET route with vault token; core read, M | after B core |
| issue-create | REAL_GAP | 1 | `RepoIssuesView.swift:209, 285` | provider write; core, L, risky | HOLD (C) |
| issue-metadata-edit | REAL_GAP | 2 | `RepoIssueDetailSheet.swift:323-446, 681-753` | labels/assignee/milestone/state write; core, L, risky | HOLD (C) |
| kanban-drag | REAL_GAP | 1 | `RepoKanbanPanel.swift:148, 255` | label/state write on drop; core, L, risky | HOLD (C) |
| gitlab-due-date | REAL_GAP | 3 | `RepoIssueDetailSheet.swift:485-512, 768` | GitLab native due-date write (Q-I2); also needs GitLab import first; core, M, risky | HOLD (C) |
| mr-create | REAL_GAP | 5 | `RepoIssueDetailSheet.swift:251, 792-925` | open-MR lookup, remote branch create, PR/MR create; not in the core plan; core, L, risky | HOLD (C) |
| code-change-workflow | REAL_GAP | 4 | `ReviewView.swift:195-229` -> QuickFix/Guided | branch, AI change, commit, push, MR, issue comment; not in the core plan; core + rust, L, risky | HOLD (C) |
| existing-issue-picker | REAL_GAP | 3 | `QuickFixSheet.swift:60-71`, `CodeWorkflowSheet.swift:82` | read list itself trivial, but only host is the write workflow; held with it; L, risky | HOLD (C) |

## Reclassifications (Haiku -> verified)

1. "project to view the timeline" REAL_GAP core -> REWORDED. Haiku assumed `RepoBackend.listProjects` is a live provider list; it returns only Settings-saved repos (`GitHubClient+RepoBackend.swift:29-33`, `GitLabClient+RepoBackend.swift:20-41`). The desktop already scopes the timeline by repository.
2. "projects" (RepoProjectDropdown empty state) REAL_GAP core -> REWORDED. Same reason; desktop Issues lists saved repos (`IssuesScreen.tsx:47-57, 161-165`) and has the no-repo hint (`:210`).
3. "Search projects…" stays REAL_GAP but needs core -> ui. The list is local settings, which the desktop reads already.
4. "Open Details" REWORDED -> REAL_GAP ui S. The desktop Gantt has no in-app detail; Haiku counted "switch to Issues and find it" as the same behaviour.
5. existing-issue-picker (3 rows): risky false -> true, effort M -> L, held. The read could use `/kb/issues`, but the picker exists only inside the write-side code-change workflow.

REWORDED spot checks (16 of 17, all confirmed): both Clear search rows, Date Range, Done, Retry, Refresh Cmd+R, Edit Schedule, due-before-start, Schedule, dependency placeholder, arrows caption, Clear schedule, Search title / body, Any label, Linked banner (plus the two new ones). RUNTIME (3): all decoration, confirmed.

## Implementation batches

### A: pure UI, safe now (no core change)
1. gantt-project-picker: source Gantt's repository list from `readRepoConfig` saved repos (union with cached repos), add a search box.
2. gantt-row-detail: Open details from a Gantt row using the Issues read-only detail dialog (extract it into a shared component).
3. issue-detail-meta: "author opened this issue <relative date>" from `createdAt`.
4. issue-due-date-overlay: Dates section with Edit in the Issues detail for GitHub issues, reusing Gantt's `ScheduleEditor` and `PUT/DELETE /kb/issue-schedule`.

### B: small read-only core additions, then UI
Do paging first. Today the desktop sees at most 100 issues, the import stops at 1 000, and `/kb/issues` scans at most 1 000 cached tickets. Read-only, no new credential exposure, and every other read feature depends on it.
1. Paging (interim, before IC2): `GET /kb/issues` gains `cursor` (opaque offset or `updatedAt|id`) and returns `{ issues, nextCursor, total }`. Raise the inner `kb.search` scan cap, or better a direct indexed query on `meta.provider/repo/state`. Same auth (JWT user, user-scoped). Raise `MAX_PAGES` in `connectors/issues.mjs` with a progress/limit note. Long-term this is IC2 + IC3 `GET /kb/repo/issues` (cursor, limit 200, "showing N of M").
2. milestones + assignees: store `milestone {title, dueOn, startOn?}` and `assignees [login]` in `indexGithubIssues` meta (already in the GitHub list payload, no extra calls) and return them from `/kb/issues`; UI adds milestone/assignee filters, Gantt milestone legend and diamonds, row avatar. Plan: normalised shape section 4, IC1/IC3 (`/kb/repo/milestones|assignees` for pickers).
3. issue-comments read: `GET /kb/repo/issues/:key/comments?provider&repo&cursor` (plan section 3, IC3). Live provider GET with the vault `github.token`, response `{ items: [{id, author, body, createdAt, system}], nextCursor }`, errors mapped to fixed codes, host pinned via `makeTrackerFetch`, no token in URL or log.
GitLab for all of B needs a GitLab importer and a vault key (`repo.gitlab.token|host`, plan section 6), which waits on Q-I1 (token migration).

### C: provider writes, HOLD
Features: issue-create, issue-metadata-edit (labels, assignee, milestone, close/reopen), kanban-drag, issue comment post, gitlab-due-date, mr-create (branch + PR/MR), code-change-workflow (with existing-issue-picker).

Decisions to take:
- Q-I1 token path into the core vault (plan recommends paste write-only, `gh`/`glab` import as convenience).
- Q-I2 native due-date write-back (plan recommends overlay only in v1).
- New: whether the desktop opens branches and PR/MRs at all, outside `/kb/review/approve`. The core plan has no route for it. Recommend keeping `/kb/review/approve` as the only PR path, and treating Review's Quick Fix / Guided as a later slice that reuses the codegen + review approval flow, not a second writer.
- Whether issue writes ship in v1 or the desktop stays read-only with "Open on GitHub". Recommend shipping IC3 writes (create, PATCH, comment) only after B is in daily use, in this order: comment, state close/reopen, labels via drag, metadata, create.

Safeguards a write implementation needs (all of them):
- Tokens only in the core vault, per user, write-only entry; never in the webview, URLs, logs, errors or audit rows.
- Per-user scoping (`userId` first) and the repo allowlist enforced in the route layer (port of `AllowlistedRepoBackend`) plus the per-provider operation allow-list. Default it to OFF for writes on the desktop, unlike the Mac's all-on default.
- Desktop-class confirmation before every remote write, showing provider, repo, issue key and the exact diff or text. Phone and other origins go through T1 approval (plan section 8); Chat and Loop only via the existing approval path. Workspace Trust is irrelevant here, but the approval flow is required.
- Stale check: `baseUpdatedAt` with 409 and the latest issue; optimistic UI with rollback.
- Idempotency key on create and comment; dedup an open MR on the same branch, as the Mac does.
- No force operations: no force push, no branch delete, no overwrite of a remote branch.
- Audit row per write (provider, repo, key, action, result; no body, no token).
- Rate limits: per (user, provider) token bucket, one write at a time per issue, never retry on 403/429, honour `Retry-After`.
- Host allowlist through `makeTrackerFetch` (api.github.com, gitlab.com or the configured host, private hosts only with the operator gate); credential scope (no GitLab token to a GitHub host).
- Guardrail scan and redaction of outgoing bodies, as `/kb/dispatch` does.

### Recommended order
B1 paging, then A (parallel, cheap), then B2 milestones/assignees, then B3 comments read, then decide Q-I1 and add GitLab import, then the C decisions, then C writes in the order above. Branch/MR/code-change stays last and needs its own plan.

## Not verified
- No GUI run of either app; reachability is from code only.
- That WebKitGTK and WebView2 both render a clear button on `type=search` (WKWebView does).
- GitHub list payload field names (`milestone.due_on`, `assignees[].login`) were taken from the API's known shape, not from a recorded fixture.
