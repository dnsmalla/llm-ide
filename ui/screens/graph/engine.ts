// Main-thread side of the layout worker: one job at a time, cache by graph hash, cancel by terminating the
// worker, a watchdog so a hung worker cannot leave the screen "loading" forever.
import { LayoutCache, sha256Hex, type CacheEntry } from "./cache.ts";
import type { GraphModel, LayoutResult } from "./model.ts";
import { isFromWorker, type JobStage, type WorkerLike } from "./protocol.ts";

export interface EngineDeps {
  createWorker: () => WorkerLike;
  wasmUrl: string;
  cache?: LayoutCache;
  hash?: (text: string) => Promise<string>;
  /** Hard stop for one job; the 50k-node layout takes seconds, so this is generous. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface Preview {
  model: GraphModel;
  layout: LayoutResult;
  notices: string[];
}

export type JobOutcome =
  | { kind: "done"; entry: CacheEntry; cached: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export class LayoutEngine {
  private worker: WorkerLike | null = null;
  private job = 0;
  private settle: ((o: JobOutcome) => void) | null = null;
  private timer: unknown = null;
  readonly cache: LayoutCache;
  private readonly deps: EngineDeps;
  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.cache = deps.cache ?? new LayoutCache();
  }

  /** Starts a load. A job already running is cancelled first. Progress is reported per stage. */
  async load(text: string, onProgress?: (stage: JobStage | "hash") => void, onPreview?: (p: Preview) => void): Promise<JobOutcome> {
    this.cancel();
    const job = ++this.job;
    onProgress?.("hash");
    const hash = await (this.deps.hash ?? sha256Hex)(text);
    if (job !== this.job) return { kind: "cancelled" };
    const key = LayoutCache.key(hash);
    const hit = this.cache.get(key);
    if (hit) return { kind: "done", entry: hit, cached: true };

    return new Promise<JobOutcome>((resolve) => {
      const worker = this.deps.createWorker();
      this.worker = worker;
      const finish = (o: JobOutcome) => {
        if (this.settle !== finish) return;
        this.settle = null;
        this.clearTimer();
        this.dispose();
        resolve(o);
      };
      this.settle = finish;
      let previewModel: GraphModel | null = null;
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (!isFromWorker(m) || m.job !== job) return;
        if (m.type === "progress") onProgress?.(m.stage);
        else if (m.type === "preview") {
          previewModel = m.model;
          onPreview?.({ model: m.model, layout: m.layout, notices: m.notices });
        } else if (m.type === "error") finish({ kind: "error", message: m.message });
        else {
          const model = m.model ?? previewModel;
          if (!model) return finish({ kind: "error", message: "The layout worker returned no graph." });
          const entry: CacheEntry = { model, layout: m.layout, notices: m.notices };
          this.cache.set(key, entry);
          finish({ kind: "done", entry, cached: false });
        }
      };
      worker.onerror = (ev) => finish({ kind: "error", message: ev.message || "The layout worker failed." });
      worker.onmessageerror = () => finish({ kind: "error", message: "The layout worker sent an unreadable message." });
      const ms = this.deps.timeoutMs ?? 180_000;
      this.timer = (this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t)))(() => finish({ kind: "error", message: "Layout took too long and was stopped." }), ms);
      try {
        worker.postMessage({ type: "run", job, text, wasmUrl: this.deps.wasmUrl });
      } catch (e) {
        finish({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** Stops a running job (terminates the worker mid-layout). Safe to call at any time. */
  cancel(): void {
    this.job++;
    const s = this.settle;
    if (s) s({ kind: "cancelled" });
    else this.dispose();
  }

  get busy(): boolean {
    return this.settle !== null;
  }

  private clearTimer(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private dispose(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  }
}
