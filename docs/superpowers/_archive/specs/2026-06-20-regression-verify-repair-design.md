# Regression Verify + Repair — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorming) — pending implementation plan
**Supersedes the answer-only model from:** Phase D ([2026-05-24-phase-d-regression-check.md](../plans/2026-05-24-phase-d-regression-check.md)) and Phase F ([2026-05-24-phase-f-regression-three-pane.md](../plans/2026-05-24-phase-f-regression-three-pane.md)).

## Problem

Today's "regression check" does not check faults — it checks *answer text*. For each `status: fixed`
`FaultReport` it re-sends the saved `prompt` to the agent and string-compares the new answer to the
saved `response` ([RegressionRunner.swift](../../../mac/Sources/LlmIdeMac/Services/RegressionRunner.swift)).

Consequences:

1. **It cannot detect a real code regression** — nothing runs the code. The bug can fully reappear and,
   so long as the agent's prose matches, the verdict reads green.
2. **Context asymmetry guarantees noise.** The re-ask sends `history: []` and `agentContext: nil`, while
   the original answer was captured interactively. Same question, different context → answers drift for
   reasons unrelated to a regression. The semantic judge exists only to paper over this.
3. **The repair process is not wired in.** A regressed verdict only flips `fixed → open` on disk; the
   agent-driven fix that lives in `AutoCodeUpdateService` is never invoked from this loop.

Additional defects found while reviewing the flow:

- **Silent file corruption.** `AutoCodeUpdateService.runRegressionSweep` builds the runner with **no
  judge** but still passes `autoReopen: config.regressionAutoReopen`. Without the judge, verdicts are
  pure exact-match, so reworded LLM answers flip `fixed → open` on disk on nearly every sweep.
- **Sub-model mis-wiring.** The judge calls `codeAssist(..., model: nil)`, which hits the full global
  model — not the `LLMIDE_SUBAGENT_MODEL` tier its own comment claims. The sub-agent tier is applied
  server-side only on the `ask-subagent` path ([route.mjs:137](../../../extension/llm_agent/runtime/route.mjs)).
- Runs are serial-only, non-cancellable, and do disk I/O on the main actor.

## Goals

- Detect fault recurrence with a **deterministic, runnable check**, not LLM answer comparison.
- On a confirmed regression, **auto-repair**, **re-verify**, and present a **diff for the user to
  approve** — never commit unattended.
- Keep command-less / legacy faults working via the existing answer-compare + judge tier.
- Make fault knowledge **portable** between projects via an export/import bundle.
- Fix the silent-corruption, sub-model, concurrency, and main-thread defects along the way.

## Non-goals

- Fully autonomous fix-and-commit (no human gate). The diff review is mandatory.
- Server-side hosting/sync of fault packs (local file export/import only for now).
- Running the user's repo commands anywhere but the local Mac that holds the repo.

---

## Architecture (Approach A)

`RegressionRunner` stays the orchestrator. Its per-fault loop becomes a staged pipeline. Two new
injectable protocols join the existing `RegressionPrompter` / `RegressionJudge`:

- `FaultVerifier` — runs the verify command as a local subprocess.
- `FaultRepairer` — drives the agent (with write access) to fix a confirmed regression.

A `VerifyApprovalStore` gates first-run of any command. A `FaultPackService` handles portability. All
units have protocol seams so tests inject fakes.

```
RegressionRunner.run()
  └─ for each fixed fault (pipeline):
       has verify command?
         no  → fallback tier: re-ask prompt → answer-compare → semantic judge
         yes → approved on this machine?
                 no  → .needsApproval (stop; user approves in UI)
                 yes → FaultVerifier.verify(command)
                         exit 0 → .unchanged
                         exit ≠0 (regression) → repair enabled?
                                                  no  → .regressed
                                                  yes → FaultRepairer.repair() (edits working tree)
                                                        → FaultVerifier.verify() again
                                                            pass → .repaired  (capture git diff)
                                                            fail → .repairFailed(tail)
```

