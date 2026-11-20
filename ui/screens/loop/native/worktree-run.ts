// Helpers for running a Loop in an isolated git worktree (spec A1). The Factory's run gets its own worktree at
// `<project>/system/loop-worktrees/<run id>` on branch `factory/<run id>`. Every other loop has ONE worktree and ONE
// branch for all its runs: `<project>/system/loop-worktrees/<slug>` on `loop/<slug>`, where the slug (see
// `loopBranchSlug`) is also the run id. Each run continues on that branch and its commits join the loop's one draft MR.
// Every host call of a run carries the run id. Pure: the host calls stay in NativeLoopScreen, so node tests can import this module.
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

/** The name part of a loop's slug: lowercase letters, digits and inner hyphens, at most 23 characters; "" when the name has none. */
export function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 23).replace(/-+$/, "");
}

/** Eight hex digits that identify a loop: the first eight of its id when that has them (a UUID does), else a hash of it. */
export function idHex8(id: string): string {
  const hex = id.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length >= 8) return hex.slice(0, 8);
  let h = 0x811c9dc5;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * The loop's branch and worktree slug: `<name, max 23>-<8 hex of the loop id>`, or `loop-<8 hex>` when the name has no
 * usable character. The id part makes it unique (two loops named alike get different branches); `existing` (the run ids of
 * the worktrees that exist) keeps a loop on its branch after a rename: a worktree already carrying this loop's id wins.
 * At most 32 characters, matching the host's `valid_loop_slug`.
 */
export function loopBranchSlug(name: string, id: string, existing: Iterable<string> = []): string {
  const hex = idHex8(id);
  for (const run of existing) if (run.endsWith(`-${hex}`) && /^[a-z0-9][a-z0-9-]{8,30}[a-z0-9]$/.test(run)) return run;
  const part = nameSlug(name);
  return part ? `${part}-${hex}` : `loop-${hex}`;
}

/**
 * Whether a run works in its own worktree and branch. The Factory always does. Any other loop does when its switch is
 * on (the default), except a loop with an enabled Regression stage: that stage re-checks faults in the main working
 * tree (see `worktreeBlockedStage`), so it stays on the working tree, the one documented exception.
 */
export function runsInWorktree(config: { alwaysUseWorktree: boolean; stages: readonly Pick<LoopStage, "kind" | "enabled">[] }, isFactory: boolean): boolean {
  return isFactory || (config.alwaysUseWorktree && worktreeBlockedStage(config.stages) === null);
}

/** Whether a run's branch holds anything beyond its base, from the run-end diff; null when the diff could not be read. */
export function runChanged(diff: { files: readonly string[]; truncated: boolean } | null): boolean | null {
  return diff ? diff.files.length > 0 || diff.truncated : null;
}

export type RunEnd = "ship" | "hold" | "discard" | "keep";

/**
 * What happens to a worktree run's branch when it ends (one rule for every loop). `changed` is null when the diff could
 * not be read: nothing is ever deleted or shipped on doubt.
 * - failed, cancelled or unreadable: keep the worktree and branch, no MR;
 * - passed with no changes: remove the worktree and branch;
 * - passed with changes: open the draft MR by itself, or hold for a person in human review mode or when the worktree
 *   held uncommitted files from an earlier run when this one started;
 * - passed with changes but "open a merge request" is off: keep the branch.
 */
export function runEndAction(r: { passed: boolean; cancelled: boolean; changed: boolean | null; humanReview: boolean; openMergeRequest: boolean; /** Uncommitted files an earlier run left in the loop's worktree; null when they could not be counted (treated as present). */ leftoverFiles?: number | null }): RunEnd {
  if (!r.passed || r.cancelled || r.changed === null) return "keep";
  if (!r.changed) return "discard";
  if (!r.openMergeRequest) return "keep";
  // Edits an earlier (failed) run left behind are not this run's reviewed work: a person looks before they go out.
  return r.humanReview || r.leftoverFiles === null || (r.leftoverFiles ?? 0) > 0 ? "hold" : "ship";
}
