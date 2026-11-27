// The Loop page used to keep its own queue of runs per project in localStorage. Queued loop runs now live in the run
// manager (one loop run per project at a time, the rest wait in FIFO order). This file only reads and removes what an
// older build persisted, so that queue is answered once and never silently restarted.
import type { LoopDefinition } from "./model.ts";

/** One entry of the retired persisted queue. */
export interface QueuedRun { loopId: string; scheduled: boolean; at: string; command?: string; inputPath?: string }

function key(root: string): string { return `llmide.loopQueue.v1.${root}`; }

export function loadQueue(root: string, storage: Storage | undefined = globalThis.localStorage): QueuedRun[] {
  try {
    const raw = storage?.getItem(key(root)); if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is QueuedRun => typeof x === "object" && x !== null && typeof (x as QueuedRun).loopId === "string").slice(0, 50);
  } catch { return []; }
}

export function clearQueue(root: string, storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.removeItem(key(root)); } catch { /* session only */ }
}

/**
 * Takes the retired queue of a project: removes it and says what was dropped. Entries are not re-submitted: they were queued
 * in an earlier session (the old page waited for an explicit Resume), and starting code-changing runs nobody asked for after a
 * restart is the worse mistake. Returns null when there was nothing queued.
 */
export function takeLegacyQueue(root: string, loops: readonly Pick<LoopDefinition, "id" | "name">[], storage: Storage | undefined = globalThis.localStorage): string | null {
  const entries = loadQueue(root, storage);
  clearQueue(root, storage);
  if (entries.length === 0) return null;
  const names = [...new Set(entries.map((q) => loops.find((l) => l.id === q.loopId)?.name).filter((n): n is string => n !== undefined))];
  return `${entries.length} run${entries.length === 1 ? "" : "s"} queued by an older version ${entries.length === 1 ? "was" : "were"} not restarted${names.length ? ` (${names.map((n) => `“${n}”`).join(", ")})` : ""}. Start ${entries.length === 1 ? "it" : "them"} again with ▶ Run.`;
}
