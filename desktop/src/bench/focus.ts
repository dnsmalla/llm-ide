// Focus and visibility monitor for one bench step. A bench measured while the window is hidden
// or unfocused is not valid (WKWebView throttles rAF and timers), so the runner tracks the time
// lost and marks the step's records when it exceeds TOLERANCE_MS.
const SAMPLE_MS = 250;
export const FOCUS_TOLERANCE_MS = 250;

export interface FocusReport {
  lostMs: number;
  valid: boolean;
}

/** Starts sampling; the returned function stops it and reports the time focus or visibility was lost. */
export function startFocusMonitor(): () => FocusReport {
  let lostMs = 0;
  let lostSince: number | null = null;
  const check = () => {
    const lost = document.visibilityState !== "visible" || !document.hasFocus();
    const now = performance.now();
    if (lost && lostSince === null) lostSince = now;
    else if (!lost && lostSince !== null) {
      lostMs += now - lostSince;
      lostSince = null;
    }
  };
  const timer = setInterval(check, SAMPLE_MS);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  window.addEventListener("blur", check);
  check();
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("focus", check);
    window.removeEventListener("blur", check);
    check();
    if (lostSince !== null) {
      lostMs += performance.now() - lostSince;
      lostSince = null;
    }
    const rounded = Math.round(lostMs);
    return { lostMs: rounded, valid: rounded <= FOCUS_TOLERANCE_MS };
  };
}
