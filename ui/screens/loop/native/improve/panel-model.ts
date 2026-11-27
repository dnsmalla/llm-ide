// Page-level model of the Improvements panel: applying, reverting and listing improvements. Every rule (allowlist,
// direction, staleness) lives in change.ts and is re-checked there against the CURRENT loop; nothing is reimplemented.
import { reviewEveryRunsOf, type LoopDefinition } from "../model.ts";
import type { LoopProjectStore } from "../model.ts";
import { isFactoryLoop } from "../factory.ts";
import { loadLoops, saveLoops, type LoopFs } from "../store.ts";
import { appendChangeLines, changeLine, newOutcomeLines, readChangeLog, unrecordedDecisions } from "./changes-log.ts";
import type { CoreFetch } from "../stage-exec.ts";
import { applyChange, invertChange, type ImprovementChange } from "./change.ts";

type LoadState = { store: LoopProjectStore; hash: string };
export interface ApplyDeps {
  fs: LoopFs;
  core: CoreFetch;
  projectRoot: string;
  load: LoadState;
  runningLoopIds: ReadonlySet<string>;
  /** Evaluated at click time, right before the write: a run may have started since the panel rendered. */
  isRunning?: () => boolean;
}
export type ApplyResult = LoadState & { notice?: string };

export interface ImproveRow {
  id: number | string;
  loopId: string;
  templateKey?: string | null;
  stageKey: string | null;
  change: ImprovementChange;
  rationale: string;
  evidence: { signalIds: number[]; excerpts?: string[] } | null;
  suggestedScope: "project" | "general";
  status: string;
  scope: string | null;
  origin?: string;
  baseline?: unknown;
  outcome: { verdict?: string } | null;
  createdAt: string;
  decidedAt: string | null;
  fromProjectName?: string;
  forLoopId?: string;
  /** The core could not find this decided change's line in system/self-improvement/changes.jsonl (`change` is null). */
  recordMissing?: boolean;
}
export interface ImproveState {
  loops: Record<string, { finishedRunsSinceReview: number; proposals: ImproveRow[]; history: ImproveRow[] }>;
  offers: ImproveRow[];
}

/** Auto review is due once this many runs finished since the last one. */
export function shouldAutoReview(finishedRunsSinceReview: number, loop: LoopDefinition): boolean {
  return finishedRunsSinceReview >= reviewEveryRunsOf(loop.config);
}

/**
 * Loops that must not be edited right now: the one this page is running itself, every loop the run manager is running or
 * has queued in this project, and the Factory loop while the manager holds a Factory run of this project (lane runs always
 * execute the Factory loop).
 */
export function runningLoopIdsOf(input: { store: LoopProjectStore; projectRoot: string; activeLoopId: string | null; liveRuns: readonly { projectRoot: string; itemKey?: string }[] }): Set<string> {
  const ids = new Set<string>();
  if (input.activeLoopId) ids.add(input.activeLoopId);
  const here = input.liveRuns.filter((r) => r.projectRoot === input.projectRoot);
  for (const r of here) if (r.itemKey?.startsWith("loop:")) ids.add(r.itemKey.slice("loop:".length));
  if (here.some((r) => !r.itemKey?.startsWith("loop:"))) {
    for (const loop of input.store.loops) if (isFactoryLoop(loop)) ids.add(loop.id);
  }
  return ids;
}

const isConflict = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "conflict";

function withChange(store: LoopProjectStore, loopId: string, change: ImprovementChange, mode: "forward" | "revert"): LoopProjectStore {
  const loop = store.loops.find((l) => l.id === loopId);
  if (!loop) throw new Error("This suggestion is out of date");
  const next = applyChange(loop, change, { mode });
  return { ...store, loops: store.loops.map((l) => (l.id === loopId ? next : l)) };
}

/** Apply + hash-checked save. One reload and re-check when another writer changed the file in between. */
async function applyAndSave(deps: ApplyDeps, loopId: string, change: ImprovementChange, mode: "forward" | "revert"): Promise<LoadState> {
  if (deps.runningLoopIds.has(loopId) || deps.isRunning?.()) throw new Error("Finish or stop the run first");
  let load = deps.load;
  for (let attempt = 0; ; attempt++) {
    const next = withChange(load.store, loopId, change, mode); // stale throws here, before any write
    try {
      const saved = await saveLoops(deps.fs, next, load.hash);
      return { store: next, hash: saved.hash };
    } catch (e) {
      if (!isConflict(e) || attempt >= 1) throw e;
      const fresh = await loadLoops(deps.fs);
      if (fresh.kind !== "ok") throw new Error("The Loop file could not be reloaded");
      load = { store: fresh.store, hash: fresh.hash };
    }
  }
}

async function decide(deps: ApplyDeps, body: Record<string, unknown>, saved: LoadState): Promise<ApplyResult> {
  try {
    await deps.core.request("/kb/loop/improve/decide", { method: "POST", body: { ...body, projectRoot: deps.projectRoot } });
    return saved;
  } catch {
    // The file is already changed; the row then reads as stale on the next refresh.
    return { ...saved, notice: "The change was applied but could not be recorded. Refresh the suggestions." };
  }
}

/** The row as the log needs it; a caller without the full row (tests) logs the change alone. */
type LogRow = Partial<Pick<ImproveRow, "rationale" | "evidence" | "origin" | "stageKey" | "templateKey">>;

/**
 * Records the decision in system/self-improvement/changes.jsonl after the loop file changed and before the DB call,
 * so the log (the shareable record) never misses an applied change. Once the line is written the DB is told
 * `logged: true` and keeps no copy of the text (the log is its one home); a failed write keeps the DB copy and never
 * undoes the change. `lineId` is the improvement's own id (for an adopt, the new row's id the client chose).
 */
