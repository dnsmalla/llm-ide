// Messages between the screen and the layout worker. One job at a time; cancelling terminates the worker
// (the kernel is one blocking call, so terminate is the only way to stop it mid-layout).
import type { GraphModel, LayoutResult } from "./model.ts";

export type JobStage = "decode" | "layout";

export type ToWorker = { type: "run"; job: number; text: string; wasmUrl: string };

export type FromWorker =
  | { type: "progress"; job: number; stage: JobStage }
  /** A fast approximate layout of big graphs, sent before the kernel finishes so the first frame is not delayed by it. */
  | { type: "preview"; job: number; model: GraphModel; layout: LayoutResult; notices: string[] }
  /** `model` is absent when a preview already carried it. */
  | { type: "done"; job: number; model?: GraphModel; layout: LayoutResult; notices: string[] }
  | { type: "error"; job: number; message: string };

/** The part of the Worker API the engine uses; tests pass a fake. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: { data: FromWorker }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onmessageerror?: ((ev: unknown) => void) | null;
}

export function isFromWorker(v: unknown): v is FromWorker {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  const job = (v as { job?: unknown }).job;
  return (t === "progress" || t === "preview" || t === "done" || t === "error") && typeof job === "number";
}

/** Every ArrayBuffer in a result, for the transfer list (so the 50k-node arrays move instead of being copied). */
export function transferables(model: GraphModel | null, layout: LayoutResult): ArrayBuffer[] {
  const arrays: ArrayBufferView[] = [
    ...(model ? [model.kindOf, model.from, model.to, model.edgeKind, model.conf] : []),
    layout.pos, layout.radius, layout.community, layout.degree, layout.inDegree, layout.rank, layout.communityRank,
  ];
  const seen = new Set<ArrayBuffer>();
  for (const a of arrays) if (a.buffer instanceof ArrayBuffer) seen.add(a.buffer);
  return [...seen];
}
