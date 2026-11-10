# Factory Premium Surfaces — Group D Implementation Plan (2026-11-10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Factory board, card, Ship panel and empty/error states premium without adding a second source of truth: the live run manager, the run record and the existing PR/MR status stay authoritative; every new visual is a projection of those facts.

**Architecture:** D1 adds a typed `progress` projection to `LiveRun`, fed by a new runner `onProgress` callback (never parsed from log text). D2 extends `RunRecordFacts` with the verdict, changed-file summary, verify result, cost and failing-stage excerpt, and renders them on the card. D3 extends `ShipPanel`. D4/D5 are UI state and ARIA work. D6 is conditional on a measured 500-card node model. D7 is human acceptance, not code.

**Tech Stack:** React 19, TypeScript 5.9, Tauri host, node:test with `--experimental-strip-types`, existing Factory CSS tokens. No new dependency.

**Spec:** `agent-coord/reviews/R-036-factory-premium.md` group D, revised by `agent-coord/reviews/R-045-factory-surfaces-plan.md`. Prerequisite: **R-044 #1–#3 (the Ship secret gate) first**; D3's “ship anyway” confirm depends on R-044 #3 (file and line in the hit) and the user's decision on an override. REQ-019 A–C are complete.

## Global constraints

- One concern per commit; the sub-commits below are the unit.
- No new store, no new core route. One host-answer extension is allowed: `loop_worktree_diff` gains `additions`/`deletions` from `git diff --numstat` with the same pathspec as the patch (D2). No HTTP wire change.
- Every card fact degrades: an old record without the new fields renders the old card, never an error.
- `window.confirm`/`window.prompt` stay unused (a94d776a3).
- Factory is local-only (`REMOTE_SECTIONS` excludes it).
- D7 is a human run; an agent must not check it.

---

## D1 — Live progress and stage timeline

D1 is three commits.

### D1a — runner event → `LiveRun.progress` → bus runner

**Files:** `ui/screens/loop/native/runner.ts`, `run-manager.ts`, `bus-runner.ts`, `ui/screens/loop/tests/native-runner.test.mjs`, `native-run-manager.test.mjs`, `native-bus-runner.test.mjs`.

- [ ] Add to `RunnerDeps`:
  ```ts
  onProgress?(event:
    | { type: "iteration"; iteration: number }
    | { type: "stage-start"; stage: LoopStage; index: number; count: number; iteration: number }
    | { type: "stage-result"; stage: LoopStage; ok: boolean; iteration: number }
    | { type: "stage-skipped"; stage: LoopStage; iteration: number }
    | { type: "repair"; stage: LoopStage; attempt: number }
    | { type: "paused"; paused: boolean }): void;
  ```
  `runNativeLoop` emits it at the same points it already calls `deps.log`; no behaviour change. Test that an iteration, stage-start, stage-result, skip and repair produce the events in order.
- [ ] Add to `LiveRun`:
  ```ts
  progress: {
    stageName: string | null;
    stageIndex: number;   // 1-based, 0 before the first stage
    stageCount: number;
    iteration: number;
    repairs: number;
    lastLine: string | null;
    /** The board computes elapsed time from this; progress is not re-emitted per tick. */
    startedAt: string | null;
  } | null;
  ```
  `run-manager.ts` wires `onProgress` into the run context and updates `progress` (and `emit()` only on real events). Do not store `elapsedSeconds`: one board timer computes it, so cards do not re-render every second.
- [ ] `bus-runner.ts` uses `live.progress?.stageName` for the phone progress step, with the existing `lastStep(log)` only as the fallback for an older live object.
- [ ] Tests: `native-run-manager.test.mjs` asserts progress at stage start/result/repair/pause; `native-bus-runner.test.mjs` asserts the progress event uses the typed stage.

### D1b — card line

**Files:** `Card.tsx`, `board-model.ts`, `factory.css`, `board-model.test.mjs`.

- [ ] Pure `progressLabel(progress, now)` → `Implement · 3 of 8 · iter 2 · repair 1 · 4m 12s` (elapsed from `startedAt`/`now`). Card live branch shows it plus the last log line (truncated; `title` carries the full line).

### D1c — panel timeline

**Files:** `Board.tsx`, `Card.tsx`, `board-model.ts`, `factory.css`, `board-model.test.mjs`.

