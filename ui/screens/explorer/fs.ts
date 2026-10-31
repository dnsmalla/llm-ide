// Typed wrappers over the Rust host's root-confined fs / watch / git commands
// (desktop/src-tauri/src/{fs_ops,fs_watch,git}.rs). The webview never sends an absolute path:
// every path here is relative to the open project root, `/` separated, `""` = the root.
// The bridge is `invokeHost` from the shell (Tauri `invoke`, or a fake in tests).
import { invokeHost } from "../shell/host";

export type FsErrorCode =
  | "no_project" | "root_too_broad" | "invalid_path" | "outside_root" | "not_found" | "exists" | "conflict"
  | "too_large" | "not_regular" | "hardlink" | "not_a_directory" | "permission_denied" | "unsupported_encoding"
  | "trash_unavailable" | "changed" | "no_watch" | "not_a_repo" | "untrusted_repo_config" | "git_unavailable"
  | "git_failed" | "git_timeout" | "io" | "unavailable";

/** What the host rejects with: `{ code, message }`. Anything else is mapped to `io` / `unavailable`. */
export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

export function toFsError(e: unknown): FsError {
  if (e instanceof FsError) return e;
  if (typeof e === "object" && e !== null && "code" in e && "message" in e && typeof (e as { code: unknown }).code === "string") {
    const o = e as { code: string; message: unknown };
    return new FsError(o.code as FsErrorCode, String(o.message));
  }
  if (e instanceof Error && e.name === "HostUnavailableError") return new FsError("unavailable", e.message);
  return new FsError("io", e instanceof Error ? e.message : String(e));
}

export interface Entry {
  name: string;
  path: string;
  kind: "dir" | "file" | "other";
  symlink: boolean;
  hidden: boolean;
  ignored: boolean;
  size: number;
  mtime_ms: number;
}

export interface ListOptions {
  offset?: number;
  limit?: number;
  show_hidden?: boolean;
  gitignore?: boolean;
  hide_ignored?: boolean;
}

export interface ListResult {
  path: string;
  entries: Entry[];
  total: number;
  next_offset: number | null;
  skipped: number;
}

export type ReadStatus = "ok" | "binary" | "too_large";
export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "unknown";
export type Eol = "lf" | "crlf" | "cr" | "mixed" | "none";

export interface ReadResult {
  path: string;
  status: ReadStatus;
  size: number;
  mtime_ms: number;
  hash: string | null;
  text: string | null;
  encoding: Encoding;
  bom: boolean;
  eol: Eol;
  read_only: boolean;
}

export interface RangeResult {
  path: string;
  offset: number;
  size: number;
  mtime_ms: number;
  text: string;
  next_offset: number | null;
  binary: boolean;
}

export interface WriteResult {
  path: string;
  size: number;
  mtime_ms: number;
  hash: string;
}

export interface WriteOptions {
  encoding?: Encoding;
  bom?: boolean;
  /** Hash last read or written; `null` = the file must not exist yet. */
  expected_hash: string | null;
  /** "Keep mine": overwrite whatever is on disk. */
  force?: boolean;
}

export interface WatchBatch {
  dirs: string[];
  files: string[];
  overflow: boolean;
}

export type StatusKind = "changed" | "renamed" | "unmerged" | "untracked";
export interface StatusEntry {
  path: string;
  orig_path: string | null;
  index: string;
  worktree: string;
  kind: StatusKind;
}
export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
  truncated: boolean;
}

/** The host surface the Explorer uses; tests provide an in-memory implementation. */
export interface FsApi {
  list(path: string, opts?: ListOptions): Promise<ListResult>;
  read(path: string, maxBytes?: number): Promise<ReadResult>;
  readRange(path: string, offset: number, length: number): Promise<RangeResult>;
  write(path: string, text: string, opts: WriteOptions): Promise<WriteResult>;
  create(path: string, kind: "file" | "dir"): Promise<string>;
  rename(from: string, to: string): Promise<string>;
  /** Moves to the OS trash. */
  remove(path: string): Promise<void>;
  watchStart(onBatch: (b: WatchBatch) => void): Promise<{ mode: "native" | "poll" }>;
  watchSet(dirs: string[]): Promise<void>;
  watchStop(): Promise<void>;
  gitStatus(): Promise<GitStatus>;
  gitDiff(path: string, staged: boolean): Promise<{ text: string; truncated: boolean }>;
  gitShow(path: string, rev: "head" | "index"): Promise<{ exists: boolean; text: string; truncated: boolean }>;
  gitStage(paths: string[], stage: boolean): Promise<void>;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invokeHost<T>(command, args);
  } catch (e) {
    throw toFsError(e);
  }
}

/** Real implementation over the Tauri commands. `watchStart` needs a Tauri Channel (see `channelFactory`). */
export function createHostFs(channelFactory?: (onMessage: (b: WatchBatch) => void) => unknown): FsApi {
  return {
    list: (path, opts = {}) => call("fs_list_dir", { req: { path, ...opts } }),
    read: (path, maxBytes) => call("fs_read_file", { req: { path, max_bytes: maxBytes ?? null } }),
    readRange: (path, offset, length) => call("fs_read_range", { req: { path, offset, length } }),
    write: (path, text, o) =>
      call("fs_write_file", {
        req: { path, text, encoding: o.encoding ?? "utf-8", bom: o.bom ?? false, expected_hash: o.expected_hash, force: o.force ?? false },
      }),
    create: (path, kind) => call("fs_create", { req: { path, kind } }),
    rename: (from, to) => call("fs_rename", { req: { from, to } }),
    remove: (path) => call("fs_delete", { path }),
    async watchStart(onBatch) {
      if (!channelFactory) throw new FsError("unavailable", "file watching needs the desktop host");
      return call("fs_watch_start", { onEvent: channelFactory(onBatch) });
    },
    watchSet: (dirs) => call("fs_watch_set", { dirs }),
    watchStop: () => call("fs_watch_stop"),
    gitStatus: () => call("git_status"),
    gitDiff: (path, staged) => call("git_diff", { req: { path, staged } }),
    gitShow: (path, rev) => call("git_show", { req: { path, rev } }),
    gitStage: (paths, stage) => call("git_stage", { req: { paths, stage } }),
  };
}

/** Joins a folder path and a child name (`""` is the root). */
export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}
