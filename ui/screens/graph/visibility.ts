// What is drawn right now: filters AND the level-of-detail plan, with the selection always kept. Pure and
// typed-array based so the rules are testable without WebGL and cheap at 50k nodes / 250k edges.
import type { GraphModel, LayoutResult } from "./model.ts";
import { nodeMask, type Adjacency, type FilterState } from "./filters.ts";
import type { LodPlan } from "./lod.ts";

/** 1 for nodes to draw. The selected node and its neighbours are drawn whatever the plan says (filters still apply). */
export function visibleNodes(model: GraphModel, layout: LayoutResult, filters: FilterState, plan: LodPlan, selected: number, adj: Adjacency | null): Uint8Array {
  const allowed = nodeMask(model, layout, filters);
  const out = new Uint8Array(model.n);
  for (let i = 0; i < model.n; i++) {
    if (allowed[i] === 1 && (plan.nodeFraction >= 1 || layout.communityRank[i] <= plan.nodeFraction)) out[i] = 1;
  }
  if (selected >= 0 && selected < model.n && adj) {
    if (allowed[selected] === 1) out[selected] = 1;
    for (let k = adj.start[selected]; k < adj.start[selected + 1]; k++) {
      const j = adj.nbr[k];
      if (allowed[j] === 1) out[j] = 1;
    }
  }
  return out;
}

/** An edge is drawn when it is heavy enough for both the user's slider and the plan, and both ends are drawn. */
export function edgeShown(e: number, model: GraphModel, weights: Float32Array, visible: Uint8Array, minWeight: number, plan: LodPlan, selected: number): boolean {
  const a = model.from[e], b = model.to[e];
  if (visible[a] === 0 || visible[b] === 0) return false;
  const touchesSelection = selected >= 0 && (a === selected || b === selected);
  if (touchesSelection) return true; // the selection's own edges are always listed (they are the point of selecting)
  const w = weights[e];
  return w >= minWeight - 1e-6 && w >= plan.edgeFloor - 1e-6;
}

/** Should this node carry a label at this zoom? Selection and its neighbours always do. */
export function labelShown(i: number, layout: LayoutResult, plan: LodPlan, selected: number, neighbour: boolean): boolean {
  return i === selected || neighbour || layout.rank[i] <= plan.labelFraction;
}
