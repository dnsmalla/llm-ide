# automation-kit

Status: **K0 Map**, written 2026-10-31. No code was changed. Citations are paths and `path:line` where a line was read; read on 2026-10-31 at `main` (`de8d51e8`). Counts say how they were taken (`wc -l`, `find`, grep). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified.

## 1. Purpose

automation-kit is **unattended work**: the Loop (a verifiable harness of stages that run, detect failures, repair them with a confined agent, and journal every run) and the Auto Tasks (scheduled and on-demand jobs: source update, review, regression, issue creation, plan-status refresh, Loop Engineering sweep). It is the **workflow** and **observability** half of the plan's owned table for anything that runs while the user is away, and it is the **largest and riskiest** kit: almost all of it is Swift today.

The plan row (kit 9) names: Loop, Auto Tasks, verify and repair; `Features/Loop`, `Features/AutoTask`; key `auto_tasks`; contract `/kb/loop/*`; depends on core (**job runner**, Repo, Incidents, Memory), agent, knowledge; size 20 to 30 tasks for K0 to K2. It runs after the "core job runner" step, which **does not exist yet** (section 5).

## 2. Code on every side

### 2a. Server (Node, `extension/`)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Loop headless agent step | `routes/loop-agent.mjs` (`POST /kb/loop/agent-run`, handler at `:106`; engine in `llm_agent/sdk/loop-agent.mjs`) | 245 | The **only** server surface of the kit. Confined agent: file read, search, edit, write; no shell, no network; a tool that needs approval is denied; metered under the provider that ran (API v58, v66). Bucket `agentTurn` (`server.mjs:504`). |
| Feature group | `routes/feature-routes.mjs:44-50` (`auto_tasks`, prefix `/kb/loop/`) | 126 (file) | With `auto_tasks` off the route answers 404 `feature_disabled`. |
| Plain completion for regression | `POST /kb/complete` (API v88; `routes/complete.mjs`, 89) | 89 | The Mac's `RegressionRunner` moved onto it. Always on. |
| Usage report for CLI runs | `routes/router.mjs:1105-1111` (an `autotask` usage report becomes one `autotask:<id>` run) | — | AutoTask meters its CLI runs here. |
| Outcome refresh | `POST /kb/outcomes/refresh` (work-kit) | — | `updatePlanStatus` task calls it (`AutoCodeUpdateService+PipelineTasks.swift:1066`). |
| Store jobs (not a job runner) | `kb/agent-jobs.mjs` | — | Boot, rollup and watchdog ticks for the agent store only (`startAgentStoreJobs`), a 60 s tick; **not** a general job queue. |

There is **no server-side Loop engine, scheduler, run journal, queue or Auto Task runner**. `grep` of `extension/` for loop stage, journal or queue code finds only the route above.

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

| Layer | Piece | Path | Lines (`find` + `cat \| wc -l`) |
|---|---|---|---|
| Features | **Loop** | `Features/Loop/` (83 files): `Services/LoopEngineRunner.swift` 3 271, `LoopStageDetector` 1 964, `RepairScopeGuard` 946, `LoopEngineRunner+CodeGraph` 612, `RegressionRunner` 534, `LoopRunJournal` 420, `LoopShipCoordinator` 269, `LoopRunService` 286, `LoopRunQueue` 133, `LoopWorktreeManager` 219, `Models/` (stage, definition, template, config, run record), `Views/` (`LoopEngineView` 2 167 and parts) | **23 245** |
| Features | **Auto Tasks** | `Features/AutoTask/` (30 files): `AutoCodeUpdateService` 1 195 + `+CLI` 1 286 + `+PipelineTasks` 1 105, `AutoCodeView` 1 117, `ModelLimitsPanel` 699, `MobileAutoTaskBridge` 579, `AutoTaskSettings` 502, `AutoTaskTemplateStore` 399, `CronExpression` 138, `TaskLogStore` 101 | **9 710** |
| Features | **Total** | two folders, 113 files | **32 955** |
| Core | Repo clients (shared) | `Core/Repo/` (25 files, 5 765 lines) | shared |
| Core | Memory and incidents (shared) | `Core/Memory/` (fault reports, Q&A store), `Core/Incidents/` (self-heal proposals) | shared |
| Core | HTTP | `Core/Networking/API/LlmIdeAPIClient+LoopAgent.swift` (produces `LoopAgentResult`), `+Complete.swift`, `+Usage.swift` | — |
| Contracts | Loop and Auto Task seams | `LoopRunning`, `LoopAgentRunning`, `LoopLaneControlling`, `LoopRunTrigger`, `LoopSweepPlanning`, `SweepOutcome`, `LoopEngineStatus`, `LoopRepoRegistering`, `TaskLogWriting`, `RoutinesProviding`, `SourceIngesting`, `MobileAutoTaskMessages`, `MobileLoopMessages` in `Core/Contracts/` | — |
| Phone | Bridges | `Features/AutoTask/Services/MobileAutoTaskBridge.swift` (579), `Features/Loop/Services/MobileLoopBridge.swift` (465); wire `AutoTaskMessages`, `AutoTaskSetupMessages`, `LoopMessages` | — |
| Shell | Boot | `FeatureCatalog.bootAutoTask`, `wireMobileFeatureBridges`; `LoopRunService.logTaskKey` set by Shell | — |

