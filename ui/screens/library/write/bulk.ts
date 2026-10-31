// Bulk operations on many notes: chunked, progress-reporting and cancellable between chunks/items, so
// "select 1,000 notes, delete or tag" never freezes the page, never sends one huge request and can be
// stopped. Cancelling leaves the work already done in place (nothing is rolled back; moved-to-Trash
// notes can be restored from the Trash) and reports exactly how far it got.

import { addTags, removeTags } from "./frontmatter-edit.ts";
import { BULK_HOST_MAX, toWriteError, WriteError, type SavedNote, type WriteErrorCode, type WriteHost } from "./write-host.ts";

export const DELETE_CHUNK = 100;
export const TAG_CONCURRENCY = 4;
/** Failures kept in the progress report (the count keeps going). */
export const MAX_REPORTED_ERRORS = 50;
/** A bulk delete of more than one note asks for the typed phrase. */
export const TYPED_CONFIRM_FROM = 2;

export type BulkPhase = "idle" | "running" | "done" | "cancelled";

export interface BulkProgress {
  phase: BulkPhase;
  total: number;
  /** Items finished, successfully or not. */
  done: number;
  ok: number;
  /** Items that needed nothing (tag already there). */
  skipped: number;
  failed: number;
  errors: { rel: string; code: WriteErrorCode }[];
}

export const IDLE_BULK: BulkProgress = { phase: "idle", total: 0, done: 0, ok: 0, skipped: 0, failed: 0, errors: [] };

function start(total: number): BulkProgress {
  return { ...IDLE_BULK, errors: [], phase: "running", total };
}

function fail(p: BulkProgress, rel: string, code: WriteErrorCode): void {
  p.failed += 1;
  p.done += 1;
  if (p.errors.length < MAX_REPORTED_ERRORS) p.errors.push({ rel, code });
}

function finish(p: BulkProgress, signal: AbortSignal): BulkProgress {
  return { ...p, errors: p.errors.slice(), phase: signal.aborted && p.done < p.total ? "cancelled" : "done" };
}

/** The phrase the user must type to confirm deleting `n` notes. */
export function deletePhrase(n: number): string {
  return `delete ${n} notes`;
}

export function confirmMatches(input: string, n: number): boolean {
  return input.trim().toLowerCase() === deletePhrase(n);
}

export function needsTypedConfirm(n: number): boolean {
  return n >= TYPED_CONFIRM_FROM;
}

/** What the delete dialog lists: the first names, then a count of the rest. */
export function previewNames(rels: readonly string[], max = 8): { shown: string[]; more: number } {
  return { shown: rels.slice(0, max), more: Math.max(0, rels.length - max) };
}

export interface BulkDeleteDeps {
  host: WriteHost;
  signal: AbortSignal;
  onProgress: (p: BulkProgress) => void;
  /** Called with each chunk's successfully trashed paths (the screen updates its list from this). */
  onDeleted: (rels: string[]) => void;
  chunk?: number;
}

/** Moves notes to the Trash in chunks. Never permanent; one failure does not stop the rest. */
export async function bulkDelete(rels: readonly string[], deps: BulkDeleteDeps): Promise<BulkProgress> {
  const chunk = Math.max(1, Math.min(deps.chunk ?? DELETE_CHUNK, BULK_HOST_MAX));
  const unique = [...new Set(rels)];
  const p = start(unique.length);
  deps.onProgress({ ...p });
  for (let i = 0; i < unique.length && !deps.signal.aborted; i += chunk) {
    const part = unique.slice(i, i + chunk);
    let outcomes;
    try {
      outcomes = await deps.host.deleteMany(part);
    } catch (e) {
      const code = toWriteError(e).code;
      for (const rel of part) fail(p, rel, code);
      deps.onProgress({ ...p, errors: p.errors.slice() });
      continue;
    }
    const byRel = new Map(outcomes.map((o) => [o.rel, o]));
    const gone: string[] = [];
    for (const rel of part) {
      const o = byRel.get(rel);
      if (o?.ok) {
        p.ok += 1;
        p.done += 1;
        gone.push(rel);
      } else fail(p, rel, o?.error ?? "io");
    }
    if (gone.length) deps.onDeleted(gone);
    deps.onProgress({ ...p, errors: p.errors.slice() });
  }
  const out = finish(p, deps.signal);
  deps.onProgress(out);
  return out;
}

export interface BulkTagDeps {
  host: WriteHost;
  signal: AbortSignal;
  onProgress: (p: BulkProgress) => void;
  /** Called with each saved note and its new text (the list reads its head from it). */
  onSaved: (saved: SavedNote, text: string) => void;
  concurrency?: number;
}

/** Adds or removes tags on many notes: read, edit the header surgically, save with compare-and-swap. */
export async function bulkTag(rels: readonly string[], tags: readonly string[], mode: "add" | "remove", deps: BulkTagDeps): Promise<BulkProgress> {
  const unique = [...new Set(rels)];
  const p = start(unique.length);
  deps.onProgress({ ...p });
  let next = 0;
  const one = async (rel: string): Promise<void> => {
    // One retry: if the note changed between our read and our save, redo the (idempotent) edit on the fresh text.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const o = await deps.host.open(rel);
        const edited = mode === "add" ? addTags(o.text, tags) : removeTags(o.text, tags);
        if (edited === o.text) {
          p.skipped += 1;
          p.done += 1;
          return;
        }
        const saved = await deps.host.save(rel, edited, o.bom, o.hash);
        deps.onSaved(saved, edited);
        p.ok += 1;
        p.done += 1;
        return;
      } catch (e) {
        const err = e instanceof WriteError ? e : toWriteError(e);
        if (err.code === "conflict" && attempt === 0) continue;
        fail(p, rel, err.code);
        return;
      }
    }
  };
  const worker = async (): Promise<void> => {
    while (!deps.signal.aborted) {
      const i = next++;
      if (i >= unique.length) return;
      await one(unique[i]!);
      deps.onProgress({ ...p, errors: p.errors.slice() });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? TAG_CONCURRENCY, 8)) }, worker));
  const out = finish(p, deps.signal);
  deps.onProgress(out);
  return out;
}

export function bulkMessage(p: BulkProgress, verb: string): string {
  const n = (x: number): string => x.toLocaleString();
  if (p.phase === "running") return `${verb} ${n(p.done)} of ${n(p.total)}…`;
  const base = `${n(p.ok)} done${p.skipped ? `, ${n(p.skipped)} unchanged` : ""}${p.failed ? `, ${n(p.failed)} failed` : ""}`;
  return p.phase === "cancelled" ? `Stopped after ${n(p.done)} of ${n(p.total)} (${base}).` : `Finished: ${base}.`;
}
