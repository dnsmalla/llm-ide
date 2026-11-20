// A loop's one branch (`loop/<slug>`): did its draft MR get merged? Git answers when the branch tip is in the base (the
// host checks that when it prepares the worktree); a squash or rebase merge leaves no trace in git, so the provider is
// asked about the MR the loop last opened.
import type { FsApi } from "../../explorer/fs";
import { decodeShipResults } from "../../factory/board-model.ts";
import { decodeFactoryFields, loadRunRecord, type LoopRunIndexEntry } from "./history.ts";

/** The URL of the draft MR this loop opened most recently, from its newest records, or null. */
export async function lastShipUrl(fs: Pick<FsApi, "read">, runs: readonly Pick<LoopRunIndexEntry, "id" | "loopId" | "startedAt">[], loopId: string): Promise<{ url: string; since: string } | null> {
  const mine = runs.filter((r) => r.loopId === loopId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5);
  for (const r of mine) {
    const ship = decodeFactoryFields(await loadRunRecord(fs, r.id, r.startedAt)).ship;
    if (ship) return { url: ship.url, since: r.startedAt };
  }
  return null;
}

/** True only when the provider says the MR is merged. Any doubt (offline, an error, an unknown answer) is false. */
export async function providerSaysMerged(request: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>, last: { url: string; since: string } | null): Promise<boolean> {
  if (!last) return false;
  try {
    const r = await request("/kb/loop/ship-status", { requests: [{ url: last.url, since: last.since }] });
    if (r.status !== 200) return false;
    const s = decodeShipResults(r.body).get(last.url);
    return s !== undefined && s !== "error" && s.state === "merged";
  } catch { return false; }
}

/** A loop keeps one branch for all its runs, so Discard (which removes it) belongs to the loop's NEWEST run only. */
export function isNewestRunOfLoop(runs: readonly Pick<LoopRunIndexEntry, "id" | "loopId" | "startedAt">[], entry: Pick<LoopRunIndexEntry, "id" | "loopId">): boolean {
  const newest = runs.filter((r) => r.loopId === entry.loopId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return !newest || newest.id === entry.id;
}

/**
 * Why a past run's Review/Discard panel must not open, or null. A loop's branch (`loop/…`) is shared by all its runs, so
 * Discard (which removes it) is offered from the newest run only, and never while that loop is running.
 */
export function branchDiscardRefusal(info: { branch: string }, runs: readonly Pick<LoopRunIndexEntry, "id" | "loopId" | "startedAt">[], entry: Pick<LoopRunIndexEntry, "id" | "loopId">, runningLoopId: string | null): string | null {
  if (!info.branch.startsWith("loop/")) return null;
  if (runningLoopId !== null && runningLoopId === entry.loopId) return "This loop is running now; its branch is in use. Open its run after it finishes.";
  if (!isNewestRunOfLoop(runs, entry)) return "This loop keeps one branch for all its runs. Open its newest run to review or discard that branch.";
  return null;
}