**What Loop stages are.** `LoopStage.Kind` (`LoopStage.swift:43-77`): `regressionSweep`, `shellCommand`, `skill`, `artifactCheck`, `testMap`, `testPrune`, `incidentTriage`, `codeGraph`, `sdkSurfaceDiff`, `unsupported`. Default loops: Regression, Test, System Check, Plan, Refactoring, Doc Optimization (MASTER-PLAN, memory index). The Loop's model use goes through **one** route, `/kb/loop/agent-run`; everything else (stage detection, repair scope guard, journal, queue, worktrees, test map, code-graph snapshots) is Swift.

**What Auto Tasks are.** `AutoTask` enum (`AutoTask.swift`): `sourceUpdate`, `sourcesToIssue`, `implementIssues`, `reviewMerge`, `reviewCode`, `reviewDoc`, `reviewConflicts`, `regression`, `generateKnowledge`, `generateDoc`, `updateIssues`, `updatePlanStatus`, `loopEngineering` (13), plus user-created `CustomAutoTask`. They run an AI CLI (`claude`, `codex`, `gemini`; `AutoCodeUpdateService+CLI.swift:449,574`) as a `Process`, scheduled by a **60 s `Timer`** plus cron (`AutoCodeUpdateService.swift:254-256`, `CronExpression`).

### 2c. Extension (Chrome)

None. The Mac phone bridge and the Mac UI are the only clients.

### 2d. Contract and phone wire

| Piece | Path |
|---|---|
| Group row | `schema/http/live-loop-misc.schema.json`: `POST /kb/loop/agent-run` (feature `auto_tasks`); fixtures 200, 400-provider, 502, 503, 504 are produced in-process with the engine seam stubbed (per the schema description), so no model is called |
| Loop engine contract | none over HTTP: `mac/Sources/LoopContractLab` (4 062 lines, 20 files) asserts the Swift logic via `make loop-gates` (`Makefile:273-275`) |
| iOS | `ios_app/SharedProtocol/.../AutoTaskMessages.swift`, `AutoTaskSetupMessages.swift`, `LoopMessages.swift`, `SelfHealMessages.swift`; wire tags `auto_task_*` and `loop_*` in `MobileProtocol.swift` |

### 2e. Feature key `auto_tasks`

`mac/Package.swift:127` excludes both `Features/AutoTask` and `Features/Loop` and about 40 test files (`:129-166`, truncated list) when off. Server: `loop-agent.mjs` is not loaded and `/kb/loop/*` answers 404 `feature_disabled`. The mobile bridges degrade (`MobileFeatureBridge`). The `LoopRunning` seam names `LoopEngineConfig` under `#if FEATURE_AUTOTASK` (the one allowlisted Core to feature edge, CLAUDE.md check 7).

### 2f. Tests and gates

