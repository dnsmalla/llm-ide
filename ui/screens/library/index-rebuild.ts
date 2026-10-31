// User-initiated rebuild of the core's derived note index (kb/note-index.mjs) from the notes folder.
// The index is rebuildable and holds no unique data: this reads the files, asks the core which notes
// it is missing or holds stale (chunked `POST /kb/index/scan`), and uploads only those
// (`POST /kb/index/notes`). It NEVER prunes: nothing is deleted from the index in this slice.
//
// Shape mirrors the Mac's NoteIndexReconciler (same limits, same upsert body, contentHash = SHA-256
// of the file bytes), so the two apps agree on what a note looks like. Only meeting notes are
// indexable (the server accepts kind 'meeting' only); other notes are skipped and counted.
//
// Memory is bounded: phase 1 keeps only `{ noteKey, contentHash }` per note (50,000 notes is a few MB),
// phase 3 re-reads just the missing/stale notes and drops each batch after sending it. Cancellable
// between every file and every request.

import { fmDateMs, fmInt, fmList, fmString, parseNote } from "./frontmatter.ts";
import type { NotesHost } from "./host.ts";
import type { NoteRecord } from "./notes-model.ts";

export const SCAN_CHUNK_ENTRIES = 500;
export const SCAN_CHUNKS_MAX = 100;
export const BATCH_NOTES = 50;
export const BATCH_BYTES = 900_000;
export const BODY_BYTES = 512 * 1024;
const READ_CHUNK = 256 * 1024;
const FILE_CONCURRENCY = 4;

