// The Code Graph screen: toolbar, search, filters, canvas or node list, details. Everything here reads a
// `GraphStore`; the section entry (index.tsx) wires the real host, worker and shell bus, tests wire fakes.
import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { invokeHost } from "../shell/host";
import { Controls } from "./Controls.tsx";
import { NodeDetails } from "./Details.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { GraphFileTree } from "./FileTree.tsx";
import { NodeList } from "./NodeList.tsx";
import { EmptyState, ErrorState, LoadingState, NoProjectState, TooLargeState } from "./States.tsx";
import { buildAdjacency, communitySummary } from "./filters.ts";
import { DOC_LEGEND, kindColor } from "./colors.ts";
import { searchNodes } from "./search.ts";
import type { GraphStore } from "./store.ts";
import type { ViewCamera, ViewOptions, GraphView } from "./view.ts";

export interface GraphScreenProps {
  store: GraphStore;
  active: boolean;
  projectRoot: string | null;
  /** Generate system/graph/graph.json with the host's GraphKit runner (`code`, `memory`, `all`). */
  onGenerate?: (mode: "code" | "memory" | "all", target: string) => Promise<void>;
  /** Ask the shell to open a project-relative file in Explorer. */
  openFile: (path: string) => void;
  createView?: (o: ViewOptions) => Promise<GraphView | null>;
}

const num = (n: number) => n.toLocaleString("en-US");

