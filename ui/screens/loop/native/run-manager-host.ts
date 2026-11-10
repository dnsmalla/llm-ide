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
import { repoForIssue } from "./factory.ts";
import { configureRunManager, concurrency, liveRuns, projectGuardedFs, startRun } from "./run-manager.ts";

let installed = false;
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
    // The bus runner reports a finished Factory run to the phone's claimed command (B5).
    onRunFinished: (info) => noteRunFinished(info.runId, info.statusCode, info.statusSummary),
  });
  installBusRunner();
}

/** The Factory's own path for issues: store each as a card and start one `full` run per issue (bus and Auto Task). */
export async function startIssueRuns(projectRoot: string, issueIds: readonly string[]): Promise<{ runIds: string[]; missing: string[] }> {
  installRunManagerHost();
  const fs = projectGuardedFs(createHostFs(), projectRoot, () => projectStore.getSnapshot().project?.root ?? null);
  // The phone names cached issues by the core's id; only the Factory's own cards become runs.
  const listed = await core.requestRaw("/kb/issues?state=open", { method: "GET" }).catch(() => null);
  const { rows, missing } = issueRowsFor(listed?.status === 200 ? listed.body : null, issueIds);
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
  };
  busDeps = deps;
  const timer = setInterval(() => kickPoll(deps), BUS_POLL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}
