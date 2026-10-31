// The sigma/WebGL view. One instance per visible screen: it is created when the screen shows and disposed
// (WebGL context released) when it hides, so a hidden Code Graph holds typed arrays but no GPU memory.
// No per-node React components: nodes and edges live in one graphology graph, drawn by sigma.
//
// Level of detail is applied in the reducers from a plan computed off the camera zoom (lod.ts); the view
// re-processes only when the plan's coarse key changes, after the camera has been still for a moment, and
// sigma hides edges while the camera moves, so pan and zoom stay smooth at 50k nodes.
import Graph from "graphology";
import Sigma from "sigma";
import type { GraphModel, LayoutResult } from "./model.ts";
import { buildAdjacency, edgeWeights, type Adjacency, type FilterState } from "./filters.ts";
import { planLod, weightHistogram, type LodPlan } from "./lod.ts";
import { edgeShown, labelShown, visibleNodes } from "./visibility.ts";
import { communityColor, DIM_COLOR, EDGE_COLORS, NEIGHBOUR_COLOR, SELECT_COLOR } from "./colors.ts";

export interface ViewCamera {
  x: number;
  y: number;
  ratio: number;
}

export interface ViewOptions {
  container: HTMLElement;
  model: GraphModel;
  layout: LayoutResult;
  filters: FilterState;
  selected: number;
  camera: ViewCamera | null;
  onSelect(i: number): void;
  onCamera(c: ViewCamera): void;
  /** Called when WebGL is unavailable or the context is lost for good. */
  onFatal(message: string): void;
  /** Polled between build chunks: true when the screen no longer wants this view. */
  shouldAbort?: () => boolean;
}

const CHUNK = 6000;
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

export class GraphView {
  private sigma: Sigma | null = null;
  private graph: Graph | null = null;
  private visible: Uint8Array = new Uint8Array(0);
  private plan: LodPlan;
  private filters: FilterState;
  private selected: number;
  private neighbour: Uint8Array = new Uint8Array(0);
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly adj: Adjacency;
  private readonly weights: Float32Array;
  private readonly hist: Uint32Array;
  private readonly ring: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly maxRadius: number;

  private constructor(private readonly o: ViewOptions) {
    this.filters = o.filters;
    this.selected = o.selected;
    this.adj = buildAdjacency(o.model);
    this.weights = edgeWeights(o.model);
    this.hist = weightHistogram(this.weights);
    let mr = 1;
    for (let i = 0; i < o.layout.n; i++) if (o.layout.radius[i] > mr) mr = o.layout.radius[i];
    this.maxRadius = mr;
    this.plan = planLod(o.model.n, o.model.m, o.camera?.ratio ?? 1, this.hist);
    this.ring = document.createElement("div");
    this.ring.className = "gr-ring";
    this.ring.hidden = true;
    this.tip = document.createElement("div");
    this.tip.className = "gr-tip";
    this.tip.hidden = true;
    this.tip.setAttribute("aria-hidden", "true");
  }

  /** Builds the graph in chunks (yielding between them so the UI stays responsive) and mounts sigma. Null when disposed meanwhile. */
  static async create(o: ViewOptions): Promise<GraphView | null> {
    const v = new GraphView(o);
    const ok = await v.build();
    return ok ? v : null;
  }