export interface IndexCore {
  request(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

export type RebuildPhase = "idle" | "reading" | "scanning" | "uploading" | "done" | "error" | "cancelled";

export interface RebuildProgress {
  phase: RebuildPhase;
  /** Meeting notes found to index. */
  total: number;
  /** Files read and hashed so far. */
  hashed: number;
  chunksDone: number;
  chunksTotal: number;
  missing: number;
  stale: number;
  uploaded: number;
  /** Not indexable: not a meeting note, too large, no usable frontmatter, unreadable, in iCloud. */
  skipped: number;
  error: "unavailable" | "unauthorized" | "too_many" | "failed" | null;
}

export const IDLE_REBUILD: RebuildProgress = { phase: "idle", total: 0, hashed: 0, chunksDone: 0, chunksTotal: 0, missing: 0, stale: 0, uploaded: 0, skipped: 0, error: null };

export interface RebuildDeps {
  host: NotesHost;
  core: IndexCore;
  sha256Hex?: (bytes: Uint8Array) => Promise<string>;
  newScanId?: () => string;
  /** Optional project scope for the index rows ("" = none). */
  projectId?: string;
}

export async function sha256HexWebCrypto(bytes: Uint8Array): Promise<string> {
  const buf = new Uint8Array(bytes).buffer; // detach from any larger backing buffer
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

function randomScanId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `scan-${[...a].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Which records the index can hold: meeting notes with frontmatter, readable and not in iCloud. */
export function indexable(records: readonly NoteRecord[]): { keep: NoteRecord[]; skipped: number } {
  const keep: NoteRecord[] = [];
  for (const r of records) {
    if (r.sourceId === "meeting" && r.area !== "llm-doc" && !r.placeholder && r.hasFrontmatter && /\.md$/i.test(r.name) && r.size <= BODY_BYTES) keep.push(r);
  }
  return { keep, skipped: records.length - keep.length };
}

/** Whole file text through bounded host reads; null when it cannot be read or changed size mid-read. */
export async function readWhole(host: NotesHost, rel: string, signal: AbortSignal): Promise<string | null> {
  let text = "";
  let offset = 0;
  for (let i = 0; i < 64; i++) {
    if (signal.aborted) return null;
    let c;
    try {
      c = await host.read(rel, offset, READ_CHUNK);
    } catch {
      return null;
    }
    text += c.text;
    if (c.nextOffset === null) return text;
    offset = c.nextOffset;
  }
  return null;
}

export interface IndexNoteInput {
  noteKey: string;
  kind: "meeting";
  title: string;
  date: string;
  durationSec: number;
  participants: string[];
  body: string;
  contentHash: string;
  mtimeMs: number;
  meta: { meetingId: string; platform: string; language: string };
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** The upsert body for one note read now; null when it has no usable meeting frontmatter or is too large. */
export function makeUpsertInput(rel: string, text: string, contentHash: string, mtimeMs: number): IndexNoteInput | null {
  if (new TextEncoder().encode(text).length > BODY_BYTES) return null;
  const parsed = parseNote(text);
  if (!parsed.hasFrontmatter) return null;
  const d = parsed.data;
  const title = fmString(d, "title");
  const started = fmDateMs(d, "started_at");
  if (title === null || started === null) return null;
  return {
    noteKey: rel,
    kind: "meeting",
    title: clip(title, 500),
    date: clip(new Date(started).toISOString(), 64),
    durationSec: Math.max(0, fmInt(d, "duration_seconds") ?? 0),
    participants: fmList(d, "participants").slice(0, 200).map((p) => clip(p, 200)),
    body: parsed.body,
    contentHash,
    mtimeMs: Math.max(0, Math.trunc(mtimeMs)),
    meta: { meetingId: clip(fmString(d, "id") ?? "", 1000), platform: clip(fmString(d, "platform") ?? "", 1000), language: clip(fmString(d, "language") ?? "", 1000) },
  };
}

/** Splits upserts into requests of at most BATCH_NOTES notes and BATCH_BYTES of JSON; oversize ones are dropped (counted). */
export function batchUpserts(inputs: readonly IndexNoteInput[]): { batches: IndexNoteInput[][]; dropped: number } {
  const batches: IndexNoteInput[][] = [];
  let cur: IndexNoteInput[] = [];
  let bytes = 0;
  let dropped = 0;
  const enc = new TextEncoder();
  for (const n of inputs) {
    const size = enc.encode(JSON.stringify(n)).length;
    if (size > BATCH_BYTES) {
      dropped += 1;
      continue;
    }
    if (cur.length > 0 && (cur.length >= BATCH_NOTES || bytes + size > BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(n);
    bytes += size;
  }
  if (cur.length > 0) batches.push(cur);
  return { batches, dropped };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

type Reporter = (p: RebuildProgress) => void;

/**
 * Runs one rebuild. Resolves with the final progress (phase done / error / cancelled); never throws.
 * `records` is the current listing (the store's records).
 */
export async function rebuildIndex(records: readonly NoteRecord[], deps: RebuildDeps, report: Reporter, signal: AbortSignal): Promise<RebuildProgress> {
  const sha = deps.sha256Hex ?? sha256HexWebCrypto;
  const projectId = deps.projectId ?? "";
  const { keep, skipped } = indexable(records);
  let p: RebuildProgress = { ...IDLE_REBUILD, phase: "reading", total: keep.length, skipped };
  const emit = (patch: Partial<RebuildProgress>): void => {
    p = { ...p, ...patch };
    report(p);
  };
  const finish = (patch: Partial<RebuildProgress>): RebuildProgress => {
    emit(patch);
    return p;
  };
  const cancelled = (): boolean => signal.aborted;
  emit({});

  if (keep.length > SCAN_CHUNK_ENTRIES * SCAN_CHUNKS_MAX) return finish({ phase: "error", error: "too_many" });

  // Phase 1: read and hash every indexable note (bounded concurrency).
  const hashes = new Map<string, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!cancelled()) {
      const r = keep[next++];
      if (!r) return;
      const text = await readWhole(deps.host, r.rel, signal);
      if (text === null || text.includes("�")) {
        emit({ skipped: p.skipped + 1, hashed: p.hashed + 1 }); // unreadable or not valid UTF-8: a hash of the text would not match the bytes
        continue;
      }
      hashes.set(r.rel, await sha(new TextEncoder().encode(text)));
      emit({ hashed: p.hashed + 1 });
    }
  };
  await Promise.all(Array.from({ length: FILE_CONCURRENCY }, worker));
  if (cancelled()) return finish({ phase: "cancelled" });

  // Phase 2: chunked scan (never prune).
  const manifest = [...hashes.entries()].map(([noteKey, contentHash]) => ({ noteKey, contentHash }));
  const parts: { noteKey: string; contentHash: string }[][] = [];
  for (let i = 0; i < manifest.length; i += SCAN_CHUNK_ENTRIES) parts.push(manifest.slice(i, i + SCAN_CHUNK_ENTRIES));
  if (parts.length === 0) parts.push([]);
  emit({ phase: "scanning", chunksTotal: parts.length, chunksDone: 0 });
  const scanId = (deps.newScanId ?? randomScanId)();
  const need: string[] = [];
  let missing = 0;
  let stale = 0;
  for (let i = 0; i < parts.length; i++) {
    if (cancelled()) return finish({ phase: "cancelled" });
    const last = i === parts.length - 1;
    const body: Record<string, unknown> = { scanId, index: i, total: parts.length, entries: parts[i], complete: last, prune: false };
    if (projectId !== "") body.projectId = projectId;
    if (last) body.totalEntries = manifest.length;
    let res;
    try {
      res = await deps.core.request("POST", "/kb/index/scan", body, signal);
    } catch {
      return cancelled() ? finish({ phase: "cancelled" }) : finish({ phase: "error", error: "failed" });
    }
    if (res.status === 404) return finish({ phase: "error", error: "unavailable" });
    if (res.status === 401 || res.status === 403) return finish({ phase: "error", error: "unauthorized" });
    if (res.status < 200 || res.status >= 300 || !isRecord(res.body)) return finish({ phase: "error", error: "failed" });
    const m = strings(res.body.missing);
    const s = strings(res.body.stale);
    need.push(...m, ...s);
    missing += m.length;
    stale += s.length;
    emit({ chunksDone: i + 1, missing, stale });
  }

  // Phase 3: upload what the core lacks, re-reading each file and checking it did not change since hashing.
  emit({ phase: "uploading", uploaded: 0 });
  const byRel = new Map(keep.map((r) => [r.rel, r]));
  const batch: IndexNoteInput[] = [];
  let uploaded = 0;
  let skippedNow = p.skipped;
  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const { batches, dropped } = batchUpserts(batch.splice(0));
    skippedNow += dropped;
    for (const b of batches) {
      if (cancelled()) return false;
      const payload: Record<string, unknown> = { notes: b };
      if (projectId !== "") payload.projectId = projectId;
      let res;
      try {
        res = await deps.core.request("POST", "/kb/index/notes", payload, signal);
      } catch {
        return false;
      }
      if (res.status < 200 || res.status >= 300) return false;
      uploaded += b.length;
      emit({ uploaded, skipped: skippedNow });
    }
    return true;
  };
  let failed = false;
  for (const rel of need) {
    if (cancelled()) return finish({ phase: "cancelled" });
    const rec = byRel.get(rel);
    const expect = hashes.get(rel);
    if (!rec || !expect) continue;
    const text = await readWhole(deps.host, rel, signal);
    const input = text !== null && (await sha(new TextEncoder().encode(text))) === expect ? makeUpsertInput(rel, text, expect, rec.mtimeMs) : null;
    if (input === null) {
      skippedNow += 1; // changed since it was hashed, or no usable frontmatter: the next rebuild picks it up
      continue;
    }
    batch.push(input);
    if (batch.length >= BATCH_NOTES && !(await flush())) {
      failed = true;
      break;
    }
  }
  if (!failed && !(await flush())) failed = true;
  if (cancelled()) return finish({ phase: "cancelled" });
  if (failed) return finish({ phase: "error", error: "failed", uploaded, skipped: skippedNow });
  return finish({ phase: "done", uploaded, skipped: skippedNow });
}

export function rebuildMessage(p: RebuildProgress): string {
  switch (p.phase) {
    case "reading":
      return `Reading notes ${p.hashed} of ${p.total}`;
    case "scanning":
      return `Comparing with the index, chunk ${p.chunksDone} of ${p.chunksTotal}`;
    case "uploading":
      return `Uploading ${p.uploaded} of ${p.missing + p.stale}`;
    case "done":
      return p.uploaded === 0 ? "The index is up to date." : `Index rebuilt: ${p.uploaded} notes uploaded.`;
    case "cancelled":
      return "Rebuild cancelled. Nothing was removed from the index.";
    case "error":
      switch (p.error) {
        case "unavailable":
          return "This core has no note index routes.";
        case "unauthorized":
          return "Sign in again to rebuild the index.";
        case "too_many":
          return "More than 50,000 meeting notes: the index cannot take them in one scan.";
        default:
          return "The rebuild failed. The index was not changed beyond what was uploaded; run it again.";
      }
    default:
      return "";
  }
}
