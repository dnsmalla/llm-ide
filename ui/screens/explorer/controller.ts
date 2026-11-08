// Explorer controller: tree paging, tabs, documents, save/conflict flow, watcher and git decoration.
// React-free and host-free (the fs bridge and the editor are injected), so the whole flow is tested
// with an in-memory fake. The UI subscribes to immutable snapshots.
import { FsError, baseName, joinPath, parentOf, toFsError, type Entry, type FsApi, type GitStatus, type ReadResult, type WatchBatch } from "./fs";
import { LARGE_FILE_BYTES, type EditorHost } from "./editor-types";
import {
  PAGE_SIZE, applySelect, buildLayout, emptyTree, invalidate, pagesNeeded, pruneCollapsed, rowsInRange, topLevel, unloadedExpanded,
  withError, withExpanded, withLoading, withPage, NO_SELECTION, type Layout, type Mods, type Row, type Selection, type TreeState,
} from "./tree-model";
import { emptyTabs, requestClose, restoreTabs, serializeTabs, tabsReduce, type CloseOutcome, type TabsAction, type TabsState } from "./tabs-model";
import { beginSave, keepMine, newDoc, onDiskProbe, reloaded, saveFailed, saveSucceeded, type DocState } from "./conflict";
import { languageFor } from "./lang";
import { defaultKv, loadSession, saveSession, type KV } from "./session";

export type DocStatus = "loading" | "ready" | "binary" | "too_large" | "range" | "error";

export interface DocView {
  state: DocState;
  status: DocStatus;
  size: number;
  readOnly: boolean;
  language: string;
  encoding: ReadResult["encoding"];
  bom: boolean;
  eol: ReadResult["eol"];
  error: string | null;
  /** Range view ("open anyway" on a large file): next byte offset to load, or null at the end. */
  rangeNext: number | null;
}

export type GitDeco = "modified" | "added" | "untracked" | "deleted" | "conflicted";

/** What the host can watch: `fs_watch_set` refuses more than MAX_DIRS, and the UI caps below it. */
export const WATCH_DIR_CAP = 500;

export interface Notice {
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ExplorerSnapshot {
  root: string | null;
  /** The tree's root, relative to `root` (the Mac Explorer roots at the project's `code/`; "" = project root). */
  treeBase: string;
  tree: TreeState;
  layout: Layout;
  selection: Selection;
  focusPath: string | null;
  tabs: TabsState;
  docs: ReadonlyMap<string, DocView>;
  git: { branch: string | null; ahead: number; behind: number; deco: ReadonlyMap<string, GitDeco>; dirs: ReadonlySet<string>; error: string | null } | null;
  diffPath: string | null;
  watchMode: "native" | "poll" | "off";
  notice: Notice | null;
  showHidden: boolean;
  hideIgnored: boolean;
  version: number;
}

export interface ControllerDeps {
  fs: FsApi;
  editor?: () => EditorHost | null;
  kv?: KV | null;
  pageSize?: number;
  /** Debounce for git refresh and session save, ms. Tests pass 0. */
  settleMs?: number;
}

const MAX_WATCH_REFRESH_PAGES = 20;
/** Any line break (CR, LF, VT, FF, NEL, LS, PS): a name holding one tears across the records this app writes one per line. */
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
const RANGE_BYTES = 1024 * 1024;

export function gitDecoFor(index: string, worktree: string, kind: string): GitDeco {
  if (kind === "untracked") return "untracked";
  if (kind === "unmerged" || index === "U" || worktree === "U") return "conflicted";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "A") return "added";
  return "modified";
}

export class ExplorerController {
  private fs: FsApi;
  private getEditor: () => EditorHost | null;
  private kv: KV | null;
  private pageSize: number;
  private settleMs: number;
  private gen = 0;
  private listeners = new Set<() => void>();
  private snap: ExplorerSnapshot;
  private pendingText = new Map<string, ReadResult>();
  private clipboard: { mode: "copy" | "cut"; paths: string[] } | null = null;
  private gitTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = new Set<string>();
  private treeWidth: number | null = null;
  private treeBase = "";
  /** The host watches at most this many folders (desktop/src-tauri/src/fs_watch.rs MAX_DIRS). */
  private watchCapped = false;
  private watchErrorShown = false;

  constructor(deps: ControllerDeps) {
    this.fs = deps.fs;
    this.getEditor = deps.editor ?? (() => null);
    this.kv = deps.kv === undefined ? defaultKv() : deps.kv;
    this.pageSize = deps.pageSize ?? PAGE_SIZE;
    this.settleMs = deps.settleMs ?? 400;
    this.snap = this.blank(null);
  }

  // ---- store ----------------------------------------------------------------------------

