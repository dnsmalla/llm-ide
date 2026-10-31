// Gmail -> note files -> mark seen. The core's `POST /kb/google/gmail/fetch` returns one capped batch (at most 50
// threads) with a `batchId` and holds the NEXT cursor as pending; only `POST /kb/google/gmail/seen` with that
// batch id moves it. This module is the client half of that contract:
//
//  - Every note is created through `WriteHost.create`, which never overwrites. A thread whose file already exists
//    is compared with what is on disk: identical -> nothing to do; different (new replies, or the user edited the
//    file) -> the new text is saved as a NEW sibling file named by a hash of its text, so nothing is lost and
//    nothing is replaced, and fetching the same thread again is idempotent.
//  - A tombstone ("deleted upstream <date>") is appended to the existing note with a compare-and-swap save; a note
//    that is not there is skipped (nothing to mark).
//  - `seen` is sent ONLY when every create and every tombstone of the batch succeeded and the run was not
//    stopped mid-batch. On any failure the batch is not confirmed, the failed file names are reported, and the
//    next fetch returns the same threads again (create-only makes the replay harmless).
//  - A big mailbox is fetched in rounds (one batch each, `pending` means more), with Stop checked between rounds
//    and between notes. Nothing larger than one batch is ever held in memory; only counters and at most
//    `MAX_FAILED_SHOWN` failed names are kept.
//  - Core output is treated as untrusted: the file name must match the core's own pattern (no path escape), the
//    text must be a Gmail note carrying `untrusted: true`, and its size is capped before it is written.

import { sha256HexWebCrypto } from "../../index-rebuild.ts";
import { toWriteError, type WriteHost } from "../../write/write-host.ts";
import type { SourcesCore } from "../source-core.ts";
import { GoogleError, googleGmailFetch, googleGmailSeen, mapGoogleThrown, type GmailFetch, type GmailNoteIn, type GoogleErrorCode, type Tombstone } from "./google-core.ts";

export const NOTE_DIR = "source/gmail";
export const NOTE_FILE_RE = /^gmail-[a-f0-9]{12}-[A-Za-z0-9_-]{1,100}\.md$/;
export const TOMBSTONE_RE = /^deleted upstream \d{4}-\d{2}-\d{2}$/;
export const MAX_NOTE_CHARS = 600_000;
export const MAX_ROUNDS = 1000;
export const MAX_FAILED_SHOWN = 50;

export type GmailPhase = "idle" | "fetching" | "writing" | "marking" | "done" | "cancelled" | "error";

export interface GmailProgress {
  phase: GmailPhase;
  rounds: number;
  threads: number;
  /** New files created. */
  written: number;
  /** Threads whose file existed with different text: saved as a new sibling file. */
  updated: number;
  /** Threads whose file already holds exactly this text. */
  unchanged: number;
  tombstoned: number;
  failedCount: number;
  /** Names (never paths, never mail text) of the first failures. */
  failed: string[];
  /** Batches the core confirmed. */
  confirmed: number;
  /** The core has more to give. */
  more: boolean;
  /** The server skipped threads (too large) or capped the run. */
  skipped: number;
  truncated: boolean;
  /** A batch was left unconfirmed (failure or stop): it will be fetched again. */
  unconfirmed: boolean;
  error: GoogleErrorCode | null;
  serverCode: string | null;
}

export const IDLE_GMAIL: GmailProgress = {
  phase: "idle", rounds: 0, threads: 0, written: 0, updated: 0, unchanged: 0, tombstoned: 0, failedCount: 0, failed: [], confirmed: 0, more: false, skipped: 0, truncated: false, unconfirmed: false, error: null, serverCode: null,
};

