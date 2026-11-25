// Pure Factory board logic: grouping, card actions, fact assembly and decoders for host and core answers. No React,
// no host: the board's columns come from these facts every time it is read, and nothing here writes anything.
import { loadRunRecord, type HistoryFs } from "../loop/native/history.ts";
import type { WorkItem } from "../loop/native/factory.ts";
import type { LiveRun } from "../loop/native/run-manager.ts";
import type { StepReviewCounts } from "../loop/native/issue-trail.ts";
import { COLUMNS, COLUMN_LABELS, NOTE, columnFor, decodeRunRecordFacts, type Column, type ItemFacts, type LoopbackFacts, type RunRecordFacts, type ShipStatus } from "./columns.ts";
import type { WorkItemRecord } from "./items.ts";

export { factoryAnchor, focusKeyFromAnchor } from "./anchor.ts";

export const STATUS_REFRESH_MS = 5 * 60 * 1000;
export const SHIP_STATUS_BATCH = 20;
export type CardAction = "start" | "openDiff" | "ship" | "sendBack" | "discard" | "openRequest" | "resume" | "finishChecks" | "rerun" | "intake" | "answer" | "approve" | "requestChanges" | "retryRecord";
export interface CardView {
  key: string; title: string; source: WorkItemRecord["source"]; note: string | null; actions: CardAction[];
  /** The board lane the card sits in (a process step, or backlog / MR / done). */
  lane: string;
  /** The status the card is in (the old column's label), shown as a badge. */
  status: string;
  /** How far a live run is through its steps, 0..1; null when not running or not known. */
  progress?: number | null;
  costUsd?: number | null; durationSeconds?: number | null; progressLabel?: string | null; lastLine?: string | null;
  verdict?: string | null; changed?: { files: number; additions: number | null; deletions: number | null; truncated: boolean } | null;
  test?: { command: string | null; ok: boolean | null } | null; failingStage?: { name: string; error: string } | null;
  readiness?: string | null;
  /** Set only on a stopped looping run (note `Stopped, no MR opened`). */
  loopback?: LoopbackFacts | null;
  /** Why the run did not open its draft MR by itself. */
  notShipped?: string | null;
  /** The last run's step review verdicts; the key is absent when it has none. */
  stepReviews?: StepReviewCounts | null;
  shipOverride?: { rule: string; file: string | null; line: number | null } | null;
}
/** The headline of a stopped looping run's warning card. */
export function loopbackTitle(l: LoopbackFacts): string {
  if (l.reason === "tests") return `Tests still failing after ${l.rounds} rounds`;
  if (l.reason === "review") return `Review still requests changes after ${l.rounds} rounds`;
  if (l.reason === "baseline") return "The tests already fail before any change";
  return `Stopped at its limit in round ${l.rounds} of ${l.maxRounds}`;
}
export const ACTION_LABELS: Readonly<Record<CardAction, string>> = { start: "Start", openDiff: "Open diff", ship: "Ship", sendBack: "Send back", discard: "Discard", openRequest: "Open PR/MR", resume: "Resume", finishChecks: "Continue", rerun: "Run again from start", intake: "Run intake", answer: "Answer & continue", approve: "Approve", requestChanges: "Request changes", retryRecord: "Retry record" };
export const SOURCE_LABELS: Readonly<Record<WorkItemRecord["source"], string>> = { issue: "Issue", spec: "Spec", text: "Text" };
export const EMPTY_FACTS: ItemFacts = { live: null, lastRecord: null, worktreeExists: false, ship: null, shipStatusError: false, lastKnownColumn: null };

