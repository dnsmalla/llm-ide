# Auto Tasks audit: what to keep, merge or remove

Date: 2026-10-31, at `main`. **Static analysis only**: code, tests, docs, git history, the iOS source and the shared wire schema. No user data was read (no `kb/data.db`, no Application Support, no agent DB, no notes folder, no project data), nothing was run, no model was called. So **no verdict below is based on how often you use a task**; they are based on what the code does, what it duplicates and what it costs. Section 7 gives you one command that prints your own usage; the REMOVE and MERGE rows are provisional until you have run it. Nothing is deleted by this document.

Your decisions that frame it: Auto Tasks exist so tasks are easy to **command from the mobile app**; **multi-engine stays** (the SDK engine becomes the default for Claude, codex, gemini and the others stay first-class); remove what is not needed.

## 1. Facts that shape every verdict

| # | Fact | Evidence |
|---|---|---|
| F1 | The 13 built-in tasks are a closed enum, plus user-created `CustomAutoTask`. | `Features/AutoTask/Models/AutoTask.swift:7-45`, `Models/CustomAutoTask.swift` |
| F2 | **Every task is already off by default**, the master switch is off, and each task's cron is **disarmed** by default. Nothing runs round the clock on a fresh or untouched install. | `Models/AutoTaskSettings.swift:369-391` (master `enabled` false; every `run*` false), `:294-295` (`isScheduleActive` default false) |
| F3 | Only five of the 13 call an AI CLI (`runCLI(prompt:)`): reviewCode, reviewDoc, reviewConflicts, generateDoc, updateIssues; plus implementIssues (`runCLI(issue:)`) and custom tasks. The rest are deterministic Swift or one HTTP call. | `AutoCodeUpdateService.swift:766-826`; `+CLI.swift:673,1008` |
| F4 | A task run from the phone **ignores the task's own enable flag** and runs once. The only gate is the desktop switch `autoTaskControl` (default OFF). Stop and read-only views need no switch. | `AutoCodeUpdateService.swift:276-289` ("ignoring its enable checkbox"); `MobileControl/Services/PhoneAccessSettings.swift:23,67`; `MobileAutoTaskBridge.swift:117-175,407-409` |
| F5 | With `autoTaskControl` ON the phone can also **edit prompt templates, per-task config and toggles** (`auto_task_template_save`, `auto_task_config_set`, `auto_task_toggle`), so a phone can change what a later run executes. | `MobileAutoTaskBridge.swift:283-400`; `AutoTaskSetupMessages.swift` |
| F6 | Auto Task runs spawn the `claude` CLI (`-p`, `--permission-mode acceptEdits`, metered JSON, 30/120 max turns), or **`codex exec --yolo`** or **`gemini --yolo -p`**. The last two disable the CLI's own sandbox and are metered with no tokens. Cursor, Copilot, DeepSeek, GLM and custom have no unattended form and are skipped. | `Core/Platform/AICliTool.swift:175-200`; `ClaudeLink/ClaudeCLI.swift:25-37`; `+CLI.swift:449-483,1040-1180,574-581` |
| F7 | Each CLI run executes in a throwaway **git worktree** off HEAD, never the user's checkout; implement runs get a `fix/*` branch. | `+CLI.swift:1066-1105` |
| F8 | The Node side has **no Auto Task runner**. It has the engine pieces (CLI spawn layer, SDK confined agent) and a job-runner library not wired to any route. | `docs/kits/automation-kit.md` 2a; `docs/spec/job-runner.md` header |
| F9 | The Node CLI layer runs codex with `-s read-only` and gemini with its default approval, and says outright that auto-approving writes (`--yolo`) is "opted into per-task by the auto-task runner". The Node side has no such runner, so **there is no Node path today for a codex or gemini task that edits files**. | `extension/providers/providers.mjs:555-590` |
| F10 | The generate-doc, review-conflicts and update-issues default templates are all **read-only prompts whose output goes to the task log**; nothing persists. | `Core/Platform/Config.swift:630-632` |

## 2. Inventory (13 built-in tasks)

