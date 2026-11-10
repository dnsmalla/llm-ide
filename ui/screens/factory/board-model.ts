// Pure Factory board logic: grouping, card actions, fact assembly and decoders for host and core answers. No React,
// no host: the board's columns come from these facts every time it is read, and nothing here writes anything.
import { loadRunRecord, type HistoryFs } from "../loop/native/history.ts";
import type { WorkItem } from "../loop/native/factory.ts";
import type { LiveRun } from "../loop/native/run-manager.ts";
import { COLUMNS, NOTE, columnFor, decodeRunRecordFacts, type Column, type ItemFacts, type RunRecordFacts, type ShipStatus } from "./columns.ts";
import type { WorkItemRecord } from "./items.ts";

export { factoryAnchor, focusKeyFromAnchor } from "./anchor.ts";

export const STATUS_REFRESH_MS = 5 * 60 * 1000;
export const SHIP_STATUS_BATCH = 20;
export type CardAction = "start" | "openDiff" | "ship" | "sendBack" | "discard" | "openRequest" | "resume" | "intake";
export interface CardView { key: string; title: string; source: WorkItemRecord["source"]; note: string | null; actions: CardAction[]; costUsd?: number | null; durationSeconds?: number | null; progressLabel?: string | null; lastLine?: string | null }
export const ACTION_LABELS: Readonly<Record<CardAction, string>> = { start: "Start", openDiff: "Open diff", ship: "Ship", sendBack: "Send back", discard: "Discard", openRequest: "Open PR/MR", resume: "Resume", intake: "Run intake" };
export const SOURCE_LABELS: Readonly<Record<WorkItemRecord["source"], string>> = { issue: "Issue", spec: "Spec", text: "Text" };
export const EMPTY_FACTS: ItemFacts = { live: null, lastRecord: null, worktreeExists: false, ship: null, shipStatusError: false, lastKnownColumn: null };

/** The actions a card in this column offers (the spec's table; `note` refines the needs-you cases). */
export function actionsFor(column: Column, note: string | null): CardAction[] {
  switch (column) {
    case "inbox": return note === NOTE.intakeReady ? ["start", "discard"] : ["start", "intake", "discard"];
    case "needsDecision": return ["intake", "discard"];
    case "working": return [];
    case "needsYou":
      if (note === NOTE.interrupted) return ["resume", "discard"];
      if (note === NOTE.ciFailed || note === NOTE.newComments || note === NOTE.ciFailedAndComments) return ["sendBack", "openRequest", "openDiff", "discard"];
      if (note === NOTE.closedUnmerged || note === NOTE.statusUnavailable) return ["openRequest", "discard"];
      return ["resume", "openDiff", "discard"];
    case "readyToShip": return ["openDiff", "ship", "discard"];
    case "shipped": return ["openRequest", "openDiff"];
    case "done": return ["openRequest", "discard"];
  }
}

/** One card per item, grouped by the column its facts derive. Insertion order is kept inside a column. */
export function buildBoard(items: readonly WorkItemRecord[], facts: ReadonlyMap<string, ItemFacts>, nowMs = Date.now()): Record<Column, CardView[]> {
  const board = Object.fromEntries(COLUMNS.map((c) => [c, [] as CardView[]])) as Record<Column, CardView[]>;
  for (const item of items) {
    const { column, note } = columnFor(facts.get(item.key) ?? EMPTY_FACTS);
    const f = facts.get(item.key) ?? EMPTY_FACTS;
    board[column].push({ key: item.key, title: item.title, source: item.source, note, actions: actionsFor(column, note), costUsd: f.lastRecord?.costUsd ?? null, durationSeconds: f.lastRecord?.durationSeconds ?? null, progressLabel: f.live?.progress ? progressLabel(f.live.progress, nowMs) : null, lastLine: f.live?.log.at(-1) ?? null });
  }
  return board;
}

