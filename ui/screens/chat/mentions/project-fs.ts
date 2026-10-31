// What mentions and plan saving need from the host's root-confined fs commands (desktop/src-tauri/src/fs_ops.rs),
// behind a small interface so tests use an in-memory project. Chat owns this thin wrapper instead of importing the
// Explorer screen (screens never import each other); argument shapes match the Explorer's own client.

export interface DirEntry { name: string; path: string; kind: "dir" | "file" | "other"; size: number }
export interface DirPage { entries: DirEntry[]; nextOffset: number | null }

export interface ProjectFs {
  /** One page of a directory (`""` = the root). Hidden and gitignored entries are left out. */
  list(path: string, offset: number, limit: number, signal?: AbortSignal): Promise<DirPage>;
  /** The first `maxBytes` of a text file. */
  readHead(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean; binary: boolean }>;
  /** Creates a directory; resolves quietly when it already exists. */
  ensureDir(path: string): Promise<void>;
  /**
   * Writes a text file. Without `expectedHash` the file is only CREATED: an existing one rejects with code `exists`
   * (never replaced). With the hash the write replaces the file only while its content still has that hash (else
   * code `conflict`). Resolves with the new content hash when the host reports one.
   */
  writeText(path: string, text: string, expectedHash?: string | null): Promise<{ hash: string | null }>;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const codeOf = (e: unknown): string => (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");

export function createHostProjectFs(invoke: Invoke): ProjectFs {
  return {
    async list(path, offset, limit) {
      const r = await invoke<{ entries?: unknown[]; next_offset?: number | null }>("fs_list_dir", { req: { path, offset, limit, show_hidden: false, gitignore: true, hide_ignored: true } });
      const entries: DirEntry[] = [];
      for (const x of Array.isArray(r?.entries) ? r.entries : []) {
        const o = x as Record<string, unknown>;
        if (typeof o.name === "string" && typeof o.path === "string" && (o.kind === "dir" || o.kind === "file" || o.kind === "other")) {
          entries.push({ name: o.name, path: o.path, kind: o.kind, size: typeof o.size === "number" ? o.size : 0 });
        }
      }
      return { entries, nextOffset: typeof r?.next_offset === "number" ? r.next_offset : null };
    },
    async readHead(path, maxBytes) {
      const r = await invoke<{ text?: string; binary?: boolean; next_offset?: number | null }>("fs_read_range", { req: { path, offset: 0, length: maxBytes } });
      return { text: typeof r?.text === "string" ? r.text : "", truncated: typeof r?.next_offset === "number", binary: r?.binary === true };
    },
    async ensureDir(path) {
      try { await invoke("fs_create", { req: { path, kind: "dir" } }); } catch (e) { if (codeOf(e) !== "exists") throw e; }
    },
    async writeText(path, text, expectedHash = null) {
      const r = await invoke<{ hash?: unknown }>("fs_write_file", { req: { path, text, encoding: "utf-8", bom: false, expected_hash: expectedHash, force: false } });
      return { hash: typeof r?.hash === "string" ? r.hash : null };
    },
  };
}