---

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `FaultVerifier` (protocol) + `ShellFaultVerifier` | Run `command` with `cwd = repoRoot`, capture combined stdout/stderr, enforce timeout (kill process group on overrun). Returns `VerifyOutcome = (exitCode: Int32, output: String)`. | `Process` |
| `FaultRepairer` (protocol) + `AgentFaultRepairer` | Drive the agent with write access to fix `fault` given `failureOutput`. Returns when the working tree is edited; the diff is read separately from git. | agent-edit path shared with `AutoCodeUpdateService` |
| `VerifyApprovalStore` | `isApproved(repo:fault:command:)` / `approve(...)`. Key = `sha256(repoPath \0 faultFileName \0 command)`. Backed by `UserDefaults` — per-machine, never in the repo. | `UserDefaults` |
| `RegressionRunner` (extended) | Orchestrates the pipeline; publishes `results` / `log` / `lastCSVURL`. Disk scan + verify hop off the main actor; published state stays `@MainActor`. | the above + `prompter` + `judge` |
| `MemoryStore` (extended) | Encode/decode new optional fault fields; CSV gains a `verify` column; `gitDiff(at:)` helper for the review UI. | filesystem, git |
| `FaultPackService` + `FaultPack` (Codable) | `export(faults:) -> Data`, `import(data:into:) -> ImportSummary`. | `MemoryStore` |
| `AutoCodeUpdateService` (fixed) | Sweep runner gets the judge wired in; runs verify+repair when enabled but stops at `.repaired` (no unattended commit). | `RegressionRunner` |

---

## Data model

`FaultReport` gains two **optional** frontmatter fields:

- `verify:` — the agent-authored shell command, runnable from repo root; fails iff the fault is present.
- `verify_kind:` — `command` (only kind today; reserved so the schema can grow without migration).

Absent on legacy faults; the markdown parser treats both as optional, so old files load unchanged.

### Verify-command lifecycle

Populated when a fault is flipped to `status: fixed` (existing `CodeAssistantPanel` path) via one extra
agent call routed to the **sub-model tier**:

> "You just fixed this fault. Give the single shell command, runnable from the repo root, that fails if
> this fault is present and passes if it is fixed. Reply with only the command, or `NONE`."

`NONE` ⇒ field stays empty ⇒ fault uses the fallback tier.

### Approval (per-machine)

Approve-once is stored locally, keyed by `sha256(repoPath + faultFileName + command)`. Rationale:
frontmatter travels with the repo via git; storing approval there would let a cloned/malicious repo ship
a pre-approved arbitrary command. Local storage means each machine approves before first run, and any
edit to the command text forces re-approval.

---

## Verdict model

```
.pending
.unchanged              // verify passed (or answer-compare matched)
.regressed              // verify failed, no repair attempted / repair off
.repaired               // verify failed → repair → re-verify passed (diff awaiting review)
.repairFailed(String)   // verify failed → repair → re-verify still failing
.needsApproval          // has a verify command the user hasn't approved on this machine
.failed(String)         // couldn't run the check (timeout, command error, judge unavailable)
```

`.repaired` / `.repairFailed` **never** mutate the fault's `status` on disk automatically — the diff
review gates that. Approve ⇒ mark `fixed` + re-save. Discard ⇒ `git checkout` the touched paths + mark
`open`.

---

## Concurrency & lifecycle

- **Verify-only passes** may run with bounded concurrency (read-only w.r.t. the working tree).
- **Repairs run serially** — two agents editing the same working tree would collide.
- The run is **cancellable**: checks cancellation between faults and kills the live subprocess.
- A second `run()` while one is in flight is **rejected** (`guard !running`).
- Disk scan, fault decode, verify subprocess, and CSV export move **off the main actor**; the runner
  hops back to the main actor only to publish state.

---

## Portable fault packs

**Format:** single JSON `faults-pack.json`, `schemaVersion: 1`. Each entry carries only portable
knowledge — `prompt`, `response`, `notes`, `severity`, `tags`, plus provenance (`sourceProject`,
`exportedAt`, original `reportedAt`). **No `verify`, no `status`, no `git_head` / `app_version`** (all
host-repo-specific).

**Export** (Regression view): "Export fault pack…" writes the active repo's faults (all or the checked
subset) to a user-chosen `.json`. Pure transform; no agent calls.