  getSnapshot = (): ExplorerSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private blank(root: string | null): ExplorerSnapshot {
    const tree = withExpanded(emptyTree(this.pageSize), this.treeBase, true);
    return {
      root, treeBase: this.treeBase, tree,
      layout: root === null ? { count: 0, segs: [], starts: [] } : buildLayout(tree, this.treeBase),
      selection: NO_SELECTION, focusPath: null, tabs: emptyTabs, docs: new Map(), git: null,
      diffPath: null, watchMode: "off", notice: null, showHidden: false, hideIgnored: false, version: 0,
    };
  }

  private set(patch: Partial<ExplorerSnapshot>): void {
    const next = { ...this.snap, ...patch, version: this.snap.version + 1 };
    if (patch.tree && !patch.layout) next.layout = buildLayout(next.tree, this.treeBase);
    this.snap = next;
    for (const l of [...this.listeners]) l();
  }

  private notify(severity: Notice["severity"], message: string): void {
    this.set({ notice: { severity, message } });
  }

  dismissNotice(): void {
    if (this.snap.notice) this.set({ notice: null });
  }

  rowsFor(from: number, to: number): Row[] {
    return rowsInRange(this.snap.layout, from, to, this.snap.tree);
  }

  // ---- lifecycle ------------------------------------------------------------------------

  /**
   * (Re)open for a project root; null closes. Everything from the previous root is dropped. `treeBase` is the tree's
   * root relative to the project (the Mac Explorer shows the project's `code/` folder, not the whole project); when
   * that folder does not exist the tree falls back to the project root.
   */
  async init(root: string | null, treeBase = ""): Promise<void> {
    const gen = ++this.gen;
    this.flushSession(); // save the previous project's session before its timer is cleared
    this.clearTimers();
    void this.fs.watchStop().catch(() => undefined);
    this.pendingText.clear();
    let base = root && treeBase ? treeBase : "";
    if (base) {
      try {
        await this.fs.list(base, { offset: 0, limit: 1, show_hidden: false, gitignore: true, hide_ignored: true });
      } catch {
        base = "";
      }
      if (gen !== this.gen) return; // superseded while the folder check was in flight
    }
    this.treeBase = base;
    this.snap = this.blank(root);
    for (const l of [...this.listeners]) l();
    if (!root) return;
    const session = loadSession(this.kv, root);
    this.treeWidth = session.treeWidth;
    let tree = withExpanded(emptyTree(this.pageSize), this.treeBase, true);
    for (const p of session.expanded) tree = withExpanded(tree, p, true);
    const tabs = session.tabs ? restoreTabs(session.tabs) : emptyTabs;
    this.set({ tree, tabs });
    await this.ensureExpandedLoaded(gen);
    if (gen !== this.gen) return;
    void this.startWatching(gen);
    void this.refreshGit();
    // Restore the active tab first, the others lazily when activated.
    if (tabs.activeId) await this.loadDoc(tabs.activeId, gen);
  }

  dispose(): void {
    this.gen++;
    this.clearTimers();
    void this.fs.watchStop().catch(() => undefined);
    this.listeners.clear();
  }

  private clearTimers(): void {
    for (const t of [this.gitTimer, this.sessionTimer, this.watchTimer]) if (t) clearTimeout(t);
    this.gitTimer = this.sessionTimer = this.watchTimer = null;
  }

  /** The editor became available (Monaco chunk loaded): give it the documents read before it existed. */
  attachEditor(): void {
    const ed = this.getEditor();
    if (!ed) return;
    for (const [path, r] of this.pendingText) this.openInEditor(ed, path, r);
    this.pendingText.clear();
    const active = this.snap.tabs.activeId;
    if (active) this.showActive();
  }

  // ---- tree -----------------------------------------------------------------------------

  private listOpts(offset: number) {
    return { offset, limit: this.pageSize, show_hidden: this.snap.showHidden, gitignore: true, hide_ignored: this.snap.hideIgnored };
  }

  async loadPage(dir: string, page: number, gen = this.gen): Promise<void> {
    const d = this.snap.tree.dirs.get(dir);
    if (d?.loading.has(page) || d?.pages.has(page)) return;
    this.set({ tree: withLoading(this.snap.tree, dir, page) });
    try {
      const r = await this.fs.list(dir, this.listOpts(page * this.pageSize));
      if (gen !== this.gen) return;
      this.set({ tree: withPage(this.snap.tree, dir, page, r.entries, r.total) });
    } catch (e) {
      if (gen !== this.gen) return;
      this.set({ tree: withError(this.snap.tree, dir, page, toFsError(e).message) });
    }
  }

  /** Called by the view with the pages its window needs. */
  requestPages(rows: Row[]): void {
    for (const { dir, page } of pagesNeeded(rows, this.snap.tree)) void this.loadPage(dir, page);
    void this.ensureExpandedLoaded(this.gen);
  }

  private async ensureExpandedLoaded(gen: number): Promise<void> {
    const todo = [this.treeBase, ...unloadedExpanded(this.snap.tree)].filter((p) => !this.snap.tree.dirs.has(p) && !this.snap.tree.dirs.get(p)?.loading.has(0));
    await Promise.all(todo.map((p) => this.loadPage(p, 0, gen)));
  }

