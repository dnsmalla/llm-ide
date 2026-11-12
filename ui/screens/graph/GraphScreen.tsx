// The Code Graph screen: toolbar, search, filters, canvas or node list, details. Everything here reads a
// `GraphStore`; the section entry (index.tsx) wires the real host, worker and shell bus, tests wire fakes.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { invokeHost } from "../shell/host";
import { Controls } from "./Controls.tsx";
import { NodeDetails } from "./Details.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { GraphFileTree } from "./FileTree.tsx";
import { NodeList } from "./NodeList.tsx";
import { CancelledState, EmptyState, ErrorState, LoadingState, NoProjectState, TooLargeState } from "./States.tsx";
import { FullPageGraph } from "./FullPage.tsx";
import { buildAdjacency, communitySummary, countOnes, docSplit, isDocKind, nodeMask, setSymbolsShown, symbolKinds, symbolsShown } from "./filters.ts";
import { DOC_LEGEND, kindColor } from "./colors.ts";
import { NODE_BUDGET } from "./lod.ts";
import { searchNodes } from "./search.ts";
import type { GraphStore } from "./store.ts";
import { graphCandidates } from "./source.ts";
import type { ViewCamera, ViewOptions, GraphView } from "./view.ts";

export interface GraphScreenProps {
  store: GraphStore;
  active: boolean;
  projectRoot: string | null;
  /** Generate system/graph/graph.json with the host's GraphKit runner (`code`, `memory`, `all`). */
  onGenerate?: (mode: "code" | "memory" | "all", target: string) => Promise<void>;
  /** Ask the shell to open a project-relative file in Explorer. */
  openFile: (path: string) => void;
  /** Stop the running generator; the screen keeps its previous graph. */
  onCancel?: () => void;
  createView?: (o: ViewOptions) => Promise<GraphView | null>;
}

const num = (n: number) => n.toLocaleString("en-US");

