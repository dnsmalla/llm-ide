// The start of a Loop-page run, free of React: approval, the input-folder check, the worktree decision (one shared
// worktree per non-Factory loop, a fresh one per Factory run), the leftover-file count and the state copy-in. Every side
// effect goes through `StartDeps`, so node tests drive the exact order. The screen keeps its refs and calls this.
import type { LoopDefinition } from "./model.ts";
import { isFactoryLoop, type WorkItem } from "./factory.ts";
import { copyStateIn } from "./run-end.ts";
import { configWithSetup, isSetupStage } from "./loop-setup.ts";
import { providerSaysMerged } from "./loop-branch.ts";
import { decodeWorktreeStatus, shipTarget } from "./ship-model.ts";
import { loopBranchSlug, repoPrefixFor, type RunInfo } from "./worktree-run.ts";
import type { LoopApproval, LoopApprovalStatus } from "./approvals.ts";
import type { RepoConfig } from "../../settings/repo-config.ts";

export interface StartDeps {
  host<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** True when the folder (repository-relative) can be listed. */
  folderExists(path: string): Promise<boolean>;
  /** The native approval dialog; null when the person declined. */
  approveLoop(loopId: string): Promise<LoopApproval | null>;
  approvalStatus(loopId: string): Promise<LoopApprovalStatus>;
  refreshApproval(loopId: string): Promise<void>;
  /** The newest shipped MR of the loop, for the merged-branch check. */
  lastShip(loopId: string): Promise<{ url: string; since: string } | null>;
  post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }>;
  readRepoConfig(): RepoConfig;
  /** The Factory run id of a fresh worktree. */
  newRunId(): string;
  setupNeeded(prefix: string, command: string): Promise<boolean>;
  isUnmounted(): boolean;
  /** The re-entry guard: false when a start is already being prepared. */
  beginStarting(): boolean;
  /** Releases the guard; called on every refusal after `beginStarting` returned true. */
  endStarting(): void;
  closePicker(): void;
  log(line: string): void;
}

export interface StartInput {
  target: LoopDefinition;
  scheduled: boolean;
  start: { repoRel: string; task: string; item: WorkItem } | null;
  command: string | undefined;
  oneItem: boolean;
  /** `runsInWorktree(...)`, decided by the caller before approval so a blocked stage refuses first. */
  useWorktree: boolean;
  projectRoot: string | null;
  workRoot: string | null;
  workRelative: string;
}

export type StartResult =
  | { ok: false; notice: string | null }
  | {
    ok: true;
    info: RunInfo | null;
    reusedWorktree: boolean;
    mergedMr: string | null;
    /** Uncommitted files an earlier run left on the loop's branch; null when the status could not be read. */
    leftoverFiles: number | null;
    approvalToken: string | null;
    runConfig: LoopDefinition["config"];
    notice: string | null;
    logLines: string[];
  };

const refuse = (d: StartDeps, notice: string | null, release = true): StartResult => {
  if (release) d.endStarting();
  return { ok: false, notice };
};

/** Approval: a scheduled run reuses a grant or skips, so the app cannot self-approve. */
async function approve(d: StartDeps, i: StartInput): Promise<{ token: string | null } | { notice: string }> {
  const { target } = i;
  try {
    let token: string | null;
    if (i.scheduled) {
      const status = await d.approvalStatus(target.id);
      if (!status.approved) return { notice: `“${target.name}” needs a native host approval for its exact shell commands before a scheduled run; run it once from here.` };
      // `token` is null when there is nothing to approve (no shell or fault verify commands).
      token = status.token;
    } else {
      const approval = await d.approveLoop(target.id);
      if (!approval) return { notice: "The Loop commands were not approved; the run did not start." };
      token = approval.token;
    }
    await d.refreshApproval(target.id);
    return { token };
  } catch (e) {
    return { notice: e instanceof Error ? e.message : "The Loop commands could not be approved." };
  }
}

interface Prepared { info: RunInfo; reusedWorktree: boolean; mergedMr: string | null }

