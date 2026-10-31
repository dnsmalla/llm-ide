// "@" mentions: files of the open project and notes.
//
// Big projects: the flat index is a BOUNDED background walk of the host's paged, root-confined listing (gitignored,
// hidden and vendored directories skipped; at most MAX_FILES entries and MAX_DIRS directories), searchable while it
// runs. A path typed after `@` ("src/ui/ch") does not need the index at all: that folder is listed directly, page
// by page, so ANY depth of a 100k-file project is reachable. Searches are debounced by the caller, cancelled by an
// AbortSignal, and return at most RESULT_LIMIT rows (the menu windows them). No search runs per keystroke over
// more than the capped index.
import type { CoreTransport } from "../transport";
import { item, type MenuItem } from "../slash/items";
import { safeLine } from "../slash/sanitize";
import type { ProjectFs, DirEntry } from "./project-fs";
import { SKIP_DIRS, safeMentionPath, splitQuery } from "./paths";

export const MAX_FILES = 30_000;
export const MAX_DIRS = 6_000;
export const PAGE_SIZE = 500;
export const RESULT_LIMIT = 200;
export const MAX_BROWSE_PAGES = 10;
export const INDEX_TTL_MS = 30_000;

interface FileEntry { path: string; name: string; lname: string; lpath: string }

export type ScanState = "idle" | "scanning" | "done" | "truncated";

export interface MentionResult {
  items: MenuItem[];
  scan: ScanState;
  /** A short human line the menu may show ("Showing the first 30,000 files..."). */
  note: string | null;
}

function fileItem(f: { path: string; name: string }): MenuItem {
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  return item("file", `file:${f.path}`, f.name, dir || "project root", { path: f.path });
}
function entryItem(e: DirEntry): MenuItem {
  const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
  return item("file", `${e.kind === "dir" ? "dir" : "file"}:${e.path}`, e.kind === "dir" ? `${e.name}/` : e.name, e.kind === "dir" ? "folder" : dir || "project root", { path: e.path, isDir: e.kind === "dir" });
}

export class FileIndex {
  private files: FileEntry[] = [];
  private state: ScanState = "idle";
  private startedAt = -Infinity;
  private ac: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly fs: ProjectFs, private readonly now: () => number = Date.now, private readonly caps = { files: MAX_FILES, dirs: MAX_DIRS }) {}

  get scanState(): ScanState { return this.state; }
  get size(): number { return this.files.length; }

  /** Drops the index and cancels a running walk (project changed). */
  reset(): void {
    this.ac?.abort();
    this.ac = null; this.running = null; this.files = []; this.state = "idle"; this.startedAt = -Infinity;
  }

  /** Starts (or reuses) the walk; stale after INDEX_TTL_MS so files created since show up. Resolves when it ends. */
  ensure(): Promise<void> {
    if (this.running) return this.running;
    if ((this.state === "done" || this.state === "truncated") && this.now() - this.startedAt < INDEX_TTL_MS) return Promise.resolve();
    this.startedAt = this.now();
    this.state = "scanning";
    const ac = new AbortController();
    this.ac = ac;
    const files: FileEntry[] = [];
    this.files = files; // visible while it fills: searches over a partial index are honest ("scanning")
    this.running = this.walk(ac.signal, files).then((truncated) => {
      if (ac.signal.aborted) return;
      this.state = truncated ? "truncated" : "done";
    }).catch(() => { if (!ac.signal.aborted) this.state = "truncated"; }).finally(() => { if (this.ac === ac) this.running = null; });
    return this.running;
  }

  private async walk(signal: AbortSignal, out: FileEntry[]): Promise<boolean> {
    const queue: string[] = [""];
    let dirs = 0, truncated = false;
    const next = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const dir = queue.shift();
        if (dir === undefined) return;
        dirs++;
        let offset: number | null = 0;
        while (offset !== null && !signal.aborted) {
          let page;
          try { page = await this.fs.list(dir, offset, PAGE_SIZE, signal); } catch { break; }
          for (const e of page.entries) {
            if (e.kind === "dir") {
              if (SKIP_DIRS.has(e.name)) continue;
              if (dirs + queue.length >= this.caps.dirs) { truncated = true; continue; }
              queue.push(e.path);
            } else if (e.kind === "file") {
              if (out.length >= this.caps.files) { truncated = true; return; }
              out.push({ path: e.path, name: e.name, lname: e.name.toLowerCase(), lpath: e.path.toLowerCase() });
            }
          }
          offset = page.nextOffset;
        }
      }
    };
    // A few workers: IPC round-trips overlap while each page is processed.
    await Promise.all([next(), next(), next(), next()]);
    return truncated;
  }

  /** Ranked files for a non-empty query without `/`: name prefix, name contains, name subsequence, path contains. */
  search(query: string, limit = RESULT_LIMIT): MenuItem[] {
    const q = query.toLowerCase();
    if (q === "") return [];
    const a: FileEntry[] = [], b: FileEntry[] = [], c: FileEntry[] = [], d: FileEntry[] = [];
    const files = this.files;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.lname.startsWith(q)) a.push(f);
      else if (f.lname.includes(q)) b.push(f);
      else if (q.length >= 2 && subseq(q, f.lname)) c.push(f);
      else if (f.lpath.includes(q)) d.push(f);
      if (a.length >= limit) break; // enough perfect hits: stop scanning (keeps typing O(limit) on huge indexes)
    }
    const out: MenuItem[] = [];
    for (const list of [a, b, c, d]) for (const f of list) { if (out.length >= limit) return out; out.push(fileItem(f)); }
    return out;
  }
}

