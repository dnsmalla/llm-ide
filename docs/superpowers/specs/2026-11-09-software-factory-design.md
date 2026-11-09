# Software Factory — Loop-first design

Status: draft for review, 2026-11-09. Local working document — remove it once the branch is merged (see the project's plan-cleanup rule).

## Intent

Turn the desktop app into a small software factory. A work item (an issue or a spec in `llm-doc/`) goes in. A reviewed, tested change on its own branch comes out, opened as a draft PR/MR after one human approval.

The Review Conflicts menu is where this lives in the end. Today it is a read-only tree of `code/` and `llm-doc/`, and the user asks the chat to compare them by hand. In the factory, that comparison becomes the first automatic step (intake), and the menu becomes the factory board.

Why Loop-first: Loop already has the factory's middle — stages, verify, repair, budgets, no-progress stop, protected tests, hash-pinned shell approvals and a run journal. It lacks isolation, a review step, shipping and a diff view. Building those into Loop first (Phase A) proves the pipeline on one item. The board (Phase B) then becomes mostly UI and scheduling on top.

## Goals

- **Phase A — Factory as a Loop template.** One work item per run, in its own git worktree. The run goes intake → plan → implement → verify → review. On a pass, the user reviews the diff and presses Ship, which opens a draft PR/MR.
- **Phase B — Factory board.** Replaces the Review Conflicts menu. Every work item is a card, and each card runs the Phase A pipeline in its own worktree. Several cards run in parallel under a concurrency cap. A card's column comes from facts (run result, PR/MR state, CI, review comments). CI failures and review comments can be sent back to the same worktree.

## Non-goals

- A graph/DAG pipeline engine or editor (option C). Revisit only after A and B show which pipelines are actually used.
- Cloud sandboxes or containers. Isolation is a git worktree on the user's machine.
- Running while the app is closed. Same rule as Loop and Auto Tasks today.
- Codex or Gemini write mode. Their write mode needs `--yolo`, which disables their sandbox (see the bus registry note on `issues.implement`). The factory runs Claude through `/kb/loop/agent-run` only.
- Embedding any outside project's code. Ideas are borrowed (see "Prior art"). No AGPL code (claude-squad, coder).

## Anti-goals (a failure even if it works)

- **The agent can push, merge or hold a write token.** Ship is a human button. The push and the PR/MR call run in the core with the user's credentials, after a secret scan.
- **A repair edits the verifier** (tests, build config, the Loop's own files). The existing protected-path policy must apply inside the worktree too.
- **A run touches the user's main working tree.** A factory run never writes outside its worktree.
- **Every repair restarts from stage 1** and re-pays for intake, plan and implement. This is the user's parked "single-pass" wish for Loop. Phase A fixes it for the stages that need it.
- **A worktree is deleted without the user asking.** Only Discard (or Ship followed by an explicit clean-up) removes one.

## What exists and is reused

| Need | Existing piece | Change needed |
|---|---|---|
| Stage runner, repair, budgets | `ui/screens/loop/native/runner.ts` (`runNativeLoop`) | Add a once-per-run stage option (A2) |
| Shell stages with approval | `desktop/src-tauri/src/loop_runner.rs`, `loop_approval.rs` | Run in a run's worktree instead of `work_root` (A1) |
| Coding agent | `POST /kb/loop/agent-run` → `extension/llm_agent/sdk/loop-agent.mjs` | None. It already accepts linked worktrees under a `loop-worktrees` folder and reports changed paths and usage |
| Worktree lifecycle | `desktop/src-tauri/src/self_heal_fix.rs` (prepare / verify / diff / apply / remove, ownership check) | Generalise to any project (A1) |
| Write guards | `protected.ts`, `agent-call.ts` | Point at the worktree root |
| Artifact gates | `artifact.ts` | **New rule needed.** `expand()` skips dot-entries (`artifact.ts:53`), and section rules pass when their header is missing. Add a `verdict` rule that reads one explicit path and requires one line, failing when the file or line is missing (A3) |
| Path mapping for check stages | `NativeLoopScreen.tsx:590-592` `repoPrefix` (artifact, testMap, codeGraph) | Map the run's worktree path, not only `workRoot` (A1) |
| Read-only agent stages | none in Loop (`read-only.ts` is Auto Tasks code; the core's `readOnly` removes all write tools) | **New:** a "write only under `.factory/`" policy in `loop-agent.mjs` `loopToolRefusal` (A3) |
| Run journal | `history.ts` (`system/loop-runs/`) | Add work item, worktree, branch and ship fields (A5) |
| Push + PR | `extension/agents/github-pr.mjs` | Only `scanForSecrets` and `createDraftPr` are reusable. `openPullRequest` checks out a branch in the given repo, refuses a dirty tree and stages only `.llmide-auto/`. The worktree commit-and-push flow is **new code**; GitLab MR is **new code** (A4) |
| PR/MR state | `extension/agents/outcome-watcher.mjs`, `outcome-providers.mjs` | GitHub and Backlog only. GitLab MR state, CI and comments are **new** (B3) |
| Issues | `GET /kb/issues`, Issues screen | "Send to Factory" action (B4) |
| Approval inbox, phone | Command bus, `issues.implement` registered but unavailable | Make it available on top of B (B5) |

The Loop settings already contain `alwaysUseWorktree`, `useWorktreesForConcurrentRuns` and `openMergeRequest`. They are shown disabled as "not ported". Phase A ports the first and the last of these. Phase B ports the concurrent one.

## Phase A — the Factory Loop

### A1. Worktree runs (the one real new piece)

A new host module, for example `desktop/src-tauri/src/loop_worktree.rs`, generalised from `self_heal_fix.rs`:

- **`prepare(project, repo, run_id, base)`.** Adds a worktree on branch `factory/<run_id>` from the chosen repo's `HEAD` (or a chosen base). It writes the work item to `.factory/TASK.md` inside the worktree. The host keeps a run registry (`run_id` → project, repo, worktree), so later calls take only the `run_id`.
- **Which repo (my call).** A project can hold several repos under `code/`, and today `work_root()` silently takes the first (`loop_runner.rs:90`). A factory run carries its repo explicitly. An issue maps to the repo it was imported from. A spec or free text asks the user, and the picker defaults to `work_root()`'s repo.
- **`diff(run_id)`.** Diffs `HEAD` against the worktree, not the index, so what is shown is what Ship commits. Untracked files are included. Output is size-capped and carries a patch id.
- **`remove(run_id)`.**
- **`list()`.** Lists the factory worktrees, for the board and for finding orphans.
- **The ownership check from Self-Heal stays.** A worktree must belong to the project's repo (the common git dir is the repo's `.git`). The webview only ever passes a `run_id`, never a path.

**Location (my call).** Put worktrees at `<project>/system/loop-worktrees/<run_id>`.

- This is the path `loop-agent.mjs` already names and trusts (`:88`).
- `system/` already holds `loop.json` and the run journal.
- The project-scoped Explorer `FsApi` can read it, which the artifact, testMap and codeGraph stages need.
- An app-data location like Self-Heal's was rejected because the webview could not read it.
- If the project root is itself the git repo, `prepare` adds `system/loop-worktrees/` to that repo's `.git/info/exclude`, so the worktree never shows as untracked.

**Loop changes.**

- `loop_runner.rs` stage commands (run, revert, changed paths) take an optional `run_id`. When one is given, the host resolves the run's worktree, validates it and uses it as the work root. Hash-pinned approvals are unchanged.
- `NativeLoopScreen` passes the worktree path as `repoRoot` to `agent-run` for skill and repair stages, and derives `repoPrefix` from the worktree for check stages.
- Cancel becomes per run. Today `loop_runner.rs:23` has one global `CANCEL` flag, which cannot stop one of several runs (needed in B).
- The "Always run in an isolated worktree" toggle is enabled. A Factory loop forces it on.

**Cold worktree risk.** A new worktree has no `node_modules` or build cache. The Factory template therefore starts with an optional **Set up** shell stage (for example `npm ci`) that runs once per run. Loop's existing environment check (`environment.ts`) suggests the command.

### A2. Once-per-run stages

Add `runOnce: boolean` to `LoopStage` (tolerant decode, default false).

- The runner skips a `runOnce` stage in later iterations once it has passed in this run.
- A repair then re-runs only Verify and Review, not Intake, Plan and Implement.
- This is the smallest change toward the parked single-pass Loop. It does not change existing loops.

### A3. The Factory template

A new built-in template in `templates.ts` / `defaults.ts`. The stages, in order:

| # | Stage | Kind | Once | Severity | Repair | Output / gate |
|---|---|---|---|---|---|---|
| 0 | Set up | shellCommand | yes | blocking | no | Install dependencies; optional |
| 1 | Intake | skill `factory-intake` (read-only) | yes | blocking | no | `.factory/READINESS.md`: doc-vs-code conflicts, open decisions, `Verdict: ready \| needs-decision` |
| 2 | Intake gate | artifactCheck | yes | blocking | no | Requires `Verdict: ready`. A failure ends the run as **needs decision** |
| 3 | Plan | skill (existing plan skill) | yes | blocking | no | `.factory/PLAN.md` |
| 4 | Implement | skill (existing implementer / TDD skill) | yes | blocking | yes | Code changes in the worktree |
| 5 | Verify | shellCommand (project test command) | no | blocking | yes | Exit code |
| 6 | Review | skill `factory-review` (read-only) | no | blocking | no | `.factory/REVIEW.md` with findings and `Verdict: approve \| changes` |
| 7 | Review gate | artifactCheck | no | blocking | yes | Requires `Verdict: approve`. On failure the repair agent gets the findings, then Verify and Review run again |

- **New skills.** `factory-intake` and `factory-review` are written in the central skills kit (the `.skills` submodule, agent-kit repo). This repo only references them.
- **New write policy.** Intake and Review may write only under `.factory/`. This is a new option on the agent run: `loopToolRefusal` refuses Edit/Write outside `.factory/`. The core's existing `readOnly` mode cannot be used, because it removes write tools and the gate needs the report file.
- **New `verdict` artifact rule.** It reads one explicit file (dot-folders allowed) and requires a line such as `Verdict: ready`. A missing file or missing line fails. Existing `sectionRules` can't do this (see the reuse table).
- **Intake is the old Review Conflicts job, automated.** After the run, the app (not the agent) copies the report to `llm-doc/factory/<yyyy>/<MM>/<run_id>-readiness.md`. That is outside the code repo. The existing Review Conflicts tree shows it with no UI change.
- **`.factory/` is excluded from the diff and from Ship.** It is like Self-Heal's `.self-heal/`.

**Picking the work item (Phase A UI).** The Factory loop's Run button asks for one of:

- an issue from `GET /kb/issues`, or
- a file under `llm-doc/`, or
- free text.

The choice becomes `.factory/TASK.md`.

### A4. Diff review and Ship

The step after a passed run is shown in the Loop screen. It is ported from Self-Heal's proposal flow.

- **Review.** A per-file diff of the worktree against `HEAD`. A shared diff component is reused if the explorer SCM view has one.
- **Ship** (human button, the single approval gate):
  - The core commits in the worktree with a pathspec, which never sweeps in other staged files.
  - The commit author is the user.
  - The core runs `scanForSecrets` on the staged diff and pushes the branch with the user's git credentials. Commit and push are new code that runs in the worktree; `openPullRequest` is not reused.
  - It then opens a **draft** PR (GitHub, reusing `createDraftPr`) or a **draft** MR (GitLab, new code).
  - The GitLab MR uses the vaulted GitLab token and the fixed `gitlab.com` API host, the way `routes/issue-writes.mjs` does. A self-hosted GitLab is out of scope for A (my call).
  - The core returns the URL.
  - The `openMergeRequest` toggle is ported to mean "offer Ship after a passed run".
- **Discard.** Removes the worktree and branch after a confirm.
- **New core route,** for example `POST /kb/loop/ship`. It goes in Loop's feature route group, is added to `ALL_ENDPOINTS` and bumps `SERVER_API_VERSION`.
- **The repo must be allowlisted** the way codegen-apply requires today.

### A5. Run record

The Loop run record gains these fields:

- `workItem` (source, id, title)
- `worktree` (run id, branch, base commit)
- `ship` (provider, url, state)
- the needs-decision reason when Intake stopped the run

The run is recorded in the existing `agent_runs` with token totals. Past runs show the stored diff summary even after the worktree is removed.

### Phase A acceptance

- A Factory run on a real issue in a test repo ends in one of: **passed and shipped** (draft PR/MR open), **needs decision** (with `READINESS.md`), **failed** (with the failing stage), or **cancelled**. In every case the target repo's main working tree is untouched (`git status` there is identical before and after). The readiness copy under `llm-doc/` is the only write outside the worktree.
- An Intake report without a `Verdict:` line fails the gate.
- A repair re-runs only Verify and Review.
- A Review `changes` verdict leads to a repair, then a re-verify.
- Ship never runs without a click. The secret scan blocks a planted fake token.
- Stop mid-run leaves a worktree that Discard removes cleanly.

## Phase B — the Factory board

### B1. Shell-level run manager

- **Factory runs live in a shell-owned manager, not in the screen.** Switching sections must not kill or orphan a run. The runner stays `runNativeLoop` in the webview. Porting it to the core is out of scope.
- **Concurrency cap: default 2, configurable.** Parallel Claude runs hit rate and session limits. The rest of the queue waits.
- **One worktree per card.** Shell approvals by command hash are already shared across runs.
- **Auto-stop is dropped for B.** B has no automatic retries (Send back is a button), so there is nothing to stop. Revisit it if automatic send-back is added.
- **Project switch (my call).** A run stays bound to the project it started in. The agent or shell stage that is running keeps going after a switch. The run then holds at the next stage boundary ("Waiting for its project") until that project is open again, because file-reading gates read through the open project. Every host call carries the `run_id`, which the host's run registry resolves, instead of `active_root()`. The board shows only the current project's cards, plus a count of live runs in other projects.
- **Orphans.** On launch, `list()` finds worktrees whose run is no longer live. They are shown as "Interrupted" with Resume and Discard. They are never auto-deleted.

### B2. The board (replaces Review Conflicts)

- **Placement.** The `conflicts` section is relabelled **Factory**. The current read-only tree stays as a **Docs vs code** tab, so nothing is lost.
- **Columns are derived from stored facts** (run results, ship records, PR/MR state) when the board is read. They are never stored as a status (borrowed from agent-orchestrator).

| Column | Derived from |
|---|---|
| Inbox | A work item with no run |
| Needs decision | The last run ended at the Intake gate |
| Working | A run is live or queued |
| Needs you | The last run failed, was blocked or paused, or was interrupted; or the PR/MR has failing CI or new review comments |
| Ready to ship | The last run passed and has no ship record |
| Shipped | The PR/MR is open |
| Done | The PR/MR is merged (closed without merge goes back to Needs you) |

- **Card actions:** Start, Open diff, Ship, Send back (with a note), Discard, Open PR/MR.
- **Feature gating.** The `conflicts` section stays ungated, so the Docs vs code tab is always available. The Board tab is shown only when `auto_tasks` (Loop) is usable. New core routes go in the `/kb/loop/` group, which `auto_tasks` already gates.

### B3. Feedback from the PR/MR

- `outcome-watcher` polls PR state for GitHub only (`outcome-providers.mjs`). Add a GitLab MR provider. Then read CI status and new review comments for factory branches on both providers. Comments are untrusted text: they are fenced as data in the repair prompt.
- **Send back** re-opens the same worktree and runs a repair with the CI log or comments as input. Then Verify and Review run, then the user ships an update (push to the same branch).
- In B, Send back is a button. Automatic send-back is a later option.

### B4. Intake from Issues and llm-doc

- The Issues screen gets "Send to Factory" for one or more issues.
- `llm-doc/` specs can be added from the board.
- Batch intake runs only the Intake stage on each item, so the Needs decision column fills before any code is written (borrowed from superplane's readiness scoring).

### B5. Command bus

- Make `issues.implement` available, backed by the factory. Its tier T2 approval and the approval inbox become the remote entry point (phone and web).
- This is the last step of B and can slip without blocking the board.

### Phase B acceptance

- Three issues sent to the factory with a cap of 2: two run and one queues. Switching sections and back keeps all three intact.
- After an app quit mid-run, the board shows the run as Interrupted, and Discard removes its worktree.
- A PR/MR with a failing CI check moves its card to Needs you. Send back produces a new push to the same branch.

## Prior art borrowed (ideas only)

- **strongdm/attractor (Apache-2.0):**
  - checkpoint per stage
  - goal gates
  - a human-wait node (here: Intake gate and the Ship button)
- **agent-orchestrator (Apache-2.0):**
  - board columns
  - status derived from facts
  - CI and review feedback routed to the branch's own worker
  - never auto-type into a blocked session
- **superplane:**
  - a readiness check before implementing
  - one human gate before merge
- **open-inspect (MIT):**
  - auto-stop after repeated failures
  - commits attributed to the requesting user
- **Self-Heal (ours):**
  - the worktree lifecycle
  - the propose-then-apply pattern

## Risks

- **Cold worktrees** make Verify slow or failing. Mitigation: the once-per-run Set up stage, plus a clear "environment" failure message.
- **Rate limits** with parallel runs. Mitigation: the concurrency cap, plus run cost recorded per item.
- **Disk use.** Each worktree is a full checkout plus dependencies. Mitigation: the board shows worktree count and size, and Discard is one click.
- **Prompt injection** through issue text, specs or PR comments. Mitigation: fence them as data (`docs/explanation/invariants.md` fence rules); the agent has no shell, network or push.
- **Self-Heal drift.** If Self-Heal does not move onto `loop_worktree.rs`, two worktree implementations exist. Moving it is optional cleanup in A1.

## Decided by the user

- Build A first, then B. Skip the graph engine (C) for now.
- Review Conflicts becomes the factory's home.
- Replies and this design are in English.
- Ship supports **both** GitHub PRs and GitLab MRs in Phase A.
- The design was approved for Phase A planning on 2026-11-09.

## Builder's calls (made in this draft — check them)

- Worktrees live under `<project>/system/loop-worktrees/`, so the webview can read them.
- A run targets one explicit repo, and an issue maps to the repo it was imported from.
- After the run, the app copies the readiness report to `llm-doc/`.
- GitLab means `gitlab.com` only in A. A self-hosted GitLab is later.
- After a project switch, a run finishes its current step and then waits until its project is opened again.
- In Factory loops, the Implement stage may write tests and manifests (TDD). Repairs, Plan and Review may not.
- Ship opens **draft** PR/MRs only. There is never an auto-merge.
- The concurrency cap defaults to 2.
- The Review Conflicts tree is kept as a tab rather than deleted.
- The runner stays in the webview for B, not in the core.

## Open questions for the user

- What is the main input: Issues tickets, `llm-doc/` specs, or both equally? Both are supported. The answer only decides which picker gets polish first.
