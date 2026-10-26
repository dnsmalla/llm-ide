import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sigma from "sigma";
import type Graph from "graphology";
import {
  buildSource,
  LAYOUT_ITERATIONS,
  LAYOUT_TIMEOUT_MS,
  SOURCE_LABELS,
  SOURCE_SUFFIX,
  type SourceId,
} from "../graph/sources";
import {
  runLayout,
  timeMainThread,
  timeWorkerNoReducer,
  type LayoutRun,
} from "../graph/layout";
import { measureCameraFps } from "../graph/fps";
import { emitBench } from "../bench/records";
import { claimStep, finishStep, isStepCancelled } from "../bench/runner";

/** Emits one measurement as a `BENCH <json>` stdout line (also kept for the Bench table). */
const emit = emitBench;

/** Lays out and renders one source into `container`. Caller owns the returned renderer. */
async function renderSource(
  id: SourceId,
  container: HTMLElement,
): Promise<{ graph: Graph; sigma: Sigma; nodes: number; edges: number; layout: LayoutRun }> {
  const graph = await buildSource(id);
  const layout = await runLayout(graph, LAYOUT_ITERATIONS[id], LAYOUT_TIMEOUT_MS);
  // WebGL only: sigma throws if no WebGL context can be created.
  const sigma = new Sigma(graph, container, {
    renderLabels: false,
    renderEdgeLabels: false,
    hideEdgesOnMove: false,
    defaultNodeColor: "#4f7cff",
    defaultEdgeColor: "#8a94a6",
    defaultEdgeType: "line",
    enableEdgeEvents: false,
    zIndex: false,
  });
  sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  return { graph, sigma, nodes: graph.order, edges: graph.size, layout };
}

/**
 * Measurement-only slowdown probes on the 10k graph (layout approach unchanged):
 * worker FA2 without outputReducer, and main-thread forceAtlas2.assign.
 */
async function runSlowdownProbes(log: (s: string) => void) {
  log("probe: worker without outputReducer, 20 iterations");
  const g1 = await buildSource("synthetic-10k");
  const w = await timeWorkerNoReducer(g1, 20);
  await emit({
    name: "graph_fa2_worker_no_reducer_ms_per_iter_10k",
    value: Math.round((w.ms / w.iterations) * 10) / 10,
    unit: "ms",
    iterations: w.iterations,
  });
  log("probe: main-thread assign, 5 iterations");
  const g2 = await buildSource("synthetic-10k");
  const mainMs = timeMainThread(g2, 5);
  await emit({
    name: "graph_fa2_main_ms_per_iter_10k",
    value: Math.round((mainMs / 5) * 10) / 10,
    unit: "ms",
    iterations: 5,
  });
}

/**
 * Runs the benchmarks in order, printing BENCH lines. `bench_done` is called in
 * a finally so the app always exits, even when a scenario fails.
 */
async function runAutobench(log: (s: string) => void) {
  const plan: SourceId[] = ["synthetic-10k", "synthetic-50k", "real"];
  // Fixed-size stage on document.body: the benches must not depend on the tab's
  // React mount or the shell layout, which were unreliable during the run.
  const stage = document.createElement("div");
  Object.assign(stage.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1000px",
    height: "640px",
    zIndex: "9999",
    background: "#fff",
  });
  document.body.appendChild(stage);
  try {
    for (const id of plan) {
      if (isStepCancelled("graph")) break;
      const suffix = SOURCE_SUFFIX[id];
      try {
        log(`bench ${id}: layout…`);
        const r = await renderSource(id, stage);
        const perIter = r.layout.iterations > 0 ? r.layout.ms / r.layout.iterations : 0;
        await emit({
          name: `graph_layout_ms_${suffix}`,
          value: Math.round(r.layout.ms),
          unit: "ms",
          iterations: r.layout.iterations,
          target_iterations: LAYOUT_ITERATIONS[id],
          timed_out: String(r.layout.timedOut),
          nodes: r.nodes,
          edges: r.edges,
        });
        await emit({
          name: `graph_layout_ms_per_iter_${suffix}`,
          value: Math.round(perIter * 10) / 10,
          unit: "ms",
          iterations: r.layout.iterations,
        });
        if (id === "real") {
          await emit({ name: "graph_real_nodes", value: r.nodes, unit: "count" });
          await emit({ name: "graph_real_edges", value: r.edges, unit: "count" });
        }
        log(`bench ${id}: camera 5 s…`);
        const fps = await measureCameraFps(r.sigma);
        await emit({
          name: `graph_fps_${suffix}`,
          value: Math.round(fps.fpsRender * 10) / 10,
          unit: "fps",
          fps_render: Math.round(fps.fpsRender * 10) / 10,
          fps_raf: Math.round(fps.fpsRaf * 10) / 10,
          frames_render: fps.framesRender,
          frames_raf: fps.framesRaf,
          elapsed_ms: Math.round(fps.elapsedMs),
          nodes: r.nodes,
          edges: r.edges,
        });
        r.sigma.kill();
        stage.replaceChildren();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`bench ${id} failed: ${message}`);
        await emit({ name: `graph_error_${suffix}`, value: 0, unit: "error", message });
        stage.replaceChildren();
      }
    }
    try {
      if (!isStepCancelled("graph")) await runSlowdownProbes(log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`probes failed: ${message}`);
      await emit({ name: "graph_error_probes", value: 0, unit: "error", message });
    }
  } finally {
    stage.remove();
    log("autobench finished");
  }
}

