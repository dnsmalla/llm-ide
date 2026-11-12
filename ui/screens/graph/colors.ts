// Community colours: the Mac's 15 fixed cluster hues (CGPalette.clusterColors), cycled by cluster id.
// Colour is never the only signal: the details panel and node list always state the community number.
const CLUSTER_COLORS = [
  "#4f7aa6", // steel blue
  "#f28f2b", // amber
  "#59a14f", // moss
  "#e05759", // brick
  "#b07aa1", // mauve
  "#75b8b3", // teal
  "#edc947", // gold
  "#ff9ea6", // rose
  "#9c755f", // taupe
  "#8c8c94", // slate
  "#2e87ab", // ocean
  "#8273b3", // iris
  "#ccba75", // sand
  "#54a887", // jade
  "#c44f8c", // plum
] as const;

/** The community hue, cycling the Mac's 15-colour palette. */
export function communityColor(c: number): string {
  const i = Number.isInteger(c) && c >= 0 ? c : 0;
  return CLUSTER_COLORS[i % CLUSTER_COLORS.length];
}

export const SELECT_COLOR = "#ff3b6b";
export const NEIGHBOUR_COLOR = "#ffb020";
export const DIM_COLOR = "#8a8f9855";
export const EDGE_COLORS = ["#8a8f9833", "#8a8f9855", "#8a8f9888", "#6c727e"] as const;

/** Light-theme variants: on a pale canvas the dark-tuned edges vanish and bright hues wash out. */
export const LIGHT_DIM_COLOR = "#5a627088";
export const LIGHT_EDGE_COLORS = ["#4a526a30", "#4a526a55", "#4a526a88", "#3a4152"] as const;

/** Darken a `#rrggbb` hue by `k` (0..1) so community colours keep contrast on a light canvas. */
export function darken(hex: string, k = 0.22): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (v: number) => Math.round(v * (1 - k)).toString(16).padStart(2, "0");
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** Node-kind colours, the Mac's `CGPalette.color(for:)` values (SwiftUI system colours and the custom UA hues).
 *  Used for the kind legend and the kind dots; nodes themselves are coloured by community, as on the Mac canvas. */
const KIND_COLORS: Readonly<Record<string, string>> = {
  file: "#007aff", symbol: "#af52de", module: "#ff9500", docPage: "#34c759",
  memoryDoc: "#5856d6", memoryChunk: "#00c7be",
  noteDecision: "#ff3b30", noteTask: "#ff9500", noteQuestion: "#ffcc00", noteFact: "#34c759",
  noteConcept: "#32ade6", notePlaybook: "#007aff", noteHypothesis: "#af52de", noteEvent: "#ff2d55", noteSource: "#a2845e",
  function: "#3399e6", classType: "#9933cc", config: "#808080", service: "#00b380", table: "#cc801a",
  endpoint: "#e64d4d", pipeline: "#4d80e6", schemaNode: "#b3661a", resource: "#1a804d", domain: "#e6991a",
  flow: "#66cccc", step: "#99cc66", article: "#669933", entity: "#cc3399", topic: "#3366cc", claim: "#e66633",
  skill: "#59bfa6", agent: "#d973bf", other: "#8e8e93",
};

/** Colour for a node kind. Unknown kinds read as `other` (grey), as on the Mac. */
export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? KIND_COLORS.other;
}

/** Legend rows shown for a doc graph, in the Mac's order. */
export const DOC_LEGEND: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: "memoryChunk", label: "Note" },
  { kind: "memoryDoc", label: "Document" },
  { kind: "noteConcept", label: "Concept" },
  { kind: "noteDecision", label: "Decision" },
  { kind: "noteFact", label: "Fact" },
  { kind: "notePlaybook", label: "Playbook" },
  { kind: "noteQuestion", label: "Question" },
  { kind: "noteSource", label: "Source" },
  { kind: "noteTask", label: "Task" },
];
