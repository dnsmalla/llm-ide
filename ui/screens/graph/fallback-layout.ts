// Fallback layout used only when the WASM kernel cannot be loaded (for example a webview policy that blocks
// WebAssembly). Not the product layout: deterministic and O(n + m) so it never freezes a worker on 50k nodes,
// but without the kernel's force simulation and collision passes. The screen says so when this runs.
//   1. communities by weighted label propagation (fixed visiting order, 8 rounds)
//   2. one cluster anchor per community on a golden-angle spiral, sized by sqrt(members)
//   3. members on a golden-angle spiral around the anchor, most connected first
//   4. a few smoothing passes pulling each node toward the mean of its same-community neighbours
import type { GraphModel } from "./model.ts";
import type { KernelOutput } from "./kernel.ts";
import { edgeWeight } from "./weights.ts";

const GOLDEN = 2.399963229728653;

export function fallbackLayout(model: GraphModel): KernelOutput {
  const n = model.n;
  const m = model.m;
  // CSR adjacency (undirected, weighted)
  const deg = new Uint32Array(n);
  const inDeg = new Uint32Array(n);
  const w = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    deg[model.from[e]]++;
    deg[model.to[e]]++;
    inDeg[model.to[e]]++;
    w[e] = edgeWeight(model.edgeKinds[model.edgeKind[e]], model.conf[e]);
  }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = start.slice(0, n);
  const adj = new Uint32Array(start[n]);
  const adjW = new Float32Array(start[n]);
  for (let e = 0; e < m; e++) {
    const a = model.from[e], b = model.to[e];
    adj[fill[a]] = b; adjW[fill[a]++] = w[e];
    adj[fill[b]] = a; adjW[fill[b]++] = w[e];
  }

  // 1. label propagation
  let label = new Uint32Array(n);
  for (let i = 0; i < n; i++) label[i] = i;
  const score = new Map<number, number>();
  for (let round = 0; round < 8; round++) {
    let changed = 0;
    const next = label.slice();
    for (let i = 0; i < n; i++) {
      if (start[i] === start[i + 1]) continue;
      score.clear();
      for (let k = start[i]; k < start[i + 1]; k++) score.set(label[adj[k]], (score.get(label[adj[k]]) ?? 0) + adjW[k]);
      let best = label[i], bestScore = score.get(label[i]) ?? 0;
      for (const [l, s] of score) if (s > bestScore + 1e-9 || (Math.abs(s - bestScore) <= 1e-9 && l < best)) { best = l; bestScore = s; }
      if (best !== label[i]) { next[i] = best; changed++; }
    }
    label = next;
    if (changed === 0) break;
  }
  // dense community ids ordered by first appearance
  const ids = new Map<number, number>();
  const community = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let c = ids.get(label[i]);
    if (c === undefined) { c = ids.size; ids.set(label[i], c); }
    community[i] = c;
  }
  const count = ids.size;
  const members: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < n; i++) members[community[i]].push(i);
  for (const g of members) g.sort((a, b) => deg[b] - deg[a] || a - b);

  // 2-3. anchors and member spirals
  const order = [...members.keys()].sort((a, b) => members[b].length - members[a].length || a - b);
  const spacing = 6;
  const pos = new Float32Array(n * 2);
  let at = 0;
  let ring = 0;
  for (const c of order) {
    const g = members[c];
    const rad = spacing * Math.sqrt(g.length) * 0.8 + spacing;
    const dist = ring === 0 ? 0 : spacing * 6 * Math.sqrt(ring) + rad;
    const ax = Math.cos(at * GOLDEN) * dist;
    const ay = Math.sin(at * GOLDEN) * dist;
    ring += Math.max(1, g.length / 40);
    at++;
    for (let j = 0; j < g.length; j++) {
      const r = spacing * Math.sqrt(j + 0.5) * 0.8;
      const a = j * GOLDEN;
      pos[2 * g[j]] = ax + Math.cos(a) * r;
      pos[2 * g[j] + 1] = ay + Math.sin(a) * r;
    }
  }
  // 4. smoothing
  const nx = new Float32Array(n * 2);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sw = 0;
      for (let k = start[i]; k < start[i + 1]; k++) {
        const j = adj[k];
        if (community[j] !== community[i]) continue;
        sx += pos[2 * j] * adjW[k]; sy += pos[2 * j + 1] * adjW[k]; sw += adjW[k];
      }
      nx[2 * i] = sw > 0 ? pos[2 * i] * 0.7 + (sx / sw) * 0.3 : pos[2 * i];
      nx[2 * i + 1] = sw > 0 ? pos[2 * i + 1] * 0.7 + (sy / sw) * 0.3 : pos[2 * i + 1];
    }
    pos.set(nx);
  }
  let maxDeg = 1;
  for (let i = 0; i < n; i++) if (deg[i] > maxDeg) maxDeg = deg[i];
  const radius = new Float32Array(n);
  for (let i = 0; i < n; i++) radius[i] = 4 + 14 * Math.sqrt(deg[i] / maxDeg);
  return { n, linkCount: m, communityCount: count, pos, radius, community, degree: deg, inDegree: inDeg, nonFinite: 0 };
}
