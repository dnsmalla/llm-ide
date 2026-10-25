import type Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import { mulberry32 } from "./prng";

/** Deterministic starting positions: uniform in a box, seeded. */
export function seedPositions(graph: Graph, seed: number): void {
  const rnd = mulberry32(seed);
  graph.updateEachNodeAttributes((_node, attr) => ({
    ...attr,
    x: (rnd() * 2 - 1) * 100,
    y: (rnd() * 2 - 1) * 100,
  }));
}

export interface LayoutRun {
  /** Wall-clock ms from worker start until the target iterations (or timeout) were reached. */
  ms: number;
  /** ForceAtlas2 iterations completed. */
  iterations: number;
  /** True when the safety timeout stopped the run before the target was reached. */
  timedOut: boolean;
}

/**
 * ForceAtlas2 in a Web Worker (graphology-layout-forceatlas2/worker), run for a
 * fixed number of iterations, then stopped. A hard timeout stops it earlier and
 * reports `timedOut`. Iterations are counted through the supervisor's
 * outputReducer, which runs once per node per iteration; the first node's calls
 * mark one iteration. The stop is requested inside the reducer, and the worker is
 * killed on the next tick, after the supervisor has finished the current message.
 */
export function runLayout(graph: Graph, targetIterations: number, timeoutMs: number): Promise<LayoutRun> {
  return new Promise<LayoutRun>((resolve, reject) => {
    const started = performance.now();
    let firstKey: string | null = null;
    let count = 0;
    let finished = false;
    let sup: FA2Layout | null = null;

    const finish = (timedOut: boolean) => {
      if (finished || !sup) return;
      finished = true;
      clearTimeout(timer);
      const ms = performance.now() - started;
      sup.stop();
      const done = sup;
      setTimeout(() => {
        done.kill();
        resolve({ ms, iterations: count, timedOut });
      }, 0);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);

    try {
      sup = new FA2Layout(graph, {
        settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true },
        outputReducer: (key: string, attr: Record<string, unknown>) => {
          if (firstKey === null) firstKey = key;
          if (key === firstKey && !finished) {
            count++;
            if (count >= targetIterations) finish(false);
          }
          return attr;
        },
      });
      const w = (sup as unknown as { worker: Worker }).worker;
      w.addEventListener("error", (ev) => console.error("fa2 worker error", ev.message));
      sup.start();
    } catch (e) {
      clearTimeout(timer);
      finished = true;
      sup?.kill();
      reject(e);
    }
  });
}

/**
 * Measurement-only: worker FA2 WITHOUT outputReducer, timed over `iterations`
 * worker messages (each message is one iteration). Used to separate reducer
 * overhead from worker compute. Layout approach is unchanged.
 */
export function timeWorkerNoReducer(graph: Graph, iterations: number): Promise<{ ms: number; iterations: number }> {
  return new Promise((resolve, reject) => {
    let sup: FA2Layout | null = null;
    let count = 0;
    let started = 0;
    let finished = false;
    try {
      sup = new FA2Layout(graph, {
        settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true },
      });
      const w = (sup as unknown as { worker: Worker }).worker;
      // Listener added after the supervisor's own message handler, so positions
      // are already applied when this counts the message.
      w.addEventListener("message", () => {
        if (finished) return;
        count++;
        if (count === 1) started = performance.now();
        if (count >= iterations) {
          finished = true;
          const ms = performance.now() - started;
          sup?.stop();
          const done = sup;
          setTimeout(() => {
            done?.kill();
            resolve({ ms, iterations: count });
          }, 0);
        }
      });
      started = performance.now();
      sup.start();
    } catch (e) {
      finished = true;
      sup?.kill();
      reject(e);
    }
  });
}

/** Measurement-only: main-thread forceAtlas2.assign for `iterations` iterations. */
export function timeMainThread(graph: Graph, iterations: number): number {
  const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true };
  const t0 = performance.now();
  forceAtlas2.assign(graph, { iterations, settings });
  return performance.now() - t0;
}
