// Module-level manager for Factory runs. A run lives here, not in a screen, so a section or project switch neither
// kills nor orphans it. Each run works in its own worktree, and every run-scoped host call carries its run id. At most
// `concurrency()` runs execute at once; the rest wait in a FIFO queue. No React and no runtime imports here: the real
// host, core and project store are wired in by run-manager-host.ts, so node tests can load this module.
import type { FsApi } from "../../explorer/fs";
import { persistEnsuredDefaults } from "./defaults-save.ts";
import { detectTestCommand } from "./environment.ts";
import { configFor, factoryVerifyProblem, isFactoryLoop, needsDecisionSummary, taskMarkdown, type RunMode } from "./factory.ts";
import { appendRunRecord, iterationRecordsWithScores, type LoopRunIndexEntry } from "./history.ts";
import type { LoopDefinition, LoopEngineConfig } from "./model.ts";
import { copyReadiness } from "./readiness-copy.ts";
import { runNativeLoop, runStatusCode, type LoopRunOutcome } from "./runner.ts";
import { createStageDeps, type CoreFetch, type HostInvoke, type StageExecContext } from "./stage-exec.ts";
import { loadLoops, saveLoops } from "./store.ts";
import { initialProjectStore } from "./templates.ts";
import { newRunId, repoPrefixFor } from "./worktree-run.ts";

export type { RunMode } from "./factory.ts";

/** The work item fields a run needs. Task 4's WorkItemRecord is a superset. */
export interface RunItem { key: string; source: "issue" | "spec" | "text"; id: string | null; title: string; body: string; repo: string | null; provider: "github" | "gitlab" | null }

export interface LiveRun {
  runId: string;
  itemKey: string;
  projectRoot: string;
  mode: RunMode;
  /** "paused" is set only while the run holds for its project (note below); B has no user pause action. */
  state: "queued" | "running" | "paused";
  startedAt: string | null;
  /** "Waiting for its project" while held, else null. */
  note: string | null;
  log: string[];
}

export interface RunManagerDeps {
  host: HostInvoke;
  core: CoreFetch;
  /** The file API a run uses for its project (the default refuses while another project is open). */
  fsFor(projectRoot: string): FsApi;
  /** The local clone folder (`code/<name>`) of an issue's repo, or null when it is not in Settings → Repositories. Optional: absent = no mapping. */
  repoForSlug?(provider: "github" | "gitlab", slug: string, projectRoot: string): string | null;
  /** The open project's saved Factory loop (the one `isFactoryLoop` accepts), or null. */
  loadFactoryLoop(fs: FsApi): Promise<LoopDefinition | null>;
  /** The host approval token for the loop's shell commands; null = the user declined. */
  approve(loopId: string): Promise<string | null>;
  createStageDeps: typeof createStageDeps;
  runLoop: typeof runNativeLoop;
  appendRecord(fs: FsApi, entry: LoopRunIndexEntry, record: Record<string, unknown>): Promise<void>;
  copyReadiness(fs: FsApi, runRootPrefix: string, runId: string, at: Date): Promise<boolean>;
  activeProject(): string | null;
  subscribeProject(listener: () => void): () => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  now(): Date;
  rand(): number;
  newId(): string;
  /** A stage boundary: the Factory bus runner renews its lease from this, not only from the 60 s timer. */
  onStage?(runId: string): void;
  /** A stage boundary: the Factory bus runner renews its lease from this, not only from the 60 s timer. */
  onStage?(runId: string): void;
  /** A finished run's record was written (or held): the Factory bus runner reports it to the phone. */
  onRunFinished?(info: { runId: string; itemKey: string; projectRoot: string; mode: RunMode; statusCode: string; statusSummary: string }): void;
}

/** The host's RunInfo (Phase A Task 4), camelCase on the wire. */
interface WorktreeInfo { runId: string; project: string; repo: string; worktree: string; branch: string; baseCommit: string }
interface ManagedRun { live: LiveRun; item: RunItem; reuse: boolean; cancelled: boolean; abort: AbortController; /** Set while the run holds for its project; cancelRun calls it. */ wake?: () => void }
interface Finished { loop: LoopDefinition; info: WorktreeInfo; config: LoopEngineConfig; outcome: LoopRunOutcome }

