// Test doubles: an in-memory root-confined fs (list/create/write with the host's `exists` / `conflict` rules), source
// readers and a core API whose answer the test controls. No network, no model.
import type { Entry, ListResult } from "../../explorer/fs.ts";
import type { GenerateBody, GenerateResult } from "../model.ts";
import type { SourceReaders } from "../sources.ts";

export class FsErr extends Error {
  code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

const sha = (s: string): string => `h${s.length}:${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

export class MemFs {
  files = new Map<string, { text: string; hash: string; mtime: number; size: number }>();
  dirs = new Set<string>([""]);
  tick = 1000;
  writes: string[] = [];
  listCalls = 0;
  pageLimit = 1000;

  addFile(path: string, text: string, size = text.length): void {
    this.mkdirs(path.split("/").slice(0, -1).join("/"));
    this.files.set(path, { text, hash: sha(text), mtime: this.tick++, size });
  }
  mkdirs(dir: string): void {
    let at = "";
    for (const seg of dir.split("/").filter(Boolean)) {
      at = at ? `${at}/${seg}` : seg;
      this.dirs.add(at);
    }
  }
  async create(path: string, kind: "file" | "dir"): Promise<string> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.dirs.has(parent)) throw new FsErr("not_found");
    if (this.dirs.has(path) || this.files.has(path)) throw new FsErr("exists");
    if (kind === "dir") this.dirs.add(path);
    else this.addFile(path, "");
    return path;
  }
  async write(path: string, text: string, o: { expected_hash: string | null; force?: boolean }) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.dirs.has(parent)) throw new FsErr("not_found");
    const cur = this.files.get(path);
    if (cur && !o.force) {
      if (o.expected_hash === null) throw new FsErr("exists");
      if (o.expected_hash !== cur.hash) throw new FsErr("conflict");
    }
    if (!cur && o.expected_hash !== null && !o.force) throw new FsErr("conflict");
    this.writes.push(path);
    const hash = sha(text);
    this.files.set(path, { text, hash, mtime: this.tick++, size: text.length });
    return { path, size: text.length, mtime_ms: this.tick, hash };
  }
  async list(path: string, opts: { offset?: number; limit?: number } = {}): Promise<ListResult> {
    this.listCalls++;
    if (!this.dirs.has(path)) throw new FsErr("not_found");
    const prefix = path === "" ? "" : `${path}/`;
    const all: Entry[] = [];
    for (const d of this.dirs) {
      if (d !== "" && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) all.push(entry(d, "dir", 0, 0));
    }
    for (const [p, f] of this.files) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) all.push(entry(p, "file", f.size, f.mtime));
    }
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? this.pageLimit, this.pageLimit);
    const entries = all.slice(offset, offset + limit);
    const end = offset + entries.length;
    return { path, entries, total: all.length, next_offset: end < all.length ? end : null, skipped: 0 };
  }
}

function entry(path: string, kind: "dir" | "file", size: number, mtime: number): Entry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, kind, symlink: false, hidden: false, ignored: false, size, mtime_ms: mtime };
}

export function readersFrom(files: Record<string, string | null>, notes: Record<string, string | null> = {}, log: string[] = []): SourceReaders {
  return {
    async file(rel) {
      log.push(`file:${rel}`);
      const t = files[rel];
      if (t === undefined) throw new FsErr("not_found");
      return { text: t, truncated: false };
    },
    async note(rel) {
      log.push(`note:${rel}`);
      const t = notes[rel];
      if (t === undefined) throw new FsErr("not_found");
      return { text: t, truncated: false };
    },
  };
}

export function okResult(content: string, extra: Partial<GenerateResult> = {}): GenerateResult {
  return { content, truncated: [], truncatedCount: 0, omitted: [], omittedCount: 0, reportsFit: true, ...extra };
}

/** A core whose `generate` waits for the test to answer, and honours the abort signal like the real client. */
export function controllableApi() {
  const calls: { body: GenerateBody; resolve: (r: GenerateResult) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = [];
  return {
    calls,
    api: {
      generate(body: GenerateBody, signal: AbortSignal): Promise<GenerateResult> {
        return new Promise((resolve, reject) => {
          const call = { body, resolve, reject, signal };
          calls.push(call);
          signal.addEventListener("abort", () => reject(Object.assign(new Error("Request cancelled."), { code: "ABORTED", status: 0 })), { once: true });
        });
      },
    },
  };
}

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