/** The column each card had in this board (memory only: the board keeps it while the PR/MR status is unavailable). */
export function lastKnownFrom(board: Record<Column, CardView[]>): Map<string, Column> {
  const out = new Map<string, Column>();
  for (const column of COLUMNS) for (const card of board[column]) out.set(card.key, column);
  return out;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string => (typeof v === "string" ? v : "");

export interface WorktreeInfo { runId: string; project: string; repo: string; worktree: string; branch: string; baseCommit: string }

/** `loop_worktree_list` rows keyed by run id; a row without a valid run id or a worktree path is dropped. */
export function decodeWorktreeList(body: unknown): Map<string, WorktreeInfo> {
  const out = new Map<string, WorktreeInfo>();
  if (!Array.isArray(body)) return out;
  for (const row of body) {
    if (!isRecord(row)) continue;
    const runId = row.runId;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) continue;
    if (typeof row.worktree !== "string" || row.worktree === "") continue;
    out.set(runId, { runId, project: asString(row.project), repo: asString(row.repo), worktree: row.worktree, branch: asString(row.branch), baseCommit: asString(row.baseCommit) });
  }
  return out;
}

export interface FactsContext { projectRoot: string; live: readonly LiveRun[]; records: ReadonlyMap<string, RunRecordFacts>; worktrees: ReadonlyMap<string, unknown>; interrupted?: ReadonlySet<string>; ship: ReadonlyMap<string, ShipStatus | "error">; lastKnown: ReadonlyMap<string, Column> }

/** The facts of one card: its last run's record, its worktree, the PR/MR status and its last known column. */
export function assembleFacts(item: WorkItemRecord, ctx: FactsContext): ItemFacts {
  const runId = item.runIds.at(-1) ?? null;
  // Item keys repeat across projects (the same issue in two projects): a live run counts only in its own project.
  const live = ctx.live.find((r) => r.itemKey === item.key && r.projectRoot === ctx.projectRoot) ?? null;
  const lastRecord = runId ? ctx.records.get(runId) ?? null : null;
  const entry = lastRecord?.ship ? ctx.ship.get(lastRecord.ship.url) : undefined;
  return {
    live,
    lastRecord,
    worktreeExists: runId !== null && ctx.worktrees.has(runId),
    interrupted: runId !== null && ctx.interrupted?.has(runId) === true,
    ship: entry !== undefined && entry !== "error" ? entry : null,
    shipStatusError: entry === "error",
    lastKnownColumn: ctx.lastKnown.get(item.key) ?? null,
  };
}

/** One status request per shipped card, from when its run ended (or the item was added); duplicate URLs once. */
export function shipRequestsFor(items: readonly WorkItemRecord[], records: ReadonlyMap<string, RunRecordFacts>): { url: string; since: string }[] {
  const out: { url: string; since: string }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const runId = item.runIds.at(-1) ?? null;
    if (!runId) continue;
    const record = records.get(runId);
    if (!record?.ship || seen.has(record.ship.url)) continue;
    seen.add(record.ship.url);
    out.push({ url: record.ship.url, since: record.endedAt ?? item.addedAt });
  }
  return out;
}

/** The route takes at most SHIP_STATUS_BATCH requests per call (its `dispatch` bucket is small). */
export function chunkShipRequests<T>(list: readonly T[], size = SHIP_STATUS_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)));
  return out;
}

const SHIP_STATES: readonly string[] = ["open", "merged", "closed"];
const SHIP_CI: readonly string[] = ["none", "pending", "success", "failed"];