export const CONCURRENCY_KEY = "llmide.factory.concurrency";
export const DEFAULT_CONCURRENCY = 2;
const MAX_LOG_LINES = 500;
const REQUIRED = ["host", "core", "fsFor", "approve", "activeProject", "subscribeProject"] as const;

/** The project's Factory loop. It is a default loop: a project whose Loop page was never opened gets it (and loop.json) written here. */
async function ensureFactoryLoop(fs: FsApi): Promise<LoopDefinition | null> {
  let r = await loadLoops(fs);
  if (r.kind === "corrupt") return null;
  const command = (await detectTestCommand(fs).catch(() => null))?.command ?? null;
  if (r.kind === "missing") {
    const store = initialProjectStore(command);
    r = { kind: "ok", store, hash: (await saveLoops(fs, store, null)).hash };
  } else {
    const ensured = await persistEnsuredDefaults(fs, r, command);
    // An unsaved Factory loop cannot be approved or run by the host, which reads loop.json.
    if (ensured.error !== null) throw new Error(`The Factory loop could not be added to system/loop.json (${ensured.error}); the run did not start.`);
    r = ensured.load;
  }
  return r.kind === "ok" ? r.store.loops.find(isFactoryLoop) ?? null : null;
}

let ensuring: Promise<unknown> = Promise.resolve();
/** `ensureFactoryLoop`, one call at a time: runs that start together would each add the loop and the later write would conflict. */
export function loadOrCreateFactoryLoop(fs: FsApi): Promise<LoopDefinition | null> {
  const next = ensuring.then(() => ensureFactoryLoop(fs));
  ensuring = next.catch(() => undefined);
  return next;
}

const PURE_DEFAULTS: Partial<RunManagerDeps> = {
  loadFactoryLoop: loadOrCreateFactoryLoop,
  createStageDeps,
  runLoop: runNativeLoop,
  appendRecord: appendRunRecord,
  copyReadiness,
  now: () => new Date(),
  rand: Math.random,
  newId: () => crypto.randomUUID(),
};

let deps: Partial<RunManagerDeps> = { ...PURE_DEFAULTS };
const runs = new Map<string, ManagedRun>();
let queue: string[] = [];
let cap: number | null = null;
const listeners = new Set<() => void>();
let snapshot: readonly LiveRun[] = Object.freeze([]);
/** Record writes for runs that ended while another project was open, keyed by project root. */
const pending = new Map<string, Array<() => Promise<void>>>();
let unsubscribeProject: (() => void) | null = null;
/** Why the latest run did not start; read once by takeRunNotice. */
let lastNotice: string | null = null;

/** The test/host seam: replaces any of the deps (and subscribes to project changes when it can). */
export function configureRunManager(next: Partial<RunManagerDeps>): void {
  deps = { ...deps, ...next };
  if (next.subscribeProject) {
    unsubscribeProject?.();
    unsubscribeProject = next.subscribeProject(onProjectChange);
  }
}

/** The open project changed: write a held record for it, then start any queued run that may now start. */
function onProjectChange(): void {
  const root = deps.activeProject?.() ?? null;
  if (root !== null) void flushPending(root).then(pump);
  else pump();
}

/** Drops every live run and every dep. Tests only (the repo's `resetSelfHealForTests` pattern). */
export function resetRunManagerForTests(): void {
  for (const run of runs.values()) {
    run.cancelled = true;
    run.wake?.();
  }
  runs.clear();
  lastNotice = null;
  queue = [];
  cap = null;
  listeners.clear();
  pending.clear();
  unsubscribeProject?.();
  unsubscribeProject = null;
  deps = { ...PURE_DEFAULTS };
  snapshot = Object.freeze([]);
}

function requireDeps(): RunManagerDeps {
  const missing = REQUIRED.filter((k) => deps[k] === undefined);
  if (missing.length > 0) throw new Error(`the factory run manager is not configured (missing: ${missing.join(", ")})`);
  return deps as RunManagerDeps;
}

/** 1–4, else the default: a fractional or non-finite value never becomes a cap. */
export function clampConcurrency(n: number): number {
  return Number.isFinite(n) ? Math.min(4, Math.max(1, Math.trunc(n))) : DEFAULT_CONCURRENCY;
}

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try { return deps.storage ?? globalThis.localStorage; } catch { return undefined; }
}

