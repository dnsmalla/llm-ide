// "Has this install shown the Help & Support guide yet?" UI-only flag, no secrets.
const KEY = "llmide.guide.seen";

/** True only on the first launch of an install. Blocked or missing storage answers false so it never nags every launch. */
export function shouldOpenGuideOnFirstRun(storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    return storage != null && storage.getItem(KEY) === null;
  } catch {
    return false;
  }
}

export function markGuideSeen(storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, "1"); } catch { /* unavailable storage: the reader already answers false */ }
}
