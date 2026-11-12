// Wires the factory run manager to the real host, core, file API and project store. The Factory board calls
// installRunManagerHost() on mount; it is idempotent, so runs survive the board unmounting.
import { createHostFs } from "../../explorer/fs";
import { sendToFactory, workItemFromIssue } from "../../factory/intake.ts";
import { attachRun, readItems, type WorkItemRecord } from "../../factory/items.ts";
import { issueRowsFor, noteRunFinished, pollOnce } from "./bus-runner.ts";
import { invokeHost } from "../../shell/host";
import { projectStore } from "../../shell/project-store";
import { core } from "../../shell/runtime";
import { readRepoConfig } from "../../settings/repo-config";
import { approveLoop } from "./approvals.ts";
import { factoryRole, repoForIssue } from "./factory.ts";
import { autoShipKind, decodeWorktreeDiff } from "./ship-model.ts";
import { setRunRecordAutoShip, setRunRecordShip } from "./history.ts";
import { postIssueText, postStageComment } from "../../factory/issue-comment-poster.ts";
import { autoShipRun } from "../../factory/auto-ship.ts";
import { readReworkCounts, watchMrsOnce, writeReworkCounts } from "../../factory/mr-watch.ts";
import { chunkShipRequests, decodeShipResults, decodeWorktreeList } from "../../factory/board-model.ts";
import type { ShipStatus } from "../../factory/columns.ts";
import { cancelRun, configureRunManager, concurrency, liveRuns, postRunNotice, projectGuardedFs, startRun } from "./run-manager.ts";

let installed = false;
const commentChains = new Map<string, Promise<void>>();
let busRunnerInstalled = false;
let busDeps: Parameters<typeof pollOnce>[0] | null = null;
let polling = false;
const BUS_POLL_MS = 60_000;

export function installRunManagerHost(): void {
  if (installed) return;
  installed = true;
  const hostFs = createHostFs();
  const activeProject = () => projectStore.getSnapshot().project?.root ?? null;
  configureRunManager({
    host: invokeHost,
    core,
    fsFor: (root) => projectGuardedFs(hostFs, root, activeProject),
    approve: async (loopId) => (await approveLoop(loopId))?.token ?? null,
    // An issue runs in the clone Settings → Repositories maps its owner/name slug to (null = not mapped).
    repoForSlug: (provider, slug, projectRoot) => repoForIssue({ provider, repo: slug }, readRepoConfig().saved, projectRoot),
    activeProject,
    // A stage boundary renews the phone command's lease instead of waiting for the 60 s tick.
    onStage: () => { if (busDeps) kickPoll(busDeps); },
    subscribeProject: (listener) => projectStore.subscribe(listener),
    onStageResult: (e) => {
      const fs = projectGuardedFs(hostFs, e.projectRoot, activeProject);
      // One chain per run, so a slow lookup (the diff) never lets a later step's comment land first.
      const prev = commentChains.get(e.runId) ?? Promise.resolve();
      const next = prev.then(() => postStageComment({
        request: (path, body) => core.requestRaw(path, { method: "POST", body, timeoutMs: 15_000 }),
        diffFiles: (runId) => invokeHost<unknown>("loop_worktree_diff", { runId }).then((raw) => decodeWorktreeDiff(raw).files),
        readText: (path) => fs.read(path, 200_000).then((r) => (r.status === "ok" ? r.text : null)),
        allowed: (provider) => readRepoConfig().operations[provider].includes("commentIssue"),
      }, e)).then(() => undefined, () => undefined);
      commentChains.set(e.runId, next);
      void next.then(() => { if (commentChains.get(e.runId) === next) commentChains.delete(e.runId); });
    },
    autoShip: async (e) => {
      const kind = autoShipKind({ mode: e.mode, statusCode: e.statusCode, needsDecision: e.needsDecision, failedRole: e.failedStage ? factoryRole(e.failedStage) : null });
      if (!kind) return "";
      // Wait for this run's step comments, so the Ship comment lands after them.
      await (commentChains.get(e.runId) ?? Promise.resolve());
      const fs = projectGuardedFs(hostFs, e.projectRoot, activeProject);
      const request = (path: string, body: Record<string, unknown>) => core.requestRaw(path, { method: "POST", body, timeoutMs: 15_000 });
      const allowed = (provider: "github" | "gitlab") => readRepoConfig().operations[provider].includes("commentIssue");
      const out = await autoShipRun({
        repoConfig: () => readRepoConfig(),
        diff: (runId) => invokeHost<unknown>("loop_worktree_diff", { runId }).then(decodeWorktreeDiff),
        repoBranch: (runId) => invokeHost<string | null>("loop_repo_branch", { runId }),
        readText: (path) => fs.read(path, 200_000).then((r) => (r.status === "ok" ? r.text : null)),
        ship: async (body) => {
          const r = await core.requestRaw("/kb/loop/ship", { method: "POST", body, timeoutMs: 5 * 60_000 });
          const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
          if (r.status >= 200 && r.status < 300 && typeof b.url === "string" && typeof b.commit === "string") return { ok: true, url: b.url, commit: b.commit, reused: b.reused === true };
          const err = (b.error && typeof b.error === "object" ? b.error : {}) as Record<string, unknown>;
          return { ok: false, code: typeof err.code === "string" ? err.code : "error", ...(typeof err.rule === "string" ? { rule: err.rule } : {}) };
        },
        saveShip: (entry, ship) => setRunRecordShip(fs, entry, ship),
        saveBlocked: (entry, reason) => setRunRecordAutoShip(fs, entry, reason, new Date()),
        comment: async (text) => { await postIssueText({ request, allowed }, e.item, text); },
        now: () => new Date(),
      }, { info: e.info, item: e.item, entry: e.entry, kind, failedStage: e.failedStage?.name ?? null, runPrefix: e.runPrefix });
      return "shipped" in out ? `Draft MR: ${out.shipped}` : `MR not opened: ${out.blocked}`;
    },
    // The bus runner reports a finished Factory run to the phone's claimed command (B5).
    onRunFinished: (info) => noteRunFinished(info.runId, info.statusCode, info.statusSummary),
  });
  installBusRunner();
  installMrWatch(hostFs, activeProject);
}