/** The per-viewer cap, read once from localStorage (a blocked storage keeps the default). */
export function concurrency(): number {
  if (cap === null) {
    let raw: string | null = null;
    try { raw = storage()?.getItem(CONCURRENCY_KEY) ?? null; } catch { raw = null; }
    cap = raw === null ? DEFAULT_CONCURRENCY : clampConcurrency(Number(raw));
  }
  return cap;
}

export function setConcurrency(n: number): void {
  cap = clampConcurrency(n);
  try { storage()?.setItem(CONCURRENCY_KEY, String(cap)); } catch { /* per-viewer convenience; memory keeps it */ }
  emit();
  pump();
}

function emit(): void {
  snapshot = Object.freeze([...runs.values()].map((r) => Object.freeze({ ...r.live, log: [...r.live.log] })));
  for (const l of [...listeners]) l();
}

/** The same frozen snapshot until something changes (`useSyncExternalStore` needs a stable value). */
export function liveRuns(): readonly LiveRun[] {
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The reason the most recent run did not start, once. */
export function takeRunNotice(): string | null {
  const n = lastNotice;
  lastNotice = null;
  return n;
}

function appendLog(run: ManagedRun, line: string): void {
  run.live.log.push(line);
  if (run.live.log.length > MAX_LOG_LINES) run.live.log.splice(0, run.live.log.length - MAX_LOG_LINES);
  emit();
}

/** Logs why a run did not start and keeps it for takeRunNotice (the live run and its log disappear at once). */
function fail(run: ManagedRun, message: string): void {
  appendLog(run, message);
  lastNotice = message;
}

/** Starts a run (or queues it when the cap is reached) and returns its run id. Never awaits. */
export function startRun(projectRoot: string, item: RunItem, mode: RunMode, opts: { runId?: string } = {}): string {
  const d = requireDeps();
  if ((mode === "continue" || mode === "sendBack") && !opts.runId) throw new Error(`${mode} needs the runId of an existing worktree`);
  const runId = opts.runId ?? newRunId(d.now(), d.rand);
  if (runs.has(runId)) return runId;
  runs.set(runId, {
    live: { runId, itemKey: item.key, projectRoot, mode, state: "queued", startedAt: null, note: null, log: [] },
    item, reuse: opts.runId !== undefined, cancelled: false, abort: new AbortController(),
  });
  queue.push(runId);
  emit();
  pump();
  return runId;
}

/** FIFO, skipping runs whose project is not the open one (they start when it is opened again). */
function pump(): void {
  const active = deps.activeProject?.() ?? null;
  let running = [...runs.values()].filter((r) => r.live.state !== "queued").length;
  const limit = concurrency();
  let changed = false;
  for (const runId of [...queue]) {
    if (running >= limit) break;
    const run = runs.get(runId);
    if (!run) { queue = queue.filter((id) => id !== runId); continue; }
    // Starting needs the open project: the worktree is cut, loop.json read and the loop approved through active-root host commands.
    if (run.live.projectRoot !== active) continue;
    queue = queue.filter((id) => id !== runId);
    run.live.state = "running";
    run.live.startedAt = (deps.now ?? (() => new Date()))().toISOString();
    running += 1;
    changed = true;
    void execute(run);
  }
  if (changed) emit();
}

export function cancelRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  if (run.live.state === "queued") {
    queue = queue.filter((id) => id !== runId);
    runs.delete(runId);
    emit();
    return;
  }
  run.cancelled = true;
  run.abort.abort();
  run.wake?.();
  void requireDeps().host("loop_cancel", { runId }).catch(() => undefined);
  emit();
}

async function execute(run: ManagedRun): Promise<void> {
  const d = requireDeps();
  const started = d.now();
  const fs = d.fsFor(run.live.projectRoot);
  let finished: Finished | null = null;
  try {
    finished = await runInWorktree(d, run, fs);
  } catch (e) {
    fail(run, e instanceof Error ? e.message : String(e));
  }
  if (finished) {
    try { await saveRecord(d, run, fs, finished, started); }
    catch (e) { appendLog(run, `run record not written: ${e instanceof Error ? e.message : String(e)}`); }
    try {
      d.onRunFinished?.({ runId: run.live.runId, itemKey: run.item.key, projectRoot: run.live.projectRoot, mode: run.live.mode, statusCode: runStatusCode(finished.outcome), statusSummary: finished.outcome.statusSummary });
    } catch { /* a listener must never change the run's own outcome */ }
  }
  runs.delete(run.live.runId);
  emit();
  pump();
}

