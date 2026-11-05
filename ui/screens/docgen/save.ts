// Saving generated documents into the open project through the root-confined host fs. The webview names
// project-relative paths only; the host resolves, confines and writes atomically. A new file never replaces an
// existing one (the host's no-replace create answers `exists`, we move to `-2`, `-3`...). Re-saving a document the
// app already wrote uses the hash of what it wrote (compare-and-swap), so an edit made elsewhere is never lost.
import type { FsApi } from "../explorer/fs";
import { candidateName, GENERATED_DIR } from "./naming.ts";

export type SaveFs = Pick<FsApi, "create" | "write">;

export interface ExternalSaver {
  /** Save one sanitized file name in the host-chosen folder; `expectedHash` makes a re-save compare-and-swap. */
  save(name: string, text: string, expectedHash: string | null): Promise<{ name: string; hash: string; size: number }>;
}

export interface Saved {
  /** Project-relative path of the file. */
  path: string;
  /** SHA-256 the host reported; the CAS token for the next save of this file. */
  hash: string;
  size: number;
  /** Written to the host-chosen folder outside the project; `path` is `external:<name>`. */
  external?: boolean;
}

const MAX_SUFFIX = 200;

const codeOf = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");

/** Documents are plain UTF-8, LF, one trailing newline. */
export function normalizeDocument(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

async function ensureDir(fs: SaveFs, dir: string): Promise<void> {
  let at = "";
  for (const seg of dir.split("/")) {
    at = at === "" ? seg : `${at}/${seg}`;
    try {
      await fs.create(at, "dir");
    } catch (e) {
      if (codeOf(e) !== "exists") throw e; // an existing folder is what we want
    }
  }
}

/** Creates `<dir>/<stem>.md`, or the first free `<stem>-N.md`. Never overwrites. */
export async function saveNewDocument(fs: SaveFs, stem: string, text: string, dir: string = GENERATED_DIR): Promise<Saved> {
  await ensureDir(fs, dir);
  const body = normalizeDocument(text);
  for (let i = 0; i < MAX_SUFFIX; i++) {
    const path = `${dir}/${candidateName(stem, i)}`;
    try {
      const r = await fs.write(path, body, { expected_hash: null });
      return { path: r.path, hash: r.hash, size: r.size };
    } catch (e) {
      if (codeOf(e) === "exists") continue;
      throw e;
    }
  }
  throw Object.assign(new Error("no free file name"), { code: "exists" });
}

/** Replaces a document this app wrote earlier. Throws `conflict` when the file changed since (never force-overwrites). */
export async function saveRevision(fs: SaveFs, path: string, text: string, expectedHash: string): Promise<Saved> {
  const r = await fs.write(path, normalizeDocument(text), { expected_hash: expectedHash });
  return { path: r.path, hash: r.hash, size: r.size };
}


/** Creates `<stem>.md` / `<stem>-N.md` in the external folder; never overwrites. */
export async function saveNewExternal(saver: ExternalSaver, stem: string, text: string): Promise<Saved> {
  const body = normalizeDocument(text);
  for (let i = 0; i < MAX_SUFFIX; i++) {
    const name = candidateName(stem, i);
    try {
      const r = await saver.save(name, body, null);
      return { path: `external:${r.name}`, hash: r.hash, size: r.size, external: true };
    } catch (e) {
      if (codeOf(e) === "exists") continue;
      throw e;
    }
  }
  throw Object.assign(new Error("no free file name"), { code: "exists" });
}

/** Replaces an external document by its previous hash; a changed file is a conflict. */
export async function saveRevisionExternal(saver: ExternalSaver, name: string, text: string, expectedHash: string): Promise<Saved> {
  const r = await saver.save(name, normalizeDocument(text), expectedHash);
  return { path: `external:${r.name}`, hash: r.hash, size: r.size, external: true };
}