/** One shared worktree per non-Factory loop (by slug), a fresh one per Factory run. A refusal is a notice string. */
async function prepareWorktree(d: StartDeps, i: StartInput): Promise<Prepared | { notice: string | null }> {
  const { target, start } = i;
  const isFactory = isFactoryLoop(target);
  const root = i.projectRoot ?? "";
  const workRel = i.workRoot === root ? "" : repoPrefixFor(root, i.workRoot ?? "");
  if (!root || (!start && i.workRoot !== root && workRel === "")) {
    return { notice: "The repository for this run could not be resolved, so no worktree was created and the run did not start." };
  }
  // One branch per loop: the slug (name + loop id) is the worktree folder, the run id and the branch name (loop/<slug>).
  const worktrees = isFactory ? [] : await d.host<RunInfo[]>("loop_worktree_list").catch(() => [] as RunInfo[]);
  const slug = loopBranchSlug(target.name, target.id, worktrees.map((w) => w.runId));
  let fresh = false;
  let baseRef: string | null = null;
  let mergedMr: string | null = null;
  if (!isFactory) {
    // Git sees a merge or fast-forward by itself; a squash or rebase merge is only visible to the provider.
    const last = await d.lastShip(target.id).catch(() => null);
    fresh = await providerSaysMerged((path, body) => d.post(path, body, 20_000), last);
    if (fresh && last) mergedMr = last.url;
    const old = worktrees.find((w) => w.runId === slug);
    if (fresh && old) {
      // The restarted branch is cut from the real base: the core fetches it (the host's git has no credentials).
      try {
        const to = shipTarget(old, d.readRepoConfig());
        const base = await d.host<string | null>("loop_repo_branch", { runId: slug });
        const r = to && base ? await d.post("/kb/loop/sync-base", { worktree: old.worktree, branch: old.branch, provider: to.provider, repo: to.slug, base }, 90_000) : null;
        if (r && r.status === 200) baseRef = `origin/${base}`;
        else d.log("The base branch could not be fetched, so the restarted branch is cut from your local copy of it.");
      } catch { /* cut from the local base */ }
    }
  }
  const reusedWorktree = !fresh && worktrees.some((w) => w.runId === slug);
  const task = start ? start.task : `# ${target.name}\n\nLoop run in an isolated worktree. No work item was picked; the loop's goal applies.\n`;
  let info: RunInfo;
  try {
    info = await d.host<RunInfo>("loop_worktree_prepare", { repoRel: start ? start.repoRel : workRel, runId: isFactory ? d.newRunId() : slug, base: baseRef, task, loopSlug: isFactory ? null : slug, fresh });
  } catch (e) {
    return { notice: `The isolated worktree could not be created: ${e instanceof Error ? e.message : String(e)}. The run did not start.` };
  }
  // Check stages read the worktree through the project-scoped fs; a worktree outside the expected folder would
  // make the prefix "" and silently point them at the main tree.
  if (repoPrefixFor(root, info.worktree) !== `system/loop-worktrees/${info.runId}`) {
    return { notice: `The worktree ${info.worktree} is not under this project's system/loop-worktrees/ folder, so the run did not start. The worktree was kept.` };
  }
  if (d.isUnmounted()) return { notice: null };
  return { info, reusedWorktree, mergedMr };
}

/** The run-log header: the loop, its task, the worktree and any leftover-file warning. */
function headerLines(i: StartInput, info: RunInfo | null, leftoverFiles: number | null): string[] {
  const leftover = leftoverFiles === null ? ["The worktree's state could not be read; the end of this run waits for your review."]
    : leftoverFiles > 0 ? [`${leftoverFiles} uncommitted file(s) from an earlier run are in this worktree; the end of this run waits for your review.`] : [];
  return [`▶ ${i.target.name}`, ...(i.oneItem ? [`Task: ${i.command?.trim()}`] : []),
    ...(info ? [`⎇ isolated worktree system/loop-worktrees/${info.runId} on ${info.branch}, started from ${info.baseCommit.slice(0, 7)}`, ...leftover] : []), ""];
}

