// Calendar and Drive sync (Pattern A: the core indexes into its own search index; no note files are created).
// `POST /kb/google/sync` runs ONE capped pass and reports `pending` while more is left, so a big drive (up to
// 50,000 files) is covered by repeating it. This module repeats it, with Stop checked between passes, a
// stall guard (a pass that changes nothing twice in a row ends the run), and counters only (nothing per-item is
// kept). A 429 after the core's own retries ends the run and starts a cooldown the pane shows.

import type { SourcesCore } from "../source-core.ts";
import { GoogleError, googleSync, mapGoogleThrown, type GoogleErrorCode, type Product, type SyncResult } from "./google-core.ts";

export const MAX_PASSES = 500;
export const COOLDOWN_MS = 60_000;

export type SyncPhase = "idle" | "running" | "done" | "cancelled" | "error";

export interface SyncProgress {
  product: "gcal" | "gdrive";
  phase: SyncPhase;
  passes: number;
  /** Calendar: events upserted. Drive: files indexed. */
  items: number;
  /** Calendar: cancelled events removed. Drive: removed or trashed files removed. */
  removed: number;
  withContent: number;
  metadataOnly: number;
  skippedShared: number;
  contentSkipped: number;
  resynced: boolean;
  restarted: boolean;
  truncated: boolean;
  more: boolean;
  error: GoogleErrorCode | null;
  serverCode: string | null;
}

export const idleSync = (product: "gcal" | "gdrive"): SyncProgress => ({
  product, phase: "idle", passes: 0, items: 0, removed: 0, withContent: 0, metadataOnly: 0, skippedShared: 0, contentSkipped: 0, resynced: false, restarted: false, truncated: false, more: false, error: null, serverCode: null,
});

/** Folds one pass into the running totals. */
export function addPass(p: SyncProgress, r: SyncResult): SyncProgress {
  if (r.product === "gcal") {
    return { ...p, passes: p.passes + 1, items: p.items + r.events, removed: p.removed + r.cancelled, resynced: p.resynced || r.calendars.some((c) => c.resynced), more: r.pending };
  }
  const s = r.stats;
  return {
    ...p,
    passes: p.passes + 1,
    items: p.items + s.files,
    removed: p.removed + s.removed,
    withContent: p.withContent + s.withContent,
    metadataOnly: p.metadataOnly + s.metadataOnly,
    skippedShared: p.skippedShared + s.skippedShared,
    contentSkipped: p.contentSkipped + s.contentSkipped,
    restarted: p.restarted || s.restarted,
    truncated: p.truncated || s.truncated,
    more: r.pending,
  };
}

export function syncMessage(p: SyncProgress): string {
  const n = (x: number): string => x.toLocaleString();
  if (p.phase === "idle") return "";
  if (p.phase === "running") return `Syncing (pass ${n(p.passes + 1)}): ${n(p.items)} ${p.product === "gcal" ? "events" : "files"} so far…`;
  if (p.phase === "error" && p.passes === 0) return "";
  const parts: string[] = [];
  if (p.product === "gcal") {
    parts.push(`${n(p.items)} events indexed`);
    if (p.removed) parts.push(`removed ${n(p.removed)} cancelled`);
    if (p.resynced) parts.push("a calendar was re-read from scratch because Google's saved position expired");
  } else {
    parts.push(`${n(p.items)} files indexed`);
    if (p.withContent) parts.push(`${n(p.withContent)} with text`);
    if (p.metadataOnly) parts.push(`${n(p.metadataOnly)} by name only`);
    if (p.removed) parts.push(`removed ${n(p.removed)} deleted or trashed`);
    if (p.skippedShared) parts.push(`${n(p.skippedShared)} in shared drives skipped (off)`);
    if (p.contentSkipped) parts.push(`${n(p.contentSkipped)} too large or unsupported to read`);
    if (p.restarted) parts.push("restarted from scratch because Google's saved position expired");
    if (p.truncated) parts.push("the core capped this pass");
  }
  if (p.more) parts.push("more is left: sync again");
  return `${p.phase === "cancelled" ? "Stopped. " : ""}${parts.join("; ")}.`;
}

export interface SyncDeps {
  core: SourcesCore;
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  maxPasses?: number;
}

const moved = (before: SyncProgress, after: SyncProgress): boolean => after.items !== before.items || after.removed !== before.removed;

/** Repeats the sync until nothing is pending, the user stops, it stalls, errors, or `maxPasses` is reached. Never throws. */
export async function runProductSync(accountId: string, product: Exclude<Product, "gmail">, deps: SyncDeps): Promise<SyncProgress> {
  let p: SyncProgress = { ...idleSync(product), phase: "running" };
  deps.onProgress(p);
  const max = Math.max(1, deps.maxPasses ?? MAX_PASSES);
  let still = 0;
  try {
    for (let i = 0; i < max; i += 1) {
      if (deps.signal.aborted) {
        p = { ...p, phase: "cancelled" };
        break;
      }
      const r = await googleSync(deps.core, accountId, product, deps.signal);
      const next = addPass(p, r);
      still = moved(p, next) ? 0 : still + 1;
      p = { ...next, phase: "running" };
      deps.onProgress(p);
      if (!r.pending) {
        p = { ...p, phase: "done", more: false };
        break;
      }
      if (still >= 2) {
        p = { ...p, phase: "done" };
        break;
      }
      if (i === max - 1) p = { ...p, phase: "done" };
    }
    if (p.phase === "running") p = { ...p, phase: deps.signal.aborted ? "cancelled" : "done" };
  } catch (e) {
    const err = e instanceof GoogleError ? e : mapGoogleThrown(e, deps.signal);
    p = err.code === "cancelled" ? { ...p, phase: "cancelled" } : { ...p, phase: "error", error: err.code, serverCode: err.serverCode };
  }
  deps.onProgress(p);
  return p;
}

/** Milliseconds a sync button stays disabled after an error that means "slow down", from the clock `now`. */
export function cooldownUntil(code: GoogleErrorCode | null, now: number): number {
  return code === "rate_limited" || code === "busy" ? now + COOLDOWN_MS : 0;
}
