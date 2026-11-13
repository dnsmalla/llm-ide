// Library state: the notes folder, the incremental listing, lazy head enrichment, selection,
// filters and search. A plain observable store (no React) so every transition is tested with
// node; components read it through `useSyncExternalStore` (use-library.ts).
//
// Scale: 50,000+ notes. Listing arrives in pages of up to 2,000 paths (the host walks with a stable
// cursor), each page is folded into the record map as it arrives (the list is usable after the first
// page), and frontmatter heads (title, date, platform) are read in the background in batches with
// bounded concurrency, visible rows first. A rescan keeps the heads of files whose size and mtime did
// not change. Everything is cancellable: a newer scan, a root change or `dispose()` stops the old one.

import { applyHead, buildRows, countBySection, NO_FILTERS, recordFromEntry, sectionsFor, type Filters, type GroupKey, type NoteRecord, type Row, type SectionDef, type SortKey } from "./notes-model.ts";
import { NotesError, toNotesError, type NotesErrorCode, type NotesHost, type NotesRoot } from "./host.ts";
import { IDLE_SEARCH, SearchController, type SearchHit, type SearchRun, type SearchState } from "./search.ts";
import { hideRels, isVisible, loadHidden, pruneHidden, saveHidden, unhideRels, type KeyValue } from "./hidden-notes.ts";

export const LIST_PAGE = 2000;
export const HEAD_BATCH = 200;
export const HEAD_BYTES = 2048;
export const HEAD_CONCURRENCY = 3;

export type RootStatus = "unknown" | "loading" | "ready" | "none" | "error";

function defaultStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const PREFS_KEY = "llmide.library.prefs";
interface LibraryPrefs { sectionId?: string | null; filters?: Partial<Filters>; sort?: SortKey; group?: GroupKey }
function readPrefs(): LibraryPrefs {
  try { return JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? "{}") as LibraryPrefs; } catch { return {}; }
}

/**
 * Old builds saved group "month" on every filter or sort change, and no control here can change it back.
 * That saved value shows the date buckets (the default); every other saved value is kept.
 */
export function groupFromPrefs(saved: GroupKey | undefined): GroupKey {
  if (saved === undefined || saved === "month") return "relative";
  return saved;
}

/**
 * Like the Mac, the list has only the search field, so only the saved search text is restored. Platform,
 * has-summary and date-range filters saved by older builds (which had controls for them) would otherwise hide
 * notes with nothing on screen to clear them.
 */
export function filtersFromPrefs(saved: Partial<Filters> | undefined): Filters {
  return { ...NO_FILTERS, query: typeof saved?.query === "string" ? saved.query : "" };
}

export interface LibraryState {
  rootStatus: RootStatus;
  root: NotesRoot | null;
  /** Short code for the UI to map to wording; null when fine. */
  error: NotesErrorCode | null;
  listing: { phase: "idle" | "listing" | "done" | "error"; loaded: number };
  heads: { done: number; total: number };
  /** Bumps whenever `records` changes (memo key for derived rows). */
  version: number;
  records: readonly NoteRecord[];
  counts: ReadonlyMap<string, number>;
  sections: readonly SectionDef[];
  /** Selected sidebar section id, or null for "All". */
  sectionId: string | null;
  selectedRel: string | null;
  filters: Filters;
  sort: SortKey;
  group: GroupKey;
  search: SearchState;
  /** Notes hidden with "Remove from List" in the current folder (the files are untouched). */
  hidden: ReadonlySet<string>;
  /** Hidden notes whose files are still in the folder (the "N hidden" line). */
  hiddenCount: number;
  /** The "Show hidden" toggle: hidden notes are listed (with Unhide) and counted. Session only. */
  showHidden: boolean;
}