/** The actions a card in this column offers (the spec's table; `note` refines the needs-you cases). */
export function actionsFor(column: Column, note: string | null, process: { intake?: boolean } = {}): CardAction[] {
  // A process without an Intake step cannot run intake: the action is not offered (the run manager refuses it too).
  if (process.intake === false) return actionsFor(column, note).filter((a) => a !== "intake");
  switch (column) {
    case "inbox": return note === NOTE.intakeReady ? ["start", "discard"] : ["start", "intake", "discard"];
    case "needsDecision": return ["intake", "discard"];
    case "working": return [];
    case "needsYou":
      // Continue (finishChecks) tests and reviews the work already done instead of rerunning the whole Loop, or resumes
      // the run when it stopped before its work was written. Open diff shows what the interrupted run changed.
      // The record is being written; Resume, Continue and Run again would race that write.
      // Discard deletes the worktree of a finished run, so the read-only diff stays available.
      if (note === NOTE.recordPending) return ["openDiff", "discard"];
      if (note === NOTE.recordStuck) return ["retryRecord", "openDiff", "discard"];
      if (note === NOTE.interrupted) return ["finishChecks", "openDiff", "rerun", "discard"];
      if (note === NOTE.ciFailed || note === NOTE.newComments || note === NOTE.ciFailedAndComments) return ["sendBack", "openRequest", "openDiff", "discard"];
      if (note === NOTE.closedUnmerged || note === NOTE.statusUnavailable) return ["openRequest", "discard"];
      // A run held for a person's review is approved or sent back from the card.
      if (note === NOTE.awaitingReview) return ["approve", "requestChanges", "openDiff", "discard"];
      if (note === NOTE.stoppedNoMr) return ["openDiff", "rerun", "discard"];
      if (note === NOTE.notShipped) return ["rerun", "openDiff", "discard"];
      return ["resume", "openDiff", "discard"];
    case "readyToShip": return ["openDiff", "ship", "discard"];
    case "shipped": return ["openRequest", "openDiff"];
    case "done": return ["openRequest", "discard"];
  }
}

export const LANE_BACKLOG = "backlog";
export const LANE_DONE = "done";
/** Merged work leaves the board: Done holds finished work that is not merged yet. */
export const LANE_MERGED = "merged";
export const stepLane = (name: string): string => `step:${name}`;
const norm = (n: string) => n.trim().toLowerCase().replace(/\s+gate$/, "");

/** The step lane a stage name belongs to: an exact step, a gate of a step, else the stage's own (dynamic) lane. */
function stageLane(stage: string | null | undefined, steps: readonly string[]): string | null {
  if (!stage) return null;
  const hit = steps.find((s) => norm(s) === norm(stage));
  return stepLane(hit ?? stage.replace(/\s+gate$/i, ""));
}

/** Where a card sits on the process board: backlog, the step it is on or stopped at, the MR, or done. */
export function laneFor(column: Column, f: ItemFacts, steps: readonly string[]): string {
  const rec = f.lastRecord;
  // A live run shows its step first, also a send-back re-run of an item whose MR is already open.
  if (column === "working") return f.live?.state === "queued" ? LANE_BACKLOG : stageLane(f.live?.progress?.stageName, steps) ?? (steps[0] ? stepLane(steps[0]) : LANE_BACKLOG);
  // Interrupted (the app stopped mid-run, also a re-run after a ship): the step the run's marker last named, else
  // where its previous run ended.
  if (f.interrupted) return stageLane(f.interruptedStage ?? rec?.failingStage?.name ?? rec?.lastStage, steps) ?? LANE_BACKLOG;
  if (column === "done") return LANE_MERGED;
  // An MR closed without merge is not done: back to Backlog, where Discard frees the issue to start again.
  if (rec?.ship && f.ship?.state === "closed") return LANE_BACKLOG;
  // Finished, not merged: ready to ship, or an MR open (also when CI failed or a reviewer commented).
  // A run held for a person is finished work waiting on a decision, so it sits in Done, not at its last step.
  if (rec?.ship || column === "readyToShip" || (column === "needsYou" && rec?.statusCode === "awaiting_review" && !rec.autoShipBlocked)) return LANE_DONE;
  if (column === "inbox") return LANE_BACKLOG;
  // Stopped: the failing step, else the last one reached; an interrupted run with no record has none.
  return stageLane(rec?.failingStage?.name ?? rec?.lastStage, steps) ?? (rec && steps[0] ? stepLane(steps[0]) : LANE_BACKLOG);
}

export interface Lane { id: string; label: string; cards: CardView[] }
/** Cards a lane draws before "Show more" (the Backlog alone can hold 1,000 per provider). */
export const LANE_PAGE = 100;
/** The lanes as drawn: each cut to its cap (`shown[lane.id]`, default one page). Keyboard navigation walks these. */
export const visibleLanes = (lanes: readonly Lane[], shown: Readonly<Record<string, number>>): Lane[] =>
  lanes.map((l) => (l.cards.length > (shown[l.id] ?? LANE_PAGE) ? { ...l, cards: l.cards.slice(0, shown[l.id] ?? LANE_PAGE) } : l));
/**
 * The lanes in order: Backlog (stored items, then `openIssues`: open issues not on the board yet), each process step,
 * any step a card stopped at that the process no longer lists, and Done (finished, not merged). Merged cards are left out.
 */