async function logDecision(deps: ApplyDeps, action: "accept" | "adopt" | "revert", item: { id: string | number; loopId: string; change: ImprovementChange; row?: LogRow }, lineId: string, body: Record<string, unknown>, saved: LoadState, scope?: string, origin?: string): Promise<{ body: Record<string, unknown>; problem: string | null }> {
  const loop = saved.store.loops.find((l) => l.id === item.loopId);
  const r = item.row ?? {};
  const logged = { ...body, logged: true };
  try {
    await appendChangeLines(deps.fs, [changeLine(action, {
      id: lineId, loopId: item.loopId, change: item.change, rationale: r.rationale ?? "", evidence: r.evidence ?? null, origin: origin ?? r.origin,
      stageKey: r.stageKey ?? ("stageKey" in item.change ? item.change.stageKey : null),
    }, logged, { scope, loopKey: loop?.defaultKey ?? r.templateKey ?? null })]);
    return { body: logged, problem: null };
  } catch {
    return { body, problem: "The change was applied, but system/self-improvement/changes.jsonl could not be written." };
  }
}

export async function acceptImprovement(deps: ApplyDeps, item: { id: string | number; loopId: string; change: ImprovementChange; kind: "proposal" | "offer"; row?: LogRow }, scope: "project" | "general"): Promise<ApplyResult> {
  const saved = await applyAndSave(deps, item.loopId, item.change, "forward");
  const offer = item.kind === "offer";
  // An adopted offer becomes a new row here; its id is chosen now so the log line and the row share it.
  const lineId = offer ? globalThis.crypto.randomUUID() : String(item.id);
  const body = offer ? { action: "adopt", id: item.id, loopId: item.loopId, newId: lineId } : { action: "accept", id: item.id, scope };
  const logged = await logDecision(deps, offer ? "adopt" : "accept", item, lineId, body, saved, offer ? "project" : scope, offer ? `shared:${item.id}` : undefined);
  const result = await decide(deps, logged.body, saved);
  return logged.problem && !result.notice ? { ...result, notice: logged.problem } : result;
}

export async function revertImprovement(deps: ApplyDeps, item: { id: string | number; loopId: string; change: ImprovementChange; row?: LogRow }): Promise<ApplyResult> {
  const saved = await applyAndSave(deps, item.loopId, invertChange(item.change), "revert");
  const logged = await logDecision(deps, "revert", item, String(item.id), { action: "revert", id: item.id }, saved);
  const result = await decide(deps, logged.body, saved);
  return logged.problem && !result.notice ? { ...result, notice: logged.problem } : result;
}

/**
 * Brings the DB and the log together after a state read: re-sends every decision the log has but the DB missed, and
 * appends outcome verdicts the log lacks. Returns true when a decision was re-sent (the caller reads the state again).
 * Best effort: a failure here never blocks the panel.
 */
export async function syncChangeLog(fs: LoopFs, core: CoreFetch, projectRoot: string, state: ImproveState): Promise<boolean> {
  let log;
  try { log = await readChangeLog(fs); } catch { return false; }
  let resent = false;
  for (const body of unrecordedDecisions(log, state)) {
    try {
      await core.request("/kb/loop/improve/decide", { method: "POST", body: { ...body, projectRoot } });
      resent = true;
    } catch { /* tried again on the next load */ }
  }
  await appendChangeLines(fs, newOutcomeLines(log, state)).catch(() => undefined);
  return resent;
}

export async function loadImproveState(core: CoreFetch, projectRoot: string, store: LoopProjectStore): Promise<ImproveState> {
  const loops = store.loops.map((l) => ({
    loopId: l.id, templateKey: l.defaultKey,
    stageKeys: l.config.stages.map((s) => s.defaultKey).filter((k): k is string => k !== null),
  }));
  return core.request<ImproveState>("/kb/loop/improve/state", { method: "POST", body: { projectRoot, loops } });
}

export async function decideSimple(core: CoreFetch, projectRoot: string, body: { action: "reject" | "dismiss"; id: string | number }): Promise<void> {
  await core.request("/kb/loop/improve/decide", { method: "POST", body: { projectRoot, ...body } });
}

/** One plain line for a failed improve call; PROJECT_UNKNOWN is the unregistered-folder case. */
export function improveErrorLine(e: unknown): { unavailable: boolean; text: string } {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === "PROJECT_UNKNOWN") return { unavailable: true, text: "Not available for this folder" };
  return { unavailable: false, text: e instanceof Error ? e.message : "Something went wrong" };
}

export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  better: "Better", same: "No clear change", no_clear_change: "No clear change", worse: "Worse", not_enough_data: "Not enough data yet",
};
export function outcomeLabel(outcome: { verdict?: string } | null): string | null {
  if (!outcome) return null;
  const v = outcome.verdict ?? "";
  return OUTCOME_LABEL[v] ?? OUTCOME_LABEL[v.replace(/[\s-]+/g, "_")] ?? null;
}

/** The verdict text the review dropped/skipped result shows in the status line. */
export function reviewStatusLine(r: { saved: number; dropped: { reason: string }[] } | { failed: string } | { skipped: string }): string {
  if ("failed" in r) return `Review failed: ${r.failed}. Nothing was changed; try again.`;
  if ("skipped" in r) return `No review: ${r.skipped}`;
  const dropped = r.dropped.length ? ` ${r.dropped.length} dropped: ${[...new Set(r.dropped.map((d) => d.reason))].join("; ")}` : "";
  return `${r.saved} new suggestion${r.saved === 1 ? "" : "s"}.${dropped}`;
}
