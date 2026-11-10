// Review & Merge picks the Factory run to review: the newest card in "Ready to ship" (the board's own column rules)
// whose run still has its worktree. It never ships; the card's Ship button stays a separate user click.
import type { FsApi } from "../explorer/fs";
import { assembleFacts, decodeWorktreeList, latestRecords, type WorktreeInfo } from "../factory/board-model.ts";
import { columnFor, type RunRecordFacts } from "../factory/columns.ts";
import { readItems, type WorkItemRecord } from "../factory/items.ts";

export interface PendingRun { runId: string; itemKey: string }

/** Pure: the board's facts for each card, then the newest "Ready to ship" card with a live worktree. */
export function selectPendingRun(
  worktrees: ReadonlyMap<string, WorktreeInfo>,
  records: ReadonlyMap<string, RunRecordFacts>,
  items: readonly WorkItemRecord[],
): PendingRun | null {
  let best: (PendingRun & { startedAt: string }) | null = null;
  for (const item of items) {
    // No live runs, PR status or last-known columns here: a card with one of those is not "Ready to ship" anyway.
    const facts = assembleFacts(item, { projectRoot: "", live: [], records, worktrees, ship: new Map(), lastKnown: new Map() });
    if (!facts.lastRecord || !facts.worktreeExists || columnFor(facts).column !== "readyToShip") continue;
    const startedAt = facts.lastRecord.entry?.startedAt ?? "";
    if (best === null || startedAt > best.startedAt) best = { runId: facts.lastRecord.runId, itemKey: item.key, startedAt };
  }
  return best === null ? null : { runId: best.runId, itemKey: best.itemKey };
}

/** The pending run as the Factory board reads it: the same items, last-run records and worktree list. */
export async function loadPendingRun(fs: FsApi, listWorktrees: () => Promise<unknown>): Promise<PendingRun | null> {
  const items = await readItems(fs);
  const runIds = new Set(items.flatMap((i) => i.runIds.slice(-1)));
  const [records, worktrees] = await Promise.all([
    latestRecords(fs, runIds),
    listWorktrees().then(decodeWorktreeList, () => new Map<string, WorktreeInfo>()),
  ]);
  return selectPendingRun(worktrees, records, items);
}
