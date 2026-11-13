// Source Control controller: owns status, selection, hunks, commit form, branches and history for one project.
// All git work goes through `ScmApi` (the Rust host); this class holds no git knowledge beyond sequencing,
// stale-response guards and wording. `subscribe` / `getSnapshot` fit React's `useSyncExternalStore`.
import {
  ScmError, toScmError,
  type Branch, type CommitDetail, type HunkDiff, type Identity, type LogEntry, type ScmApi, type ScmStatus, type Stash, type Tag,
} from "./api";
import {
  GROUP_ORDER, MAX_DISCARD, NO_SELECTION, STAGE_CHUNK, actionsFor, branchNameError, buildGroups, chunk, describeError, displayText,
  flatten, hunkIndexes, messageError, pruneSelection, rowKey, selectAllHunks, selectRow, selectedItems, displayLine, tagNameError, toggleHunk,
  validateAmend, validateCommit,
  type ErrorInfo, type FileItem, type GroupId, type Groups, type Row, type Selection,
} from "./model";

/** A branch the host refused to delete because it has commits no merged branch holds. Nothing was deleted. */
export interface PendingBranchDelete { name: string; tip: string; unique: number }
/** An amend the host refused because the commit is already on a remote; the second step (force) sends the same message. */
export interface PendingAmend { message: string }

export type ScmTab = "changes" | "history" | "branches";

export interface HunkState {
  path: string;
  staged: boolean;
  status: "loading" | "ready" | "error";
  diff: HunkDiff | null;
  selected: ReadonlySet<number>;
  error: ErrorInfo | null;
}

export interface HistoryState {
  entries: readonly LogEntry[];
  hasMore: boolean;
  loading: boolean;
  error: ErrorInfo | null;
  open: { hash: string; status: "loading" | "ready" | "error"; detail: CommitDetail | null; file: string | null; diff: { text: string; truncated: boolean } | null; diffLoading: boolean; error: ErrorInfo | null } | null;
}

export interface ScmSnapshot {
  root: string | null;
  tab: ScmTab;
  phase: "idle" | "loading" | "ready" | "error";
  /** A fatal repo-level problem (not a repo, untrusted config, no git): the panel shows only this. */
  fatal: ErrorInfo | null;
  /** Transient result of the last action (shown in a live region). */
  notice: { kind: "info" | "error"; info: ErrorInfo | null; text: string } | null;
  status: ScmStatus | null;
  groups: Groups;
  collapsed: ReadonlySet<GroupId>;
  rows: readonly Row[];
  selection: Selection;
  focusKey: string | null;
  busy: string | null;
  message: string;
  identity: { state: "unknown" | "ok" | "missing"; value: Identity | null };
  hunks: HunkState | null;
  branches: { list: readonly Branch[]; truncated: boolean; loading: boolean; error: ErrorInfo | null };
  /** Read-only tag listing shown under the branches (a failure here never blocks the branch list). */
  tags: { list: readonly Tag[]; truncated: boolean; loading: boolean; error: ErrorInfo | null };
  history: HistoryState;
  /** Stash list, read on the branches tab (the Mac's stash menu lists the same entries). */
  stashes: { list: readonly Stash[]; truncated: boolean; loading: boolean; error: ErrorInfo | null };
  pendingBranchDelete: PendingBranchDelete | null;
  /** A stash drop waiting for the in-page confirmation. */
  pendingStashDrop: Stash | null;
  /** An amend waiting for the in-page "Amend anyway" step (the commit is already published). */
  pendingAmend: PendingAmend | null;
  counts: { staged: number; changes: number; untracked: number; conflicts: number };
}

const EMPTY_GROUPS: Groups = { conflicts: [], staged: [], changes: [], untracked: [] };
const REPO_LEVEL = new Set(["not_a_repo", "untrusted_repo_config", "git_unavailable", "unavailable"]);
const LOG_PAGE = 100;

