// Library > project files: the rules for removing, adding files and adding folders in the Code and Data
// trees. Pure (no DOM, no Tauri): `projectMutations(invoke)` builds the `Mutations`, thin wrappers over the host
// commands fs_delete (trash only), fs_create, fs_write_file (no expected hash = no-replace create) and the
// attach_* commands. Nothing here deletes permanently and nothing writes outside the project root.
import { safeProjectPath } from "./project-files.ts";

export const CATEGORY_ROOTS = ["code", "data"] as const;
export const MAX_ADD_BYTES = 25 * 1024 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
const MAX_CANDIDATES = 1000;

export interface PickedFile {
  handle: string;
  name: string;
  size: number;
}

/** The host calls the screen needs. `trash` is the only removal; there is no permanent delete here. */
export interface Mutations {
  pick(): Promise<{ files: PickedFile[]; rejected: { name: string; reason: string }[] }>;
  read(handle: string, offset: number, len: number): Promise<Uint8Array>;
  release(handle: string): Promise<void>;
  create(path: string, kind: "file" | "dir"): Promise<string>;
  /** Writes a NEW file: the host refuses (code "exists") when anything is already at `path`, and leaves nothing behind on failure. */
  writeNew(path: string, text: string): Promise<void>;
  trash(path: string): Promise<void>;
}

const codeOf = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");

// ---- paths ------------------------------------------------------------------------------------

const GIT_NAME = /^(\.git|git~1)[\s.]*$/i;

/** Why a path may not be removed (or used as an add target), or null when it may. The project root, the Code and Data roots themselves and anything inside .git are refused. */
export function projectEntryProblem(path: string, opts: { allowCategoryRoot?: boolean } = {}): string | null {
  const clean = safeProjectPath(path);
  if (clean === null || clean !== path) return "Only files and folders inside Code or Data can be used here.";
  const parts = clean.split("/");
  if (!(CATEGORY_ROOTS as readonly string[]).includes(parts[0]!)) return "Only files and folders inside Code or Data can be used here.";
  if (parts.length === 1 && !opts.allowCategoryRoot) return "The Code and Data folders themselves cannot be removed.";
  if (parts.some((p) => GIT_NAME.test(p))) return "Nothing inside .git can be changed here.";
  return null;
}

// ---- names ------------------------------------------------------------------------------------

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f‪-‮⁦-⁩‎‏]/;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Why a file or folder name is not allowed, or null. Names come from the user or a picked file: untrusted text. */
export function validateEntryName(name: string): string | null {
  if (name.trim() === "") return "Enter a name.";
  if (utf8Bytes(name) > 255) return "Names can be at most 255 bytes long.";
  if (name !== name.trim()) return "Names cannot start or end with a space.";
  if (name === "." || name === ".." || name.startsWith("..")) return 'Names cannot start with "..".';
  if (/[\\/]/.test(name)) return "Names cannot contain / or \\.";
  if (CONTROL_OR_BIDI.test(name)) return "Names cannot contain control characters.";
  if (name.endsWith(".")) return "Names cannot end with a dot.";
  if (RESERVED_WINDOWS.test(name)) return "That name is reserved on Windows.";
  if (name.toLowerCase() === ".git") return "That name is reserved for Git.";
  return null;
}

