# Every Loop run on its own branch, ending in a draft MR

Date: 2026-11-20 · Status: done (2026-11-20, three Opus review rounds) · Code: Sonnet 5.5 · Review: Opus 5.5

## Goal (user request, 2026-11-20)

"For each function I want a new branch, do the update there, and at merge time do an MR so the user checks and merges."
User decision: a passed run with changes opens a **draft MR automatically** (no Ship click); the user reviews and merges
on GitHub/GitLab.

## Today

| Loop | Own branch per run | MR |
|---|---|---|
| Factory (Run Manager / board) | yes, worktree `system/loop-worktrees/<run id>`, branch `factory/<run id>` | automatic draft MR (`run-manager.ts` `autoShip`, `run-manager-host.ts`), with blocks: secret scan, CI/hook files, diff too large, human review mode |
| Refactoring (`NativeLoopScreen.tsx` run path) | yes (template sets `alwaysUseWorktree`) | Ship panel, one click |
| Regression, Test, Plan, Doc Optimization, Main Loop, user loops | **no**: edit the user's working tree on the checked-out branch | **no** |
| A user loop with "Always run in an isolated worktree" on | yes | **no** (`NativeLoopScreen.tsx` ~825 offers Ship only to Factory and `refactor`): the branch is stranded — bug |

`worktreeBlockedStage` refuses a worktree for any loop with an enabled `regressionSweep` stage (it re-checks faults in the
main working tree) — the Regression loop.

## Target behaviour

1. **Every loop run gets its own worktree and branch** by default: Regression, Test, Plan, Doc Optimization, Main Loop,
   Refactoring, user loops and the Factory. The user's working tree and checked-out branch are never edited by a run.
   The per-loop "Always run in an isolated worktree" switch stays as an opt-out (default on; existing saved loops are
   migrated to on once, recorded so a later opt-out sticks).
2. **End of a run, one rule for every loop** (reuse the Factory's `autoShip` path and its blocks, not a copy):
   - passed + files changed → push the branch and open a **draft** MR; the run's history row and summary carry the MR
     link (or "MR not opened: <why>" when a block or a missing GitHub/GitLab connection stops it; the branch is kept);
   - passed + nothing changed → remove the worktree and delete the branch; history says "No changes";
   - failed / cancelled / stopped → keep the worktree and branch, no MR; history keeps the branch so the user can open
     the diff or discard it (existing Discard).
   - Human review mode (`reviewMode: "human"`) keeps holding the run for Approve, as the Factory does today.
3. **Branch names say which loop ran**: `loop/<loop slug>/<run id>` for non-Factory loops (Factory keeps
   `factory/<run id>`); the core's ship branch check (`FACTORY_BRANCH_RE` in `extension/agents/factory-ship.mjs`) and
   the host (`desktop/src-tauri/src/loop_worktree.rs`) accept both shapes, nothing else. If the slug is awkward to
   validate, `loop/<run id>` is acceptable — say which in the report.
4. **Regression loop**: make the `regressionSweep` stage re-check against the run's worktree if the stage can be pointed
   at the run root safely; otherwise keep Regression on the working tree as the one documented exception, with the
   reason shown in the Loop editor. Investigate first, report the choice.
5. **Scheduled runs**: unchanged rules (code-applying loops stay manual-only on a schedule). A scheduled run that is
   allowed follows the same end-of-run rule, so its MR needs no click.
6. **Many runs**: concurrent runs each get their own worktree (already per run id); stale worktrees of finished runs
   are cleaned by the existing prune, never a worktree of a running run.

## Revision 1 (after the Opus review, user decision 2026-11-20): one branch and one MR per loop

Branch-per-run made every run start from HEAD, lose the loop's saved state and open a duplicate draft MR. Instead:

- **One branch per loop**: `loop/<loop slug>` (Factory keeps `factory/<run id>`). A run continues on that branch in the
  loop's worktree; its commits are added to the same draft MR (the ship path reuses an open MR for the branch). When the
  branch is merged into the base, the next run starts a fresh `loop/<slug>` from the base. One run per loop at a time.
- **No-change run**: removes the branch only when it has no commits beyond the base; otherwise keeps it and its MR.
- **Excluded machine state** (`system/loop/`, `llm-doc/loop/test/`, the `STAGED_PATCH_EXCLUDES` list): copied from the main
  tree into the worktree at start and back to the main tree at the end of every run (passed or failed), before any removal.
- **Dependencies**: a worktree run gets the same setup step the Factory uses (install from the lockfile) before its stages.
- **Board Clean up** never removes a `loop/` worktree of a running loop or a branch with commits beyond the base.
- `SERVER_API_VERSION` / `APP_API_VERSION` bump (the ship route accepts a new branch shape).

## Not in scope

Auto-merge (the user merges), changing the secret scan or blocks, per-project switches.

## Tests (must fail on a broken implementation)

- every default loop starts in a worktree on its own branch; the working tree is untouched;
- passed + changes calls the auto-ship path once and records the link; passed + no changes removes worktree and branch;
  failed keeps them and opens no MR; a block keeps the branch and records "MR not opened";
- a user loop with the switch on now ships (the stranded-branch bug);
- the branch-name rule (core + host) accepts the new shape and refuses anything else (`..`, spaces, `refs/`, leading `-`);
- migration flips saved loops once and respects a later opt-out.
