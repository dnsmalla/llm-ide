// Typed wrappers over the Rust host's Source Control commands (desktop/src-tauri/src/{git,git_scm}.rs).
// The webview never sends an absolute path or patch text: paths are relative to the open project root and
// hunk staging sends hunk indexes plus the diff id the host handed out. Destructive commands (discard,
// checkout, branch delete, merge, amend, discard all, stash pop and drop) ask in a native host dialog the page cannot
// answer. Local actions only: there is no push, pull, fetch or remote command, by design (they need credentials;
// see the parity checklist).
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
  /** A merge is in progress (MERGE_HEAD exists): the Changes tab offers Abort merge. */
  merging: boolean;
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
/** `annotated` is false for a lightweight tag. `target` is the short id of the commit it names. */
export interface Tag { name: string; target: string; annotated: boolean }
export interface TagList { tags: Tag[]; truncated: boolean }
/** `not_merged` is a refusal that deleted nothing: `tip` is the branch's last commit, `unique_commits` what a forced delete loses. */
export type BranchDelete = { status: "deleted" } | { status: "not_merged"; tip: string; unique_commits: number };
/** `index` is the position in the list (`stash@{index}`), newest first; `hash` is the entry's commit, sent back with
 * apply / pop / drop so the host refuses (`changed`) when the list moved since it was shown. */
export interface Stash { index: number; hash: string; message: string }
export interface StashList { stashes: Stash[]; truncated: boolean }
/** `merged`: `hash` is the new short HEAD and `fast_forward` means no merge commit was made. `conflicts`: git stopped
 * with conflicts and kept the merge in progress; `paths` are the conflicted files (bounded). */
export type MergeOutcome = { status: "merged"; hash: string; fast_forward: boolean } | { status: "conflicts"; paths: string[]; truncated: boolean };
export interface AmendResult { hash: string }
/** `trashed` untracked items moved to the Trash; `skipped` items left in place (symlinks, nested repositories, a Trash refusal). */
export interface DiscardAllResult { restored: number; trashed: number; skipped: number }

export interface ScmApi {
  status(): Promise<ScmStatus>;
  stage(paths: string[], stage: boolean): Promise<void>;
  stageAll(stage: boolean): Promise<void>;
  diffHunks(path: string, staged: boolean): Promise<HunkDiff>;
  stageHunks(path: string, staged: boolean, diffId: string, hunks: number[]): Promise<void>;
  discard(paths: string[]): Promise<{ restored: number; trashed: number }>;
  identity(): Promise<Identity>;
  /** `skipped` names what the user's own git would have run and the host did not: "hooks", "signing". */
  commit(message: string): Promise<{ hash: string; skipped?: readonly string[] }>;
  branches(): Promise<BranchList>;
  checkout(name: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  log(skip: number, limit: number): Promise<LogPage>;
  commitFiles(hash: string): Promise<CommitDetail>;
  commitDiff(hash: string, path: string): Promise<CommitDiff>;
  tags(): Promise<TagList>;
  branchDelete(name: string, force: boolean): Promise<BranchDelete>;
  tagCreate(name: string, message?: string, target?: string): Promise<Tag>;
  stashList(): Promise<StashList>;
  stashPush(message: string, includeUntracked: boolean): Promise<void>;
  stashApply(index: number, hash: string): Promise<void>;
  stashPop(index: number, hash: string): Promise<void>;
  stashDrop(index: number, hash: string): Promise<void>;
  /** `name` is a local branch merged into the current one; `mode` `ff` (default, fast-forward when possible) or `no_ff`. */
  merge(name: string, mode?: "ff" | "no_ff"): Promise<MergeOutcome>;
  mergeAbort(): Promise<void>;
  /** Amends HEAD with the staged changes; `message` omitted or blank keeps the old one. `force` is the second step after already_pushed. */
  commitAmend(message: string | undefined, force: boolean): Promise<AmendResult>;
  discardAll(includeUntracked: boolean): Promise<DiscardAllResult>;
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
    tags: () => call("git_tags"),
    branchDelete: (name, force) => call("git_branch_delete", { name, force }),
    tagCreate: (name, message, target) => call("git_tag_create", { name, message: message ?? null, target: target ?? null }),
    stashList: () => call("git_stash_list"),
    stashPush: (message, includeUntracked) => call("git_stash_push", { req: { message, include_untracked: includeUntracked } }),
    stashApply: (index, hash) => call("git_stash_apply", { index, hash }),
    stashPop: (index, hash) => call("git_stash_pop", { index, hash }),
    stashDrop: (index, hash) => call("git_stash_drop", { index, hash }),
    merge: (name, mode) => call("git_merge", { req: { name, mode: mode ?? null } }),
    mergeAbort: () => call("git_merge_abort"),
    commitAmend: (message, force) => call("git_commit_amend", { req: { message: message ?? null, force } }),
    discardAll: (includeUntracked) => call("git_discard_all", { req: { include_untracked: includeUntracked } }),
  };
}
