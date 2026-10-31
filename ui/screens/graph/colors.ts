// Community colours: the Okabe-Ito colour-blind-safe set first, then evenly spaced hues. Colour is never the
// only signal: the details panel and the node list always state the community number and the node kind.
const BASE = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#7a7a7a"];

export function communityColor(c: number): string {
  if (c < BASE.length) return BASE[c];
  const hue = Math.round(((c - BASE.length) * 137.508) % 360);
  return `hsl(${hue} 55% 52%)`;
}

export const SELECT_COLOR = "#ff3b6b";
export const NEIGHBOUR_COLOR = "#ffb020";
export const DIM_COLOR = "#8a8f9855";
export const EDGE_COLORS = ["#8a8f9833", "#8a8f9855", "#8a8f9888", "#6c727e"] as const;
