// Main-thread stall monitor. Uses the Long Tasks API when the webview supports it
// (`longtask`); otherwise a 10 ms setInterval whose overrun is the stall. The method
// is reported with the number, since the two measure different things.
export interface StallResult {
  maxMs: number;
  method: "longtask" | "drift";
}

const INTERVAL_MS = 10;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Starts monitoring; the returned function stops it and reports the longest stall. */
export function startStallMonitor(): () => StallResult {
  const supported = typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("longtask");
  if (supported) {
    let max = 0;
    const record = (entries: PerformanceEntryList) => {
      for (const entry of entries) max = Math.max(max, entry.duration);
    };
    const observer = new PerformanceObserver((list) => record(list.getEntries()));
    try {
      observer.observe({ type: "longtask", buffered: false });
      return () => {
        record(observer.takeRecords());
        observer.disconnect();
        return { maxMs: round1(max), method: "longtask" };
      };
    } catch {
      observer.disconnect();
    }
  }
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - INTERVAL_MS);
    last = now;
  }, INTERVAL_MS);
  return () => {
    clearInterval(timer);
    return { maxMs: round1(Math.max(0, max)), method: "drift" };
  };
}
