// Read-only view of the Mac's Loop journal under `<root>/system/loop-runs/`. The index is append-only JSONL,
// month-rotated (`index-YYYY-MM.jsonl`) with the legacy `index.jsonl` read oldest. A missing journal is normal.
import type { FsApi } from "../../explorer/fs";
import type { LoopIterationOutcome } from "./runner.ts";
import { parseTestResults } from "./testmap.ts";

export interface LoopRunIndexEntry {
  id: string;
  loopId: string;
  loopName: string;
  startedAt: string;
  durationSeconds: number;
  iterationsUsed: number;
  statusCode: string;
  statusSummary: string;
  trigger: string;
}

export type HistoryFs = Pick<FsApi, "list" | "read">;
export type WriteHistoryFs = HistoryFs & Pick<FsApi, "create" | "write">;
const MAX = 50;

function decodeLine(line: string): LoopRunIndexEntry | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.startedAt !== "string") return null;
    return {
      id: o.id,
      loopId: typeof o.loopId === "string" ? o.loopId : "",
      loopName: typeof o.loopName === "string" ? o.loopName : "Loop",
      startedAt: o.startedAt,
      durationSeconds: typeof o.durationSeconds === "number" ? o.durationSeconds : 0,
      iterationsUsed: typeof o.iterationsUsed === "number" ? o.iterationsUsed : 0,
      statusCode: typeof o.statusCode === "string" ? o.statusCode : "",
      statusSummary: typeof o.statusSummary === "string" ? o.statusSummary : "",
      trigger: typeof o.trigger === "string" ? o.trigger : "manual",
    };
  } catch { return null; }
}

export async function readRecentRuns(fs: HistoryFs, limit = 20): Promise<LoopRunIndexEntry[]> {
  let names: string[];
  try {
    const listed = await fs.list("system/loop-runs");
    names = listed.entries.map((e) => e.name).filter((n) => n === "index.jsonl" || /^index-\d{4}-\d{2}\.jsonl$/.test(n));
  } catch { return []; }
  const rotated = names.filter((n) => n !== "index.jsonl").sort().reverse();
  const ordered = names.includes("index.jsonl") ? [...rotated, "index.jsonl"] : rotated;
  const out: LoopRunIndexEntry[] = [];
  for (const name of ordered) {
    try {
      const r = await fs.read(`system/loop-runs/${name}`, 2_000_000);
      if (r.status !== "ok" || !r.text) continue;
      for (const line of r.text.split(/\r?\n/).reverse()) {
        if (!line.trim()) continue;
        const e = decodeLine(line);
        if (e) out.push(e);
        if (out.length >= Math.min(limit, MAX)) return out;
      }
    } catch { /* unreadable index is skipped */ }
  }
  return out;
}


/** Appends one run record/index entry under `system/loop-runs/` (month-bucketed, like the Mac journal). */
/** The journal is newest-first in the UI but append-only on disk; keep the last 200 entries like the Mac. */
export const MAX_RUN_RECORDS = 200;

export async function appendRunRecord(fs: WriteHistoryFs, entry: LoopRunIndexEntry, record: Record<string, unknown>): Promise<void> {
  const d = new Date(entry.startedAt);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const dir = `system/loop-runs/${month}`;
  try { await fs.create(dir, "dir"); } catch (e) { if (typeof e === "object" && e !== null && (e as { code?: unknown }).code !== "exists") throw e; }
  await fs.write(`${dir}/${entry.id}.json`, JSON.stringify(record, null, 2) + "\n", { expected_hash: null });
  const idx = `system/loop-runs/index-${month}.jsonl`;
  let prior = "";
  let hash: string | null = null;
  try {
    const r = await fs.read(idx, 2_000_000);
    if (r.status === "ok" && r.text !== null) { prior = r.text; hash = r.hash; }
  } catch { /* new index */ }
  const lines = (prior + JSON.stringify(entry) + "\n").split("\n").filter((l) => l.trim() !== "");
  const body = lines.slice(-MAX_RUN_RECORDS).join("\n") + "\n";
  await fs.write(idx, body, { expected_hash: hash });
}


/** Project-relative path of a run record, the month bucket its index entry names. */
export function runRecordPath(id: string, startedAt: string): string {
  const d = new Date(startedAt);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `system/loop-runs/${month}/${id}.json`;
}