export function GraphView() {
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const [source, setSource] = useState<SourceId>("synthetic-10k");
  const [status, setStatus] = useState("idle");
  const [busy, setBusy] = useState(false);
  const [fpsText, setFpsText] = useState<string | null>(null);

  // Tear the renderer down on unmount.
  useEffect(() => {
    return () => {
      sigmaRef.current?.kill();
      sigmaRef.current = null;
    };
  }, []);

  // LLMIDE_POC_AUTOBENCH=graph: run the benches on load, then exit cleanly.
  // Module-level guard: StrictMode mounts effects twice in development.
  // Outside the claim: a normal launch (no autobench, no run) returns here and never reaches
  // finishStep, which exits the app in single-mode autobench.
  useEffect(() => {
    void (async () => {
      const mode = await invoke<string | null>("autobench_mode").catch(() => null);
      const start = claimStep("graph", mode);
      if (!start) return;
      let error: string | undefined;
      try {
        setStatus("autobench running");
        window.addEventListener("error", (ev) => void emit({ name: "graph_webview_error", value: 0, unit: "error", message: String(ev.message) }));
        window.addEventListener("unhandledrejection", (ev) => void emit({ name: "graph_webview_error", value: 0, unit: "error", message: String(ev.reason) }));
        await runAutobench((s) => {
          setStatus(s);
          void emit({ name: "graph_progress", value: 0, unit: "log", message: s });
        });
        setStatus("autobench done");
      } catch (e: unknown) {
        error = String(e);
        setStatus(`autobench error: ${error}`);
      } finally {
        await finishStep(start, "graph", error);
      }
    })();
  }, []);

  async function load(id: SourceId) {
    if (!container.current) return;
    setBusy(true);
    setFpsText(null);
    sigmaRef.current?.kill();
    sigmaRef.current = null;
    container.current.replaceChildren();
    try {
      setStatus(`building ${SOURCE_LABELS[id]}…`);
      const r = await renderSource(id, container.current);
      sigmaRef.current = r.sigma;
      setStatus(
        `${r.nodes} nodes, ${r.edges} edges; layout ${Math.round(r.layout.ms)} ms (${r.layout.iterations} iterations${r.layout.timedOut ? ", timed out" : ""})`,
      );
    } catch (e) {
      setStatus(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function measure() {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    setBusy(true);
    try {
      const fps = await measureCameraFps(sigma);
      setFpsText(
        `render ${fps.fpsRender.toFixed(1)} fps, raf ${fps.fpsRaf.toFixed(1)} fps (${Math.round(fps.elapsedMs)} ms)`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="graph-view" style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <div className="graph-controls">
        <select
          value={source}
          disabled={busy}
          onChange={(e) => setSource(e.target.value as SourceId)}
        >
          {(Object.keys(SOURCE_LABELS) as SourceId[]).map((id) => (
            <option key={id} value={id}>
              {SOURCE_LABELS[id]}
            </option>
          ))}
        </select>
        <button disabled={busy} onClick={() => void load(source)}>
          Load
        </button>
        <button disabled={busy || !sigmaRef.current} onClick={() => void measure()}>
          Measure camera FPS (5 s)
        </button>
        <span className="graph-status">{status}</span>
        {fpsText && <span className="graph-status">{fpsText}</span>}
      </div>
      <div ref={container} className="graph-canvas" style={{ flex: 1, minHeight: 300, width: "100%", position: "relative" }} />
    </section>
  );
}
