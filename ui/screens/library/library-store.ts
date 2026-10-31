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
import { IDLE_SEARCH, SearchController, type SearchRun, type SearchState } from "./search.ts";

export const LIST_PAGE = 2000;
export const HEAD_BATCH = 200;
export const HEAD_BYTES = 2048;
export const HEAD_CONCURRENCY = 3;

export type RootStatus = "unknown" | "loading" | "ready" | "none" | "error";

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
}

export interface StoreDeps {
  host: NotesHost;
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

  constructor(deps: StoreDeps) {
    this.host = deps.host;
    this.now = deps.now ?? (() => Date.now());
    this.search = deps.searchRun
      ? new SearchController({
          run: deps.searchRun,
          setTimer: deps.setTimer,
          clearTimer: deps.clearTimer,
          onChange: (s) => this.patch({ search: s }),
        })
      : null;
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
      sectionId: "meeting",
      selectedRel: null,
      filters: NO_FILTERS,
      sort: "date-desc",
      group: "month",
      search: IDLE_SEARCH,
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
      this.patch({ rootStatus: "ready", root });
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
    const selectedGone = this.state.selectedRel !== null && !this.byRel.has(this.state.selectedRel);
    this.publish(loaded, { listingDone: true, selectedGone });
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
    const counts = countBySection(records);
    this.patch({
      records,
      counts,
      sections: sectionsFor(counts),
      version: this.state.version + 1,
      listing: { phase: extra?.listingDone ? "done" : this.state.listing.phase === "idle" ? "listing" : this.state.listing.phase, loaded },
      heads: { done: this.headsDone, total: this.headsTotal },
      ...(extra?.selectedGone ? { selectedRel: null } : null),
    });
  }

  // ---- view state -----------------------------------------------------------------------

  select(rel: string | null): void {
    if (rel !== this.state.selectedRel) this.patch({ selectedRel: rel });
  }

  setSection(id: string | null): void {
    this.patch({ sectionId: id, selectedRel: null });
  }

  setFilters(f: Partial<Filters>): void {
    this.patch({ filters: { ...this.state.filters, ...f } });
  }

  setSort(sort: SortKey): void {
    this.patch({ sort });
  }

  setGroup(group: GroupKey): void {
    this.patch({ group });
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
    this.patch({ sectionId: r ? r.sourceId : this.state.sectionId, selectedRel: rel });
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
      this.rowsCache = buildRows(s.records, { sectionId: s.sectionId, filters: s.filters, sort: s.sort, group: s.group, now: this.now() });
    }
    return this.rowsCache;
  }
}
