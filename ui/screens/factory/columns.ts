// Board columns, derived from stored facts every time the board is read. A column is never written anywhere.
import type { LiveRun, RunMode } from "../loop/native/run-manager.ts";

export type Column = "inbox" | "needsDecision" | "working" | "needsYou" | "readyToShip" | "shipped" | "done";

export interface ShipComment { author: string; body: string; at: string }
export interface ShipStatus { url: string; state: "open" | "merged" | "closed"; ci: "none" | "pending" | "success" | "failed"; ciSummary: string | null; comments: ShipComment[] }
/** The factory fields of one run record, as `decodeRunRecordFacts` reads them. */
export interface RunRecordFacts { runId: string; mode: RunMode; statusCode: string; needsDecision: string | null; ship: { provider: "github" | "gitlab"; url: string } | null; reviewedPatchId: string | null; endedAt: string | null; entry: { id: string; startedAt: string } | null }

export interface ItemFacts { live: LiveRun | null; lastRecord: RunRecordFacts | null; worktreeExists: boolean; ship: ShipStatus | null; shipStatusError: boolean; lastKnownColumn: Column | null }

export const COLUMNS: readonly Column[] = ["inbox", "needsDecision", "working", "needsYou", "readyToShip", "shipped", "done"];
export const COLUMN_LABELS: Readonly<Record<Column, string>> = { inbox: "Inbox", needsDecision: "Needs decision", working: "Working", needsYou: "Needs you", readyToShip: "Ready to ship", shipped: "Shipped", done: "Done" };
export const NOTE = {
  queued: "Queued", paused: "Paused", interrupted: "Interrupted", intakeReady: "Intake ready",
  statusUnavailable: "status unavailable", ciFailed: "CI failed", newComments: "New review comments",
  ciFailedAndComments: "CI failed, new review comments", closedUnmerged: "Closed without merge", ciRunning: "CI running",
  failed: "Failed", stopped: "Stopped", error: "Error", blocked: "Blocked",
} as const;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_MODES: readonly string[] = ["full", "intakeOnly", "continue", "sendBack"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try { return new URL(v).protocol === "https:" ? v : null; } catch { return null; }
}

/** The factory fields of one Loop run record (Phase A Task 12 + Task 2's `factoryMode`), or null for a non-factory record. */
export function decodeRunRecordFacts(raw: unknown, entry: { id: string; startedAt: string } | null = null): RunRecordFacts | null {
  if (!isRecord(raw) || !isRecord(raw.worktree)) return null;
  const runId = raw.worktree.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return null;
  let ship: RunRecordFacts["ship"] = null;
  if (isRecord(raw.ship)) {
    const provider = raw.ship.provider;
    const url = httpsUrl(raw.ship.url);
    if ((provider === "github" || provider === "gitlab") && url) ship = { provider, url };
  }
  const mode = typeof raw.factoryMode === "string" && RUN_MODES.includes(raw.factoryMode) ? (raw.factoryMode as RunMode) : "full";
  const d = isRecord(raw.diffSummary) ? raw.diffSummary : null;
  const reviewedPatchId = typeof d?.patchId === "string" && /^[0-9a-f]{64}$/.test(d.patchId) ? d.patchId : null;
  return {
    runId,
    mode,
    statusCode: typeof raw.statusCode === "string" ? raw.statusCode : "",
    needsDecision: typeof raw.needsDecision === "string" && raw.needsDecision.trim() !== "" ? raw.needsDecision.slice(0, 500) : null,
    ship,
    reviewedPatchId,
    endedAt: typeof raw.endedAt === "string" ? raw.endedAt : null,
    entry,
  };
}

function finishedNote(statusCode: string): string {
  if (statusCode === "aborted") return NOTE.stopped;
  if (statusCode === "error") return NOTE.error;
  if (statusCode.startsWith("blocked")) return NOTE.blocked;
  return NOTE.failed;
}

// NOTE: a run interrupted while an older record of the SAME run id exists (a send-back after a ship) is shown by that
// older record: the run manager writes no in-progress marker, so the journal's last finished record still decides.
/** The spec's column table. Order matters: live run, then no record, then the PR/MR, then the run result. */
export function columnFor(f: ItemFacts): { column: Column; note: string | null } {
  if (f.live) return { column: "working", note: f.live.state === "queued" ? NOTE.queued : f.live.state === "paused" ? NOTE.paused : null };
  const rec = f.lastRecord;
  // No finished record: a worktree left behind means the app stopped mid-run. It is never auto-deleted.
  if (!rec) return f.worktreeExists ? { column: "needsYou", note: NOTE.interrupted } : { column: "inbox", note: null };
  if (rec.ship) {
    // Unreachable provider or expired token: keep the last known column, never fall back to Inbox or Ready to ship.
    if (f.shipStatusError) return { column: f.lastKnownColumn ?? "shipped", note: NOTE.statusUnavailable };
    const s = f.ship;
    if (!s) return { column: f.lastKnownColumn ?? "shipped", note: null };
    if (s.state === "merged") return { column: "done", note: null };
    if (s.state === "closed") return { column: "needsYou", note: NOTE.closedUnmerged };
    const ciFailed = s.ci === "failed";
    const hasComments = s.comments.length > 0;
    if (ciFailed && hasComments) return { column: "needsYou", note: NOTE.ciFailedAndComments };
    if (ciFailed) return { column: "needsYou", note: NOTE.ciFailed };
    if (hasComments) return { column: "needsYou", note: NOTE.newComments };
    return { column: "shipped", note: s.ci === "pending" ? NOTE.ciRunning : null };
  }
  if (rec.needsDecision !== null) return { column: "needsDecision", note: null };
  if (rec.statusCode === "success") return rec.mode === "intakeOnly" ? { column: "inbox", note: NOTE.intakeReady } : { column: "readyToShip", note: null };
  return { column: "needsYou", note: finishedNote(rec.statusCode) };
}