export function GraphScreen({ store, active, projectRoot, openFile, createView, onGenerate }: GraphScreenProps) {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const loadedFor = useRef<string | null | undefined>(undefined);
  const camera = useRef<ViewCamera | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [mode, setMode] = useState<"code" | "memory" | "all">("code");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showSymbols, setShowSymbols] = useState(true);
  const [repos, setRepos] = useState<string[]>([]);
  const [target, setTarget] = useState("");

  // Load lazily on first show, and again when the project changes; never while another section is shown.
  useEffect(() => {
    if (!active || loadedFor.current === projectRoot) return;
    loadedFor.current = projectRoot;
    camera.current = null;
    setFatal(null);
    void store.load(projectRoot);
  }, [active, projectRoot, store]);
  useEffect(() => () => store.cancel(), [store]);
  useEffect(() => {
    if (!projectRoot) { setRepos([]); setTarget(""); return; }
    let live = true;
    void invokeHost<unknown>("fs_list_dir", { req: { path: "code" } }).then((raw) => {
      if (!live) return;
      const o = raw && typeof raw === "object" ? raw as { entries?: Array<{ path?: unknown; kind?: unknown; hidden?: unknown; ignored?: unknown }> } : {};
      const dirs = (o.entries ?? []).filter((e) => e.kind === "dir" && e.hidden !== true && e.ignored !== true && typeof e.path === "string").map((e) => e.path as string);
      setRepos(dirs);
      setTarget((cur) => cur || dirs[0] || "");
    }).catch(() => { if (live) setRepos([]); });
    return () => { live = false; };
  }, [projectRoot]);

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
  const runGeneration = (targetPath: string, modeOverride: "code" | "memory" | "all" = mode) => {
    if (!onGenerate || generating) return;
    setGenerating(true);
    setGenerateError(null);
    void onGenerate(modeOverride, targetPath).then(() => store.reload()).catch((e: unknown) => setGenerateError(e instanceof Error ? e.message : "The graph could not be generated.")).finally(() => setGenerating(false));
  };

  const runFooter = (
    <div className="gr-run-footer">
      {repos.length > 0 ? (
        <div className="gr-quick" aria-label="Quick pick repositories">
          <h3 className="gr-quick-title">Quick Pick</h3>
          {repos.map((r) => (
            <button key={r} type="button" className="gr-quick-repo" data-on={target === r || undefined} disabled={generating} title={`Generate from ${r}`} onClick={() => { setMode("code"); setTarget(r); runGeneration(r, "code"); }}>
              <span>‹/› {r.split("/").pop()}</span><span aria-hidden="true">▶</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="gr-run-modes" role="radiogroup" aria-label="Graph mode">
        {([["code", "Code"], ["memory", "InfiniteBrain"], ["all", "All"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className="gr-seg-btn" data-on={mode === id} disabled={generating} onClick={() => { setMode(id); setGenerateError(null); }}>{label}</button>
        ))}
      </div>
      <p className="gr-muted">
        {mode === "code" ? "Scans code into a symbol graph." : mode === "memory" ? "Scans the selected repo's .md/.txt docs into an InfiniteBrain graph." : "Merges code and llm-doc into one graph."}
      </p>
      <button
        type="button"
        className="gr-btn gr-btn-primary"
        disabled={generating || !onGenerate}
        onClick={() => runGeneration(target)}
      >
        {generating ? "Generating…" : mode === "code" ? "Generate Code Graph" : mode === "memory" ? "Generate InfiniteBrain" : "Generate Graph"}
      </button>
      <button type="button" className="gr-btn" disabled={generating} onClick={() => void store.reload()}>Check again</button>
      {generateError ? <p className="gr-error" role="alert">{generateError}</p> : null}
    </div>
  );

  if (s.phase === "empty") {
    return wrap(
      <div className="gr-empty-shell">
        <aside className="gr-run-panel" aria-label="Graph generation">{runFooter}</aside>
        <main className="gr-empty-main"><EmptyState mode={mode} /></main>
      </div>,
    );
  }
  if (s.phase === "too-large") return wrap(<TooLargeState onOpen={(p) => store.openPath(p)} />);
  if (s.phase === "error" || !entry || !adj) return wrap(<ErrorState message={s.error ?? "Unknown error."} onRetry={() => void store.reload()} />);

  const { model, layout } = entry;
  const sel = s.selected;
  const notices = [...entry.notices];
  if (layout.engine === "fallback") notices.unshift("Showing a simplified layout because the layout engine could not start.");
  const kindSet = new Set(model.nodeKinds);
  const docGraph = model.nodeKinds.some((k) => k.startsWith("note") || k === "memoryDoc" || k === "memoryChunk" || k === "docPage");
  const legend = DOC_LEGEND.filter((l) => kindSet.has(l.kind));

  return (
    <div className="gr-root" data-active={active}>
      <header className="gr-top">
        <h2 className="gr-title">Code Graph</h2>
        <p className="gr-summary" role="status">
          {num(model.n)} nodes, {num(model.m)} edges, {num(layout.communityCount)} communities
          {s.cached ? ", from cache" : `, laid out in ${layout.ms < 1000 ? `${Math.round(layout.ms)} ms` : `${(layout.ms / 1000).toFixed(1)} s`}`}
          {s.sourcePath ? ` · ${s.sourcePath}` : ""}
        </p>
        <div className="gr-canvas-tools" role="group" aria-label="Graph display">
          <button type="button" className="gr-btn" aria-pressed={showSymbols} onClick={() => {
            const next = new Set(s.filters.hiddenKinds);
            if (showSymbols) next.add("symbol"); else next.delete("symbol");
            setShowSymbols(!showSymbols);
            store.setFilters({ hiddenKinds: next });
          }}>Symbols</button>
          <div className="gr-seg" role="radiogroup" aria-label="Dimensions">
            <button type="button" role="radio" aria-checked="true" className="gr-seg-btn" data-on="true">2D</button>
            <button type="button" role="radio" aria-checked="false" className="gr-seg-btn" disabled title="3D is not available in the desktop renderer">3D</button>
          </div>
          <button type="button" className="gr-btn" aria-pressed={showLabels} onClick={() => setShowLabels((v) => !v)}>Labels</button>
          <span className="gr-muted">{num(model.n)} nodes</span>
          {docGraph ? <span className="gr-legend-inline" aria-label="Node kinds">{legend.map((l) => <span key={l.kind}><i style={{ background: kindColor(l.kind) ?? "transparent" }} aria-hidden="true" />{l.label}</span>)}</span> : null}
          <button type="button" className="gr-btn" title="Toggle full screen" onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()).catch(() => undefined); }}>⛶</button>
        </div>
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
          <GraphFileTree
            paths={model.paths}
            selected={s.query}
            onSelect={(path) => store.setQuery(path)}
            onClear={() => store.setQuery("")}
          />
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
          {runFooter}
        </div>
        <main className="gr-main">
          <div id="gr-panel-graph" role="tabpanel" aria-labelledby="gr-tab-graph" hidden={s.tab !== "graph"} className="gr-panel">
            <GraphCanvas model={model} layout={layout} adj={adj} filters={s.filters} selected={sel} active={active && s.tab === "graph"} camera={camera} showLabels={showLabels} colorByKind={docGraph} onSelect={(i) => store.select(i)} onFatal={setFatal} createView={createView} />
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