function subseq(q: string, s: string): boolean {
  if (q.length > s.length) return false;
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s.charCodeAt(j) === q.charCodeAt(i)) i++;
  return i === q.length;
}

export interface NoteHit { noteKey: string; title: string; snippet: string; kind: string }

export function decodeNotes(raw: unknown): NoteHit[] {
  const list = (raw as { results?: unknown })?.results;
  if (!Array.isArray(list)) return [];
  const out: NoteHit[] = [];
  for (const r of list.slice(0, 20)) {
    const o = r as Record<string, unknown>;
    if (typeof o?.noteKey !== "string" || typeof o.title !== "string" || o.noteKey.length > 400) continue;
    out.push({ noteKey: o.noteKey, title: safeLine(o.title, 120), snippet: safeLine(o.snippet, 240), kind: safeLine(o.kind, 24) });
  }
  return out;
}

export function noteItem(n: NoteHit): MenuItem {
  return item("note", `note:${n.noteKey}`, n.title || "Untitled note", n.snippet || n.kind, { path: n.noteKey, insert: `${n.title}${n.snippet ? `\n${n.snippet}` : ""}` });
}

export interface MentionSearch {
  search(query: string, signal: AbortSignal): Promise<MentionResult>;
  /** The project changed or closed. */
  reset(): void;
}

export interface MentionDeps { fs: ProjectFs | null; core?: CoreTransport | null; now?: () => number }

export function createMentionSearch(deps: MentionDeps): MentionSearch {
  const index = deps.fs ? new FileIndex(deps.fs, deps.now) : null;

  async function browse(dir: string, prefix: string, signal: AbortSignal): Promise<{ items: MenuItem[]; missing: boolean }> {
    if (!deps.fs) return { items: [], missing: false };
    const safe = dir === "" ? "" : safeMentionPath(dir);
    if (safe === null) return { items: [], missing: true };
    const p = prefix.toLowerCase();
    const hits: DirEntry[] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < MAX_BROWSE_PAGES && !signal.aborted; page++) {
      let r;
      try { r = await deps.fs.list(safe, offset, PAGE_SIZE, signal); } catch { return { items: [], missing: true }; }
      for (const e of r.entries) if (e.kind !== "other" && e.name.toLowerCase().startsWith(p)) hits.push(e);
      offset = r.nextOffset;
    }
    hits.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "dir" ? -1 : 1));
    return { items: hits.slice(0, RESULT_LIMIT).map(entryItem), missing: false };
  }

  async function notes(query: string, signal: AbortSignal): Promise<MenuItem[]> {
    if (!deps.core || !/[\p{L}\p{N}]{2,}/u.test(query)) return [];
    try {
      const raw = await deps.core.json<unknown>("GET", `/kb/index/search?q=${encodeURIComponent(query.slice(0, 200))}&limit=5`, undefined, signal);
      return decodeNotes(raw).map(noteItem);
    } catch { return []; }
  }

  return {
    reset() { index?.reset(); },
    async search(query, signal) {
      const { dir, prefix } = splitQuery(query);
      if (dir !== null) {
        const r = await browse(dir, prefix, signal);
        return { items: r.items, scan: "done", note: r.missing ? "No such folder in this project." : null };
      }
      if (prefix === "") {
        const r = await browse("", "", signal);
        void index?.ensure(); // warm the flat index while the user reads the root listing
        return { items: r.items, scan: index?.scanState ?? "idle", note: null };
      }
      let scan: ScanState = "idle";
      let files: MenuItem[] = [];
      if (index) {
        const running = index.ensure();
        // Give a young scan a short head start, then answer with what is indexed so far (never block typing).
        await Promise.race([running, new Promise<void>((r) => setTimeout(r, 120))]);
        files = index.search(prefix);
        scan = index.scanState;
      }
      const noteItems = signal.aborted ? [] : await notes(prefix, signal);
      const note = scan === "scanning" ? "Still indexing this project; more files may appear."
        : scan === "truncated" ? "Large project: only part of it is indexed. Type a folder path (src/) to browse deeper." : null;
      return { items: files.concat(noteItems), scan, note };
    },
  };
}