Columns are cut to what decides the verdict. "Trigger" means all can be started by cron (if armed), the desktop button and the phone `auto_task_run`; the only exception is noted. Default enabled is **off for all** (F2). Engine: C = `claude` CLI, X = codex CLI, G = gemini CLI (chosen by tier route `TierRouting.resolve(.autoTasks, localCLIOnly: true)` or `activeCLI`, F6), SDK = none today for Auto Tasks (the Loop uses it via `/kb/loop/agent-run`). Size is the task body in `AutoCodeUpdateService*.swift` (the shared runner, about 3,600 lines for the three service files, is common to all). Last change: from `git log -S`/subjects under `Features/AutoTask`; "move only" means the body is unchanged since the 2026-09-16 move commit `1c13da61`.

| Task (enum) | Purpose | Engine | Reads / writes | Overlap | Swift size (body) | Last change | Tests | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **sourceUpdate** | Fetch email and Slack into the Library and re-index | none (Library ingest, `SourceIngesting`) | reads connectors; writes notes folder; no repo | knowledge-kit connectors (Pattern A/B), `SourcesStore` | ~55 + Library ingester | move only | no direct test (`runSourceUpdate` unreferenced) | no model call in the task | network reads, notes writes, no repo | **KEEP** (as `sources.update`) |
| **sourcesToIssue** | Extract action items from recent notes, create upstream issues | none (deterministic `NoteActionExtractor`) | reads notes index; **writes issues on GitHub/GitLab** (allow-listed) | Issues feature; `updateIssues` does the same by prompt | ~165 | 2026-10-16 (dedupe, approval label) | `runSourcesToIssue` + body helpers in `PipelineTasksTests` | none | posts to tracker (create-issue allow-list) | **KEEP** (absorbs updateIssues) |
| **implementIssues** | Run the CLI on approved issues in a worktree on a `fix/*` branch | C/X/G (`runCLI(issue:)`, 120 turns for C) | reads issues; **edits files in a worktree, commits locally** | Loop repair (confined SDK agent); chat Execute | ~150 + ~320 (`runCLI(issue:)`) | 2026-10-16 (park failed branch, worktree) | approval label, worktree, cancel, CLI tests | **High**: 120-turn cap, the one task that burns real tokens | writes code; needs approval label on the issue | **KEEP** (the phone's "do this issue") |
| **reviewMerge** | Push local `fix/*` branches and open MR/PR (no auto-merge) | none | reads branches; **pushes, opens MR/PR** | `LoopShipCoordinator` + `Core/Repo` `ChangeShipping` (same ship step) | ~115 | 2026-10-16 | `ReviewMergeCandidatesTests` | none | **pushes to a remote**; needs push + createPR allow-list and a token | **MERGE** into implementIssues as the opt-in "ship" step |
| **reviewCode** | Read-only code review of HEAD in a worktree | C/X/G | reads repo; writes only the task log; skipped when HEAD unchanged | chat review mode; Loop skill stages | ~70 + ReviewSkip 42 + shared `runCLI(prompt:)` ~280 | 2026-10-24 (HEAD-signature skip) | `ReviewSkipTests`, `ComposedPromptTests` | medium (30 turns), skipped when HEAD unchanged | low (read-only), but `acceptEdits`/`--yolo` still allow writes inside the worktree | **KEEP** (as `review`, with `focus: code`) |
| **reviewDoc** | Same, for docs | C/X/G | same | same; docs-kit | shares reviewCode body | 2026-10-24 | shared | medium | low | **MERGE** into `review` (`focus: doc`) |
| **reviewConflicts** | Prompt asking the CLI to list merge conflicts | C/X/G | reads repo; log only | **`Features/ReviewConflicts`** (a Library entry, different thing) and `git diff --check` / `git ls-files -u`, deterministic | ~12 | move only | none (`reviewConflicts` unreferenced in tests) | medium for something git answers for free | low | **MERGE** into `review` (`focus: conflicts`, deterministic first) |
| **regression** | Re-ask past `status: fixed` fault reports, reopen regressed ones | `/kb/complete` (plain completion) via `LoopRunnerProvider` | reads fault reports; writes reports; optional repair edits | **the Loop's default Regression loop** and the `loopEngineering` sweep | ~85 + `RegressionRunner` 534 | 2026-10-23 (sweep), 2026-09-30 (repair guard) | `regressionSweepSummary` x6, 50 test files mention regression | medium | `attemptRepair` default off; runs verify commands | **MERGE** into Loop (`loop.run` with loop = regression) |
| **generateKnowledge** | **Report** the state of the graph and memory | none | reads `graph.json` and lists memory file names; log only | graph-kit (generation is automatic via `GraphAutoUpdater`) | ~35 | move only | one test (clears stale error) | none | none | **REMOVE** |
| **generateDoc** | Prompt: write docs for recent changes, "READ-ONLY... output markdown" | C/X/G | reads repo; **output only in the task log** (F10) | **docs-kit** (`Features/Generation/DocGen`, phone `generationRun`) | ~12 | move only | none for the task (`GenerateDocFailureTests` covers the Doc Gen feature, not this task) | medium for output nobody files | low | **REMOVE** (docs-kit owns generation) |
| **updateIssues** | Prompt: review changes, "create a new issue" through the tracker | C/X/G | reads repo; tries the tracker from inside a CLI | `sourcesToIssue` (deterministic, allow-listed) and the Issues feature | ~12 | move only | none | medium | the CLI path has no allow-list (sourcesToIssue does) | **MERGE** into sourcesToIssue |
| **updatePlanStatus** | Call `POST /kb/outcomes/refresh` | none | writes `outcomes` rows | **the server's own background poller** (`startBackgroundOutcomePoller`, `server.mjs:1316`, `agents/outcome-watcher.mjs:251`) | ~40 | move only | none | none | none | **REMOVE** |
| **loopEngineering** | Run the project's scheduled Loops (the sweep) | SDK for agent steps (`/kb/loop/agent-run`), shell stages | writes under `system/loop-runs/`, repairs inside scope | it is the Loop | ~220 | 2026-10-24 | `LoopEngineeringTests` (2 files), `LoopLaneTests` | medium to high when repairs run | repair edits inside declared scope; protected paths | **KEEP** (the `loop.run` job; absorbs regression) |

Custom tasks (user-created prompts with their own cron and project): same runner, `persistChanges` can create a branch. **KEEP** as the generic `custom.run` (a named prompt, typed args); they are the answer to "any task I want to command".

Totals: **KEEP 5** (sourceUpdate, sourcesToIssue, implementIssues, reviewCode as `review`, loopEngineering), **MERGE 5** (reviewMerge into implementIssues, reviewDoc and reviewConflicts into `review`, regression into Loop, updateIssues into sourcesToIssue), **REMOVE 3** (generateKnowledge, generateDoc, updatePlanStatus), **OFF-BY-DEFAULT 0** (all 13 already are, F2; the risky ones simply stay desktop-approval-only, section 3).

The three duplicates the automation-kit K0 named (A6): **generateDoc** (docs-kit), **reviewConflicts** (knowledge-kit / Review Conflicts), **generateKnowledge** (graph-kit). The audit adds two more duplicates the K0 did not: **updatePlanStatus** (the server poller already does it for every user) and **regression** (a Loop). Plus updateIssues vs sourcesToIssue, and reviewMerge vs the Loop's ship coordinator.

Cost profile (needs your data to confirm): the repo's own token review (memory `token-usage-review-2026-10-24`, 99.6% of tokens = long v2 chat turns plus unmetered round-the-clock auto tasks) predates two fixes visible in git: Claude Auto Task runs are metered and turn-capped (`feat(mac,server): meter Claude Code auto-task tokens and cap turns`, 2026-10-24) and review runs skip when HEAD is unchanged. Everything is off by default (F2), so a quiet install costs nothing; a user who armed an hourly cron on several CLI tasks costs the most. codex and gemini runs are still unmetered in tokens (F6).

## 3. (a) The phone-command surface that must survive

What the phone does today (iOS `AutoTaskStore`, `AutoTaskView`, wire `AutoTaskMessages`, `AutoTaskSetupMessages`, `LoopMessages`; about 2,100 iOS lines): `auto_task_list/state`, `auto_task_run(task?)`, `auto_task_stop`, `auto_task_toggle`, `auto_task_history`, `auto_task_logs_list/reply`, `auto_task_setup_list/reply`, `auto_task_config_set`, `auto_task_template_save/rename/delete`, and `loop_status_list/state`, `loop_start`, `loop_start_stage`, `loop_stop`, `loop_history`.

**Target core API (job-runner based).** Build on `docs/spec/job-runner.md` (persisted `jobs` table with `user_id`, `kind`, `lane`, state machine, per-user lane lock, cancel, quota, boot sweep). The phone stops talking to Auto Task internals and talks to jobs:

| Call | Shape | Rules |
|---|---|---|
| `enqueue` | `{ kind, args }` with `kind` from a closed registry and `args` validated by a per-kind schema (typed: ids and enums, **never a path, a command or free prompt text**; free prompts only through a saved custom task's id) | per-user; the kind's declared `tier` decides the next step; returns `jobId` |
| `list` | per-user jobs, newest first, paged | read-only |
| `status(jobId)` | state, current step label, counts, last error (fixed codes, redacted) | read-only |
| `cancel(jobId)` | idempotent; queued becomes cancelled, running aborts the process group | needs no approval (stop is always allowed) |
| `result(jobId)` | bounded, redacted result and log tail, paged | read-only |
| `kinds` | the registry with each kind's tier and arg schema | read-only |

**Registry (what the 13 collapse to):** `review` (focus: code, doc, conflicts), `sources.update`, `issues.from_notes`, `issues.implement` (with optional `ship`), `loop.run` (loop id or stage id), `custom.run` (saved custom task id). Six kinds replace 13 enum cases.

**Tiers, reconciled with the relay design.** The relay design fixes two things (D1, D2): queued phone requests run under a **fixed read-only ceiling** that ignores the desktop's mode, and start of a Loop or Auto Task is **native iOS and desktop only, never the PWA**. Today's Swift behaviour is weaker than that (F4, F5): a phone with `autoTaskControl` ON can run `implementIssues` and `reviewMerge`. The target:

| Tier | Meaning | Kinds | Approval |
|---|---|---|---|
| **T0 read-only** | May be started from the phone with **no desktop approval**; runs under the remote-safe ceiling (read, search, no shell, no network-fetch, no writes) on the **SDK engine** in a throwaway read-only checkout | `review` (all three focuses), plus `list`, `status`, `result`, `cancel`, `kinds` | none; **native iOS only** (D1: not the PWA) |
| **T1 desktop approval** | The phone can only **enqueue a request**; it sits `awaiting_approval` until the user approves it **on the desktop** (permission re-checked at execution time, per user) | `sources.update` (writes notes, uses connector credentials), `issues.from_notes` (posts issues), `loop.run` (edits inside scope, runs verify commands), `custom.run` | desktop click, every time |
| **T2 desktop approval plus explicit per-run confirm** | Writes code or leaves the machine | `issues.implement`, and the `ship` step (push, open MR/PR) | desktop click showing the exact issue ids or branches; **never from a queued remote request without the click; never inherits Bypass** |

Never phone-editable under any tier: templates, task config, schedules, allow-lists, model routing. Today's `auto_task_template_*`, `auto_task_config_set` and `auto_task_toggle` become **desktop-only**; the phone keeps read access to them. That is consistent with D1 (writes and approvals on desktop and native only) and with H2/T5 in the relay review.

The relay review's rule stands for the transport: a queued request is a typed envelope, expires on the receiver side, and the desktop re-checks permission when it executes, not when it was queued. Jobs enqueued from the phone are tagged `origin: remote`; the job runner refuses any T1 or T2 kind for an unapproved remote job and refuses any job whose turn would attach `desktop.*` (Phase 7 design 5.4).

Today, until the Node core owns this, the Swift bridge keeps working unchanged (the Tauri app does not host `:3006`, Phase 5 plan section 9). The only Swift change worth doing early, and only if you confirm it, is to make the three phone-editing messages (template, config, toggle) require the desktop; that is a behaviour change, so it is not done here.

## 4. (b) Engine abstraction

**What exists today in Swift.** One function, `runCLI(prompt:)` / `runCLI(issue:)` in `AutoCodeUpdateService+CLI.swift`, builds a `Process`:

1. Pick the tool: a tier route (`autoTaskRoute()` -> `TierRouting.resolve(feature: .autoTasks, localCLIOnly: true)`, `+CLI.swift:567`) or `AICliTool(rawValue: config.activeCLI)`.
2. Ask the usage chain for a model (`resolveModelForRun`, `:448`), which can pause the run or step down within the same provider; pass it as `--model` (`modelArgs`, `:577`: claude, codex, gemini accept it).
3. Compose argv: executable from the tool (`AICliTool.swift:161`), `unattendedPermissionArgs` (claude only: `--permission-mode acceptEdits`), then `nonInteractivePromptArgs(prompt)`: claude `-p`, codex `exec --yolo`, gemini `--yolo -p` (`AICliTool.swift:189-196`); a tool with no form returns nil and the run is skipped before any worktree exists.
4. Create the worktree, set `cwd`, close stdin, stream stdout/stderr to the log. Claude alone gets `ClaudeCLI.meteredRunArgs` (JSON result, `--max-turns`), so tokens are recorded; codex and gemini record a run with no tokens (`recordRun`, `:484`).
5. Login: the CLIs use their own login (`claude login`, `codex login`, `gemini`); the vault API key is the other path and only the Claude/SDK side uses it.

**What the Node side has.** `extension/providers/providers.mjs`: `PROVIDERS` (vault key, env, `cli` per provider), `cliInvocation(provider, prompt, {cwd, model, isolated})` with `CLI_ARG_BUILDERS` (codex `exec -C <cwd> -m <model> -s read-only --`, gemini `-m <model> --prompt=<p>`), `cliModelId` (argv-safe model ids), `providerHasCli`, `cliBinFor` with `LLMIDE_<PROVIDER>_CLI` overrides, a concurrency cap and a sanitized child env (no `LLMIDE_JWT_SECRET` or vault key leaks into codex/gemini), `providers/route-health.mjs` (is the CLI logged in), `providers/tier-routing.mjs` (feature routes; `UNTRUSTED_INPUT_FEATURES` already keep untrusted text away from the keyless codex/gemini agent CLIs), `providers/adapter-complete.mjs` and `web-client.mjs` (API-key HTTP completion, no tools). For agents: `llm_agent/sdk/loop-agent.mjs` (confined SDK run, Claude only). For spawning: `core/process-group.mjs` and the job runner's `ctx.spawn` (own process group, sanitized env, kill on abort).

**Gaps to close for multi-engine Auto Tasks in Node** (do not start before the matching decisions are confirmed):

| Gap | Why it matters | Proposal |
|---|---|---|
| G1: an `engine` interface | Today the choice is spread over the tier route, `activeCLI` and `AICliTool` switches | One interface `runTask({ provider, model, prompt, cwd, mode: 'read' \| 'write', signal, spawn }) -> { text, usage?, stopReason }`; implementations `sdk` (Claude, default, confined, metered), `cli:codex`, `cli:gemini` (login path), `api` (key path, text only). The job runner passes `ctx.spawn` so every CLI is process-group killed |
| G2: write mode for codex and gemini | F9: Node only knows read-only codex and unflagged gemini; Swift uses `--yolo` | A `write` mode builder that uses the CLI's **workspace-write** sandbox where the CLI has one (codex `-s workspace-write`, not `--yolo`), always inside a worktree, always desktop-approved (T2); `--yolo`/sandbox-off only as an explicit per-task opt-in with a visible warning, as today. Do not copy the Swift `--yolo` default |
| G3: key path vs login path | Both must remain | `engine.credential = login \| key` resolved per provider by the vault and `route-health`; **write tasks on codex/gemini are login-path only** (an API-key HTTP completion has no tools and cannot edit); the SDK engine handles Claude on both login and key. If you want write tasks on an API-key-only OpenAI or Google account, that needs a provider-neutral tool loop, which does not exist (the classic loop was retired, memory `agent-kit-sdk-only-decision`) |
| G4: metering parity | codex/gemini runs record no tokens | Parse what each CLI prints where it prints usage, else record a run row with `tokens: null` and show it as "not metered" rather than zero |
| G5: confinement parity | The SDK path denies a refused tool instead of asking; CLI agents decide for themselves | CLI engines run only in a worktree, with the T0 ceiling forcing read-only modes, so remote-origin jobs can never reach a CLI with write flags |
| G6: model fallback | The usage chain steps down inside one provider | Keep `resolveModelForRun`'s contract as an engine pre-step (same endpoint `/kb/usage/...`), engine-agnostic |

Keeping both credential paths means: the job's `engine` field is `{provider, credential}`; a missing login for a CLI engine or a missing key is a fixed, typed error (`engine_not_logged_in`, `engine_no_key`), shown on the phone as text, never as a silent fallback to Claude (the repo's standing rule for `runClaude`).

## 5. (c) Removal plan (nothing deleted now; you confirm per task)

For each task marked REMOVE or MERGE, after you confirm. Common to all: the enum case and its switch arms in `AutoTask.swift` (`label`, `icon`, `logSuffix`, `templateBinding`, `resetTemplate`, `isStructural`, `requiresLinkedRepo`), `AutoTaskSettings.run*` plus its UserDefaults key (read old keys, ignore them), `isTaskEnabled` and `runTaskBody` arms in `AutoCodeUpdateService*.swift`, the `enabledOrder` list, the phone's task list (the Mac sends `AutoTaskInfo` from `AutoTask.allCases`, so the iOS list shrinks with no iOS change), and old stored history records with a removed `taskId` must still decode (the record stores a string; the UI should show them as "retired task").

| Task | Delete in Swift | iOS wire / app | Docs | Tests |
|---|---|---|---|---|
| **generateKnowledge** (REMOVE) | `reportKnowledge` (`+PipelineTasks.swift:719`), the `.generateKnowledge` filter in `runPipeline` (`AutoCodeUpdateService.swift:1009-1014`), `runGenerateKnowledge` | none (it is a string id in `AutoTaskInfo`) | automation-kit 2b, `docs/spec/macos-app.md` Auto Tasks lines, help text `HelpGuideView` | `testReportKnowledgeClearsStaleTaskErrorWhenNothingToGraph`; `AutoTaskSettings*` rows naming it |
| **generateDoc** (REMOVE) | `.generateDoc` arm, `AppConfig.defaultTemplateGenerateDoc` and `autoTaskTemplateGenerateDoc` (keep the UserDefaults key readable), the template-store seed row (`AutoTaskTemplateStore.swift:360` region), `purposeMode: "document"` path if unused afterwards | none | docs-kit E14 note, automation-kit A6, help text | `AutoTaskConfigStoreTests` (uses the id `generateDoc` as sample data) and template tests naming it; `GenerateDocFailureTests` is the Doc Gen feature and stays |
| **updatePlanStatus** (REMOVE) | `refreshPlanStatuses` (`+PipelineTasks.swift:1068`), `.updatePlanStatus` arms, `runUpdatePlanStatus`; the server poller stays and stays the only owner | none | work-kit E8, automation-kit E8 | any settings test iterating all cases |
| **updateIssues** (MERGE into sourcesToIssue) | `.updateIssues` arm, `defaultTemplateUpdateIssues`, the seeded template row | none | help text, spec | template and settings tests naming it |
| **reviewDoc**, **reviewConflicts** (MERGE into `review`) | the two enum cases collapse into `review(focus:)`; keep the two prompts as focus presets; replace the conflicts prompt with a deterministic `git ls-files -u` / `git diff --check` pre-check | the phone's `auto_task_run(task: "reviewDoc")` ids keep working through an alias table for one release | automation-kit, help text | `ReviewSkipTests` stays; add alias tests |
| **regression** (MERGE into Loop) | `.regression` arm and `runRegressionSweep` (`+PipelineTasks.swift:759`); the Loop's Regression loop is the surviving path (`LoopRunnerProvider.runRegressionSweep` stays) | the phone's id `regression` aliases to `loop.run(loop: regression)` | automation-kit | `testRegressionSweepSummary_*` move with the function; `AutoTask*LoopEngineeringTests` stay |
| **reviewMerge** (MERGE into implementIssues `ship`) | none in Swift until the Node job exists: it becomes a step shared with `LoopShipCoordinator` / `ChangeShipping` | alias for one release | work-kit, automation-kit | `ReviewMergeCandidatesTests` move with it |

Order: the three REMOVE rows first (smallest, no model, no data), and only after your usage command shows zero runs. The MERGE rows ride with the Node port (automation-kit A7), not before; doing them in Swift first would be work the port deletes.

## 6. Findings that are surprising

1. **Phone run ignores the enable flag and can start the two risky tasks.** A phone with `autoTaskControl` ON can start `implementIssues` (edits code) and `reviewMerge` (pushes and opens MR/PR) once, although both are disabled on the Mac (F4). This is gated only by one desktop switch that defaults off. It is weaker than the relay design's fixed read-only ceiling (D2).
2. **The phone can edit what a task will run** (templates, config, toggles; F5). Under D1 these are write actions and must be desktop-only. The existing template approval (`noteUnapprovedTemplate`) protects against changes made outside the app but not against the phone, because a phone save goes through the app.
3. **Three tasks produce nothing durable.** generateKnowledge reports to a log, and generateDoc/reviewConflicts/updateIssues default to "READ-ONLY ... output" with output only in the log (F10). They cost model turns for text that is not filed anywhere.
4. **updatePlanStatus does what the server already does for every user** every poll interval; the task can only add a second, manual call of the same route.
5. **codex and gemini auto tasks run with their sandbox off** (`--yolo`, F6) and are the only unmetered tokens; the Node layer deliberately never passes `--yolo` and has no write mode (F9). The Swift default is the broadest permission surface in the app.
6. **The evidence is thin by design.** The Mac keeps only the newest 200 runs across all tasks (`AutoTaskRunHistory.swift:38`), so a frequently cron-fired task evicts the others; the server ledger meters only the CLI-backed tasks. That is why the usage script reads both and says which source a number came from.
7. **Test coverage is uneven**: no direct test mentions `runSourceUpdate`, `refreshPlanStatuses`, `runReviewMerge` (only its candidate selector), reviewConflicts or updateIssues; the safety-critical tasks (implement, regression, Loop, review skip, worktrees, cancel, phone scope) are covered.

## 7. (d) Confirm your own usage (you run it; I did not)

**Where the app shows it:** the Auto Tasks page lists each task's last run and result; the run history behind it is `auto-task-runs.json` in the app's Application Support folder (newest 200 runs, all tasks). The Loop page has its own journal. The phone's Auto Tasks screen shows the same list and history.

**A command that prints counts only.** `scripts/auto-task-usage.mjs` is read-only: it opens `auto-task-runs.json` and the server database with `readonly: true`, prints per task the run count, last run date, success rate, how many ran from cron or phone, and the ledger's run count and last date. It prints no log line, summary, project, path, prompt or issue text, and writes nothing. Run on your Mac, from the repo:

```
node scripts/auto-task-usage.mjs
```

Defaults: history `~/Library/Application Support/llm-ide/auto-task-runs.json`; database from `--db`, else `LLMIDE_DB_PATH`, else `$LLMIDE_DATA_DIR/data.db` (the Mac app uses `~/Library/Application Support/llm-ide/system/data.db`), else the repo `kb/data.db`. If your database is in the app folder:

```
node scripts/auto-task-usage.mjs --db "$HOME/Library/Application Support/llm-ide/system/data.db"
```

(`--json` prints the same as JSON.) It needs the repo's `extension/node_modules` (better-sqlite3); if you see "Server usage ledger: not found" with a database path you know exists, run `cd extension && npm install` first.

**How to read it:** `runs 0` and `ledger runs 0` for a task means it did not run in the retained window. Rule I propose, for you to confirm per task: REMOVE rows with 0 runs and no cron armed; MERGE rows regardless of use (they keep their function, only the name changes); anything the phone ran (`phone` column above 0) stays reachable through the alias table.

## 8. Decisions for you

| # | Question | Recommendation |
|---|---|---|
| T1 | Remove generateKnowledge, generateDoc, updatePlanStatus? | Yes, after the usage command shows zero runs; none of them has a function that another feature does not already own |
| T2 | Fold updateIssues into sourcesToIssue, reviewDoc and reviewConflicts into `review`, regression into Loop, reviewMerge into implementIssues as `ship`? | Yes, in the Node port, with a one-release alias table so the phone keeps working |
| T3 | Make template save, config set and toggle desktop-only (the phone keeps read access)? | Yes (matches D1); behaviour change in the Swift bridge, so only on your word |
| T4 | Should a phone ever start `implementIssues` or `ship`? | Only as an enqueued request approved on the desktop each time (T2 tier); never directly |
| T5 | Is `--yolo` still wanted as the codex and gemini default for Auto Tasks? | No: workspace-write sandbox by default, `--yolo` as a per-task opt-in with a warning |
| T6 | Do you want write tasks on an OpenAI or Google **API key** with no CLI login? | Not without a provider-neutral tool loop; confirm whether you need it or login-only is enough |

Answered by your messages today (recorded in the Phase 5 plan and MASTER-PLAN): multi-engine is kept, the phone-command surface is kept, removals wait for evidence.