  async toggleDir(path: string, open?: boolean): Promise<void> {
    const want = open ?? !this.snap.tree.expanded.has(path);
    this.set({ tree: withExpanded(this.snap.tree, path, want) });
    if (want) await this.ensureExpandedLoaded(this.gen);
    else this.set({ tree: pruneCollapsed(this.snap.tree) });
    this.syncWatch();
    this.queueSession();
  }

  /** The Mac's Collapse All: close every folder except the tree's base, dropping their cached pages. */
  collapseAll(): void {
    let tree = this.snap.tree;
    for (const p of [...tree.expanded]) if (p !== this.treeBase) tree = withExpanded(tree, p, false);
    this.set({ tree: pruneCollapsed(tree) });
    this.syncWatch();
    this.queueSession();
  }

  setFocus(path: string | null): void {
    if (path !== this.snap.focusPath) this.set({ focusPath: path });
  }

  select(path: string, mods: Mods): void {
    this.set({ selection: applySelect(this.snap.selection, this.snap.layout, this.snap.tree, path, mods), focusPath: path });
  }

  setShowHidden(v: boolean): void {
    this.set({ showHidden: v });
    void this.reloadAllDirs();
  }

  setHideIgnored(v: boolean): void {
    this.set({ hideIgnored: v });
    void this.reloadAllDirs();
  }

  private async reloadAllDirs(): Promise<void> {
    const gen = this.gen;
    const dirs = [...this.snap.tree.dirs.keys()];
    let tree = this.snap.tree;
    for (const d of dirs) tree = invalidate(tree, d);
    this.set({ tree });
    await this.ensureExpandedLoaded(gen);
  }

  /** Reloads a folder's loaded pages in place (no flicker); pages beyond a budget reload on demand. */
  async refreshDir(dir: string): Promise<void> {
    const gen = this.gen;
    const old = this.snap.tree.dirs.get(dir);
    if (!old || this.refreshing.has(dir)) return;
    this.refreshing.add(dir);
    try {
      const loaded = [...old.pages.keys()].sort((a, b) => a - b);
      const first = await this.fs.list(dir, this.listOpts(0));
      if (gen !== this.gen) return;
      let tree = withPage(invalidate(this.snap.tree, dir), dir, 0, first.entries, first.total);
      const extra = loaded.filter((p) => p > 0 && p * this.pageSize < first.total).slice(0, MAX_WATCH_REFRESH_PAGES);
      for (const p of extra) {
        const r = await this.fs.list(dir, this.listOpts(p * this.pageSize));
        if (gen !== this.gen) return;
        tree = withPage(tree, dir, p, r.entries, r.total);
      }
      this.set({ tree });
    } catch (e) {
      if (gen === this.gen) {
        const err = toFsError(e);
        // The folder is gone: forget it and refresh its parent.
        if (err.code === "not_found" || err.code === "not_a_directory") {
          this.set({ tree: invalidate(withExpanded(this.snap.tree, dir, false), dir) });
          if (dir !== "" && dir !== this.treeBase) void this.refreshDir(parentOf(dir));
        }
      }
    } finally {
      this.refreshing.delete(dir);
    }
  }

  // ---- documents ------------------------------------------------------------------------

  private patchDoc(path: string, fn: (d: DocView) => DocView): void {
    const cur = this.snap.docs.get(path);
    if (!cur) return;
    const docs = new Map(this.snap.docs);
    docs.set(path, fn(cur));
    this.set({ docs });
  }

  private setDoc(path: string, d: DocView): void {
    const docs = new Map(this.snap.docs);
    docs.set(path, d);
    this.set({ docs });
  }

  private blankDoc(path: string, status: DocStatus, extra: Partial<DocView> = {}): DocView {
    return {
      state: newDoc(path, null), status, size: 0, readOnly: true, language: languageFor(path), encoding: "utf-8", bom: false, eol: "none",
      error: null, rangeNext: null, ...extra,
    };
  }

  private openInEditor(ed: EditorHost, path: string, r: ReadResult): void {
    if (r.status !== "ok" || r.text === null) return;
    const large = r.size > LARGE_FILE_BYTES;
    ed.open({ path, text: r.text, language: large ? "plaintext" : languageFor(path), readOnly: r.read_only, large });
  }

