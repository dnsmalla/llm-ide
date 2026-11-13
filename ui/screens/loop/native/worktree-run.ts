// Helpers for running a Loop in an isolated git worktree (spec A1). A run with `alwaysUseWorktree` gets its own
// worktree at `<project>/system/loop-worktrees/<run id>` on branch `factory/<run id>`, and every host call of that
// run carries the run id. Pure: the host calls stay in NativeLoopScreen, so node tests can import this module.
import type { LoopStage } from "./model.ts";

/** Mirrors the Rust `loop_worktree::RunInfo` (serde camelCase). `project`, `repo` and `worktree` are absolute paths. */
export interface RunInfo {
  runId: string;
  project: string;
  repo: string;
  worktree: string;
  branch: string;
  baseCommit: string;
}

const SUFFIX_SPACE = 36 ** 6;
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDD-HHMMSS-<6 base36>` in UTC. Always matches the host's run-id rule `^[A-Za-z0-9_-]{1,64}$`. */
export function newRunId(now: Date, rand: () => number): string {
  const date = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  const time = `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  const r = rand();
  // Clamp: rand() is [0, 1) by contract, but 1 or NaN must still give exactly six digits.
  const n = Number.isFinite(r) ? Math.min(SUFFIX_SPACE - 1, Math.max(0, Math.floor(r * SUFFIX_SPACE))) : 0;
  return `${date}-${time}-${n.toString(36).padStart(6, "0")}`;
}

/** The folder a run works in: its worktree when it has one, else the resolved work root, else the project root. */
export function runRoot(projectRoot: string, info: { worktree: string } | null, workRoot: string | null): string {
  return info?.worktree || workRoot || projectRoot;
}

/** `root` relative to `projectRoot` ("code/app", "system/loop-worktrees/<id>"); "" for the root itself or outside it. */
export function repoPrefixFor(projectRoot: string, root: string): string {
  const base = projectRoot.replace(/\/+$/, "");
  if (!base || !root.startsWith(`${base}/`)) return "";
  return root.slice(base.length + 1).replace(/\/+$/, "");
}

/** Extra host-command args: `{ runId }` for a worktree run, nothing for the legacy main-tree run. */
export function stageHostArgs(runId: string | null): { runId?: string } {
  return runId ? { runId } : {};
}

/**
 * Args for the host commands that read or revert a run's changed paths (`loop_changed_paths`, `loop_revert_paths`).
 * A worktree run is pinned by its run id. A main-tree run works in whatever project is active when the call lands, so
 * it names the project it started in: the host then refuses once the user has opened another project, instead of
 * judging that project's uncommitted edits against this run's snapshot and reverting them.
 */
export function changedPathArgs(runId: string | null, projectRoot: string | null | undefined): { runId?: string; expectedRoot?: string } {
  if (runId) return { runId };
  return projectRoot ? { expectedRoot: projectRoot } : {};
}

/**
 * The first enabled stage a worktree run cannot honour. A Regression stage re-runs fault verify commands through
 * `loop_run_fault_verify`, which takes no run id and so would run in the main working tree.
 */
export function worktreeBlockedStage<S extends Pick<LoopStage, "kind" | "enabled">>(stages: readonly S[]): S | null {
  return stages.find((s) => s.enabled && s.kind === "regressionSweep") ?? null;
}
