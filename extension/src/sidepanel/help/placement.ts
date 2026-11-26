// Where a tour card goes next to its target inside the side panel: a single scrollable column, so (unlike the
// desktop's floating-place.ts) there is only one horizontal arrangement to worry about, just a below/above flip
// and a horizontal clamp to the panel's own width. Pure — no DOM — so node can test it.
export interface TargetRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
export interface CardSize {
  width: number;
  height: number;
}
export interface PlacedCard {
  top: number;
  left: number;
  side: 'below' | 'above';
}

const GAP = 8;
const MARGIN = 8;

export function placeCard(target: TargetRect, card: CardSize, panelWidth: number, panelHeight: number): PlacedCard {
  const below = panelHeight - target.bottom - GAP - MARGIN;
  const above = target.top - GAP - MARGIN;
  const side: 'below' | 'above' = card.height <= below || below >= above ? 'below' : 'above';
  const wanted = side === 'below' ? target.bottom + GAP : target.top - GAP - card.height;
  // Reachable Skip/Finish beats not overlapping the target, so clamp even when that covers it.
  const top = Math.max(MARGIN, Math.min(wanted, panelHeight - MARGIN - card.height));
  const left = Math.max(MARGIN, Math.min(target.left, panelWidth - MARGIN - card.width));
  return { top, left, side };
}