  private async loadDoc(path: string, gen = this.gen): Promise<void> {
    const existing = this.snap.docs.get(path);
    const ed = this.getEditor();
    // A live model (with its unsaved edits) is authoritative; only re-read when it is gone.
    if (existing && (existing.status === "binary" || existing.status === "too_large" || existing.status === "range" || (ed?.has(path) ?? false))) {
      this.showActive();
      return;
    }
    if (!existing) this.setDoc(path, this.blankDoc(path, "loading"));
    try {
      const r = await this.fs.read(path);
      if (gen !== this.gen) return;
      const base = this.blankDoc(path, "ready", { size: r.size, readOnly: r.read_only, encoding: r.encoding, bom: r.bom, eol: r.eol });
      if (r.status === "binary") this.setDoc(path, { ...base, status: "binary" });
      else if (r.status === "too_large") this.setDoc(path, { ...base, status: "too_large" });
      else {
        this.setDoc(path, { ...base, state: newDoc(path, r.hash) });
        const e = this.getEditor();
        if (e) this.openInEditor(e, path, r);
        else this.pendingText.set(path, r);
      }
      this.showActive();
    } catch (e) {
      if (gen !== this.gen) return;
      const err = toFsError(e);
      this.setDoc(path, this.blankDoc(path, "error", { error: err.message }));
      if (err.code === "not_found") this.dispatchTabs({ type: "removed", id: path });
    }
  }

  private showActive(): void {
    const ed = this.getEditor();
    const id = this.snap.tabs.activeId;
    if (!ed) return;
    if (!id) {
      ed.showNone();
      return;
    }
    const d = this.snap.docs.get(id);
    if (d?.status === "ready" || d?.status === "range") {
      if (!ed.show(id)) void this.loadDoc(id);
      if (this.snap.diffPath && this.snap.diffPath !== id) this.set({ diffPath: null });
    } else ed.showNone();
  }

  private dispatchTabs(a: TabsAction): void {
    const tabs = tabsReduce(this.snap.tabs, a);
    if (tabs !== this.snap.tabs) {
      this.set({ tabs });
      this.queueSession();
    }
  }

  /** Open from the tree: single click = preview, double click / Enter = regular tab. */
  async openFile(path: string, preview = true): Promise<void> {
    this.dispatchTabs({ type: "open", path, preview });
    this.syncWatch();
    await this.loadDoc(path);
  }

  /** Open a file as a regular tab and put the cursor at `line` / `col` (search results, cross-screen requests). */
  async openAt(path: string, line: number, col = 1): Promise<void> {
    await this.openFile(path, false);
    this.getEditor()?.reveal?.(path, line, col);
  }

  async activateTab(id: string): Promise<void> {
    this.dispatchTabs({ type: "activate", id });
    await this.loadDoc(id);
  }

  promoteTab(id: string): void {
    this.dispatchTabs({ type: "promote", id });
  }

  pinTab(id: string, pinned: boolean): void {
    this.dispatchTabs({ type: "pin", id, pinned });
  }

  moveTab(id: string, to: number): void {
    this.dispatchTabs({ type: "move", id, to });
  }

  /** Dirty change reported by the editor. */
  onEditorDirty(path: string, dirty: boolean): void {
    this.patchDoc(path, (d) => ({ ...d, state: { ...d.state, dirty } }));
    this.dispatchTabs({ type: "edit", id: path, dirty });
  }

  /** Close outcome; the UI shows the prompt on `prompt` and then calls `discardAndClose` or `saveAndClose`. */
  requestClose(id: string): CloseOutcome {
    const o = requestClose(this.snap.tabs, id);
    if (o === "close") this.closeNow(id);
    return o;
  }

  private closeNow(id: string): void {
    this.dispatchTabs({ type: "close", id });
    this.getEditor()?.close(id);
    this.pendingText.delete(id);
    const docs = new Map(this.snap.docs);
    docs.delete(id);
    this.set({ docs, diffPath: this.snap.diffPath === id ? null : this.snap.diffPath });
    this.syncWatch();
    const next = this.snap.tabs.activeId;
    if (next) void this.loadDoc(next);
    else this.showActive();
  }

  discardAndClose(id: string): void {
    this.closeNow(id);
  }

  async saveAndClose(id: string): Promise<boolean> {
    const ok = await this.save(id);
    if (ok) this.closeNow(id);
    return ok;
  }

  closeOthers(id: string): void {
    const before = new Set(this.snap.tabs.tabs.map((t) => t.id));
    this.dispatchTabs({ type: "closeOthers", id });
    this.disposeClosed(before);
  }

  closeAll(): void {
    const before = new Set(this.snap.tabs.tabs.map((t) => t.id));
    this.dispatchTabs({ type: "closeAll" });
    this.disposeClosed(before);
  }

  private disposeClosed(before: Set<string>): void {
    const open = new Set(this.snap.tabs.tabs.map((t) => t.id));
    const docs = new Map(this.snap.docs);
    for (const id of before) {
      if (open.has(id)) continue;
      this.getEditor()?.close(id);
      docs.delete(id);
    }
    this.set({ docs });
    this.syncWatch();
    const a = this.snap.tabs.activeId;
    if (a) void this.loadDoc(a);
    else this.showActive();
  }

  // ---- save / conflict -----------------------------------------------------------------