**Import** (target project's Regression view): "Import fault pack…" reads the JSON and writes each entry
as a new fault with `status: open` and a `tags` marker `imported:<sourceProject>`. **Dup guard:** skip
entries whose `prompt` already exists (whitespace-normalized match) — re-import is idempotent.

**Re-verify per project:** imported faults arrive with **no verify command**. They get one the normal
way — when the fault is worked and marked `fixed`, the fix-time agent call generates a verify command
*for the host codebase*. A pack therefore seeds *what to watch for*; each project grows its own runnable
checks. Until then, imported faults ride the answer-compare fallback tier.

**Unit:** `FaultPack` (Codable) + `FaultPackService` (`export` / `import`), isolated from the runner;
the view calls it directly.

---

## Safety & error handling

- Approve-once gate: an unseen command ⇒ `.needsApproval`; nothing runs until the user approves it
  (command shown verbatim). Editing the command re-arms the gate.
- Timeout (default 120s, configurable) kills the process group on overrun ⇒ `.failed("verify timed
  out")`. `status` is never mutated on `.failed`.
- Verify runs `cwd = repoRoot`; the only string reaching `/bin/sh -c` is the agent-authored,
  user-approved command. No fault content is interpolated into the command line.
- Conservative failure handling (never silently mutates a fault):
  - command error / missing binary ⇒ `.failed`, logged.
  - repair throws or makes no change ⇒ `.repairFailed`, working tree left for inspection.
  - re-verify still failing ⇒ `.repairFailed`, diff still shown.
  - judge unavailable on the fallback tier ⇒ `.failed`, not reopened (today's behavior).

---

## Sub-model wiring

- The fix-time **verify-command generation** and the fallback **semantic judge** are short,
  single-purpose calls → route through `ask-subagent` so they use `LLMIDE_SUBAGENT_MODEL`. Add a named
  subagent (e.g. `regression-judge`) on the extension side plus a `verify-author` prompt path. This
  makes the comment at `RegressionRunner.swift` accurate.
- **Repair** is a multi-file code-editing task → stays on the full agent (sub-model too weak).
- Correct the misleading sub-model comment regardless of routing outcome.

---

## UI changes (Regression view)

Three-pane layout unchanged; additive only.

- **Sources pane:** verdict pills extend to `ok` / `REGR` / `repaired` / `repair-failed` /
  `needs-approval` / `fail`. The `needs-approval` pill is tappable.
- **Detail pane:**
  - **Verify** row: shows the command (or "no check — uses answer comparison"). `.needsApproval` shows
    **Approve & run** with the command shown verbatim.
  - Toolbar: keep Run + auto-reopen toggle; add **Export fault pack…**, **Import fault pack…**, and a
    **timeout** field.
  - **Diff review** state for `.repaired` / `.repairFailed`: shows the working-tree `git diff` with
    **Approve (mark fixed)** and **Discard (revert + reopen)**.
- **Log pane:** unchanged; gains lines for verify exit codes, repair attempts, re-verify outcomes.

### Settings & paths audit

**Paths section — nothing to add.**
- Where faults live is already covered by the **Per-repo memory subdir** row
  (`config.memorySubdir`, default `.understand-anything/memory`); faults sit at
  `<repo>/<memorySubdir>/faults/`. The verify+repair pipeline, CSV, and packs all key off it.
- Fault-pack export/import uses an `NSOpenPanel` / `NSSavePanel` file picker — the user chooses the
  `.json` location each time, so no stored path setting is needed.

**Config fields to add** (follow the existing `@Published … didSet { defaults.set(...) }` +
init-from-defaults pattern in `AppConfig`, same shape as `regressionAutoReopen`):

| Field | Type | Default | UI |
|---|---|---|---|
| `regressionAttemptRepair` | `Bool` | `false` | New toggle in `AutoCodeSettingsSection`, next to the Regression auto-task toggle. |
| `regressionVerifyTimeout` | `TimeInterval` | `120` | Settings field + Regression view toolbar field. |

**Existing fields reused:** `autoCodeRunRegression` (auto-task toggle, already wired in
`AutoCodeSettingsSection`) and `regressionAutoReopen` (used by the runner). Note `regressionAutoReopen`
currently has **no Settings toggle** — it is only set from the Regression view toolbar; add a Settings
toggle for it while adding the two new fields above.

---

## Testing

- `FaultVerifier`: fake returns canned `(exitCode, output)`; `ShellFaultVerifier` runs real
  `true` / `false` / `sleep` (timeout kill).
- `FaultRepairer`: fake "fixes" by flipping the fake verifier's next outcome — asserts
  `.regressed → repair → re-verify → .repaired`, and the no-fix case → `.repairFailed`.
- `VerifyApprovalStore`: approve/lookup; hash-change re-arms.
- `RegressionRunner` pipeline: command-fault vs command-less routing; cancellation mid-run; second-run
  rejection.
- `FaultPackService`: export→import round-trip; dup-guard idempotency; verify-command stripped on
  export.
- `MemoryStore`: new fields round-trip through markdown; CSV gains the column; **legacy faults with no
  verify field still decode**.
- Fix-time generation: `NONE` reply ⇒ empty verify field.
- Regression for the corruption bug: sweep with no judge + autoReopen must **not** mutate disk.