  private async build(): Promise<boolean> {
    const { model, layout } = this.o;
    const g = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    for (let s = 0; s < model.n; s += CHUNK) {
      if (this.gone()) return false;
      const end = Math.min(model.n, s + CHUNK);
      for (let i = s; i < end; i++) {
        g.addNode(i, { x: layout.pos[2 * i], y: layout.pos[2 * i + 1], size: 1.5 + 6 * Math.sqrt(layout.radius[i] / this.maxRadius), i });
      }
      await yieldToMain();
    }
    const seen = new Set<number>();
    for (let s = 0; s < model.m; s += CHUNK) {
      if (this.gone()) return false;
      const end = Math.min(model.m, s + CHUNK);
      for (let e = s; e < end; e++) {
        const a = model.from[e], b = model.to[e];
        const key = a * model.n + b;
        if (seen.has(key)) continue; // parallel edges: the first one is drawn (all stay in the model and the details)
        seen.add(key);
        g.addDirectedEdgeWithKey(e, a, b, { e, size: 0.6 });
      }
      await yieldToMain();
    }
    if (this.gone()) return false;
    this.graph = g;
    this.recompute();
    const container = this.o.container;
    let sigma: Sigma;
    try {
      sigma = new Sigma(g, container, {
        allowInvalidContainer: false,
        renderEdgeLabels: false,
        hideEdgesOnMove: true,
        hideLabelsOnMove: true,
        labelDensity: 0.6,
        labelGridCellSize: 90,
        labelRenderedSizeThreshold: 4,
        enableEdgeEvents: false,
        zIndex: true,
        defaultEdgeType: "line",
        minCameraRatio: 0.002,
        maxCameraRatio: 20,
        nodeReducer: (_k, d) => this.nodeAttrs(d),
        edgeReducer: (_k, d) => this.edgeAttrs(d),
      });
    } catch (e) {
      this.o.onFatal(e instanceof Error ? `WebGL is not available: ${e.message}` : "WebGL is not available.");
      return false;
    }
    this.sigma = sigma;
    container.appendChild(this.ring);
    container.appendChild(this.tip);
    if (this.o.camera) sigma.getCamera().setState({ x: this.o.camera.x, y: this.o.camera.y, ratio: this.o.camera.ratio });
    sigma.on("clickNode", ({ node }) => this.o.onSelect(Number(node)));
    sigma.on("clickStage", () => this.o.onSelect(-1));
    sigma.on("enterNode", ({ node }) => this.showTip(Number(node)));
    sigma.on("leaveNode", () => { this.tip.hidden = true; });
    sigma.on("afterRender", () => this.placeRing());
    sigma.getCamera().on("updated", () => this.onCameraUpdated());
    const canvas = container.querySelector("canvas");
    canvas?.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      this.o.onFatal("The graphics context was lost. Reopen the graph to draw it again.");
    });
    return true;
  }

  private gone(): boolean {
    return this.disposed || (this.o.shouldAbort?.() ?? false);
  }

  private recompute(): void {
    const { model, layout } = this.o;
    this.visible = visibleNodes(model, layout, this.filters, this.plan, this.selected, this.adj);
    this.neighbour = new Uint8Array(model.n);
    if (this.selected >= 0) {
      for (let k = this.adj.start[this.selected]; k < this.adj.start[this.selected + 1]; k++) this.neighbour[this.adj.nbr[k]] = 1;
    }
  }

  private nodeAttrs(d: Record<string, unknown>): Record<string, unknown> {
    const i = d.i as number;
    const { model, layout } = this.o;
    if (this.visible[i] === 0) return { ...d, hidden: true };
    const sel = this.selected;
    const isNb = this.neighbour[i] === 1;
    let color = communityColor(layout.community[i]);
    let zIndex = 0;
    let size = d.size as number;
    if (sel >= 0) {
      if (i === sel) { color = SELECT_COLOR; zIndex = 3; size *= 1.6; }
      else if (isNb) { color = NEIGHBOUR_COLOR; zIndex = 2; }
      else color = DIM_COLOR;
    }
    return { ...d, color, size, zIndex, label: labelShown(i, layout, this.plan, sel, isNb) ? model.titles[i] : null };
  }

  private edgeAttrs(d: Record<string, unknown>): Record<string, unknown> {
    const e = d.e as number;
    const { model } = this.o;
    if (!edgeShown(e, model, this.weights, this.visible, this.filters.minWeight, this.plan, this.selected)) return { ...d, hidden: true };
    const w = this.weights[e];
    const touches = this.selected >= 0 && (model.from[e] === this.selected || model.to[e] === this.selected);
    const bucket = w >= 0.85 ? 3 : w >= 0.6 ? 2 : w >= 0.35 ? 1 : 0;
    return { ...d, color: touches ? SELECT_COLOR : EDGE_COLORS[this.selected >= 0 ? 0 : bucket], size: touches ? 1.6 : 0.4 + w * 0.8, zIndex: touches ? 1 : 0 };
  }

  private onCameraUpdated(): void {
    const sigma = this.sigma;
    if (!sigma) return;
    const st = sigma.getCamera().getState();
    this.o.onCamera({ x: st.x, y: st.y, ratio: st.ratio });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = planLod(this.o.model.n, this.o.model.m, st.ratio, this.hist);
      if (next.key === this.plan.key) return;
      this.plan = next;
      this.apply();
    }, 160);
  }

  private apply(): void {
    if (this.disposed || !this.sigma) return;
    this.recompute();
    this.sigma.refresh({ skipIndexation: true });
  }

  /** Filters or selection changed. */
  update(filters: FilterState, selected: number): void {
    this.filters = filters;
    this.selected = selected;
    this.apply();
  }

  /** Centre the camera on a node (animated) without changing zoom much. */
  focus(i: number): void {
    const sigma = this.sigma;
    const g = this.graph;
    if (!sigma || !g || !g.hasNode(i)) return;
    const pos = sigma.getNodeDisplayData(String(i));
    if (!pos) return;
    const cam = sigma.getCamera();
    void cam.animate({ x: pos.x, y: pos.y, ratio: Math.min(cam.getState().ratio, 0.35) }, { duration: 300 });
  }

  zoomIn(): void { void this.sigma?.getCamera().animatedZoom({ duration: 200 }); }
  zoomOut(): void { void this.sigma?.getCamera().animatedUnzoom({ duration: 200 }); }
  reset(): void { void this.sigma?.getCamera().animatedReset({ duration: 250 }); }
  pan(dx: number, dy: number): void {
    const cam = this.sigma?.getCamera();
    if (!cam) return;
    const s = cam.getState();
    cam.setState({ x: s.x + dx * s.ratio, y: s.y + dy * s.ratio });
  }

  private showTip(i: number): void {
    const sigma = this.sigma;
    if (!sigma) return;
    const d = sigma.getNodeDisplayData(String(i));
    if (!d) return;
    const p = sigma.graphToViewport({ x: d.x, y: d.y });
    this.tip.textContent = this.o.model.titles[i]; // text only
    this.tip.style.left = `${Math.round(p.x + 10)}px`;
    this.tip.style.top = `${Math.round(p.y + 10)}px`;
    this.tip.hidden = false;
  }

  private placeRing(): void {
    const sigma = this.sigma;
    if (!sigma || this.selected < 0) { this.ring.hidden = true; return; }
    const d = sigma.getNodeDisplayData(String(this.selected));
    if (!d || d.hidden) { this.ring.hidden = true; return; }
    const p = sigma.graphToViewport({ x: d.x, y: d.y });
    const r = Math.max(10, d.size * 1.6 + 6);
    this.ring.style.width = this.ring.style.height = `${Math.round(r * 2)}px`;
    this.ring.style.transform = `translate(${Math.round(p.x - r)}px, ${Math.round(p.y - r)}px)`;
    this.ring.hidden = false;
  }

  /** Releases the GPU context, listeners and the graphology graph. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    const container = this.o.container;
    try {
      for (const c of Array.from(container.querySelectorAll("canvas"))) {
        const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
      }
    } catch {
      // a context that cannot be queried is already gone
    }
    this.sigma?.kill();
    this.sigma = null;
    this.graph?.clear();
    this.graph = null;
    this.ring.remove();
    this.tip.remove();
  }
}
