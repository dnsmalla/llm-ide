# Unified Task Registry Implementation Plan (2026-11-10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status 2026-11-10 (Task 16 closed).** Tasks 1–15 are on `main`; Task 16 is done on this branch. The registry is the only task catalog: the dead bridge screen `AutoTasksScreen.tsx`, the Mac-only set and the "Mac app only" copy are deleted; the usage ledger resolves through the registry (`loopEngineering` aside, below); the reference is `docs/reference/task-registry.md`. Carry-overs A–D from Tasks 14–15 are fixed, except C, which is correct as written and reported below.

Known limits (also in `docs/reference/task-registry.md`): (1) Factory stages carry no `promptRef`, so a registry prompt change does not reach existing Factory loops. (2) `loop.refactor_apply` and `loop.refactor_conform` are registered `available`, but the Loop still refuses an enabled batch stage because batch rollback is not ported; the registry should say `unported`. (3) `loopEngineering` has no registry entry. (4) The Loop page's own cron is a second scheduler and fires only while the Loop page is open. (5) Custom Implement mode still says "Mac app only" (custom tasks are not registry tasks). (6) `ui/screens/bridge/` lost its only importer and is still present.

Checkboxes: Task 16 steps 1–4 are ticked. Tasks 1–15 were not re-verified step by step in this pass, so their boxes stay unticked.

**Goal:** One implementation per task, referenced by Auto Tasks, Loop templates/stages, the Factory/Ship pipeline and the review surfaces, so a prompt, policy or runner change reaches every surface; migrate one task per commit; delete the duplicated prompts and catalogs only after both surfaces read the registry.

**Architecture:** A data registry at `schema/tasks/registry.json` (plus `schema/tasks/prompts/` and `schema/tasks/templates.json`) is the only place a task id, label, prompt, runner, schedule policy, read-only policy, feature gate and availability reason live. A generator produces two runtime copies plus two prompt modules: `ui/screens/tasks/registry.generated.ts` + `ui/screens/tasks/prompts.generated.ts` for the desktop UI, and `extension/core/task-registry.generated.mjs` + `extension/core/task-prompts.generated.mjs` for the Node core. All four generated files are byte-checked by `scripts/conformance-tasks.mjs`, exactly as `schema/bus/registry.json` is copied to `extension/routes/bus/registry.json` today (`scripts/conformance-bus.mjs:30-35`). Auto Tasks, Loop, Factory, Ship and the review screens import the generated catalog; no surface keeps its own prompt table. Execution has one contract with two adapters: the desktop adapter `ui/screens/tasks/runner.ts` handles `shell` and `desktop-action` tasks (they need the Tauri host), and the core adapter `extension/agents/task-runner.mjs` handles `agent` and `core-route` tasks. The desktop adapter calls the core adapter over `POST /kb/tasks/:id/run` for every task the core can run, so there is never a second prompt or a second route implementation.

**Tech Stack:** Node 22 core (pure `node:http`, better-sqlite3, `node:test`, ES modules), React 19 screens under `ui/screens` (node `--test --experimental-strip-types`), Tauri host commands in `desktop/src-tauri/src/`, TypeScript 5.9. No new dependency.

**Spec:** This plan is the design record for the user goal. It is grounded in the command-bus contract (`docs/spec/command-bus.md`, especially §5 and §10), the Auto Tasks audit (`docs/superpowers/plans/2026-10-31-auto-tasks-audit.md`, especially §2 and §5) and the code as of `main` at `a4cc5c065`. Where this plan and those documents disagree, this plan's decision table (§7) says why.

**Revision after review R-037 (2026-11-10).** Revised after `agent-coord/reviews/R-037-unified-task-registry-plan.md`; the user accepted every recommendation in §7, including D14-D17. **Prerequisite:** REQ-019 groups A-C (review R-036) are pushed first, because they change `factory.ts`, `stage-exec.ts`, `run-manager.ts`, `ship-model.ts`, `ShipPanel.tsx` and `loop-agent.mjs`, which Tasks 7, 8 and 14 rewrite. Before Task 1, re-check every `file:line` in this plan against the new `main`; the numbers here are from `a4cc5c065`.

---

## Global constraints

