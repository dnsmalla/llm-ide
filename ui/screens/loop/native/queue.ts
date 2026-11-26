// Persisted Loop queue. The live queue is in-memory; this keeps enqueued ids per project so a reload or a navigation
// back to Loop can show/resume them. It deliberately does not claim the Mac's cross-window background queue.
import { normalizeInputPath } from "./input-path.ts";
import type { LoopDefinition } from "./model.ts";
import { RUN_COMMAND_MAX } from "./run-command.ts";

/** `command` and `inputPath` come from a board request; older entries have neither and load as before. */
export interface QueuedRun { loopId: string; scheduled: boolean; at: string; command?: string; inputPath?: string }

/** Whitespace-collapsed and bounded, like the Loop page's own task field. */
export function cleanCommand(text: string): string { return text.replace(/\s+/g, " ").trim().slice(0, RUN_COMMAND_MAX); }

/** The persisted form of a queue entry. `inputOverride` is set only by a board request (an explicit per-run path); a run queued from the Loop page never pins one, so a later edit of the loop is not shadowed. */
export function toQueued(entry: { loop: LoopDefinition; scheduled: boolean; command?: string; inputOverride?: string }, at: string): QueuedRun {
  const command = entry.command ? cleanCommand(entry.command) : "";
  return { loopId: entry.loop.id, scheduled: entry.scheduled, at, ...(command ? { command } : {}), ...(entry.inputOverride !== undefined ? { inputPath: entry.inputOverride } : {}) };
}

/** Rebuilds a queue entry against the loaded loop; an override that no longer validates drops the entry. */
export function fromQueued(q: QueuedRun, loop: LoopDefinition): { entry: { loop: LoopDefinition; scheduled: boolean; command?: string; inputOverride?: string } } | { error: string } {
  let target = loop;
  let inputOverride: string | undefined;
  if (typeof q.inputPath === "string") {
    const n = normalizeInputPath(q.inputPath);
    if ("error" in n) return { error: `Dropped a queued run of “${loop.name}”: ${n.error}` };
    target = { ...loop, inputPath: n.path };
    inputOverride = n.path;
  }
  const command = typeof q.command === "string" ? cleanCommand(q.command) : "";
  return { entry: { loop: target, scheduled: q.scheduled, ...(command ? { command } : {}), ...(inputOverride !== undefined ? { inputOverride } : {}) } };
}

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