/** Reads a run record from the month bucket its index entry names. Missing/corrupt records return null. */
export async function loadRunRecord(fs: Pick<FsApi, "read">, id: string, startedAt: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fs.read(runRecordPath(id, startedAt), 4_000_000);
    if (r.status !== "ok" || !r.text) return null;
    const v = JSON.parse(r.text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** The Mac journal's trigger for a run: a scheduled loop is an unattended `autoTask` sweep, a Run press is `manual`. */
export function runTrigger(scheduled: boolean): "manual" | "autoTask" {
  return scheduled ? "autoTask" : "manual";
}

/**
 * The attempt's score (the Mac's `score`): the failing-test count the test runner's output reports. Null when the output
 * is not a recognised test report, so an unscored attempt is never shown as "0 failing".
 */
export function attemptScore(output: string): number | null {
  const parsed = parseTestResults(output);
  return parsed.failing.length + parsed.passing.length === 0 ? null : parsed.failing.length;
}

/** Iteration rows in the shape the run inspector reads: each iteration with its stages and any repair attempt. */
export function iterationRecords(iterations: readonly LoopIterationOutcome[]): Record<string, unknown>[] {
  return iterations.map((it) => ({
    index: it.index,
    stages: it.stages.map((o) => ({ stageName: o.stage.name, passed: o.ok, severity: o.stage.severity, output: o.output })),
    repair: it.repair ? { stageId: it.repair.stageId, attempt: it.repair.attempt, ok: it.repair.ok } : null,
  }));
}

/** `iterationRecords` plus each stage attempt's score (the Mac's per-attempt `score`); only shell stages are scored. */
export function iterationRecordsWithScores(iterations: readonly LoopIterationOutcome[]): Record<string, unknown>[] {
  return iterationRecords(iterations).map((row, i) => ({
    ...row,
    stages: iterations[i].stages.map((o, j) => ({
      ...((row.stages as Record<string, unknown>[])[j]),
      score: o.stage.kind === "shellCommand" ? attemptScore(o.output) : null,
    })),
  }));
}

/** Factory fields of a run record (spec A5). Null when the run had none (every non-Factory run). */
export interface FactoryRunFields {
  workItem: { source: "issue" | "spec" | "text"; id: string | null; title: string } | null;
  worktree: { runId: string; branch: string; baseCommit: string; repo: string } | null;
  ship: { provider: "github" | "gitlab"; url: string; commit: string; reused: boolean; secretOverride?: { rule: string; file: string | null; line: number | null; at: string; hits?: { rule: string; file: string | null; line: number }[]; total?: number } | null } | null;
  needsDecision: string | null;
  diffSummary: { files: string[]; truncated: boolean; patchId: string | null } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Tolerant read of the Factory fields: anything malformed reads as null, never as a wrong value. */
export function decodeFactoryFields(record: Record<string, unknown> | null): FactoryRunFields {
  const r = record ?? {};
  const w = isRecord(r.workItem) ? r.workItem : null;
  const src = w?.source;
  const source = src === "issue" || src === "spec" || src === "text" ? src : null;
  const workItem: FactoryRunFields["workItem"] = w && source && typeof w.title === "string" ? { source, id: typeof w.id === "string" ? w.id : null, title: w.title } : null;
  const t = isRecord(r.worktree) ? r.worktree : null;
  const worktree = t && typeof t.runId === "string" && typeof t.branch === "string" && typeof t.baseCommit === "string" && typeof t.repo === "string"
    ? { runId: t.runId, branch: t.branch, baseCommit: t.baseCommit, repo: t.repo } : null;
  const s = isRecord(r.ship) ? r.ship : null;
  const provider = s?.provider;
  const so = s && isRecord(s.secretOverride) && typeof s.secretOverride.rule === "string" ? { rule: s.secretOverride.rule, file: typeof s.secretOverride.file === "string" ? s.secretOverride.file : null, line: typeof s.secretOverride.line === "number" ? s.secretOverride.line : null, at: typeof s.secretOverride.at === "string" ? s.secretOverride.at : "", ...(Array.isArray(s.secretOverride.hits) ? { hits: s.secretOverride.hits.filter((h): h is { rule: string; file: string | null; line: number } => typeof h === "object" && h !== null && typeof (h as { rule?: unknown }).rule === "string"), total: typeof s.secretOverride.total === "number" ? s.secretOverride.total : undefined } : {}) } : null;
  const ship: FactoryRunFields["ship"] = s && (provider === "github" || provider === "gitlab") && typeof s.url === "string" && typeof s.commit === "string"
    ? { provider, url: s.url, commit: s.commit, reused: s.reused === true, ...(so ? { secretOverride: so } : {}) } : null;
  const d = isRecord(r.diffSummary) ? r.diffSummary : null;
  const diffSummary = d && Array.isArray(d.files)
    ? { files: d.files.filter((f): f is string => typeof f === "string"), truncated: d.truncated === true, patchId: typeof d.patchId === "string" && /^[0-9a-f]{64}$/.test(d.patchId) ? d.patchId : null }
    : null;
  return { workItem, worktree, ship, needsDecision: typeof r.needsDecision === "string" ? r.needsDecision : null, diffSummary };
}

/** Merges `fields` into an existing run record. False when the record is missing or unreadable (nothing is created). */
async function setRunRecordFields(fs: Pick<FsApi, "read" | "write">, entry: Pick<LoopRunIndexEntry, "id" | "startedAt">, fields: Record<string, unknown>): Promise<boolean> {
  const path = runRecordPath(entry.id, entry.startedAt);
  let text: string;
  let hash: string;
  try {
    const r = await fs.read(path, 4_000_000);
    if (r.status !== "ok" || r.text === null || r.hash === null) return false;
    text = r.text;
    hash = r.hash;
  } catch { return false; }
  let record: unknown;
  try { record = JSON.parse(text); } catch { return false; }
  if (!isRecord(record)) return false;
  // Compare-and-set on the hash just read: a concurrent edit makes the write fail instead of being overwritten.
  await fs.write(path, JSON.stringify({ ...record, ...fields }, null, 2) + "\n", { expected_hash: hash });
  return true;
}

/** Records a Ship result on an existing run record. False when the record is missing or unreadable (nothing is created). */
export function setRunRecordShip(fs: Pick<FsApi, "read" | "write">, entry: Pick<LoopRunIndexEntry, "id" | "startedAt">, ship: NonNullable<FactoryRunFields["ship"]>): Promise<boolean> {
  return setRunRecordFields(fs, entry, { ship });
}

/** Records why a finished Factory run did not open its draft MR by itself, so its card can say so. */
export function setRunRecordAutoShip(fs: Pick<FsApi, "read" | "write">, entry: Pick<LoopRunIndexEntry, "id" | "startedAt">, blocked: string, at: Date): Promise<boolean> {
  return setRunRecordFields(fs, entry, { autoShip: { blocked: blocked.slice(0, 300), at: at.toISOString() } });
}
