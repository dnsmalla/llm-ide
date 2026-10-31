// Screen state, framework-free (subscribe / getSnapshot, so React reads it with useSyncExternalStore and
// node tests drive it directly). Owns the load pipeline: read through the host, hash, layout in the worker,
// cache. A new load or `dispose` cancels the one in flight.
import type { CacheEntry } from "./cache.ts";
import type { LayoutEngine } from "./engine.ts";
import { initialFilters, type FilterState } from "./filters.ts";
import { customGraphPath, readProjectGraph, type Invoke } from "./source.ts";

export type Phase = "idle" | "loading" | "ready" | "empty" | "too-large" | "no-project" | "error";
export type Tab = "graph" | "list";

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
  selected: -1, filters: initialFilters(), query: "", tab: "graph",
});

export class GraphStore {
  private state: GraphState = initial();
  private listeners = new Set<() => void>();
  private run = 0;
  private root: string | null = null;
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
  async load(root: string | null, rels?: readonly string[]): Promise<void> {
    const run = ++this.run;
    this.deps.engine.cancel();
    this.root = root;
    this.set({ phase: "loading", stage: "Reading graph.json", error: null, entry: null, selected: -1, cached: false, refining: false });
    const read = await readProjectGraph(this.deps.invoke, root, rels);
    if (run !== this.run) return;
    if (!read.ok) {
      const phase: Phase = read.kind === "not-found" ? "empty" : read.kind;
      this.set({ phase, error: read.kind === "not-found" ? null : read.message, tried: read.tried, stage: "" });
      return;
    }
    this.set({ sourcePath: read.path, stage: "Checking the file" });
    const out = await this.deps.engine.load(
      read.text,
      (s) => {
        if (run !== this.run) return;
        this.set({ stage: s === "hash" ? "Checking the file" : s === "decode" ? "Reading nodes and edges" : "Laying out the graph" });
      },
      (p) => {
        if (run !== this.run) return;
        // First frame: a fast approximate layout, replaced when the full one arrives.
        this.set({ phase: p.model.n === 0 ? "empty" : "ready", entry: p, stage: "", refining: true, filters: initialFilters(), query: "", selected: -1 });
      },
    );
    if (run !== this.run) return;
    if (out.kind === "cancelled") return;
    if (out.kind === "error") {
      // A preview that is already on screen stays usable; say that the refinement failed.
      if (this.state.refining && this.state.entry) this.set({ refining: false, error: `The full layout failed (${out.message}); the approximate layout is shown.` });
      else this.set({ phase: "error", error: out.message, stage: "" });
      return;
    }
    this.set({
      phase: out.entry.model.n === 0 ? "empty" : "ready",
      entry: out.entry, cached: out.cached, refining: false, stage: "", error: null, tried: [],
      ...(this.state.refining ? {} : { filters: initialFilters(), query: "", selected: -1 }),
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
    if (this.state.phase === "loading") this.set({ phase: this.state.entry ? "ready" : "idle", stage: "" });
  }

  select(i: number): void {
    const n = this.state.entry?.model.n ?? 0;
    this.set({ selected: Number.isInteger(i) && i >= 0 && i < n ? i : -1 });
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