  async save(path: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const ed = this.getEditor();
    const d = this.snap.docs.get(path);
    if (!ed || !d || d.status !== "ready" || d.readOnly || d.state.saving) return false;
    const snap = ed.snapshot(path);
    if (snap === null) return false;
    const text = snap.text;
    this.patchDoc(path, (x) => ({ ...x, state: beginSave(x.state) }));
    const gen = this.gen;
    try {
      const w = await this.fs.write(path, text, { encoding: d.encoding === "unknown" ? "utf-8" : d.encoding, bom: d.bom, expected_hash: d.state.diskHash, force: opts.force });
      if (gen !== this.gen) return false;
      const clean = ed.markSaved(path, snap.versionId);
      this.patchDoc(path, (x) => ({ ...x, size: w.size, state: { ...saveSucceeded(x.state, w.hash), dirty: !clean } }));
      this.dispatchTabs({ type: "edit", id: path, dirty: !clean });
      this.queueGit();
      return true;
    } catch (e) {
      if (gen !== this.gen) return false;
      const err = toFsError(e);
      this.patchDoc(path, (x) => ({ ...x, state: saveFailed(x.state, err.code, err.message) }));
      return false;
    }
  }

  /** Banner action "Reload from disk": discards the buffer. */
  async reloadFromDisk(path: string): Promise<void> {
    const gen = this.gen;
    const v0 = this.getEditor()?.snapshot(path)?.versionId;
    try {
      const r = await this.fs.read(path);
      if (gen !== this.gen || r.status !== "ok" || r.text === null) return;
      const ed = this.getEditor();
      if (ed && ed.snapshot(path)?.versionId !== v0) {
        // Typed while the read was in flight: never overwrite those keystrokes; surface the conflict instead.
        this.patchDoc(path, (x) => ({ ...x, state: { ...x.state, external: "changed" } }));
        this.notify("error", "The file changed while you were editing; reload was cancelled.");
        return;
      }
      ed?.replace(path, r.text);
      this.patchDoc(path, (x) => ({ ...x, size: r.size, encoding: r.encoding, bom: r.bom, eol: r.eol, readOnly: r.read_only, state: reloaded(x.state, r.hash) }));
      this.dispatchTabs({ type: "edit", id: path, dirty: false });
    } catch (e) {
      const err = toFsError(e);
      if (err.code === "not_found") this.patchDoc(path, (x) => ({ ...x, state: { ...x.state, external: "deleted" } }));
      else this.notify("error", err.message);
    }
  }

  /** Banner action "Keep mine": adopt the disk's current hash, then save over it. */
  async keepMineAndSave(path: string): Promise<boolean> {
    let hash: string | null = null;
    try {
      hash = (await this.fs.read(path)).hash;
    } catch (e) {
      if (toFsError(e).code !== "not_found") {
        this.notify("error", toFsError(e).message);
        return false;
      }
      // Deleted on disk: saving recreates it.
      this.patchDoc(path, (x) => ({ ...x, state: { ...keepMine(x.state, null), diskHash: null } }));
      return this.save(path);
    }
    this.patchDoc(path, (x) => ({ ...x, state: keepMine(x.state, hash) }));
    return this.save(path);
  }

  /** Banner action "Keep mine" (changed on disk): keep the buffer and adopt the disk's hash, so the next save overwrites. */
  async keepMineOnly(path: string): Promise<void> {
    try {
      const hash = (await this.fs.read(path)).hash;
      this.patchDoc(path, (x) => ({ ...x, state: keepMine(x.state, hash) }));
    } catch (e) {
      this.notify("error", toFsError(e).message);
    }
  }

  /** Probe an open document after a change notification. */
  private async probeDoc(path: string): Promise<void> {
    const d = this.snap.docs.get(path);
    if (!d || d.status !== "ready") return;
    const gen = this.gen;
    let probe: { exists: boolean; hash?: string | null };
    try {
      const r = await this.fs.read(path);
      probe = { exists: true, hash: r.hash };
    } catch (e) {
      if (toFsError(e).code !== "not_found") return;
      probe = { exists: false };
    }
    if (gen !== this.gen) return;
    const cur = this.snap.docs.get(path);
    if (!cur) return;
    const { doc, action } = onDiskProbe(cur.state, probe);
    this.patchDoc(path, (x) => ({ ...x, state: doc }));
    if (action.type === "reload") await this.reloadFromDisk(path);
  }

  // ---- "open anyway" for large files ----------------------------------------------------

  async openAnyway(path: string): Promise<void> {
    const gen = this.gen;
    try {
      const r = await this.fs.readRange(path, 0, RANGE_BYTES);
      if (gen !== this.gen) return;
      if (r.binary) {
        this.patchDoc(path, (x) => ({ ...x, status: "binary" }));
        return;
      }
      this.patchDoc(path, (x) => ({ ...x, status: "range", readOnly: true, rangeNext: r.next_offset, size: r.size }));
      const ed = this.getEditor();
      if (ed) ed.open({ path, text: r.text, language: "plaintext", readOnly: true, large: true });
      else this.pendingText.set(path, { path, status: "ok", size: r.size, mtime_ms: r.mtime_ms, hash: null, text: r.text, encoding: "unknown", bom: false, eol: "none", read_only: true });
      this.showActive();
    } catch (e) {
      this.notify("error", toFsError(e).message);
    }
  }

