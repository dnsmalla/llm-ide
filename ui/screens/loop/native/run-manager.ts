// Module-level manager for Factory runs. A run lives here, not in a screen, so a section or project switch neither
// kills nor orphans it. Each run works in its own worktree, and every run-scoped host call carries its run id. At most
// `concurrency()` runs execute at once; the rest wait in a FIFO queue. No React and no runtime imports here: the real
// host, core and project store are wired in by run-manager-host.ts, so node tests can load this module.
import type { FsApi } from "../../explorer/fs";
import { persistEnsuredDefaults } from "./defaults-save.ts";
import { detectProjectStructureCommand, detectProjectTestCommand, detectStructureCommand, detectTestCommand } from "./environment.ts";
import { configFor, factoryRole, factoryVerifyProblem, isFactoryLoop, needsDecisionSummary, taskMarkdown, withDetectedStructure, withDetectedVerify, type RunMode } from "./factory.ts";
import { TEMPLATE_FILE, applyTemplate, droppedMessage, formatFactoryTemplate, parseFactoryTemplate, readTemplateFile, sameLoop, templateFromLoop, templateProblemMessage, upgradeOldDefault, writeTemplateIfMissing, type FactoryTemplate } from "./factory-template.ts";
import { appendRunRecord, iterationRecordsWithScores, type LoopRunIndexEntry } from "./history.ts";
import { clampIterations, type LoopDefinition, type LoopEngineConfig, type LoopStage } from "./model.ts";
import { copyReadiness } from "./readiness-copy.ts";
import { readPending, writePending, type PendingRecord } from "./pending-records.ts";
import { LOOPBACK_STOPPED_CODE, loopbackRecord } from "./loopback.ts";
import { runNativeLoop, runStatusCode, type LoopRunOutcome, type ProgressEvent as RunProgressEvent } from "./runner.ts";
import { autoShipKind, holdsForHuman, type AutoShipKind } from "./ship-model.ts";
import { postSignal, runSignalPayload } from "./improve/signals.ts";
import { createModelTracker } from "./step-model.ts";
import { runLoopRequest, type LoopManualShip, type LoopRunFinished, type LoopRunHost, type LoopRunRequest } from "./run-manager-loop.ts";
import { withBaselineFor } from "./loop-drivers.ts";
import { createStageDeps, type CoreFetch, type HostInvoke, type StageExecContext } from "./stage-exec.ts";
import { loadLoops, saveLoops } from "./store.ts";
import { initialProjectStore } from "./templates.ts";
import { newRunId, repoPrefixFor } from "./worktree-run.ts";
import { createRunLogWriter, runLogPath, type RunLogWriter } from "./run-log-file.ts";
import { stepReviewRecords } from "./review.ts";
import { countStepReviews, summarizeSteps, type StepReviewCounts } from "./issue-trail.ts";

export type { RunMode } from "./factory.ts";
export type { LoopManualShip, LoopRunRequest } from "./run-manager-loop.ts";
export { withBaselineFor };

/** The work item fields a run needs. Task 4's WorkItemRecord is a superset. `loop` set = a non-Factory loop run (see `loopRunItem`). */
export interface RunItem { key: string; source: "issue" | "spec" | "text"; id: string | null; title: string; body: string; repo: string | null; provider: "github" | "gitlab" | null; loop?: LoopRunRequest }

/** The run item of a non-Factory loop: its key names the loop, so a loop's runs share one board card and one worktree. */
export function loopRunItem(loop: { id: string; name: string }, request: Omit<LoopRunRequest, "loopId"> = {}): RunItem {
  return { key: `loop:${loop.id}`, source: "text", id: null, title: loop.name, body: "", repo: null, provider: null, loop: { loopId: loop.id, ...request } };
}

/** True for a non-Factory loop's run (its item key is `loop:<id>`). The Factory board shows only the others. */
export function isLoopRun(r: { itemKey: string }): boolean { return r.itemKey.startsWith("loop:"); }

/** The loop a loop run belongs to, else null. */
export function loopIdOfRun(r: { itemKey: string }): string | null { return isLoopRun(r) ? r.itemKey.slice("loop:".length) : null; }

/** The runs the Factory board and its consumers care about: loop runs have no Factory card. */
export function factoryRuns<T extends { itemKey: string }>(runs: readonly T[]): T[] { return runs.filter((r) => !isLoopRun(r)); }

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
  /** A loop run's Pause was pressed: it holds at the next step boundary (state "paused" from then on). */
  pauseRequested?: boolean;
  log: string[];
  /** Typed progress from the runner; null before the run starts. Elapsed is computed by the board from startedAt. */
  progress: {
    stageName: string | null;
    stageIndex: number;
    stageCount: number;
    iteration: number;
    /** The run's round budget, so the board can show "round N of M". */
    maxIterations: number;
    repairs: number;
    stages: { id: string; name: string; state: "running" | "passed" | "failed" | "repaired" | "skipped" }[];
    startedAt: string | null;
    /** What the run does inside the current step while its AI review runs; null otherwise. */
    substate: "reviewing" | "fixing review" | null;
    /** The model the running agent step uses; null for shell steps, finished steps or unknown routing. Display only. */
    model: string | null;
  } | null;
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
  /** What a non-Factory loop run needs beyond the deps above; absent = such runs refuse to start. */
  loopRun?: LoopRunHost;
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
  /** A stage finished (passed or failed): the Factory posts its step comment on the run's issue. */
  onStageResult?(e: { runId: string; projectRoot: string; mode: RunMode; item: RunItem; stage: LoopStage; ok: boolean; iteration: number; runPrefix: string }): void;
  /** The run's record was just written: the Factory opens its draft MR (or records why not). Returns a log line. */
  autoShip?(e: { runId: string; projectRoot: string; mode: RunMode; item: RunItem; info: WorktreeInfo; entry: { id: string; startedAt: string }; statusCode: string; needsDecision: boolean; failedStage: LoopStage | null; runPrefix: string; /** The loop that ran, when it is not the Factory (names the MR text). */ processName?: string; /** The loop's previous MR, when its branch restarted after it merged. */ mergedMr?: string | null; /** Set by Approve: the kind the run was held as, so the MR label matches it whatever the loop config says now. */ kind?: AutoShipKind }): Promise<string>;
  /**
   * A finished run's record was written (or held): the Factory bus runner reports it to the phone, and the issue trail
   * posts the run summary. `steps`, `durationSeconds`, `costUsd` and `shipLine` (the autoShip log line,
   * "" when none) describe the run for that summary.
   */
  onRunFinished?(info: { runId: string; itemKey: string; projectRoot: string; mode: RunMode; statusCode: string; statusSummary: string; item: RunItem; steps: { name: string; ok: boolean; attempts: number }[]; durationSeconds: number; costUsd: number | null; shipLine: string; stepReviews: StepReviewCounts | null }): void;
}

