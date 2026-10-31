// Level of detail for big graphs. Pure decisions, no rendering: the view asks for a plan from the camera
// zoom and applies it in its node and edge reducers. Nothing is ever deleted from the model, only hidden
// at render, so zooming in brings it all back (the Mac rule: weight edges, filter at render, never prune).
//
// Sigma's camera `ratio` is 1 when the whole graph fits and shrinks as you zoom in; the visible area is
// about ratio^2 of the graph's, so a uniformly dense graph shows about n * ratio^2 nodes.
//   nodes   : at most NODE_BUDGET on screen; far out, each community keeps only its top-ranked members
//   edges   : at most EDGE_BUDGET on screen; far out, only the strongest weight buckets
//   labels  : at most LABEL_BUDGET, by global importance rank (sigma's own density culling then applies)
export const NODE_BUDGET = 15_000;
export const EDGE_BUDGET = 60_000;
export const LABEL_BUDGET = 250;
/** Weight histogram resolution: bucket b holds edges whose weight is in [b/100, (b+1)/100). */
export const WEIGHT_BUCKETS = 101;

export interface LodPlan {
  /** Show a node when its in-community rank fraction is at most this (1 = all). */
  nodeFraction: number;
  /** Hide edges lighter than this (0 = none). */
  edgeFloor: number;
  /** Label a node when its global rank fraction is at most this. */
  labelFraction: number;
  /** Coarse identity: the view re-processes only when this changes. */
  key: string;
}

export function weightHistogram(weights: ArrayLike<number>): Uint32Array {
  const h = new Uint32Array(WEIGHT_BUCKETS);
  for (let i = 0; i < weights.length; i++) h[Math.min(WEIGHT_BUCKETS - 1, Math.max(0, Math.floor(weights[i] * 100 + 1e-9)))]++;
  return h;
}

export function planLod(n: number, m: number, ratio: number, hist: Uint32Array): LodPlan {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const area = Math.min(1, r * r);
  const nodeFraction = n === 0 ? 1 : Math.min(1, NODE_BUDGET / Math.max(1, n * area));
  const labelFraction = n === 0 ? 1 : Math.min(1, LABEL_BUDGET / Math.max(1, n * area));
  let edgeFloorBucket = 0;
  if (m > 0 && m * area > EDGE_BUDGET) {
    // Smallest bucket b whose edges at-or-above b fit the budget (scaled by the visible area).
    let above = 0;
    edgeFloorBucket = WEIGHT_BUCKETS;
    for (let b = WEIGHT_BUCKETS - 1; b >= 0; b--) {
      above += hist[b];
      if (above * area > EDGE_BUDGET) break;
      edgeFloorBucket = b;
    }
  }
  const nb = nodeFraction >= 1 ? 0 : Math.floor(Math.log2(nodeFraction) * 2);
  const lb = labelFraction >= 1 ? 0 : Math.floor(Math.log2(labelFraction) * 2);
  return {
    nodeFraction: nodeFraction >= 1 ? 1 : 2 ** (nb / 2),
    edgeFloor: edgeFloorBucket / 100,
    labelFraction: labelFraction >= 1 ? 1 : 2 ** (lb / 2),
    key: `${nb}:${edgeFloorBucket}:${lb}`,
  };
}