async function runInWorktree(d: RunManagerDeps, run: ManagedRun, fs: FsApi): Promise<Finished | null> {
  const log = (line: string) => {
    appendLog(run, line);
    if (line.startsWith("$ ")) { try { d.onStage?.(run.live.runId); } catch { /* a listener must not stop the run */ } }
  };
  const loop = await d.loadFactoryLoop(fs);
  if (!loop) { fail(run, "This project has no Factory loop (system/loop.json could not be read); the run did not start."); return null; }
  const config = configFor(run.live.mode, loop.config);
  const verifyProblem = factoryVerifyProblem(config);
  if (verifyProblem) { fail(run, `${verifyProblem} The run did not start.`); return null; }
  const token = await d.approve(loop.id);
  if (token === null) { fail(run, "The Factory loop's commands were not approved; the run did not start."); return null; }
  if (run.cancelled) { log("Run cancelled before it started."); return null; }
  const info = run.reuse ? await findWorktree(d, run.live.runId) : await prepareWorktree(d, run);
  if (!info) { fail(run, `The worktree of run ${run.live.runId} no longer exists; the run did not start.`); return null; }
  const ctx: StageExecContext = {
    projectRoot: run.live.projectRoot, runId: run.live.runId, runRoot: info.worktree, fs, host: d.host, core: d.core, log,
    approvalToken: async () => token, signal: run.abort.signal,
    isCancelled: () => run.cancelled, markCancelled: () => { run.cancelled = true; },
  };
  log(`▶ ${loop.name} (${run.live.mode})`);
  const outcome = await d.runLoop(config, { ...d.createStageDeps(ctx, loop), log, isCancelled: () => run.cancelled, holdWhilePaused: holdForProject(d, run) });
  log(outcome.cancelled ? "Loop cancelled." : outcome.passed ? "Loop passed." : `Loop failed: ${outcome.statusSummary}`);
  return { loop, info, config, outcome };
}

/** The worktree of an earlier run (Resume, continue, sendBack), or null when it was removed. */
async function findWorktree(d: RunManagerDeps, runId: string): Promise<WorktreeInfo | null> {
  const list = await d.host<WorktreeInfo[]>("loop_worktree_list").catch(() => null);
  const rows = Array.isArray(list) ? list : [];
  return rows.find((r) => r?.runId === runId) ?? null;
}

/** Cuts a new worktree for the run: the mapped clone for an issue, else the work root. Logs the base commit. */
async function prepareWorktree(d: RunManagerDeps, run: ManagedRun): Promise<WorktreeInfo> {
  const workRoot = await d.host<string>("loop_work_root").catch(() => null);
  const { provider, repo } = run.item;
  let repoRel: string;
  if (provider !== null && repo) {
    // An issue's clone is chosen in Settings → Repositories; a repo that is not mapped must not fall back to the work root.
    const mapped = d.repoForSlug?.(provider, repo, run.live.projectRoot) ?? null;
    if (mapped === null) throw new Error(`The repository ${repo} is not in Settings → Repositories with a clone folder inside this project, so the run did not start.`);
    repoRel = mapped;
  } else {
    repoRel = repoRelFor(repo, run.live.projectRoot, workRoot);
  }
  const info = await d.host<WorktreeInfo>("loop_worktree_prepare", {
    repoRel, runId: run.live.runId, base: null,
    task: taskMarkdown({ source: run.item.source, id: run.item.id, title: run.item.title, body: run.item.body, repo: run.item.repo }),
  });
  appendLog(run, `started from ${info.baseCommit.slice(0, 7)}`);
  return info;
}

/** A project-relative repo ("" or code/<name>) as loop_worktree_prepare takes it; anything else falls back to the work root. */
export function repoRelFor(repo: string | null, projectRoot: string, workRoot: string | null): string {
  if (repo !== null && /^(code\/(?!\.\.?$)[A-Za-z0-9._-]+)?$/.test(repo)) return repo;
  return workRoot ? repoPrefixFor(projectRoot, workRoot) : "";
}

