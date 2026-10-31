// The Code Graph screen: toolbar, search, filters, canvas or node list, details. Everything here reads a
// `GraphStore`; the section entry (index.tsx) wires the real host, worker and shell bus, tests wire fakes.
import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Controls } from "./Controls.tsx";
import { NodeDetails } from "./Details.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { NodeList } from "./NodeList.tsx";
import { EmptyState, ErrorState, LoadingState, NoProjectState, TooLargeState } from "./States.tsx";
import { buildAdjacency, communitySummary } from "./filters.ts";
import { searchNodes } from "./search.ts";
import type { GraphStore } from "./store.ts";
import type { ViewCamera, ViewOptions, GraphView } from "./view.ts";

export interface GraphScreenProps {
  store: GraphStore;
  active: boolean;
  projectRoot: string | null;
  /** Ask the shell to open a project-relative file in Explorer. */
  openFile: (path: string) => void;
  createView?: (o: ViewOptions) => Promise<GraphView | null>;
}

const num = (n: number) => n.toLocaleString("en-US");

export function GraphScreen({ store, active, projectRoot, openFile, createView }: GraphScreenProps) {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const loadedFor = useRef<string | null | undefined>(undefined);
  const camera = useRef<ViewCamera | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // Load lazily on first show, and again when the project changes; never while another section is shown.
  useEffect(() => {
    if (!active || loadedFor.current === projectRoot) return;
    loadedFor.current = projectRoot;
    camera.current = null;
    setFatal(null);
    void store.load(projectRoot);
  }, [active, projectRoot, store]);
  useEffect(() => () => store.cancel(), [store]);

  const entry = s.entry;
  const adj = useMemo(() => (entry ? buildAdjacency(entry.model) : null), [entry]);
  const communities = useMemo(() => (entry ? communitySummary(entry.model, entry.layout) : []), [entry]);
  const deferredQuery = useDeferredValue(s.query);
  const results = useMemo(() => (entry ? searchNodes(entry.model, deferredQuery) : new Uint32Array(0)), [entry, deferredQuery]);

  if (s.phase === "loading" || s.phase === "idle") {
    return <div className="gr-root" data-active={active}><LoadingState stage={s.stage} onCancel={() => store.cancel()} /></div>;
  }
  const wrap = (child: React.ReactNode) => <div className="gr-root" data-active={active}>{child}</div>;
  if (s.phase === "no-project") return wrap(<NoProjectState />);
  if (s.phase === "empty") return wrap(<EmptyState tried={s.tried} onOpen={(p) => store.openPath(p)} onRetry={() => void store.reload()} />);
  if (s.phase === "too-large") return wrap(<TooLargeState onOpen={(p) => store.openPath(p)} />);
  if (s.phase === "error" || !entry || !adj) return wrap(<ErrorState message={s.error ?? "Unknown error."} onRetry={() => void store.reload()} />);

  const { model, layout } = entry;
  const sel = s.selected;
  const notices = [...entry.notices];
  if (layout.engine === "fallback") notices.unshift("Showing a simplified layout because the layout engine could not start.");

  return (
    <div className="gr-root" data-active={active}>
      <header className="gr-top">
        <h2 className="gr-title">Code Graph</h2>
        <p className="gr-summary" role="status">
          {num(model.n)} nodes, {num(model.m)} edges, {num(layout.communityCount)} communities
          {s.cached ? ", from cache" : `, laid out in ${layout.ms < 1000 ? `${Math.round(layout.ms)} ms` : `${(layout.ms / 1000).toFixed(1)} s`}`}
          {s.sourcePath ? ` · ${s.sourcePath}` : ""}
        </p>
        <div role="tablist" aria-label="Graph views" className="gr-seg">
          <button type="button" role="tab" id="gr-tab-graph" aria-selected={s.tab === "graph"} aria-controls="gr-panel-graph" className="gr-seg-btn" data-on={s.tab === "graph"} onClick={() => store.setTab("graph")}>Graph</button>
          <button type="button" role="tab" id="gr-tab-list" aria-selected={s.tab === "list"} aria-controls="gr-panel-list" className="gr-seg-btn" data-on={s.tab === "list"} onClick={() => store.setTab("list")}>Nodes</button>
        </div>
        <button type="button" className="gr-btn" onClick={() => void store.reload()}>Reload</button>
      </header>
      {notices.length > 0 && (
        <div className="gr-notices">{notices.slice(0, 4).map((n) => <StatusBanner key={n} severity="info" message={n} />)}</div>
      )}
      {s.refining && <StatusBanner severity="info" message="Showing a quick approximate layout while the full layout is computed. The picture will settle in a few seconds." />}
      {!s.refining && s.error && <StatusBanner severity="warning" message={s.error} />}
      {fatal && <StatusBanner severity="error" message={`${fatal} The Nodes tab still works.`} />}
      <div className="gr-body">
        <div className="gr-side">
          <label className="gr-field">
            <span>Search nodes</span>
            <input type="search" value={s.query} spellCheck={false} placeholder="Name or path" onChange={(e) => store.setQuery(e.target.value)} />
          </label>
          {s.query.trim() !== "" && (
            <div className="gr-results">
              <p className="gr-muted" role="status">{num(results.length)} match{results.length === 1 ? "" : "es"}</p>
              <NodeList id="gr-search" label="Search results" model={model} layout={layout} count={results.length} nodeAt={(k) => results[k]} selected={sel} onSelect={(i) => store.select(i)} initialViewport={240} emptyText="No node matches." />
            </div>
          )}
          <Controls model={model} communities={communities} filters={s.filters} onChange={(patch) => store.setFilters(patch)} />
        </div>
        <main className="gr-main">
          <div id="gr-panel-graph" role="tabpanel" aria-labelledby="gr-tab-graph" hidden={s.tab !== "graph"} className="gr-panel">
            <GraphCanvas model={model} layout={layout} adj={adj} filters={s.filters} selected={sel} active={active && s.tab === "graph"} camera={camera} onSelect={(i) => store.select(i)} onFatal={setFatal} createView={createView} />
          </div>
          <div id="gr-panel-list" role="tabpanel" aria-labelledby="gr-tab-list" hidden={s.tab !== "list"} className="gr-panel">
            {s.tab === "list" && (
              <NodeList id="gr-all" label="All nodes" model={model} layout={layout} count={model.n} nodeAt={(k) => k} selected={sel} onSelect={(i) => store.select(i)} initialViewport={520} />
            )}
          </div>
        </main>
        {sel >= 0 && (
          <NodeDetails model={model} layout={layout} adj={adj} node={sel} onSelect={(i) => store.select(i)} onOpenFile={model.paths[sel] !== null ? openFile : null} onClose={() => store.select(-1)} />
        )}
      </div>
    </div>
  );
}
