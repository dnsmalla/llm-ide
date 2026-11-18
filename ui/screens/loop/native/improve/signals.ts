// Recording side of Loop self-improvement: turns run results and user edits into signals posted to the core.
// Everything here is fail-open: a signal must never throw into a run or a save, and an older core without the routes
// is simply skipped (Review Focus 4).
import type { LoopDefinition, LoopStage } from "../model.ts";
import type { LoopRunIndexEntry } from "../history.ts";
import type { CoreFetch } from "../stage-exec.ts";

/** The core API version that serves POST /kb/loop/improve/*. */
export const LOOP_IMPROVE_MIN_API = 150;
const FINDINGS_MAX = 2000;
const TEXT_MAX = 20000;

export interface RunFinishedPayload {
  statusCode: string;
  passed: boolean;
  iterations: number;
  durationSeconds: number;
  costUsd: number | null;
  stages: { name: string; ok: boolean }[];
  stepReviews: { stageName: string; verdict: string; attempts: number; findings: string }[];
  loopbackRounds: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** The run_finished payload for a finished run; `passed` is the runner's success code (see runStatusCode). */
export function runSignalPayload(entryIn: LoopRunIndexEntry, recordIn: Record<string, unknown>): RunFinishedPayload {
  // Total: a held record comes from persisted JSON, so neither argument is trusted to be an object.
  const entry: Partial<LoopRunIndexEntry> = isObj(entryIn) ? entryIn : {};
  const record: Record<string, unknown> = isObj(recordIn) ? recordIn : {};
  const stages = (Array.isArray(record.stages) ? record.stages : []).filter(isObj).map((s) => ({
    name: typeof s.stageName === "string" ? s.stageName : "",
    ok: isObj(s.run) && s.run.exitCode === 0,
  }));
  const stepReviews = (Array.isArray(record.stepReviews) ? record.stepReviews : []).filter(isObj).map((r) => ({
    stageName: typeof r.stageName === "string" ? r.stageName : "",
    verdict: typeof r.verdict === "string" ? r.verdict : "",
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    findings: cap(typeof r.findings === "string" ? r.findings : "", FINDINGS_MAX),
  }));
  const rounds = isObj(record.loopback) && typeof record.loopback.rounds === "number" ? record.loopback.rounds : 0;
  return {
    statusCode: typeof entry.statusCode === "string" ? entry.statusCode : "",
    // A run held for a person passed all its checks and only waits for review.
    passed: entry.statusCode === "success" || entry.statusCode === "awaiting_review",
    iterations: typeof entry.iterationsUsed === "number" ? entry.iterationsUsed : 0,
    durationSeconds: typeof entry.durationSeconds === "number" ? entry.durationSeconds : 0,
    costUsd: typeof record.costUsd === "number" && Number.isFinite(record.costUsd) ? record.costUsd : null,
    stages, stepReviews, loopbackRounds: rounds,
  };
}

const STAGE_FIELDS = ["name", "kind", "command", "skillId", "targetPath", "outputPath", "prompt", "enabled", "severity", "timeoutSeconds", "check", "allowsRepair", "runOnce", "reviewAfter", "promptAddendum", "order"] as const;
const LOOP_FIELDS = ["name", "goal", "acceptanceCriteria", "scopeGlobs", "inputPath", "runsOnSchedule"] as const;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clip = (v: unknown): unknown => (typeof v === "string" ? cap(v, TEXT_MAX) : v ?? null);

function stageChanges(before: LoopStage, after: LoopStage): Record<string, unknown> | null {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of STAGE_FIELDS) {
    const b = (before as unknown as Record<string, unknown>)[f];
    const a = (after as unknown as Record<string, unknown>)[f];
    if (!same(b, a)) changes[f] = { before: clip(b), after: clip(a) };
  }
  return Object.keys(changes).length ? { stageName: after.name, changes } : null;
}

/** One entry per changed stage (matched by id) plus one loop-level entry; [] when nothing differs. */
export function loopEditSignals(before: LoopDefinition, after: LoopDefinition): { stageKey: string | null; payload: Record<string, unknown> }[] {
  const out: { stageKey: string | null; payload: Record<string, unknown> }[] = [];
  const beforeStages = new Map(before.config.stages.map((s) => [s.id, s]));
  for (const stage of after.config.stages) {
    const prev = beforeStages.get(stage.id);
    const payload = prev ? stageChanges(prev, stage) : null;
    if (payload) out.push({ stageKey: stage.defaultKey ?? null, payload });
  }
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of LOOP_FIELDS) {
    if (!same(before[f], after[f])) changes[f] = { before: clip(before[f]), after: clip(after[f]) };
  }
  const { stages: _b, ...cfgBefore } = before.config;
  const { stages: _a, ...cfgAfter } = after.config;
  for (const key of new Set([...Object.keys(cfgBefore), ...Object.keys(cfgAfter)])) {
    const b = (cfgBefore as Record<string, unknown>)[key];
    const a = (cfgAfter as Record<string, unknown>)[key];
    if (!same(b, a)) changes[`config.${key}`] = { before: clip(b), after: clip(a) };
  }
  const afterIds = new Set(after.config.stages.map((s) => s.id));
  const added = after.config.stages.filter((s) => !beforeStages.has(s.id)).map((s) => s.name);
  const removed = before.config.stages.filter((s) => !afterIds.has(s.id)).map((s) => s.name);
  if (added.length) changes.stagesAdded = { before: null, after: added };
  if (removed.length) changes.stagesRemoved = { before: removed, after: null };
  if (Object.keys(changes).length) out.push({ stageKey: null, payload: { loopName: after.name, changes } });
  return out;
}

/** True when the core's /health apiVersion serves the improve routes. */
export function improveAvailable(apiVersion: unknown): boolean {
  return typeof apiVersion === "number" && Number.isFinite(apiVersion) && apiVersion >= LOOP_IMPROVE_MIN_API;
}

const versions = new WeakMap<object, Promise<unknown>>();
/** The core's apiVersion from one /health read per core object; a failed read resolves to undefined (unavailable). */
export function loadCoreApiVersion(core: CoreFetch): Promise<unknown> {
  let p = versions.get(core);
  if (!p) {
    p = Promise.resolve().then(() => core.request<{ apiVersion?: unknown }>("/health", { auth: false })).then((h) => h?.apiVersion, () => undefined);
    versions.set(core, p);
  }
  return p;
}

let warned = false;
/** Posts one signal. Never rejects; logs once per session on failure. */
export async function postSignal(core: CoreFetch, body: { projectRoot: string; loopId: string; stageKey?: string | null; kind: string; runId?: string | null; payload: unknown | (() => unknown) }): Promise<void> {
  try {
    if (!improveAvailable(await loadCoreApiVersion(core))) return;
    // A thunk is built here, inside the fail-open try, so building a payload can never throw into the caller.
    const payload = typeof body.payload === "function" ? (body.payload as () => unknown)() : body.payload;
    await core.request("/kb/loop/improve/signal", { method: "POST", body: { ...body, payload } });
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`loop improvement signal not recorded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