export interface ScmOptions {
  api: ScmApi;
  /** Called after an action that changed files on disk (discard) so the editor/tree can refresh. */
  onFilesChanged?: () => void;
}

export class ScmController {
  private api: ScmApi;
  private opts: ScmOptions;
  private snap: ScmSnapshot;
  private listeners = new Set<() => void>();
  private refreshSeq = 0;
  private hunkSeq = 0;
  private logSeq = 0;
  private disposed = false;

  constructor(opts: ScmOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.snap = {
      root: null, tab: "changes", phase: "idle", fatal: null, notice: null, status: null, groups: EMPTY_GROUPS, collapsed: new Set(), rows: [],
      selection: NO_SELECTION, focusKey: null, busy: null, message: "", identity: { state: "unknown", value: null }, hunks: null,
      branches: { list: [], truncated: false, loading: false, error: null },
      tags: { list: [], truncated: false, loading: false, error: null },
      history: { entries: [], hasMore: false, loading: false, error: null, open: null },
      stashes: { list: [], truncated: false, loading: false, error: null },
      pendingBranchDelete: null,
      pendingStashDrop: null,
      pendingAmend: null,
      counts: { staged: 0, changes: 0, untracked: 0, conflicts: 0 },
    };
  }

  // ---- store -----------------------------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ScmSnapshot => this.snap;