| Side | Files |
|---|---|
| Mac | 77 test files whose names match loop, autotask, autocode, cron, verify, regression or repair (`ls \| grep -ci`); examples: `LoopEngineRunnerTests`, `LoopStageDetectorTests` (+ Refactor and Test variants), `LoopRunJournalTests`, `LoopRunQueueTests`, `RepairScopeGuardTests`, `AutoCodeUpdateService*Tests` (13 files), `CronExpressionTests`, `AutoTaskConfigStoreTests`, `MobileLoopSnapshotTests`, `MobileAutoTaskBridgeScopeTests` |
| Lab | `LoopContractLab` (20 files, 4 062 lines): output layout and migration, refactor rollback, rules, test standard and contract, self-heal (690), SDK adoption, environment checks |
| Server | `loop-agent.test.mjs`, `loop-progress.test.mjs` (2 files) |
| Gates | `make loop-gates` (in `make regression`), `mac/Scripts/feature-boundaries.sh`, `make feature-matrix --key auto_tasks` |

## 3. Cross-kit edges

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | automation to agent-kit | `/kb/loop/agent-run` and `/kb/complete`; tier routing; the CLI runs for Auto Tasks use the local `claude` binary (the Swift `ClaudeLink` meters) | C | `LlmIdeAPIClient+LoopAgent.swift`; `AutoCodeUpdateService+CLI.swift` |
| E2 | AutoTask to Loop | runners and sweep planning through `LoopRunnerProviding`, `LoopSweepPlanning`, `LoopLaneControlling` | C | `Core/Contracts/` |
| E3 | AutoTask to knowledge | `SourceIngesting` (Source Update drives Library ingestion) | C | CLAUDE.md contract list |
| E4 | Loop to graph-kit | `LoopEngineRunner+CodeGraph` (612 lines), `GraphRescanning` seam; snapshots and verify | C | `Core/Contracts/GraphRescanning.swift` |
| E5 | both to `Core/Repo` | worktrees, branches, MR and PR (`ChangeShipping`) | C (Core) | work-kit E8 |
| E6 | both to `Core/Memory`, `Core/Incidents` | fault reports, self-heal proposals | C (Core) | CLAUDE.md Core list |
| E7 | MobileControl to both | bridges through `MobileBridgeHosting` | C | `MobileControl/CLAUDE.md` |
| E8 | AutoTask to work-kit | `updatePlanStatus` calls `/kb/outcomes/refresh` | C | `+PipelineTasks.swift:1066` |
| E9 | AutoTask to docs-kit | none in code; "Generate Documentation" runs a CLI prompt | — | docs-kit map E14 |
| E10 | os-kit to automation | Loop journal and activity feed the aggregate | C | `kb/os-state.mjs` |

**Cycles:** none found; the cycle rule (Core contracts) holds. **Process-level coupling:** `LoopRunQueue` serializes the Auto Task lane and desktop-started Loop runs on one in-process FIFO per git root (`LoopRunQueue.swift`), and `LoopRunService` owns one runner per (project, loop). Moving either half alone breaks that lock.

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| Fixing a failing stage (agent edits files) | Delegated | `/kb/loop/agent-run` is the SDK agent; it improves as the SDK does. |
| Stage execution and detection (`LoopStageDetector`, shell commands, test map) | Owned | Deterministic checks; the harness is the project's own truth. |
| Repair scope guard, protected paths, no-reward-hacking checks (`RepairScopeGuard` 946, `ProtectedPathRepairGuard`) | Owned | Permission and safety; the central invariant. |
| Verify approval store (`VerifyApprovalStore`) | Owned | Permission, fail-closed. |
| Run journal, event log, interrupted-run reconcile (`LoopRunJournal`) | Owned | Observability; fail-open by contract, crash-safe. |
| Queue and worktree isolation (`LoopRunQueue`, `LoopWorktreeManager`) | Owned | Prevents races in one checkout. |
| Scheduling (60 s timer, cron, lanes) | Owned | Workflow. |
| Token and model caps for runs (`ModelLimitsPanel`, `learned-limits`, tier routing) | Owned | Budget. |
| Task prompt templates | Owned content | User-editable. |
| Review, doc and code-review task bodies (`reviewCode`, `reviewDoc`, `generateDoc`) | Delegated | A CLI prompt; the model does the work. |
| Phone bridges | Owned | Permission switches. |
| `LoopEngineView` (2 167) and AutoTask views | Owned UI | K3. |

