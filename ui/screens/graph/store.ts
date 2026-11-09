// Screen state, framework-free (subscribe / getSnapshot, so React reads it with useSyncExternalStore and
// node tests drive it directly). Owns the load pipeline: read through the host, hash, layout in the worker,
// cache. A new load or `dispose` cancels the one in flight.
import type { CacheEntry } from "./cache.ts";
import type { LayoutEngine } from "./engine.ts";
import { carryFilters, defaultFilters, initialFilters, type FilterState } from "./filters.ts";
import { customGraphPath, readProjectGraph, type Invoke } from "./source.ts";

/** `cancelled`: the user stopped a load that had nothing on screen; it offers Reload (not a spinner forever). */
export type Phase = "idle" | "loading" | "cancelled" | "ready" | "empty" | "too-large" | "no-project" | "error";
export type Tab = "graph" | "list";

type ReadOutcome = Awaited<ReturnType<typeof readProjectGraph>>;

export interface GraphState {
  phase: Phase;
  /** Human text for the loading line ("Reading graph.json", "Laying out 50,000 nodes"). */
  stage: string;
  error: string | null;
  /** Project-relative path that was loaded. */
  sourcePath: string | null;
  tried: string[];
  entry: CacheEntry | null;
  cached: boolean;
  /** A preview layout is showing and the full layout is still being computed. */
  refining: boolean;
  selected: number;
  /** The node the canvas is focused on (double-click), or -1. Dims everything outside its neighbourhood. */
  focus: number;
  filters: FilterState;
  query: string;
  tab: Tab;
}

export interface StoreDeps {
  invoke: Invoke;
  engine: Pick<LayoutEngine, "cancel"> & { load: LayoutEngine["load"] };
}

const initial = (): GraphState => ({
  phase: "idle", stage: "", error: null, sourcePath: null, tried: [], entry: null, cached: false, refining: false,
  selected: -1, focus: -1, filters: initialFilters(), query: "", tab: "graph",
});

export class GraphStore {
  private state: GraphState = initial();
  private listeners = new Set<() => void>();
  private run = 0;
  private root: string | null = null;
  /** The text of the graph being shown or laid out; a refresh with the same text is a no-op. */
  private loadedText: string | null = null;
  private readonly deps: StoreDeps;
  constructor(deps: StoreDeps) {
    this.deps = deps;
  }

