// One registry task run, for Run Now (Auto Tasks) and for the desktop scheduler, so both take the same path: the Loop
// stage for a shell task, the core route for core-route and agent tasks, a host action for desktop-action. No React
// here; the caller shows and records the outcome. A refusal that is not a failure carries a code in SKIP_CODES.
import { readRepoConfig } from "../settings/repo-config.ts";
import { createHostFs, type FsApi } from "../explorer/fs";
import { invokeHost } from "../shell/host";
import { changedPathArgs } from "../loop/native/worktree-run.ts";
import { shellBus } from "../shell/bus";
import type { CoreClient } from "../shell/core";
import { repoForIssue } from "../loop/native/factory.ts";
import { loadLoops } from "../loop/native/store.ts";
import { approveStage, approvalStatus } from "../loop/native/approvals.ts";
import { decideRun, resolvePath, type Resolve } from "../autotasks/native/usage.ts";
import { issuesFromNotesArgs } from "../autotasks/native/model.ts";
import { taskById, taskFocus } from "./model.ts";
import { registeredProjectId, repoRelativeTo } from "./project.ts";
import { runTask, type TaskActions } from "./runner.ts";
import type { ScheduledOutcome } from "./schedule.ts";

export interface RegisteredRunInput {
  projectRoot: string;
  /** The user's own focus sentence for an agent task; null = the registry's. */
  promptOverride: string | null;
  /** A scheduled run never opens an approval dialog: it reuses a live approval or is skipped. */
  scheduled: boolean;
  core: Pick<CoreClient, "request">;
  fs?: FsApi;
  signal?: AbortSignal;
  log(line: string): void;
}

/** Whether an active saved repository with a clone is linked: the one check Auto Tasks other than Source Update need. */
export function hasLinkedRepo(): boolean {
  try { const c = readRepoConfig(); return [...c.saved.github, ...c.saved.gitlab].some((r) => r.active && r.clonePath.trim() !== ""); } catch { return false; }
}

/** Paths git reports as changed right now; null when git cannot say. */
async function changedPathsNow(projectRoot: string): Promise<string[] | null> {
  try { return await invokeHost<string[]>("loop_changed_paths", changedPathArgs(null, projectRoot)); } catch { return null; }
}

/** The Factory's own run path (the bus uses the same functions), loaded on first use as the Issues screen does. */
const taskActions: TaskActions = {
  startFactory: async (ids, root) => (await import("../loop/native/run-manager-host.ts")).startIssueRuns(root, ids),
  factoryItemKeys: async (root) => (await import("../loop/native/run-manager-host.ts")).factoryItemKeys(root),
  issueRunnableHere: (issue, root) => repoForIssue(issue, readRepoConfig().saved, root) !== null,
  // Opens the pending card on the Factory board (goto-section, as Issues → Send to Factory does); never ships.
  reviewPendingMerge: async () => {
    const [review, anchor] = await Promise.all([import("./ship-review.ts"), import("../factory/anchor.ts")]);
    const pick = await review.loadPendingRun(createHostFs(), () => invokeHost("loop_worktree_list"));
    if (!pick) return null;
    shellBus.publish({ type: "goto-section", section: "conflicts", anchor: anchor.factoryAnchor(pick.itemKey) });
    return { runId: pick.runId, reviewed: true };
  },
};

const refuse = (summary: string, code: string): ScheduledOutcome => ({ ok: false, summary, code });

/** Runs one registry task. Throws only for a bad registry entry; every other outcome is an answer. */
export async function runRegisteredTask(id: string, input: RegisteredRunInput): Promise<ScheduledOutcome> {
  const task = taskById(id);
  if (!task?.runner) return refuse(`Task "${id}" has no runner.`, "TASK_NOT_AVAILABLE");
  const fs = input.fs ?? createHostFs();
  const { projectRoot, core } = input;
  const workRoot = await invokeHost<string>("loop_work_root");
  // The host mints approvals only for a stage it resolves from system/loop.json, so use the project's real Regression loop.
  let approvalToken: string | null = null;
  if (task.runner.kind === "shell") {
    const loaded = await loadLoops(fs);
    const regression = loaded.kind === "ok" ? loaded.store.loops.find((l) => l.defaultKey === "regression") : null;
    if (!regression) return refuse("No Regression loop exists in this project. Open Loop → Regression once, then run again.", "NO_REGRESSION_LOOP");
    if (input.scheduled) {
      const status = await approvalStatus(regression.id);
      if (status.approved && status.token) approvalToken = status.token;
    } else {
      // Approve only the Regression stage's fault-verify commands, not every shell command in the loop.
      const stage = regression.config.stages.find((s) => s.kind === "regressionSweep");
      const approval = stage ? await approveStage(stage.id, regression.id) : null;
      if (approval) approvalToken = approval.token;
    }
    if (!approvalToken) return refuse("Regression needs its fault commands approved once in Loop.", "NEEDS_APPROVAL");
  }
  // Sources -> Issue files into the active saved repository; the core refuses a repository that is not on the board.
  const tracked = task.runner.kind === "core-route" && task.runner.route === "issues-from-notes";
  const tracker = tracked ? issuesFromNotesArgs(readRepoConfig()) : null;
  if (tracked && !tracker) return refuse("Make a saved repository active in Settings → Repositories first.", "NO_REPOSITORY");
  const isAgent = task.runner.kind === "agent";
  const focusOverride = isAgent && input.promptOverride && input.promptOverride.trim() !== (taskFocus(id) ?? "").trim() ? input.promptOverride : undefined;
  let agentArgs: Record<string, unknown> = {};
  if (isAgent) {
    // The server's model caps decide first: a paused chain stops the task, an engaged one picks the model. A failed
    // check runs on the default model, and the log says so.
    const decision = await decideRun(() => core.request<Resolve>(resolvePath("anthropic")));
    if (decision.proceed && decision.warning) input.log(decision.warning);
    if (!decision.proceed) { input.log(decision.notice); return refuse(decision.notice, "PAUSED_BY_LIMITS"); }
    const repo = repoRelativeTo(projectRoot, workRoot);
    agentArgs = {
      ...(focusOverride ? { focusText: focusOverride } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      ...(repo !== null ? { repo } : {}),
    };
  }
  const needsProject = isAgent || tracker !== null;
  const result = await runTask(id, {
    projectRoot,
    ...(needsProject ? { projectId: await registeredProjectId(core, projectRoot), args: tracker ?? agentArgs } : {}),
    core,
    host: invokeHost,
    fs,
    log: input.log,
    ...(input.signal ? { signal: input.signal } : {}),
    approvalToken: async () => approvalToken,
    // Both name the project the task started in: after a project switch the host refuses, so this task can never
    // revert the other project's uncommitted edits.
    changedPaths: () => changedPathsNow(projectRoot),
    revert: async (paths, created) => { await invokeHost("loop_revert_paths", { paths, created, ...changedPathArgs(null, projectRoot) }); },
    actions: taskActions,
  });
  input.log(result.output);
  return { ok: result.ok, summary: result.summary, ...(result.code ? { code: result.code } : {}) };
}
