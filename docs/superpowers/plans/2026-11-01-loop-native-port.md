# Loop native desktop port (A–Z)

Date: 2026-11-01. Source of truth: `mac/Sources/LlmIdeMac/Features/Loop/` (≈21k Swift lines).
The desktop currently has only a Mobile Control remote-control screen. This plan ports the feature into the Tauri app.

## Architecture

- **Persistence:** the same committed `system/loop.json` (`LoopEngineProjectStore` v2), read/written through the
  root-confined host fs. Legacy bare `LoopEngineConfig` is wrapped as a Primary "Main Loop"; unknown stage kinds and
  newer fields survive a save.
- **UI:** three panes matching `LoopEngineView`: LOOPS sidebar, STAGES sidebar, and the Run pane
  (Overview / Environment / Template / Process) plus RUN LOG. LoopEngineHomeView and the new-loop wizard follow.
- **Engine:** a desktop runner ported from `LoopEngineRunner` + `LoopRunQueue` + `LoopRunJournal`. Stages:
  regression sweep, shell command (approval-gated), skill via the core's loop-agent endpoint, artifact/test/code-graph
  checks, incident triage, SDK diff. Repair/verification/worktree/shipping come after the basic run loop.
- **Host:** shell execution, git worktree/branch, file writes and process supervision are host commands in Rust, not
  webview shell access. The webview names project-relative paths only.

## Phases

1. **Models + config store** — `ui/screens/loop/native/model.ts`, `store.ts`, tests. *(done)*
2. **Read-only Loop screen** — three panes, overview fields, stage list, budgets, run history placeholders from
   `system/loop.json`; empty/create state.
3. **Editing** — loop add/duplicate/delete/primary, stage add/edit/delete/order/severity/enabled, budgets, template
   recipe, save with compare-and-swap.
4. **Host execution** — shell stage with approval, output capture, timeout/abort, run journal, git root detection.
5. **Runner** — iteration loop, blocking/advisory gates, repair streak, max repairs, wall-clock/pause budgets,
   regression sweep, skill via `/kb/loop/agent-run`, queue per git root.
6. **Environment/template** — project environment inspector, test command, recipes, check-Python action.
7. **History/approval** — run records, log tail/poll, past-run inspector, stage approvals, worktrees/shipping.
8. **Parity pass** — Mac UI gates, desktop tests, rebuilt app, final matrix and honest limits.

## Non-negotiable Mac invariants

- `system/loop.json` is committed and round-trips unknown/newer fields.
- Shell commands are machine-approved, never taken from a cloned project file.
- Default loops are re-ensured; refactor/code-applying loops are manual-only.
- A run is bounded by iterations, consecutive failures and per-stage repairs, not by a hard default wall clock.

## Status (2026-11-02)

Phases 1 to 7 are built except: incident-triage execution, git worktrees, merge-request shipping, pause timeout and background scheduling with the window closed (all refused or disabled in the UI, not faked). Phase 8 (parity pass, rebuilt app, final matrix) is open and needs a real-window run (UN-001). Code: `ui/screens/loop/native/`, host `desktop/src-tauri/src/loop_runner.rs`.
