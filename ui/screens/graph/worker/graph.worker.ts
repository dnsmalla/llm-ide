// Web Worker entry: runs `runJob` off the main thread and transfers the typed arrays back.
// The wasm is a bundled static asset (same origin); nothing is fetched from anywhere else.
/// <reference lib="webworker" />
import { runJob } from "../layout-job.ts";
import { transferables, type FromWorker, type ToWorker } from "../protocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (!msg || msg.type !== "run" || typeof msg.text !== "string" || typeof msg.wasmUrl !== "string") return;
  const job = msg.job;
  const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
  let previewed = false;
  try {
    const r = await runJob(msg.text, {
      progress: (stage) => post({ type: "progress", job, stage }),
      // Cloned, not transferred: the worker still needs the model for the kernel run and for its own fallback.
      onPreview: (model, layout, notices) => {
        previewed = true;
        post({ type: "preview", job, model, layout, notices });
      },
      loadWasm: async () => {
        const res = await fetch(msg.wasmUrl);
        if (!res.ok) throw new Error(`wasm fetch failed (${res.status})`);
        return res.arrayBuffer();
      },
    });
    const model = previewed ? null : r.model; // a preview already delivered the model
    post({ type: "done", job, ...(model ? { model } : {}), layout: r.layout, notices: r.notices }, transferables(model, r.layout));
  } catch (e) {
    post({ type: "error", job, message: e instanceof Error ? e.message : String(e) });
  }
};