/** The route's per-request answers: a status per URL, or "error" for a refused or malformed one. */
export function decodeShipResults(body: unknown): Map<string, ShipStatus | "error"> {
  const out = new Map<string, ShipStatus | "error">();
  const rows = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.url !== "string") continue;
    const url = row.url;
    if (typeof row.error === "string" || typeof row.state !== "string" || !SHIP_STATES.includes(row.state) || typeof row.ci !== "string" || !SHIP_CI.includes(row.ci)) {
      out.set(url, "error");
      continue;
    }
    const comments: ShipStatus["comments"] = [];
    if (Array.isArray(row.comments)) {
      for (const c of row.comments) {
        if (!isRecord(c) || typeof c.author !== "string" || typeof c.body !== "string" || typeof c.at !== "string") continue;
        comments.push({ author: c.author.slice(0, 200), body: c.body.slice(0, 4000), at: c.at.slice(0, 40) });
        if (comments.length >= SHIP_STATUS_BATCH) break;
      }
    }
    out.set(url, {
      url,
      state: row.state as ShipStatus["state"],
      ci: row.ci as ShipStatus["ci"],
      ciSummary: typeof row.ciSummary === "string" ? row.ciSummary.slice(0, 4000) : null,
      comments,
    });
  }
  return out;
}

/** A PR/MR link is only opened when it is https on github.com or gitlab.com (Phase A ships to gitlab.com only). */
export function safeRequestUrl(url: string | null): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.host === "github.com" || u.host === "gitlab.com") ? url : null;
  } catch { return null; }
}

const INDEX_RE = /^index-\d{4}-\d{2}\.jsonl$/;
const MAX_INDEX_LINES = 2000;
/** The newest run record per factory run id, found through the month index lines that carry `factoryRunId` (written by the run manager). */
export async function latestRecords(fs: HistoryFs, runIds: ReadonlySet<string>): Promise<Map<string, RunRecordFacts>> {
  const out = new Map<string, RunRecordFacts>();
  if (runIds.size === 0) return out;
  let names: string[];
  try {
    names = (await fs.list("system/loop-runs")).entries.map((e) => e.name).filter((n) => INDEX_RE.test(n)).sort().reverse();
  } catch {
    return out;
  }
  const wanted = new Map<string, { id: string; startedAt: string }>();
  let scanned = 0;
  for (const name of names) {
    let text: string | null = null;
    try {
      const r = await fs.read(`system/loop-runs/${name}`, 2_000_000);
      text = r.status === "ok" ? r.text : null;
    } catch {
      text = null;
    }
    if (!text) continue;
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      if (++scanned > MAX_INDEX_LINES) break;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const runId = o.factoryRunId;
        if (typeof runId === "string" && runIds.has(runId) && !wanted.has(runId) && typeof o.id === "string" && typeof o.startedAt === "string") {
          wanted.set(runId, { id: o.id, startedAt: o.startedAt });
        }
      } catch {
        // a corrupt index line is skipped
      }
    }
    if (scanned > MAX_INDEX_LINES || wanted.size === runIds.size) break;
  }
  for (const [runId, e] of wanted) {
    const facts = decodeRunRecordFacts(await loadRunRecord(fs, e.id, e.startedAt), { id: e.id, startedAt: e.startedAt });
    if (facts && facts.runId === runId) out.set(runId, facts);
  }
  return out;
}

/** "2 runs live in other projects": the board shows only the open project's cards, never another project's. */
export function otherProjectsNote(live: readonly LiveRun[], projectRoot: string | null): string | null {
  const n = live.filter((r) => r.projectRoot !== projectRoot).length;
  return n === 0 ? null : `${n} run${n === 1 ? "" : "s"} live in other projects`;
}

/** Phase A's `WorkItem` view of a card, for the Ship panel (it takes the five work-item fields only). */
export function toWorkItem(item: WorkItemRecord): WorkItem {
  return { source: item.source, id: item.id, title: item.title, body: item.body, repo: item.repo };
}

/** Send back needs a readable PR/MR status that asks for work (failing CI or new comments) and the run's worktree. */
export function sendBackAllowed(facts: ItemFacts): boolean {
  const s = facts.ship;
  return facts.worktreeExists && !facts.shipStatusError && s !== null && (s.ci === "failed" || s.comments.length > 0);
}

/** Status of one worktree for clean-up (loop_worktree_status). */
export interface CleanupStatus { changedFiles: number; localCommits: number }
export interface CleanupPlan { remove: string[]; keep: { runId: string; reason: string }[] }

