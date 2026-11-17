// Resumes a Factory run the app's quit interrupted, from the app's background rather than the board: the person
// reopens the app and the work carries on. Narrow on purpose (see eligibility below); the native approval for shell
// commands still appears as for any run start, so the safety gate stays human.
import type { FsApi } from "../explorer/fs";
import { repoPrefixFor } from "../loop/native/worktree-run.ts";
import type { LiveRun } from "../loop/native/run-manager.ts";
import { readPending } from "../loop/native/pending-records.ts";
import { assembleFacts, latestRecords, type WorktreeInfo } from "./board-model.ts";
import { NOTE } from "./columns.ts";
import { interruptedRunPlan } from "./intake.ts";
import { attachRun, readItems } from "./items.ts";
import type { StartRunFn } from "./send-back.ts";

export interface AutoResumeDeps {
  projectRoot(): string | null;
  fs(root: string): Pick<FsApi, "read" | "write" | "create" | "list">;
  worktrees(): Promise<ReadonlyMap<string, Pick<WorktreeInfo, "runId" | "worktree">>>;
  live(): readonly Pick<LiveRun, "runId" | "itemKey" | "projectRoot">[];
  /** Core status trust is "spawned" and this is the desktop host: an adopted, remote or SSH core never auto-resumes. */
  localSpawnedCore(): boolean;
  /** The Factory loop applies code and is manual-only. */
  loopIsManualOnly(): Promise<boolean>;
  /** loop_worktree_diff -> files.length */
  changedFiles(runId: string): Promise<number>;
  start: StartRunFn;
  readResumed(): Record<string, true>;
  writeResumed(ids: Record<string, true>): void;
  notice(message: string): void;
  /** Run ids whose finished record is still held for this project (not yet flushed to the journal). Default: stored ones. */
  pendingRunIds?(root: string): ReadonlySet<string>;
  /** Marks the started run's card `Continuing automatically…` while it is queued. */
  markResuming?(runId: string): void;
}

// A second tick must not start the same run while the first is still deciding.
const attempted = new Set<string>();

/** Run ids with a record (or a thrown run's marker clear) still waiting for the project to be open. */
export function storedPendingRunIds(root: string): ReadonlySet<string> {
  const ids = new Set<string>();
  let store: Storage | undefined;
  try { store = globalThis.localStorage; } catch { store = undefined; }
  for (const p of readPending(store)) {
    if (p.projectRoot !== root) continue;
    const fromRecord = (p.record.worktree as { runId?: unknown } | undefined)?.runId;
    if (typeof fromRecord === "string") ids.add(fromRecord);
    if (p.entry.id.startsWith("marker:")) ids.add(p.entry.id.slice("marker:".length));
  }
  return ids;
}

/** One pass over the open project. Returns how many runs started. Never throws. */
export async function autoResumeOnce(d: AutoResumeDeps): Promise<number> {
  const root = d.projectRoot();
  if (!root) return 0;
  try {
    if (!d.localSpawnedCore() || await d.loopIsManualOnly()) return 0;
    const fs = d.fs(root);
    const items = await readItems(fs);
    const worktrees = await d.worktrees();
    const records = await latestRecords(fs, new Set(items.flatMap((i) => i.runIds.slice(-1))));
    const held = (d.pendingRunIds ?? storedPendingRunIds)(root);
    const resumed = d.readResumed();
    let n = 0;
    for (const item of items) {
      const runId = item.runIds.at(-1) ?? null;
      const wt = runId ? worktrees.get(runId) : undefined;
      if (!runId || !wt || resumed[runId] || attempted.has(`${root}\u0000${runId}`) || held.has(runId)) continue;
      const mark = await fs.read(`${repoPrefixFor(root, wt.worktree)}/.factory/RUN.json`).catch(() => null);
      if (mark?.status !== "ok") continue;
      let startedAt = "";
      try {
        const parsed: unknown = JSON.parse(mark.text ?? "");
        const obj = parsed as { runId?: unknown; startedAt?: unknown } | null;
        if (obj?.runId !== runId) continue;
        startedAt = typeof obj.startedAt === "string" ? obj.startedAt : "";
      } catch { continue; }
      const f = assembleFacts(item, { projectRoot: root, live: d.live() as LiveRun[], records, worktrees: worktrees as ReadonlyMap<string, unknown>, interrupted: new Set([runId]), ship: new Map(), lastKnown: new Map() });
      const rec = f.lastRecord;
      if (f.live || rec?.statusCode === "awaiting_review") continue;
      // A finished record from after the marker was written means the run ended; the marker is only waiting to be cleared.
      if (rec?.endedAt && startedAt && rec.endedAt >= startedAt) continue;
      // Recorded BEFORE start: a crash, a throw or a declined approval must never make this run loop.
      attempted.add(`${root}\u0000${runId}`);
      d.writeResumed({ ...resumed, [runId]: true });
      resumed[runId] = true;
      try {
        const prefix = repoPrefixFor(root, wt.worktree);
        const plan = await interruptedRunPlan({
          changedFiles: (id) => d.changedFiles(id).catch(() => 0),
          hasPlan: () => fs.read(`${prefix}/.factory/PLAN.md`, 200_000).then((r) => r.status === "ok", () => false),
        }, item, f);
        const started = d.start(root, item, plan.mode, plan.runId ? { runId: plan.runId } : undefined);
        if (!plan.runId) await attachRun(fs, item.key, started);
        d.markResuming?.(started);
        d.notice(`"${item.title}" was interrupted when the app closed; ${NOTE.continuingAutomatically.toLowerCase()}`);
        n += 1;
      } catch { /* the id stays recorded: the card keeps its Continue button */ }
    }
    return n;
  } catch {
    return 0;
  }
}

const RESUMED_KEY = "llmide.factory.autoResumed";

/** Run ids already auto-resumed, kept across restarts. Unreadable storage reads as none (the in-process guard still holds). */
export function readAutoResumed(): Record<string, true> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(RESUMED_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.keys(raw).map((k) => [k, true as const]));
  } catch { return {}; }
}

export function writeAutoResumed(ids: Record<string, true>): void {
  try { globalThis.localStorage?.setItem(RESUMED_KEY, JSON.stringify(ids)); } catch { /* the in-process guard still holds */ }
}

export function _resetAutoResumeForTests(): void { attempted.clear(); }
