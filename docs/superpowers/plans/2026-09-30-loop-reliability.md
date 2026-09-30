# Loop Reliability & Effectiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Loop actually able to change code, report honest results, survive normal use, repair effectively, and stay fast — in four phases, each shippable on its own.

**Architecture:** A single headless agent-run seam (server endpoint + Mac client) replaces the three call sites that today hit the tool-less legacy path; runs get explicit stage verdicts, one subprocess primitive, one edit guard, structured failure extraction and an attempt ledger; `loop.json` becomes versioned with stable default ids; the Loop page and phone polling stop doing IO per render/poll.

**Tech Stack:** Swift/SwiftUI (mac/), Node ESM server (extension/), existing Claude Agent SDK / agent engine on the server.

**Spec (the 2026-09-30 four-reviewer Loop review, findings verified by the controller; the user asked for all phases end to end):**

- **Tier 0 (critical):** `AgentLoopSkillExecutor` (`mac/…/Features/Loop/Services/LoopSkillExecuting.swift:28`), `AgentLoopStageRepairer` (`LoopStageRepairer.swift:109`) and `AgentFaultRepairer` (`mac/…/Core/Platform/RegressionRunner.swift` or `Core/Verification/`) call `codeAssist(agentContext: nil)`; `extension/server/ai-routes.mjs:646` then takes the "Legacy path — no agentContext, no tools" (`runClaude` with `--tools ''`). No Loop repair or skill stage can edit a file; replies are discarded. The repo root reaches the agent only as prompt text, so worktree runs could not be targeted either.
- **Tier 1 (dishonest results):** skill-stage error → `.proceed` → run `.success` (`LoopEngineRunner.swift:~945`, `~649`); `withScopeGuard` returns `.failed` on a throwing edit BEFORE `scopeGuard.check` (`:1040`); `StageOutputParser` uses `firstMatch` for XCTest (per-suite lines; total is last) and returns the XCTest value before checking swift-testing; regression stage `score: outcome.regressed` is always 0 with `attemptRepair` (`:~698`) and the sweep's own repairs are unguarded; output capture unbounded, empty on non-UTF-8 or a pipe held by a grandchild (`FaultVerifier.swift:~111-148`); a compile error (count → nil) scores as "improved" (`ProgressWatch.swift:51-57`).
- **Tier 2 (breakage):** phone Stop calls `autoCode.stop()` (kills the Auto Task timer) instead of `cancel()` (`MobileLoopBridge.swift:150`); default loop/stage ids are fresh UUIDs on every read when `loop.json` is never persisted; a UserDefaults-keyed migration (`normalizeScheduleOptIn`, `LoopEngineConfigStore.swift:214`) rewrites the shared, committed `loop.json` on every new machine; read errors and unknown enum cases quarantine the file and write defaults (`:66-84`, `LoopStage.swift:145`); `LoopTemplateStore` persists `[]` after a failed decode; Mac-app System Check stage `cd mac && swift test` lacks `LLMIDE_KEYCHAIN_BACKEND=memory`; Stop/timeout kill only `/bin/sh`; no default stage timeout and loops occupy the single Auto Task `runTask` slot; sweep runs a stale loop snapshot; worktrees never pruned after quit; `LoopRunQueue` cancel race; journal written only at finish (crash = nothing).
- **Tier 3 (effectiveness):** repair gets `failureOutput.suffix(4000)` (errors cut off); no attempt history (`history: []`, reply discarded); `consecutiveFailureStop` 2 means the informed second repair never happens; no flake check; `.retryIteration` re-runs all stages from the top; one transport error ends the run; repairs unbounded by the time budget; Plan/Docs loops have no verify stage; default-stage content never upgrades in persisted loops; `refactor-test` not re-detected; Makefile detection returns `make test` when only `regression:` exists; npm placeholder/`--watch` test scripts accepted; `AgentFaultRepairer` sends the output HEAD.
- **Tier 4 (performance):** `detectCommandCandidates` runs in `body` per shell stage per render (`LoopEngineView.swift:771`); whole 3-pane view re-renders per log line (`runner` observed at root, `:63`); `resolveRecordURL` in body may walk `loop-runs/`; scope-glob rows keyed by offset; phone `buildLoopState` loads loops 3× and reads the whole `index.jsonl` per 2 s poll on the main actor; output regex/hash on the main actor.

