// One graph load, end to end, with no DOM and no worker globals: decode, encode, run the kernel (or the
// fallback), rank. The worker calls this; tests call it directly with the vendored wasm bytes.
import { decodeGraph } from "./decode.ts";
import { decodeKernelOutput, encodeKernelInput, toLayoutResult, WasmKernel } from "./kernel.ts";
import { fallbackLayout } from "./fallback-layout.ts";
import type { GraphModel, LayoutResult } from "./model.ts";
import type { JobStage } from "./protocol.ts";

export interface JobDeps {
  /** Loads the wasm bytes; may throw (blocked, missing). Called once per job. */
  loadWasm: () => Promise<BufferSource>;
  progress?: (stage: JobStage) => void;
  /** Called with the fast fallback layout of a big graph before the kernel runs (first frame sooner). */
  onPreview?: (model: GraphModel, layout: LayoutResult, notices: string[]) => void;
  now?: () => number;
}

/** Graphs at least this big get a preview: the kernel needs seconds there, the fallback well under one. */
export const PREVIEW_MIN_NODES = 5000;

export interface JobResult {
  model: GraphModel;
  layout: LayoutResult;
  notices: string[];
}

export async function runJob(text: string, deps: JobDeps): Promise<JobResult> {
  const now = deps.now ?? (() => performance.now());
  deps.progress?.("decode");
  const model = decodeGraph(text);
  const notices = [...model.notices];
  deps.progress?.("layout");
  const t0 = now();
  if (model.n === 0) {
    const empty = { n: 0, linkCount: 0, communityCount: 0, pos: new Float32Array(0), radius: new Float32Array(0), community: new Uint32Array(0), degree: new Uint32Array(0), inDegree: new Uint32Array(0), nonFinite: 0 };
    return { model, layout: toLayoutResult(empty, "wasm", 0), notices };
  }
  let out;
  let engine: LayoutResult["engine"] = "wasm";
  try {
    const input = encodeKernelInput(model);
    if (deps.onPreview && model.n >= PREVIEW_MIN_NODES) {
      const tp = now();
      deps.onPreview(model, toLayoutResult(fallbackLayout(model), "fallback", now() - tp), [...notices]);
    }
    const kernel = await WasmKernel.create(await deps.loadWasm());
    out = decodeKernelOutput(kernel.run(input), model.n);
  } catch (e) {
    engine = "fallback";
    notices.push(`The layout engine could not run (${e instanceof Error ? e.message : String(e)}); a simpler fallback layout is shown.`);
    out = fallbackLayout(model);
  }
  if (out.nonFinite > 0) notices.push(`${out.nonFinite} node positions were not finite and were reset to the centre.`);
  return { model, layout: toLayoutResult(out, engine, now() - t0), notices };
}