export function buildLanes(board: Record<Column, CardView[]>, steps: readonly string[], openIssues: readonly CardView[] = []): Lane[] {
  const cards = COLUMNS.flatMap((c) => board[c]);
  const lanes: Lane[] = [{ id: LANE_BACKLOG, label: "Backlog", cards: [] }, ...steps.map((s) => ({ id: stepLane(s), label: s, cards: [] as CardView[] }))];
  const done: Lane = { id: LANE_DONE, label: "Done", cards: [] };
  const by = new Map<string, Lane>([...lanes, done].map((l) => [l.id, l]));
  for (const c of cards) {
    if (c.lane === LANE_MERGED) continue;
    let lane = by.get(c.lane);
    if (!lane) {
      lane = { id: c.lane, label: c.lane.startsWith("step:") ? c.lane.slice(5) : c.lane, cards: [] };
      by.set(c.lane, lane);
      lanes.push(lane);
    }
    lane.cards.push(c);
  }
  const onBoard = new Set(cards.map((c) => c.key));
  lanes[0].cards.push(...openIssues.filter((c) => !onBoard.has(c.key)));
  return [...lanes, done];
}

/** The step a run marker (`.factory/RUN.json`) names, or null for an older marker, bad JSON or a bad value. */
export function markerStage(text: string | null): string | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    const stage = isRecord(v) ? v.stage : null;
    return typeof stage === "string" && stage.trim() !== "" ? stage.slice(0, 120) : null;
  } catch {
    return null;
  }
}

export type CardTone = "run" | "alert" | "warn" | "ok" | "ghost" | "idle";
/** The colour family of a card, from its status. */
export function cardTone(status: string): CardTone {
  switch (status) {
    case "Working": return "run";
    case "Needs you": return "alert";
    case "Needs decision": return "warn";
    case "Ready to ship": case "Shipped": case "Done": return "ok";
    case "Open issue": return "ghost";
    default: return "idle";
  }
}

/** The board header's one-line summary, e.g. "12 in backlog · 2 running · 3 waiting to merge". */
export function boardSummary(lanes: readonly Lane[], running: number, doneLane: string = LANE_DONE): string {
  const backlog = lanes.find((l) => l.id === LANE_BACKLOG)?.cards.length ?? 0;
  const done = lanes.find((l) => l.id === doneLane)?.cards.length ?? 0;
  const attention = lanes.reduce((n, l) => n + l.cards.filter((c) => c.status === "Needs you" || c.status === "Needs decision").length, 0);
  const parts = [`${backlog} in backlog`, `${running} running`];
  if (attention > 0) parts.push(`${attention} need${attention === 1 ? "s" : ""} you`);
  parts.push(`${done} waiting to merge`);
  return parts.join(" · ");
}

/** An open issue not on the board yet, as a Backlog card whose only action is Start (it is stored when started). */
export function openIssueCard(item: Pick<WorkItemRecord, "key" | "title">): CardView {
  return { key: item.key, title: item.title, source: "issue", note: null, lane: LANE_BACKLOG, status: "Open issue", actions: ["start"] };
}