/** The host's RunInfo (Phase A Task 4), camelCase on the wire. */
interface WorktreeInfo { runId: string; project: string; repo: string; worktree: string; branch: string; baseCommit: string }
interface ManagedRun { /** Non-Factory loop runs: the worktree id host calls carry (null = no worktree), undefined until the worktree is prepared. */ loopRunId?: string | null; live: LiveRun; item: RunItem; reuse: boolean; cancelled: boolean; abort: AbortController; /** Where the run marker was written; execute clears it when the run throws before a record exists. */ markerPath?: string; /** Set while the run holds for its project; cancelRun calls it. */ wake?: () => void; /** Mirrors the log to system/loop-runs/logs/<runId>.log once the worktree exists; execute flushes it before the run is dropped. */ logWriter?: RunLogWriter; /** A loop run's Pause: it holds at the next step boundary until resumed. */ userPaused?: boolean; /** Set when the manager is torn down, so a hold that ignores Cancel still ends. */ dropped?: boolean }
interface Finished { loop: LoopDefinition; info: WorktreeInfo; config: LoopEngineConfig; outcome: LoopRunOutcome }

export const CONCURRENCY_KEY = "llmide.factory.concurrency";
export const DEFAULT_CONCURRENCY = 2;
const MAX_LOG_LINES = 500;
const REQUIRED = ["host", "core", "fsFor", "approve", "activeProject", "subscribeProject"] as const;

