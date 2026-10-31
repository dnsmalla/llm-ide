// Library notes as sources: pages the notes folder listing (the same host commands the Library uses) into light
// records, newest first, with a name/path filter. Nothing is read until Generate. Bounded: at most NOTES_MAX records.
import type { NotesHost } from "../library/host.ts";
import { recordFromEntry, type NoteRecord } from "../library/notes-model.ts";
import type { SourceReaders } from "./sources.ts";

export const NOTES_PAGE = 2000;
export const NOTES_MAX = 100_000;

export interface NotesIndexState {
  phase: "idle" | "loading" | "ready" | "none" | "error";
  records: readonly NoteRecord[];
  capped: boolean;
  errorCode: string | null;
}

const isText = (name: string) => /\.(md|markdown|txt)$/i.test(name);

export async function loadNotes(host: Pick<NotesHost, "rootGet" | "list">, signal: AbortSignal, onPage?: (n: number) => void): Promise<NotesIndexState> {
  const root = await host.rootGet();
  if (!root) return { phase: "none", records: [], capped: false, errorCode: null };
  const out: NoteRecord[] = [];
  let cursor: string | null = null;
  let capped = false;
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    const page = await host.list(cursor, NOTES_PAGE);
    for (const e of page.entries) {
      if (e.placeholder || !isText(e.rel)) continue;
      if (out.length >= NOTES_MAX) {
        capped = true;
        break;
      }
      out.push(recordFromEntry(e));
    }
    onPage?.(out.length);
    if (capped || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  out.sort((a, b) => b.dateMs - a.dateMs || (a.rel < b.rel ? -1 : 1));
  return { phase: "ready", records: out, capped, errorCode: null };
}

/** Case-insensitive match on title and path; empty query matches all. Returns at most `limit` (the list is virtualised, this is for counts). */
export function filterNotes(records: readonly NoteRecord[], query: string): NoteRecord[] {
  const q = query.trim().toLowerCase();
  if (q === "") return records.slice();
  const words = q.split(/\s+/);
  return records.filter((r) => {
    const hay = `${r.title} ${r.rel}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function notesReader(host: Pick<NotesHost, "read">): SourceReaders["note"] {
  return async (rel, maxBytes, signal) => {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    const c = await host.read(rel, 0, maxBytes);
    return { text: c.text, truncated: c.nextOffset !== null };
  };
}
