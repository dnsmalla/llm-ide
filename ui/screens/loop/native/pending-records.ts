// Run records that ended while their project was closed, kept in localStorage so a quit before the project reopens
// does not lose them. Pure serialize/deserialize: no React, no host; run-manager.ts owns when they are written.
import type { LoopRunIndexEntry } from "./history.ts";
import { isRecord } from "../../../kit/src/decode.ts";

export const PENDING_KEY = "llmide.factory.pendingRecords";
/** A held record must not fill localStorage: stage output is the only unbounded part, and the worktree keeps the rest. */
const STDOUT_MAX = 4000;

export interface PendingRecord {
  projectRoot: string;
  entry: LoopRunIndexEntry;
  record: Record<string, unknown>;
  /** The readiness copy to make after the record is written (full / intake-only runs); null when none. */
  copy: { prefix: string; runId: string; endedAt: string } | null;
  /** The run marker to remove once the record is written. */
  marker: string;
  /** A run that threw has no record; only its marker still has to be removed once its project is open. */
  markerOnly?: boolean;
  /** How many times writing this record has failed, so a record that never succeeds is reported, not retried silently. */
  attempts?: number;
}

function valid(v: unknown): v is PendingRecord {
  if (!isRecord(v)) return false;
  if (typeof v.projectRoot !== "string" || v.projectRoot === "" || typeof v.marker !== "string") return false;
  if (!isRecord(v.entry) || typeof v.entry.id !== "string" || !isRecord(v.record)) return false;
  if (v.copy === null) return true;
  return isRecord(v.copy) && typeof v.copy.prefix === "string" && typeof v.copy.runId === "string" && typeof v.copy.endedAt === "string";
}

/** Tolerant: bad JSON, a non-array or storage that throws reads as no records; malformed entries are dropped. */
export function readPending(storage: Pick<Storage, "getItem"> | undefined): PendingRecord[] {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function truncated(p: PendingRecord): PendingRecord {
  const stages = p.record.stages;
  if (!Array.isArray(stages)) return p;
  const cut = stages.map((s: unknown) => {
    if (!isRecord(s) || !isRecord(s.run) || typeof s.run.stdout !== "string" || s.run.stdout.length <= STDOUT_MAX) return s;
    return { ...s, run: { ...s.run, stdout: s.run.stdout.slice(0, STDOUT_MAX) } };
  });
  return { ...p, record: { ...p.record, stages: cut } };
}

/** Never throws: a full or blocked storage keeps the in-memory path working. */
export function writePending(storage: Pick<Storage, "setItem"> | undefined, all: readonly PendingRecord[]): void {
  try { storage?.setItem(PENDING_KEY, JSON.stringify(all.map(truncated))); } catch { /* per-viewer convenience; memory still holds the record */ }
}
