# work-kit

Status: **K0 Map**, written 2026-10-31. No code was changed. Citations are `path:line` or path only; read on 2026-10-31 at `main` (`de8d51e8`). Counts say how they were taken (`wc -l`, `find`, grep). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified.

## 1. Purpose

work-kit is the **plan-to-ship pipeline**: it turns a meeting or a goal into a plan (milestones, tasks, risks), puts the plan through a review queue, generates a guardrail-scanned diff for a task, dispatches approved tasks to GitHub, GitLab, Backlog or Linear, and reads the outcome (issue or PR state) back for the next plan. It also owns the **Issues board and Gantt** on the Mac (GitHub and GitLab issues, kanban, schedule overlay). It is the **workflow** and **permission** half of the plan's owned table: plans, review queue, dispatch, guardrails.

The plan row (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md`, kit 6) names: `agents/` planner, risk, codegen, codegen-apply, dispatcher, outcome-watcher, outcome-providers, github-pr; `guardrails/`; `kb/` plans, reviews, outcomes, issue-schedule, review-payload; `Features/Issues` (+ Gantt); `usePlan.ts`, `useAgent.ts`, `lib/plan.ts`; key `gantt_issues` (Issues part); contract groups planning, review, live-loop-misc (issue-schedule) plus **new** GitHub and GitLab issue routes; depends on core, agent, knowledge, graph.

The plan's premise that work-kit is a Swift-to-Node move is **only half right**. The planning half is already Node and has no Mac caller (section 2b); the Swift half is the Issues UI and the `Core/Repo` clients, which call GitHub and GitLab directly from the Mac.

## 2. Code on every side

### 2a. Server (Node, `extension/`)

| Piece | Path | Lines (`wc -l`) | Notes |
|---|---|---|---|
| Planner | `agents/planner.mjs` (`generatePlan` `:136`, `validatePlan` `:84`) | 163 | Grounded by `findGraphContext` from `graphkit/index.mjs` and `getMeeting`; model call through `providers/runtime.mjs` `runClaude`. `MAX_TASKS = 30`. |
| Risk annotator | `agents/risk.mjs` | 141 | `POST /kb/analyze-risks`. |
| Codegen | `agents/codegen.mjs` (`generateCodeForTask` `:201`, `validate` `:140`), `agents/codegen-apply.mjs` | 256 + 130 | `MAX_FILE_BYTES` 25 KiB, `MAX_OUTPUT_TOKENS` 16 000. Symlink and path checks are tested. |
| Dispatcher | `agents/dispatcher.mjs` (`dispatchPlan` `:500`, `retryFailedDispatches` `:407`, `resolveDispatchItems` `:492`) | 543 | Modes `preview` (default, no API call), `github`, `backlog`; idempotent through `meta.dispatched.url`; claims a task before sending (`claimTaskForDispatch`). |
| PR creation | `agents/github-pr.mjs` | 278 | Secrets and validation tests exist. |
| Outcome watcher and providers | `agents/outcome-watcher.mjs` (`refreshAllOutcomes` `:100`, background poller `:251`), `agents/outcome-providers.mjs` | 261 + 205 | Writes the `outcomes` table; a background poller starts at boot. |
| Guardrails | `guardrails/scan.mjs` (`scanForSecrets`), `guardrails/rules.mjs` | 39 + 324 | Secret, PII and destructive-op patterns. Imported by dispatcher, review, docs-kit and knowledge-kit ingest. |
| KB tables | `kb/plans.mjs`, `kb/reviews.mjs`, `kb/outcomes.mjs`, `kb/issue-schedule.mjs`, `kb/review-payload.mjs` | 352, 141, 314, 143, 82 | `plans` and `outcomes` are created in `kb/migrations/0001_initial.sql:114,207`. |
| Routes | `routes/planning.mjs` (`/kb/plans`, `/kb/plan/*` prefixes `:107,115`), `routes/review.mjs` (`/kb/review*`), `routes/issue-schedule.mjs`, plus dispatch, generate-plan, generate-code and outcome handlers inside `routes/router.mjs` (1 535 lines) | 344, 275, 76 | `planning` and `review` are always on (Chat and the extension use them). Only `/kb/issue-schedule` is feature-gated. |
| Feature group | `routes/feature-routes.mjs:28-32` (`gantt_issues`, prefix `/kb/issue-schedule`, loads `routes/issue-schedule.mjs`) | 126 (file) | The only route owned by the Issues key. |
| Endpoints in `ALL_ENDPOINTS` | `server.mjs:387-405` | — | `/kb/generate-plan`, `/kb/analyze-risks`, `/kb/code-sync`, `/kb/plans`, `/kb/plan/:id`, `/kb/plan/save`, `/kb/plan-task/update`, `/kb/plan/delete`, `/kb/dispatch`, `/kb/generate-code`, `/kb/issue-schedule`, `/kb/review/{submit,list,get/:id,approve,reject,delete}`, `/kb/notify/slack`, `/kb/outcomes/{refresh,retry-failed,task/:id,stats}`. About 25 rows. |

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

| Layer | Piece | Path | Lines |
|---|---|---|---|
| Features | Issues board, detail, kanban, project dropdown, picker | `Features/Issues/Views/` (5 files; `RepoIssueDetailSheet` 925, `RepoIssuesView` 691, `RepoKanbanPanel` 261) | part of 4 278 |
| Features | Gantt | `Features/Issues/Gantt/Views/` (5 files; `GanttView` 885, `GanttViewModel` 411, `GanttContainerView` 284, `GanttFilterBar` 252, `IssueScheduleEditorSheet` 212) | part of 4 278 |
| Features | Recent issues provider | `Features/Issues/Services/RecentIssuesResolver.swift` | 1 file |
| Features | **Total** | `Features/Issues/` (11 files, `find` + `cat \| wc -l`) | **4 278** |
| Core | Git clients and backend seam | `Core/Repo/Services/GitHubClient.swift`, `GitLabClient.swift`, `Repo/RepoBackend.swift`, `RepoBackendFactory.swift`, `AllowlistedRepoBackend.swift`, `GitHubClient+RepoBackend.swift`, `GitLabClient+RepoBackend.swift`; models `Core/Repo/Models/` | `Core/Repo/` 25 files, 5 765 lines (shared with SourceControl, Chat, AutoTask, Loop, MobileControl) |
| Core | Schedule overlay HTTP | `Core/Networking/API/LlmIdeAPIClient+IssueSchedule.swift` | the only work-kit route the Mac calls |
| Contracts | Issues seams | `Core/Contracts/IssueSeams.swift` (`ExistingIssuePickerRequest`, `IssueSeamRegistry`, `RecentIssuesProviding`) | — |
| Phone | Issues bridge | `Features/MobileControl/Services/MobileIssuesBridge.swift` (119), `PhoneIssues.swift` (76); wire `ios_app/SharedProtocol/.../IssuesMessages.swift` | — |

**Finding: the Mac never calls the planning, review, dispatch, codegen or outcome routes.** A grep of `mac/Sources/LlmIdeMac` for `kb/plans`, `kb/review`, `kb/dispatch`, `kb/generate-plan`, `kb/generate-code`, `kb/analyze-risks` finds only the schedule overlay client, and comments in `ProjectExporter.swift:221-257`, `AutoCodeUpdateService+PipelineTasks.swift:1066` (a `/kb/outcomes/refresh` doc comment), `GitHubSettingsSection.swift:479` and `RepoBackend.swift`. So the work-kit pipeline's only live client is the Chrome extension (2c). The Mac's Issues surface is a separate implementation that talks to GitHub and GitLab itself.

### 2c. Extension (Chrome)

| Piece | Path |
|---|---|
| Plan hook | `extension/src/sidepanel/hooks/usePlan.ts` |
| Agent hook | `extension/src/sidepanel/hooks/useAgent.ts` (the meeting co-pilot; belongs to capture-kit, see its map) |
| Plan client | `extension/src/lib/plan.ts` (`/kb/generate-plan`, `/kb/analyze-risks`, `/kb/code-sync`, `/kb/plan/:id`), `extension/src/lib/kb.ts:96` (`/kb/plan/save`) |
| Required endpoints | `extension/src/sidepanel/App.tsx:67-74` (`/kb/generate-plan`, `/kb/dispatch`, `/kb/generate-code`, `/kb/review/submit`, `/kb/review/list`, `/kb/review/approve`, `/kb/outcomes/refresh`) |

### 2d. Contract

| Piece | Path | Count |
|---|---|---|
| Planning group | `schema/http/planning.schema.json` | 1 904 lines |
| Review group | `schema/http/review.schema.json` | 532 lines |
| Issue schedule | `schema/http/live-loop-misc.schema.json` (row for `/kb/issue-schedule`, feature `gantt_issues`) | 3 methods |
| Inventory | `schema/http/INVENTORY.md`: `/kb/analyze-risks`, `/kb/code-sync`, `/kb/plans`, `/kb/review/get/:id`, `/kb/review/reject`, `/kb/review/delete` are "tests only"; `/kb/plan-task/update`, `/kb/plan/delete`, `/kb/outcomes/*` are "comments/docs only" | — |

### 2e. Feature key

`gantt_issues` (`mac/Package.swift`; excludes `Features/Issues` including Gantt; `file_explorer` off drops it by closure). It owns **one** server route. Planning, review and dispatch have **no key**: with `gantt_issues` off they still run (extension and Chat need them). Removing the key removes the Mac Issues and Gantt screens and the schedule overlay only.

### 2f. Tests and gates

| Side | Files |
|---|---|
| Server (`extension/tests/`, found by name) | `planner-validate`, `plan-pipeline`, `plan-status`, `plan-tasks-symbols-roundtrip`, `codegen-validate`, `codegen-apply-symlink`, `github-pr-validate`, `github-pr-secrets`, `outcome-dispatch-sentinel`, `outcome-url-parse`, `outcome-watcher-refresh`, `kb-task-update-outcome-scope`, `dispatch-preview`, `review-dispatch-guardrails`, `review-payload`, `review-secrets`, `review-state`, `guardrails`, `issue-schedule`, `issue-schedule-routes` (20 files). No test file for `risk.mjs` or `dispatcher.mjs` by name. |
| Mac | `GanttViewModelProviderParityTests`, `IssuesGanttGraphFixesTests`, `IssueImplementWorktreeTests`, `RepoIssueSearchParityTests`, `RepoIssuesLoadGateTests`, `RepoConnectionEmptyStateTests`, `RepoCredentialScopeTests`, `LinkedRepoDerivationTests`, `PhoneIssuesTests` (9 files, by name) |
| Gates | `mac/Scripts/feature-boundaries.sh`; `make feature-matrix --key gantt_issues`; `make contract-gates` |

## 3. Cross-kit edges

Legend: **C** = through `Core/Contracts` or an HTTP route; **D** = direct reference; **ok** = allowed by the server layering rule (ESLint allow-table, decision 9 of the docs-kit map).

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | work to agent-kit (providers) | `runClaude`, `routeOpts` in-process | ok | `agents/planner.mjs:6-7` |
| E2 | work to knowledge (kb) | `getMeeting`, `getMeetingTranscript`, plans/outcomes tables | ok | `agents/planner.mjs:8` |
| E3 | work to graph-kit | `findGraphContext` from `graphkit/` (always loaded) | ok | `agents/planner.mjs:9` |
| E4 | guardrails to docs-kit, knowledge-kit | `scanForSecrets` imported by `export-routes.mjs`, ingest | ok | docs-kit map E4 |
| E5 | work (Mac Issues) to Chat | picker and sheets through `IssueSeamRegistry` | C | `Core/Contracts/IssueSeams.swift` |
| E6 | Chat, MobileControl to work | recent issues grounding through `RecentIssuesProviding` | C | `Core/Contracts/IssueSeams.swift` |
| E7 | work to Core/Repo | `RepoBackend` protocol | C (Core) | `Core/Repo/Services/Repo/RepoBackend.swift` |
| E8 | AutoTask and Loop to work | the Issue-implement flow uses `Core/Repo`; AutoTask Pipeline posts to `/kb/outcomes/refresh` (comment) | C | `AutoCodeUpdateService+PipelineTasks.swift:1066` |
| E9 | extension to work | `usePlan`, `lib/plan.ts` | C | 2c |
| E10 | work (phone) to MobileControl | issues list, detail, comment | C | `MobileIssuesBridge.swift` |

**Cycles:** none found. The plan's cycle rule (`Core/Repo` stays in core, Issues seams stay in `Core/Contracts`) already holds. Open: the dispatcher shells to GitHub and Backlog itself (server) while the Mac's `GitHubClient` also creates issues and PRs (Swift); two implementations of GitHub write calls (section 5).

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| The model call that drafts a plan (`planner.mjs`) | Delegated | Reasoning and planning are model capability. |
| Plan JSON validation (`validatePlan`, `MAX_TASKS`) | Owned | Contract with the review queue and dispatch. |
| KB grounding of the planner (`findGraphContext`, FTS5 context) | Owned | Knowledge: project memory. |
| Risk annotation prompt (`risk.mjs`) | Delegated (thin) | Prompt only; trim as models improve. |
| Code generation call (`codegen.mjs`) | Delegated | The coding is model capability; chat with tools (agent-kit) does the same job better. **Retire candidate**: no Mac caller, extension is the only client. |
| Codegen apply, path checks, symlink guard, `validate` | Owned | Permission. |
| Guardrail scan (`guardrails/`) | Owned | Permission: secrets, PII, destructive ops. |
| Review queue and approval state (`reviews.mjs`) | Owned | Workflow. |
| Dispatch (`dispatcher.mjs`, `github-pr.mjs`, idempotency, claim) | Owned | Workflow and permission: what leaves the machine. |
| Outcome polling (`outcome-watcher`, `outcome-providers`) | Owned | Workflow: feeds the next plan. |
| Issues board, kanban, Gantt views | Owned UI | Replaced at K3. |
| `GitHubClient`, `GitLabClient`, `RepoBackend` | Owned | Credential scope (`RepoCredentialScopeTests`). |
| Schedule overlay (`issue-schedule`) | Owned | Gantt data GitHub has no field for. |

## 5. State and data (feeds K1a)

- **Server SQLite** (`data.db`): `plans` (plans and tasks, `meta.dispatched`), `reviews`, `outcomes`, `issue_schedule`; all user-scoped (`userId` first). They hold unique data today (a plan has no other copy), so under [data-lifecycle](data-lifecycle.md) rule 1 the K1a question is whether they stay server-only (project-control data, not a transcript) or get a file home.
- **Mac:** no plan or review store. Issues are **not cached**: the board reads GitHub or GitLab live through `Core/Repo`; credentials sit in the Keychain; the linked repo and project choices are UserDefaults. The `ProjectExporter` comment (`:221`) notes `GET /kb/plans` has no project filter, so plan export is by a different path.
- **Dispatch secrets:** `meta.dispatched.url`, tokens redacted (`core/redact-secrets.mjs`, `github-pr-secrets` test).

## 6. What K1 would move (proposal)

K1 for work-kit is **smaller than the plan's 10 to 12 tasks** if the server half is already done. Proposal:

1. **Issue routes in Node** (the plan's "new GitHub and GitLab issue routes"): `GET/POST/PUT /kb/repo/issues*`, comments, labels, milestones, kanban columns, behind one `RepoBackend`-shaped module in `extension/connectors/` (Box is the reference connector). Tokens move from the Mac Keychain to the vault (`server/vault`) per user.
2. **Mac Issues and Gantt call those routes**; the Swift `GitHubClient`/`GitLabClient` issue methods stay one release behind a preference (rollback), then go. SourceControl keeps its git use of `Core/Repo`.
3. **Fixtures first:** port `GanttViewModelProviderParityTests`, `RepoIssueSearchParityTests`, `RepoIssuesLoadGateTests`, `RepoCredentialScopeTests`, `PhoneIssuesTests` to node tests or a lab before deleting Swift.
4. **Planning half:** no K1 move. Add the missing tests (`risk.mjs`, `dispatcher.mjs`) and the Mac caller decision (question 1).

## 7. Decisions needed from the user

Options and the recommended answer; the recommendation is mine.

| # | Question | Options | Recommended |
|---|---|---|---|
| W1 | The Mac app does not use plan, review, dispatch, codegen or outcomes at all; only the extension does. Keep the planning pipeline as is, give the Mac a plan screen, or retire codegen/dispatch in favour of chat with tools? | keep as is; add Mac screen; retire codegen and dispatch | keep as is for K1; retire **codegen** (the chat engine with tools does it); keep dispatch and review (they are permission and workflow) |
| W2 | Issues provider credentials: keep in the Mac Keychain, or move GitHub/GitLab tokens into the server vault so Node can call the APIs (needed for the Tauri and relay path)? | Keychain; vault; both | vault, with a Keychain-to-vault migration (one way, N-1 readable) |
| W3 | Should the schedule overlay (`issue_schedule`) stay server SQLite or become a file in the project folder? | SQLite; project file | SQLite (derived project-control data, not content), unless knowledge-kit Q1 makes everything file-first |
| W4 | `gantt_issues` gates one route only. Give planning, review and dispatch their own key so a build without the extension can drop them, or leave them always on? | own key; leave | leave: Chat and the extension need them (`feature-routes.mjs:18-19`) |
| W5 | Is `/kb/code-sync`, `/kb/plan-task/update`, `/kb/plan/delete`, `/kb/outcomes/*` (no client, comments only) still wanted, or remove? | keep; remove | keep until the contract inventory shows no caller for a full release, then remove with an API bump |
| W6 | Dispatch targets in code are `preview`, `github`, `backlog`, `linear` (`dispatcher.mjs:34`); CLAUDE.md also names GitLab, which dispatch does not support (the Mac Issues UI does). Add a GitLab dispatch target, or leave GitLab to the Issues UI only? | add; leave | leave: GitLab issues are covered by the Issues routes in K1, dispatch can add it later |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Two implementations of GitHub writes (server dispatcher and Mac `GitHubClient`) drift | One Node module after K1; contract fixtures |
| R2 | Moving tokens to the vault changes who can call GitHub (server holds them) | Per-user scope, `RepoCredentialScopeTests` ported first |
| R3 | The planner reads the code graph at boot (`graphkit/` always loaded) so a graph-kit change breaks planning | Keep the `findGraphContext` seam covered by `plan-pipeline` |
| R4 | Dispatch is irreversible (creates issues and PRs) | Preview mode default, idempotency and claim tests stay; no live dispatch in tests |
| R5 | 9 Mac test files for Issues depend on SwiftUI-free view models | Port before delete (kit plan K1 rule) |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan lists work-kit as moving logic out of Swift; the **planning half is already Node** and the Mac does not call it.
2. The plan says `gantt_issues` covers the Issues part; the server owns **only `/kb/issue-schedule`** under it.
3. The plan's "new GitHub/GitLab issue routes" do not exist yet; the Mac Issues use `Core/Repo` directly.
4. CLAUDE.md says dispatch goes to GitHub, GitLab, Backlog and Linear; `ALLOWED_TARGETS` (`dispatcher.mjs:34`) is `preview`, `github`, `backlog`, `linear`. No GitLab target (the file header also omits Linear: comment drift).
5. Six planning/review/outcome endpoints have no client (inventory above).

## 10. What I could not verify

- The dispatcher beyond `ALLOWED_TARGETS` and its header (not read in full).
- Live behaviour of any route (no server run); `make contract-gates`, `make feature-matrix` and Mac `swift test` were **not run**.
- The exact Swift line count that is Issues-only logic versus UI state (only the folder total was counted).
