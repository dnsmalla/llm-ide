// Where a popup goes next to its button: the pure half of Floating.tsx (no React, no DOM), so node can test it.
export type Placement = "below-start" | "below-end" | "above-start" | "above-end";
export interface Rect { top: number; left: number; right: number; bottom: number }
export interface Placed { top: number; left: number; maxHeight: number; side: "below" | "above" }

const GAP = 6;
const MARGIN = 8;

/**
 * Where a popup of `size` goes next to `anchor` inside a `vw`×`vh` window. It keeps the preferred side when the popup
 * fits there, else takes the side with more room; it is aligned to the anchor's start or end edge and slid back inside
 * the window; it never gets taller than the room on its side. Pure.
 */
export function placeFloating(anchor: Rect, size: { width: number; height: number }, vw: number, vh: number, placement: Placement = "below-start"): Placed {
  const below = vh - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const wantBelow = placement.startsWith("below");
  const side: "below" | "above" = (wantBelow ? size.height <= below || below >= above : !(size.height <= above || above >= below)) ? "below" : "above";
  const room = Math.max(80, side === "below" ? below : above);
  const height = Math.min(size.height, room);
  const top = side === "below" ? anchor.bottom + GAP : anchor.top - GAP - height;
  const startLeft = placement.endsWith("end") ? anchor.right - size.width : anchor.left;
  const left = Math.max(MARGIN, Math.min(startLeft, vw - MARGIN - size.width));
  return { top: Math.max(MARGIN, top), left, maxHeight: room, side };
}