export function GraphScreen({ store, active, projectRoot, openFile, createView, onGenerate, onCancel }: GraphScreenProps) {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const loadedFor = useRef<string | null | undefined>(undefined);
  const staleWhileHidden = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const camera = useRef<ViewCamera | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [mode, setMode] = useState<"code" | "memory" | "all">("code");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const cancelRequested = useRef(false);
  const [showLabels, setShowLabels] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  // Full page shows the canvas alone over the window (the Mac's expanded overlay). It is a view state, not a graph state.
  const [fullPage, setFullPage] = useState(false);
  const closeFullPage = useCallback(() => setFullPage(false), []);
  // Leaving full page gives focus back to the button that opened it (it remounts with the normal view).
  const expandBtn = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);
  useEffect(() => {
    if (wasFull.current && !fullPage) expandBtn.current?.focus();
    wasFull.current = fullPage;
  }, [fullPage]);

  // Load lazily on first show, and again when the project changes; never while another section is shown.
  useEffect(() => {
    const key = `${projectRoot ?? ""}:${mode}`;
    if (!active || loadedFor.current === key) return;
    loadedFor.current = key;
    camera.current = null;
    setFatal(null);
    void store.load(projectRoot, graphCandidates(mode));
  }, [active, projectRoot, mode, store]);
  // The host timer writes graph-code.json in the background (code mode only). Stay subscribed while hidden, remember
  // the refresh, and refresh quietly when this section becomes visible again (the shell keeps sections mounted).
  useEffect(() => {
    if (mode !== "code") return;
    let live = true;
    let un: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => listen("graph-auto-updated", () => {
      if (!activeRef.current) { staleWhileHidden.current = true; return; }
      void store.refresh(projectRoot, graphCandidates(mode));
    })).then((fn) => { if (live) un = fn; else fn(); }).catch(() => undefined);
    return () => { live = false; un?.(); };
  }, [projectRoot, mode, store]);
  useEffect(() => {
    if (!active || !staleWhileHidden.current) return;
    staleWhileHidden.current = false;
    if (mode !== "code") return;
    void store.refresh(projectRoot, graphCandidates(mode));
  }, [active, projectRoot, mode, store]);
  useEffect(() => () => store.cancel(), [store]);
  useEffect(() => {
    if (!projectRoot) { setRepos([]); setTarget(""); return; }
    let live = true;
    void invokeHost<unknown>("fs_list_dir", { req: { path: "code" } }).then((raw) => {
      if (!live) return;
      const o = raw && typeof raw === "object" ? raw as { entries?: Array<{ path?: unknown; kind?: unknown; hidden?: unknown; ignored?: unknown }> } : {};
      const dirs = (o.entries ?? []).filter((e) => e.kind === "dir" && e.hidden !== true && e.ignored !== true && typeof e.path === "string").map((e) => e.path as string);
      setRepos(dirs);
      // The Mac's scan target: the only repo when there is exactly one, otherwise the one picked in Quick Pick.
      setTarget((cur) => (dirs.length === 1 ? dirs[0] : dirs.includes(cur) ? cur : ""));
    }).catch(() => { if (live) setRepos([]); });
    return () => { live = false; };
  }, [projectRoot]);

  const entry = s.entry;
  const adj = useMemo(() => (entry ? buildAdjacency(entry.model) : null), [entry]);
  const communities = useMemo(() => (entry ? communitySummary(entry.model, entry.layout) : []), [entry]);
  const deferredQuery = useDeferredValue(s.query);
  const results = useMemo(() => (entry ? searchNodes(entry.model, deferredQuery) : new Uint32Array(0)), [entry, deferredQuery]);
  const split = useMemo(() => (entry ? docSplit(entry.model) : null), [entry]);
  const shown = useMemo(() => (entry ? countOnes(nodeMask(entry.model, entry.layout, s.filters)) : 0), [entry, s.filters]);

  if (s.phase === "loading" || s.phase === "idle") {
    return <div className="gr-root" data-active={active}><LoadingState stage={s.stage} onCancel={() => store.cancel()} /></div>;
  }
  const wrap = (child: React.ReactNode) => <div className="gr-root" data-active={active}>{child}</div>;
  if (s.phase === "no-project") return wrap(<NoProjectState />);
  const reloadCurrent = () => store.load(projectRoot, graphCandidates(mode));
  if (s.phase === "cancelled") return wrap(<CancelledState onReload={() => void reloadCurrent()} />);
  const runGeneration = (targetPath: string, modeOverride: "code" | "memory" | "all" = mode) => {
    if (!onGenerate || generating) return;
    cancelRequested.current = false;
    setGenerating(true);
    setGenerateError(null);
    void onGenerate(modeOverride, targetPath)
      .then(() => store.load(projectRoot, graphCandidates(modeOverride)))
      .catch((e: unknown) => setGenerateError(cancelRequested.current ? "Graph generation cancelled." : e instanceof Error ? e.message : "The graph could not be generated."))
      .finally(() => { cancelRequested.current = false; setGenerating(false); });
  };

  // The Mac's scan target. Code scans the picked repo only; InfiniteBrain and All fall back to the first repo.
  const baseName = (p: string): string => p.split("/").pop() ?? p;
  const scanTarget = target || repos[0] || "";
  const generateTarget = mode === "code" ? target : scanTarget;
  const canGenerate = !generating && !!onGenerate && generateTarget !== "";
  const runLabel = mode === "code"
    ? (target ? `Generate Code Graph for ${baseName(target)}` : "Generate Code Graph")
    : mode === "memory"
      ? (scanTarget ? `Generate InfiniteBrain for ${baseName(scanTarget)}` : "Generate InfiniteBrain")
      : (scanTarget ? `Generate Graph for ${baseName(scanTarget)}` : "Generate Graph");

  const quickPick = repos.length > 0 ? (
    <div className="gr-quick" aria-label="Quick pick repositories">
      <h3 className="gr-quick-title">Quick Pick</h3>
      {repos.map((r) => (
        <button key={r} type="button" className="gr-quick-repo" data-on={target === r || undefined} disabled={generating} title={`Load graph for ${baseName(r)}`} onClick={() => { setTarget(r); setMode("code"); setGenerateError(null); runGeneration(r, "code"); }}>
          <span>‹/› {r.split("/").pop()}</span><span aria-hidden="true">▶</span>
        </button>
      ))}
    </div>
  ) : null;
  const runFooter = (
    <div className="gr-run-footer">
      <div className="gr-run-modes" role="radiogroup" aria-label="Graph mode">
        {([["code", "Code"], ["memory", "InfiniteBrain"], ["all", "All"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className="gr-seg-btn" data-on={mode === id} disabled={generating} onClick={() => { setMode(id); setGenerateError(null); store.select(-1); }}>{label}</button>
        ))}
      </div>
      <p className="gr-muted">
        {repos.length === 0
          ? "Pick a repo in Settings → GitLab/GitHub to generate a graph."
          : mode === "code"
            ? (target ? `Scans code in ${baseName(target)} into a symbol graph.` : "Pick a repo in Quick Pick to scan its code.")
            : mode === "memory"
              ? `Builds a doc graph from the .md/.txt docs in ${baseName(scanTarget)}.`
              : `Builds one graph from all code + docs in ${baseName(scanTarget)}, with cross-links.`}
      </p>
      <button
        type="button"
        className="gr-btn gr-btn-primary"
        disabled={!canGenerate}
        onClick={() => runGeneration(generateTarget)}
      >
        {generating ? "Generating…" : runLabel}
      </button>
      {generating && onCancel ? <button type="button" className="gr-btn" onClick={() => { cancelRequested.current = true; onCancel(); }}>Cancel</button> : null}
      <button type="button" className="gr-btn" disabled={generating} onClick={() => void reloadCurrent()}>Check again</button>
      {generateError ? <p className="gr-error" role="alert">{generateError}</p> : null}
    </div>
  );

  // Empty, too-large and error states keep the generate and mode controls: a corrupt or oversized graph is fixed by
  // regenerating it, and "Try again" alone cannot do that.
  const withRunPanel = (main: React.ReactNode) => wrap(
    <div className="gr-empty-shell">
      <aside className="gr-run-panel" aria-label="Graph generation">{quickPick}{runFooter}</aside>
      <main className="gr-empty-main">{main}</main>
    </div>,
  );
  if (s.phase === "empty") return withRunPanel(<EmptyState mode={mode} />);
  if (s.phase === "too-large") return withRunPanel(<TooLargeState onOpen={(p) => store.openPath(p)} />);
  if (s.phase === "error" || !entry || !adj) return withRunPanel(<ErrorState message={s.error ?? "Unknown error."} onRetry={() => void reloadCurrent()} />);

  const { model, layout } = entry;
  const sel = s.selected;
  const hasSymbols = symbolKinds(model).length > 0;
  const symbolsOn = symbolsShown(model, s.filters);
  const focusedName = s.focus >= 0 && s.focus < model.n ? model.titles[s.focus] : null;
  const notices = [...entry.notices];
  if (layout.engine === "fallback") notices.unshift("Showing a simplified layout because the layout engine could not start.");
  const kindSet = new Set(model.nodeKinds);
  const docGraph = model.nodeKinds.some(isDocKind);
  const legend = DOC_LEGEND.filter((l) => kindSet.has(l.kind));

  if (fullPage) {
    return wrap(
      <FullPageGraph onClose={closeFullPage} active={active}>
        <GraphCanvas
          model={model}
          layout={layout}
          adj={adj}
          filters={s.filters}
          selected={sel}
          focused={s.focus}
          active={active}
          camera={camera}
          showLabels={showLabels}
          onSelect={(i) => store.select(i)}
          onFocus={(i) => store.setFocus(i < 0 || i === store.getSnapshot().focus ? -1 : i)}
          onFatal={setFatal}
          createView={createView}
        />
      </FullPageGraph>,
    );
  }

  // The numbers and kind legend sit quietly over the canvas, not in the toolbar.
  const hud = (
    <>
      <span aria-label="Nodes shown">{num(shown)} / {num(model.n)} shown</span>
      {docGraph ? <span className="gr-legend-inline" aria-label="Node kinds">{legend.map((l) => <span key={l.kind}><i style={{ background: kindColor(l.kind) }} aria-hidden="true" />{l.label}</span>)}</span> : null}
    </>
  );

  return (
    <div className="gr-root" data-active={active}>
      <header className="gr-top">
        <div className="gr-heading">
          <h2 className="gr-title">Code Graph</h2>
          <p className="gr-summary" role="status">{num(model.n)} nodes, {num(model.m)} edges, {num(layout.communityCount)} communities{split && split.doc > 0 ? ` · ${num(split.code)} code · ${num(split.doc)} doc` : ""}{model.n > NODE_BUDGET ? " · overview: click a node to reveal its neighbours" : ""}</p>
        </div>
        <div role="tablist" aria-label="Graph views" className="gr-seg">
          <button type="button" role="tab" id="gr-tab-graph" aria-selected={s.tab === "graph"} aria-controls="gr-panel-graph" className="gr-seg-btn" data-on={s.tab === "graph"} onClick={() => store.setTab("graph")}>Graph</button>
          <button type="button" role="tab" id="gr-tab-list" aria-selected={s.tab === "list"} aria-controls="gr-panel-list" className="gr-seg-btn" data-on={s.tab === "list"} onClick={() => store.setTab("list")}>Nodes</button>
        </div>
        <div className="gr-canvas-tools" role="group" aria-label="Graph display">
          {hasSymbols ? (
            <button type="button" className="gr-btn" aria-pressed={symbolsOn} onClick={() => store.setFilters({ hiddenKinds: setSymbolsShown(model, s.filters, !symbolsOn) })}>Symbols</button>
          ) : null}
          <button type="button" className="gr-btn" aria-pressed={showLabels} onClick={() => setShowLabels((v) => !v)}>Labels</button>
          {focusedName !== null ? (
            <button type="button" className="gr-btn gr-chip" title="Clear focus (or double-click empty space)" onClick={() => store.setFocus(-1)}>Focus: {focusedName} ✕</button>
          ) : null}
          <button ref={expandBtn} type="button" className="gr-btn gr-icon-btn" aria-label="Expand graph to full page" title="Expand graph to full page" onClick={() => setFullPage(true)}>⛶</button>
          <button type="button" className="gr-btn" title="Read the graph file again" onClick={() => void reloadCurrent()}>Reload</button>
        </div>
      </header>
      {notices.length > 0 && (
        <div className="gr-notices">{notices.slice(0, 4).map((n) => <StatusBanner key={n} severity="info" message={n} />)}</div>
      )}
      {s.refining && <StatusBanner severity="info" message="Showing a quick approximate layout while the full layout is computed. The picture will settle in a few seconds." />}
      {!s.refining && s.error && <StatusBanner severity="warning" message={s.error} />}
      {fatal && <StatusBanner severity="error" message={`${fatal} The Nodes tab still works.`} />}
      <div className="gr-body">
        <div className="gr-side">
          <div className="gr-find">
            <label className="gr-field gr-search">
              <span className="gr-sr">Search nodes</span>
              <input type="search" value={s.query} spellCheck={false} placeholder="Search nodes by name or path" onChange={(e) => store.setQuery(e.target.value)} />
            </label>
            {s.query.trim() !== "" && (
              <div className="gr-results">
                <p className="gr-muted" role="status">{num(results.length)} match{results.length === 1 ? "" : "es"}</p>
                <NodeList id="gr-search" label="Search results" model={model} layout={layout} count={results.length} nodeAt={(k) => results[k]} selected={sel} onSelect={(i) => store.revealNode(i)} initialViewport={240} emptyText="No node matches." />
              </div>
            )}
          </div>
          {repos.length > 1 ? quickPick : null}
          <GraphFileTree
            paths={model.paths}
            selected={s.query}
            onSelect={(path) => store.setQuery(path)}
            onClear={() => store.setQuery("")}
          />
          {/* Everything that is not needed to look around: filters, communities and generating the graph. */}
          <details className="gr-advanced">
            <summary>Advanced</summary>
            <div className="gr-advanced-body">
              <h3 className="gr-subhead">Filters and communities</h3>
              <Controls model={model} communities={communities} filters={s.filters} onChange={(patch) => store.setFilters(patch)} />
              <h3 className="gr-subhead">Generate graph</h3>
              {runFooter}
            </div>
          </details>
        </div>
        <main className="gr-main">
          <div id="gr-panel-graph" role="tabpanel" aria-labelledby="gr-tab-graph" hidden={s.tab !== "graph"} className="gr-panel">
            <GraphCanvas
              model={model}
              layout={layout}
              adj={adj}
              filters={s.filters}
              selected={sel}
              focused={s.focus}
              active={active && s.tab === "graph"}
              camera={camera}
              showLabels={showLabels}
              hud={hud}
              onSelect={(i) => store.select(i)}
              onFocus={(i) => store.setFocus(i < 0 || i === store.getSnapshot().focus ? -1 : i)}
              onFatal={setFatal}
              createView={createView}
            />
          </div>
          <div id="gr-panel-list" role="tabpanel" aria-labelledby="gr-tab-list" hidden={s.tab !== "list"} className="gr-panel">
            {s.tab === "list" && (
              <NodeList id="gr-all" label="All nodes" model={model} layout={layout} count={model.n} nodeAt={(k) => k} selected={sel} onSelect={(i) => store.select(i)} initialViewport={520} />
            )}
          </div>
        </main>
        {sel >= 0 && (
          <NodeDetails model={model} layout={layout} adj={adj} node={sel} onSelect={(i) => store.select(i)} onOpenFile={model.paths[sel] !== null ? openFile : null} onRegenerate={canGenerate ? () => runGeneration(generateTarget) : null} onClose={() => store.select(-1)} />
        )}
      </div>
    </div>
  );
}
