// Search controller: debounced query -> one host search at a time -> streamed results. React-free and
// host-free (the SearchApi is injected), so the state machine is tested with a fake.
import { toFsError } from "../fs";
import type { SearchApi, SearchRequest } from "./host";
import {
  DEFAULT_OPTIONS, decodeDone, decodeFiles, flattenRows, initialSearch, moveSelection, normalizedQuery, splitGlobs,
  type Row, type SearchOptions, type SearchState, type WireEvent,
} from "./model";

export interface SearchDeps {
  api: SearchApi;
  /** Relative paths of the open editor tabs, for the "open files only" scope. */
  openPaths?: () => string[];
  /** Click / Enter on a result. */
  onOpen?: (path: string, line: number, col: number) => void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** Results held by the UI are bounded independently of the host's cap. */
const MAX_UI_MATCHES = 6000;

export class SearchController {
  private snap: SearchState = initialSearch();
  private rowsCache: { files: unknown; collapsed: unknown; rows: Row[] } | null = null;
  private listeners = new Set<() => void>();
  private timer: unknown = null;
  /** Local run counter: guards async completions of superseded runs. */
  private gen = 0;
  private activeId: number | null = null;
  /** Events that arrived before `start` resolved with its id. */
  private early: WireEvent[] = [];
  private starting = false;
  private disposed = false;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly deps: SearchDeps) {
    this.debounceMs = deps.debounceMs ?? 250;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): SearchState => this.snap;

  private set(p: Partial<SearchState>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  rows(): Row[] {
    const c = this.rowsCache;
    if (c && c.files === this.snap.files && c.collapsed === this.snap.collapsed) return c.rows;
    const rows = flattenRows(this.snap.files, this.snap.collapsed);
    this.rowsCache = { files: this.snap.files, collapsed: this.snap.collapsed, rows };
    return rows;
  }

  // ---- input -------------------------------------------------------------------------------

  setQuery(q: string): void {
    if (q === this.snap.query) return;
    this.set({ query: q });
    this.schedule();
  }

  setOptions(p: Partial<SearchOptions>): void {
    this.set({ opts: { ...this.snap.opts, ...p } });
    this.schedule();
  }

  resetOptions(): void {
    this.setOptions(DEFAULT_OPTIONS);
  }

  private schedule(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  /** Enter in the search box: run now. */
  runNow(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    void this.run();
  }

  // ---- run ---------------------------------------------------------------------------------

  async run(): Promise<void> {
    if (this.disposed) return;
    const q = normalizedQuery(this.snap.query);
    const gen = ++this.gen;
    this.abortActive();
    if (q === null) {
      this.set({ phase: "idle", files: [], matchCount: 0, done: null, error: null, selected: -1, collapsed: new Set() });
      return;
    }
    const o = this.snap.opts;
    const only = o.openFilesOnly ? (this.deps.openPaths?.() ?? []) : null;
    if (only !== null && only.length === 0) {
      this.set({ phase: "done", files: [], matchCount: 0, done: null, error: null, selected: -1, collapsed: new Set() });
      return;
    }
    const req: SearchRequest = {
      query: q,
      regex: o.regex,
      case_sensitive: o.caseSensitive,
      whole_word: o.wholeWord,
      include: splitGlobs(o.include),
      exclude: splitGlobs(o.exclude),
      only_paths: only,
      include_hidden: true,
      use_ignore: o.useIgnore,
    };
    this.set({ phase: "searching", files: [], matchCount: 0, done: null, error: null, selected: -1, collapsed: new Set() });
    this.activeId = null;
    this.early = [];
    this.starting = true;
    try {
      const { id } = await this.deps.api.start(req, (e) => this.onEvent(gen, e));
      if (gen !== this.gen || this.disposed) {
        // Superseded while starting: the host already cancelled it by starting the newer one, but be explicit.
        void this.deps.api.cancel(id);
        return;
      }
      this.activeId = id;
      this.starting = false;
      const buffered = this.early;
      this.early = [];
      for (const e of buffered) this.apply(e);
    } catch (e) {
      if (gen !== this.gen) return;
      this.starting = false;
      const err = toFsError(e);
      this.set({ phase: "error", error: err.code === "invalid_query" ? err.message : `Search failed: ${err.message}` });
    }
  }

  private onEvent(gen: number, e: WireEvent): void {
    if (gen !== this.gen || this.disposed) return;
    if (this.starting) {
      if (this.early.length < 10_000) this.early.push(e);
      return;
    }
    this.apply(e);
  }

  private apply(e: WireEvent): void {
    if (e.id !== this.activeId) return; // a stale run's event
    if (e.type === "chunk") {
      if (this.snap.phase !== "searching") return;
      const room = MAX_UI_MATCHES - this.snap.matchCount;
      if (room <= 0) return;
      let add = decodeFiles(e.files);
      let n = 0;
      add = add.flatMap((f) => {
        if (n >= room) return [];
        const hits = f.hits.slice(0, room - n);
        n += hits.length;
        return [{ ...f, hits, more: f.more || hits.length < f.hits.length }];
      });
      if (add.length) this.set({ files: [...this.snap.files, ...add], matchCount: this.snap.matchCount + n });
    } else if (e.type === "done") {
      const done = decodeDone(e);
      this.activeId = null;
      this.set({ phase: "done", done, matchCount: this.snap.matchCount });
    }
  }

  private abortActive(): void {
    const id = this.activeId;
    this.activeId = null;
    this.starting = false;
    this.early = [];
    if (id !== null) void this.deps.api.cancel(id);
  }

  /** Esc while searching: stop, keep what arrived. */
  cancel(): void {
    if (this.snap.phase !== "searching") return;
    this.gen++;
    this.abortActive();
    this.set({ phase: "done", done: { filesScanned: 0, filesMatched: this.snap.files.length, matches: this.snap.matchCount, truncated: null, cancelled: true, skippedBinary: 0, skippedLarge: 0, skippedOther: 0 } });
  }

  clear(): void {
    this.gen++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.abortActive();
    this.set({ ...initialSearch(), opts: this.snap.opts });
  }

  // ---- results -----------------------------------------------------------------------------

  toggleCollapsed(path: string): void {
    const next = new Set(this.snap.collapsed);
    if (!next.delete(path)) next.add(path);
    this.set({ collapsed: next });
  }

  collapseAll(collapse: boolean): void {
    this.set({ collapsed: collapse ? new Set(this.snap.files.map((f) => f.path)) : new Set() });
  }

  select(index: number): void {
    this.set({ selected: index });
  }

  moveSelection(delta: number): number {
    const i = moveSelection(this.rows(), this.snap.selected, delta);
    this.set({ selected: i });
    return i;
  }

  /** Enter / click on a row: a file row toggles, a hit row opens the file at its line. */
  activate(index: number): void {
    const row = this.rows()[index];
    if (!row) return;
    this.set({ selected: index });
    if (row.kind === "file") this.toggleCollapsed(row.path);
    else this.deps.onOpen?.(row.path, row.hit.line, row.hit.col);
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.abortActive();
    this.listeners.clear();
  }
}
