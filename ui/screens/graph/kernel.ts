// Driver for graph-kit's Rust `graph-layout` kernel (vendored as wasm/graph-layout.wasm): the C ABI of
// mac/LocalPackages/graph-kit/rust/graph-layout/README.md, typed arrays in and out, no imports needed.
//   input  (little endian): u32 n | u32 m | u8 kindCount | kindCount x (u8 len, utf8 name) | m x (u32 from, u32 to, u8 kind, u8 conf)
//   output: u32 n | u32 linkCount | u32 communityCount | n x (f64 x, f64 y, f64 radius, u32 community, u32 degree, u32 inDegree) | linkCount x f64
import type { GraphModel, LayoutResult } from "./model.ts";

export const KERNEL_HEADER_BYTES = 9;

/** The kernel's input bytes for a model. Edge kinds are already restricted to known names by the decoder. */
export function encodeKernelInput(model: GraphModel): Uint8Array {
  const enc = new TextEncoder();
  const names = model.edgeKinds.map((k) => enc.encode(k));
  if (names.length > 255) throw new Error("too many edge kinds");
  let head = KERNEL_HEADER_BYTES;
  for (const nm of names) head += 1 + nm.length;
  const out = new Uint8Array(head + model.m * 10);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, model.n, true);
  dv.setUint32(4, model.m, true);
  out[8] = names.length;
  let at = KERNEL_HEADER_BYTES;
  for (const nm of names) {
    out[at++] = nm.length;
    out.set(nm, at);
    at += nm.length;
  }
  for (let e = 0; e < model.m; e++) {
    dv.setUint32(at, model.from[e], true);
    dv.setUint32(at + 4, model.to[e], true);
    out[at + 8] = model.edgeKind[e];
    out[at + 9] = model.conf[e];
    at += 10;
  }
  return out;
}

export interface KernelOutput {
  n: number;
  linkCount: number;
  communityCount: number;
  pos: Float32Array;
  radius: Float32Array;
  community: Uint32Array;
  degree: Uint32Array;
  inDegree: Uint32Array;
  nonFinite: number;
}

/** Validates the length exactly, copies into typed arrays, replaces non-finite coordinates by 0 (counted). */
export function decodeKernelOutput(bytes: Uint8Array, expectN: number): KernelOutput {
  if (bytes.length < 12) throw new Error("layout output is truncated");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const linkCount = dv.getUint32(4, true);
  const communityCount = dv.getUint32(8, true);
  if (n !== expectN) throw new Error(`layout returned ${n} nodes, expected ${expectN}`);
  if (bytes.length !== 12 + n * 36 + linkCount * 8) throw new Error("layout output has the wrong length");
  const pos = new Float32Array(n * 2);
  const radius = new Float32Array(n);
  const community = new Uint32Array(n);
  const degree = new Uint32Array(n);
  const inDegree = new Uint32Array(n);
  let nonFinite = 0;
  let at = 12;
  for (let i = 0; i < n; i++) {
    let x = dv.getFloat64(at, true);
    let y = dv.getFloat64(at + 8, true);
    let r = dv.getFloat64(at + 16, true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0; y = 0; nonFinite++; }
    if (!Number.isFinite(r) || r < 0) r = 1;
    pos[2 * i] = x;
    pos[2 * i + 1] = y;
    radius[i] = r;
    community[i] = dv.getUint32(at + 24, true);
    degree[i] = dv.getUint32(at + 28, true);
    inDegree[i] = dv.getUint32(at + 32, true);
    at += 36;
  }
  return { n, linkCount, communityCount, pos, radius, community, degree, inDegree, nonFinite };
}

interface KernelExports {
  memory: WebAssembly.Memory;
  gl_alloc(len: number): number;
  gl_free(ptr: number, len: number): void;
  gl_layout(ptr: number, len: number): number;
  gl_out_ptr(): number;
  gl_out_len(): number;
}

/** A compiled kernel instance. A trap (a kernel bug) poisons the instance: create a new one. */
export class WasmKernel {
  private readonly x: KernelExports;
  private constructor(x: KernelExports) {
    this.x = x;
  }

  static async create(wasmBytes: BufferSource): Promise<WasmKernel> {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const x = instance.exports as unknown as KernelExports;
    for (const name of ["memory", "gl_alloc", "gl_free", "gl_layout", "gl_out_ptr", "gl_out_len"]) {
      if (!(name in x)) throw new Error(`graph-layout.wasm lacks export ${name}`);
    }
    return new WasmKernel(x);
  }

  run(input: Uint8Array): Uint8Array {
    const x = this.x;
    const ptr = x.gl_alloc(input.length);
    new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
    const rc = x.gl_layout(ptr, input.length);
    x.gl_free(ptr, input.length);
    if (rc !== 0) throw new Error("layout input rejected by the kernel");
    // Copy out: the view is invalidated by the next call and by memory growth.
    return new Uint8Array(x.memory.buffer, x.gl_out_ptr(), x.gl_out_len()).slice();
  }
}

/**
 * rank[i]: 0 for the most important node (largest kernel radius, then degree), 1 for the least.
 * communityRank[i]: the same inside the node's community. Used by level of detail (labels, node reduction).
 */
export function computeRanks(radius: Float32Array, degree: Uint32Array, community: Uint32Array): { rank: Float32Array; communityRank: Float32Array } {
  const n = radius.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => radius[b] - radius[a] || degree[b] - degree[a] || a - b);
  const rank = new Float32Array(n);
  const communityRank = new Float32Array(n);
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) sizes.set(community[i], (sizes.get(community[i]) ?? 0) + 1);
  const seen = new Map<number, number>();
  const denom = Math.max(1, n - 1);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    rank[i] = k / denom;
    const c = community[i];
    const j = seen.get(c) ?? 0;
    seen.set(c, j + 1);
    const size = sizes.get(c) ?? 1;
    communityRank[i] = size > 1 ? j / (size - 1) : 0;
  }
  return { rank, communityRank };
}

export function toLayoutResult(out: KernelOutput, engine: LayoutResult["engine"], ms: number): LayoutResult {
  const { rank, communityRank } = computeRanks(out.radius, out.degree, out.community);
  return {
    n: out.n,
    pos: out.pos,
    radius: out.radius,
    community: out.community,
    degree: out.degree,
    inDegree: out.inDegree,
    communityCount: out.communityCount,
    rank,
    communityRank,
    engine,
    ms,
  };
}
