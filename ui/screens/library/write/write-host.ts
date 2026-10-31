// Typed client for the notes WRITE host commands (desktop/src-tauri/src/notes_write.rs). Same rules as
// the read client (`../host.ts`): the webview never supplies an absolute path, only a path relative to
// the notes folder; errors are `<code>: <detail>` strings reduced to a code the UI words itself.
//
// Concurrency model: every save carries the SHA-256 of the bytes the editor last read or wrote
// (`expectedHash`); the host refuses with `conflict` when the file changed on disk. There is no
// blind overwrite except the explicit "keep mine" (`force`) after a conflict the user saw.

import { toNotesError, type NotesErrorCode } from "../host.ts";

export type WriteErrorCode =
  | NotesErrorCode
  | "not_note"
  | "not_utf8"
  | "conflict"
  | "exists"
  | "hardlink"
  | "not_regular"
  | "trash_unavailable"
  | "permission_denied";

const WRITE_CODES: readonly string[] = ["not_note", "not_utf8", "conflict", "exists", "hardlink", "not_regular", "trash_unavailable", "permission_denied"];

export class WriteError extends Error {
  readonly code: WriteErrorCode;
  constructor(code: WriteErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WriteError";
    this.code = code;
  }
}

export function toWriteError(e: unknown): WriteError {
  if (e instanceof WriteError) return e;
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const m = /^([a-z_]+):/.exec(s);
  if (m && WRITE_CODES.includes(m[1]!)) return new WriteError(m[1] as WriteErrorCode);
  return new WriteError(toNotesError(e).code);
}

export function writeErrorText(code: WriteErrorCode): string {
  switch (code) {
    case "conflict":
      return "This note changed on disk since you opened it.";
    case "exists":
      return "A note with that name already exists. Nothing was overwritten.";
    case "not_found":
      return "The note no longer exists. It may have been moved or deleted outside the app.";
    case "not_note":
      return "Notes must be .md, .markdown or .txt files and cannot be hidden.";
    case "not_utf8":
      return "This file is not valid UTF-8 text, so it is not opened for editing (editing could corrupt it).";
    case "too_large":
      return "This note is too large to edit here (limit 8 MB).";
    case "hardlink":
      return "This file has several hard links, so it is not edited here.";
    case "not_regular":
      return "Only note files can be changed here, not folders or special files.";
    case "trash_unavailable":
      return "The Trash is not available on this volume, so nothing was deleted. Notes are never deleted permanently.";
    case "permission_denied":
      return "The operating system refused access to this note.";
    case "outside_root":
    case "invalid_path":
      return "That is not a valid path inside the notes folder.";
    case "no_root":
      return "No notes folder is chosen yet.";
    case "invalid_root":
      return "The notes folder cannot be used.";
    case "not_downloaded":
      return "This note is in iCloud and is not downloaded to this computer.";
    case "unavailable":
      return "Notes can only be changed inside the desktop app.";
    default:
      return "The note could not be saved.";
  }
}

export interface OpenedNote {
  rel: string;
  text: string;
  hash: string;
  bom: boolean;
  size: number;
  mtimeMs: number;
}

export interface SavedNote {
  rel: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface DeleteOutcome {
  rel: string;
  ok: boolean;
  error: WriteErrorCode | null;
}

export interface WriteHost {
  open(rel: string): Promise<OpenedNote>;
  /** Compare-and-swap save. `force` overwrites whatever is on disk ("keep mine"). */
  save(rel: string, text: string, bom: boolean, expectedHash: string, force?: boolean): Promise<SavedNote>;
  /** Creates a new note (and missing folders); `exists` when the name is taken. */
  create(rel: string, text: string): Promise<SavedNote>;
  /** Renames/moves inside the notes folder; never overwrites. Returns the new relative path. */
  rename(from: string, to: string): Promise<string>;
  /** Moves notes to the OS trash (never permanent). At most `BULK_HOST_MAX` per call. */
  deleteMany(rels: string[]): Promise<DeleteOutcome[]>;
}

/** Items the host accepts per `notes_delete_many` call. */
export const BULK_HOST_MAX = 200;

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function decodeOpened(v: unknown): OpenedNote {
  const r = isRecord(v) ? v : {};
  if (typeof r.rel !== "string" || typeof r.text !== "string" || typeof r.hash !== "string") throw new WriteError("io", "bad open reply");
  return { rel: r.rel, text: r.text, hash: r.hash, bom: r.bom === true, size: num(r.size), mtimeMs: num(r.mtime_ms) };
}

export function decodeSaved(v: unknown): SavedNote {
  const r = isRecord(v) ? v : {};
  if (typeof r.rel !== "string" || typeof r.hash !== "string") throw new WriteError("io", "bad save reply");
  return { rel: r.rel, hash: r.hash, size: num(r.size), mtimeMs: num(r.mtime_ms) };
}

export function decodeOutcomes(v: unknown): DeleteOutcome[] {
  const out: DeleteOutcome[] = [];
  for (const o of Array.isArray(v) ? v : []) {
    if (!isRecord(o) || typeof o.rel !== "string") continue;
    out.push({ rel: o.rel, ok: o.ok === true, error: o.ok === true ? null : toWriteError(str(o.error)).code });
  }
  return out;
}

export function createWriteHost(invoke: Invoke): WriteHost {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (e) {
      throw toWriteError(e);
    }
  };
  return {
    open: async (rel) => decodeOpened(await call<unknown>("note_open", { rel })),
    save: async (rel, text, bom, expectedHash, force = false) =>
      decodeSaved(await call<unknown>("note_save", { req: { rel, text, bom, expected_hash: expectedHash, force } })),
    create: async (rel, text) => decodeSaved(await call<unknown>("note_create", { req: { rel, text } })),
    rename: async (from, to) => {
      const r = await call<unknown>("note_rename", { from, to });
      if (typeof r !== "string") throw new WriteError("io", "bad rename reply");
      return r;
    },
    deleteMany: async (rels) => decodeOutcomes(await call<unknown>("notes_delete_many", { rels })),
  };
}