/** The project's Factory loop. It is a default loop: a project whose Loop page was never opened gets it (and loop.json) written here. */
async function ensureFactoryLoop(fs: FsApi): Promise<LoopDefinition | null> {
  let r = await loadLoops(fs);
  if (r.kind === "corrupt") return null;
  const command = (await detectProjectTestCommand(fs).catch(() => null))?.command ?? null;
  if (r.kind === "missing") {
    const store = initialProjectStore(command);
    r = { kind: "ok", store, hash: (await saveLoops(fs, store, null)).hash };
  } else {
    const ensured = await persistEnsuredDefaults(fs, r, command);
    // An unsaved Factory loop cannot be approved or run by the host, which reads loop.json.
    if (ensured.error !== null) throw new Error(`The Factory loop could not be added to system/loop.json (${ensured.error}); the run did not start.`);
    r = ensured.load;
  }
  if (r.kind !== "ok") return null;
  const found = r.store.loops.find(isFactoryLoop) ?? null;
  if (!found) return null;
  // The project's template decides the steps. A project without one gets it written from its current loop (an
  // unedited loop of the previous default moves to the current default).
  const structure = (await detectProjectStructureCommand(fs).catch(() => null))?.command ?? null;
  const file = await readTemplateFile(fs);
  let template: FactoryTemplate;
  if (file.kind === "ok") {
    if (!file.parse.ok) throw new Error(templateProblemMessage(file.parse.errors));
    template = file.parse.template;
  } else {
    const migrated = templateFromLoop(withDetectedVerify(found, command).loop);
    template = upgradeOldDefault(migrated.template) ?? migrated.template;
    await writeTemplateIfMissing(fs, template);
    // Nothing is dropped silently: this run stops once so the person sees what changed; the next run uses the file.
    if (migrated.dropped.length > 0) throw new Error(droppedMessage(migrated.dropped));
    const check = parseFactoryTemplate(formatFactoryTemplate(template));
    if (!check.ok) throw new Error(templateProblemMessage(check.errors));
  }
  const templated = applyTemplate(found, template, command, structure);
  const fromTemplate = !sameLoop(templated, found);
  // An existing Factory loop saved before detection existed can have an empty Verify command. Fill it once,
  // persist it, and let the run continue instead of sending the user to the Loop page.
  const verified = withDetectedVerify(templated, command);
  const repaired = withDetectedStructure(verified.loop, structure);
  if (!fromTemplate && !verified.changed && !repaired.changed) return repaired.loop;
  const store = { ...r.store, loops: r.store.loops.map((l) => (l.id === repaired.loop.id ? repaired.loop : l)) };
  try {
    await saveLoops(fs, store, r.hash);
  } catch (e) {
    // The host approves and runs loop.json, so template steps that could not be saved must not run as the old ones.
    if (fromTemplate) throw new Error(`system/loop.json could not be updated from ${TEMPLATE_FILE} (${e instanceof Error ? e.message : String(e)}); the run did not start.`);
  }
  return repaired.loop;
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
/** Loop-page runs on the board (trackExternalRun): listed by liveRuns, outside the queue, the cap and every action. */
const external = new Map<string, LiveRun>();
/** The note a Loop-page run shows; the board hides Stop for it (it cannot be stopped from the board). */
export const LOOP_PAGE_NOTE = "Running on the Loop page";
let queue: string[] = [];
let cap: number | null = null;
const listeners = new Set<() => void>();
let snapshot: readonly LiveRun[] = Object.freeze([]);
/** Record writes for runs that ended while another project was open, keyed by project root. */
const pending = new Map<string, Array<{ id: string; runId: string | null; write: () => Promise<void> }>>();
/** Failed write attempts per held record id (also stored on the record, so a restart keeps the count). */
const attemptsById = new Map<string, number>();
/** One delayed retry per project while its project stays open. */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FLUSH_RETRY_MS = 5000;
export const MAX_RECORD_ATTEMPTS = 5;
/** Entry ids being written by a flush right now, so a second flush (configure + project change) cannot write them twice. */
const flushing = new Set<string>();
let unsubscribeProject: (() => void) | null = null;
/** Why the latest run did not start; read once by takeRunNotice. */
let lastNotice: string | null = null;

/** The test/host seam: replaces any of the deps (and subscribes to project changes when it can). */
export function configureRunManager(next: Partial<RunManagerDeps>): void {
  deps = { ...deps, ...next };
  if (next.subscribeProject) {
    unsubscribeProject?.();
    unsubscribeProject = next.subscribeProject(onProjectChange);
    // A record left by a quit is stored, and no project change will announce a project that is already open at launch.
    const root = deps.activeProject?.() ?? null;
    if (root !== null && deps.fsFor && deps.appendRecord) void flushPending(root);
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
    run.dropped = true;
    run.wake?.();
  }
  runs.clear();
  loopListeners.clear();
  external.clear();
  lastNotice = null;
  queue = [];
  cap = null;
  listeners.clear();
  pending.clear();
  flushing.clear();
  attemptsById.clear();
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  unsubscribeProject?.();
  unsubscribeProject = null;
  deps = { ...PURE_DEFAULTS };
  snapshot = Object.freeze([]);
  if (logTimer !== null) { clearTimeout(logTimer); logTimer = null; }
  logDirty = false;
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

function rebuild(): void {
  logDirty = false;
  const all = [...[...runs.values()].map((r) => r.live), ...external.values()];
  snapshot = Object.freeze(all.map((r) => Object.freeze({ ...r, log: [...r.log] })));
}

function emit(): void {
  if (logTimer !== null) { clearTimeout(logTimer); logTimer = null; }
  rebuild();
  for (const l of [...listeners]) l();
}

/** Log lines arrive in bursts: one snapshot and notification per window, not per line. */
const LOG_EMIT_MS = 50;
let logTimer: ReturnType<typeof setTimeout> | null = null;
let logDirty = false;
function emitSoon(): void {
  logDirty = true;
  if (logTimer !== null) return;
  logTimer = setTimeout(() => {
    logTimer = null;
    if (logDirty) rebuild();
    for (const l of [...listeners]) l();
  }, LOG_EMIT_MS);
  (logTimer as { unref?: () => void }).unref?.();
}

/** The same frozen snapshot until something changes (`useSyncExternalStore` needs a stable value). */
export function liveRuns(): readonly LiveRun[] {
  if (logDirty) rebuild(); // a read never sees a log older than the lines already appended
  return snapshot;
}

let factoryCache: { src: readonly LiveRun[]; out: readonly LiveRun[] } | null = null;
/** `liveRuns()` without loop runs: what the Factory board, its cap and its summaries count. Stable between changes. */
export function factoryLiveRuns(): readonly LiveRun[] {
  const src = liveRuns();
  if (factoryCache?.src !== src) factoryCache = { src, out: factoryRuns(src) };
  return factoryCache.out;
}

/**
 * A run the Loop page is executing, shown on the board while it runs. It is NOT queued, holds no concurrency slot and
 * is never cancelled, saved or held by this manager. Returns the release that removes it.
 */
export function trackExternalRun(run: { runId: string; itemKey: string; projectRoot: string }): () => void {
  external.set(run.runId, { runId: run.runId, itemKey: run.itemKey, projectRoot: run.projectRoot, mode: "full", state: "running", startedAt: (deps.now ?? (() => new Date()))().toISOString(), note: LOOP_PAGE_NOTE, log: [], progress: null });
  emit();
  return () => {
    if (external.delete(run.runId)) emit();
  };
}

/** What a finished non-Factory loop run tells its observers (the Loop page and the loop boards). */
export interface LoopRunEnd {
  type: "finished";
  runId: string;
  loopId: string;
  projectRoot: string;
  /** The outcome line ("The loop passed.", a refusal, ...), null when the run said nothing. */
  notice: string | null;
  /** The run's whole log, including the lines written after the last live snapshot. */
  log: readonly string[];
  /** The run ended before it started (no record): `notice` is the reason. */
  refused: boolean;
  /** Held for review, or the shipper was blocked: the Loop page opens its Ship panel for it. */
  manualShip: LoopManualShip | null;
}
/** `signal`: the run's run_finished signal was posted, so the improvements panel can re-read. */
export type LoopRunEvent = LoopRunEnd | { type: "signal"; projectRoot: string };

const loopListeners = new Set<(e: LoopRunEvent) => void>();

export function subscribeLoopRunEvents(listener: (e: LoopRunEvent) => void): () => void {
  loopListeners.add(listener);
  return () => { loopListeners.delete(listener); };
}

function emitLoopEvent(e: LoopRunEvent): void {
  for (const l of [...loopListeners]) { try { l(e); } catch { /* an observer must not break the run's end */ } }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A one-line notice for the Factory board (e.g. a background MR restart), shown once like a start refusal. */
/** Sets the note a live run's card shows (e.g. "Continuing automatically…"); a run that is gone is ignored. */
export function setRunNote(runId: string, note: string | null): void {
  const run = runs.get(runId);
  if (!run) return;
  run.live.note = note;
  emit();
}

export function postRunNotice(message: string): void {
  lastNotice = message;
  emit();
}

/** The reason the most recent run did not start, once. */
export function takeRunNotice(): string | null {
  const n = lastNotice;
  lastNotice = null;
  return n;
}

function appendLog(run: ManagedRun, line: string): void {
  run.live.log.push(line);
  run.logWriter?.add(line);
  if (run.live.log.length > MAX_LOG_LINES) run.live.log.splice(0, run.live.log.length - MAX_LOG_LINES);
  emitSoon();
}

/** Logs why a run did not start and keeps it for takeRunNotice (the live run and its log disappear at once). */
function fail(run: ManagedRun, message: string): void {
  appendLog(run, message);
  lastNotice = message;
}

/** Starts a run (or queues it when the cap is reached) and returns its run id. Never awaits. */
export function startRun(projectRoot: string, item: RunItem, mode: RunMode, opts: { runId?: string } = {}): string {
  const d = requireDeps();
  if ((mode === "continue" || mode === "sendBack" || mode === "check" || mode === "rework" || mode === "humanReview") && !opts.runId) throw new Error(`${mode} needs the runId of an existing worktree`);
  const runId = opts.runId ?? newRunId(d.now(), d.rand);
  if (runs.has(runId)) return runId;
  // Starting again would race the pending record write (and its marker clear would delete the new run's marker).
  if (opts.runId !== undefined && heldRunIds(projectRoot).has(runId)) {
    postRunNotice("This run's record is still being saved; try again in a moment.");
    return runId;
  }
  // A loop's runs share one worktree (its slug), so a second run of the same loop would work in the first one's tree.
  if (item.loop) {
    const same = [...runs.values()].find((other) => other.item.loop?.loopId === item.loop?.loopId && other.live.projectRoot === projectRoot);
    if (same) {
      postRunNotice(`“${item.title}” already has a run in progress.`);
      return same.live.runId;
    }
  }
  // A new run for a work item that already has a live run of the same kind would cut a second worktree, branch and
  // draft MR for it (a double click, or the phone starting an issue whose card is already running).
  if (opts.runId === undefined) {
    for (const other of runs.values()) {
      if (other.live.itemKey === item.key && other.live.projectRoot === projectRoot && other.live.mode === mode && !other.cancelled) return other.live.runId;
    }
  }
  runs.set(runId, {
    live: { runId, itemKey: item.key, projectRoot, mode, state: "queued", startedAt: null, note: null, log: [], progress: null },
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
  // A run held at a stage boundary for a project that is not open takes no slot: it never times out, and counting it
  // would block every run of the open project until the user reopens the other one.
  let running = [...runs.values()].filter((r) => r.live.state !== "queued" && !(r.live.state === "paused" && r.live.projectRoot !== active)).length;
  const limit = concurrency();
  let changed = false;
  for (const runId of [...queue]) {
    if (running >= limit) break;
    const run = runs.get(runId);
    if (!run) { queue = queue.filter((id) => id !== runId); continue; }
    // Loop runs of one project copy the loop state in and out of the main tree, and a later finisher would delete what an
    // earlier one saved: one at a time, the rest wait (a Factory run behind them is not held up).
    if (run.item.loop && loopRunActive(run.live.projectRoot)) continue;
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

/** True while a non-Factory loop run of this project is running (or held for its project): the next one waits. Every loop run copies the shared loop state in and back out, so two at once would overwrite each other's. */
export function loopRunActive(projectRoot: string): boolean {
  return [...runs.values()].some((r) => r.item.loop !== undefined && r.live.projectRoot === projectRoot && r.live.state !== "queued");
}

export function cancelRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  if (run.live.state === "queued") {
    queue = queue.filter((id) => id !== runId);
    runs.delete(runId);
    emit();
    // A listener waiting for this run (a board's answer, the page) is released: it will never start.
    if (run.item.loop) emitLoopEvent({ type: "finished", runId, loopId: run.item.loop.loopId, projectRoot: run.live.projectRoot, notice: "Cancelled while queued", log: [], refused: true, manualShip: null });
    return;
  }
  run.cancelled = true;
  run.abort.abort();
  run.wake?.();
  // A loop run is pinned by its worktree id (none: the main tree); before that exists nothing is running to cancel.
  if (run.item.loop) {
    if (run.loopRunId !== undefined) void requireDeps().host("loop_cancel", run.loopRunId ? { runId: run.loopRunId } : {}).catch(() => undefined);
  } else void requireDeps().host("loop_cancel", { runId }).catch(() => undefined);
  emit();
}

/**
 * A loop run's Pause / Resume. The run holds at the next step boundary (never mid-step), like the Loop page's own pause.
 * Loop runs only; a Factory run has no user pause.
 */
export function setRunPaused(runId: string, paused: boolean): void {
  const run = runs.get(runId);
  if (!run || !run.item.loop || run.live.state === "queued") return;
  run.userPaused = paused;
  run.live.pauseRequested = paused ? true : undefined;
  if (!paused) run.wake?.();
  emit();
}

async function writeMarker(fs: FsApi, path: string, text: string, force = false): Promise<boolean> {
  if (typeof fs.write !== "function") return false;
  try { await fs.write(path, text, { expected_hash: null, ...(force ? { force: true } : {}) }); return true; } catch { return false; }
}

/** Never throws; false = the marker may still exist (the remove was refused or failed). */
async function clearMarker(fs: FsApi, path: string): Promise<boolean> {
  if (typeof fs.remove !== "function") return true;
  try { await fs.remove(path); return true; } catch { return false; }
}

/** The marker of a run that threw, cleared now when its project is open, else remembered until it is. */
async function clearOrHoldMarker(d: RunManagerDeps, run: ManagedRun, fs: FsApi): Promise<void> {
  const path = run.markerPath;
  if (!path) return;
  // The guarded fs refuses another project, so do not even try: hold the clear for flushPending.
  if (d.activeProject() === run.live.projectRoot && await clearMarker(fs, path)) return;
  const store = storage();
  const id = `marker:${run.live.runId}`;
  const held: PendingRecord = { projectRoot: run.live.projectRoot, entry: { id } as PendingRecord["entry"], record: {}, copy: null, marker: path, markerOnly: true };
  writePending(store, [...readPending(store).filter((p) => p.entry.id !== id), held]);
}

/** A stalled host write must not keep a finished run live: wait for the log at most this long. */
const LOG_FLUSH_TIMEOUT_MS = 5000;
async function boundedFlush(writer: RunLogWriter | undefined): Promise<void> {
  if (!writer) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, LOG_FLUSH_TIMEOUT_MS); (timer as { unref?: () => void }).unref?.(); });
  try { await Promise.race([writer.flush(), timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function execute(run: ManagedRun): Promise<void> {
  const d = requireDeps();
  const started = d.now();
  const fs = d.fsFor(run.live.projectRoot);
  if (run.item.loop) { await executeLoopRun(d, run, fs, run.item.loop); return; }
  let finished: Finished | null = null;
  try {
    finished = await runInWorktree(d, run, fs);
  } catch (e) {
    fail(run, e instanceof Error ? e.message : String(e));
    // No record will be written for a run that threw, so a left marker would show it Interrupted forever and
    // auto-resume it into the same crash.
    await clearOrHoldMarker(d, run, fs);
  }
  if (finished) {
    let entry: { id: string; startedAt: string } | null = null;
    try { entry = await saveRecord(d, run, fs, finished, started); }
    catch (e) {
      // saveRecord already held the record (and its marker) for the next flush; say so instead of dropping the run silently.
      fail(run, `Run record not written: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Only a record written now can carry the MR. A held record (project closed) is not auto-shipped: its card keeps
    // the manual Ship. The board shows a held run as "Record pending" and offers no Ship or Resume for it.
    let shipLine = "";
    // A stopped run opens no MR, so there is nothing to ship and no "Opening the MR" note.
    if (entry && d.autoShip && runStatusCode(finished.outcome) !== LOOPBACK_STOPPED_CODE) {
      run.live.note = "Opening the MR";
      emit();
      const f = finished;
      const line = await d.autoShip({ runId: run.live.runId, projectRoot: run.live.projectRoot, mode: run.live.mode, item: run.item, info: f.info, entry, statusCode: runStatusCode(f.outcome), needsDecision: needsDecisionSummary(f.outcome) !== null, failedStage: f.outcome.failedStage, runPrefix: repoPrefixFor(run.live.projectRoot, f.info.worktree) }).catch((e: unknown) => `MR not opened: ${e instanceof Error ? e.message : String(e)}`);
      if (line) appendLog(run, line);
      shipLine = line;
    }
    try {
      const o = finished.outcome;
      d.onRunFinished?.({
        runId: run.live.runId, itemKey: run.item.key, projectRoot: run.live.projectRoot, mode: run.live.mode, statusCode: runStatusCode(o), statusSummary: o.statusSummary,
        item: run.item, steps: summarizeSteps(o.stages), stepReviews: countStepReviews(o.stepReviews),
        durationSeconds: (d.now().getTime() - started.getTime()) / 1000, costUsd: o.costUsd ?? null, shipLine,
      });
    } catch { /* a listener must never change the run's own outcome */ }
  }
  await boundedFlush(run.logWriter);
  runs.delete(run.live.runId);
  emit();
  pump();
}

const USER_PAUSE_NOTE = "Paused";

/** The typed progress of a run about to start its steps. */
function newProgress(config: { stages: readonly LoopStage[]; maxIterations: number }, startedAt: string | null): NonNullable<LiveRun["progress"]> {
  return { stageName: null, stageIndex: 0, stageCount: config.stages.filter((s) => s.enabled).length, iteration: 0, maxIterations: clampIterations(config.maxIterations), repairs: 0, stages: [], startedAt, substate: null, model: null };
}

/** One runner event folded into a run's typed progress (the Factory and every other loop share it). */
function applyProgress(progress: NonNullable<LiveRun["progress"]>, e: RunProgressEvent): void {
  if (e.type === "iteration") progress.iteration = e.iteration;
  else if (e.type === "stage-start") {
    progress.stageName = e.stage.name; progress.stageIndex = e.index; progress.stageCount = e.count; progress.iteration = e.iteration;
    // A new step starts with no review in progress, so a sub-state from the previous step cannot carry over.
    progress.substate = null;
    const row = progress.stages.find((r) => r.id === e.stage.id);
    if (row) row.state = "running"; else progress.stages.push({ id: e.stage.id, name: e.stage.name, state: "running" });
  } else if (e.type === "stage-result") {
    const row = progress.stages.find((r) => r.id === e.stage.id);
    if (row) row.state = e.ok ? "passed" : "failed";
  } else if (e.type === "stage-skipped") {
    progress.stageName = e.stage.name; progress.stageIndex = e.index; progress.stageCount = e.count; progress.iteration = e.iteration;
    const row = progress.stages.find((r) => r.id === e.stage.id);
    if (row) row.state = "skipped"; else progress.stages.push({ id: e.stage.id, name: e.stage.name, state: "skipped" });
  } else if (e.type === "step-review") {
    progress.substate = e.phase === "fixing" ? "fixing review" : "reviewing";
  } else if (e.type === "step-review-result") {
    progress.substate = null;
  } else if (e.type === "loopback") {
    // The run goes back to the code step, so the check that failed must not keep showing as running or reviewing.
    const row = progress.stages.find((r) => r.id === e.stage.id);
    if (row) row.state = "failed";
    progress.substate = null;
  } else if (e.type === "repair") {
    progress.repairs += 1;
    const row = progress.stages.find((r) => r.id === e.stage.id);
    if (row && row.state !== "passed") row.state = "repaired";
  }
}

/** A non-Factory loop run: the Loop page's steps (run-manager-loop.ts). It writes its own record; a thrown error is the run's failure. */
async function executeLoopRun(d: RunManagerDeps, run: ManagedRun, fs: FsApi, request: LoopRunRequest): Promise<void> {
  let notice: string | null = null;
  let refused = false;
  const result: { finished: LoopRunFinished | null } = { finished: null };
  const loopStarted = d.now();
  const log = (line: string) => {
    appendLog(run, line);
    if (line.startsWith("$ ")) { try { d.onStage?.(run.live.runId); } catch { /* a listener must not stop the run */ } }
  };
  try {
    await runLoopRequest(d, {
      fs, projectRoot: run.live.projectRoot, runId: run.live.runId, request,
      log,
      notice: (text) => { notice = text; },
      // A loop's refusal belongs to the page or board that asked, not to the Factory board's one-shot notice.
      refuse: (message) => { refused = true; notice = message; appendLog(run, message); },
      isCancelled: () => run.cancelled,
      markCancelled: () => { run.cancelled = true; },
      signal: run.abort.signal,
      holdWhilePaused: holdForProject(d, run),
      holdForProject: async () => { await holdAt(d, run, true); },
      onPrepared: (worktreeRunId) => { run.loopRunId = worktreeRunId; },
      startLogFile: () => { run.logWriter = createRunLogWriter(fs, runLogPath(run.live.runId), run.live.log); },
      onConfig: (config) => { run.live.progress = newProgress(config, run.live.startedAt); emit(); },
      onProgress: (e) => { if (run.live.progress) { applyProgress(run.live.progress, e); emit(); } },
      onModel: (label) => { if (run.live.progress && run.live.progress.model !== label) { run.live.progress.model = label; emit(); } },
      onSignalPosted: () => emitLoopEvent({ type: "signal", projectRoot: run.live.projectRoot }),
      onFinished: (f) => { result.finished = f; },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    appendLog(run, message);
    notice = message;
    // The runner itself failed (not a stage verdict), as on the Loop page.
    try { d.loopRun?.reportIncident?.(message); d.loopRun?.notify?.(false); } catch { /* a listener must not stop the run's end */ }
  }
  const done = result.finished;
  if (done) {
    try {
      const o = done.outcome;
      d.onRunFinished?.({
        runId: run.live.runId, itemKey: run.item.key, projectRoot: run.live.projectRoot, mode: run.live.mode, statusCode: runStatusCode(o), statusSummary: o.statusSummary,
        item: run.item, steps: summarizeSteps(o.stages), stepReviews: countStepReviews(o.stepReviews),
        durationSeconds: (d.now().getTime() - loopStarted.getTime()) / 1000, costUsd: o.costUsd ?? null, shipLine: "",
      });
    } catch { /* a listener must never change the run's own outcome */ }
  }
  await boundedFlush(run.logWriter);
  const finalLog = [...run.live.log];
  runs.delete(run.live.runId);
  emit();
  pump();
  emitLoopEvent({ type: "finished", runId: run.live.runId, loopId: request.loopId, projectRoot: run.live.projectRoot, notice, log: finalLog, refused, manualShip: done?.manualShip ?? null });
}

async function runInWorktree(d: RunManagerDeps, run: ManagedRun, fs: FsApi): Promise<Finished | null> {
  const log = (line: string) => {
    appendLog(run, line);
    if (line.startsWith("$ ")) { try { d.onStage?.(run.live.runId); } catch { /* a listener must not stop the run */ } }
  };
  const loop = await d.loadFactoryLoop(fs);
  if (!loop) { fail(run, "This project has no Factory loop (system/loop.json could not be read); the run did not start."); return null; }
  // Without an Intake step an intake-only run would do nothing and still pass as "Intake ready".
  if (run.live.mode === "intakeOnly" && !loop.config.stages.some((s) => s.enabled && factoryRole(s) === "intake")) {
    fail(run, "This Factory process has no Intake step; add one in Factory → Process. The run did not start.");
    return null;
  }
  let config = configFor(run.live.mode, loop.config);
  const token = await d.approve(loop.id);
  if (token === null) { fail(run, "The Factory loop's commands were not approved; the run did not start."); return null; }
  if (run.cancelled) { log("Run cancelled before it started."); return null; }
  const info = run.reuse ? await findWorktree(d, run.live.runId) : await prepareWorktree(d, run);
  if (!info) { fail(run, `The worktree of run ${run.live.runId} no longer exists; the run did not start.`); return null; }
  run.logWriter = createRunLogWriter(fs, runLogPath(run.live.runId), run.live.log);
  // NOTE: loop_env_prepare clears the host's cancel flag on entry (so a Stop from an earlier attempt can't cancel a
  // Resume), which would also swallow a Stop pressed while the worktree was being cut; check it here first.
  if (run.cancelled) { log("Run cancelled before it started."); return null; }
  const envProblem = await prepareEnvironment(d, run.live.runId, loop, token, log);
  if (envProblem) { fail(run, `${envProblem} The run did not start.`); return null; }
  if (run.cancelled) { log("Run cancelled before it started."); return null; }
  // The project root often holds the clone under code/<name>, so detect the test command in the run worktree, not only at the project root.
  const runPrefix = repoPrefixFor(run.live.projectRoot, info.worktree);
  const detected = await detectTestCommand(fs, runPrefix).catch(() => null);
  const structure = await detectStructureCommand(fs, runPrefix).catch(() => null);
  const verifyFilled = withDetectedVerify(loop, detected?.command ?? null);
  const filled = withDetectedStructure(verifyFilled.loop, structure?.command ?? null);
  if (verifyFilled.changed || filled.changed) config = configFor(run.live.mode, filled.loop.config);
  const verifyProblem = factoryVerifyProblem(config);
  if (verifyProblem) { fail(run, `${verifyProblem} The run did not start.`); return null; }
  const marker = `${repoPrefixFor(run.live.projectRoot, info.worktree)}/.factory/RUN.json`;
  const markerBase = { runId: run.live.runId, mode: run.live.mode, startedAt: new Date().toISOString(), itemKey: run.item.key };
  // The marker also names the step the run is on, so an interrupted run's card sits in that step. Writes are chained
  // and awaited before the run ends, so a late write can never recreate the marker after it is cleared.
  let markerWrites: Promise<unknown> = Promise.resolve();
  if (!(await writeMarker(fs, marker, JSON.stringify(markerBase)))) {
    log("The run marker could not be written; an interrupted run may not offer Resume.");
  } else {
    run.markerPath = marker;
  }
  const ctx: StageExecContext = {
    projectRoot: run.live.projectRoot, runId: run.live.runId, runRoot: info.worktree, fs, host: d.host, core: d.core, log,
    approvalToken: async () => token, signal: run.abort.signal,
    isCancelled: () => run.cancelled, markCancelled: () => { run.cancelled = true; },
  };
  log(`▶ ${loop.name} (${run.live.mode})`);
  const progress = newProgress(config, run.live.startedAt);
  run.live.progress = progress;
  // Not awaited: the routing read may wait for a CLI probe, and a label must never delay the run's first step.
  const models = createModelTracker(d.core, config.repairModel);
  models.onChange(() => { if (run.live.progress === progress) { progress.model = models.label(); emit(); } });
  const onProgress = (e: RunProgressEvent) => {
    progress.model = models.onEvent(e);
    if (e.type === "stage-start") {
      const stage = e.stage.name;
      markerWrites = markerWrites.then(() => writeMarker(fs, marker, JSON.stringify({ ...markerBase, stage }), true));
    } else if (e.type === "stage-result") {
      try {
        d.onStageResult?.({ runId: run.live.runId, projectRoot: run.live.projectRoot, mode: run.live.mode, item: run.item, stage: e.stage, ok: e.ok, iteration: e.iteration, runPrefix: repoPrefixFor(run.live.projectRoot, info.worktree) });
      } catch { /* a listener must not stop the run */ }
    }
    applyProgress(progress, e);
    emit();
  };
  const outcome = await d.runLoop(config, { ...withBaselineFor(d.createStageDeps(ctx, loop), run.reuse), log, isCancelled: () => run.cancelled, holdWhilePaused: holdForProject(d, run), onProgress }).finally(() => markerWrites);
  log(outcome.cancelled ? "Loop cancelled." : outcome.passed ? "Loop passed." : `Loop failed: ${outcome.statusSummary}`);
  // Human review mode: a finished run that would auto-ship waits for a person instead. runStatusCode reads the flag.
  const held = holdsForHuman(config, { mode: run.live.mode, statusCode: runStatusCode(outcome), needsDecision: needsDecisionSummary(outcome) !== null, failedRole: outcome.failedStage ? factoryRole(outcome.failedStage) : null });
  if (held) return { loop, info, config, outcome: { ...outcome, awaitingReview: true } };
  // Every other failure (tests, review, final gate, check mode, cost or time) is the warning state, not a draft MR;
  // cancel, guard block, error and an intake decision keep their own states.
  const stopped = !outcome.passed && !outcome.cancelled && !outcome.blocked && !outcome.errored && needsDecisionSummary(outcome) === null && run.live.mode !== "intakeOnly";
  return { loop, info, config, outcome: stopped ? { ...outcome, stoppedAtLimit: true } : outcome };
}

/** What the host's `loop_env_prepare` answers (loop_env_cache.rs). */
interface EnvPrepare { status: "none" | "present" | "restored" | "built" | "failed"; message: string; key: string | null; output: string | null }

/**
 * Makes the loop's cached environment (`config.envCache`) ready in the run's worktree before its first step: copied from
 * the cache, or built once by the approved setup command. Returns a reason to stop the run, else null. A loop with no
 * envCache never reaches the host.
 */
async function prepareEnvironment(d: RunManagerDeps, runId: string, loop: { id: string; config: { envCache?: unknown } }, token: string, log: (line: string) => void): Promise<string | null> {
  if (!loop.config.envCache) return null;
  log("Preparing the environment (the first run for these requirements installs it; later runs reuse it)...");
  let r: EnvPrepare | null;
  try {
    r = await d.host<EnvPrepare | null>("loop_env_prepare", { loopId: loop.id, runId, approvalToken: token, timeoutSecs: 1800 });
  } catch (e) {
    return `The environment could not be prepared: ${e instanceof Error ? e.message : String(e)}.`;
  }
  if (!r || r.status === "none") return null;
  log(r.message);
  if (r.output && r.status !== "restored") log(r.output);
  return r.status === "failed" ? r.message : null;
}

/** Runs whose Approve is shipping right now. */
const shippingHeld = new Set<string>();

/**
 * Approve on a run held for a person, on any loop board: ships it through the same autoShip path as an automatic finish, so every safety
 * block (CI/hook files, secret scan, diff size) still applies. Starts no run. Returns autoShip's log line.
 * `statusCode` / `shipped` describe the record the card was drawn from; a stale card (no longer awaiting, or already
 * shipped) is refused so an old click cannot open a second MR.
 */
export async function shipHeldRun(projectRoot: string, item: RunItem, facts: { runId: string; entry: { id: string; startedAt: string }; statusCode?: string; shipped?: boolean; awaiting: { held: "success" | "failed"; kind: AutoShipKind; failedStage: string | null }; /** A non-Factory loop's name (its MR title and trail). */ processName?: string; /** The merged MR a restarted loop branch may replace. */ mergedMr?: string | null }): Promise<string> {
  const d = requireDeps();
  if (!d.autoShip) return "";
  if ((facts.statusCode !== undefined && facts.statusCode !== "awaiting_review") || facts.shipped) return "Not approved: this run is no longer waiting for review.";
  // autoShip can take minutes; a second click must not open a second MR.
  if (shippingHeld.has(facts.runId)) return "Already opening the MR for this run.";
  shippingHeld.add(facts.runId);
  const info = await findWorktree(d, facts.runId).catch(() => null);
  if (!info) { shippingHeld.delete(facts.runId); return "MR not opened: the run's worktree was removed."; }
  return d.autoShip({ runId: facts.runId, projectRoot, mode: "full", item, info, entry: facts.entry, statusCode: facts.awaiting.held, needsDecision: false, failedStage: null, kind: facts.awaiting.kind, runPrefix: repoPrefixFor(projectRoot, info.worktree), ...(facts.processName ? { processName: facts.processName } : {}), ...(facts.mergedMr ? { mergedMr: facts.mergedMr } : {}) })
      .catch((e: unknown) => `MR not opened: ${e instanceof Error ? e.message : String(e)}`)
      .finally(() => { shippingHeld.delete(facts.runId); });
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

/** The `awaiting` record fact of a held run: what the run would have shipped as, so Approve can ship it that way. */
function awaitingFact(o: LoopRunOutcome, mode: RunMode): { awaiting?: { held: "success" | "failed"; kind: AutoShipKind; failedStage: string | null } } {
  if (!o.awaitingReview) return {};
  const held = o.passed ? "success" : "failed";
  const kind = autoShipKind({ mode, statusCode: held, needsDecision: false, failedRole: o.failedStage ? factoryRole(o.failedStage) : null });
  return kind ? { awaiting: { held, kind, failedStage: o.failedStage?.name ?? null } } : {};
}

async function saveRecord(d: RunManagerDeps, run: ManagedRun, fs: FsApi, f: Finished, started: Date): Promise<{ id: string; startedAt: string } | null> {
  const { live, item } = run;
  const ended = d.now();
  const changedPaths = await d.host<string[]>("loop_changed_paths", { runId: live.runId }).catch(() => [] as string[]);
  const diff = await d.host<{ files?: unknown; truncated?: unknown; patchId?: unknown; additions?: unknown; deletions?: unknown } | null>("loop_worktree_diff", { runId: live.runId }).catch(() => null);
  const diffSummary = {
    files: Array.isArray(diff?.files) ? diff.files.filter((p): p is string => typeof p === "string") : [],
    truncated: diff?.truncated === true,
    patchId: typeof diff?.patchId === "string" ? diff.patchId : null,
    additions: typeof diff?.additions === "number" ? diff.additions : null,
    deletions: typeof diff?.deletions === "number" ? diff.deletions : null,
  };
  // factoryRunId + factoryMode: the Factory board finds a card's last run through these two fields in BOTH the month
  // index line and the record.
  const entry: LoopRunIndexEntry & { factoryRunId: string; factoryMode: RunMode } = { id: d.newId(), loopId: f.loop.id, loopName: f.loop.name, startedAt: started.toISOString(), durationSeconds: (ended.getTime() - started.getTime()) / 1000, iterationsUsed: f.outcome.iterationsUsed, statusCode: runStatusCode(f.outcome), statusSummary: f.outcome.statusSummary, trigger: "manual", factoryRunId: live.runId, factoryMode: live.mode };
  const stages = f.outcome.stages.map((o) => ({ stageName: o.stage.name, severity: o.stage.severity, costUsd: o.usage?.costUsd ?? null, run: { exitCode: o.ok ? 0 : 1, stdout: o.output, stderr: "", timedOut: false, durationMs: o.durationMs ?? 0 } }));
  const record = {
    ...entry, endedAt: ended.toISOString(), gitRoot: f.info.worktree, config: f.config, changedPaths, summaryPath: null, stages, ...stepReviewRecords(f.outcome.stepReviews), ...loopbackRecord(f.outcome.loopback),
    iterations: iterationRecordsWithScores(f.outcome.iterations),
    workItem: { source: item.source, id: item.id, title: item.title },
    worktree: { runId: live.runId, branch: f.info.branch, baseCommit: f.info.baseCommit, repo: f.info.repo },
    ...awaitingFact(f.outcome, live.mode),
    ship: null, needsDecision: needsDecisionSummary(f.outcome), diffSummary, costUsd: f.outcome.costUsd ?? stages.reduce((n, st) => n + (st.costUsd ?? 0), 0),
  };
  const copy = live.mode === "full" || live.mode === "intakeOnly";
  const prefix = repoPrefixFor(live.projectRoot, f.info.worktree);
  const held: PendingRecord = {
    projectRoot: live.projectRoot, entry, record,
    copy: copy ? { prefix, runId: live.runId, endedAt: ended.toISOString() } : null,
    // Cleared by the same write as the record, so flushPending also clears the marker when the project is reopened.
    marker: `${prefix}/.factory/RUN.json`,
  };
  if (d.activeProject() === live.projectRoot) {
    try { await writeHeld(d, fs, held); } catch (e) {
      // Held like a closed project's record, so the next launch or project change retries it and auto-resume does not replay the run.
      holdRecord(d, fs, held, 1);
      throw e;
    }
    return { id: entry.id, startedAt: entry.startedAt };
  }
  appendLog(run, "The run's project is not open; its record is saved when you open it again.");
  holdRecord(d, fs, held, 0);
  return null;
}

/** Keeps a record that is not on disk: in memory for this session and in storage so a quit does not lose it. */
function holdRecord(d: RunManagerDeps, fs: FsApi, held: PendingRecord, attempts: number): void {
  const root = held.projectRoot;
  const runId = (held.record.worktree as { runId?: unknown } | undefined)?.runId;
  pending.set(root, [...(pending.get(root) ?? []), { id: held.entry.id, runId: typeof runId === "string" ? runId : null, write: () => writeHeld(d, fs, held) }]);
  attemptsById.set(held.entry.id, attempts);
  const store = storage();
  writePending(store, [...readPending(store).filter((p) => p.entry.id !== held.entry.id), { ...held, attempts }]);
  scheduleRetry(root);
}

/** One parse of the pending-records store, filtered to `projectRoot`: shared by heldRunIds/stuckRunIds/heldAndStuckRunIds
 * so a caller needing more than one of them does not re-parse localStorage for each. */
function pendingForProject(projectRoot: string): PendingRecord[] {
  return readPending(storage()).filter((p) => p.projectRoot === projectRoot);
}

/** Run ids whose record (or marker clear) is waiting to be written in this project: the board shows them as "Record pending". */
/** Held runs whose record failed every try: the board offers "Retry record" for them. */
export function stuckRunIds(projectRoot: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const p of pendingForProject(projectRoot)) {
    if ((p.attempts ?? 0) < MAX_RECORD_ATTEMPTS) continue;
    const runId = (p.record.worktree as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") ids.add(runId);
  }
  return ids;
}

/** The "Retry record" action: one more try now, for every record held in this project. */
export async function retryHeldRecords(projectRoot: string): Promise<void> {
  if (deps.fsFor && deps.appendRecord) await flushPending(projectRoot);
}

/** Forgets the held records of these runs (Discard): their retries and notices stop. */
export function dropHeldRecords(projectRoot: string, runIds: readonly string[]): void {
  const drop = new Set(runIds);
  const runOf = (p: PendingRecord): string | null => {
    const fromRecord = (p.record.worktree as { runId?: unknown } | undefined)?.runId;
    return typeof fromRecord === "string" ? fromRecord : p.entry.id.startsWith("marker:") ? p.entry.id.slice("marker:".length) : null;
  };
  const mem = pending.get(projectRoot) ?? [];
  for (const m of mem) if (m.runId && drop.has(m.runId)) attemptsById.delete(m.id);
  pending.set(projectRoot, mem.filter((m) => !(m.runId && drop.has(m.runId))));
  const store = storage();
  const all = readPending(store);
  const gone = all.filter((p) => p.projectRoot === projectRoot && drop.has(runOf(p) ?? ""));
  for (const p of gone) attemptsById.delete(p.entry.id);
  if (gone.length > 0) writePending(store, all.filter((p) => !gone.includes(p)));
  emit();
}

export function heldRunIds(projectRoot: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const m of pending.get(projectRoot) ?? []) if (m.runId) ids.add(m.runId);
  for (const p of pendingForProject(projectRoot)) {
    const fromRecord = (p.record.worktree as { runId?: unknown } | undefined)?.runId;
    if (typeof fromRecord === "string") ids.add(fromRecord);
    if (p.entry.id.startsWith("marker:")) ids.add(p.entry.id.slice("marker:".length));
  }
  return ids;
}

/** `heldRunIds` + `stuckRunIds` from one parse of localStorage: the board's run-log listener fires up to 20x/s while a
 * run is live and needs both sets every time, so it calls this instead of the two functions above. */
export function heldAndStuckRunIds(projectRoot: string): { held: ReadonlySet<string>; stuck: ReadonlySet<string> } {
  const held = new Set<string>();
  const stuck = new Set<string>();
  for (const m of pending.get(projectRoot) ?? []) if (m.runId) held.add(m.runId);
  for (const p of pendingForProject(projectRoot)) {
    const fromRecord = (p.record.worktree as { runId?: unknown } | undefined)?.runId;
    if (typeof fromRecord === "string") {
      held.add(fromRecord);
      if ((p.attempts ?? 0) >= MAX_RECORD_ATTEMPTS) stuck.add(fromRecord);
    }
    if (p.entry.id.startsWith("marker:")) held.add(p.entry.id.slice("marker:".length));
  }
  return { held, stuck };
}

/** Retries a held record a few seconds later while its project stays open (a transient conflict usually clears). */
function scheduleRetry(root: string): void {
  if (retryTimers.has(root)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(root);
    if ((deps.activeProject?.() ?? null) === root && deps.fsFor && deps.appendRecord) void flushPending(root);
  }, FLUSH_RETRY_MS);
  (timer as { unref?: () => void }).unref?.();
  retryTimers.set(root, timer);
}

/** Counts a failed write of a held record, tells the user, and keeps the record for the next try. */
function noteFlushFailure(root: string, id: string, e: unknown): void {
  const store = storage();
  const all = readPending(store);
  const cur = all.find((p) => p.entry.id === id);
  const n = Math.max(cur?.attempts ?? 0, attemptsById.get(id) ?? 0) + 1;
  attemptsById.set(id, n);
  if (cur) writePending(store, all.map((p) => (p.entry.id === id ? { ...p, attempts: n } : p)));
  const why = e instanceof Error ? e.message : String(e);
  postRunNotice(n >= MAX_RECORD_ATTEMPTS
    ? `Run record could not be written after ${n} tries: ${why}. It is kept and tried again when the project is opened.`
    : n === 1 ? `Run record not written: ${why}` : `Run record still not written (attempt ${n}): ${why}`);
  if (n < MAX_RECORD_ATTEMPTS) scheduleRetry(root);
}

async function writeHeld(d: RunManagerDeps, fs: FsApi, held: PendingRecord): Promise<void> {
  if (held.markerOnly) {
    // A throw keeps the entry stored for the next flush.
    if (!(await clearMarker(fs, held.marker))) throw new Error("the run marker could not be removed");
    return;
  }
  await d.appendRecord(fs, held.entry, held.record);
  // Fire-and-forget and fail-open: the core also counts a repeated run_finished for the same run once.
  void postSignal(d.core, { projectRoot: held.projectRoot, loopId: held.entry.loopId, kind: "run_finished", runId: held.entry.id, payload: () => runSignalPayload(held.entry, held.record) });
  if (held.copy) await d.copyReadiness(fs, held.copy.prefix, held.copy.runId, new Date(held.copy.endedAt));
  await clearMarker(fs, held.marker);
}

/**
 * The runner's `holdWhilePaused`: at a stage boundary a loop run whose Pause was pressed holds until Resume, and a run whose
 * project is not the open one holds ("paused") until that project is open again or the run is cancelled (cancelRun calls
 * `run.wake`). Never times out (`configFor` sets pauseTimeoutSeconds 0).
 */
function holdForProject(d: RunManagerDeps, run: ManagedRun): (timeoutSeconds?: number) => Promise<"ok" | "timedOut"> {
  return (timeoutSeconds = 0) => holdAt(d, run, false, timeoutSeconds);
}

/** `ignoreCancel`: the wait for the project is not cut short by Cancel (the end of a run writes into its project, cancelled or not). */
async function holdAt(d: RunManagerDeps, run: ManagedRun, ignoreCancel: boolean, timeoutSeconds = 0): Promise<"ok" | "timedOut"> {
  const since = Date.now();
  const away = () => d.activeProject() !== run.live.projectRoot && !(run.cancelled && !ignoreCancel) && !run.dropped;
  for (;;) {
    // A user Pause times out like the runner's pause always did (0 = never); the project-away hold below never does.
    while (run.userPaused && !run.cancelled && !run.dropped) {
      const remaining = timeoutSeconds > 0 ? timeoutSeconds * 1000 - (Date.now() - since) : 0;
      if (timeoutSeconds > 0 && remaining <= 0) {
        run.userPaused = false;
        run.live.pauseRequested = undefined;
        run.live.state = "running";
        run.live.note = null;
        emit();
        return "timedOut";
      }
      run.live.state = "paused";
      run.live.note = USER_PAUSE_NOTE;
      emit();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        run.wake = resolve;
        if (timeoutSeconds > 0) { timer = setTimeout(resolve, remaining); (timer as { unref?: () => void }).unref?.(); }
      });
      if (timer !== undefined) clearTimeout(timer);
      run.wake = undefined;
    }
    if (run.live.note === USER_PAUSE_NOTE) { run.live.state = "running"; run.live.note = null; emit(); }
    if (!away()) return "ok";
    run.live.state = "paused";
    run.live.note = "Waiting for its project";
    emit();
    pump(); // its slot is free now: a queued run of the open project may start
    while (away()) {
      await new Promise<void>((resolve) => {
        const off = d.subscribeProject(() => { if (!away()) { off(); resolve(); } });
        run.wake = () => { off(); resolve(); };
      });
      run.wake = undefined;
    }
    run.live.state = "running";
    run.live.note = null;
    emit();
    // A Pause pressed while the run waited for its project still holds it.
    if (!(run.userPaused && !run.cancelled && !run.dropped)) return "ok";
  }
}

/** Writes the records of runs that ended while their project was closed (this session's and stored ones), once it is open again. */
async function flushPending(projectRoot: string): Promise<void> {
  const d = deps as RunManagerDeps;
  const memory = (pending.get(projectRoot) ?? []).filter((m) => !flushing.has(m.id));
  pending.delete(projectRoot);
  const memoryIds = new Set(memory.map((m) => m.id));
  const stored = readPending(storage()).filter((p) => p.projectRoot === projectRoot && !memoryIds.has(p.entry.id) && !flushing.has(p.entry.id));
  for (const id of [...memoryIds, ...stored.map((p) => p.entry.id)]) flushing.add(id);
  const written = new Set<string>();
  const failed: typeof memory = [];
  for (const m of memory) {
    try { await m.write(); written.add(m.id); } catch (e) { failed.push(m); noteFlushFailure(projectRoot, m.id, e); }
  }
  for (const p of stored) {
    try { await writeHeld(d, d.fsFor(projectRoot), p); written.add(p.entry.id); } catch (e) { noteFlushFailure(projectRoot, p.entry.id, e); /* stays stored for the next flush */ }
  }
  for (const id of [...memoryIds, ...stored.map((p) => p.entry.id)]) flushing.delete(id);
  // A failed write is retried on the next project change instead of being dropped.
  if (failed.length > 0) pending.set(projectRoot, [...(pending.get(projectRoot) ?? []), ...failed]);
  if (written.size > 0) {
    const store = storage();
    writePending(store, readPending(store).filter((p) => !written.has(p.entry.id)));
    for (const id of written) attemptsById.delete(id);
    // The board shows a held run as "Record pending" until now.
    emit();
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