/** One card per item, grouped by the column its facts derive. Insertion order is kept inside a column. */
export function buildBoard(items: readonly WorkItemRecord[], facts: ReadonlyMap<string, ItemFacts>, nowMs = Date.now(), process: { intake?: boolean; steps?: readonly string[] | null } = {}): Record<Column, CardView[]> {
  const steps = process.steps ?? [];
  const board = Object.fromEntries(COLUMNS.map((c) => [c, [] as CardView[]])) as Record<Column, CardView[]>;
  for (const item of items) {
    const { column, note } = columnFor(facts.get(item.key) ?? EMPTY_FACTS);
    const f = facts.get(item.key) ?? EMPTY_FACTS;
    board[column].push({ key: item.key, title: item.title, source: item.source, note, lane: laneFor(column, f, steps), status: COLUMN_LABELS[column], progress: f.live?.progress && f.live.progress.stageCount > 0 ? Math.min(1, (f.live.progress.stageIndex + 1) / f.live.progress.stageCount) : null, actions: actionsFor(column, note, process), costUsd: f.lastRecord?.costUsd ?? null, durationSeconds: f.lastRecord?.durationSeconds ?? null, progressLabel: f.live?.progress ? progressLabel(f.live.progress, nowMs) : null, lastLine: f.live?.log.at(-1) ?? null, verdict: f.lastRecord?.verdict ?? null, changed: f.lastRecord?.changed ?? null, test: f.lastRecord?.test ?? null, failingStage: f.lastRecord?.failingStage ?? null, readiness: column === "needsDecision" ? f.lastRecord?.readiness ?? null : null, notShipped: note === NOTE.notShipped ? f.lastRecord?.autoShipBlocked ?? null : null, shipOverride: f.lastRecord?.ship?.secretOverride ?? null, ...(note === NOTE.stoppedNoMr ? { loopback: f.lastRecord?.loopback ?? null } : {}), ...(f.lastRecord?.stepReviews ? { stepReviews: f.lastRecord.stepReviews } : {}) });
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

export interface FactsContext { projectRoot: string; live: readonly LiveRun[]; records: ReadonlyMap<string, RunRecordFacts>; worktrees: ReadonlyMap<string, unknown>; interrupted?: ReadonlySet<string>; recordPending?: ReadonlySet<string>; recordStuck?: ReadonlySet<string>; interruptedStages?: ReadonlyMap<string, string>; ship: ReadonlyMap<string, ShipStatus | "error">; lastKnown: ReadonlyMap<string, Column> }

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
    recordPending: runId !== null && ctx.recordPending?.has(runId) === true,
    recordStuck: runId !== null && ctx.recordStuck?.has(runId) === true,
    interruptedStage: runId !== null ? ctx.interruptedStages?.get(runId) ?? null : null,
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
        comments.push({ author: c.author.slice(0, 200), body: c.body.slice(0, 4000), at: c.at.slice(0, 40), ...((c as { bot?: unknown }).bot === true ? { bot: true } : {}) });
        if (comments.length >= SHIP_STATUS_BATCH) break;
      }
    }
    const commits = decodeCommits(row.commits);
    out.set(url, {
      url,
      state: row.state as ShipStatus["state"],
      ci: row.ci as ShipStatus["ci"],
      ciSummary: typeof row.ciSummary === "string" ? row.ciSummary.slice(0, 4000) : null,
      comments,
      ...(commits ? { commits } : {}),
    });
  }
  return out;
}

const SHA40 = /^[0-9a-f]{40}$/;
const MAX_COMMITS_READ = 100;
const MAX_EXTRA_COMMITS = 50;

function decodeCommits(v: unknown): { sha: string }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { sha: string }[] = [];
  for (const c of v) {
    if (isRecord(c) && typeof c.sha === "string" && SHA40.test(c.sha)) out.push({ sha: c.sha });
    if (out.length >= MAX_COMMITS_READ) break;
  }
  return out;
}

/**
 * The commits on a run's MR that the loop did not push: every SHA listed after `ship.commit`. Null when there is
 * nothing foreign, when the commit list is unknown, or when `ship.commit` is not in the list (a force-push rewrote
 * history, so "after" means nothing). Capped at 50.
 */
export function foreignCommits(ownCommit: string | undefined, commits: readonly { sha: string }[] | undefined): string[] | null {
  if (!ownCommit || !commits) return null;
  const at = commits.findIndex((c) => c.sha === ownCommit);
  if (at < 0) return null;
  const extra = commits.slice(at + 1).map((c) => c.sha);
  return extra.length ? extra.slice(0, MAX_EXTRA_COMMITS) : null;
}

/**
 * The output_edited signals to post now: one per run whose MR gained foreign commits that were not posted yet.
 * `posted` (run id to the newest foreign SHA already posted; the caller keeps it in memory) is updated here, so a
 * 5-minute poll does not post the same set again, and a further push posts once more.
 */
