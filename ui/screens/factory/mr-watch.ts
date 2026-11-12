// Watches the open project's shipped Factory cards from the app's background, not the board: a person closing an MR
// or commenting on it restarts that card from the first step even when the Factory screen was never opened.
import type { FsApi } from "../explorer/fs";
import { repoPrefixFor } from "../loop/native/worktree-run.ts";
import type { LiveRun } from "../loop/native/run-manager.ts";
import { assembleFacts, autoRework, latestRecords, shipRequestsFor, type WorktreeInfo } from "./board-model.ts";
import type { ShipStatus } from "./columns.ts";
import { readItems } from "./items.ts";
import { rework, type StartRunFn } from "./send-back.ts";

export interface MrWatchDeps {
  projectRoot(): string | null;
  fs(root: string): Pick<FsApi, "read" | "write" | "create" | "list">;
  worktrees(): Promise<ReadonlyMap<string, Pick<WorktreeInfo, "runId" | "worktree">>>;
  live(): readonly Pick<LiveRun, "runId" | "itemKey" | "projectRoot">[];
  /** POST /kb/loop/ship-status for these MRs; url → status, or "error". */
  shipStatus(requests: { url: string; since: string }[]): Promise<ReadonlyMap<string, ShipStatus | "error">>;
  readCounts(): Record<string, number>;
  writeCounts(counts: Record<string, number>): void;
  start: StartRunFn;
  notice(message: string): void;
}

// One restart per run record, process-wide: a later check of the same MR state must not start it again.
const restarted = new Set<string>();

/** One check of the open project's MRs. Returns how many cards restarted. Never throws. */
export async function watchMrsOnce(d: MrWatchDeps): Promise<number> {
  const root = d.projectRoot();
  if (!root) return 0;
  try {
    const fs = d.fs(root);
    const items = await readItems(fs);
    const records = await latestRecords(fs, new Set(items.flatMap((i) => i.runIds.slice(-1))));
    const requests = shipRequestsFor(items, records);
    if (requests.length === 0) return 0;
    const [worktrees, ship] = await Promise.all([d.worktrees(), d.shipStatus(requests)]);
    const interrupted = new Set<string>();
    for (const [runId, wt] of worktrees) {
      const r = await fs.read(`${repoPrefixFor(root, wt.worktree)}/.factory/RUN.json`).catch(() => null);
      if (r?.status === "ok") interrupted.add(runId);
    }
    const counts = d.readCounts();
    let changed = false;
    let n = 0;
    for (const item of items) {
      const f = assembleFacts(item, { projectRoot: root, live: d.live() as LiveRun[], records, worktrees: worktrees as ReadonlyMap<string, unknown>, interrupted, ship, lastKnown: new Map() });
      // Keyed by project too: the same issue can be a card in two projects.
      const countKey = `${root}\u0000${item.key}`;
      if (f.ship?.state === "merged" && counts[countKey]) { delete counts[countKey]; changed = true; continue; }
      const reason = autoRework(f, counts[countKey] ?? 0);
      const once = `${root}\u0000${item.key}\u0000${f.lastRecord?.entry?.id ?? ""}`;
      if (!reason || !f.ship || restarted.has(once)) continue;
      restarted.add(once);
      // A failed restart (project switched, feedback not writable) is retried at the next check; other cards go on.
      try {
        await rework({ fs, start: d.start, projectRoot: root }, item, f.ship, reason);
      } catch {
        restarted.delete(once);
        continue;
      }
      counts[countKey] = (counts[countKey] ?? 0) + 1;
      changed = true;
      d.notice(`${reason === "closed" ? "The MR was closed" : "The MR got comments"}: "${item.title}" starts again from the first step.`);
      n += 1;
    }
    if (changed) d.writeCounts(counts);
    return n;
  } catch {
    return 0;
  }
}

const REWORKS_KEY = "llmide.factory.reworks";

/** Automatic MR restarts per card, kept across app restarts so the limit holds. Unreadable storage reads as none. */
export function readReworkCounts(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(REWORKS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  } catch { return {}; }
}

export function writeReworkCounts(counts: Record<string, number>): void {
  try { globalThis.localStorage?.setItem(REWORKS_KEY, JSON.stringify(counts)); } catch { /* the once-per-record guard still holds */ }
}

export function _resetMrWatchForTests(): void { restarted.clear(); }
