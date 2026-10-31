// Source Control controller: owns status, selection, hunks, commit form, branches and history for one project.
// All git work goes through `ScmApi` (the Rust host); this class holds no git knowledge beyond sequencing,
// stale-response guards and wording. `subscribe` / `getSnapshot` fit React's `useSyncExternalStore`.
import {
  ScmError, toScmError,
  type Branch, type CommitDetail, type HunkDiff, type Identity, type LogEntry, type ScmApi, type ScmStatus,
} from "./api";
import {
  GROUP_ORDER, MAX_DISCARD, NO_SELECTION, STAGE_CHUNK, actionsFor, branchNameError, buildGroups, chunk, describeError, displayText,
  flatten, hunkIndexes, pruneSelection, rowKey, selectAllHunks, selectRow, selectedItems, toggleHunk, validateCommit,
  type ErrorInfo, type FileItem, type GroupId, type Groups, type Row, type Selection,
} from "./model";

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
  history: HistoryState;
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
      history: { entries: [], hasMore: false, loading: false, error: null, open: null },
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
    if (tab === "branches") void this.loadBranches();
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
      this.set({ message: "", notice: { kind: "info", info: null, text: `Committed ${res.hash}. ` }, history: { ...this.snap.history, entries: [], hasMore: false, open: null } });
      if (this.snap.tab === "history") void this.loadLog(true);
    } else if (this.snap.notice?.info?.code === "identity_missing") {
      this.set({ identity: { state: "missing", value: null } });
    }
  }

  // ---- branches --------------------------------------------------------------------------------------------

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
    await this.run("Switching branch", () => this.api.checkout(name));
    this.set({ history: { entries: [], hasMore: false, loading: false, error: null, open: null }, hunks: null });
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