  async loadMoreRange(path: string): Promise<void> {
    const d = this.snap.docs.get(path);
    if (!d || d.status !== "range" || d.rangeNext === null) return;
    try {
      const r = await this.fs.readRange(path, d.rangeNext, RANGE_BYTES);
      this.getEditor()?.append(path, r.text);
      this.patchDoc(path, (x) => ({ ...x, rangeNext: r.next_offset }));
    } catch (e) {
      this.notify("error", toFsError(e).message);
    }
  }

  // ---- file operations --------------------------------------------------------------------

  private validName(name: string): string | null {
    const n = name.trim();
    if (!n || n === "." || n === ".." || /[\\/\0]/.test(n) || LINE_BREAK.test(n)) return null;
    return n;
  }

  /** The message for a name `validName` refused. A line break gets its own sentence, as on the Mac: a pasted wrapped line is invisible in a one-line field. */
  private nameProblem(name: string): string {
    return LINE_BREAK.test(name.trim()) ? "Names can't contain line breaks." : "A name cannot be empty or contain slashes.";
  }

  async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<string | null> {
    const n = this.validName(name);
    if (!n) {
      this.notify("warning", this.nameProblem(name));
      return null;
    }
    try {
      const p = await this.fs.create(joinPath(dir, n), kind);
      await this.toggleDir(dir, true);
      await this.refreshDir(dir);
      if (kind === "file") await this.openFile(p, false);
      this.queueGit();
      return p;
    } catch (e) {
      this.notify("error", this.describe(e));
      return null;
    }
  }

  async renameEntry(path: string, newName: string): Promise<string | null> {
    const n = this.validName(newName);
    if (!n) {
      this.notify("warning", this.nameProblem(newName));
      return null;
    }
    // The same name is nothing to do: no host call, no error (the Mac closes the editor the same way).
    if (n === baseName(path)) return path;
    return this.moveOne(path, joinPath(parentOf(path), n));
  }

  private async moveOne(from: string, to: string): Promise<string | null> {
    try {
      const dest = await this.fs.rename(from, to);
      this.afterMove(from, dest);
      await Promise.all([this.refreshDir(parentOf(from)), parentOf(dest) !== parentOf(from) ? this.refreshDir(parentOf(dest)) : Promise.resolve()]);
      this.queueGit();
      return dest;
    } catch (e) {
      this.notify("error", this.describe(e));
      return null;
    }
  }

  private afterMove(from: string, to: string): void {
    const affected = this.snap.tabs.tabs.filter((t) => t.id === from || t.id.startsWith(`${from}/`));
    this.dispatchTabs({ type: "renamed", from, to });
    const docs = new Map(this.snap.docs);
    const ed = this.getEditor();
    for (const t of affected) {
      const nid = to + t.id.slice(from.length);
      const d = docs.get(t.id);
      if (d) {
        docs.delete(t.id);
        docs.set(nid, { ...d, state: { ...d.state, path: nid }, language: languageFor(nid) });
      }
      ed?.rename(t.id, nid);
    }
    // Expanded folders under the moved path follow it.
    let tree = this.snap.tree;
    for (const p of [...tree.expanded]) {
      if (p === from || p.startsWith(`${from}/`)) tree = withExpanded(withExpanded(tree, p, false), to + p.slice(from.length), true);
    }
    for (const k of [...tree.dirs.keys()]) if (k === from || k.startsWith(`${from}/`)) tree = invalidate(tree, k);
    const remap = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    const selection = this.snap.selection;
    const focusPath = this.snap.focusPath === null ? null : remap(this.snap.focusPath);
    this.set({ docs, tree, selection: { anchor: selection.anchor === null ? null : remap(selection.anchor), paths: new Set([...selection.paths].map(remap)) }, focusPath });
    this.syncWatch();
    this.queueSession();
  }

  /** Drag-and-drop or "move to": the UI has confirmed. Folders move with their contents. */
  async moveInto(paths: string[], destDir: string): Promise<void> {
    for (const p of topLevel(paths)) {
      if (p === destDir || destDir.startsWith(`${p}/`)) continue;
      await this.moveOne(p, joinPath(destDir, baseName(p)));
    }
    await this.toggleDir(destDir, true);
  }

  /** Moves to the OS trash (the UI confirmed). Open clean tabs under it close; dirty ones are kept and flagged. */
  getClipboard(): { mode: "copy" | "cut"; paths: readonly string[] } | null {
    return this.clipboard;
  }

  setClipboard(mode: "copy" | "cut"): void {
    const paths = topLevel(this.snap.selection.paths);
    this.clipboard = paths.length ? { mode, paths } : null;
    this.set({ notice: this.clipboard ? { severity: "info", message: `${this.clipboard.paths.length} item${this.clipboard.paths.length === 1 ? "" : "s"} ${mode === "copy" ? "copied" : "cut"}.` } : null });
  }

