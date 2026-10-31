// Typed wrappers over the Rust host's Source Control commands (desktop/src-tauri/src/{git,git_scm}.rs).
// The webview never sends an absolute path or patch text: paths are relative to the open project root and
// hunk staging sends hunk indexes plus the diff id the host handed out. Destructive commands (discard,
// checkout) ask in a native host dialog the page cannot answer. Local actions only: there is no push, pull,
// fetch, remote, amend or stash command, by design (they need credentials; see the parity checklist).
import { invokeHost } from "../../shell/host";

export interface ScmStatusEntry {
  path: string;
  orig_path: string | null;
  /** Index column: `.` unchanged, `M`, `A`, `D`, `R`, `C`, `T`, `U`. */
  index: string;
  worktree: string;
  kind: "changed" | "renamed" | "unmerged" | "untracked";
  submodule?: boolean;
}

export interface ScmStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: ScmStatusEntry[];
  truncated: boolean;
}

export interface HunkView {
  index: number;
  header: string;
  added: number;
  removed: number;
  lines: string[];
}
export interface HunkDiff {
  diff_id: string;
  hunks: HunkView[];
  truncated: boolean;
}

export interface Identity { name: string; email: string }
export interface Branch { name: string; current: boolean; hash: string; upstream: string | null }
export interface BranchList { branches: Branch[]; truncated: boolean }
export interface LogEntry { hash: string; short: string; author: string; time: number; subject: string; parents: number }
export interface LogPage { entries: LogEntry[]; has_more: boolean }
export interface CommitFile { status: string; path: string }
export interface CommitDetail { hash: string; parents: string[]; message: string; files: CommitFile[]; truncated: boolean }
export interface CommitDiff { text: string; truncated: boolean }

export interface ScmApi {
  status(): Promise<ScmStatus>;
  stage(paths: string[], stage: boolean): Promise<void>;
  stageAll(stage: boolean): Promise<void>;
  diffHunks(path: string, staged: boolean): Promise<HunkDiff>;
  stageHunks(path: string, staged: boolean, diffId: string, hunks: number[]): Promise<void>;
  discard(paths: string[]): Promise<{ restored: number; trashed: number }>;
  identity(): Promise<Identity>;
  commit(message: string): Promise<{ hash: string }>;
  branches(): Promise<BranchList>;
  checkout(name: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  log(skip: number, limit: number): Promise<LogPage>;
  commitFiles(hash: string): Promise<CommitDetail>;
  commitDiff(hash: string, path: string): Promise<CommitDiff>;
}

/** What the host rejects with: `{ code, message }`. Anything else is mapped to `io` / `unavailable`. */
export class ScmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScmError";
    this.code = code;
  }
}

export function toScmError(e: unknown): ScmError {
  if (e instanceof ScmError) return e;
  if (typeof e === "object" && e !== null && "code" in e && "message" in e && typeof (e as { code: unknown }).code === "string") {
    const o = e as { code: string; message: unknown };
    return new ScmError(o.code, String(o.message));
  }
  if (e instanceof Error && e.name === "HostUnavailableError") return new ScmError("unavailable", e.message);
  return new ScmError("io", e instanceof Error ? e.message : String(e));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invokeHost<T>(command, args);
  } catch (e) {
    throw toScmError(e);
  }
}

export function createHostScm(): ScmApi {
  return {
    status: () => call("git_status"),
    stage: (paths, stage) => call("git_stage", { req: { paths, stage } }),
    stageAll: (stage) => call("git_stage_all", { stage }),
    diffHunks: (path, staged) => call("git_diff_hunks", { req: { path, staged } }),
    stageHunks: (path, staged, diffId, hunks) => call("git_stage_hunks", { req: { path, staged, diff_id: diffId, hunks } }),
    discard: (paths) => call("git_discard", { paths }),
    identity: () => call("git_identity"),
    commit: (message) => call("git_commit", { message }),
    branches: () => call("git_branches"),
    checkout: (name) => call("git_checkout", { name }),
    createBranch: (name) => call("git_create_branch", { name }),
    log: (skip, limit) => call("git_log", { req: { skip, limit } }),
    commitFiles: (hash) => call("git_commit_files", { hash }),
    commitDiff: (hash, path) => call("git_commit_diff", { req: { hash, path } }),
  };
}
