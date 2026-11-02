// Community colours: the Okabe-Ito colour-blind-safe set first, then evenly spaced hues. Colour is never the
// only signal: the details panel and the node list always state the community number and the node kind.
const BASE = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#7a7a7a"];

function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function communityColor(c: number): string {
  if (c < BASE.length) return BASE[c];
  const hue = Math.round(((c - BASE.length) * 137.508) % 360);
  return hslHex(hue, 55, 52);
}

export const SELECT_COLOR = "#ff3b6b";
export const NEIGHBOUR_COLOR = "#ffb020";
export const DIM_COLOR = "#8a8f9855";
export const EDGE_COLORS = ["#8a8f9833", "#8a8f9855", "#8a8f9888", "#6c727e"] as const;

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