- **Module boundaries are not negotiable.** `extension/core` imports nothing internal; `extension/agents` may import L0–L2 plus `connectors/`, `graphkit/`, `guardrails/`; `extension/routes` may import any Node layer; **no layer below L4 may import a route module** (L4 may import a sibling route module, as `routes/bus/executor.mjs` already does). The ESLint allow-table in `extension/eslint.config.mjs` stays at zero violations. The new core runner lives in `agents/`, never in `routes/`.
- **The desktop UI cannot import `extension/`.** `ui/screens/loop/native/factory.ts:156-157` already documents this for prompt-fence neutralisation. The shared catalog is therefore generated data, not a cross-package import. Do not add a `ui` → `extension` import to "fix" duplication.
- **Prompts live in `schema/tasks/prompts/<task-id>.md` and nowhere else in hand-written code.** The generated `prompts.generated.ts`/`task-prompts.generated.mjs` are byte-checked copies, never hand-edited. A task with `runner.kind` `shell`, `core-route` or `desktop-action` has **no** prompt. An `agent` task's prompt is the file named by `prompt`. This is the "no fake prompts" rule: a deterministic task never gets an invented agent prompt, and a missing prompt is a typed `TASK_NOT_PROMPTABLE`, never a fallback string.
- **No agent fallback.** A task either declares an agent runner with a real prompt/skill or it is `unported`/`retired`. The runner never turns a shell/core/desktop task into an agent call when its own runner fails.
- **One task per commit**, Conventional Commits, one concern per commit. A migration task deletes the old prompt/catalog entries it replaces in the same commit only when the test proves both surfaces read the registry entry (see each task's "delete old duplicate" step).
- **Do not delete a duplicate before both surfaces use the registry.** For each task: add the registry entry, rewire both surfaces behind a test, prove the old text is no longer read, then delete it. The final cleanup task (Task 16) is the only place the old global catalog and dead bridge screen are removed.
- **`SERVER_API_VERSION`** is `135` (`extension/server.mjs:456`). Every task that adds a wire route bumps it by one in its own commit, adds the route to `ALL_ENDPOINTS`, adds an `schema/http` contract with fixtures, and runs `node scripts/gen-api-types.mjs` and `node scripts/gen-openapi.mjs`. A task that only moves code between layers does not bump it.
- **Feature gates:** a task declares `features` (a list). `auto_tasks` gates the Auto Tasks/Loop surfaces (`ui/screens/shell/features.ts:57-66`); `doc_gen` gates `/generate-doc` (`extension/routes/feature-routes.mjs:43-46`); `gantt_issues` gates issue writes (`extension/routes/feature-routes.mjs:35-38`). A task is runnable only when every listed feature is enabled in both the UI pref set and the core's `/health.features`. The list is **capability** gates, not surface ownership: the `/kb/tasks` route group already carries `auto_tasks`, so a core task that is also reachable from the bus lists only its extra requirement (`gantt_issues`, `doc_gen`) or `[]`.
- **Remote mode:** the desktop UI in remote mode shows only `REMOTE_SECTIONS` (`ui/screens/shell/sections.ts:147`), which excludes `autotasks` and `loop`. A task whose runner needs the local host sets `requiresLocalHost: true`; the runner refuses it with `LOCAL_ONLY` and the UI never lists it in remote mode. Remote clients reach core tasks through the command bus, never through a local path.
- **No new store.** Task config uses the existing `localStorage` pattern and `system/loop.json`; schedules use the existing five-field cron parser. No SQLite migration is needed for the registry (it is checked-in data). A later bus change may add a `cron` column, but this plan does not.
- **One exception to "no new store" (D15):** Task 9 adds one append-only migration for the durable Sources → Issue record. Without it the task would re-create issues on every run.
- **The run route is desktop-only (D14).** `POST /kb/tasks/:id/run` requires the bus host proof (`verifyBusHostProof`, as `routes/issue-writes.mjs:140` does). A JWT-only caller (web app, Chrome extension, remote desktop) and every caller on a hub gets `403 HOST_PROOF_REQUIRED`. Remote clients keep using the command bus and its tiers.
- **Nothing that writes code or a tracker runs unattended (D17).** `issues.implement`, `review.merge` and `issues.from_notes` are `schedule.backend: "none"`. The Task 15 migration switches `scheduleActive` off for every task whose runner changed, so a schedule saved while the task could not run never starts firing by itself. A scheduled `shell` task reuses a live host approval or is skipped; it never opens the native approval dialog.
- **Scheduled agent runs are metered and capped.** Every agent task run writes its ledger row with the task id, and a scheduled run is refused (`USD_CAP`) when the member or project budget is reached, through the same resolver a chat turn uses.
- **Tests fail before the change.** Every migration names the test and the assertion that fails on the current code. A test that passes on both sides is not a regression test for this plan.
- **No user-visible "Mac app" wording.** The Mac app was removed on 2026-11-06. `MAC_ONLY_MESSAGE` (`ui/screens/autotasks/native/model.ts:74`) and `macBatchReason` (`ui/screens/loop/native/store.ts:68-75`) must be replaced by registry availability reasons that name the real missing capability.

---

## 1. Inventory: every duplicated task

Line numbers are from `main` at `a4cc5c065`. "Kind" is what the current implementation is, not what it should be: **UI-only** (a label/checkbox with no runner), **agent prompt** (text sent to a model), **shell stage** (host command / deterministic stage), **core route** (Node HTTP handler), **desktop action** (host/Factory/Ship work in the webview).

### 1a. Auto Tasks catalog (`ui/screens/autotasks/native/model.ts`)

`AutoTaskId` is the closed union at `:5-8`; `TASKS` is the 12-entry catalog at `:25-38`; `MAC_ONLY_TASK_IDS` is the 7-entry disabled set at `:71-74`.

| Auto Task id | Label | Prompt / logic location | Kind | Duplicate elsewhere |
|---|---|---|---|---|
| `sourceUpdate` | Source Update | `model.ts:26`; also in `MAC_ONLY_TASK_IDS:72` | agent prompt **standing in for** a deterministic sync | `schema/bus/registry.json:68-83` kind `sources.update`; `extension/routes/bus/sources-update.mjs:65-110`; Library source Update UI (`ui/screens/library/extensions/legacy.ts:523`) |
| `sourcesToIssue` | Sources → Issue | `model.ts:27`; `MAC_ONLY:72` | agent prompt standing in for note extraction | bus kind `issues.from_notes` (`schema/bus/registry.json:84-101`, `available:false`); `GET /kb/search?kind=action` (`extension/routes/router.mjs:295-321`, `extension/kb/db.mjs:221-260`); `/kb/issues/create` (`extension/routes/issue-writes.mjs:129-180`) |
| `implementIssues` | Implement Issues | `model.ts:28`; `MAC_ONLY:72` | agent prompt standing in for Factory | Factory `Implement` stage (`ui/screens/loop/native/factory.ts:52`); `run-manager.ts:220-230`; Issues → Factory (`ui/screens/issues/index.tsx:17-28`); bus kind `issues.implement` (`schema/bus/registry.json:102-121`); bus claim runner (`ui/screens/loop/native/bus-runner.ts:1-90`) |
| `reviewMerge` | Review & Merge | `model.ts:29`; `MAC_ONLY:72` | agent prompt standing in for Ship | Factory `Review` stage (`factory.ts:54`); `ui/screens/loop/native/ShipPanel.tsx:1-3`; `ship-model.ts:16-35`; `POST /kb/loop/ship` (`extension/routes/loop-agent.mjs` header, `:1-20`); bus `issues.implement` `ship` arg (`schema/bus/registry.json:117-119`) |
| `reviewCode` | Review Code | `model.ts:30` (`readOnlyOutput:true`) | agent prompt | bus `review` focus `code` (`extension/routes/bus/review.mjs:10`, `:14-22`) |
| `reviewDoc` | Review Doc | `model.ts:31` (`readOnlyOutput:true`) | agent prompt | bus `review` focus `doc` (`review.mjs:11`) |
| `reviewConflicts` | Review Conflicts | `model.ts:32` | agent prompt | bus `review` focus `conflicts` (`review.mjs:12`, deterministic pre-check `:33-40`); the `conflicts` screen (`ui/screens/review/ReviewScreen.tsx:1-5`) is a **UI-only** file viewer, not the task |
| `updateIssues` | Update Issues | `model.ts:33` | agent prompt | bus `issues.from_notes` is the intended owner; audit says merge into it (`docs/superpowers/plans/2026-10-31-auto-tasks-audit.md:36`) |
| `updatePlanStatus` | Update Plan Status | `model.ts:34`; `MAC_ONLY:72` | agent prompt standing in for a core route | `POST /kb/outcomes/refresh` (`extension/routes/router.mjs:1441-1471`); background poller (`extension/agents/outcome-watcher.mjs`) |
| `generateDoc` | Generate Documentation | `model.ts:35` | agent prompt standing in for Doc Gen | `/generate-doc` (`extension/routes/doc-gen.mjs:141-150`, `:204-267`); Doc Gen screen (`ui/screens/docgen/run.ts`, `model.ts:80-95`) |
| `regression` | Regression | `model.ts:36`; `MAC_ONLY:72` | agent prompt standing in for a shell stage | Loop `regressionSweep` (`ui/screens/loop/native/stage-exec.ts:97-118`), `regression.ts:61-83`; built-in Regression loop (`templates.ts:33-35`, `defaults.ts:6-53`) |
| `generateKnowledge` | Knowledge | `model.ts:37`; `MAC_ONLY:72` | agent prompt with no durable writer | none; OS/Activity only counts `knowledge_updated` (`extension/routes/os.mjs:245-247`) |
| `loopEngineering` | Loop Engineering | only in the dead bridge screen `AutoTasksScreen.tsx:33` | UI-only | Loop itself; absent from the native catalog |

### 1b. The dead/duplicate Auto Tasks UI

`ui/screens/autotasks/AutoTasksScreen.tsx` is the old Mobile-Control bridge screen. It is **not imported**: `ui/screens/autotasks/index.tsx:1` exports the native screen, and `ui/screens/shell/screens.tsx:51` loads `../autotasks/index.tsx`. Search shows no other importer. It duplicates the catalog with 13 tasks (`AutoTasksScreen.tsx:28-40`), a different group map (`:19-25`), and different labels:

- `AutoTasksScreen.tsx:30` "Sources to Issue" vs `model.ts:27` "Sources → Issue".
- `:31` "Review Merge" vs `model.ts:29` "Review & Merge".
- `:39` "Generate Doc" vs `model.ts:35` "Generate Documentation".
- `:20-25` puts `updateIssues` in **Pipeline**; `model.ts:33` puts it in **Automation**.
- `:33` includes `loopEngineering`, absent from the native catalog.

This is the clearest "one label per task" regression. It is deleted in Task 16, after the native screen and tests use the registry.

### 1c. Loop built-in templates and stages

- `ui/screens/loop/native/templates.ts:31-40` defines `test-and-fix`, `regression`, `test`, `full-verify`; `:42-57` adds `skill-loop`, `docs-refresh`, `operation-diagnosis`, `system-check`; `:65-71` adds `plan-director`, `refactoring`, `doc-optimization`, `test-growth`, `FACTORY_TEMPLATE`. `applyTemplate` is `:75-86`; `initialProjectStore` is `:181-191`.
- `ui/screens/loop/native/defaults.ts:5-644` defines the six Mac starter loops (since `6e31859e4` the Factory is a seventh default loop, built by `factoryLoop()` in `templates.ts` from `FACTORY_TEMPLATE`) (Regression `:6-53`, Test `:54-194`, Plan `:195-286`, Main `:287-311`, Refactoring `:312-549`, Doc Optimization `:550-643`) with full inline prompts in `config.stages[*].prompt`.
- Duplication **inside Loop**: Regression is defined twice (`templates.ts:33,35` and `defaults.ts:6-53`); Test is defined twice (`templates.ts:36-37` and `defaults.ts:54-194`); "Test & Fix" and "Full Verify" re-compose the same Regression/Test stages (`templates.ts:33,39`).
- Prompts duplicated between `defaults.ts` and `.skills` SKILL.md bodies: `skills/test-structure-setup` (`defaults.ts:87`, `:345`), `skills/test-gap-writer` (`:126`, `:448`), `skills/plan-structure-index` (`:215`), `skills/plan-director` (`:230`), `skills/refactor-planner` (`:396`), `skills/refactor-apply` (`:477`), `skills/refactor-conform` (`:492`), `skills/doc-structure-index` (`:570`), `skills/doc-writer` (`:585`). The stage prompt is an instruction wrapper around the skill; it is not identical, but it is a second copy of the same policy and it drifts.
- `FACTORY_TEMPLATE` (`ui/screens/loop/native/factory.ts:42-62`) has four inline prompts (`INTAKE_PROMPT` `:27`, `PLAN_PROMPT` `:28`, `IMPLEMENT_PROMPT` `:29`, `REVIEW_PROMPT` `:30`) plus `FACTORY_REPAIR_HINT` `:31`. The skill ids are `:14-17`; `agentRunBody` is `:97-118`; the role mapping is `:299-315`.
- Stale Mac stages: `templates.ts:45` runs `cd mac && swift build` and `:54` runs `cd mac && swift test`, but `mac/` was removed. These are **shell stages** that now fail by construction. `ui/screens/loop/native/store.ts:72` still says "Run it from the Mac app" for a refactor batch, and `:77-78` lists default keys (`system-check`, `self-heal`, `sdk-adoption`) that `DEFAULT_LOOP_SPECS` no longer defines. Both are user-visible drift.

### 1d. Review / pipeline / bus surfaces

- `extension/routes/bus/review.mjs:9-13` has `FOCUS` prompts for `code`, `doc`, `conflicts`; `:14-22` wraps them in `reviewPrompt`; `:33-40` does the deterministic conflict pre-check and returns `modelCalls: 0` when git finds nothing.
- `schema/bus/registry.json` (copied to `extension/routes/bus/registry.json`, checked by `scripts/conformance-bus.mjs:30-35`) defines six kinds at `:40-158`: `review`, `sources.update`, `issues.from_notes`, `issues.implement`, `loop.run`, `custom.run`. `issues.from_notes` `:84-101`, `loop.run` `:122-140` and `custom.run` `:141-158` are `available:false`; `issues.implement` is a desktop-runner kind `:102-121`.
- `docs/spec/command-bus.md:79-92` documents those six kinds and says "the six kinds replace the Mac's 13 Auto Task cases". The task registry must therefore not invent a seventh wire vocabulary; it maps task ids to existing bus kinds where one exists.
- `extension/routes/bus/executor.mjs:148-150` dispatches `review` to `runReview` and `sources.update` to `runSourcesUpdate`; `:162-167` gives desktop-runner kinds no core handler. These two functions are **route-layer logic** today; the plan moves them down to `agents/tasks/` so the core runner and the bus share one implementation.
- `ui/screens/review/ReviewScreen.tsx` is a read-only docs-vs-code viewer (`:1-5`), not a task runner. The section is labelled "Factory" in `ui/screens/shell/sections.ts:28` while its id is `conflicts`; that label is a UI-only naming drift for Task 16.
- `ui/screens/loop/native/ShipPanel.tsx` + `ship-model.ts` are the Review & Merge desktop action; `POST /kb/loop/ship` is the only side-effect and is user-click driven (`ShipPanel.tsx:1-3`). `bus-runner.ts:72-80` deliberately never ships (`readyToShip` only).

### 1e. Catalogs outside the screens

- `scripts/auto-task-usage.mjs:51-72` hard-codes the 13 old task ids and the `SUFFIX_TO_ID` map. It is the usage report operators run; it will silently miss every new task id until it reads the registry.
- `ui/screens/autotasks/native/model.ts:43-66` stores all Auto Task config under one global `localStorage` key `llmide.autoTasks.v1`, although input/output are project-relative (`:91-99`) and custom tasks are per project (`custom.ts:35-54`). A task config is therefore **not project-scoped** today; this is fixed in Task 15.
- `ui/screens/autotasks/native/NativeAutoTasksScreen.tsx:117-146` schedules built-ins only while the Auto Tasks page is mounted; `ui/screens/shell/Shell.tsx:194-202` schedules custom tasks from the shell. The hint at `NativeAutoTasksScreen.tsx:474` admits "the schedule runs while the Auto Tasks page is open". This is two schedulers and two lifetimes; fixed in Task 15.
- Run history stores `task: t.label` (`NativeAutoTasksScreen.tsx:75-78`, `:189`, `:219`, `:227`), not the id, so a label change breaks history. The registry adds `taskId` additively in Task 15.

---

## 2. The single source of truth

### 2a. Files

| Path | Role | Generated? |
|---|---|---|
| `schema/tasks/registry.json` | The data: tasks, aliases, runner config, IO, schedule/read-only/output policy, feature gate, availability, revision | no (hand-edited) |
| `schema/tasks/prompts/<task-id>.md` | The one prompt for an `agent` task; named by `prompt` | no |
| `schema/tasks/templates.json` | Loop templates and stage references (`taskId` or a raw shell/check stage) | no |
| `schema/tasks/README.md` | Schema explanation and the generation commands | no |
| `scripts/gen-task-registry.mjs` | Generates the runtime and prompt copies; `--check` fails on drift | no |
| `scripts/conformance-tasks.mjs` | Validates schema, aliases, prompts, templates, bus mappings, feature keys and copies; `--sync` copies | no |
| `ui/screens/tasks/registry.generated.ts` | Typed UI copy (`TASKS`, `TASK_BY_ID`, `ALIASES`, `TEMPLATES`) | **yes** |
| `extension/core/task-registry.generated.mjs` | Core copy, imports nothing (L0 data) | **yes** |
| `ui/screens/tasks/prompts.generated.ts` | UI prompt text keyed by task id, imports nothing | **yes** |
| `extension/core/task-prompts.generated.mjs` | Core prompt text keyed by task id, imports nothing | **yes** |
| `ui/screens/tasks/model.ts` | Pure selectors: `resolveTaskId`, `taskAvailability`, `taskPrompt`, `taskGroup` | no |
| `ui/screens/tasks/runner.ts` | Desktop execution adapter (`shell`, `desktop-action`; delegates core to the route) | no |
| `ui/screens/tasks/store.ts` | Project-scoped config + legacy migration | no |
| `ui/screens/tasks/schedule.ts` | The one scheduler tick | no |
| `extension/agents/task-runner.mjs` | Core execution adapter (`agent`, `core-route`) | no |
| `extension/agents/tasks/*.mjs` | One adapter per task family (`review`, `sources-update`, `plan-status`, `issues-from-notes`) | no |
| `extension/routes/tasks.mjs` | HTTP adapter: `GET /kb/tasks`, `POST /kb/tasks/:id/run` | no |

The two generated copies are **checked in**. The generator reads the JSON and the prompt files and writes deterministic output (sorted keys, sorted tasks, trailing newline). `scripts/conformance-tasks.mjs` is the only gate that matters; a stale copy fails `make contract-gates`.

### 2b. Registry schema

`TaskDef` (one object in `tasks`; the JSON schema is `schema/tasks/registry.schema.json`):

```json
{
  "id": "review.code",
  "label": "Review Code",
  "group": "Review",
  "description": "Read-only review of the recent commits for correctness, security and style problems.",
  "aliases": ["reviewCode"],
  "runner": {
    "kind": "agent",
    "busKind": "review",
    "busArgs": { "focus": "code" },
    "engine": { "mode": "read", "provider": "anthropic", "providerArg": "engine" },
    "prompt": "prompts/review.code.md",
    "timeoutSeconds": 1800
  },
  "input": { "kind": "repo", "required": true, "paths": ["<repoRoot>"] },
  "output": { "kind": "text", "persist": "run-record", "revertWrites": true },
  "schedule": { "backend": "desktop", "defaultCron": null, "schedulable": true },
  "scope": "project",
  "readOnly": true,
  "requiresRepo": true,
  "requiresLocalHost": false,
  "features": [],
  "availability": { "status": "available", "reason": null },
  "revision": 1
}
```

Field rules (all enforced by `conformance-tasks.mjs`):

- `id` is `^[a-z][a-z0-9]*(\.[a-z0-9]+)+$` (dotted, stable, never a label). `aliases` are old ids; an alias may not equal another task's id or alias.
- `group` is one of `Pipeline`, `Review`, `Automation`, `Maintenance` (the Auto Tasks groups at `model.ts:10`). Factory-only tasks use `Factory`; the group is a UI hint, not a runner decision.
- `runner.kind` is one of `agent`, `shell`, `core-route`, `desktop-action`. `runner` is `null` only when `availability.status` is `retired` or `alias`.
- `agent` requires `prompt` and forbids `route`/`action`; it may carry `stage` metadata (skill id, target/output path, severity) when a Loop template uses it. `shell` requires `stage.kind` and forbids `prompt`. `core-route` requires `route` (the id of an adapter registered in `extension/agents/task-runner.mjs`, for example `sources-update` or `plan-status`; never a URL or a file path) and forbids `prompt`. `desktop-action` requires `action` (a value from the closed `desktopActions` set in the registry) and forbids `prompt`.
- `busKind`, when present, must exist in `schema/bus/registry.json`; `busArgs` are merged with the task's typed args. `review.code` -> `review` + `{focus:"code"}`; `sources.update` -> `sources.update`; `issues.implement` -> `issues.implement`; `issues.from_notes` -> `issues.from_notes`.
- `input.kind` is `repo`, `project`, `notes`, `issues`, `doc`, `none`. `input.required` is a boolean; `input.paths` are documentation only (never sent to a shell).
- `output.persist` is `log`, `run-record`, `note`, `tracker`, `file` or `none`; `revertWrites` is true exactly for read-only `agent` tasks (a `desktop-action` or `core-route` task has nothing to revert).
- `scope` is `project` or `app`. An `app` task keeps per-project enable/cron but is scheduled once from the active project (Task 15); its work is not repeated per project.
- `schedule.backend` is `none`, `desktop` or `bus`. `desktop` means the one desktop scheduler (Task 15); `bus` means `POST /bus/schedules` (only `sources.update` is schedulable there today, `extension/routes/bus/schedules.mjs:8`). A task with `schedule.backend: "none"` is manual-only. A task that writes code or an external tracker is always `none` (D17): the conformance gate fails when a `desktop-action` task, or a task whose `output.persist` is `tracker`, is schedulable.
- `features` is a subset of `agent_chat`, `file_explorer`, `code_graph_3d`, `gantt_issues`, `terminal`, `doc_gen`, `mobile_sync`, `auto_tasks` (`ui/screens/shell/features.ts:5-14`). The `/kb/tasks` route group itself is gated by `auto_tasks`; that is not repeated in every task entry. `docs.generate` lists `doc_gen`, `issues.from_notes` lists `gantt_issues`, and the rest are `[]`.
- `availability.status` is `available`, `unported`, `retired` or `alias` (only with `aliasOf`). `unported` requires a reason that names the missing capability (never "Mac app"). `retired` keeps the alias for stored history but is hidden from every picker.
- `revision` is a positive integer. It drives the default-stage upgrade that Task 14 builds (the desktop only stores `defaultRevision` today; nothing upgrades yet), not the task runner. An `agent` task also carries `knownPromptHashes`: the SHA-256 of every published revision of its prompt, so an unedited stage in an existing `loop.json` can be recognised.

### 2c. Templates

`schema/tasks/templates.json`:

```json
{
  "version": 1,
  "templates": [
    {
      "id": "regression",
      "name": "Regression",
      "summary": "Re-check known faults only.",
      "kind": "starter",
      "defaultKey": "regression",
      "isPrimary": true,
      "goal": "Find the code behind each known fault and fix it for real, without weakening any test.",
      "acceptanceCriteria": "The fault sweep reports no failing faults and the test suite still passes.",
      "stages": [
        { "taskId": "loop.regression" },
        { "kind": "shellCommand", "name": "Test", "command": "<detected-test-command>", "severity": "blocking" }
      ],
      "config": { "maxIterations": 10, "consecutiveFailureStop": 2 }
    }
  ]
}
```

A stage entry is either `{ "taskId": "..." }` (the task's `stage` or `prompt` is the default) or a raw `{ "kind": "shellCommand" | "artifactCheck" | "testMap" | "testPrune" | "codeGraph", ... }` for stages that are not a reusable task. The generator emits `DEFAULT_LOOP_SPECS` and `BUILT_IN_TEMPLATES` from this file in Task 14; until then the file may contain only the templates migrated so far, and the conformance gate fails if a template stage references a missing task.

### 2d. Availability is computed once

`ui/screens/tasks/model.ts`:

```ts
export type RunnerKind = "agent" | "shell" | "core-route" | "desktop-action";

export interface TaskEnv {
  /** Enabled feature keys from the host pref set; null = every feature. */
  features: ReadonlySet<string> | null;
  /** The core's /health.features; null = every feature. */
  coreFeatures: ReadonlySet<string> | null;
  hasRepo: boolean;
  localHost: boolean;
  mode: "local" | "remote";
}

export interface Availability { runnable: boolean; reason: string | null }

export function taskAvailability(t: TaskDef, env: TaskEnv): Availability {
  if (t.availability.status !== "available") return { runnable: false, reason: t.availability.reason };
  if (!t.features.every((f) => (env.features === null || env.features.has(f)) && (env.coreFeatures === null || env.coreFeatures.has(f)))) {
    return { runnable: false, reason: `Needs the ${t.features.join(" + ")} feature.` };
  }
  if (env.mode === "remote" && t.requiresLocalHost) return { runnable: false, reason: "Runs on this computer; not available from a hub." };
  if (t.requiresRepo && !env.hasRepo) return { runnable: false, reason: "No linked repository. Add one in Settings → Repositories." };
  if (t.runner?.kind === "desktop-action" && !env.localHost) return { runnable: false, reason: "Needs the desktop app." };
  return { runnable: true, reason: null };
}
```

Every surface calls this function. `NativeAutoTasksScreen.tsx` replaces `desktopRunnable`/`scheduledRunAllowed` (`model.ts:76-84`) with it; Loop's `macBatchReason` (`store.ts:68-75`) calls it for batch stages; Factory's Ship gate calls it for `review.merge`. One test (`ui/screens/tasks/tests/availability.test.mjs`) covers the matrix: feature off, remote, no repo, no host, unported, retired, alias.

### 2e. One execution contract

`ui/screens/tasks/runner.ts` (desktop):

```ts
export interface TaskRunContext {
  projectRoot: string;
  core: Pick<CoreClient, "request">;
  host: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  fs: FsApi;
  log(line: string): void;
  signal?: AbortSignal;
  approvalToken(stage: LoopStage): Promise<string | null>;
  changedPaths(): Promise<string[] | null>;
  revert(paths: string[], created: string[]): Promise<void>;
  actions: TaskActions; // startFactory, reviewPendingMerge, createIssues
  /** Custom tasks are dynamic (their prompt belongs to the user); the scheduler passes them here. */
  extraTasks?: ReadonlyMap<string, TaskDef>;
}

export interface TaskResult {
  taskId: string;
  ok: boolean;
  runner: RunnerKind;
  summary: string;
  output: string;
  changedPaths: string[];
  warnings: string[];
  code?: string;
}

export function runTask(taskId: string, ctx: TaskRunContext): Promise<TaskResult>;
```

`extension/agents/task-runner.mjs` (core):

```js
export async function runCoreTask({ taskId, userId, projectRoot, args = {}, signal, emit, deps = {} })
// -> { taskId, runner, ok, summary, output, warnings, code? }
```

Both adapters resolve an alias with `resolveTaskId` before dispatch, so `runCoreTask({ taskId: "sourcesToIssue" })` and `runTask("reviewMerge")` work for stored/phone ids. Dispatch rules, implemented once in each adapter:

| `runner.kind` | Desktop adapter | Core adapter |
|---|---|---|
| `agent` | `POST /kb/tasks/:id/run` (core builds the prompt from the registry) | `runAgentTask` with the registry prompt/skill; refuses a missing prompt |
| `core-route` | `POST /kb/tasks/:id/run` | calls the adapter in `agents/tasks/` (the same function the legacy route calls) |
| `shell` | builds one `LoopStage` from `runner.stage` and calls `runOneStage` (`stage-exec.ts:233-245`) with a `StageExecContext`; no prompt | `TASK_LOCAL_ONLY` (typed) |
| `desktop-action` | calls `ctx.actions[action]`; no prompt | `TASK_LOCAL_ONLY` (typed) |

Loop uses the same primitive rather than a parallel runner: `stage-exec.ts`'s `runOneStage` is the only stage executor, the Loop screen calls it through `createStageDeps` (`NativeLoopScreen.tsx:628`), the Factory run manager calls the same `createStageDeps` (`run-manager.ts:313`), and the Auto Tasks `shell` adapter calls `runOneStage` directly. A Loop stage that references a registry task uses that task's prompt and stage metadata; it does not carry a second prompt table. A task's `agent` runner and a Loop `skill` stage both reach the same `POST /kb/loop/agent-run` engine (through the injected `runTask` port), but each uses the one prompt its registry entry names.

Why two adapters and not one module: `shell` tasks need the Tauri host commands (`desktop/src-tauri/src/lib.rs:325-338`: `loop_run_stage`, `loop_run_fault_verify`, `loop_changed_paths`, `loop_revert_paths`, `loop_worktree_diff`), and `desktop-action` tasks need the open project's worktree/Factory state. The Node core cannot run either. The **contract** is one; the process split is the desktop/core split. For every task the core *can* run, the desktop never implements a second copy: it calls `/kb/tasks/:id/run`.

### 2f. Why `/kb/tasks/:id/run` and not "call every legacy route"

The route body is `{ projectId?, args? }`; it never accepts `prompt`, `route`, `command`, `repoRoot` or a shell string. The registry supplies those. This is the security property that stops the task API becoming a generic agent endpoint. The handler:

0. refuses a request without the bus host proof with `403 HOST_PROOF_REQUIRED` (D14), before reading the body;
1. resolves `taskId` (aliases accepted) from `TASK_BY_ID`;
2. refuses `availability.status !== "available"` with `TASK_NOT_AVAILABLE { reason }`;
3. checks `features` against `config.features` and answers the existing `404 { error: "feature_disabled", feature }` envelope;
4. checks the project with `projectScopeRefusal` and the task's action class (`model.read` for reviews, `external.read` for `sources.update`, `model.exec` for `issues.implement`, `external.write` for `issues.from_notes`);
5. validates `args` against the task's `args` JSON schema (same validator as the bus, `extension/routes/bus/schema-validate.mjs`), then calls `runCoreTask`.

`ROUTE_POLICY` gives a method + path exactly one class, so `POST /kb/tasks/*/run` is declared `model.read` (the lowest class any task needs) and the handler makes a second `authorizeAction` call with the task's own class. The project checks are the bus executor's, reused and not re-written: move `projectRootFor` → `realpathSync` → `projectAllowed` → `classRefusal` (`routes/bus/executor.mjs`, the block before the kind dispatch) into one exported helper that the executor and `routes/tasks.mjs` both call. An adapter that needs something only a route may read declares it (`needs: ["tracker-creds"]`); `routes/tasks.mjs` resolves each need through one small table (the vault read both `/kb/outcomes/refresh` and the task route call) and passes it in `deps`. The generic route never branches on a task id.

`extension/agents/tasks/review.mjs` is the moved `runReview` from `extension/routes/bus/review.mjs`; `extension/routes/bus/review.mjs` becomes a thin wrapper that calls it. `extension/routes/bus/executor.mjs:148-150` calls the same agent module. That is the concrete "one implementation" for Review Code/Doc/Conflicts.

### 2g. Where each layer sits

```
L0  extension/core/task-registry.generated.mjs   (data only, no imports)
L0  extension/core/task-prompts.generated.mjs    (strings only, no imports)
L1  extension/kb/*                               (unchanged)
L2  extension/providers/*                        (unchanged)
L3  extension/agents/task-runner.mjs             (orchestrates; imports L0-L2 + connectors/graphkit/guardrails)
L3  extension/agents/tasks/*.mjs                 (one adapter per family)
L4  extension/routes/tasks.mjs                   (HTTP only; imports L3)
L4  extension/routes/bus/executor.mjs            (imports L3, not routes/bus/review.mjs)
```

The desktop side is a separate package: `ui/screens/tasks/*` may import `ui/screens/loop/*` and `ui/screens/factory/*`, never `extension/*`. The generated TS is the seam.

### 2h. Task ids and aliases

| Canonical id | Label | Aliases (old Auto Task id) | Runner after migration |
|---|---|---|---|
| `loop.regression` | Regression | `regression` | shell |
| `sources.update` | Source Update | `sourceUpdate` | core-route |
| `plan.status` | Update Plan Status | `updatePlanStatus` | core-route |
| `knowledge.update` | Knowledge | `generateKnowledge` | retired (no writer) |
| `docs.generate` | Generate Documentation | `generateDoc` | retired as an Auto Task; `/generate-doc` remains Doc Gen's implementation |
| `issues.implement` | Implement Issues | `implementIssues` | desktop-action |
| `review.merge` | Review & Merge | `reviewMerge` | desktop-action (review only; Ship stays a click) |
| `issues.from_notes` | Sources → Issue | `sourcesToIssue` | core-route |
| `issues.update` | Update Issues | `updateIssues` | alias to `issues.from_notes` |
| `review.code` | Review Code | `reviewCode` | agent |
| `review.doc` | Review Doc | `reviewDoc` | agent |
| `review.conflicts` | Review Conflicts | `reviewConflicts` | agent + deterministic git pre-check |
| `factory.intake` / `factory.plan` / `factory.implement` / `factory.verify` / `factory.review` | Factory stages | none | agent/shell (Task 14) |
| `loop.engineering` | Loop Engineering | `loopEngineering` | retired (the Loop screen owns it) |

`review.code`/`review.doc`/`review.conflicts` share one bus kind `review`; the registry's `busArgs.focus` is the mapping. `custom.run` is **not** a registry task: a custom task's prompt belongs to the user's saved task, so it is a dynamic `TaskDef` built at runtime (`runner.kind: "agent"`, `promptSource: "user"`). It must never be faked into the registry.

### 2i. Transitional merge while tasks migrate (one task per commit)

The UI cannot lose the eleven un-migrated tasks between commits. `ui/screens/autotasks/native/model.ts` therefore keeps a shrinking `LEGACY_TASKS` array and exposes the merged catalog:

```ts
import { TASKS as REGISTRY_TASKS, TASK_BY_ID as REGISTRY_BY_ID } from "../../tasks/model.ts";

/** Entries not migrated yet. A migration deletes its own entry from this array. */
const LEGACY_TASKS: readonly AutoTaskDef[] = [ /* ... the un-migrated tasks ... */ ];

export const TASKS = [...REGISTRY_TASKS.filter((t) => t.availability.status === "available" || t.availability.status === "unported"), ...LEGACY_TASKS];
// Full catalog for history/aliases; TASKS is only what a picker lists.
export const TASK_BY_ID = Object.freeze({ ...REGISTRY_BY_ID, ...Object.fromEntries(LEGACY_TASKS.map((t) => [t.id, t])) });
```

`desktopRunnable(id)` becomes:

```ts
export function desktopRunnable(id: AutoTaskId, env: TaskEnv): boolean {
  const task = REGISTRY_BY_ID[resolveTaskId(id) ?? ""];
  if (task) return taskAvailability(task, env).runnable;
  return !MAC_ONLY_TASK_IDS.has(id); // only un-migrated legacy entries reach this line
}
```

Each migration removes one `LEGACY_TASKS` entry and one `MAC_ONLY_TASK_IDS` entry, so the shim shrinks monotonically and Task 16 deletes both. The merged list must be de-duplicated by canonical id; a legacy entry whose id resolves to a registry task is a conformance error, not a second row. **Every later step that says "remove `model.ts:<line>`" means remove that entry from `LEGACY_TASKS`**; the line is the current literal, and the registry entry is already the replacement.

---

## 3. Migration tasks

Each task is one commit. "Delete old duplicate" is always the last step and always after the named test proves the new path is used. Run `cd desktop && npm test` for UI tasks and `cd extension && npm test` for core tasks; the full gate is `make regression`.

### Task 1 — Registry foundation, generator and conformance gate

**Files:**
- Create: `schema/tasks/registry.json`, `schema/tasks/registry.schema.json`, `schema/tasks/templates.json`, `schema/tasks/prompts/.gitkeep`, `schema/tasks/README.md`
- Create: `scripts/gen-task-registry.mjs`, `scripts/conformance-tasks.mjs`
- Create: `ui/screens/tasks/registry.generated.ts`, `ui/screens/tasks/model.ts`
- Create: `extension/core/task-registry.generated.mjs`, `extension/core/task-prompts.generated.mjs`
- Create: `ui/screens/tasks/tests/registry.test.mjs`, `ui/screens/tasks/tests/availability.test.mjs`
- Modify: `Makefile:150-161` (`contract-gates`), `desktop/package.json:11` (test glob)

**Interfaces:**
- Produces: `TASKS`, `TASK_BY_ID`, `ALIASES`, `TEMPLATES` from both generated files; `resolveTaskId`, `taskAvailability`, `taskPrompt` from `ui/screens/tasks/model.ts`.
- Produces: `node scripts/gen-task-registry.mjs [--check]` and `node scripts/conformance-tasks.mjs [--sync]`.

- [ ] **Step 1: Write the failing test.** `ui/screens/tasks/tests/registry.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ALIASES, TASKS, TASK_BY_ID } from "../registry.generated.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the checked-in generated copies match schema/tasks", () => {
  assert.doesNotThrow(() => execFileSync("node", ["scripts/gen-task-registry.mjs", "--check"], { cwd: ROOT, stdio: "pipe" }));
});

test("ids and aliases are unique and resolve", () => {
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const [alias, id] of Object.entries(ALIASES)) {
    assert.ok(TASK_BY_ID[id], `${alias} -> ${id}`);
    assert.equal(TASK_BY_ID[id].id, id);
    assert.ok(TASK_BY_ID[id].aliases.includes(alias), alias);
  }
});

test("a retired task has no runner and an agent task has a prompt", () => {
  for (const t of TASKS) {
    if (t.availability.status === "retired") assert.equal(t.runner, null, t.id);
    if (t.runner?.kind === "agent") assert.match(t.runner.prompt, /^prompts\/.+\.md$/, t.id);
    if (t.runner && t.runner.kind !== "agent") assert.equal(t.runner.prompt, undefined, t.id);
  }
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/registry.test.mjs`. Expected: FAIL with `Cannot find module '../registry.generated.ts'` (or `ENOENT` for the script).

- [ ] **Step 2: Add the schema and the empty registry.** `schema/tasks/registry.json`:

```json
{ "version": 1, "tasks": [] }
```

`schema/tasks/templates.json`:

```json
{ "version": 1, "templates": [] }
```

`registry.schema.json` is a JSON Schema with `additionalProperties:false` at the root and in every object; it encodes the field rules in §2b. Do not add a new validation dependency: `conformance-tasks.mjs` uses the existing `validate` from `extension/routes/bus/schema-validate.mjs` for task `args` and hand-written structural checks for the registry, exactly as `scripts/conformance-bus.mjs:55-90` does for the bus.

- [ ] **Step 3: Write the generator.** `scripts/gen-task-registry.mjs` exports `buildRegistry()` and `renderTs(reg)` / `renderPromptsTs(reg)` / `renderMjs(reg)` / `renderPromptsMjs(reg)`; the CLI writes all four files, or with `--check` compares them and exits 1 with `generated copy is stale: <path> (run: node scripts/gen-task-registry.mjs)`. The TS catalog copy ends with:

```ts
export const TASKS: readonly TaskDef[] = [];
export const TASK_BY_ID: Readonly<Record<string, TaskDef>> = Object.freeze({});
export const ALIASES: Readonly<Record<string, string>> = Object.freeze({});
export const TEMPLATES: readonly LoopTemplateDef[] = [];
```

The MJS copy is the same data with no type annotations and `export const`. Prompt files are inlined into `task-prompts.generated.mjs` only; the registry keeps the relative path.

- [ ] **Step 4: Write the conformance gate.** `scripts/conformance-tasks.mjs` checks, in this order:
  1. all four generated files are byte-identical to the generator output;
  2. every `prompt` file exists, is UTF-8, non-empty and not duplicated — only `prompts/*.md` count (`.gitkeep` and dotfiles are ignored), and each file's SHA-256 appears once across all prompt files;
  3. every `busKind` exists in `schema/bus/registry.json`; every `busArgs` key is allowed by that kind's `args`;
  4. every `features` key exists in `ui/screens/shell/features.ts` (read as text, not imported);
  5. every template `taskId` exists; no `shellCommand` contains `cd mac` (the stale stage guard);
  6. every alias points at a task, and no alias collides with another task id;
  7. a non-`agent` runner has no `prompt`; a `retired` task has no runner.

Add `node scripts/conformance-tasks.mjs` to `contract-gates` after the bus line (`Makefile:150-161`), and add `../ui/screens/tasks/tests/*.test.*` to the `desktop/package.json:11` glob.

- [ ] **Step 5: Add the pure selector.** `ui/screens/tasks/model.ts` exports the types and `taskAvailability` from §2d, plus `resolveTaskId(idOrAlias)` (own-property lookup, never `__proto__`), `taskPrompt(taskId)` (throws `TASK_NOT_PROMPTABLE` for a non-agent task) and `taskGroup(taskId)` (falls back to `Automation`). Write `availability.test.mjs` with one task fixture per status and the matrix from §2d.

- [ ] **Step 6: Run and commit.**

```bash
node scripts/gen-task-registry.mjs
node scripts/conformance-tasks.mjs
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/registry.test.mjs ../ui/screens/tasks/tests/availability.test.mjs
cd .. && make contract-gates
git add schema/tasks scripts/gen-task-registry.mjs scripts/conformance-tasks.mjs ui/screens/tasks extension/core/task-registry.generated.mjs extension/core/task-prompts.generated.mjs Makefile desktop/package.json
git commit -m "feat(tasks): add the unified task registry, generated copies and conformance gate"
```

**Compatibility:** no runtime reads the registry yet; all existing code paths are untouched. The empty catalog is valid. **Rollback:** revert the commit; no stored data changes. **User-visible change:** none.

---

### Task 2 — `loop.regression` (Regression)

**Files:**
- Modify: `schema/tasks/registry.json` (add the task), `schema/tasks/prompts/` (none: shell task)
- Modify: `schema/tasks/templates.json` (add the Regression starter template; optional until Task 14)
- Create: `ui/screens/tasks/runner.ts`
- Modify: `ui/screens/autotasks/native/model.ts:25-38`, `:71-79` (remove `regression` from `MAC_ONLY`, keep the id alias)
- Modify: `ui/screens/autotasks/native/NativeAutoTasksScreen.tsx:162-231` (call `runTask`)
- Modify: `ui/screens/loop/native/model.ts` (add the optional `taskId` field to `LoopStage`, decode/encode), `ui/screens/loop/native/templates.ts:33,35`, `ui/screens/loop/native/defaults.ts:7-25`
- Test: `ui/screens/tasks/tests/runner-regression.test.mjs`

**Interfaces:**
- Consumes: `runOneStage` / `StageExecContext` from `ui/screens/loop/native/stage-exec.ts:233-245`, `runRegression` from `ui/screens/loop/native/regression.ts:61-83`.
- Produces: `runTask("loop.regression", ctx) -> TaskResult` with `runner: "shell"`; no `/kb/loop/agent-run` call.

- [ ] **Step 1: Write the failing test.** `ui/screens/tasks/tests/runner-regression.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";

const FAULT = "---\nstatus: fixed\nprompt: what is 2+2?\nresponse: 4\nverify: npm test\n---\n";

function fakeFs() {
  return {
    async list(path) {
      return { entries: path === "system/faults" ? [{ name: "a.md", path: "system/faults/a.md", kind: "file" }] : [] };
    },
    async read(path) {
      return path === "system/faults/a.md" ? { status: "ok", text: FAULT, hash: "h" } : { status: "missing", text: null, hash: null };
    },
  };
}

test("Regression runs the Loop regression stage and never the agent", async () => {
  const coreCalls = [];
  const hostCalls = [];
  const result = await runTask("regression", {
    projectRoot: "/p",
    core: { request: async (path) => { coreCalls.push(path); throw new Error("the agent must not run"); } },
    host: async (command) => {
      hostCalls.push(command);
      return command === "loop_run_fault_verify"
        ? { exitCode: 0, stdout: "", stderr: "", timedOut: false }
        : command === "loop_work_root" ? "/p" : null;
    },
    fs: fakeFs(),
    log: () => {},
    approvalToken: async () => "token",
    changedPaths: async () => [],
    revert: async () => {},
    actions: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.runner, "shell");
  assert.deepEqual(coreCalls, []);
  assert.ok(hostCalls.includes("loop_run_fault_verify"));
  assert.match(result.output, /verify passed/);
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/runner-regression.test.mjs`. Expected: FAIL (`runTask` is not defined/exported).

- [ ] **Step 2: Add the registry entry.** `schema/tasks/registry.json`:

```json
{
  "id": "loop.regression",
  "label": "Regression",
  "group": "Maintenance",
  "description": "Re-check every status:fixed fault report and reopen the ones that no longer verify.",
  "aliases": ["regression"],
  "runner": {
    "kind": "shell",
    "stage": { "kind": "regressionSweep", "name": "Regression", "severity": "blocking", "allowsRepair": true },
    "timeoutSeconds": 1800
  },
  "input": { "kind": "project", "required": true, "paths": ["system/faults"] },
  "output": { "kind": "fault-report", "persist": "run-record", "revertWrites": false },
  "schedule": { "backend": "desktop", "defaultCron": null, "schedulable": true },
  "readOnly": false,
  "requiresRepo": true,
  "requiresLocalHost": true,
  "features": [],
  "availability": { "status": "available", "reason": null },
  "revision": 1
}
```

Run `node scripts/gen-task-registry.mjs` and `node scripts/conformance-tasks.mjs`.

- [ ] **Step 3: Implement `runTask` for `shell`.** In `ui/screens/tasks/runner.ts`, build a one-stage `LoopDefinition`:

```ts
const task = TASK_BY_ID[resolvedId];
if (task.runner?.kind !== "shell") throw new Error("not a shell task");
const stage: LoopStage = {
  id: task.id, name: task.label, kind: task.runner.stage.kind, command: null, order: 0,
  skillId: null, targetPath: null, outputPath: null, prompt: null, isDefault: false, enabled: true,
  defaultKey: null, severity: task.runner.stage.severity ?? "blocking", timeoutSeconds: task.runner.timeoutSeconds ?? null,
  detectedCommand: null, check: null, testOp: null, graphOp: null,
  allowsRepair: task.runner.stage.allowsRepair ?? true, runOnce: false, defaultRevision: null,
  disabledByDetection: null, raw: null,
};
const runRoot = await ctx.host<string>("loop_work_root");
const loop: LoopDefinition = {
  id: task.id, name: task.label, isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [],
  defaultKey: null, runsOnSchedule: false,
  config: { stages: [stage], maxIterations: 1, consecutiveFailureStop: 1, wallClockBudgetSeconds: null,
    pauseTimeoutSeconds: 0, maxRepairsPerStage: 0, repairModel: null, protectedPathPolicy: "off",
    writeSummaryNote: false, extraProtectedGlobs: [], useWorktreesForConcurrentRuns: false,
    alwaysUseWorktree: false, openMergeRequest: false, refactorBatchesPerRun: null },
};
const exec: StageExecContext = {
  projectRoot: ctx.projectRoot, runId: null, runRoot, fs: ctx.fs, host: ctx.host, core: ctx.core,
  log: ctx.log, approvalToken: ctx.approvalToken, signal: ctx.signal, isCancelled: () => ctx.signal?.aborted === true,
  markCancelled: () => {},
};
const r = await runOneStage(exec, stage, loop, [], { reason: null, isError: false });
if (!r.ok && task.runner.stage.kind === "regressionSweep") {
  // Same post-failure rule as the Loop screen: a fixed fault that no longer verifies is reopened.
  for (const rel of faultPathsFromOutput(r.output)) await reopenFault(ctx.fs, rel);
}
return { taskId: task.id, ok: r.ok, runner: "shell", summary: r.output.split("\n")[0] ?? "", output: r.output, changedPaths: [], warnings: [] };
```

- [ ] **Step 4: Wire Auto Tasks to the runner.** In `NativeAutoTasksScreen.tsx:162-231`, replace the `guardedAgentCall` block for `regression` with a `runTask("loop.regression", ctx)` branch. Keep the existing model-limit decision (`decideRun`) only for `agent` tasks; a shell task does not need a model. Pass the same `invokeHost`, `core`, `fs`, `changedPathsNow`, `loop_revert_paths` and `approveStage` wiring the Loop screen uses (`NativeLoopScreen.tsx:487-490`, `:555-568`). Add the optional `taskId` field to `LoopStage` (`model.ts:21-47`, decode `:91-120`, encode `:190-213`) and tag the existing Regression stage definitions in `templates.ts:33,35` and `defaults.ts:7-25` with `taskId:"loop.regression"`. `taskId` is the identity reference; `promptRef` in Task 14 is the prompt pointer. Older builds drop `taskId` on save (it has no inline effect), which is safe because the stage still carries its own `kind`. `MAC_ONLY_TASK_IDS` loses `regression`; `desktopRunnable("regression")` becomes true through `taskAvailability`, not a hardcoded set. Update every `desktopRunnable`/`scheduledRunAllowed` call in `NativeAutoTasksScreen.tsx` (`:165`, `:332`, `:334`, `:363`, `:371`, `:374`, `:377`, `:383`) and the `scheduleStatusLine` call at `model.ts:126` to pass the screen's `TaskEnv` (feature set from the shell + `/health`, `hasRepo`, `localHost`, `mode`).

  **Approval (R-037 #4).** The host mints an approval only for a stage it resolves from `system/loop.json` (`loop_approve_stage(stageId, loopId)`), and `loop_run_fault_verify` checks the token against the fault path and its command hash. The in-memory stage above is not in `loop.json`, so it cannot be approved by its own id. `ctx.approvalToken` therefore asks for the project's real Regression loop: find the loop whose `defaultKey` is `regression` in the loaded store and call `approveLoop(thatLoop.id)` for a manual run. A scheduled run calls `approvalStatus(thatLoop.id)` and uses its token only when `approved` is true; otherwise the run is skipped with the reason "Regression needs its fault commands approved once in Loop", and no dialog opens. A project with no Regression loop gets `NO_REGRESSION_LOOP`. Add both cases to `runner-regression.test.mjs` (a scheduled run with no grant makes no `loop_run_fault_verify` call).

- [ ] **Step 5: Delete the old prompt.** Remove `model.ts:36` from `TASKS`. The label, group and runner now come from the registry. Keep `AutoTaskId` including `"regression"` (it is the alias) and map it via `resolveTaskId`.

- [ ] **Step 6: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/runner-regression.test.mjs ../ui/screens/autotasks/tests/*.test.mjs
cd .. && node scripts/conformance-tasks.mjs && make contract-gates
git commit -am "feat(tasks): Regression runs the Loop regression stage through the task registry"
```

**Compatibility:** `regression` remains a valid stored id (alias); old run records display "Regression"; the config key is unchanged until Task 15. **Rollback:** revert the commit; the alias keeps history readable. **User-visible change:** Regression is now runnable (it was disabled as "Mac app only") and runs deterministic code with no model call; a failing fault reopens exactly as the Loop's Regression loop does.

---

### Task 3 — `sources.update` (Source Update)

**Files:**
- Modify: `schema/tasks/registry.json` (task), `ui/screens/autotasks/native/model.ts:26`, `:72`
- Create: `extension/agents/tasks/sources-update.mjs` (move `runSourcesUpdate` from `extension/routes/bus/sources-update.mjs:65-110`; the route re-exports it)
- Create: `extension/routes/tasks.mjs`, `extension/agents/task-runner.mjs`
- Modify: `extension/routes/feature-routes.mjs:49-52` (add `/kb/tasks/`), `extension/server.mjs:456-470` (`ALL_ENDPOINTS`, version bump), `extension/server/route-authority.mjs` (`ROUTE_POLICY`); `extension/routes/router.mjs` gets NO static import of the task route
- Test: `extension/tests/task-runner-sources.test.mjs`, `extension/tests/task-routes.test.mjs`

**Interfaces:**
- Produces: `runSourcesUpdate({ userId, args, signal, now })` in `agents/tasks/sources-update.mjs` (same signature as today).
- Produces: `POST /kb/tasks/sources.update/run` body `{ "args": { "sourceIds"?: string[] } }` -> `{ taskId, ok, summary, output, warnings }`.

- [ ] **Step 1: Write the failing test.** `extension/tests/task-runner-sources.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoreTask } from '../agents/task-runner.mjs';

test('sources.update runs the deterministic adapter and never the agent', async () => {
  const calls = [];
  const out = await runCoreTask({
    taskId: 'sourceUpdate',
    userId: 'u1',
    projectRoot: '/p',
    args: {},
    deps: {
      runSourcesUpdate: async (a) => { calls.push(a); return { synced: 2, refused: 0, skipped: 0, results: [], text: 'Synced 2 of 2 sources.' }; },
      runLoopAgent: async () => { throw new Error('the agent must not run'); },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.runner, 'core-route');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.sourceIds, undefined);
});
```

Run: `cd extension && node --test tests/task-runner-sources.test.mjs`. Expected: FAIL (`../agents/task-runner.mjs` missing).

- [ ] **Step 2: Move the logic down without inverting a layer.** The registry entry is `runner.kind:"core-route"`, `runner.route:"sources-update"`, `scope:"app"`, `features:[]`, `requiresRepo:false`, `requiresLocalHost:false`, `schedule.backend:"desktop"` (or `"bus"` if you want to reuse the existing `sources.update` bus schedule; the desktop scheduler is the default in this plan). Create `extension/agents/tasks/sources-update.mjs` with the body of `extension/routes/bus/sources-update.mjs:65-110`. It may import `kb/` and `connectors/` (L1/L3), but it may **not** import `routes/google-connectors.mjs` or `routes/calendar-ical.mjs` (L4). Take `runGoogleSync` and `runIcalSync` as injected deps (`indexBoxFolder` is in `connectors/`, which `agents/` may import directly) (`deps.runGoogleSync ?? runGoogleSync` is not allowed; the route supplies them, tests supply fakes). `extension/routes/bus/sources-update.mjs` becomes a wrapper that supplies the real L4 functions:

```js
import { runGoogleSync } from '../google-connectors.mjs';
import { runIcalSync } from '../calendar-ical.mjs';
import { runSourcesUpdate as core } from '../../agents/tasks/sources-update.mjs';

export const runSourcesUpdate = (a) => core({ ...a, deps: { runGoogleSync, runIcalSync } });
```

The bus route (`extension/routes/bus/executor.mjs:149`) and `routes/tasks.mjs` both use this wrapper, so there is one implementation and no L3 → L4 import. Keep the route file until Task 16 so the bus import path does not change twice.

- [ ] **Step 3: Add the task route.** `extension/routes/tasks.mjs` exports `handleTaskRoutes(req, res, ctx)`; `GET /kb/tasks` returns the catalog filtered by `config.features` and **omits `runner.prompt`** (a prompt is a server-side implementation detail; the UI already has the generated copy); `POST /kb/tasks/:id/run` parses `{ projectId?, args? }`, rejects any other key (`prompt`, `route`, `command`, `repoRoot` are `VALIDATION_FAILED`), resolves the alias, refuses unavailable tasks with `TASK_NOT_AVAILABLE`, checks authority, validates args with `extension/routes/bus/schema-validate.mjs`, then calls `runCoreTask`. The run handler starts with the host-proof check (D14). Wiring (R-037 #6): add `/kb/tasks/` to `FEATURE_ROUTE_GROUPS.auto_tasks.prefixes` (`feature-routes.mjs:49-52`) and make that group's single lazy `load` return one handler that tries `handleLoopAgentRoutes` and then `handleTaskRoutes` (each returns `false` for a path it does not own). Never import `routes/tasks.mjs` statically from `router.mjs` or `server.mjs`, and `agents/task-runner.mjs` imports the Loop engine with a dynamic `import()` on first use (`tests/feature-routes.test.mjs`, `tests/lazy-engine.test.mjs` must stay green). Add the paths to `ALL_ENDPOINTS` and to `ROUTE_POLICY` as described in §2f; bump `SERVER_API_VERSION` to 136. `tests/task-routes.test.mjs` includes: no host proof → 403 `HOST_PROOF_REQUIRED`; a body with `prompt` → `VALIDATION_FAILED`; `auto_tasks` off → 404 `feature_disabled`.

- [ ] **Step 4: Wire the desktop.** `runTask` for `core-route` calls `ctx.core.request("/kb/tasks/" + task.id + "/run", { method: "POST", body: { projectId, args } })`. Auto Tasks no longer needs `requiresLinkedRepo` for this task (`model.ts:86-89` says only Source Update is exempt); that stays true through the registry (`requiresRepo:false`).

- [ ] **Step 5: Delete the old prompt and the Mac-only entry.** Remove `model.ts:26` from `TASKS`, remove `"sourceUpdate"` from `MAC_ONLY_TASK_IDS` (`:72`), and delete the "Source Update" special-case text at `NativeAutoTasksScreen.tsx:319` if it still says "Auto Tasks other than Source Update".

- [ ] **Step 6: Run and commit.**

```bash
cd extension && node --test tests/task-runner-sources.test.mjs tests/task-routes.test.mjs tests/bus-sources.test.mjs
cd .. && node scripts/conformance-tasks.mjs && make contract-gates && make inventory-check
git commit -am "feat(tasks): Source Update runs the core sources.update adapter through the task registry"
```

**Compatibility:** the bus kind is unchanged; the route is additive (API 136). Existing `sources.update` schedules still work. **Rollback:** set `availability.status` to `unported` in the registry (data-only) or revert the commit; the bus route is untouched. **User-visible change:** Source Update is runnable (was disabled), needs no linked repo, and reports the same counts as the core sync.

---

### Task 4 — `plan.status` (Update Plan Status)

**Files:**
- Modify: `schema/tasks/registry.json` (task), `ui/screens/autotasks/native/model.ts:34`, `:72`
- Create: `extension/agents/tasks/plan-status.mjs` (thin wrapper over `refreshAllOutcomes`)
- Modify: `extension/agents/task-runner.mjs` (dispatch `core-route` by `runner.route` id)
- Test: `extension/tests/task-runner-plan-status.test.mjs`

**Interfaces:**
- Produces: `runPlanStatus({ userId, creds }) -> summary`; the adapter calls the same `refreshAllOutcomes` as `extension/routes/router.mjs:1465`, not a second poller.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoreTask } from '../agents/task-runner.mjs';

test('plan.status refreshes outcomes and makes no model call', async () => {
  let refreshed = 0;
  const out = await runCoreTask({
    taskId: 'updatePlanStatus', userId: 'u1', projectRoot: '/p', args: {},
    deps: { refreshAllOutcomes: async () => { refreshed += 1; return { refreshed: 3 }; }, runLoopAgent: async () => { throw new Error('no model'); } },
  });
  assert.equal(out.ok, true);
  assert.equal(refreshed, 1);
  assert.match(out.summary, /3/);
});
```

Run: `cd extension && node --test tests/task-runner-plan-status.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Add the registry entry.** `runner.kind: "core-route"`, `runner.route: "plan-status"`, `scope: "app"`, `features: []` (the route refreshes the user's dispatched tasks and has no project filter; `refreshAllOutcomes` takes only `taskIds`), `requiresRepo:false`, `requiresLocalHost:false`, `schedule.backend:"desktop"`.

- [ ] **Step 3: Implement the adapter.** `agents/tasks/plan-status.mjs`:

```js
export async function runPlanStatus({ userId, creds, deps = {} }) {
  const refresh = deps.refreshAllOutcomes ?? (await import('../outcome-watcher.mjs')).refreshAllOutcomes;
  const summary = await refresh(userId, { creds });
  return { ok: true, summary: `Refreshed ${summary.refreshed ?? 0} outcome(s).`, output: JSON.stringify(summary) };
}
```

Credentials come from the vault in the route, exactly as `router.mjs:1449-1464` does; do not accept them from the task body (the task route's `args` schema has no `creds`). The entry declares `needs: ["tracker-creds"]`; `routes/tasks.mjs` resolves it through the table in §2f and passes `deps.creds`, so `runPlanStatus` receives `creds` without the generic route knowing the task.

- [ ] **Step 4: Wire the desktop and delete the old prompt.** Remove `model.ts:34`, remove `updatePlanStatus` from `MAC_ONLY_TASK_IDS`. In `NativeAutoTasksScreen`, the task now goes through `runTask`'s `core-route` branch and does not call `decideRun` (no model).

- [ ] **Step 5: Run and commit.**

```bash
cd extension && node --test tests/task-runner-plan-status.test.mjs tests/outcome-watcher-refresh.test.mjs
cd .. && node scripts/conformance-tasks.mjs && make contract-gates
git commit -am "feat(tasks): Update Plan Status runs the outcomes refresh through the task registry"
```

**Compatibility:** the route is the existing `/kb/outcomes/refresh` logic moved down; no shape change. **Rollback:** registry `unported` or revert. **User-visible change:** runnable (was disabled), no model, app-wide (it refreshes every dispatched task for the user, matching the existing poller).

---

### Task 5 — `knowledge.update` (Knowledge): retire, do not fake it

**Files:**
- Modify: `schema/tasks/registry.json` (retired entry), `ui/screens/autotasks/native/model.ts:37`, `:72`
- Test: `ui/screens/tasks/tests/retired-knowledge.test.mjs`

**Interfaces:**
- Produces: `resolveTaskId("generateKnowledge") -> "knowledge.update"`; `taskAvailability` returns `{runnable:false, reason:"No durable memory writer exists..."}`.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskId, taskAvailability } from "../model.ts";
import { TASK_BY_ID } from "../registry.generated.ts";

test("Knowledge is retired with an honest reason and keeps its alias", () => {
  const id = resolveTaskId("generateKnowledge");
  assert.equal(id, "knowledge.update");
  const t = TASK_BY_ID[id];
  assert.equal(t.runner, null);
  assert.equal(t.availability.status, "retired");
  assert.match(t.availability.reason, /no durable memory writer/i);
  assert.deepEqual(taskAvailability(t, { features: null, coreFeatures: null, hasRepo: true, localHost: true, mode: "local" }), { runnable: false, reason: t.availability.reason });
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/retired-knowledge.test.mjs`. Expected: FAIL (no entry).

- [ ] **Step 2: Add the retired entry.** `runner: null`, `aliases:["generateKnowledge"]`, `availability:{status:"retired", reason:"No durable memory writer exists in the core; Graph/Memory surfaces own knowledge updates."}`, `readOnly:true`, `features:[]`.

- [ ] **Step 3: Remove it from the Auto Tasks picker.** `NativeAutoTasksScreen.tsx:108` filters `TASKS`; the registry list excludes retired tasks from pickers but keeps them for history (`resolveTaskId`). Delete `model.ts:37`; keep `"generateKnowledge"` in `AutoTaskId` as an alias for stored history.

- [ ] **Step 4: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/retired-knowledge.test.mjs ../ui/screens/autotasks/tests/*.test.mjs
git commit -am "feat(tasks): retire the Knowledge Auto Task instead of sending a prompt that writes nothing"
```

**Compatibility:** stored config/history for `generateKnowledge` still resolves to the retired entry and displays "Knowledge (retired)". **Rollback:** change `status` to `unported` (still not runnable) or revert. **User-visible change:** the task is no longer offered as runnable; no model turn is spent on a log-only result.

**Decision if you want it kept:** implement it as a real `core-route` over the memory extractor (`extension/llm_agent/memory/memory-extract.mjs`) with a durable destination and its own test. Do not re-add the prompt without that writer.

---

### Task 6 — `docs.generate` (Generate Documentation): retire the Auto Task, keep Doc Gen

**Files:**
- Modify: `schema/tasks/registry.json` (retired entry), `ui/screens/autotasks/native/model.ts:35`
- Test: `ui/screens/tasks/tests/retired-docs-generate.test.mjs`

**Interfaces:**
- Produces: `resolveTaskId("generateDoc") -> "docs.generate"`, `taskAvailability` false with "Doc Gen needs a template and sources; use the Doc Gen screen."

- [ ] **Step 1: Write the failing test.** Same pattern as Task 5: assert `runner === null`, `status === "retired"`, and that `schema/tasks/prompts/docs.generate.md` does **not** exist.

- [ ] **Step 2: Add the retired entry.** `aliases:["generateDoc"]`, reason: "Generate Documentation needs a template and sources; the Doc Gen screen and POST /generate-doc own it." `features:["auto_tasks","doc_gen"]` (so if it is ever promoted, the gate is already right).

- [ ] **Step 3: Delete the prompt.** Remove `model.ts:35`; keep the `generateDoc` alias. The Doc Gen screen (`ui/screens/docgen/run.ts`, `model.ts:80-95`) is untouched and remains the one implementation.

- [ ] **Step 4: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/retired-docs-generate.test.mjs
git commit -am "feat(tasks): retire the Generate Documentation Auto Task; Doc Gen owns generation"
```

**Compatibility:** history alias only. **Rollback:** revert. **User-visible change:** no more "Generate Documentation" Auto Task that asks a model for a document nobody files; Doc Gen keeps working.

---

### Task 7 — `issues.implement` (Implement Issues, Factory/B5)

**Files:**
- Modify: `schema/tasks/registry.json` (task), `ui/screens/autotasks/native/model.ts:28`, `:72`
- Create: `ui/screens/tasks/select-issues.ts` (+ test)
- Modify: `ui/screens/tasks/runner.ts` (`desktop-action` dispatch)
- Modify: `ui/screens/issues/index.tsx:17-28` (reuse `startFactory`), `ui/screens/loop/native/bus-runner.ts` (call the same action)
- Test: `ui/screens/tasks/tests/runner-implement-issues.test.mjs`

**Interfaces:**
- Consumes: `startRun` / `sendToFactory` (`ui/screens/issues/index.tsx:17-28`), `GET /kb/issues` (`extension/routes/router.mjs:380-...`).
- Produces: `selectNextReadyIssue(issues) -> Issue | null` (pure); `runTask("issues.implement", ctx)` starts exactly one Factory run and never calls `/kb/loop/agent-run`.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";
import { selectNextReadyIssue } from "../select-issues.ts";

const issues = [
  { id: "2", number: 2, title: "Later", body: "b", state: "open", isPR: false, labels: [] },
  { id: "1", number: 1, title: "Ready", body: "a", state: "open", isPR: false, labels: [] },
];

test("selectNextReadyIssue takes the oldest open non-PR issue with a body", () => {
  assert.equal(selectNextReadyIssue(issues)?.id, "1");
  assert.equal(selectNextReadyIssue([]), null);
  assert.equal(selectNextReadyIssue([{ ...issues[0], isPR: true }]), null);
});

test("Implement Issues starts one Factory run, never an agent prompt", async () => {
  const coreCalls = [];
  let started = null;
  const out = await runTask("implementIssues", {
    projectRoot: "/p",
    core: { request: async (path) => { coreCalls.push(path); return { issues }; } },
    host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null,
    changedPaths: async () => [], revert: async () => {},
    actions: { factoryItemKeys: async () => new Set(), startFactory: async (ids) => { started = ids; return { runIds: ["r1"] }; } },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(coreCalls, ["/kb/issues?state=open"]);
  assert.deepEqual(started, ["1"]);
  assert.deepEqual(out.changedPaths, []);
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/runner-implement-issues.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Add the registry entry.** `runner.kind:"desktop-action"`, `action:"factory.start"`, `input:{kind:"issues", required:true, selector:"next-ready"}`, `requiresRepo:true`, `requiresLocalHost:true`, `readOnly:false`, `output.persist:"run-record"`, `features:["gantt_issues"]` (the Issues board/read is `gantt_issues`; the `/kb/tasks` route group is already gated by `auto_tasks`, so it is not repeated here). `schedule: { backend: "none", schedulable: false }` (D17: it starts a code-writing run).

- [ ] **Step 3: Implement selection and the action.** `select-issues.ts` sorts by `number`/`id` ascending, drops `isPR`, non-open and empty-body rows, and every issue that already has a Factory card (`taken`: the item keys from `readItems` in `ui/screens/factory/items.ts`, whatever their column), so an issue with a live run, a finished run or a shipped PR is never started twice. `/kb/issues` rows have no assignee field; do not invent one. Signature: `selectNextReadyIssue(issues, taken = new Set())`. The `desktop-action` branch:

```ts
if (task.runner?.kind === "desktop-action") {
  if (task.runner.action === "factory.start") {
    const body = await ctx.core.request<{ issues: Issue[] }>("/kb/issues?state=open", { method: "GET" });
    const issue = selectNextReadyIssue(body.issues ?? [], await ctx.actions.factoryItemKeys(ctx.projectRoot));
    if (!issue) return { taskId: task.id, ok: false, runner: "desktop-action", summary: "No ready issue.", output: "", changedPaths: [], warnings: [], code: "NO_READY_ISSUE" };
    const { runIds } = await ctx.actions.startFactory([issue.id], ctx.projectRoot);
    return { taskId: task.id, ok: runIds.length > 0, runner: "desktop-action", summary: `Started Factory run for issue #${issue.number}.`, output: runIds.join("\n"), changedPaths: [], warnings: [] };
  }
  ...
}
```

`startFactory` is wired in `NativeAutoTasksScreen` to the same `sendToFactory`/`startRun` the Issues screen uses; the bus claim runner calls the same `ctx.actions.startFactory`, so phone-approved `issues.implement` and the Auto Task are one path.

- [ ] **Step 4: Delete the old prompt and the Mac-only flag.** Remove `model.ts:28`, remove `implementIssues` from `MAC_ONLY`.

- [ ] **Step 5: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/runner-implement-issues.test.mjs ../ui/screens/loop/tests/native-bus-runner.test.mjs ../ui/screens/issues/tests/*.test.mjs
git commit -am "feat(tasks): Implement Issues starts a Factory run through the task registry"
```

**Compatibility:** stored `implementIssues` alias; bus kind `issues.implement` unchanged; the Factory run record is the output. **Rollback:** registry `unported` or revert; the Issues screen path is untouched. **User-visible change:** the task is runnable (was disabled); it picks the oldest ready issue and starts one Factory run, with no model prompt and no auto-ship.

---

### Task 8 — `review.merge` (Review & Merge)

**Files:**
- Modify: `schema/tasks/registry.json` (task), `ui/screens/autotasks/native/model.ts:29`, `:72`
- Modify: `ui/screens/tasks/runner.ts` (`desktop-action` action `factory.ship-review`)
- Modify: `ui/screens/loop/native/ShipPanel.tsx` (accept an initial run id from the task runner), `ui/screens/loop/native/NativeLoopScreen.tsx:151-152`, `:924`
- Test: `ui/screens/tasks/tests/runner-review-merge.test.mjs`

**Interfaces:**
- Consumes: `readRecentRuns` (`ui/screens/loop/native/history.ts`), `shipRequest`/`shipTarget` (`ship-model.ts:16-35`, `:75-90`), `POST /kb/loop/ship` (user click only).
- Produces: `runTask("reviewMerge", ctx)` returns `{ ok, action: "ship-review", runId }`; it never calls `/kb/loop/ship`.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";

test("Review & Merge opens the latest passed Factory run and never ships", async () => {
  const shipCalls = [];
  let reviewed = null;
  const out = await runTask("reviewMerge", {
    projectRoot: "/p",
    core: { request: async (path) => { if (path === "/kb/loop/ship") shipCalls.push(path); return { text: "diff", truncated: false, patchId: "a".repeat(64), files: ["x"] }; } },
    host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null,
    changedPaths: async () => [], revert: async () => {},
    actions: { reviewPendingMerge: async (root, runId) => { reviewed = runId; return { runId: runId ?? "r1", reviewed: true } } },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(shipCalls, []);
  assert.equal(reviewed, null); // null = "latest passed run"; the action resolves it
  assert.match(out.summary, /review/i);
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/runner-review-merge.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Add the registry entry.** `runner.kind:"desktop-action"`, `action:"factory.ship-review"`, `input:{kind:"repo", required:true}`, `readOnly:true` (the task itself does not write; Ship is a separate user click), `requiresRepo:true`, `requiresLocalHost:true`, `features:[]`, `output.persist:"log"`. Also `output.revertWrites:false` and `schedule.backend:"none"` (D17: it opens a panel for a person, so a timer must never run it). The label stays "Review & Merge" for stored history, but the description says "Review the pending Factory run; merging is a separate Ship click."

- [ ] **Step 3: Implement the action.** Extract the body of `NativeLoopScreen`'s `reopenWorktree` (`:279-289`) into `ui/screens/tasks/ship-review.ts` so the screen and the task use one builder. It must:
  - read `invokeHost<RunInfo[]>("loop_worktree_list")` (the Rust command at `desktop/src-tauri/src/loop_worktree.rs:572-574`, returning `runId/project/repo/worktree/branch/baseCommit`);
  - read `readRecentRuns(fs, 50)` (`history.ts:41-60`) and keep the newest entry whose `statusCode === "success"` and whose `id` has a live worktree;
  - load the run record (`loadRunRecord` in `history.ts`) for its `workItem`, so `ShipPanel` gets a real `WorkItem`, not a synthesized title;
  - open `ShipPanel` with `{ info, item, entry, passed:true, reviewedPatchId: fields.diffSummary?.patchId ?? null }`, the same shape as `NativeLoopScreen.tsx:288`.
  `ShipPanel` keeps its own diff read (`loop_worktree_diff`) and its `reviewedPatchIdWarning` guard (`ship-model.ts:106-120`). If no passed run with a live worktree exists: `NO_PENDING_RUN`.

- [ ] **Step 4: Delete the old prompt and Mac-only flag.** Remove `model.ts:29`, remove `reviewMerge` from `MAC_ONLY`.

- [ ] **Step 5: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/runner-review-merge.test.mjs ../ui/screens/loop/tests/native-ship.test.mjs ../ui/screens/loop/tests/native-bus-runner.test.mjs
git commit -am "feat(tasks): Review & Merge opens the latest passed Factory run without auto-shipping"
```

**Compatibility:** bus `issues.implement` still never ships (`bus-runner.ts:72-80`); the Ship route is unchanged. **Rollback:** registry `unported` or revert. **User-visible change:** runnable (was disabled); it reviews the pending run and stops; the user still clicks Ship.

---

### Task 9 — `issues.from_notes` (Sources → Issue)

**Files:**
- Modify: `schema/tasks/registry.json` (task), `ui/screens/autotasks/native/model.ts:27`, `:72`
- Create: `extension/agents/issue-writer.mjs` (extract `parseIssueWrite`, `providerCall`, `callProvider`, `onceForIdem` from `extension/routes/issue-writes.mjs:26-120`; the route imports it)
- Create: `extension/agents/tasks/issues-from-notes.mjs`
- Create: `extension/kb/migrations/<next>-issue-source-links.sql`, `extension/kb/issue-source-links.mjs` (+ `extension/tests/issue-source-links.test.mjs`)
- Modify: `extension/routes/issue-writes.mjs` (thin route over `issue-writer.mjs`), `extension/agents/task-runner.mjs`
- Modify: `schema/bus/registry.json` + `extension/routes/bus/registry.json` (`issues.from_notes` becomes `available:true`; run `node scripts/conformance-bus.mjs --sync`)
- Test: `extension/tests/issues-from-notes.test.mjs`

**Interfaces:**
- Consumes: `kb.search(userId, { kind: "action", limit, projectId })` (`extension/kb/db.mjs:221-260`), `issue-writer.createIssue({ userId, provider, repo, title, body, idem })`.
- Produces: `POST /kb/tasks/issues.from_notes/run` body `{ projectId, args:{ provider, repo, since? } }` -> `{ created, skipped, issues }`.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoreTask } from '../agents/task-runner.mjs';

test('issues.from_notes creates one issue per new action and skips repeats', async () => {
  const created = [];
  const out = await runCoreTask({
    taskId: 'sourcesToIssue', userId: 'u1', projectRoot: '/p',
    args: { provider: 'github', repo: 'o/r', since: '2026-11-01' },
    deps: {
      searchActions: async () => [
        { ref: 'llm-doc/meetings/a.md', text: 'Send the invoice', createdAt: '2026-11-02T00:00:00Z' },
        { ref: 'llm-doc/meetings/a.md', text: 'Send the invoice', createdAt: '2026-11-02T00:00:00Z' },
      ],
      createIssue: async (a) => { created.push(a); return { id: 7, url: 'https://github.com/o/r/issues/7' }; },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(created.length, 1);
  assert.equal(out.summary, 'Created 1 issue; skipped 1 duplicate.');
});
```

Run: `cd extension && node --test tests/issues-from-notes.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Extract the writer.** `agents/issue-writer.mjs` exports the pure parser and the provider call; it takes `token`, `makePinnedFetch`, `onceForIdem` and the clock as deps. `routes/issue-writes.mjs` becomes a 40-line HTTP wrapper that resolves the token and calls it. This is required because `agents/` (L3) cannot import a route module (L4): the task runner cannot reuse the route's private functions otherwise. The existing `issue-writes` tests must stay green (they cover the parser and idempotency).

- [ ] **Step 3: Implement the adapter.** `agents/tasks/issues-from-notes.mjs`:
  - reads actions via `deps.searchActions` (the real one calls `kb.search`);
  - filters `since` (inclusive) and dedupes by `${ref}\0${sha256(text)}`;
  - maps each to `{ title: first line <= 255 chars, body: text + source ref, capped at 20 000 chars (ISSUE_LIMITS.body) }`;
  - calls `createIssue` with a deterministic idem (`taskId + ref + textHash`, 16-64 chars);
  - stops at 20 creates per run (the bus `issueIds` cap is 20, `schema/bus/registry.json:117`); reports the rest as `skipped`.
  - A provider failure is a `TaskResult` with `ok:false` and the typed code, not a silent partial success.

  **Durable record (D15, R-037 #2).** `onceForIdem` is in memory for 10 minutes (`issue-writes.mjs:17-18`), so by itself a second run, or any run after a restart, would create every issue again. Add one append-only migration (the next free number under `extension/kb/migrations/`) for `issue_source_links (user_id, provider, repo, source_ref, text_hash, issue_number, issue_url, created_at)`, unique on `(user_id, provider, repo, source_ref, text_hash)`, with `extension/kb/issue-source-links.mjs` (`findLink`, `recordLink`; `userId` first, as every kb helper). The adapter looks the action up before calling the provider and records the link in the same step as a successful create; an action with a link is reported as `skipped: already filed (#n)`. Tests: a second run with the same actions creates nothing; a run after "restart" (fresh module state, same DB) creates nothing; another user's link never suppresses this user's create. The entry is `schedule: { backend: "none" }` (D17): a person starts every run.

- [ ] **Step 4: Flip the bus kind and wire its executor.** `schema/bus/registry.json`: `issues.from_notes.available: true`, `"engineless": true` (the conformance gate refuses an available write kind without it, `scripts/conformance-bus.mjs:56-57`), remove `unavailableReason`; keep tier T1/lane write. The kind was unavailable, so there is no stored command to keep compatible: add `provider` (`enum:["github","gitlab"]`) and `repo` (the same `owner/name`/project-path shape as `issue-writes.mjs:39-42`) to `issues.from_notes.args.required`, alongside `projectId`; `since` stays optional. The desktop task config's `repo` supplies them, and a phone command must name the exact repo its approval covers. Update the command fixtures and the tier matrix, then `node scripts/conformance-bus.mjs --sync`. In `extension/routes/bus/executor.mjs`:
  - add `'issues.from_notes': 'external.write'` to `KIND_CLASS` (`:33`);
  - import `runIssuesFromNotes` from `agents/tasks/issues-from-notes.mjs`;
  - add the branch beside `:148-150`: `else if (kind === 'issues.from_notes') result = await runIssuesFromNotes({ userId, args, signal });`
  - the kind's task entry lists `gantt_issues`; `runCoreTask` refuses when the feature is off, and the bus executor checks the same feature before calling (the route's `featureDisabledFor` only covers HTTP paths, not bus kinds). The bus registry has no per-kind feature field today, so `GET /bus/kinds` still lists the kind; the execution-time refusal is `TASK_NOT_AVAILABLE`/`feature_disabled`, never a run with the feature off. Adding `features` to the bus kind is a follow-up, not part of this commit.

Run `node scripts/conformance-bus.mjs --sync` and the bus tests (`extension/tests/command-bus.test.mjs` asserts the unavailable list at `:318`; update that assertion to only `loop.run`/`custom.run`). This is a wire-visible change: the phone can now enqueue the kind, and it still needs desktop approval (T1). Everything that states the kind's availability changes in this same commit, or `make docs-check` and the contract gate go red: `docs/spec/command-bus.md` (the kinds table row and the unavailable list), `schema/http/fixtures/bus/get-bus-kinds-200-*.json`, `schema/bus/fixtures/tiers/matrix.json`, and the spec-values guard (`docs/_scripts/test_check_spec_values.py`). Bump `SERVER_API_VERSION` by one: `GET /bus/kinds` answers differently.

- [ ] **Step 5: Resolve the repo on the desktop and delete the old prompt.** `runTask` for `issues.from_notes` resolves the active linked repo with `readRepoConfig()` (the same source the Issues screen uses) and passes `{ provider, repo }` in `args`; no repo field is added to the task config, and no user-typed repo reaches the core. With no active repo the task returns `NO_REPO` before any request. Remove `model.ts:27`, remove `sourcesToIssue` from `MAC_ONLY`.

- [ ] **Step 6: Run and commit.**

```bash
cd extension && node --test tests/issues-from-notes.test.mjs tests/issue-writes.test.mjs tests/command-bus.test.mjs
cd .. && node scripts/conformance-tasks.mjs && node scripts/conformance-bus.mjs && make contract-gates
git commit -am "feat(tasks): Sources→Issue extracts note actions and creates allow-listed issues"
```

**Compatibility:** the bus kind is now available; the gate is still T1 desktop approval. Existing issue-write routes and their host-proof rule are unchanged. **Rollback:** set the task `unported` and the bus kind `available:false` with its old reason; revert the commit. **User-visible change:** runnable (was disabled); it creates issues only for repos already on the Issues board (the existing `findTicket` allow-list, `issue-writes.mjs:160-166`), and it reports duplicates instead of re-creating them.

---

### Task 10 — `issues.update` (Update Issues): alias, do not duplicate

**Files:**
- Modify: `schema/tasks/registry.json` (alias entry), `ui/screens/autotasks/native/model.ts:33`
- Test: `ui/screens/tasks/tests/alias-update-issues.test.mjs`

**Interfaces:**
- Produces: `resolveTaskId("updateIssues") -> "issues.from_notes"`; `TASK_BY_ID["issues.update"]` has `availability.status:"alias"`, `aliasOf:"issues.from_notes"`.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskId } from "../model.ts";
import { TASK_BY_ID } from "../registry.generated.ts";

test("Update Issues is an alias of Sources→Issue", () => {
  assert.equal(resolveTaskId("updateIssues"), "issues.from_notes");
  assert.equal(TASK_BY_ID["issues.update"].aliasOf, "issues.from_notes");
  assert.equal(TASK_BY_ID["issues.update"].runner, null);
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/alias-update-issues.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Add the alias entry.** `availability:{status:"alias", reason:"Update Issues is Sources→Issue; the old prompt is retired."}`, `aliasOf:"issues.from_notes"`, `aliases:["updateIssues"]`, `features:[]`. `ALIASES.updateIssues` points at `issues.update` (the recorded row, so the Task 1 alias test holds); `resolveTaskId` follows `aliasOf` one step, so `resolveTaskId("updateIssues") === "issues.from_notes"`. Add a conformance check that an `aliasOf` target exists, is `available`, and no cycle exists.

- [ ] **Step 3: Delete the prompt.** Remove `model.ts:33`. Stored `updateIssues` config/history resolves to `issues.from_notes`; the UI shows one row labelled "Sources → Issue". If a user had a custom prompt for Update Issues, it is ignored (the target is deterministic); surface a one-time notice "Update Issues was merged into Sources → Issue."

- [ ] **Step 4: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/alias-update-issues.test.mjs
git commit -am "feat(tasks): alias Update Issues to Sources→Issue and delete its prompt"
```

**Compatibility:** alias only; no data loss. **Rollback:** revert. **User-visible change:** "Update Issues" disappears as a separate runnable task; its history resolves to Sources→Issue.

---

### Task 11 — `review.code` (Review Code)

**Files:**
- Modify: `schema/tasks/registry.json` (task), `schema/tasks/prompts/review.code.md`
- Create: `extension/agents/tasks/review.mjs` (move `FOCUS`, `reviewPrompt`, `runReview` from `extension/routes/bus/review.mjs:9-61`; the engine and git are injected ports, never imported from `routes/`)
- Modify: `extension/routes/bus/review.mjs` (thin wrapper that supplies `runTask`/`engineIdFor`/`git`), `extension/routes/bus/executor.mjs:148-150` (call the agent module), `extension/agents/task-runner.mjs` (agent dispatch takes `deps.runAgent`)
- Modify: `ui/screens/autotasks/native/model.ts:30`
- Test: `extension/tests/task-review-code.test.mjs`, `ui/screens/tasks/tests/review-code-prompt.test.mjs`

**Interfaces:**
- Produces: `reviewPromptFor("review.code", evidence="")` in `agents/tasks/review.mjs`; the text is the generated prompt, not a second `FOCUS` table.
- Produces: `runTask("reviewCode", ctx)` -> `POST /kb/tasks/review.code/run` with `args:{}`; no prompt in the body.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewPromptFor } from '../agents/tasks/review.mjs';

test('review.code uses the registry prompt verbatim', () => {
  // Captured from today's reviewPrompt('code') BEFORE anything moves (Step 2).
  const want = readFileSync(new URL('./fixtures/review-prompt-code.txt', import.meta.url), 'utf8');
  assert.equal(reviewPromptFor('review.code', ''), want);
});
```

Run: `cd extension && node --test tests/task-review-code.test.mjs`. Expected: FAIL (module missing).

Also add `ui/screens/tasks/tests/review-code-prompt.test.mjs`: a fake `runTask` captures the `POST /kb/tasks/review.code/run` body and asserts it is `{}` (no `prompt`, no `message`). This is the test that keeps the desktop from re-introducing a prompt copy.

- [ ] **Step 2: Add the prompt and entry.** First write today's `reviewPrompt('code')` output to `extension/tests/fixtures/review-prompt-code.txt` (the same for `doc` and `conflicts` in Tasks 12 and 13). Then create `schema/tasks/prompts/_review.frame.md` once: the READ-ONLY preamble, a `{{focus}}` line and the concise-markdown instruction from `review.mjs:14-22`, separated by blank lines. `schema/tasks/prompts/review.code.md` holds only the current `FOCUS.code` sentence. The entry names both (`prompt` and `frame`), the generator inlines the frame once, and `reviewPromptFor` fills the slot, so the shared text exists once instead of three times (R-037 #14). The dynamic `Evidence gathered by the host...` block stays in `runReview` and is appended when evidence is non-empty; it is not stored in the prompt file. The test with no evidence proves the static text is byte-identical to the old prompt. Entry: `runner.kind:"agent"`, `busKind:"review"`, `busArgs:{focus:"code"}`, `engine:{mode:"read"}`, `prompt:"prompts/review.code.md"`, `readOnly:true`, `requiresRepo:true`, `requiresLocalHost:false` (the core can review a registered project), `features:[]`.

  **What changes for Auto Tasks (D16, R-037 #5).** Today these three tasks run `/kb/loop/agent-run` in `loop_work_root` with the user's stored prompt, an optional skill, input/output paths and the model-limit fallback (`NativeAutoTasksScreen.tsx:180-215`). After this task they run the bus review engine: one engine for the phone and the desktop. State it in the commit message and the UI copy; do not call it "the same output". Rules:
  - **Folder.** The bus runs a review in the registered project root. The task adds an optional `args.repo` (a project-relative clone folder, validated against the user's repo allow-list and realpath-checked like the project root); the desktop sends the linked repo it used to pass as `loop_work_root`. A root that is not a git repository answers `NOT_A_REPO` instead of reviewing nothing.
  - **Prompt.** The editor stays as an override (D9): empty means the registry prompt. A non-empty `promptOverride` replaces only the focus sentence, never the READ-ONLY frame, and is sent as `args.focusText` (bounded, fence-neutralised), so the route still accepts no free prompt.
  - **Dropped, and said so in the task's hint:** the skill picker and the input/output paths for the three review tasks (the bus review has neither). The model-limit decision moves to the core, which already applies the per-model cap and fallback to a bus engine run.

- [ ] **Step 3: Move the logic with injected ports.** `agents/tasks/review.mjs` owns `reviewPromptFor`, the git evidence collection and `runReview`. It must not import `routes/bus/engines.mjs` or `routes/bus/git-safe.mjs` (L4); it takes `deps.runTask`, `deps.engineIdFor` and `deps.git` and calls them. `routes/bus/review.mjs` becomes the wrapper that supplies the real functions from `engines.mjs`/`git-safe.mjs`; `routes/bus/executor.mjs` calls the wrapper as today. `agents/task-runner.mjs` calls `runReview` with the ports the task route injects (`routes/tasks.mjs` imports `runTask`/`engineIdFor` from `routes/bus/engines.mjs` and passes them in `deps`). There is no cycle and no L3 -> L4 import. When the engine interface itself moves down later, only the wrapper changes.

- [ ] **Step 4: Wire Auto Tasks and delete the old prompt.** `model.ts:30` removed; `NativeAutoTasksScreen` uses `runTask` with a read-only `core-route`/`agent` result. The "Effective prompt" panel (`NativeAutoTasksScreen.tsx:483-498`) shows the framed registry prompt via `taskPrompt`, with the override applied when one is set. A prompt the user had edited (the stored `prompt` differs from the old default at `model.ts:30`) is carried into `promptOverride` by the Task 15 migration; an unedited one is dropped.

- [ ] **Step 5: Run and commit.**

```bash
cd extension && node --test tests/task-review-code.test.mjs tests/loop-agent.test.mjs
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/review-code-prompt.test.mjs
cd .. && node scripts/conformance-tasks.mjs && make contract-gates
git commit -am "feat(tasks): Review Code reads its prompt from the task registry"
```

**Compatibility:** the bus `review` response shape is unchanged; the prompt text is byte-identical to the old `FOCUS.code` wrapper (the test enforces it). **Rollback:** revert; the bus route still has the old copy until the wrapper is removed. **User-visible change:** Review Code in Auto Tasks now runs on the bus review engine with the registry prompt (the wording differs from the old Auto Tasks default); an edited prompt is kept as an override; the skill and input/output fields are gone for this task. The phone's `review` command is unchanged.

---

### Task 12 — `review.doc` (Review Doc)

**Files:**
- Modify: `schema/tasks/registry.json`, `schema/tasks/prompts/review.doc.md`
- Modify: `ui/screens/autotasks/native/model.ts:31`
- Test: `extension/tests/task-review-doc.test.mjs`

**Interfaces:** same as Task 11 with `busArgs:{focus:"doc"}`; `reviewPromptFor("review.doc")`.

- [ ] **Step 1: Write the failing test.** Same shape as Task 11, reading `schema/tasks/prompts/review.doc.md` and asserting `reviewPromptFor("review.doc", "")`; also assert the string "stale commands or paths" appears once in the prompt file and nowhere in `extension/routes/bus/review.mjs`.

- [ ] **Step 2: Add the prompt and entry.** Copy `FOCUS.doc` (`review.mjs:11`) into the prompt file; `runner` identical to `review.code` except `busArgs.focus:"doc"`.

- [ ] **Step 3: Wire and delete.** Remove `model.ts:31`; the `focus` mapping in the adapter is the only difference. The bus `runReview` already selects by focus (`review.mjs:33-58`); after the move it selects by task id.

- [ ] **Step 4: Run and commit.**

```bash
cd extension && node --test tests/task-review-doc.test.mjs
cd desktop && node --test --experimental-strip-types ../ui/screens/autotasks/tests/*.test.mjs
git commit -am "feat(tasks): Review Doc reads its prompt from the task registry"
```

**Compatibility:** bus shape unchanged; prompt byte-identical. **Rollback:** revert. **User-visible change:** as Task 11 (bus review engine, registry prompt unless overridden).

---

### Task 13 — `review.conflicts` (Review Conflicts)

**Files:**
- Modify: `schema/tasks/registry.json`, `schema/tasks/prompts/review.conflicts.md`
- Modify: `ui/screens/autotasks/native/model.ts:32`
- Test: `extension/tests/task-review-conflicts.test.mjs`

**Interfaces:** `runner.kind:"agent"`, `busArgs:{focus:"conflicts"}`, `runner.deterministicFirst:"git-conflicts"`, `features:[]`; `runReview` keeps the `ls-files -u` / `diff --check` pre-check (`review.mjs:33-40`) and returns `modelCalls:0` when clean.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../agents/tasks/review.mjs';

test('a clean worktree answers with no model call', async () => {
  let modelCalls = 0;
  const out = await runReview({
    userId: 'u1', args: { focus: 'conflicts' }, cwd: '/p', signal: null,
    emit: () => {},
    deps: {
      git: async (_cwd, args) => {
        if (args.includes('ls-files')) return { code: 0, stdout: '', stderr: '' };
        if (args.includes('--check')) return { code: 0, stdout: '', stderr: '' };
        modelCalls += 1; return { code: 0, stdout: 'should not run', stderr: '' };
      },
      runTask: async () => { modelCalls += 1; return { text: 'x' }; },
    },
  });
  assert.equal(out.modelCalls, 0);
  assert.equal(modelCalls, 0);
  assert.match(out.text, /No findings/);
});
```

Run: `cd extension && node --test tests/task-review-conflicts.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Add the prompt and entry.** Copy `FOCUS.conflicts` (`review.mjs:12`); keep the deterministic pre-check as the task's `deterministicFirst`. `readOnly:true`, `requiresRepo:true`, `features:[]`.

- [ ] **Step 3: Wire and delete.** Remove `model.ts:32`; the Auto Tasks run is a `POST /kb/tasks/review.conflicts/run`. The `ui/screens/review` viewer is untouched (it is not the task).

- [ ] **Step 4: Run and commit.**

```bash
cd extension && node --test tests/task-review-conflicts.test.mjs
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/*.test.mjs
git commit -am "feat(tasks): Review Conflicts keeps the deterministic git check and reads its prompt from the registry"
```

**Compatibility:** bus shape unchanged; no model call when git finds nothing, as today. **Rollback:** revert. **User-visible change:** none in output; the task is now runnable in Auto Tasks by the same path.

---

### Task 14 — Loop templates and stages generated from the registry

**Files:**
- Modify: `schema/tasks/templates.json` (all built-ins), `schema/tasks/registry.json` (Factory stage tasks + Loop-only stage tasks)
- Modify: `scripts/gen-task-registry.mjs`, `scripts/conformance-tasks.mjs`
- Create: `ui/screens/loop/native/templates.generated.ts`, `ui/screens/loop/native/defaults.generated.ts`
- Modify: `ui/screens/loop/native/templates.ts:31-71`, `ui/screens/loop/native/defaults.ts:5-644`, `ui/screens/loop/native/factory.ts:27-62`
- Modify: `ui/screens/loop/native/model.ts` (add `promptRef`, `promptHash` to `LoopStage`; decode/encode)
- Modify: `ui/screens/loop/native/stage-exec.ts:145` (`runSkill` resolves `promptRef` through `taskPrompt`, falls back to the inline `prompt`)
- Modify: `ui/screens/loop/native/store.ts:56-78` (replace `macBatchReason` with registry availability)
- Test: `ui/screens/loop/tests/generated-templates.test.mjs`, `ui/screens/loop/tests/prompt-upgrade.test.mjs`

**Interfaces:**
- Produces: `BUILT_IN_TEMPLATES` and `DEFAULT_LOOP_SPECS` from the generated module; `LoopStage.promptRef`/`promptHash` additive fields.
- Produces: `upgradeDefaultStage(stage, task) -> LoopStage` in `templates.ts` (or a new `defaults-upgrade.ts`), using `defaultRevision` + `promptHash`.

**Commit split (R-037 #11).** This is five commits, not one, each with its own failing test: **14a** the generator emits the template modules and `templates.ts`/`defaults.ts` re-export them, arrays byte-identical to today (a test deep-compares the generated arrays with the hand-written ones before those are deleted); **14b** one commit per starter loop (Regression, Test, Plan, Refactoring, Doc Optimization) moving its stage prompts into `schema/tasks/prompts/`; **14c** the Factory prompts (`factoryLoop()` in `templates.ts` stays the builder of the seventh default loop and keeps `factoryVerifyProblem`); **14d** `promptRef`, the known-revision upgrade and the editor rule (Step 4); **14e** the stale Mac stages (Step 5). Template ids do not change (`"factory"`, `"regression"`, … are compared in `NativeLoopScreen.tsx` and stored in custom-template selections).

- [ ] **Step 1: Write the failing test.**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_TEMPLATES, DEFAULT_LOOP_SPECS } from "../native/templates.generated.ts";

test("the generated Loop templates have no Mac build stages and reference real tasks", () => {
  const commands = [...BUILT_IN_TEMPLATES, ...DEFAULT_LOOP_SPECS]
    .flatMap((t) => t.config.stages)
    .map((s) => s.command ?? "");
  assert.equal(commands.some((c) => /(^|\s)mac\//.test(c) || /cd mac\b/.test(c)), false);
  assert.ok(BUILT_IN_TEMPLATES.some((t) => t.id === "factory"), "template ids are unchanged");
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/loop/tests/generated-templates.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 2: Move the prompt bodies.** For every skill stage in `defaults.ts` and `factory.ts`, create `schema/tasks/prompts/<stage-task-id>.md` with the current `prompt` text exactly. Add a `task` entry with `runner.kind:"agent"` for the skill stages (`runner.skill`, `runner.prompt`, `runner.stage` where applicable) and `runner.kind:"shell"` for the shell stages. Factory roles become `factory.intake`, `factory.plan`, `factory.implement`, `factory.verify`, `factory.review`: the first three and `factory.review` are `agent` with prompts `factory.intake.md`, etc.; `factory.verify` is `shell` with `stage.kind:"shellCommand"` and no prompt. Keep `FACTORY_REPAIR_HINT` as a `repairPrompt` on the Factory template, not a task prompt.

- [ ] **Step 3: Generate templates.** `templates.json` gets every built-in. The generator emits `templates.generated.ts` with `BUILT_IN_TEMPLATES` (kind `recipe`) and `DEFAULT_LOOP_SPECS` (kind `starter`). `applyTemplate`, `factoryLoop`, `initialProjectStore` and `ensureDefaultLoops` keep their signatures but read the generated arrays. Stage `id` values are generated fresh at apply time, as today (`templates.ts:78-84`).

- [ ] **Step 4: Upgrade unedited default stages.** Add `promptRef`/`promptHash` to `LoopStage` (`model.ts:21-47`, decode `:91-120`, encode `:190-213`). `ensureDefaultLoops` (or `starterLoop`) upgrades a stage when:
  - `stage.isDefault === true`;
  - `stage.promptRef` maps to a registry task;
  - `stage.defaultRevision < task.revision`;
  - the prompt is unedited: `sha256Hex(stage.prompt ?? "")` (the existing synchronous helper in `ui/screens/chat/approvals/digest.ts:15`) equals `stage.promptHash`, **or** the stage has no hash yet and that digest is one of the task's `knownPromptHashes` (R-037 #7). The second branch is what lets a project created before this plan follow the registry; without it no existing `loop.json` would ever upgrade.
  It then writes the new prompt, hash and revision. A stage whose prompt matches no known revision was edited by the user and is left alone, permanently. `runSkill` (`stage-exec.ts:145`) must use the registry prompt when `stage.promptRef` is set and the stage is unedited, else the inline `stage.prompt`; this is what makes a registry change reach a project without rewriting `loop.json` on every open. Test: an unedited Regression/Test stage upgrades; a hand-edited prompt does not; a stage with `promptRef` runs the registry text even when its inline `prompt` is an older copy.

  **The editor shows what runs.** When a stage resolves its prompt from the registry, the stage editor shows that text (with a "built-in prompt, revision n" note), not the stale inline copy; the first edit detaches the stage (`promptRef` cleared, the edited text saved inline). There must never be one prompt on screen and another sent. Test: the rendered prompt of an unedited default stage equals `taskPrompt(promptRef)`.

- [ ] **Step 5: Fix the stale Mac stages.** `operation-diagnosis` loses `cd mac && swift build`; `system-check` loses `cd mac && swift test` and `make test-shared-protocol` if it is Mac-only. Replace with `cd extension && npm run build` and `make test` where the repo actually has them. The conformance gate's `cd mac` rule must stay.

- [ ] **Step 6: Delete the old arrays.** Remove `BUILT_IN_TEMPLATES` (`templates.ts:31-71`) and `DEFAULT_LOOP_SPECS` (`defaults.ts:5-644`) after the generated module is the only source. `templates.ts` keeps `LoopTemplate`, `applyTemplate`, `factoryLoop`, `initialProjectStore`, `ensureDefaultLoops` and the custom-template store; `factory.ts` keeps `agentRunBody`, `guardedPaths`, `configFor`, `workItem*` and the role helpers, but loses the inline prompts.

- [ ] **Step 7: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/loop/tests/*.test.mjs ../ui/screens/tasks/tests/*.test.mjs
cd .. && node scripts/conformance-tasks.mjs && make contract-gates
git commit -am "feat(loop): generate built-in templates and stage prompts from the task registry"
```

**Compatibility:** `system/loop.json` keeps its inline prompts; the additive `promptRef`/`promptHash` fields are ignored by older builds; a stage with no hash is never upgraded. **Rollback:** revert; the old arrays return. **User-visible change:** the built-in loops are textually the same (prompts moved byte-for-byte), except the stale Mac build stages are replaced; a registry prompt revision now upgrades unedited default stages on the next project open.

---

### Task 15 — Project-scoped config, one scheduler, one run history

**Files:**
- Create: `ui/screens/tasks/store.ts`, `ui/screens/tasks/schedule.ts`, `ui/screens/tasks/tests/store.test.mjs`, `ui/screens/tasks/tests/schedule.test.mjs`
- Modify: `ui/screens/autotasks/native/model.ts:43-66` (remove the global store; keep aliases/types), `NativeAutoTasksScreen.tsx:43-80`, `:117-146`, `:474`
- Modify: `ui/screens/shell/Shell.tsx:194-202` (start the one scheduler)
- Modify: `ui/screens/autotasks/native/custom.ts`/`custom-schedule.ts` (custom tasks become dynamic tasks in the same store/scheduler)
- Modify: `ui/screens/autotasks/native/schedule.ts` (delete the custom-only scheduler or make it a wrapper)

**Interfaces:**
- Produces: `loadTaskState(projectRoot)`, `saveTaskState(projectRoot, state)`, `migrateLegacyState(projectRoot)`.
- Produces: `startTaskScheduler(projectRoot, deps) -> stop`; `dueTasks(state, now, fired) -> TaskId[]`.
- Produces: `TaskConfig { enabled, inputPath, outputPath, skillName, promptOverride, cron, scheduleActive }`.

- [ ] **Step 1: Write the failing test.**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTaskState, saveTaskState } from "../store.ts";

function mem() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; }

test("two projects keep different task configs", () => {
  const s = mem();
  const a = loadTaskState("/p/a", s);
  a.configs["review.code"] = { ...a.configs["review.code"], enabled: true, cron: "0 * * * *" };
  saveTaskState("/p/a", a, s);
  const b = loadTaskState("/p/b", s);
  assert.equal(b.configs["review.code"].enabled, false);
  assert.equal(loadTaskState("/p/a", s).configs["review.code"].enabled, true);
});

test("legacy global config is migrated once, by alias", () => {
  const s = mem();
  s.setItem("llmide.autoTasks.v1", JSON.stringify({ masterEnabled: true, configs: { sourceUpdate: { enabled: true, cron: "0 9 * * *", scheduleActive: true } } }));
  const st = loadTaskState("/p/a", s);
  assert.equal(st.masterEnabled, true);
  assert.equal(st.configs["sources.update"].enabled, true);
  assert.equal(st.configs["sources.update"].cron, "0 9 * * *");
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/store.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 2: Implement the store.** Key `llmide.tasks.v2:<normalized project root>`; state `{ masterEnabled, configs }`; every `available` task id in the registry gets a default config (`enabled:false`, `cron:"0 * * * *"`, `scheduleActive:false`, `promptOverride:null`). Legacy migration reads `llmide.autoTasks.v1` once per project, maps keys through `resolveTaskId`, writes the new key, and sets `llmide.tasks.v2.migrated` (a set of project roots) so a later legacy edit does not overwrite the project state. `promptOverride` is only accepted for `agent` tasks; for any other runner it is `null` and the UI hides the editor.

  **Migration safety (D17, R-037 #3 and #5).** For every task whose runner changed in Tasks 2-13 (all seven former `MAC_ONLY_TASK_IDS` plus the three review tasks), the migrated config keeps `enabled` and `cron` but sets `scheduleActive: false`; the one-time notice lists them ("These schedules were switched off because the task now does real work: …"). A task with `schedule.backend: "none"` has no schedule fields at all. A stored review prompt that differs from the old default text becomes `promptOverride`; an unedited one is dropped. Tests: a legacy `implementIssues` config with `scheduleActive: true` migrates to `false`; `dueTasks` never returns a `backend: "none"` task, whatever its stored config says.

- [ ] **Step 3: One scheduler.** `startTaskScheduler` runs every 30 s (the current cadence, `NativeAutoTasksScreen.tsx:144`), checks `autoTaskBusy()`/the Loop run manager's `liveRuns()` for a write task in the same project, computes due tasks with `takeDueAutoTasks` (reuse `due.ts`), and runs them one at a time through `runTask`. Custom tasks are `TaskDef`s built at runtime (`custom:<id>`, `runner.kind:"agent"`, `promptSource:"user"`) and go through the same queue; `runTask` resolves `extraTasks` after the registry and before failing `UNKNOWN_TASK`. An app-scoped task (`plan.status`, `sources.update`) is scheduled from the active project only and never once per open project; the scheduler keeps one fired key per task id, not per project. Start it from `Shell.tsx:194-202` with the open project; delete the page-local effect. The hint at `NativeAutoTasksScreen.tsx:474` becomes "Schedules run while the app is open; missed runs are not backfilled."

  **Cost (R-037 #12).** A scheduled `agent` task asks the core before it starts; a member or project at its monthly cap gets `USD_CAP` and the slot is skipped with that reason in the run list. Every agent task run is metered with its `taskId` (ledger `source: "task"`, `detail.taskId`), so `scripts/auto-task-usage.mjs` can report spend per task. Test: a capped member's scheduled run makes no engine call.

- [ ] **Step 4: Run history by id.** Add `taskId` to each run record (`NativeAutoTasksScreen.tsx:189`, `:219`, `:227`) while keeping `task` (the old label) for display. The Recent runs list resolves the label through `TASK_BY_ID[taskId]?.label ?? task`.

- [ ] **Step 5: Run and commit.**

```bash
cd desktop && node --test --experimental-strip-types ../ui/screens/tasks/tests/*.test.mjs ../ui/screens/autotasks/tests/*.test.mjs ../ui/screens/shell/tests/*.test.mjs
git commit -am "feat(tasks): project-scoped task config and one scheduler for built-in and custom tasks"
```

**Compatibility:** legacy `llmide.autoTasks.v1` is read once and never deleted; old run records keep `task`; custom tasks keep their `llmide.customAutoTasks.v1` store and are read into the new scheduler. **Rollback:** revert; the legacy key is untouched. **User-visible change:** built-in schedules now fire while any section is open (not only Auto Tasks); each project has its own task settings; a one-time notice says the old settings were copied into this project.

---

### Task 16 — Delete the duplicates, update the docs and close the gates

**Files:**
- Delete: `ui/screens/autotasks/AutoTasksScreen.tsx` (dead bridge screen), any remaining `TASKS` array / `MAC_ONLY_TASK_IDS` / `LOCAL_TASKS`, `BUILT_IN_TEMPLATES`/`DEFAULT_LOOP_SPECS` arrays if Task 14 left stubs
- Modify: `ui/screens/autotasks/native/model.ts` (delete the catalogs and the Mac-only set; keep or move the pure helpers), `scripts/auto-task-usage.mjs:51-72` (read the generated registry), `docs/spec/command-bus.md:79-92` (availability/alias notes), `docs/reference/` with a short `task-registry.md`
- Modify: `desktop/package.json`, `Makefile` (already in Task 1; verify)
- Test: `ui/screens/tasks/tests/no-duplicates.test.mjs`, `scripts/conformance-tasks.test.mjs`

**Interfaces:** none new; this task removes the old paths and proves the registry is the only one.

- [x] **Step 1: Write the failing test.** `no-duplicates.test.mjs` walks `ui/screens` and `extension/routes` and asserts:
  - no file outside `schema/tasks/prompts/` contains the first 40 characters of any prompt (a cheap duplicate detector; use the generated prompt hash);
  - `AutoTasksScreen.tsx` does not exist;
  - `rg` finds no `MAC_ONLY_TASK_IDS`, `MAC_ONLY_MESSAGE`, `LOCAL_TASKS`, `const TASKS: readonly AutoTaskDef[]` in `ui/screens/autotasks`;
  - `runTask` is the only exported entry point the Auto Tasks screen calls for a task.

- [x] **Step 2: Delete the dead screen and the old catalogs.** Confirm no importer first: `grep -R "AutoTasksScreen" ui desktop web --include=*.ts --include=*.tsx --include=*.mjs` returns only the file itself. Delete it. Remove the `loopEngineering` reference (it was only in the old screen).

  If `NativeAutoTasksScreen.tsx` still imports `TASKS`/`TASK_BY_ID` from `autotasks/native/model.ts`, change those imports to `ui/screens/tasks/model.ts` (or leave a one-line re-export) before deleting the local arrays; the screen must not lose its catalog. Keep the pure helpers that are not catalogs: `agentRunSucceeded` (used by `ui/screens/loop/native/stage-exec.ts:7`), `normalizeProjectPath` (used by the folder picker), `composeTaskMessage` (the effective-prompt preview) and `resetTemplateTitle`/`RESET_TEMPLATE_MESSAGE` (the reset dialog). Move them to `ui/screens/tasks/text.ts` if `autotasks/native/model.ts` should become a thin re-export, or leave them in place and delete only `TASKS`, `TASK_BY_ID`, `MAC_ONLY_TASK_IDS`, `MAC_ONLY_MESSAGE`, `blankConfig`, `defaultState`, `loadState`, `saveState` and the local `desktopRunnable`/`scheduledRunAllowed`. Do not delete a helper another module imports.

- [x] **Step 3: Update the usage script.** `scripts/auto-task-usage.mjs` reads `ui/screens/tasks/registry.generated.ts`? It is a Node script outside the UI; simplest is to read `schema/tasks/registry.json` with `readFileSync` and build `BUILT_IN_TASKS` from `tasks.map(t => t.id)` plus aliases. The ledger suffix map stays for old records (`source-update` -> `sourceUpdate` -> `sourceUpdate` alias -> `sources.update`). Add a test that every ledger suffix resolves to a registry id.

- [x] **Step 4: Update docs.** `docs/spec/command-bus.md` §5: add one paragraph that task ids are the UI vocabulary and bus kinds are the wire vocabulary, and that `loop.run`/`custom.run` remain unavailable (the `issues.from_notes` row was updated in Task 9, with the fixtures). Add `docs/reference/task-registry.md` with the schema, the generation commands and the "no prompt outside `schema/tasks/prompts`" rule. Link it from `docs/reference/project-structure.md` and `extension/CLAUDE.md` (one line each).

- [ ] **Step 5: Full gates.**

```bash
node scripts/gen-task-registry.mjs --check
node scripts/conformance-tasks.mjs
cd extension && npm run lint && npm test
cd ../desktop && npm test && npm run -s check:security && npx tsc --noEmit
cd .. && make regression
node scripts/http-inventory.mjs --coverage
make feature-matrix FM_ARGS="--key auto_tasks"
make feature-matrix FM_ARGS="--key doc_gen"
```

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "refactor(tasks): delete the duplicated Auto Task and Loop catalogs; document the registry"
```

**Compatibility:** the deleted screen was unreachable; the arrays are replaced by generated ones. **Rollback:** revert; the old files return. **User-visible change:** one Auto Tasks list, one label per task, no "Mac app" wording, and no stale Mac build stage.

---

## 4. Explicit answers to the hard cases

### 4a. Mac-only tasks that are disabled today

`MAC_ONLY_TASK_IDS` (`ui/screens/autotasks/native/model.ts:71-74`) mixes three different facts: a deterministic implementation exists in the removed Mac app, a deterministic implementation exists in the desktop but was never wired, and no implementation exists at all. The registry separates them:

| Old id | After the plan | Why |
|---|---|---|
| `sourceUpdate` | available, `runner.kind:"core-route"` | `sources.update` exists (`extension/routes/bus/sources-update.mjs:65-110`); no repo needed. |
| `regression` | available, `runner.kind:"shell"` | the Loop's `regressionSweep` exists (`stage-exec.ts:97-118`). |
| `updatePlanStatus` | available, `runner.kind:"core-route"` | `/kb/outcomes/refresh` exists (`router.mjs:1441-1471`). |
| `implementIssues` | available, `runner.kind:"desktop-action"` | the Factory run manager and bus claim runner exist (`run-manager.ts:220-230`, `bus-runner.ts`). |
| `reviewMerge` | available, `runner.kind:"desktop-action"` | `ShipPanel`/`/kb/loop/ship` exist; auto-merge is still refused by design. |
| `sourcesToIssue` | available, `runner.kind:"core-route"` | Task 9 adds the deterministic extractor over `kb.search(kind:"action")`. |
| `generateKnowledge` | retired | no durable memory writer; Task 5. |
| `generateDoc` | retired as an Auto Task | Doc Gen owns generation; Task 6. |

`MAC_ONLY_MESSAGE` and `MAC_ONLY_TASK_IDS` are deleted in Task 16. Until then the transitional `desktopRunnable` (§2i) consults the registry first. No new copy says "Mac app only"; an unavailable task says the missing capability (`batch rollback is not ported`, `no durable memory writer`, `Doc Gen needs a template`).

### 4b. Deterministic first, agent only when declared

A task's `runner.kind` is the whole answer. `shell` and `core-route` tasks never call a model; `agent` tasks always call one with the registry prompt. There is **no fallback** from a failed deterministic runner to an agent, and no "if the agent is unavailable, run the prompt anyway" path. Two tasks have a legitimate deterministic-first sequence:

- `review.conflicts`: `git ls-files -u` / `git diff --check` first; a clean result is `No findings.` with `modelCalls: 0` (the existing behavior at `review.mjs:33-40`); only a non-empty result reaches the agent prompt.
- `loop.regression`: a fault with a `verify` command runs the command; only a legacy fault with no verify command uses `/kb/complete` for the same-meaning check (`stage-exec.ts:97-118`). That is a comparison step, not a task fallback.

If a deterministic adapter throws, the task fails with its typed code. It does not become an agent task.

### 4c. Schedules

One desktop scheduler (Task 15) owns every `schedule.backend:"desktop"` task, including built-ins and custom tasks. It ticks every 30 s, uses the existing five-field cron parser (`cron.ts`, `due.ts`) and the per-minute fired key, and runs one task at a time. It starts from `Shell.tsx:194-202` with the open project, so a schedule fires while any section is open — the current built-in scheduler dies when the Auto Tasks page unmounts (`NativeAutoTasksScreen.tsx:117-146`).

`schedule.backend:"bus"` remains the remote path: `sources.update` is the only schedulable bus kind (`extension/routes/bus/schedules.mjs:8`), and the desktop's bus scheduler already enqueues/approves its slots (`ui/screens/shell/approvals/scheduler.ts`). This plan does not move the five-field cron into the bus; that would be a separate contract change. A missed slot is not backfilled, matching the current custom scheduler. The master switch still gates every desktop schedule.

### 4d. Project scope

Every built-in task is project-scoped after Task 15: `llmide.tasks.v2:<projectRoot>` holds `{ masterEnabled, configs }`; `inputPath`/`outputPath` are project-relative (`normalizeProjectPath`, `model.ts:91-99`). `system/loop.json` is already per project. Custom tasks stay in `llmide.customAutoTasks.v1` keyed by `projectRoot` (`custom.ts:35-54`) and are read into the same scheduler. The legacy global `llmide.autoTasks.v1` is copied into a project once and never deleted. Tasks with genuinely app-wide output (`plan.status` refreshes the user's dispatched tasks, `sources.update` syncs the user's connections) declare `scope:"app"`; they still keep their per-project enable/cron so a project can opt out.

### 4e. Remote mode

Auto Tasks and Loop are local-only sections (`ui/screens/shell/sections.ts:147`), and this plan does not change that. A task with `requiresLocalHost:true` (`shell`, `desktop-action`) returns `LOCAL_ONLY` from `runTask`; the UI never lists it when `mode === "remote"`. Core tasks remain reachable through the command bus: `review` (T0), `sources.update` and `issues.from_notes` (T1, desktop approval), `issues.implement` (T2, desktop claim). The bus is the only remote entry point: `POST /kb/tasks/:id/run` requires the bus host proof (D14), so it answers only the app that spawned the core and is `403 HOST_PROOF_REQUIRED` for every other client and on a hub. `GET /kb/tasks` is still served by the core for the local desktop and omits prompts; it does not grant execution.

### 4f. No fake prompts

A prompt exists only for an `agent` task and only in `schema/tasks/prompts/`. `shell`, `core-route` and `desktop-action` tasks have `runner.prompt` absent; `conformance-tasks.mjs` fails if one appears. `taskPrompt(taskId)` throws `TASK_NOT_PROMPTABLE` for a non-agent task. The Auto Tasks "Effective prompt" panel (`NativeAutoTasksScreen.tsx:483-498`) shows a prompt only for an agent task; for a deterministic task it shows the runner line ("Runs the Loop regression stage; no model call"). A custom task is the one place a user-supplied prompt is allowed, because the user owns it (`custom.ts:9-19`).

### 4g. Deletion happens only after both surfaces read the registry

Each migration's last step is a test that the old prompt text is no longer read by either surface, then the old entry is deleted. The final cleanup (Task 16) deletes the dead bridge screen, the legacy catalog arrays and the Mac-only message only after `no-duplicates.test.mjs` proves no live surface uses them. The `LEGACY_TASKS` shim in §2i is removed in the same commit, and `conformance-tasks.mjs` fails if a legacy entry resolves to a migrated task.

---

## 5. Gates and CI

| Gate | Command | What it catches |
|---|---|---|
| Registry conformance | `node scripts/conformance-tasks.mjs` | stale generated copies, missing/duplicate prompts, bad aliases, unknown bus kind/feature/template ref, `cd mac` stages |
| Generated drift | `node scripts/gen-task-registry.mjs --check` | a hand-edited generated file |
| Contract | `make contract-gates` | HTTP schema/fixtures for `/kb/tasks`, bus copy, OpenAPI/api-types |
| UI tests | `cd desktop && npm test` | generated TS imports, availability matrix, runner dispatch, per-task tests |
| Core tests | `cd extension && npm test` | task runner, route authority, bus availability, issue writer |
| TypeScript | `cd desktop && npx tsc --noEmit` | the generated TS and the `TaskDef` unions |
| Lint/boundaries | `cd extension && npm run lint` | L0–L4 edges; no route import in the runner |
| Feature matrix | `make feature-matrix FM_ARGS="--key auto_tasks"` and `--key doc_gen` | disabled-feature 404s, `/health` endpoint list, boot without the `auto_tasks` module |
| HTTP inventory | `node scripts/http-inventory.mjs --coverage` | roster coverage; `schema/http/INVENTORY.md` stays a snapshot (do not commit a stale diff, `docs/explanation/invariants.md`) |
| Full regression | `make regression` | all of the above plus graph/agent-v2 gates |

Add `node scripts/conformance-tasks.mjs` to `contract-gates` in Task 1; add `../ui/screens/tasks/tests/*.test.*` to `desktop/package.json:11` in Task 1. Do not put the generator in the pre-push hook as a write step; the gate is `--check`, and the committed artifacts are the source of truth for CI.

---

## 6. Risks and mitigations

1. **Prompt drift while both copies exist.** Every migration copies the prompt **byte-for-byte** and the test compares the generated prompt to the old text before deleting it. `conformance-tasks.mjs` also fails if the same prompt hash appears in two files. Risk after deletion: a registry change improves all surfaces by design; that is the point, and the revision field makes it visible.
2. **`system/loop.json` is a shared, committed file.** New fields (`promptRef`, `promptHash`) are additive; older builds ignore them and keep the inline prompt. The upgrade only touches `isDefault` stages whose hash still matches, so a user edit is never overwritten. Do not bump `LOOP_SCHEMA_VERSION` for additive fields; `decodeStage` defaults them (`model.ts:91-120`).
3. **Schedules change lifetime.** Built-in tasks will fire from the shell, not only the Auto Tasks page. This is a behavior change; the UI copy says so, the master switch still gates everything, and a task still needs `enabled` + `scheduleActive`. A missed slot is not backfilled, matching the current custom scheduler.
4. **Project-scoped migration can surprise a multi-project user.** Seed each project from the legacy global config once, show a notice, and keep the legacy key. Never delete it. A user who had one config for all projects gets the same starting point per project.
5. **Remote mode.** Auto Tasks/Loop are hidden (`sections.ts:147`); the task route is still a core route, so a remote client can reach it only through the bus. `requiresLocalHost` tasks return `LOCAL_ONLY`; the desktop action layer never runs on a hub.
6. **Security of a task-run route.** The route requires the bus host proof (D14), so the bus tiers and desktop approvals cannot be bypassed over HTTP. The body cannot carry a prompt, route, command, repo path or credentials. The registry supplies the prompt/route; the handler validates `args` with the bus schema validator and the project with `projectScopeRefusal`; `ROUTE_POLICY` coverage is tested (`extension/tests/route-policy-coverage.test.mjs`). This is the difference between a task API and a generic agent API.
7. **Concurrency.** A write task and a Loop run in the same checkout can race. The scheduler checks `autoTaskBusy()` and the Loop run manager's live runs before starting a write task; Factory runs already use worktrees, and non-Factory Loop runs are the remaining risk. If both are allowed, the task refuses with `PROJECT_BUSY` rather than running in the main tree.
8. **Mac-only removal.** Users will see "not available: <reason>" instead of "Mac app only". History aliases keep old runs readable. The refactor batch task remains genuinely unavailable (`store.ts:62-75`); its reason becomes "batch rollback is not ported to the desktop", not "Mac app".
9. **Stale Mac stages.** `templates.ts:45,54` currently fail by construction. The generated templates remove them; a conformance rule prevents `cd mac` from returning.
10. **Issue writes.** `issues.from_notes` reuses the existing allow-list (`findTicket`) and idempotency (`onceForIdem`). Tests use a fake provider fetch; a live tracker is not part of CI. A failure is a typed partial result, never a silent success.
11. **Two generated copies drift.** The conformance gate is the only protection; it runs in `make contract-gates`, which is part of `make regression`. Do not add a second generator path.

---

## 7. Decisions needed

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Registry home: `schema/tasks/` + generated copies, or one TS module? | `schema/tasks/` + copies | Matches the bus registry pattern (`scripts/conformance-bus.mjs:30-35`); the UI cannot import `extension/`, and the core must not read `schema/` at runtime. |
| D2 | `knowledge.update`: retire or implement? | Retire | There is no durable memory writer today; the prompt is the audit's "produces nothing durable" finding (`docs/superpowers/plans/2026-10-31-auto-tasks-audit.md:126`). |
| D3 | `docs.generate`: keep as an Auto Task or let Doc Gen own it? | Doc Gen owns it; retire the Auto Task | Doc Gen has the template/source picker; the Auto Task prompt had no sources. |
| D4 | `review.merge`: review-only or merge? | Review-only; Ship stays a click | `bus-runner.ts:72-80` and `ShipPanel.tsx:1-3` already make Ship the one human approval. A merge without a click would break that invariant. |
| D5 | `issues.update`: alias to Sources→Issue or implement a separate updater? | Alias | The audit merges it (`...auto-tasks-audit.md:36`); a second prompt has no allow-list. |
| D6 | `issues.from_notes`: core route or desktop action? | Core route, with the issue writer extracted to `agents/issue-writer.mjs` | It makes the bus kind available and keeps the host-proof route as a thin wrapper; a desktop-only action would leave the phone kind unavailable. |
| D7 | Schedule backend: all desktop, or bus schedules for core tasks? | All desktop; bus schedules remain the remote path | The current five-field cron lives in the desktop; bus schedules are hourly intervals and only `sources.update` (`schedules.mjs:8`). Moving all schedules to the bus is a separate change. |
| D8 | Task config scope: global or per project? | Per project, seeded once from the legacy global key | Config paths are project-relative; a global config is wrong across projects. |
| D9 | Prompt overrides: keep editable prompts for `agent` tasks? | Keep as `promptOverride`, never as a copied default | This lets a registry prompt update reach every task that has not overridden it; deterministic tasks have no editor. |
| D10 | Loop template migration: all at once or per stage? | Per stage in Task 14, with byte-for-byte prompts and a hash upgrade | `system/loop.json` is user-owned and committed; a big-bang rewrite risks user edits. |
| D11 | `/kb/tasks/:id/run` vs calling every legacy route? | One task route | It is the only way to have one prompt/runner and typed args; the adapters call the same functions the legacy routes use. |
| D12 | Remote mode: show a read-only catalog or hide it? | Hide Auto Tasks/Loop as today; bus is the remote path | `REMOTE_SECTIONS` already excludes them; a read-only catalog would imply a runner that cannot execute. |
| D13 | `plan.status`: keep the task or remove it (the audit says remove)? | Keep it as a thin trigger of `/kb/outcomes/refresh` | The user's migration order names it; as a `core-route` task it owns no logic and cannot drift from the poller. Removing it later is a one-line registry change. |
| D14 | Is `POST /kb/tasks/:id/run` desktop-only? | Yes: bus host proof required, refused on a hub | Otherwise a JWT-only client runs `sources.update` and `issues.from_notes` without the T1 desktop approval the bus enforces (R-037 #1). |
| D15 | One migration for a durable Sources → Issue record? | Yes (`issue_source_links`) | The in-memory idempotency lasts 10 minutes; without a durable record every run re-creates the issues (R-037 #2). |
| D16 | Review tasks in Auto Tasks: keep the Loop agent, or the bus review engine? | One engine (bus); the prompt stays overridable; stored edited prompts migrate | Two engines for the same task is the duplication this plan removes; dropping a user's edited prompt silently is not acceptable (R-037 #5). |
| D17 | May a task that writes code or the tracker be scheduled? | No; and every migrated schedule of a task whose runner changed starts switched off | Schedules saved while a task could not run would otherwise start Factory runs and tracker writes unattended (R-037 #3). |

**Answered 2026-11-10:** the user accepted every recommendation in this table (D1-D17). D14-D17 were D13-D16 in review R-037; they were renumbered because this table already had a D13.

---

## 8. Definition of done

- `schema/tasks/registry.json` is the only place a task id, label, prompt, runner, read-only policy, schedule policy and feature gate live.
- `rg "MAC_ONLY_TASK_IDS|LOCAL_TASKS|const TASKS: readonly AutoTaskDef|BUILT_IN_TEMPLATES|DEFAULT_LOOP_SPECS" ui extension` finds only the generated modules, their importers and tests: no hand-written catalog array.
- Every prompt in the repo that belongs to a task exists once under `schema/tasks/prompts/`; `conformance-tasks.mjs` proves it.
- Auto Tasks, Loop, Factory, Ship and the review screens all call `runTask`/`runCoreTask` or read the generated catalog; no surface has its own prompt table.
- `make regression`, `cd desktop && npm test`, `cd extension && npm test`, `make feature-matrix FM_ARGS="--key auto_tasks"` and `--key doc_gen` are green.
- The old bridge screen, the Mac-only message and the stale Mac build stages are gone.
- A project's task config and schedules survive a project switch; two projects do not share a config.
- A task that cannot run says why in the registry's words, never "Mac app only".