  private set(patch: Partial<ScmSnapshot>) {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  private fail(e: unknown): ErrorInfo {
    const err = toScmError(e);
    return describeError(err.code, err.message);
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------

  /** (Re)binds to a project: resets everything, then loads status and identity. */
  async init(root: string | null): Promise<void> {
    this.refreshSeq++;
    this.hunkSeq++;
    this.logSeq++;
    const fresh = new ScmController({ api: this.api }).snap;
    this.set({ ...fresh, root, phase: root ? "loading" : "idle" });
    if (!root) return;
    await Promise.all([this.refresh(), this.loadIdentity()]);
  }

  async refresh(): Promise<void> {
    if (!this.snap.root) return;
    const seq = ++this.refreshSeq;
    try {
      const status = await this.api.status();
      if (seq !== this.refreshSeq) return;
      this.applyStatus(status);
    } catch (e) {
      if (seq !== this.refreshSeq) return;
      const info = this.fail(e);
      if (REPO_LEVEL.has(info.code)) this.set({ phase: "error", fatal: info, status: null, groups: EMPTY_GROUPS, rows: [] });
      else this.set({ notice: { kind: "error", info, text: info.title } });
    }
  }

  private applyStatus(status: ScmStatus) {
    const groups = buildGroups(status.entries);
    const selection = pruneSelection(this.snap.selection, groups);
    const rows = flatten(groups, this.snap.collapsed);
    const focusKey = this.snap.focusKey && rows.some((r) => rowKey(r) === this.snap.focusKey) ? this.snap.focusKey : null;
    this.set({
      phase: "ready", fatal: null, status, groups, rows, selection, focusKey,
      counts: { staged: groups.staged.length, changes: groups.changes.length, untracked: groups.untracked.length, conflicts: groups.conflicts.length },
    });
  }

  private async loadIdentity(): Promise<void> {
    try {
      const value = await this.api.identity();
      this.set({ identity: { state: "ok", value } });
    } catch (e) {
      const err = toScmError(e);
      if (err.code === "identity_missing") this.set({ identity: { state: "missing", value: null } });
      // Repo-level errors surface through status; anything else leaves the identity unknown.
    }
  }

  setTab(tab: ScmTab) {
    this.set({ tab });
    if (tab === "history" && this.snap.history.entries.length === 0 && !this.snap.history.loading) void this.loadLog(true);
    if (tab === "branches") {
      void this.loadBranches();
      void this.loadTags();
      void this.loadStashes();
    }
  }

  dismissNotice() {
    this.set({ notice: null });
  }

  // ---- list state ------------------------------------------------------------------------------------------

  toggleGroup(id: GroupId) {
    const collapsed = new Set(this.snap.collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    this.set({ collapsed, rows: flatten(this.snap.groups, collapsed) });
  }

  select(key: string, mods: { shift: boolean; toggle: boolean }) {
    this.set({ selection: selectRow(this.snap.selection, this.snap.rows, key, mods), focusKey: key });
  }

  clearSelection() {
    this.set({ selection: NO_SELECTION });
  }

  setFocus(key: string | null) {
    this.set({ focusKey: key });
  }

  /** Moves the keyboard focus row by `delta` (skips nothing: headers are focusable too). */
  moveFocus(delta: number): string | null {
    const { rows, focusKey } = this.snap;
    if (rows.length === 0) return null;
    const cur = focusKey ? rows.findIndex((r) => rowKey(r) === focusKey) : -1;
    const next = Math.min(rows.length - 1, Math.max(0, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta));
    const key = rowKey(rows[next]);
    this.set({ focusKey: key });
    return key;
  }

  setMessage(message: string) {
    this.set({ message });
  }

  // ---- staging ---------------------------------------------------------------------------------------------

  private async run<T>(label: string, fn: () => Promise<T>, after: { refresh?: boolean } = { refresh: true }): Promise<T | undefined> {
    if (this.snap.busy) return undefined;
    this.set({ busy: label, notice: null });
    try {
      return await fn();
    } catch (e) {
      const info = this.fail(e);
      this.set({ notice: { kind: info.code === "cancelled" ? "info" : "error", info, text: info.title } });
      return undefined;
    } finally {
      this.set({ busy: null });
      if (after.refresh) await this.refresh();
    }
  }

  private async setStaged(items: readonly FileItem[], stage: boolean) {
    const paths = [...new Set(items.map((i) => i.entry.path))];
    if (paths.length === 0) return;
    await this.run(stage ? "Staging" : "Unstaging", async () => {
      for (const part of chunk(paths, STAGE_CHUNK)) await this.api.stage(part, stage);
    });
  }

  async stageSelected() {
    await this.setStaged(actionsFor(selectedItems(this.snap.groups, this.snap.selection)).stage, true);
  }
  async unstageSelected() {
    await this.setStaged(actionsFor(selectedItems(this.snap.groups, this.snap.selection)).unstage, false);
  }
  async stageItem(item: FileItem) {
    await this.setStaged([item], true);
  }
  async unstageItem(item: FileItem) {
    await this.setStaged([item], false);
  }

  async stageAll(stage: boolean) {
    await this.run(stage ? "Staging all" : "Unstaging all", () => this.api.stageAll(stage));
  }

  /** The host asks in a native dialog naming the files; "Cancel" there is `cancelled` and changes nothing. */
  async discard(items: readonly FileItem[]) {
    const targets = actionsFor(items).discard;
    if (targets.length === 0) return;
    if (targets.length > MAX_DISCARD) {
      this.set({ notice: { kind: "error", info: describeError("too_large", `Select at most ${MAX_DISCARD} files to discard at once.`), text: "Too many files" } });
      return;
    }
    const res = await this.run("Discarding", () => this.api.discard(targets.map((t) => t.entry.path)));
    if (res) {
      this.set({ notice: { kind: "info", info: null, text: `Discarded ${res.restored} changed and ${res.trashed} untracked item(s).` } });
      this.opts.onFilesChanged?.();
    }
  }
  async discardSelected() {
    await this.discard(selectedItems(this.snap.groups, this.snap.selection));
  }

  // ---- hunks -----------------------------------------------------------------------------------------------

  async openHunks(path: string, staged: boolean) {
    const seq = ++this.hunkSeq;
    this.set({ hunks: { path, staged, status: "loading", diff: null, selected: new Set(), error: null } });
    try {
      const diff = await this.api.diffHunks(path, staged);
      if (seq !== this.hunkSeq) return;
      this.set({ hunks: { path, staged, status: "ready", diff, selected: new Set(), error: null } });
    } catch (e) {
      if (seq !== this.hunkSeq) return;
      this.set({ hunks: { path, staged, status: "error", diff: null, selected: new Set(), error: this.fail(e) } });
    }
  }

  closeHunks() {
    this.hunkSeq++;
    this.set({ hunks: null });
  }

  toggleHunkAt(i: number) {
    const h = this.snap.hunks;
    if (h) this.set({ hunks: { ...h, selected: toggleHunk(h.selected, i) } });
  }

  selectAllHunksNow() {
    const h = this.snap.hunks;
    if (h?.diff) this.set({ hunks: { ...h, selected: selectAllHunks(h.diff.hunks.length) } });
  }

  clearHunks() {
    const h = this.snap.hunks;
    if (h) this.set({ hunks: { ...h, selected: new Set() } });
  }

  async applyHunks() {
    const h = this.snap.hunks;
    if (!h?.diff || h.diff.truncated) return;
    const idx = hunkIndexes(h.selected, h.diff.hunks.length);
    if (idx.length === 0) return;
    const diffId = h.diff.diff_id;
    const ok = await this.run(h.staged ? "Unstaging hunks" : "Staging hunks", async () => {
      await this.api.stageHunks(h.path, h.staged, diffId, idx);
      return true;
    }, { refresh: false });
    // Always reload: after success the hunks moved, after `changed` the ids are stale.
    await Promise.all([this.refresh(), this.snap.hunks && this.snap.hunks.path === h.path ? this.openHunks(h.path, h.staged) : Promise.resolve()]);
    if (ok) this.set({ notice: { kind: "info", info: null, text: `${idx.length} hunk(s) ${h.staged ? "unstaged" : "staged"}.` } });
  }

  // ---- commit ----------------------------------------------------------------------------------------------

  commitCheck() {
    const c = this.snap.counts;
    return validateCommit(this.snap.message, c.staged, c.conflicts);
  }

  async commit() {
    const check = this.commitCheck();
    if (!check.ok) {
      this.set({ notice: { kind: "error", info: null, text: check.reason } });
      return;
    }
    const message = this.snap.message;
    const res = await this.run("Committing", () => this.api.commit(message));
    if (res) {
      this.set({ message: "", notice: { kind: "info", info: null, text: committedText(res.hash, res.skipped ?? []) }, history: { ...this.snap.history, entries: [], hasMore: false, open: null } });
      if (this.snap.tab === "history") void this.loadLog(true);
    } else if (this.snap.notice?.info?.code === "identity_missing") {
      this.set({ identity: { state: "missing", value: null } });
    }
  }

  // ---- amend ------------------------------------------------------------------------------------------------

  /** Amends HEAD with the staged changes (and the message, when there is one). The host asks natively. */
  async amend(message: string): Promise<boolean> {
    const check = validateAmend(message, this.snap.counts.staged, this.snap.counts.conflicts);
    if (!check.ok) {
      this.set({ notice: { kind: "error", info: null, text: check.reason } });
      return false;
    }
    const res = await this.run("Amending", () => this.api.commitAmend(message.trim() ? message : undefined, false));
    if (res) {
      this.set({ message: "", pendingAmend: null, notice: { kind: "info", info: null, text: `Amended the last commit. It is now ${res.hash}.` }, history: { ...this.snap.history, entries: [], hasMore: false, open: null } });
      if (this.snap.tab === "history") void this.loadLog(true);
      return true;
    }
    if (this.snap.notice?.info?.code === "already_pushed") {
      // Not an error to show red: the page asks once more, in-page, and the host asks natively a second time.
      this.set({ pendingAmend: { message }, notice: { kind: "info", info: null, text: "This commit is already on a remote branch." } });
    } else if (this.snap.notice?.info?.code === "identity_missing") {
      this.set({ identity: { state: "missing", value: null } });
    }
    return false;
  }

  /** The second step after `already_pushed`: amends the published commit (its id changes). */
  async amendAnyway() {
    const p = this.snap.pendingAmend;
    if (!p) return;
    this.set({ pendingAmend: null });
    const res = await this.run("Amending", () => this.api.commitAmend(p.message.trim() ? p.message : undefined, true));
    if (res) {
      this.set({ message: "", notice: { kind: "info", info: null, text: `Amended the last commit. It is now ${res.hash}. A later push will need a force push.` }, history: { ...this.snap.history, entries: [], hasMore: false, open: null } });
      if (this.snap.tab === "history") void this.loadLog(true);
    }
  }

  cancelAmendAnyway() {
    this.set({ pendingAmend: null });
  }

  // ---- merge -----------------------------------------------------------------------------------------------

  /** Merges a local branch into the current one (fast-forward when git can). The host asks natively and names both. */
  async mergeBranch(name: string): Promise<void> {
    const bad = branchNameError(name);
    if (bad) {
      this.set({ notice: { kind: "error", info: describeError("invalid_ref", bad), text: bad } });
      return;
    }
    const res = await this.run("Merging", () => this.api.merge(name, "ff"));
    if (!res) return;
    if (res.status === "merged") {
      this.set({ notice: { kind: "info", info: null, text: res.fast_forward ? `Merged ${displayLine(name)}. Fast-forwarded to ${res.hash}.` : `Merged ${displayLine(name)}. Merge commit ${res.hash} was made.` } });
    } else {
      const listed = res.paths.slice(0, 10).map((p) => displayLine(p)).join(", ");
      const more = res.paths.length > 10 || res.truncated ? " and more" : "";
      this.set({ notice: { kind: "info", info: null, text: `The merge stopped with conflicts in ${res.paths.length}${res.truncated ? "+" : ""} file(s): ${listed}${more}. Resolve them in Changes, stage each one, then commit. Or abort the merge.` } });
    }
    await this.loadBranches();
    this.opts.onFilesChanged?.();
  }

  /** `git merge --abort` (the host asks natively; edits made to resolve conflicts are lost). */
  async abortMerge() {
    await this.run("Aborting merge", () => this.api.mergeAbort());
    await this.loadBranches();
    this.opts.onFilesChanged?.();
  }

  // ---- discard all -----------------------------------------------------------------------------------------

  /** Restores every tracked change to HEAD. Untracked files go to the Trash only when `includeUntracked` is set. */
  async discardAll(includeUntracked: boolean) {
    const res = await this.run("Discarding all", () => this.api.discardAll(includeUntracked));
    if (!res) return;
    const trash = res.trashed ? ` Moved ${res.trashed} untracked item(s) to the Trash.` : "";
    const kept = res.skipped ? ` ${res.skipped} item(s) were left in place.` : "";
    this.set({ notice: { kind: "info", info: null, text: `Restored ${res.restored} changed file(s) to HEAD.${trash}${kept}` } });
    this.opts.onFilesChanged?.();
  }

  // ---- branches --------------------------------------------------------------------------------------------

  async loadTags() {
    this.set({ tags: { ...this.snap.tags, loading: true, error: null } });
    try {
      const l = await this.api.tags();
      this.set({ tags: { list: l.tags, truncated: l.truncated, loading: false, error: null } });
    } catch (e) {
      this.set({ tags: { ...this.snap.tags, loading: false, error: this.fail(e) } });
    }
  }

  async loadBranches() {
    this.set({ branches: { ...this.snap.branches, loading: true, error: null } });
    try {
      const l = await this.api.branches();
      this.set({ branches: { list: l.branches, truncated: l.truncated, loading: false, error: null } });
    } catch (e) {
      this.set({ branches: { ...this.snap.branches, loading: false, error: this.fail(e) } });
    }
  }

  async checkout(name: string) {
    const bad = branchNameError(name);
    if (bad) {
      this.set({ notice: { kind: "error", info: describeError("invalid_ref", bad), text: bad } });
      return;
    }
    let switched = false;
    await this.run("Switching branch", async () => {
      await this.api.checkout(name);
      switched = true;
    });
    // Only a switch that happened changes what history and the open hunks show; a refused one leaves them alone.
    if (switched) this.set({ history: { entries: [], hasMore: false, loading: false, error: null, open: null }, hunks: null });
    await this.loadBranches();
    this.opts.onFilesChanged?.();
  }

  async createBranch(name: string): Promise<boolean> {
    const bad = branchNameError(name);
    if (bad) {
      this.set({ notice: { kind: "error", info: describeError("invalid_ref", bad), text: bad } });
      return false;
    }
    const ok = await this.run("Creating branch", async () => {
      await this.api.createBranch(name);
      return true;
    });
    await this.loadBranches();
    return !!ok;
  }

  // ---- branch delete ---------------------------------------------------------------------------------------

  /** Never forced: a branch with unmerged commits is kept and the user gets the second, explicit step. */
  async deleteBranch(name: string): Promise<void> {
    await this.runBranchDelete(name, false);
  }

  async forceDeleteBranch(): Promise<void> {
    const p = this.snap.pendingBranchDelete;
    if (p) await this.runBranchDelete(p.name, true);
  }

  cancelBranchDelete() {
    this.set({ pendingBranchDelete: null });
  }

  private async runBranchDelete(name: string, force: boolean): Promise<void> {
    const bad = branchNameError(name);
    if (bad) {
      this.set({ notice: { kind: "error", info: describeError("invalid_ref", bad), text: bad } });
      return;
    }
    if (this.snap.status?.branch === name) {
      const text = "You are on this branch. Switch to another branch, then delete it.";
      this.set({ notice: { kind: "error", info: describeError("current_branch", text), text } });
      return;
    }
    const res = await this.run("Deleting branch", () => this.api.branchDelete(name, force));
    if (res?.status === "not_merged") {
      this.set({
        pendingBranchDelete: { name, tip: res.tip, unique: res.unique_commits },
        notice: { kind: "info", info: null, text: `Branch ${name} has commits that are not merged, so Git kept it.` },
      });
    } else if (res) {
      this.set({ pendingBranchDelete: null, notice: { kind: "info", info: null, text: `Deleted branch ${name}.` } });
    }
    await this.loadBranches();
  }

  // ---- tags (create) ---------------------------------------------------------------------------------------

  /** Validated here, then by the host (which never moves an existing tag). Resolves true when the tag was created. */
  async createTag(name: string, message: string): Promise<boolean> {
    const bad = tagNameError(name) ?? messageError("tag", message);
    if (bad) {
      this.set({ notice: { kind: "error", info: null, text: bad } });
      return false;
    }
    const res = await this.run("Creating tag", () => this.api.tagCreate(name, message.trim() ? message : undefined));
    await this.loadTags();
    if (!res) return false;
    this.set({ notice: { kind: "info", info: null, text: `Created tag ${name}.` } });
    return true;
  }

  // ---- stash -----------------------------------------------------------------------------------------------

  async loadStashes() {
    this.set({ stashes: { ...this.snap.stashes, loading: true, error: null } });
    try {
      const l = await this.api.stashList();
      this.set({ stashes: { list: l.stashes, truncated: l.truncated, loading: false, error: null } });
    } catch (e) {
      this.set({ stashes: { ...this.snap.stashes, loading: false, error: this.fail(e) } });
    }
  }

  /** Stashes the working tree (tracked changes, plus untracked files when asked). Resolves true when it stashed. */
  async stashChanges(message: string, includeUntracked: boolean): Promise<boolean> {
    const bad = messageError("stash", message);
    if (bad) {
      this.set({ notice: { kind: "error", info: null, text: bad } });
      return false;
    }
    const res = await this.run("Stashing", async () => {
      await this.api.stashPush(message, includeUntracked);
      return true;
    });
    await this.loadStashes();
    if (!res) return false;
    this.set({ notice: { kind: "info", info: null, text: "Stashed the changes." } });
    return true;
  }

  async applyStash(st: Stash) {
    await this.stashOp("Applying stash", () => this.api.stashApply(st.index, st.hash), "Applied the stash. It is still in the list.");
  }

  async popStash(st: Stash) {
    await this.stashOp("Popping stash", () => this.api.stashPop(st.index, st.hash), "Popped the stash.");
  }

  askDropStash(stash: Stash) {
    this.set({ pendingStashDrop: stash });
  }

  cancelDropStash() {
    this.set({ pendingStashDrop: null });
  }

  async dropStash() {
    const p = this.snap.pendingStashDrop;
    if (!p) return;
    this.set({ pendingStashDrop: null });
    await this.stashOp("Dropping stash", () => this.api.stashDrop(p.index, p.hash), "Dropped the stash.");
  }

  private async stashOp(label: string, fn: () => Promise<void>, done: string) {
    const res = await this.run(label, async () => {
      await fn();
      return true;
    });
    await this.loadStashes();
    if (res) this.set({ notice: { kind: "info", info: null, text: done } });
  }

  // ---- history ---------------------------------------------------------------------------------------------

  async loadLog(reset: boolean) {
    const h = this.snap.history;
    if (h.loading) return;
    const seq = ++this.logSeq;
    const skip = reset ? 0 : h.entries.length;
    this.set({ history: { ...h, entries: reset ? [] : h.entries, loading: true, error: null, open: reset ? null : h.open } });
    try {
      const page = await this.api.log(skip, LOG_PAGE);
      if (seq !== this.logSeq) return;
      const cur = this.snap.history;
      this.set({ history: { ...cur, entries: reset ? page.entries : [...cur.entries, ...page.entries], hasMore: page.has_more, loading: false } });
    } catch (e) {
      if (seq !== this.logSeq) return;
      this.set({ history: { ...this.snap.history, loading: false, error: this.fail(e) } });
    }
  }

  async openCommit(hash: string) {
    const base = { hash, status: "loading" as const, detail: null, file: null, diff: null, diffLoading: false, error: null };
    this.set({ history: { ...this.snap.history, open: base } });
    try {
      const detail = await this.api.commitFiles(hash);
      if (this.snap.history.open?.hash !== hash) return;
      this.set({ history: { ...this.snap.history, open: { ...base, status: "ready", detail } } });
    } catch (e) {
      if (this.snap.history.open?.hash !== hash) return;
      this.set({ history: { ...this.snap.history, open: { ...base, status: "error", error: this.fail(e) } } });
    }
  }

  closeCommit() {
    this.set({ history: { ...this.snap.history, open: null } });
  }

  async openCommitFile(path: string) {
    const o = this.snap.history.open;
    if (!o) return;
    this.set({ history: { ...this.snap.history, open: { ...o, file: path, diff: null, diffLoading: true } } });
    try {
      const diff = await this.api.commitDiff(o.hash, path);
      const cur = this.snap.history.open;
      if (!cur || cur.hash !== o.hash || cur.file !== path) return;
      this.set({ history: { ...this.snap.history, open: { ...cur, diff: { text: displayText(diff.text), truncated: diff.truncated }, diffLoading: false } } });
    } catch (e) {
      const cur = this.snap.history.open;
      if (!cur || cur.hash !== o.hash || cur.file !== path) return;
      this.set({ history: { ...this.snap.history, open: { ...cur, diffLoading: false, error: this.fail(e) } } });
    }
  }
}

export { GROUP_ORDER, ScmError };

/**
 * The notice after a commit. The host never runs commit hooks and never signs; when this repository or user relies on
 * either, the notice says so, since a skipped secret scanner or an unsigned commit is otherwise noticed only at push.
 */
export function committedText(hash: string, skipped: readonly string[]): string {
  const hooks = skipped.includes("hooks") ? "This repository's commit hooks were not run. " : "";
  const signing = skipped.includes("signing") ? "The commit is not signed (your git is set to sign commits; LLM-IDE does not). " : "";
  return `Committed ${hash}. ${hooks}${signing}`;
}
