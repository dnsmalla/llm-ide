// Read-only view of the Mac's Loop journal under `<root>/system/loop-runs/`. The index is append-only JSONL,
// month-rotated (`index-YYYY-MM.jsonl`) with the legacy `index.jsonl` read oldest. A missing journal is normal.
import type { FsApi } from "../../explorer/fs";

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
  const body = prior + JSON.stringify(entry) + "\n";
  await fs.write(idx, body, { expected_hash: hash });
}


/** Reads a run record from the month bucket its index entry names. Missing/corrupt records return null. */
export async function loadRunRecord(fs: Pick<FsApi, "read">, id: string, startedAt: string): Promise<Record<string, unknown> | null> {
  const d = new Date(startedAt);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  try {
    const r = await fs.read(`system/loop-runs/${month}/${id}.json`, 4_000_000);
    if (r.status !== "ok" || !r.text) return null;
    const v = JSON.parse(r.text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}