## 5. State and data (feeds K1a)

- **Loop contract:** `<projectRoot>/system/loop.json` (a file, committed, travels with the project; `LoopEngineConfigStore.swift:3-10`). Per-user defaults stay in UserDefaults (`LoopEngineDefaults`).
- **Run journal:** `<projectRoot>/system/loop-runs/` with `index.jsonl` and monthly `index-<yyyy-MM>.jsonl` (`LoopRunJournal.swift:142-154`); crash-safe event logs under `Application Support/loop-events` (`:176`).
- **Loop output:** `llm-doc/loop/<key>/` (plan, refactor, summaries) and machine data under a separate data root (`LoopOutputLayout.swift`, D6 move).
- **Auto Task config:** one JSON blob in **UserDefaults** (`AutoTaskConfigStore.swift:16`), corrupt copies stashed in Application Support; run history (`AutoTaskRunHistory`), task logs (`TaskLogStore`), custom tasks, templates.
- **Server:** `usage_ledger` rows for CLI and agent runs; `agent.db` run rows (source `loop`). No queue table.
- **Keychain and secrets:** the CLIs and the vault supply credentials; none stored here.
- **The job runner that does not exist.** The plan's "core job runner" needs: a persisted queue, a lane lock, cancel on quit mapped to journal `.aborted`, process-group kill (`GroupedSubprocess`, 300 lines, exists in Swift), a flake gate, and the rule "the sidecar never restarts under the app". Today the equivalents are in-process Swift (`LoopRunQueue`, `LoopRunJournal.reconcileInterrupted`, `GroupedSubprocess`) and the 60 s `Timer`; the Node server has none, and CLAUDE.md says a feature toggle must **never** auto-restart the backend because it kills in-flight Loop work.

## 6. What K1 would move (proposal)

The plan's step order (job runner first, then the kit) is right. K0 refines it:

1. **Prerequisite, core job runner (new Node module, not in this kit):** persisted `jobs` table (SQLite, user-scoped), lane lock per git root, `cancel`, process-group kill, boot-time "reconcile interrupted" that writes the journal `.aborted` record, and an SSE or poll status route. Exit gate: kill the server mid-run twice; both runs end `.aborted`, no orphan processes, no duplicate run.
2. **K1a data:** decide the run journal's home first (question A2): files under the project (today) stay the truth, the server holds a rebuildable index, matching [data-lifecycle](data-lifecycle.md) rule 4.
3. **K1 in slices, smallest first** (each behind a preference with the Swift path one release behind, per the plan): (a) Auto Task scheduler and run history, (b) Loop contract store and journal, (c) stage detector and test map, (d) the runner and repair guard. The runner (3 271 lines) and the detector (1 964) go **last**; they carry the safety invariants.
4. **Tests before deletion:** `LoopContractLab` checks and the 77 Mac test files port to node tests or a new lab; `RepairScopeGuardTests`, `LoopRunJournalTests`, `LoopRunQueueTests`, `CronExpressionTests` first.
5. **Behaviour-changing work never rides in a K1** (plan rule): no new stage kinds, no prompt changes.

## 7. Decisions needed from the user