## Global Constraints

- Repo llm-ide, branch `feat/loop-reliability` off `main`. Commits only — never push. Never stage `.serena/project.yml`, `.skills`, or `mac/LocalPackages/graph-kit`.
- Conventional Commits, one concern per commit, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Mac tests: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > $TMPDIR/mac-test.log 2>&1` (unsandboxed); read the XCTest "Executed N tests, with M failures" line AND the swift-testing summary. Known flakes: `ExplorerTreeStoreWatchTests`, an occasional long stall in `GraphAutoUpdaterRepoResolutionTests` — re-run alone before calling a failure yours. Also `bash mac/Scripts/feature-boundaries.sh` (exit 0) and `cd mac && swift run loop-contract-lab` pass.
- Extension: `cd extension && npm test` (unsandboxed) + `npm run lint` pass; ESLint layer boundaries at zero violations. Any new/changed HTTP endpoint: add to `ENDPOINTS`, bump `SERVER_API_VERSION`, document in `docs/reference/api/`, and `make docs-check` passes.
- Mac feature boundaries: Loop code may use `Core/`; never reference another feature. Cross-feature needs go through `Core/Contracts/`.
- Never weaken an existing safety rule: code-applying stages still need an enabled non-advisory verify stage after them; Refactoring stays manual-only; the protected-path guard keeps its policies (the code-apply `.warn` promotion stays as is).
- Persisted data (`system/loop.json`, the journal, UserDefaults templates) written by this build must stay readable by it after every task; old files must decode. Never silently discard user data.
- Implementers never spawn sub-agents. `grep` is aliased to ugrep — use `/usr/bin/grep`.

---

## Phase 1 — the Loop can act, and says the truth

### Task 1.1: headless agent-run seam

**Ruling (binding):** Loop agent runs are NON-INTERACTIVE and CONFINED: file read/search/edit/write tools only, rooted at the run's git root (the worktree when one is in use); no shell, no network, no approval prompts (a tool needing approval is denied, not parked). The Loop verifies by running its own stages.

- Server: one endpoint (e.g. `POST /kb/loop/agent-run`) taking `{ message, skills?: [id], repoRoot, language?, model?, timeoutMs? }`. `repoRoot` must be absolute and must be inside a root the user may write (the user's repo allow-list OR an `.llmide-loop-worktrees/` child of one) — reject otherwise. Reuse the existing agent engine (prefer the Agent SDK engine if it supports a tool allowlist + cwd cleanly; else the legacy agent loop with a tool allowlist) — investigate, pick, and justify in the report. Return `{ reply, changedPaths: [repo-relative], usage, resolvedSkills: [ids], unresolvedSkills: [ids], truncatedSkills: [ids] }`. Honour `timeoutMs` with an AbortSignal. Tests: an edit inside `repoRoot` lands; a path outside is refused; no shell tool is offered; an unknown skill id is reported in `unresolvedSkills`; a repoRoot outside the allow-list is rejected (400).
- Mac: a `Core/Contracts` or Loop-local protocol `LoopAgentRunning` with `run(message:skills:repoRoot:timeout:) async throws -> LoopAgentResult` and an `LlmIdeAPIClient` method for the endpoint. Rewire `AgentLoopSkillExecutor` (add `repoRoot` to `LoopSkillExecuting.execute`; stop ignoring `targetPath` — it is already in the composed message), `AgentLoopStageRepairer`, and `AgentFaultRepairer` to it. A skill stage whose `skillId` is in `unresolvedSkills` fails the stage ("skill <id> is not installed"). Keep the replies (return them) — Task 3.2 consumes them.
- Tests: a Mac test with a recording fake API asserting every loop agent call carries the run's git root (and the worktree path in worktree mode); the server tests above.

### Task 1.2: honest verdicts + one edit guard

- Stage verdicts: add an explicit `errored` outcome for skill stages (transport/agent error). Rule: a run with no passing verify stage in its final iteration AND any errored stage ends `.error` (Plan/Docs with a dead backend no longer report success). Retry a transport error (connection refused/reset, 5xx) ONCE with a short backoff before erroring.
- Guard: `withScopeGuard` runs the check (and violation handling) on the THROW path too, recording changed paths. Snapshot content hashes of already-dirty paths (`git hash-object`) so further edits to loop-dirtied files are seen; include rename sources in the dirty set. `.indeterminate` stays fail-open but is recorded (unchanged).
- Regression stage: score = failing-fault count (`total - (unchanged + repaired)`, whatever makes the sweep fail), not `regressed`; wrap the sweep's own repairs in the guard (via a closure/protocol the sweep accepts, not a Loop import inside Core); `needsApproval > 0` terminates as needs-approval instead of retrying.
- Tests for each.

### Task 1.3: one subprocess primitive + correct parsing

- One runner for shell stages / verifiers (`ShellFaultVerifier` and friends): child in its own process group; Stop/timeout send SIGTERM then SIGKILL to the GROUP; capture into a capped head+tail buffer (e.g. 64 KB head + 192 KB tail, with an elision marker); decode with `String(decoding:as: UTF8.self)`; a grandchild holding the pipe cannot empty the output.
- `StageOutputParser`: XCTest total = LAST `Executed N tests, with M failures` match; when both XCTest and swift-testing summaries exist, failures = sum; parsing/hash off the main actor (on a capped string).
- `ProgressWatch`: count → nil with a non-zero exit is "worse" (the build/test run broke), never "improved"; the repair evidence says so ("your last change stopped the tests from running: <first error lines>").
- Tests: grandchild-held pipe, non-UTF-8 byte, group kill kills a `sh -c 'sleep 100 & sleep 100'` tree, XCTest multi-suite, XCTest+swift-testing mix, count→nil.

### Task 1.4: small, high-impact fixes

- `MobileLoopBridge` Stop → `autoCode.cancel()` (not `stop()`); test that the Auto Task timer survives a phone Stop.
- Mac-app System Check stage command gets the memory keychain (`make test-mac` when the Makefile target exists, else `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test`); a one-shot migration updates persisted stages whose command equals the OLD default exactly (never an edited command). Tests.

**Phase 1 gate:** full Mac + extension suites green; controller runs a phase review before Phase 2.

---

## Phase 2 — survives normal use

### Task 2.1: versioned `loop.json` + stable ids

- `schemaVersion` inside `loop.json` (current = 2). The schedule opt-in normalisation runs only when the file's version < 2, then writes version 2 — never keyed on UserDefaults (remove that key's use; leave old keys harmlessly). A missing `runsOnSchedule` at version ≥ 2 decodes as `false`.
- Refuse to WRITE a file whose `schemaVersion` is newer than this build knows (show a banner/log; keep read-only behaviour).
- Quarantine only on a DECODE error (not a read error — retry the read once), and decode unknown `LoopStage.Kind` values leniently (keep the raw stage, render it as unsupported, never run it). Surface quarantine to the UI (a banner), not only NSLog.
- `LoopTemplateStore`: on decode failure keep the raw data and refuse to persist over it (back up under a separate key).
- Default loops and stages get STABLE ids derived from keys (`default-<loopKey>`, `<loopKey>/<stageKey>`) — for newly created ones; existing persisted ids stay.
- Tests: migration idempotent; two-machine scenario (fresh UserDefaults) does not rewrite a v2 file; newer-version file not overwritten; read error does not quarantine; unknown kind round-trips; template decode failure preserved; unsaved project returns identical ids across reads.

### Task 2.2: one store per project + fresh sweep config

- A per-project loop store (actor or `@MainActor` cache keyed by project root) that all surfaces (Loop page, sweep, phone, chat entry points) resolve through; it caches the ensured store, invalidates on its own writes and on file mtime change, and does detection once per load (compute `detectTestCommand` once and pass it down).
- The scheduled sweep re-reads before each loop and re-checks it still exists, is scheduled, not manual-only, and has enabled stages.
- Tests.

### Task 2.3: execution lane, timeouts, cleanup, crash-safe journal

- Loops no longer occupy the Auto Task `runTask` slot (a separate loop lane, still one run per git root via `LoopRunQueue`); fix the queue's cancel race (remove the waiter synchronously / re-check cancellation after acquiring).
- Default per-stage timeout when none is set (e.g. 30 min for shell stages, 20 min for agent calls; configurable in Settings → Loop defaults) and a watchdog that aborts a run whose total budget is exceeded mid-stage.
- Worktree hygiene: at run start, `git worktree prune` and remove loop worktree dirs no live lease owns.
- Journal: append run events to a per-run JSONL as they happen (started, stage started/finished, repair requested/replied, verdict), flushed per event; the final record is still written at finish; at launch, reconcile runs with no end record → `.aborted`. Index: tail-read (seek from end) for recent runs, and cap/rotate it by month.
- Tests.

**Phase 2 gate:** suites green.

---

## Phase 3 — repairs that work

### Task 3.1: structured failure extraction

- One extractor per runner (XCTest, swift-testing, node TAP, jest, pytest, go) → `{ total failing, failing test ids, error locations (file:line + message) }` with a generic fallback (lines matching `error:`, `✖`, `FAIL`, `Assertion`, `Error:`).
- Repair excerpt = error lines first (±5 lines context, deduped, ≤ 60% of the budget) then the tail; budget raised to 12k chars; `AgentFaultRepairer` uses the same excerpt (not the head).
- Failure-set hash (sorted failing ids) replaces raw-output hashing for "same failure" detection.
- Tests with real captured output fixtures for each runner.

### Task 3.2: attempt ledger

- Per stage, per run: attempts `{ n, changedPaths, diffStat, trimmed diff (≤ 4k), agent reply summary (≤ 1k), resulting failure set }`, stored in the run journal. The next repair prompt includes the last 2–3 attempts ("these did not work — do something different"). A new run of the same loop reads the previous run's last ledger entries for that stage when it ended failing on the same failure set.
- Tests.

### Task 3.3: smarter run flow

- Flake gate: before the FIRST repair of a failing shell stage, re-run it once; if it passes, record "flaky" in the journal, warn, and continue without repair.
- Stop rules: default `consecutiveFailureStop` 3 for new loops (persisted values untouched) and always allow one informed repair after a first no-progress verdict; stop early when the same failure set returns after two different diffs; a partial fix (one fixed, one new) is neutral.
- Re-verify the failed stage (and only it) after a repair; run the full pipeline again only once it passes.
- Each repair's timeout = min(agent default, remaining run budget); a loop-config model tier option (default: the app's default model) passed to the agent run.
- Tests.

### Task 3.4: verifiable generate loops + versioned defaults + detection fixes

- A built-in check stage kind (evaluated in-app, no shell): `artifactCheck` with parameters (paths that must exist, max lines per file/glob, optional "citations resolve" — every backticked repo path/`path:line` in the given markdown glob exists in the repo). Plan loop gets a blocking check (INDEX.md + PLAN.md exist, ≤ 300 / 250 lines); Doc Optimization gets one (INDEX.md exists, pages ≤ 250 lines, citations resolve). It counts as a verify stage for `lacksVerifyAfter` only if blocking. Skill stages before it now get repaired/retried through the normal flow (a failed check triggers a re-run of the generate stages, bounded by budgets).
- Versioned defaults: each default stage stores `defaultRevision`; on load, a default stage whose persisted content equals its previous shipped revision upgrades automatically; an edited one shows "update available" with a one-click reset.
- Detection: `refactor-test` eligible for re-detection (paired: if tooling disappears, Refactor Apply is disabled, never left without a verify stage); Makefile returns the target that matched; npm placeholder script rejected; `--watch` scripts flagged and `CI=1` passed to shell stages.
- Tests.

**Phase 3 gate:** suites green.

---

## Phase 4 — fast

### Task 4.1: Loop page

- Command candidates detected once per loaded loop into state (`.task(id:)`), not in `body`; log pane + live header in child views observing the runner, parent observes only what it renders; `resolveRecordURL` resolved once on selection; scope-glob rows with stable identity.
- Verify with a test or an instrumented count where feasible (e.g. detection call counter under a render loop in a unit test of the extracted helper).

### Task 4.2: phone + journal IO

- `buildLoopState` loads loops once per snapshot (through Task 2.2's store), tail-reads the index, runs file IO off the main actor; clear `loopStartedHere` when a run ends; remove the no-op stage-id filter or make it real.
- Tests.

**Phase 4 gate + final:** full suites green, `make docs-check`, final whole-branch review, merge to local main.