let mrWatchInstalled = false;
const MR_WATCH_MS = 5 * 60 * 1000;

/** The background MR watch (factory/mr-watch.ts): every 5 minutes, and once shortly after the app starts. */
function installMrWatch(hostFs: ReturnType<typeof createHostFs>, activeProject: () => string | null): void {
  if (mrWatchInstalled) return;
  mrWatchInstalled = true;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void watchMrsOnce({
      projectRoot: activeProject,
      fs: (root) => projectGuardedFs(hostFs, root, activeProject),
      worktrees: () => invokeHost<unknown>("loop_worktree_list").then(decodeWorktreeList, () => new Map()),
      live: () => liveRuns(),
      shipStatus: async (requests) => {
        const out = new Map<string, ShipStatus | "error">();
        for (const chunk of chunkShipRequests(requests)) {
          const r = await core.requestRaw("/kb/loop/ship-status", { method: "POST", body: { requests: chunk }, timeoutMs: 30_000 });
          // Rate limited or failed: nothing is decided from a status that was not read.
          if (r.status !== 200) return new Map();
          for (const [url, st] of decodeShipResults(r.body)) out.set(url, st);
        }
        return out;
      },
      readCounts: readReworkCounts,
      writeCounts: writeReworkCounts,
      start: startRun,
      notice: postRunNotice,
    }).finally(() => { busy = false; });
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, MR_WATCH_MS);
  (first as unknown as { unref?: () => void }).unref?.();
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** The Factory's own path for issues: store each as a card and start one `full` run per issue (bus and Auto Task). */
export async function startIssueRuns(projectRoot: string, issueIds: readonly string[]): Promise<{ runIds: string[]; missing: string[] }> {
  installRunManagerHost();
  const fs = projectGuardedFs(createHostFs(), projectRoot, () => projectStore.getSnapshot().project?.root ?? null);
  // The phone names cached issues by the core's id; only the Factory's own cards become runs.
  // Both providers the Issues screen imports; the phone's picker lists the same two.
  const pages = await Promise.all(["github", "gitlab"].map((p) => core.requestRaw(`/kb/issues?state=open&provider=${p}&limit=100`, { method: "GET" }).catch(() => null)));
  const merged = { issues: pages.flatMap((r) => (r?.status === 200 && r.body && typeof r.body === "object" && Array.isArray((r.body as { issues?: unknown }).issues) ? (r.body as { issues: unknown[] }).issues : [])) };
  const { rows, missing } = issueRowsFor(merged, issueIds);
  const items: WorkItemRecord[] = rows.map((row) => workItemFromIssue({
    id: String(row.id), provider: String(row.provider ?? ""), repo: String(row.repo ?? ""),
    number: typeof row.number === "number" ? row.number : null, title: String(row.title),
    body: typeof row.body === "string" ? row.body : "", url: typeof row.url === "string" ? row.url : "",
  }));
  await sendToFactory(fs, items, { runIntake: false, projectRoot, start: startRun });
  const runIds: string[] = [];
  for (const item of items) {
    const runId = startRun(projectRoot, item, "full");
    await attachRun(fs, item.key, runId);
    runIds.push(runId);
  }
  return { runIds, missing };
}

/** The keys of every card on the Factory board for a project (any column), so a task never starts an issue twice. */
export async function factoryItemKeys(projectRoot: string): Promise<Set<string>> {
  const fs = projectGuardedFs(createHostFs(), projectRoot, () => projectStore.getSnapshot().project?.root ?? null);
  return new Set((await readItems(fs)).map((r) => r.key));
}

/**
 * Starts the 60 s poll for desktop-claimed bus commands (`issues.implement`). The desktop's Factory runs the
 * work; the core created the job on the phone's T2 approval and never runs it. Idempotent: one timer per app.
 */
function kickPoll(deps: Parameters<typeof pollOnce>[0]): void {
  if (polling) return; // one poll at a time: a stage boundary and the timer must not race a claim
  polling = true;
  void pollOnce(deps).catch(() => undefined).finally(() => { polling = false; });
}

function installBusRunner(): void {
  if (busRunnerInstalled) return;
  busRunnerInstalled = true;
  const deps: Parameters<typeof pollOnce>[0] = {
      requestRaw: (path, opts) => core.requestRaw(path, opts as Parameters<typeof core.requestRaw>[1]),
      activeProject: () => projectStore.getSnapshot().project?.root ?? null,
      live: () => liveRuns(),
      concurrency: () => concurrency(),
      now: () => Date.now(),
      sendItems: startIssueRuns,
      cancelRun,
  };
  busDeps = deps;
  const timer = setInterval(() => kickPoll(deps), BUS_POLL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}