| # | Question | Options | Recommended |
|---|---|---|---|
| A1 | Where do Loop and Auto Tasks run in the target: in the Node core (sidecar), or stay Swift until the Mac app is retired? | Node core; stay Swift until K4; both | Node core, **in the slice order above**, so the Tauri app and the relay can start a run; keep the Swift path one release behind a preference |
| A2 | Run journal home: project files under `system/loop-runs/` (today) as the truth with a rebuildable server index, or the server DB as the truth? | files + index; DB | files + rebuildable index (data-lifecycle rules 1 and 4; the journal travels with the project) |
| A3 | Auto Tasks that run the local `claude` CLI: keep the CLI path, or move every task to the Agent SDK engine (`/kb/loop/agent-run` style, metered, confined)? | keep CLI; move to SDK; both | move to the SDK engine; keep the CLI for `codex` and `gemini` if you still want them (the ADR 0018 plan has one company API key, not the user's CLI login) |
| A4 | Scheduling when the desktop is off: nothing runs (the desktop is the main worker, ADR 0018), or the relay may trigger a run on the desktop only when it is on? | nothing runs; relay queues for the desktop | the relay queues requests; the desktop drains them when on (no scheduling on the relay) |
| A5 | Approval of a repair that touches files outside the loop's scope: stays an interactive Mac approval, or may be answered from the phone through the relay? | Mac only; phone allowed | phone allowed only for read-only snapshot approvals already opted in (`224a9179`); edit approvals stay on the desktop until the relay permission re-check is proven |
| A6 | Which Auto Tasks are still wanted? Candidates that duplicate other kits: `generateDoc` (docs-kit), `reviewConflicts` (knowledge-kit), `generateKnowledge` (graph-kit, structural) | keep all 13; drop duplicates | keep until the move; mark the three as thin triggers of their kit's route, not logic owners |
| A7 | Concurrency: stay one run per git root (FIFO) or allow worktree-isolated parallel runs by default? | FIFO; parallel | FIFO by default; worktree parallel stays opt-in (`LoopWorktreeManager`) |
| A8 | The core job runner: one module for Loop and Auto Tasks and later Library ingest, or Loop-specific? | shared; Loop-specific | shared: the plan says job runner is core |

## 8. Risks

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | Largest port (about 33 k Swift lines) and the one with safety invariants (repair guard, fail-closed verify) | 2b | Slice order, tests first, behaviour unchanged, Fable review for the kit |
| R2 | A Node restart kills in-flight runs | CLAUDE.md (never auto-restart on feature change) | Job runner with reconcile-on-boot; sidecar lifetime rule |
| R3 | Orphan processes after a crash | `GroupedSubprocess` exists in Swift only | Port with process-group kill and a kill-mid-run test |
| R4 | Two writers on one worktree (Swift runner and Node runner during the overlap) | `LoopRunQueue` is in-process | One owner per project during the overlap, switched by a preference |
| R5 | Token cost of unattended runs (token review: round-the-clock auto tasks were 99.6% of tokens together with long chats) | memory: token usage review 2026-10-24 | Budget gate and per-user caps before the move, metering kept |
| R6 | Flaky Loop tests hide regressions in the port | plan: "flake gate" | Add the flake gate to the job runner exit |
| R7 | A cron or timezone change in the port changes when tasks fire | `CronExpressionTests` | Port cron first with fixtures |
| R8 | UserDefaults config (Auto Tasks) cannot be read by Node | `AutoTaskConfigStore.swift:16` | K1a: one-way export to a project or server file, N-1 readable |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan's contract group for the kit is `/kb/loop/*`; it is **one route**, `/kb/loop/agent-run`. The rest of the contract does not exist, so K1 creates it.
2. The plan sizes K0 to K2 at 20 to 30 tasks; the code is **32 955 Swift lines across 113 files**, more than any other kit in this folder; the estimate is plausible only with the slice order above.
3. The plan says "core job runner" is a prerequisite; the repo has `kb/agent-jobs.mjs`, which is an **agent-store tick**, not a job queue; the job runner is wholly new.
4. The plan lists the key `auto_tasks` as the kit's key; it also gates the mobile bridges and about 40 test files; the contract group (`/kb/loop/`) is also used by nothing outside the Mac.
5. The Loop contract (`system/loop.json`) and run journal (`system/loop-runs/`) are **files**, so the Loop is closer to the "files stay the truth" rule than the plan's "move into Node" wording suggests.
6. `LoopContractLab` is the Loop's contract gate today (4 062 lines), not an HTTP contract; porting needs an equivalent.

## 10. What I could not verify

- Run-time behaviour: `make loop-gates`, `swift test`, `make feature-matrix` and the server tests were **not run**.
- The exact current default-loop list (taken from the MASTER-PLAN and memory index, not re-read from `LoopTemplate.swift`).
- Which of the 13 Auto Tasks are in daily use (needs the user, question A6).
- Windows and Linux feasibility of the CLI process model and process-group kill.