export interface StoreDeps {
  host: NotesHost;
  /** Where the hidden list is kept. Defaults to the browser's localStorage; null keeps it for the session only. */
  storage?: KeyValue | null;
  /** Absent: full-text search is not offered (the local filter still works). */
  searchRun?: SearchRun;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class LibraryStore {
  private readonly host: NotesHost;
  private readonly now: () => number;
  private readonly byRel = new Map<string, NoteRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly search: SearchController | null;
  private gen = 0;
  private disposed = false;
  private pending: string[] = [];
  private pendingSet = new Set<string>();
  private inflight = 0;
  private headsDone = 0;
  private headsTotal = 0;
  private rowsKey = "";
  private rowsCache: Row[] = [];
  private state: LibraryState;
  private readonly storage: KeyValue | null;
  /** The folder the hidden list belongs to (its absolute path), or null without a folder. */
  private hiddenRoot: string | null = null;
  /** The last search answer as the core gave it: filtered again when the listing completes. */
  private rawHits: readonly SearchHit[] = [];

  constructor(deps: StoreDeps) {
    this.host = deps.host;
    this.now = deps.now ?? (() => Date.now());
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.search = deps.searchRun
      ? new SearchController({
          run: deps.searchRun,
          setTimer: deps.setTimer,
          clearTimer: deps.clearTimer,
          onChange: (s) => { this.rawHits = s.hits; this.patch({ search: { ...s, hits: this.ownHits(s.hits) } }); },
        })
      : null;
    const prefs = readPrefs();
    this.state = {
      rootStatus: "unknown",
      root: null,
      error: null,
      listing: { phase: "idle", loaded: 0 },
      heads: { done: 0, total: 0 },
      version: 0,
      records: [],
      counts: new Map(),
      sections: sectionsFor(new Map()),
      sectionId: prefs.sectionId === undefined ? "meeting" : prefs.sectionId,
      selectedRel: null,
      filters: filtersFromPrefs(prefs.filters),
      sort: prefs.sort ?? "date-desc",
      group: groupFromPrefs(prefs.group),
      search: IDLE_SEARCH,
      hidden: new Set(),
      hiddenCount: 0,
      showHidden: false,
    };
  }

  // ---- subscription ---------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): LibraryState => this.state;

  get searchAvailable(): boolean {
    return this.search !== null;
  }

  private patch(p: Partial<LibraryState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }

  // ---- lifecycle ------------------------------------------------------------------------

  async init(): Promise<void> {
    this.patch({ rootStatus: "loading", error: null });
    try {
      const root = await this.host.rootGet();
      if (this.disposed) return;
      if (!root) {
        this.patch({ rootStatus: "none", root: null });
        return;
      }
      // A different folder than the one loaded: its records and selection belong to the old folder, so drop them.
      const rootChanged = this.state.root !== null && this.state.root.root !== root.root;
      if (rootChanged) {
        this.resetRecords();
        // The query and its hits were for the previous project's folder.
        this.rawHits = [];
        this.search?.clear();
      }
      this.patch({ rootStatus: "ready", root, ...(rootChanged ? { selectedRel: null } : {}) });
      this.loadHiddenFor(root.root);
      await this.scan();
    } catch (e) {
      this.fail(toNotesError(e));
    }
  }

  async chooseRoot(): Promise<void> {
    try {
      const root = await this.host.rootChoose();
      if (this.disposed || !root) return; // cancelled in the dialog
      this.resetRecords();
      this.patch({ rootStatus: "ready", root, error: null, selectedRel: null });
      this.loadHiddenFor(root.root);
      await this.scan();
    } catch (e) {
      this.fail(toNotesError(e));
    }
  }

  async clearRoot(): Promise<void> {
    this.gen += 1;
    this.stopHeads();
    try {
      await this.host.rootClear();
    } catch {
      // The folder setting could not be removed; the screen still shows "no folder" until restart.
    }
    this.resetRecords();
    this.loadHiddenFor(null);
    this.patch({ rootStatus: "none", root: null, selectedRel: null, error: null, listing: { phase: "idle", loaded: 0 } });
  }

  dispose(): void {
    this.disposed = true;
    this.gen += 1;
    this.stopHeads();
    this.search?.dispose();
    this.listeners.clear();
  }

  private fail(e: NotesError): void {
    const gone = e.code === "no_root" || e.code === "invalid_root";
    this.patch({ error: e.code, rootStatus: gone ? (e.code === "no_root" ? "none" : "error") : this.state.rootStatus, listing: { ...this.state.listing, phase: "error" } });
  }

  private resetRecords(): void {
    this.byRel.clear();
    this.stopHeads();
    this.publish(0);
  }

  // ---- scanning -------------------------------------------------------------------------

  /** (Re)lists the whole folder. A newer scan supersedes this one. */
  async scan(): Promise<void> {
    const gen = ++this.gen;
    this.stopHeads();
    this.patch({ listing: { phase: "listing", loaded: 0 }, error: null });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let loaded = 0;
    try {
      do {
        const page = await this.host.list(cursor, LIST_PAGE);
        if (gen !== this.gen || this.disposed) return;
        for (const e of page.entries) {
          seen.add(e.rel);
          const old = this.byRel.get(e.rel);
          if (old && old.size === e.size && old.mtimeMs === e.mtimeMs && old.placeholder === e.placeholder && (old.headRead || e.placeholder)) continue;
          this.byRel.set(e.rel, recordFromEntry(e));
          this.queueHead(e.rel, false);
        }
        loaded += page.entries.length;
        cursor = page.nextCursor;
        this.publish(loaded);
        this.pump(gen);
      } while (cursor !== null);
    } catch (e) {
      if (gen !== this.gen || this.disposed) return;
      this.fail(toNotesError(e));
      return;
    }
    // Files that disappeared since the last scan.
    let removed = false;
    for (const rel of [...this.byRel.keys()]) {
      if (!seen.has(rel)) {
        this.byRel.delete(rel);
        removed = true;
      }
    }
    if (removed) {
      this.pending = this.pending.filter((r) => this.byRel.has(r));
      this.pendingSet = new Set(this.pending);
    }
    const pruned = pruneHidden(this.state.hidden, (rel) => this.byRel.has(rel));
    if (pruned.size !== this.state.hidden.size) this.commitHidden(pruned);
    const selectedGone = this.state.selectedRel !== null && !this.byRel.has(this.state.selectedRel) && !this.hasUnsaved?.();
    this.publish(loaded, { listingDone: true, selectedGone });
    // Now the folder's notes are known: drop search hits that belong to another project (see `ownHits`).
    const own = this.ownHits(this.rawHits);
    if (own.length !== this.state.search.hits.length) this.patch({ search: { ...this.state.search, hits: own } });
  }

  /**
   * The note index is one space for every project (it is written without a project id), so a search also returns
   * other projects' notes. A hit is shown only when its note exists in the open notes folder. While the folder is
   * still being listed that is not known yet, so nothing is hidden until the listing is done.
   */
  private ownHits(hits: readonly SearchHit[]): SearchHit[] {
    if (this.state.listing.phase !== "done") return [...hits];
    return hits.filter((h) => this.byRel.has(h.rel));
  }

  // ---- incremental updates from the write side ------------------------------------------
  // A write updates the in-memory list from its own result instead of rescanning the folder (50,000
  // notes must not be re-listed after every save). External changes are picked up by `scan()` (the
  // Refresh button) or by a save/open conflict.

  /** A note was created or saved: refresh its record from the write result (and its text, when known). */
  noteWritten(entry: { rel: string; size: number; mtimeMs: number }, text?: string): void {
    if (this.disposed) return;
    let rec = recordFromEntry({ rel: entry.rel, size: entry.size, mtimeMs: entry.mtimeMs, placeholder: false });
    if (text !== undefined) rec = applyHead(rec, text.slice(0, HEAD_BYTES));
    this.byRel.set(entry.rel, rec);
    this.publish(this.byRel.size, { listingDone: this.state.listing.phase === "done" });
  }

  /** Notes left the folder (moved to the Trash). */
  noteRemoved(rels: readonly string[]): void {
    if (this.disposed) return;
    let any = false;
    for (const rel of rels) any = this.byRel.delete(rel) || any;
    if (!any) return;
    if (this.pending.length) {
      this.pending = this.pending.filter((r) => this.byRel.has(r));
      this.pendingSet = new Set(this.pending);
    }
    const sel = this.state.selectedRel;
    this.publish(this.byRel.size, { listingDone: this.state.listing.phase === "done", selectedGone: sel !== null && !this.byRel.has(sel) && !this.hasUnsaved?.() });
  }

  /** A note was renamed or moved; it stays selected under its new path. */
  noteRenamed(from: string, entry: { rel: string; size: number; mtimeMs: number }, text?: string): void {
    if (this.disposed) return;
    const wasSelected = this.state.selectedRel === from;
    const old = this.byRel.get(from);
    this.byRel.delete(from);
    let rec = recordFromEntry({ rel: entry.rel, size: entry.size, mtimeMs: entry.mtimeMs, placeholder: false });
    if (text !== undefined) rec = applyHead(rec, text.slice(0, HEAD_BYTES));
    else if (old?.headRead) rec = { ...old, rel: rec.rel, name: rec.name, size: rec.size, mtimeMs: rec.mtimeMs, area: rec.area, typeDir: rec.typeDir };
    this.byRel.set(entry.rel, rec);
    this.publish(this.byRel.size, { listingDone: this.state.listing.phase === "done" });
    if (wasSelected) this.patch({ selectedRel: entry.rel });
  }

  /** Asks for these notes' heads next (the rows on screen). */
  prioritize(rels: readonly string[]): void {
    let any = false;
    for (const rel of rels) {
      const r = this.byRel.get(rel);
      if (!r || r.headRead || r.placeholder) continue;
      this.queueHead(rel, true);
      any = true;
    }
    if (any) this.pump(this.gen);
  }

  private queueHead(rel: string, front: boolean): void {
    const r = this.byRel.get(rel);
    if (!r || r.placeholder) return;
    if (this.pendingSet.has(rel)) {
      if (front) {
        this.pending.splice(this.pending.indexOf(rel), 1);
        this.pending.unshift(rel);
      }
      return;
    }
    this.pendingSet.add(rel);
    if (front) this.pending.unshift(rel);
    else this.pending.push(rel);
    this.headsTotal += 1;
  }

  private stopHeads(): void {
    this.pending = [];
    this.pendingSet = new Set();
    this.headsDone = 0;
    this.headsTotal = 0;
    this.inflight = 0;
  }

  private pump(gen: number): void {
    while (this.inflight < HEAD_CONCURRENCY && this.pending.length > 0 && gen === this.gen && !this.disposed) {
      const batch = this.pending.splice(0, HEAD_BATCH);
      for (const rel of batch) this.pendingSet.delete(rel);
      this.inflight += 1;
      void this.readHeads(gen, batch);
    }
  }

  private async readHeads(gen: number, batch: string[]): Promise<void> {
    let results: Awaited<ReturnType<NotesHost["heads"]>> = [];
    try {
      results = await this.host.heads(batch, HEAD_BYTES);
    } catch {
      results = []; // the whole batch failed: those notes keep their path facts
    }
    if (gen !== this.gen || this.disposed) return;
    this.inflight -= 1;
    let changed = false;
    for (const h of results) {
      const r = this.byRel.get(h.rel);
      if (!r) continue;
      if (h.head !== null) {
        this.byRel.set(h.rel, applyHead(r, h.head));
        changed = true;
      } else if (h.error === "not_downloaded") {
        this.byRel.set(h.rel, { ...r, placeholder: true });
        changed = true;
      }
    }
    // Everything asked for counts as done, read or not, so progress always completes.
    this.headsDone += batch.length;
    if (changed) this.publish(this.state.listing.loaded);
    else this.patch({ heads: { done: this.headsDone, total: this.headsTotal } });
    this.pump(gen);
  }

  private publish(loaded: number, extra?: { listingDone?: boolean; selectedGone?: boolean }): void {
    const records = [...this.byRel.values()];
    const { hidden, showHidden } = this.state;
    const counts = countBySection(records.filter((r) => isVisible(r.rel, hidden, showHidden)));
    let hiddenCount = 0;
    for (const rel of hidden) if (this.byRel.has(rel)) hiddenCount += 1;
    this.patch({
      records,
      counts,
      sections: sectionsFor(counts),
      hiddenCount,
      version: this.state.version + 1,
      listing: { phase: extra?.listingDone ? "done" : this.state.listing.phase === "idle" ? "listing" : this.state.listing.phase, loaded },
      heads: { done: this.headsDone, total: this.headsTotal },
      ...(extra?.selectedGone ? { selectedRel: null } : null),
    });
  }

  // ---- remove from list (hidden set; files are never touched) ---------------------------

  private loadHiddenFor(root: string | null): void {
    this.hiddenRoot = root;
    this.patch({ hidden: root === null ? new Set() : loadHidden(this.storage, root) });
  }

  private commitHidden(next: Set<string>): void {
    this.patch({ hidden: next });
    if (this.hiddenRoot !== null) saveHidden(this.storage, this.hiddenRoot, next);
  }

  private republish(): void {
    this.publish(this.byRel.size, { listingDone: this.state.listing.phase === "done" });
  }

  /** Hides notes from the list. Returns how many did not fit under the bound (HIDDEN_LIMIT). */
  hideNotes(rels: readonly string[]): { refused: number } {
    const { hidden, refused } = hideRels(this.state.hidden, rels);
    this.commitHidden(hidden);
    this.republish();
    return { refused };
  }

  unhideNotes(rels: readonly string[]): void {
    this.commitHidden(unhideRels(this.state.hidden, rels));
    this.republish();
  }

  setShowHidden(on: boolean): void {
    this.patch({ showHidden: on });
    this.republish();
  }

  // ---- view state -----------------------------------------------------------------------

  /**
   * Set by the write side while a note has unsaved changes: return false to veto a selection change.
   * `proceed` performs the vetoed change without asking again (the "discard changes" answer).
   */
  selectGuard: ((next: string | null, proceed: () => void) => boolean) | null = null;

  /** True while the open note has unsaved edits: the list never deselects it underneath the editor. */
  hasUnsaved: (() => boolean) | null = null;

  private guarded(next: string | null, action: () => void): void {
    const guard = this.selectGuard;
    if (guard) {
      const proceed = (): void => {
        this.selectGuard = null;
        try {
          action();
        } finally {
          this.selectGuard = guard;
        }
      };
      if (!guard(next, proceed)) return;
    }
    action();
  }

  select(rel: string | null): void {
    if (rel === this.state.selectedRel) return;
    this.guarded(rel, () => this.patch({ selectedRel: rel }));
  }

  private savePrefs(): void {
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ sectionId: this.state.sectionId, filters: this.state.filters, sort: this.state.sort, group: this.state.group }));
    } catch { /* session only */ }
  }

  setSection(id: string | null): void {
    this.guarded(null, () => { this.patch({ sectionId: id, selectedRel: null }); this.savePrefs(); });
  }

  setFilters(f: Partial<Filters>): void {
    this.patch({ filters: { ...this.state.filters, ...f } });
    this.savePrefs();
  }

  setSort(sort: SortKey): void {
    this.patch({ sort });
    this.savePrefs();
  }

  setGroup(group: GroupKey): void {
    this.patch({ group });
    this.savePrefs();
  }

  setSearchQuery(q: string): void {
    this.search?.setQuery(q);
  }

  submitSearch(): void {
    this.search?.submit();
  }

  clearSearch(): void {
    this.search?.clear();
  }

  /** Jump to a note from a search hit: the section it lives in, then select it. */
  reveal(rel: string): void {
    const r = this.byRel.get(rel);
    if (rel === this.state.selectedRel) return;
    this.guarded(rel, () => this.patch({ sectionId: r ? r.sourceId : this.state.sectionId, selectedRel: rel }));
  }

  record(rel: string): NoteRecord | undefined {
    return this.byRel.get(rel);
  }

  /** The flat, filtered, sorted, grouped rows for the current section. Memoised per state version. */
  rows(): Row[] {
    const s = this.state;
    const key = `${s.version}|${s.sectionId}|${JSON.stringify(s.filters)}|${s.sort}|${s.group}`;
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      this.rowsCache = buildRows(s.records.filter((r) => isVisible(r.rel, s.hidden, s.showHidden)), { sectionId: s.sectionId, filters: s.filters, sort: s.sort, group: s.group, now: this.now() });
    }
    return this.rowsCache;
  }
}
