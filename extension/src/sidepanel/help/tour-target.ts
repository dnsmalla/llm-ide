// Which element a tour step spotlights. Pure (no DOM types needed) so node can test it.

/** Locked: the step already found its element, so it never switches to another match (it may only go away).
 * Searching: take the first live candidate (a hidden panel can hold a zero-size earlier match). */
export function pickTarget<T>(locked: T | null, candidates: readonly T[], isLive: (el: T) => boolean): T | null {
  if (locked) return isLive(locked) ? locked : null;
  return candidates.find(isLive) ?? null;
}