  getSnapshot = (): GraphState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(patch: Partial<GraphState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Load the project's graph. `rels` overrides the candidate paths (Open graph.json...). */
  load(root: string | null, rels?: readonly string[]): Promise<void> {
    return this.read(root, rels, false);
  }

  /**
   * Background refresh (the host wrote a new graph file). When a graph is on screen it stays there while the new one
   * is read, view state (filters, query, camera) is kept, and an unchanged file does no work at all. With nothing on
   * screen it is an ordinary load.
   */
  refresh(root: string | null, rels?: readonly string[]): Promise<void> {
    return this.read(root, rels, this.state.entry !== null);
  }

  private async read(root: string | null, rels: readonly string[] | undefined, silent: boolean): Promise<void> {
    let pre: ReadOutcome | null = null;
    if (silent) {
      // Read before touching the run counter or the engine: a refresh that changes nothing must not cancel the
      // layout that is running.
      const before = this.run;
      const got = await readProjectGraph(this.deps.invoke, root, rels);
      if (before !== this.run) return;
      this.root = root;
      if (!got.ok) {
        // The graph on screen is still valid; say why the refresh did not happen.
        this.set({ error: got.kind === "not-found" ? "graph.json was not found, so the graph shown may be out of date." : `The graph could not be refreshed: ${got.message}` });
        return;
      }
      // Same bytes as the graph on screen: nothing to lay out. Not while a preview is still refining, though: its
      // layout is the one that clears `refining`, so the refresh runs the layout again rather than leave it stranded.
      if (!this.state.refining && got.text === this.loadedText && got.path === this.state.sourcePath) {
        // An error from an earlier failed refresh is stale once the file reads again.
        if (this.state.error !== null) this.set({ error: null });
        return;
      }
      pre = got;
    }
    const run = ++this.run;
    this.deps.engine.cancel();
    this.root = root;
    if (!silent) this.set({ phase: "loading", stage: "Reading graph.json", error: null, entry: null, selected: -1, focus: -1, cached: false, refining: false });
    const read = pre ?? (await readProjectGraph(this.deps.invoke, root, rels));
    if (run !== this.run) return;
    if (!read.ok) {
      const phase: Phase = read.kind === "not-found" ? "empty" : read.kind;
      this.set({ phase, error: read.kind === "not-found" ? null : read.message, tried: read.tried, stage: "" });
      return;
    }
    this.loadedText = read.text;
    // The graph on screen before this load: a refresh carries its view state over to the new one.
    const shown = this.state.entry?.model ?? null;
    this.set({ sourcePath: read.path, ...(silent ? { error: null } : { stage: "Checking the file" }) });
    const out = await this.deps.engine.load(
      read.text,
      (s) => {
        if (run !== this.run || silent) return;
        this.set({ stage: s === "hash" ? "Checking the file" : s === "decode" ? "Reading nodes and edges" : "Laying out the graph" });
      },
      (p) => {
        if (run !== this.run) return;
        // First frame: a fast approximate layout, replaced when the full one arrives.
        if (silent) {
          this.set({ phase: p.model.n === 0 ? "empty" : "ready", entry: p, refining: true, selected: -1, focus: -1, filters: carryFilters(shown, this.state.filters, p.model, p.layout) });
          return;
        }
        this.set({ phase: p.model.n === 0 ? "empty" : "ready", entry: p, stage: "", refining: true, filters: defaultFilters(p.model), query: "", selected: -1, focus: -1 });
      },
    );
    if (run !== this.run) return;
    if (out.kind === "cancelled") {
      this.loadedText = null;
      return;
    }
    if (out.kind === "error") {
      this.loadedText = null;
      // A graph that is already on screen (a preview, or the one a refresh replaces) stays usable; say what failed.
      if (this.state.entry) {
        this.set({ refining: false, error: this.state.refining ? `The full layout failed (${out.message}); the approximate layout is shown.` : `The graph could not be refreshed (${out.message}); the previous graph is shown.` });
      } else {
        this.set({ phase: "error", error: out.message, stage: "" });
      }
      return;
    }
    const firstView = !silent && !this.state.refining;
    this.set({
      phase: out.entry.model.n === 0 ? "empty" : "ready",
      entry: out.entry, cached: out.cached, refining: false, stage: "", error: null, tried: [],
      // A refreshed graph keeps filters and query, but its node indices no longer mean what the selection meant.
      ...(firstView
        ? { filters: defaultFilters(out.entry.model), query: "", selected: -1, focus: -1 }
        : silent
          ? { filters: carryFilters(shown, this.state.filters, out.entry.model, out.entry.layout), selected: -1, focus: -1 }
          : {}),
    });
  }

  reload(): Promise<void> {
    return this.load(this.root);
  }

  /** Open a graph.json at a project-relative path typed by the user; false when the path is not acceptable. */
  openPath(input: string): boolean {
    const rel = customGraphPath(input);
    if (rel === null) return false;
    void this.load(this.root, [rel]);
    return true;
  }

  cancel(): void {
    this.run++;
    this.deps.engine.cancel();
    this.loadedText = null;
    if (this.state.phase === "loading") this.set({ phase: this.state.entry ? "ready" : "cancelled", stage: "", refining: false });
    else if (this.state.refining) this.set({ refining: false });
  }

  select(i: number): void {
    const n = this.state.entry?.model.n ?? 0;
    this.set({ selected: Number.isInteger(i) && i >= 0 && i < n ? i : -1 });
  }

  /** Select a node from search/list, first making its kind and community visible. The Mac's search must not
   *  land on a node the canvas has filtered out; clearing the filters is the least surprising reveal. */
  revealNode(i: number): void {
    const entry = this.state.entry;
    if (!entry || !Number.isInteger(i) || i < 0 || i >= entry.model.n) return;
    const kind = entry.model.nodeKinds[entry.model.kindOf[i]];
    const hiddenKinds = new Set(this.state.filters.hiddenKinds);
    hiddenKinds.delete(kind);
    this.set({ filters: { ...this.state.filters, hiddenKinds, community: null, preset: "all" } });
    this.select(i);
  }
  /** Focus a node (-1 clears). Bounds-checked like `select`. */
  setFocus(i: number): void {
    const n = this.state.entry?.model.n ?? 0;
    this.set({ focus: Number.isInteger(i) && i >= 0 && i < n ? i : -1 });
  }
  setFilters(patch: Partial<FilterState>): void {
    this.set({ filters: { ...this.state.filters, ...patch } });
  }
  setQuery(q: string): void {
    this.set({ query: q.slice(0, 200) });
  }
  setTab(tab: Tab): void {
    this.set({ tab });
  }

  dispose(): void {
    this.run++;
    this.deps.engine.cancel();
    this.listeners.clear();
  }
}