  /**
   * Copy `src` into `destDir` under a free name, Finder-style (`a.txt` (if free) -> `a copy.txt` -> `a copy 2.txt`). The host
   * never overwrites, so a collision is detected by its `exists` answer rather than a racy pre-check.
   */
  private async copyToFreeName(src: string, destDir: string): Promise<string> {
    const base = baseName(src);
    const dot = base.lastIndexOf(".");
    const hasExt = dot > 0;
    const stem = hasExt ? base.slice(0, dot) : base;
    const ext = hasExt ? base.slice(dot) : "";
    // The Mac's `uniqueDestination`: the plain name first (pasting into another folder keeps it), then the copies.
    for (let n = -1; n < 1000; n++) {
      const name = n === -1 ? base : n === 0 ? `${stem} copy${ext}` : `${stem} copy ${n + 1}${ext}`;
      const to = joinPath(destDir, name);
      try {
        await this.fs.copy(src, to);
        return to;
      } catch (e) {
        if (toFsError(e).code !== "exists") throw e;
      }
    }
    throw new FsError("exists", "no free name for the copy");
  }

  /** Copy (not move) `paths` into `destDir` ("" = project root), Finder-style names on collision. Alt-drag uses this. */
  async copyInto(paths: string[], destDir: string): Promise<void> {
    const failures: string[] = [];
    let copied = 0;
    for (const p of topLevel(paths)) {
      if (p === destDir || destDir.startsWith(`${p}/`)) { failures.push(baseName(p)); continue; }
      try {
        await this.copyToFreeName(p, destDir);
        copied++;
      } catch (e) {
        failures.push(`${baseName(p)} (${this.describe(e)})`);
      }
    }
    await this.refreshDir(destDir);
    this.set({
      notice: failures.length
        ? { severity: "warning", message: `${copied} copied; ${failures.length} could not be copied: ${failures.slice(0, 3).join(", ")}` }
        : copied ? { severity: "info", message: `${copied} item${copied === 1 ? "" : "s"} copied.` } : null,
    });
    this.queueGit();
  }

  /**
   * Paste the internal clipboard into `destDir` ("" = project root). A copy never overwrites: it takes a free
   * Finder-style name. A cut is a move: pasting into the folder it already lives in is a no-op, and a cut is consumed
   * only when every item landed. An item that vanished since the cut is reported, not retried; a real collision or
   * write error keeps the cut armed so the user can fix it and paste again.
   */
  async paste(destDir: string): Promise<void> {
    const clip = this.clipboard;
    if (!clip?.paths.length) return;
    const moved: string[] = [];
    const conflicts: string[] = [];
    const missing: string[] = [];
    for (const src of clip.paths) {
      const base = baseName(src);
      const to = joinPath(destDir, base);
      try {
        if (clip.mode === "copy") {
          moved.push(await this.copyToFreeName(src, destDir));
        } else if (to === src) {
          // Cut into the folder it already lives in: nothing to do, and nothing to report.
          continue;
        } else {
          await this.fs.rename(src, to);
          moved.push(to);
        }
      } catch (e) {
        const code = toFsError(e).code;
        if (clip.mode === "cut" && code === "not_found") missing.push(base);
        else conflicts.push(base);
      }
    }
    if (clip.mode === "cut" && conflicts.length === 0) this.clipboard = null;
    await this.refreshDir(destDir);
    for (const p of clip.paths) await this.refreshDir(parentOf(p));
    const parts: string[] = [];
    if (moved.length) parts.push(`${moved.length} item${moved.length === 1 ? "" : "s"} pasted`);
    if (conflicts.length) parts.push(`${conflicts.length} skipped because the destination exists or could not be written: ${conflicts.slice(0, 3).join(", ")}`);
    if (missing.length) parts.push(`${missing.length} no longer exist${missing.length === 1 ? "s" : ""}`);
    this.set({
      notice: parts.length === 0 ? null : { severity: conflicts.length || missing.length ? "warning" : "info", message: parts.join("; ") + "." },
    });
  }

  async deleteEntries(paths: string[]): Promise<void> {
    for (const p of topLevel(paths)) {
      try {
        await this.fs.remove(p);
      } catch (e) {
        this.notify("error", this.describe(e));
        continue;
      }
      for (const t of this.snap.tabs.tabs.filter((x) => x.id === p || x.id.startsWith(`${p}/`))) {
        if (t.dirty) this.patchDoc(t.id, (d) => ({ ...d, state: { ...d.state, external: "deleted" } }));
        else this.closeNow(t.id);
      }
      await this.refreshDir(parentOf(p));
    }
    this.set({ selection: NO_SELECTION });
    this.queueGit();
  }