export function gmailMessage(p: GmailProgress): string {
  const n = (x: number): string => x.toLocaleString();
  switch (p.phase) {
    case "idle":
      return "";
    case "fetching":
      return `Fetching from Gmail (batch ${n(p.rounds + 1)})…`;
    case "writing":
      return `Saving notes (batch ${n(p.rounds)}): ${n(p.written + p.updated + p.unchanged)} saved or already there, ${n(p.threads)} threads so far…`;
    case "marking":
      return "Recording the batch as imported…";
    default: {
      const parts = [`${n(p.written)} new ${p.written === 1 ? "note" : "notes"} saved`];
      if (p.updated) parts.push(`${n(p.updated)} updated ${p.updated === 1 ? "thread" : "threads"} saved as new notes next to the old ones`);
      if (p.unchanged) parts.push(`${n(p.unchanged)} already there`);
      if (p.tombstoned) parts.push(`${n(p.tombstoned)} marked deleted upstream`);
      if (p.skipped) parts.push(`${n(p.skipped)} skipped by the core (too large)`);
      if (p.failedCount) parts.push(`${n(p.failedCount)} could not be saved`);
      if (p.unconfirmed) parts.push("the last batch was not confirmed, so Gmail will offer it again (nothing is duplicated)");
      if (p.truncated) parts.push("the core capped this run; fetch again for the rest");
      if (p.more && p.phase === "done") parts.push("more is available: fetch again");
      return `${p.phase === "cancelled" ? "Stopped. " : ""}${parts.join("; ")}.`;
    }
  }
}

export interface GmailDeps {
  core: SourcesCore;
  write: WriteHost;
  signal: AbortSignal;
  onProgress: (p: GmailProgress) => void;
  /** Rounds to run in one go (default `MAX_ROUNDS`). */
  maxRounds?: number;
}

/** A note from the core that is safe to write, or the reason it is not. */
export function checkNote(n: GmailNoteIn): "ok" | "bad_name" | "bad_text" | "too_large" {
  if (!NOTE_FILE_RE.test(n.noteFile)) return "bad_name";
  if (n.markdown.length > MAX_NOTE_CHARS) return "too_large";
  if (!n.markdown.startsWith("---\n")) return "bad_text";
  const end = n.markdown.indexOf("\n---\n", 4);
  if (end < 0) return "bad_text";
  const header = n.markdown.slice(0, end);
  if (!/^untrusted: true$/m.test(header) || !/^source: "gmail"$/m.test(header)) return "bad_text";
  return "ok";
}

export const noteRel = (noteFile: string): string => `${NOTE_DIR}/${noteFile}`;

async function sibling(noteFile: string, text: string): Promise<string> {
  const h = (await sha256HexWebCrypto(new TextEncoder().encode(text))).slice(0, 8);
  return noteRel(noteFile.replace(/\.md$/, `-u${h}.md`));
}

type Outcome = "written" | "updated" | "unchanged" | "failed";

/** Create-only write of one thread note (see the header comment for the three cases). */
export async function writeThread(write: WriteHost, n: GmailNoteIn): Promise<Outcome> {
  if (checkNote(n) !== "ok") return "failed";
  const rel = noteRel(n.noteFile);
  try {
    await write.create(rel, n.markdown);
    return "written";
  } catch (e) {
    if (toWriteError(e).code !== "exists") return "failed";
  }
  try {
    const have = await write.open(rel);
    if (have.text === n.markdown) return "unchanged";
    const alt = await sibling(n.noteFile, n.markdown);
    try {
      await write.create(alt, n.markdown);
      return "updated";
    } catch (e) {
      return toWriteError(e).code === "exists" ? "unchanged" : "failed";
    }
  } catch {
    return "failed";
  }
}

/** Appends the tombstone line with a compare-and-swap save. `skipped` when the note is not there or has the line. */
export async function applyTombstone(write: WriteHost, t: Tombstone): Promise<"applied" | "skipped" | "failed"> {
  if (!NOTE_FILE_RE.test(t.noteFile) || !TOMBSTONE_RE.test(t.line)) return "failed";
  const rel = noteRel(t.noteFile);
  try {
    const have = await write.open(rel);
    if (have.text.includes(`\n${t.line}`) || have.text.endsWith(t.line)) return "skipped";
    const sep = have.text.endsWith("\n") ? "\n" : "\n\n";
    await write.save(rel, `${have.text}${sep}${t.line}\n`, have.bom, have.hash);
    return "applied";
  } catch (e) {
    return toWriteError(e).code === "not_found" ? "skipped" : "failed";
  }
}