/**
 * Everything between "a run is requested" and "the runner starts", in today's order: approval, the re-entry guard, the
 * input-folder check (before any worktree exists), the worktree, the leftover count and the state copy-in. A refusal
 * releases the guard itself. On success the guard is still held: the screen clears it when the run begins.
 */
export async function prepareLoopRun(d: StartDeps, i: StartInput): Promise<StartResult> {
  const approval = await approve(d, i);
  if ("notice" in approval) return refuse(d, approval.notice, false);
  // The approval dialog is modal and can outlive the screen: a leave while it was open must not start the loop.
  if (d.isUnmounted()) return refuse(d, null, false);
  // `runningRef` is set only after the awaits below; this flag stops a second click from starting a second run
  // (and a second worktree) while the first is still being prepared.
  if (!d.beginStarting()) return refuse(d, null, false);
  try {
    return await startGuarded(d, i, approval.token);
  } catch (e) {
    // A throw must never leave the guard stuck: the next start would be refused forever.
    d.endStarting();
    throw e;
  }
}

async function startGuarded(d: StartDeps, i: StartInput, approvalToken: string | null): Promise<StartResult> {
  const { target, start } = i;
  const isFactory = isFactoryLoop(target);
  // Any run start (Run, queue, schedule, picker) closes the picker so a stale card cannot linger over it.
  d.closePicker();
  // A missing input folder would leave the stages with nothing to work on, so refuse before any worktree exists.
  if (target.inputPath) {
    const repoRel = start ? start.repoRel : i.workRelative;
    const folder = repoRel ? `${repoRel}/${target.inputPath}` : target.inputPath;
    if (!(await d.folderExists(folder))) return refuse(d, `The input path “${target.inputPath}” does not exist in this repository, so the run did not start.`);
  }
  let info: RunInfo | null = null;
  let reusedWorktree = false;
  // The previous draft MR of a loop restarted after it merged: the core checks with the provider before it lets the first push replace that head.
  let mergedMr: string | null = null;
  if (i.useWorktree) {
    const prepared = await prepareWorktree(d, i);
    if ("notice" in prepared) return refuse(d, prepared.notice);
    ({ info, reusedWorktree, mergedMr } = prepared);
  }
  // Edits an earlier run left uncommitted on this loop's branch: say so, and never ship them without a look.
  // A status that cannot be read (null) counts as "leftovers present": the run holds for review instead of shipping on a guess.
  const leftoverFiles: number | null = info && !isFactory
    ? await d.host<unknown>("loop_worktree_status", { runId: info.runId }).then((raw) => decodeWorktreeStatus(raw)?.changedFiles ?? null).catch(() => null)
    : 0;
  const notice = leftoverFiles === null
    ? "The worktree's state could not be read, so this run's changes will wait for your review instead of opening a merge request."
    : leftoverFiles > 0 ? `${leftoverFiles} uncommitted file${leftoverFiles === 1 ? "" : "s"} from an earlier run on this loop's branch. This run's changes will wait for your review instead of opening a merge request.` : null;
  let runConfig = target.config;
  if (!isFactory) {
    let needed = false;
    if (info) {
      const active = info;
      const copied = await copyStateIn({ syncStateIn: async () => { await d.host("loop_worktree_state_sync", { runId: active.runId, direction: "in" }); } }, active.branch);
      if (!copied.ok) return refuse(d, copied.message);
      const setup = target.config.stages.find((st) => st.enabled && isSetupStage(st));
      needed = setup ? await d.setupNeeded(repoPrefixFor(i.projectRoot ?? "", active.worktree), setup.command ?? "") : false;
    }
    runConfig = configWithSetup(target.config, needed);
  }
  return { ok: true, info, reusedWorktree, mergedMr, leftoverFiles, approvalToken, runConfig, notice, logLines: headerLines(i, info, leftoverFiles) };
}