export function outputEditedSignals(
  records: ReadonlyMap<string, RunRecordFacts>,
  ship: ReadonlyMap<string, ShipStatus | "error">,
  posted: Map<string, string>,
): { runId: string; payload: { extraCommits: string[] } }[] {
  const out: { runId: string; payload: { extraCommits: string[] } }[] = [];
  for (const [runId, rec] of records) {
    const status = rec.ship ? ship.get(rec.ship.url) : undefined;
    if (!rec.ship || !status || status === "error") continue;
    const extra = foreignCommits(rec.ship.commit, status.commits);
    if (!extra) continue;
    const newest = extra[extra.length - 1];
    if (posted.get(runId) === newest) continue;
    posted.set(runId, newest);
    out.push({ runId, payload: { extraCommits: extra } });
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
/** Automatic restarts per card before a person must act; a bot commenting on every MR must not loop the Factory. */
export const AUTO_REWORK_LIMIT = 3;

/**
 * Why a shipped card's MR restarts its run from the first step by itself: the person closed it without merging, or
 * commented on it. A CI failure keeps the Send back button, and nothing restarts past the limit or without a worktree.
 */
export function autoRework(facts: ItemFacts, reworksSoFar: number): "closed" | "comments" | null {
  const s = facts.ship;
  // An interrupted run (a rework stopped by closing the app) leaves the old MR record behind: never restart it unasked.
  if (!s || facts.live || facts.interrupted || facts.shipStatusError || !facts.worktreeExists || !facts.lastRecord?.ship || reworksSoFar >= AUTO_REWORK_LIMIT) return null;
  if (s.state === "closed") return "closed";
  if (s.state === "open" && s.comments.some((c) => !c.bot)) return "comments";
  return null;
}

export function sendBackAllowed(facts: ItemFacts): boolean {
  const s = facts.ship;
  return facts.worktreeExists && !facts.shipStatusError && s !== null && (s.ci === "failed" || s.comments.length > 0);
}

/** Status of one worktree for clean-up (loop_worktree_status). */
export interface CleanupStatus { changedFiles: number; localCommits: number }
export interface CleanupPlan { remove: string[]; keep: { runId: string; reason: string }[] }

/**
 * Worktrees safe to remove: a merged PR/MR, or an orphan (no card) whose status says no unshipped changes.
 * A live run, an interrupted marker, a card's unshipped run and a missing status are always kept. A worktree on a
 * `loop/<loop>` branch is never a candidate: it is its loop's one branch with its draft MR (commits beyond the base, or
 * a run in progress), so only that loop's own history discards it.
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
  for (const [runId, wt] of worktrees) {
    const branch = typeof (wt as { branch?: unknown } | null)?.branch === "string" ? (wt as { branch: string }).branch : "";
    if (branch.startsWith("loop/")) { keep.push({ runId, reason: "it is a loop's own branch with its draft MR; discard it from that loop's History" }); continue; }
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

/** One line for a live card: `Implement · 3 of 8 · round 2 of 3 · repair 1 · 4m 12s`. */
export function progressLabel(
  p: { stageName: string | null; stageIndex: number; stageCount: number; iteration: number; maxIterations?: number; repairs: number; startedAt: string | null; substate?: string | null },
  nowMs = Date.now(),
): string {
  // The sub-state sits between the step name and its position, so the card reads "Implement · reviewing · 3 of 8".
  const stage = p.stageName ? `${p.stageName}${p.substate ? ` · ${p.substate}` : ""} · ${p.stageIndex} of ${p.stageCount}` : p.iteration > 0 ? `Iteration ${p.iteration}` : "Starting";
  const parts = [stage];
  if (p.stageName && p.iteration > 0) parts.push(p.maxIterations ? `round ${p.iteration} of ${p.maxIterations}` : `iter ${p.iteration}`);
  if (p.repairs > 0) parts.push(`repair ${p.repairs}`);
  const started = p.startedAt ? Date.parse(p.startedAt) : NaN;
  if (Number.isFinite(started) && nowMs > started) parts.push(formatDuration((nowMs - started) / 1000));
  return parts.join(" · ");
}

export type StageState = "passed" | "failed" | "repaired" | "skipped" | "running";
export interface StageTimelineRow { id: string; name: string; state: StageState }

/** One row per stage a live run has touched, in first-seen order, from the typed current stage and the log markers. */
export function stageTimeline(live: { log: readonly string[]; progress?: { stageName: string | null; stages?: readonly { id: string; name: string; state: StageState }[] } | null }): StageTimelineRow[] {
  return (live.progress?.stages ?? []).map((r) => ({ id: r.id, name: r.name, state: r.state }));
}

/** The card key after `key` in lane order, or the first when key is null. */
export function nextCardKey(lanes: readonly Lane[], key: string | null, direction: "left" | "right" | "up" | "down"): string | null {
  const flat = lanes.flatMap((l, li) => l.cards.map((v) => ({ key: v.key, li })));
  if (flat.length === 0) return null;
  const current = key ? flat.find((x) => x.key === key) : null;
  if (!current) return flat[0].key;
  const row = lanes[current.li].cards.findIndex((v) => v.key === key);
  if (direction === "left" || direction === "right") {
    const step = direction === "right" ? 1 : -1;
    for (let i = current.li + step; i >= 0 && i < lanes.length; i += step) {
      const cards = lanes[i].cards;
      if (cards.length) return cards[Math.min(row, cards.length - 1)].key;
    }
    return current.key;
  }
  const cards = lanes[current.li].cards;
  return cards[Math.max(0, Math.min(cards.length - 1, row + (direction === "down" ? 1 : -1)))].key;
}