- [ ] Pure `stageTimeline(live)` returns one row per stage (`passed|failed|repaired|skipped|running`) from `progress` and the run log's stage markers; the details panel renders it above the raw log. Unknown/old runs return `[]`.

**Compatibility:** `progress` is additive; an old run has `null` and renders “Working” plus the last log line. **Rollback:** revert D1a/b/c independently; no persisted field changes.

---

## D2 — Finished card result and inline decision

D2 is two commits.

### D2a — record facts

**Files:** `ui/screens/loop/native/run-manager.ts` (record), `NativeLoopScreen.tsx` (record), `ui/screens/factory/columns.ts`, `board-model.ts`, `desktop/src-tauri/src/loop_worktree.rs` (numstat), `ship-model.ts`, tests.

- [ ] Extend the host's `loop_worktree_diff` answer with `additions`/`deletions` from `git diff --numstat` using the same base/pathspec as the patch. Store them in `diffSummary` at `saveRecord` (both record writers). A truncated diff still carries the numstat totals; the card says “N files (+A/−D)” and never derives counts from the capped text.
- [ ] Extend `RunRecordFacts` with:
  ```ts
  verdict: string | null;              // statusSummary
  changed: { files: number; additions: number | null; deletions: number | null } | null;
  test: { command: string | null; ok: boolean | null } | null;
  failingStage: { name: string; error: string } | null;
  readiness: string | null;            // needsDecision text
  ```
  `decodeRunRecordFacts` reads them; old records return nulls. The **verify** stage is found by `factoryRole(stage) === "verify"` over the record's `config.stages`, then matched to the recorded stage by name. The failing-stage excerpt is the first 3 lines of that stage's output, passed through `displayText` (it is test/agent text).
- [ ] Tests: full record, old record, failed record; a truncated diff still reports exact numstat; verify is found by role, not by a hard-coded name.

### D2b — card and answer

**Files:** `Card.tsx`, `Board.tsx`, `board-model.ts`, `loop/native/factory.ts`, `loop/native/run-manager.ts`, `factory.css`, tests.

- [ ] Finished card shows verdict, files (+A/−D), verify result, cost, duration; a failed run shows the failing stage + first error lines.
- [ ] “Answer & continue” writes the answer to `.factory/DECISIONS.md` (append, dated heading, fenced as untrusted data like `FEEDBACK.md`) and starts a `continue` run. `configFor("continue")` adds one line to the **Plan and Implement** prompts naming `.factory/DECISIONS.md`; no stage would otherwise read it. Add the action to the needs-decision card's actions; refuse an empty answer.
- [ ] Tests: an empty answer is refused; a non-empty answer writes the file once and starts `continue`; the Plan and Implement stage bodies contain the DECISIONS line.

**Compatibility:** old records show the existing note only. **Rollback:** revert D2a/b; the record keeps extra fields harmlessly.

---

## D3 — Ship panel

**Files:** `ShipPanel.tsx`, `ship-model.ts`, `factory.css`, `native-ship.test.mjs`, `factory-ship.mjs`/route only for the secret override (below).

