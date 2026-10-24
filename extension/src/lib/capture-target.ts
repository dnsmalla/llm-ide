// Helpers for keeping two simultaneously-open meeting tabs from mixing
// their transcripts.

/**
 * Pick the single meeting tab START_CAPTION_SCRAPING should reach.
 * Preference: the tab the side panel asked for, then the active tab of the
 * focused window. Returns null when neither is a known meeting tab (the
 * caller must NOT fall back to "all tabs" — that is the bug this fixes).
 */
export function pickStartTarget<T extends { id?: number }>(
  meetingTabs: T[],
  requestedTabId: number | undefined,
  activeTabId: number | undefined,
): T | null {
  for (const want of [requestedTabId, activeTabId]) {
    if (want === undefined) continue;
    const hit = meetingTabs.find((t) => t.id === want);
    if (hit) return hit;
  }
  return null;
}

/** Build a scraper sessionId that cannot collide across tabs/injections. */
export function makeSessionId(nonce: string, speaker: string, counter: number): string {
  return `${nonce}-${speaker}-${counter}`;
}
