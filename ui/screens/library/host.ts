// Typed client for the notes host commands (desktop/src-tauri/src/notes_fs.rs). The webview never
// supplies an absolute path: the notes folder is chosen through the host's native dialog, and every
// other call takes a path RELATIVE to it that came from `list`. Read-only: no write command exists.
//
// Errors from the host are strings `<code>: <detail>` (codes: no_root, invalid_root, outside_root,
// not_found, not_downloaded, too_large, invalid_path, io); `toNotesError` turns them into a code the
// UI maps to its own wording (the detail is never shown raw).

import type { NoteEntry } from "./notes-model.ts";

export interface NotesRoot {
  name: string;
  root: string;
}

export interface ListPage {
  entries: NoteEntry[];
  nextCursor: string | null;
  visited: number;
}

export interface ReadChunk {
  rel: string;
  size: number;
  mtimeMs: number;
  offset: number;
  text: string;
  nextOffset: number | null;
}

export interface NoteHeadResult {
  rel: string;
  size: number;
  mtimeMs: number;
  head: string | null;
  error: NotesErrorCode | null;
}

export type NotesErrorCode = "no_root" | "invalid_root" | "outside_root" | "not_found" | "not_downloaded" | "too_large" | "invalid_path" | "io" | "budget" | "unavailable";

const CODES: readonly NotesErrorCode[] = ["no_root", "invalid_root", "outside_root", "not_found", "not_downloaded", "too_large", "invalid_path", "io", "budget"];

export class NotesError extends Error {
  readonly code: NotesErrorCode;
  constructor(code: NotesErrorCode, message?: string) {
    super(message ?? code);
    this.name = "NotesError";
    this.code = code;
  }
}

/** `no_root: ...` -> NotesError("no_root"); a non-Tauri environment -> "unavailable". */
export function toNotesError(e: unknown): NotesError {
  if (e instanceof NotesError) return e;
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const m = /^([a-z_]+):/.exec(s);
  const code = m && (CODES as readonly string[]).includes(m[1]!) ? (m[1] as NotesErrorCode) : /not available outside the desktop app/.test(s) ? "unavailable" : "io";
  return new NotesError(code);
}

export function notesErrorText(code: NotesErrorCode): string {
  switch (code) {
    case "no_root":
      return "No notes folder is chosen yet.";
    case "invalid_root":
      return "That folder cannot be used as the notes folder (too broad, or not a folder).";
    case "outside_root":
      return "That file is outside the notes folder.";
    case "not_found":
      return "The file no longer exists. Refresh the list.";
    case "not_downloaded":
      return "This note is in iCloud and is not downloaded to this computer. Open it in Finder to download it, then refresh.";
    case "too_large":
      return "This file is too large to open here.";
    case "invalid_path":
      return "That is not a valid note path.";
    case "unavailable":
      return "Notes can only be read inside the desktop app.";
    case "budget":
      return "Too much to read at once. Try again.";
    default:
      return "The file could not be read.";
  }
}

/** What the host exposes to the screen (and what tests fake). */
export interface NotesHost {
  rootGet(): Promise<NotesRoot | null>;
  rootChoose(): Promise<NotesRoot | null>;
  rootClear(): Promise<void>;
  list(cursor: string | null, limit: number): Promise<ListPage>;
  read(rel: string, offset: number, maxBytes: number): Promise<ReadChunk>;
  heads(rels: string[], maxBytes: number): Promise<NoteHeadResult[]>;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function decodeRoot(v: unknown): NotesRoot | null {
  return isRecord(v) && typeof v.root === "string" ? { name: str(v.name) || "notes", root: v.root } : null;
}

function decodeEntry(v: unknown): NoteEntry | null {
  if (!isRecord(v) || typeof v.rel !== "string" || v.rel === "") return null;
  return { rel: v.rel, size: num(v.size), mtimeMs: num(v.mtime_ms), placeholder: v.placeholder === true };
}

export function decodeListPage(v: unknown): ListPage {
  const r = isRecord(v) ? v : {};
  const entries: NoteEntry[] = [];
  for (const e of Array.isArray(r.entries) ? r.entries : []) {
    const d = decodeEntry(e);
    if (d) entries.push(d);
  }
  return { entries, nextCursor: typeof r.next_cursor === "string" && r.next_cursor !== "" ? r.next_cursor : null, visited: num(r.visited) };
}

export function decodeReadChunk(v: unknown): ReadChunk {
  const r = isRecord(v) ? v : {};
  return { rel: str(r.rel), size: num(r.size), mtimeMs: num(r.mtime_ms), offset: num(r.offset), text: str(r.text), nextOffset: typeof r.next_offset === "number" ? r.next_offset : null };
}

export function decodeHeads(v: unknown): NoteHeadResult[] {
  const out: NoteHeadResult[] = [];
  for (const h of Array.isArray(v) ? v : []) {
    if (!isRecord(h) || typeof h.rel !== "string") continue;
    out.push({
      rel: h.rel,
      size: num(h.size),
      mtimeMs: num(h.mtime_ms),
      head: typeof h.head === "string" ? h.head : null,
      error: typeof h.error === "string" ? toNotesError(h.error).code : null,
    });
  }
  return out;
}

export function createNotesHost(invoke: Invoke): NotesHost {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (e) {
      throw toNotesError(e);
    }
  };
  return {
    rootGet: async () => decodeRoot(await call<unknown>("notes_root_get")),
    rootChoose: async () => decodeRoot(await call<unknown>("notes_root_choose")),
    rootClear: async () => {
      await call<unknown>("notes_root_clear");
    },
    list: async (cursor, limit) => decodeListPage(await call<unknown>("notes_list", { cursor, limit })),
    read: async (rel, offset, maxBytes) => decodeReadChunk(await call<unknown>("notes_read", { rel, offset, maxBytes })),
    heads: async (rels, maxBytes) => decodeHeads(await call<unknown>("notes_heads", { rels, maxBytes })),
  };
}
