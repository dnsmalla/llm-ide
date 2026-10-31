// Edge weights: a mirror of graph-kit's `EdgeWeight` (Swift) and the Rust kernel's `base_weight`.
// Edges are WEIGHTED, never pruned: the renderer filters behind a slider, the kernel ignores edges under 0.30.
// `tests/weights.test.ts` checks this table against the schema's edge-kind enum and, when the graph-kit
// checkout is present, against EdgeWeight.swift, so a drift in either place fails a test.

export const EDGE_BASE_WEIGHT: Readonly<Record<string, number>> = {
  contains: 1.0,
  inherits: 0.95,
  implements: 0.95,
  defines: 0.92,
  definesSchema: 0.9,
  imports: 0.9,
  exports: 0.85,
  dependsOn: 0.85,
  calls: 0.8,
  containsFlow: 0.8,
  flowStep: 0.78,
  middleware: 0.72,
  publishes: 0.7,
  subscribes: 0.7,
  readsFrom: 0.7,
  writesTo: 0.7,
  routes: 0.7,
  testedBy: 0.68,
  configures: 0.68,
  migrates: 0.68,
  deploys: 0.65,
  serves: 0.65,
  provisions: 0.65,
  triggers: 0.65,
  transforms: 0.62,
  validates: 0.62,
  documents: 0.6,
  references: 0.58,
  cites: 0.58,
  buildsOn: 0.55,
  contradicts: 0.52,
  exemplifies: 0.5,
  categorizedUnder: 0.48,
  authoredBy: 0.42,
  crossDomain: 0.4,
  relatedTo: 0.24,
  similarTo: 0.2,
};

export const EDGE_KINDS: readonly string[] = Object.freeze(Object.keys(EDGE_BASE_WEIGHT));

/** The kernel's layout floor (rust `MIN_WEIGHT`, Swift `minWeight`): weaker edges are drawn but do not pull. */
export const LAYOUT_MIN_WEIGHT = 0.3;

export type Confidence = 0 | 1 | 2; // 0 EXTRACTED, 1 INFERRED, 2 AMBIGUOUS

export const CONFIDENCE_NAMES = ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const;

export function confidenceMultiplier(c: number): number {
  return c === 0 ? 1.0 : c === 1 ? 0.75 : 0.45;
}

export function edgeWeight(kind: string, confidence: number): number {
  return (EDGE_BASE_WEIGHT[kind] ?? EDGE_BASE_WEIGHT.relatedTo) * confidenceMultiplier(confidence);
}

export function parseConfidence(v: unknown): Confidence {
  if (v === "EXTRACTED") return 0;
  if (v === "AMBIGUOUS") return 2;
  return v === "INFERRED" ? 1 : 0;
}