/** Candidate `n` for a clashing name: n=0 is the name itself, then "stem 1.ext", "stem 2.ext", ... */
export function candidateName(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`;
}

// ---- remove -----------------------------------------------------------------------------------

export type RemovePlan = { ok: true; path: string; name: string; kind: "file" | "dir"; title: string; message: string } | { ok: false; message: string };

/** The confirmation for one removal. Nothing is removed here: the screen shows `title`/`message` and only then calls `runRemove`. */
export function planRemove(path: string, kind: "file" | "dir", childCount: number | null): RemovePlan {
  const problem = projectEntryProblem(path);
  if (problem) return { ok: false, message: problem };
  const name = path.slice(path.lastIndexOf("/") + 1);
  const title = `Move "${name}" to the Trash?`;
  if (kind === "file") {
    return { ok: true, path, name, kind, title, message: `"${name}" will be moved to the Trash. You can restore it from the Trash. Nothing is deleted permanently.` };
  }
  const count = childCount === null ? "" : `It holds ${childCount} ${childCount === 1 ? "item" : "items"} at its top level. `;
  return { ok: true, path, name, kind, title, message: `"${name}" will be moved to the Trash, with everything inside it. ${count}You can restore it from the Trash. Nothing is deleted permanently.` };
}

export type ActionResult = { ok: true } | { ok: false; message: string };

function trashMessage(code: string): string {
  if (code === "trash_unavailable") return "The system Trash is not available, so nothing was deleted.";
  if (code === "not_found") return "That item is already gone. Refresh the list.";
  return "The item could not be moved to the Trash. Nothing was deleted.";
}

/** Runs a CONFIRMED plan through the trash only. A refused plan never reaches the host. */
export async function runRemove(plan: RemovePlan, trash: (path: string) => Promise<void>): Promise<ActionResult> {
  if (!plan.ok) return { ok: false, message: plan.message };
  try {
    await trash(plan.path);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: trashMessage(codeOf(e)) };
  }
}

// ---- add --------------------------------------------------------------------------------------

export interface AddResult {
  added: string[];
  skipped: { name: string; reason: string }[];
  /** Added files whose bytes were not UTF-8 and were converted; the user is told, since the content changed encoding. */
  notes: { name: string; note: string }[];
}

/** One line for the screen: what was added, what was converted, then what was skipped and why. */
export function addSummary(
  added: readonly string[],
  skipped: readonly { name: string; reason: string }[],
  notes: readonly { name: string; note: string }[] = [],
): string {
  const head = added.length === 0 ? "No files were added." : `Added ${added.length} ${added.length === 1 ? "file" : "files"}${added.length === 1 ? `: ${added[0]}` : ""}.`;
  const converted = notes.length === 0 ? "" : ` ${notes.map((n) => `${n.name}: ${n.note}.`).join(" ")}`;
  return skipped.length === 0 ? `${head}${converted}` : `${head}${converted} Skipped ${skipped.length}: ${skipped.map((s) => `${s.name} (${s.reason}).`).join(" ")}`;
}

const PICK_REASONS: Record<string, string> = {
  not_regular: "not a regular file",
  too_large: "larger than 25 MB",
  total_limit: "over the 100 MB limit for one add",
  too_many: "at most 20 files per pick",
  unreadable: "cannot be read",
};

/** A host pick-rejection code (attach.rs) in plain words. */
export const pickReason = (code: string): string => PICK_REASONS[code] ?? "could not be added";

class AddError extends Error {}

/**
 * Writes picked files into `folder` as NEW files: a same-name file is never replaced; the first free
 * "name n.ext" is used. Only UTF-8 text can be written (the host's write command takes text), so binary
 * picks are skipped. Every handle is released, skipped or not. Each name is tried with a no-replace write, so a
 * failure leaves no file behind and nothing is ever moved to the Trash while adding.
 */
export async function addFilesToFolder(m: Mutations, folder: string, files: PickedFile[]): Promise<AddResult> {
  const problem = projectEntryProblem(folder, { allowCategoryRoot: true });
  if (problem) throw new AddError(problem);
  const added: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const notes: { name: string; note: string }[] = [];
  for (const f of files) {
    try {
      const done = await addOne(m, folder, f);
      added.push(done.path);
      if (done.note) notes.push({ name: f.name, note: done.note });
    } catch (e) {
      skipped.push({ name: f.name, reason: e instanceof AddError ? e.message : "The file could not be added." });
    }
  }
  return { added, skipped, notes };
}

async function addOne(m: Mutations, folder: string, f: PickedFile): Promise<{ path: string; note?: string }> {
  try {
    const nameProblem = validateEntryName(f.name);
    if (nameProblem) throw new AddError(nameProblem);
    if (f.size > MAX_ADD_BYTES) throw new AddError("This file is larger than 25 MB.");
    const decoded = decodeText(await readAll(m, f));
    const path = await writeFree(m, folder, f.name, decoded.text);
    return decoded.note ? { path, note: decoded.note } : { path };
  } finally {
    await m.release(f.handle).catch(() => undefined);
  }
}

function decodeStrict(bytes: Uint8Array, encoding: string): string {
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * Hiragana, Katakana, CJK Unified Ideographs and half-width Katakana. Shift-JIS decodes almost any high-byte pair, so
 * Latin-1 text such as "café" decodes "successfully" as Shift-JIS; only text with real Japanese characters is accepted.
 */
const JAPANESE_CHAR = /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/;

/**
 * Text only. UTF-8 first; then Shift-JIS (CP932), because Japanese spreadsheets are often saved that way. Fatal decoding
 * in both keeps most binaries out, and a NUL byte is refused as before. A CP932 file is stored as UTF-8 and the
 * returned note says so. Shift-JIS is accepted only when the result holds Japanese text, since a Latin-1 file would
 * otherwise be stored as mojibake without any notice.
 */
function decodeText(bytes: Uint8Array): { text: string; note?: string } {
  const refuse = () => new AddError("Only text files can be added here yet.");
  const utf8 = tryDecode(bytes, "utf-8");
  if (utf8 !== null) {
    if (utf8.includes("\u0000")) throw refuse();
    return { text: utf8 };
  }
  const sjis = tryDecode(bytes, "shift_jis");
  if (sjis === null || sjis.includes("\u0000") || !JAPANESE_CHAR.test(sjis)) throw refuse();
  return { text: sjis, note: "converted from Shift-JIS to UTF-8" };
}

/** The decoded text, or null when the bytes are not valid in `encoding` (fatal decoding). */
function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return decodeStrict(bytes, encoding);
  } catch {
    return null;
  }
}

async function readAll(m: Mutations, f: PickedFile): Promise<Uint8Array> {
  const out = new Uint8Array(f.size);
  let offset = 0;
  while (offset < f.size) {
    const chunk = await m.read(f.handle, offset, Math.min(READ_CHUNK, f.size - offset));
    if (chunk.length === 0) break;
    out.set(chunk.subarray(0, Math.min(chunk.length, f.size - offset)), offset);
    offset += Math.min(chunk.length, f.size - offset);
  }
  if (offset !== f.size) throw new AddError("The file changed while it was being read. Nothing was added.");
  return out;
}

/** Writes `text` under the first free name in `folder` (the host's no-replace write never overwrites). */
async function writeFree(m: Mutations, folder: string, name: string, text: string): Promise<string> {
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const path = `${folder}/${candidateName(name, n)}`;
    try {
      await m.writeNew(path, text);
      return path;
    } catch (e) {
      if (codeOf(e) !== "exists") throw new AddError("The file could not be written. Nothing was added.");
    }
  }
  throw new AddError("No free name was found for this file.");
}

/** Creates one EMPTY folder `name` inside `folder`. Importing an outside folder is not offered (it would widen access past the project root). */
export async function createFolder(create: (path: string, kind: "file" | "dir") => Promise<string>, folder: string, name: string): Promise<string> {
  const problem = projectEntryProblem(folder, { allowCategoryRoot: true }) ?? validateEntryName(name);
  if (problem) throw new Error(problem);
  try {
    return await create(`${folder}/${name}`, "dir");
  } catch (e) {
    if (codeOf(e) === "exists") throw new Error("A file or folder with that name already exists.");
    throw new Error("The folder could not be created here.");
  }
}

/** The project-file writes, over the host commands: trash only for removal, no-replace create and write, attach handles. */
export function projectMutations(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): Mutations {
  const decodePicks = (v: unknown) => {
    const r = (typeof v === "object" && v !== null ? v : {}) as { files?: unknown; rejected?: unknown };
    const files = Array.isArray(r.files) ? r.files.flatMap((f) => {
      const o = f as Record<string, unknown>;
      return typeof o.handle === "string" && typeof o.name === "string" && typeof o.size === "number" ? [{ handle: o.handle, name: o.name, size: o.size }] : [];
    }) : [];
    const rejected = Array.isArray(r.rejected) ? r.rejected.flatMap((f) => {
      const o = f as Record<string, unknown>;
      return typeof o.name === "string" && typeof o.reason === "string" ? [{ name: o.name, reason: o.reason }] : [];
    }) : [];
    return { files, rejected };
  };
  return {
    pick: async () => decodePicks(await invoke("attach_pick_files")),
    read: async (handle, offset, len) => {
      const v = await invoke("attach_read", { handle, offset, len });
      if (v instanceof Uint8Array) return v;
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      if (Array.isArray(v)) return Uint8Array.from(v as number[]);
      throw new Error("unexpected attach_read answer");
    },
    release: async (handle) => { await invoke("attach_release", { handle }).catch(() => undefined); },
    create: (path, kind) => invoke("fs_create", { req: { path, kind } }) as Promise<string>,
    // No expected_hash: the host creates the file only if nothing is at `path` (no-replace rename), else "exists".
    writeNew: async (path, text) => { await invoke("fs_write_file", { req: { path, text, encoding: "utf-8", bom: false, expected_hash: null, force: false } }); },
    trash: async (path) => { await invoke("fs_delete", { path }); },
  };
}