  private describe(e: unknown): string {
    const err = toFsError(e);
    const map: Record<string, string> = {
      exists: "A file or folder with that name already exists.",
      invalid_path: "That name is not allowed.",
      outside_root: "That path leaves the project folder.",
      permission_denied: "Permission denied.",
      trash_unavailable: "The system trash is not available, so nothing was deleted.",
      not_found: "That file or folder no longer exists.",
    };
    return map[err.code] ?? err.message;
  }

  // ---- watcher ----------------------------------------------------------------------------

  private async startWatching(gen: number): Promise<void> {
    try {
      const r = await this.fs.watchStart((b) => this.onBatch(b));
      if (gen !== this.gen) return;
      this.set({ watchMode: r.mode });
      this.syncWatch();
    } catch {
      if (gen === this.gen) this.set({ watchMode: "off" });
    }
  }

  private syncWatch(): void {
    if (this.snap.watchMode === "off") return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      const want = new Set<string>(["", ".git", this.treeBase]);
      for (const t of this.snap.tabs.tabs) want.add(parentOf(t.id));
      for (const p of this.snap.tree.expanded) if (this.snap.tree.dirs.has(p)) want.add(p);
      // Say it once when the expanded set outgrows what the host watches, instead of silently watching a prefix.
      const capped = want.size > WATCH_DIR_CAP;
      if (capped && !this.watchCapped) {
        this.notify("warning", `Changes in folders beyond the first ${WATCH_DIR_CAP} expanded are not watched; collapse some folders.`);
      }
      this.watchCapped = capped;
      void this.fs.watchSet([...want].slice(0, WATCH_DIR_CAP))
        .then(() => { this.watchErrorShown = false; })
        .catch((e) => {
          // Never swallow it: a watcher that cannot follow every folder must be visible (once).
          if (!this.watchErrorShown) this.notify("warning", `The file watcher could not follow every folder: ${toFsError(e).message}`);
          this.watchErrorShown = true;
        });
    }, 0);
  }

  onBatch(b: WatchBatch): void {
    const tree = this.snap.tree;
    const dirs = b.overflow ? [...tree.dirs.keys()] : b.dirs.filter((d) => tree.dirs.has(d));
    for (const d of dirs) void this.refreshDir(d);
    const openFiles = b.overflow ? this.snap.tabs.tabs.map((t) => t.id) : b.files.filter((f) => this.snap.docs.has(f));
    for (const f of openFiles) void this.probeDoc(f);
    this.queueGit();
  }

  // ---- git ----------------------------------------------------------------------------------

  private queueGit(): void {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => void this.refreshGit(), this.settleMs);
  }

  async refreshGit(): Promise<void> {
    const gen = this.gen;
    try {
      const s: GitStatus = await this.fs.gitStatus();
      if (gen !== this.gen) return;
      const deco = new Map<string, GitDeco>();
      const dirs = new Set<string>();
      for (const e of s.entries) {
        deco.set(e.path, gitDecoFor(e.index, e.worktree, e.kind));
        for (let p = parentOf(e.path); p !== ""; p = parentOf(p)) dirs.add(p);
      }
      this.set({ git: { branch: s.branch, ahead: s.ahead, behind: s.behind, deco, dirs, error: null } });
    } catch (e) {
      if (gen !== this.gen) return;
      const err = toFsError(e);
      // Not a repository is a normal state, not an error to show.
      this.set({ git: err.code === "not_a_repo" ? null : { branch: null, ahead: 0, behind: 0, deco: new Map(), dirs: new Set(), error: err.message } });
    }
  }

  async toggleDiff(path: string): Promise<void> {
    const ed = this.getEditor();
    if (!ed) return;
    if (this.snap.diffPath === path) {
      ed.hideDiff();
      this.set({ diffPath: null });
      return;
    }
    try {
      const head = await this.fs.gitShow(path, "head");
      ed.showDiff(path, head.text);
      this.set({ diffPath: path });
    } catch (e) {
      this.notify("error", toFsError(e).message);
    }
  }

  // ---- session --------------------------------------------------------------------------------

  private queueSession(): void {
    const root = this.snap.root;
    if (!root) return;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      const s = this.snap;
      saveSession(this.kv, root, { tabs: serializeTabs(s.tabs), expanded: [...s.tree.expanded].filter((p) => p !== ""), treeWidth: this.treeWidth });
    }, this.settleMs);
  }

  /** Saves immediately (before unload / project switch). */
  flushSession(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    const root = this.snap.root;
    if (root) saveSession(this.kv, root, { tabs: serializeTabs(this.snap.tabs), expanded: [...this.snap.tree.expanded].filter((p) => p !== ""), treeWidth: this.treeWidth });
  }

  /** Persisted width of the tree panel (per project). */
  getTreeWidth(): number | null {
    return this.treeWidth;
  }

  setTreeWidth(w: number): void {
    this.treeWidth = w;
    this.queueSession();
  }
}

export { FsError };
export type { Entry };