- [ ] Per-file diff keeps the 400-line cap; add “Open in editor” (existing `open-file` bus) and a split/unified toggle. The file view is presentation only.
- [ ] Next to “Open in editor”: “Editing this file changes the reviewed patch; Ship will require Review again.” (A4 refuses the stale patch id.)
- [ ] Before confirm, editable PR/MR title and body prefilled from `shipRequest(...)`; blank title refused. When the record already has an open request (`record.ship`), show “The existing draft keeps its text” instead of editable fields.
- [ ] Summary row: target repo, base branch, head branch, provider.
- [ ] **Secret override (user decision, after R-044 #3):** if the user allows “ship anyway”, the confirm names the rule, file and line (never the text), is logged in the run record, and is the only way past a secret-scan hit. If the user keeps the hard block, do not add this control.
- [ ] Tests: split state, title/body reaching `shipRequest`, `open-file` emits a worktree-relative path, existing-draft text, and (if built) the override confirm is explicit and logged.

**Compatibility:** the ship request body keeps its shape; only values are editable. **Rollback:** revert; the old panel remains.

---

## D4 — Accessibility and keyboard

D4 is three commits. UI tests have no DOM (`renderToStaticMarkup` only, no new dependency); behaviour lives in pure helpers and the real focus behaviour is on the D7 checklist.

### D4a — roles and labels

- [ ] Replace the board `role="list"` + `<section>` children with a plain `role="region"` and one labelled `<ul role="list">` per column. Live log becomes `role="log" aria-live="polite"`.
- [ ] Static markup tests: no `role="list"` on a non-list element, one labelled list per column, log role, card `tabIndex`, button labels.

### D4b — focus targets

- [ ] Pure `focusTargetReducer` (open/close confirm, open/close details, return-to-opener) plus static assertions for the opener/target ids. Confirm bars move focus on open, Escape cancels, focus returns; implementation is asserted through the reducer and the D7 window check.

### D4c — keyboard movement

- [ ] Pure `nextCardKey(board, key, direction)` for Left/Right/Up/Down, scoped to the board having focus and never while an input/textarea is focused. `f` is **not** here; it moves to D6 with the filter.
- [ ] Tests for the reducer/next-key matrix; real arrow/focus behaviour on the D7 checklist.

**Rollback:** each sub-commit reverts independently.

---

## D5 — Empty, error and offline states

**Files:** `Board.tsx`, `Card.tsx`, `board-model.ts`, `factory.css`, tests.

- [ ] Per-column empty lines (Inbox “No work items”, Needs decision “Nothing waiting”, Working “No run”, etc.).
- [ ] Core unreachable: one board-level banner; keep last known columns, no per-card “status unavailable” wall.
- [ ] Rate-limited status refresh: “PR/MR status paused; retrying in Ns”. Use `Retry-After` when present; otherwise fall back to `STATUS_MIN_GAP_MS`. Never a spinner.
- [ ] Tests: empty copy; one banner; retry text with and without `Retry-After`.

---

## D6 — Scale (conditional, node measurement first)

**Files:** `Board.tsx`, `board-model.ts`, `virtual-column.ts` (only if needed), `factory.css`, a 500-item fixture test.

- [ ] Node thresholds: `readItems` + `latestRecords` + `buildBoard` for 500 items **under 50 ms** and a stable model. A node fixture cannot measure first paint or scroll; those go to D7 in the real window.
- [ ] Only if the node threshold is missed: virtualise per column with the chat `virtual.ts` helper and add the text filter (`f` shortcut, scoped like D4c).
- [ ] Record the measured numbers in the commit message; if already smooth, close D6 as measured with no code.

---

## D7 — Manual acceptance (human)

- [ ] T10 checklist against scratch GitHub AND GitLab: send-back after failing CI, discard after a rejected push, quit mid-run and Resume, phone-approved issue with the desktop closed then opened.
- [ ] Add: Clean up… kept-vs-removed confirm; a run stopped by the USD ceiling; a run stopped by the two-hour ceiling; keyboard/focus behaviour from D4; paint/scroll with 500 cards from D6.
- [ ] Record `MANUAL REQ-019 D7 — <pass|fail> <notes>` in `agent-coord/to-reviewer.md`. Premium is not claimed before it passes.

---

## Commit order and gates

1. R-044 #1–#3 (Ship secret gate) first.
2. D1a, D1b, D1c.
3. D2a, D2b.
4. D3.
5. D4a, D4b, D4c.
6. D5.
7. D6 (measure; code only if needed).
8. D7 — human, no commit.

For every commit: `cd desktop && npm test`, `npx tsc --noEmit`, `make regression`, `make docs-check` if docs moved. Push only after the gate is green.

## Decisions needed

- **D1:** progress exposes stage names plus the last log line, never the stage output body. **Recommended.**
- **D2:** inline answer uses `.factory/DECISIONS.md` + `continue` (recommended); no new wire.
- **D3:** editable title/body is local-only and does not update an already-open PR/MR; an existing draft keeps its text. **Recommended.**
- **D3 secret override:** ALLOWED by the user on 2026-11-10. One explicit “ship anyway” confirm names rule/file/line (no matched text) and is logged in the run record; the hard block stays the default.
- **D6:** virtualise only if the node model misses 50 ms; otherwise close as measured.
- **D7:** needs the user at the window.
- **Loop-page runs:** a Factory run started from the Loop page has no card, so no surface shows it. Recommended for a separate follow-up: `sendToFactory` + `attachRun` from that start so every run is on the board (this would also remove the clean-up special case). Not blocking D1.