/**
 * Worktrees safe to remove: a merged PR/MR, or an orphan (no card) whose status says no unshipped changes.
 * A live run, an interrupted marker, a card's unshipped run and a missing status are always kept.
 */
export function cleanupPlan(
  items: readonly { runIds: readonly string[] }[],
  worktrees: ReadonlyMap<string, unknown>,
  live: readonly { runId: string }[],
  interrupted: ReadonlySet<string>,
  merged: ReadonlySet<string>,
  statuses: ReadonlyMap<string, CleanupStatus>,
): CleanupPlan {
  const referenced = new Set(items.flatMap((i) => i.runIds));
  const busy = new Set(live.map((r) => r.runId));
  const remove: string[] = [];
  const keep: { runId: string; reason: string }[] = [];
  for (const runId of worktrees.keys()) {
    if (busy.has(runId) || interrupted.has(runId)) { keep.push({ runId, reason: "a run is still active or was interrupted" }); continue; }
    if (merged.has(runId)) { remove.push(runId); continue; }
    const status = statuses.get(runId);
    if (!status) { keep.push({ runId, reason: "its status could not be read; use Discard" }); continue; }
    if (referenced.has(runId)) { keep.push({ runId, reason: "it belongs to a card waiting for Ship; use Discard" }); continue; }
    if (status.changedFiles > 0 || status.localCommits > 0) { keep.push({ runId, reason: "it has unshipped changes; use Discard" }); continue; }
    remove.push(runId);
  }
  return { remove, keep };
}

/** Human duration for a card: 45s, 5m, 1h 30m. */
export function formatDuration(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  if (n < 60) return `${n}s`;
  const minutes = Math.floor(n / 60);
  if (minutes < 60) return n % 60 === 0 ? `${minutes}m` : `${minutes}m ${n % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** One line for a live card: `Implement · 3 of 8 · iter 2 · repair 1 · 4m 12s`. */
export function progressLabel(
  p: { stageName: string | null; stageIndex: number; stageCount: number; iteration: number; repairs: number; startedAt: string | null },
  nowMs = Date.now(),
): string {
  const stage = p.stageName ? `${p.stageName} · ${p.stageIndex} of ${p.stageCount}` : p.iteration > 0 ? `Iteration ${p.iteration}` : "Starting";
  const parts = [stage];
  if (p.stageName && p.iteration > 0) parts.push(`iter ${p.iteration}`);
  if (p.repairs > 0) parts.push(`repair ${p.repairs}`);
  const started = p.startedAt ? Date.parse(p.startedAt) : NaN;
  if (Number.isFinite(started) && nowMs > started) parts.push(formatDuration((nowMs - started) / 1000));
  return parts.join(" · ");
}

export type StageState = "passed" | "failed" | "repaired" | "skipped" | "running";
export interface StageTimelineRow { name: string; state: StageState }

/** One row per stage a live run has touched, in first-seen order, from the typed current stage and the log markers. */
export function stageTimeline(live: { log: readonly string[]; progress?: { stageName: string | null } | null }): StageTimelineRow[] {
  const rows = new Map<string, StageState>();
  for (const line of live.log) {
    const started = /^\$ (.+)$/.exec(line);
    if (started) { if (!rows.has(started[1])) rows.set(started[1], "running"); continue; }
    const result = /^([✓✗]) (.+?): (passed|failed)$/.exec(line);
    if (result) { rows.set(result[2], result[1] === "✓" ? "passed" : "failed"); continue; }
    const repair = /^↻ repairing (.+?) \(/.exec(line);
    if (repair) { if (rows.get(repair[1]) !== "passed") rows.set(repair[1], "repaired"); continue; }
    const skipped = /^↷ (.+?): passed earlier in this run$/.exec(line);
    if (skipped) rows.set(skipped[1], "skipped");
  }
  const current = live.progress?.stageName;
  if (current && !rows.has(current)) rows.set(current, "running");
  return [...rows].map(([name, state]) => ({ name, state }));
}