async function saveRecord(d: RunManagerDeps, run: ManagedRun, fs: FsApi, f: Finished, started: Date): Promise<void> {
  const { live, item } = run;
  const ended = d.now();
  const changedPaths = await d.host<string[]>("loop_changed_paths", { runId: live.runId }).catch(() => [] as string[]);
  const diff = await d.host<{ files?: unknown; truncated?: unknown; patchId?: unknown } | null>("loop_worktree_diff", { runId: live.runId }).catch(() => null);
  const diffSummary = {
    files: Array.isArray(diff?.files) ? diff.files.filter((p): p is string => typeof p === "string") : [],
    truncated: diff?.truncated === true,
    patchId: typeof diff?.patchId === "string" ? diff.patchId : null,
  };
  // factoryRunId + factoryMode: the Factory board finds a card's last run through these two fields in BOTH the month
  // index line and the record.
  const entry: LoopRunIndexEntry & { factoryRunId: string; factoryMode: RunMode } = { id: d.newId(), loopId: f.loop.id, loopName: f.loop.name, startedAt: started.toISOString(), durationSeconds: (ended.getTime() - started.getTime()) / 1000, iterationsUsed: f.outcome.iterationsUsed, statusCode: runStatusCode(f.outcome), statusSummary: f.outcome.statusSummary, trigger: "manual", factoryRunId: live.runId, factoryMode: live.mode };
  const stages = f.outcome.stages.map((o) => ({ stageName: o.stage.name, severity: o.stage.severity, run: { exitCode: o.ok ? 0 : 1, stdout: o.output, stderr: "", timedOut: false, durationMs: 0 } }));
  const record = {
    ...entry, endedAt: ended.toISOString(), gitRoot: f.info.worktree, config: f.config, changedPaths, summaryPath: null, stages,
    iterations: iterationRecordsWithScores(f.outcome.iterations),
    workItem: { source: item.source, id: item.id, title: item.title },
    worktree: { runId: live.runId, branch: f.info.branch, baseCommit: f.info.baseCommit, repo: f.info.repo },
    ship: null, needsDecision: needsDecisionSummary(f.outcome), diffSummary,
  };
  const copy = live.mode === "full" || live.mode === "intakeOnly";
  const prefix = repoPrefixFor(live.projectRoot, f.info.worktree);
  const write = async () => {
    await d.appendRecord(fs, entry, record);
    if (copy) await d.copyReadiness(fs, prefix, live.runId, ended);
  };
  if (d.activeProject() === live.projectRoot) { await write(); return; }
  appendLog(run, "The run's project is not open; its record is saved when you open it again.");
  pending.set(live.projectRoot, [...(pending.get(live.projectRoot) ?? []), write]);
}

/**
 * The runner's `holdWhilePaused`: at a stage boundary a run whose project is not the open one holds ("paused") until
 * that project is open again or the run is cancelled (cancelRun calls `run.wake`). Never times out (`configFor` sets
 * pauseTimeoutSeconds 0).
 */
function holdForProject(d: RunManagerDeps, run: ManagedRun): () => Promise<"ok" | "timedOut"> {
  return async () => {
    if (d.activeProject() === run.live.projectRoot || run.cancelled) return "ok";
    run.live.state = "paused";
    run.live.note = "Waiting for its project";
    emit();
    await new Promise<void>((resolve) => {
      const off = d.subscribeProject(() => {
        if (run.cancelled || d.activeProject() === run.live.projectRoot) { off(); resolve(); }
      });
      run.wake = () => { off(); resolve(); };
    });
    run.wake = undefined;
    run.live.state = "running";
    run.live.note = null;
    emit();
    return "ok";
  };
}

/** Writes the records of runs that ended while their project was closed, once it is open again. */
async function flushPending(projectRoot: string): Promise<void> {
  const writes = pending.get(projectRoot);
  if (!writes) return;
  pending.delete(projectRoot);
  for (const write of writes) {
    // WARNING: a write that fails here is lost; the worktree stays, so the board shows the run as Interrupted.
    try { await write(); } catch { /* see WARNING */ }
  }
}

/** The file API for one project: every call refuses (code no_project) while another project is open. */
export function projectGuardedFs(fs: FsApi, projectRoot: string, activeProject: () => string | null): FsApi {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (activeProject() !== projectRoot) {
          return Promise.reject(Object.assign(new Error(`the run's project (${projectRoot}) is not the open project`), { code: "no_project" }));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