class Tracker {
  p: GmailProgress = { ...IDLE_GMAIL };
  private readonly emit: (p: GmailProgress) => void;
  constructor(emit: (p: GmailProgress) => void) {
    this.emit = emit;
  }
  set(patch: Partial<GmailProgress>): void {
    this.p = { ...this.p, ...patch };
    this.emit(this.p);
  }
  fail(name: string): void {
    this.set({ failedCount: this.p.failedCount + 1, failed: this.p.failed.length < MAX_FAILED_SHOWN ? [...this.p.failed, name] : this.p.failed });
  }
}

export interface BatchResult {
  allOk: boolean;
  stopped: boolean;
}

/** Writes one fetched batch. `allOk` only when every note and tombstone succeeded and nothing was stopped. */
export async function writeBatch(b: GmailFetch, write: WriteHost, signal: AbortSignal, t: Tracker): Promise<BatchResult> {
  let allOk = true;
  for (const n of b.notes) {
    if (signal.aborted) return { allOk: false, stopped: true };
    const o = await writeThread(write, n);
    if (o === "failed") {
      allOk = false;
      t.fail(NOTE_FILE_RE.test(n.noteFile) ? n.noteFile : "(invalid note from the core)");
    } else if (o === "written") t.set({ written: t.p.written + 1 });
    else if (o === "updated") t.set({ updated: t.p.updated + 1 });
    else t.set({ unchanged: t.p.unchanged + 1 });
  }
  for (const x of b.tombstones) {
    if (signal.aborted) return { allOk: false, stopped: true };
    const o = await applyTombstone(write, x);
    if (o === "failed") {
      allOk = false;
      t.fail(NOTE_FILE_RE.test(x.noteFile) ? x.noteFile : "(invalid tombstone from the core)");
    } else if (o === "applied") t.set({ tombstoned: t.p.tombstoned + 1 });
  }
  return { allOk, stopped: false };
}

/**
 * Fetches and saves Gmail in rounds until the core has nothing pending, a batch cannot be fully saved, the user
 * stops, an error occurs or `maxRounds` is reached. Never throws; the result is the final progress.
 */
export async function runGmailSync(accountId: string, deps: GmailDeps): Promise<GmailProgress> {
  const t = new Tracker(deps.onProgress);
  const max = Math.max(1, deps.maxRounds ?? MAX_ROUNDS);
  try {
    for (let round = 0; round < max; round += 1) {
      if (deps.signal.aborted) break;
      t.set({ phase: "fetching" });
      const b = await googleGmailFetch(deps.core, accountId, deps.signal);
      t.set({
        phase: "writing",
        rounds: t.p.rounds + 1,
        threads: t.p.threads + b.stats.threads,
        skipped: t.p.skipped + b.stats.skipped + b.stats.oversize,
        truncated: t.p.truncated || b.stats.truncated,
        more: b.pending,
      });
      const r = await writeBatch(b, deps.write, deps.signal, t);
      if (!r.allOk) {
        t.set({ unconfirmed: true, phase: r.stopped ? "cancelled" : "done" });
        return t.p;
      }
      t.set({ phase: "marking" });
      // Never abortable: the notes exist now, so the core must be told (aborting here would only cause a replay).
      await googleGmailSeen(deps.core, accountId, b.batchId, new AbortController().signal);
      t.set({ confirmed: t.p.confirmed + 1, unconfirmed: false });
      if (!b.pending) {
        t.set({ phase: deps.signal.aborted ? "cancelled" : "done", more: false });
        return t.p;
      }
    }
    t.set({ phase: deps.signal.aborted ? "cancelled" : "done" });
    return t.p;
  } catch (e) {
    const err = e instanceof GoogleError ? e : mapGoogleThrown(e, deps.signal);
    if (err.code === "cancelled") {
      t.set({ phase: "cancelled" });
      return t.p;
    }
    // An error while recording leaves a fully written batch unconfirmed: it is offered again and replays harmlessly.
    t.set({ phase: "error", error: err.code, serverCode: err.serverCode, unconfirmed: t.p.unconfirmed || t.p.phase === "marking" });
    return t.p;
  }
}
