// Persisted Loop queue. The live queue is in-memory; this keeps enqueued ids per project so a reload or a navigation
// back to Loop can show/resume them. It deliberately does not claim the Mac's cross-window background queue.
export interface QueuedRun { loopId: string; scheduled: boolean; at: string }

function key(root: string): string { return `llmide.loopQueue.v1.${root}`; }

export function loadQueue(root: string, storage: Storage | undefined = globalThis.localStorage): QueuedRun[] {
  try {
    const raw = storage?.getItem(key(root)); if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is QueuedRun => typeof x === "object" && x !== null && typeof (x as QueuedRun).loopId === "string").slice(0, 50);
  } catch { return []; }
}

export function saveQueue(root: string, runs: readonly QueuedRun[], storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.setItem(key(root), JSON.stringify(runs.slice(0, 50))); } catch { /* session only */ }
}

export function clearQueue(root: string, storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.removeItem(key(root)); } catch { /* session only */ }
}
