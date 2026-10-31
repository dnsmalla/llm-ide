// Mounts the sigma view while the screen is visible and tears it down (WebGL context released) when it is
// hidden or the graph changes. Keyboard: arrows pan, + and - zoom, 0 resets, [ and ] step through the
// selected node's neighbours, Escape clears the selection. The Nodes tab is the full alternative.
import { useEffect, useRef, useState } from "react";
import type { Adjacency, FilterState } from "./filters.ts";
import type { GraphModel, LayoutResult } from "./model.ts";
import { GraphView, type ViewCamera, type ViewOptions } from "./view.ts";

export interface GraphCanvasProps {
  model: GraphModel;
  layout: LayoutResult;
  adj: Adjacency;
  filters: FilterState;
  selected: number;
  active: boolean;
  camera: { current: ViewCamera | null };
  onSelect: (node: number) => void;
  onFatal: (message: string) => void;
  createView?: (o: ViewOptions) => Promise<GraphView | null>;
}

export function GraphCanvas(p: GraphCanvasProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const view = useRef<GraphView | null>(null);
  const latest = useRef({ filters: p.filters, selected: p.selected });
  latest.current = { filters: p.filters, selected: p.selected };
  const [building, setBuilding] = useState(false);
  // The saved camera belongs to one layout: a new layout (preview replaced by the full one) starts fitted.
  const cameraFor = useRef<LayoutResult | null>(null);
  const create = p.createView ?? GraphView.create;

  useEffect(() => {
    const el = box.current;
    if (!p.active || !el) return;
    let cancelled = false;
    if (cameraFor.current !== p.layout) { p.camera.current = null; cameraFor.current = p.layout; }
    setBuilding(true);
    void create({
      container: el,
      model: p.model,
      layout: p.layout,
      filters: latest.current.filters,
      selected: latest.current.selected,
      camera: p.camera.current,
      onSelect: p.onSelect,
      onCamera: (c) => { p.camera.current = c; },
      onFatal: p.onFatal,
      shouldAbort: () => cancelled,
    }).then((v) => {
      if (cancelled) { v?.dispose(); return; }
      view.current = v;
      setBuilding(false);
      v?.update(latest.current.filters, latest.current.selected);
    });
    return () => {
      cancelled = true;
      view.current?.dispose();
      view.current = null;
    };
    // The view is rebuilt only when it appears or the graph changes; filters and selection update it in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.active, p.model, p.layout]);

  const stepRef = useRef<{ origin: number; k: number; current: number } | null>(null);
  const prevSel = useRef(-1);
  useEffect(() => {
    view.current?.update(p.filters, p.selected);
    if (p.selected >= 0 && p.selected !== prevSel.current) view.current?.focus(p.selected);
    prevSel.current = p.selected;
  }, [p.filters, p.selected]);

  const onKey = (e: React.KeyboardEvent) => {
    const v = view.current;
    if (!v) return;
    const step = 0.06;
    switch (e.key) {
      case "ArrowLeft": v.pan(-step, 0); break;
      case "ArrowRight": v.pan(step, 0); break;
      case "ArrowUp": v.pan(0, step); break;
      case "ArrowDown": v.pan(0, -step); break;
      case "+": case "=": v.zoomIn(); break;
      case "-": case "_": v.zoomOut(); break;
      case "0": v.reset(); break;
      case "Escape": p.onSelect(-1); break;
      case "[": case "]": {
        if (p.selected < 0) return;
        // Stepping keeps the node you started from as the origin, so repeated presses walk ITS neighbours.
        const st = stepRef.current;
        const stepping = st !== null && st.current === p.selected;
        const origin = stepping ? st.origin : p.selected;
        const lo = p.adj.start[origin], hi = p.adj.start[origin + 1];
        if (hi === lo) return;
        const dir = e.key === "]" ? 1 : -1;
        const len = hi - lo;
        const prev = stepping ? st.k : -1;
        const k = prev === -1 ? (dir > 0 ? 0 : len - 1) : (prev + dir + len) % len;
        const next = p.adj.nbr[lo + k];
        stepRef.current = { origin, k, current: next };
        p.onSelect(next);
        break;
      }
      default: return;
    }
    e.preventDefault();
  };

  return (
    <div
      className="gr-canvas-wrap"
      tabIndex={0}
      role="group"
      aria-label="Code graph canvas. Arrow keys pan, plus and minus zoom, zero resets, brackets step through the selected node's neighbours, Escape clears the selection. The Nodes tab lists every node."
      onKeyDown={onKey}
    >
      <div ref={box} className="gr-canvas" data-testid="graph-canvas" />
      {building && <div className="gr-building" role="status">Drawing {p.model.n.toLocaleString("en-US")} nodes...</div>}
      <div className="gr-zoom" role="group" aria-label="Zoom">
        <button type="button" className="gr-btn" aria-label="Zoom in" onClick={() => view.current?.zoomIn()}>+</button>
        <button type="button" className="gr-btn" aria-label="Zoom out" onClick={() => view.current?.zoomOut()}>-</button>
        <button type="button" className="gr-btn" aria-label="Fit the whole graph" onClick={() => view.current?.reset()}>Fit</button>
      </div>
    </div>
  );
}
