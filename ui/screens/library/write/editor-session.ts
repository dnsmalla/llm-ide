// The note editor's state machine. No React, no DOM: the component renders `getSnapshot()` and calls
// the methods; every transition is tested with node.
//
// Data safety rules:
//  - A save is a compare-and-swap on the hash of the bytes last read or written. A different file on
//    disk is `conflict`: nothing is overwritten. The user chooses: keep mine (force), take theirs
//    (reload, drops the draft), or save mine as a copy next to it.
//  - Saves of one note never overlap (WriteQueue), so our own second save never conflicts with our first.
//  - The draft lives in memory and is never discarded by a failed save. `dirty` is derived from the
//    draft versus the last saved text, so undoing back to the saved text is clean again.
//  - Line endings: a textarea hands back "\n" only. The file's own ending (CRLF or LF) is detected on
//    open and re-applied on save, so an edited CRLF note stays CRLF. A save with no change is skipped,
//    so merely opening a note never rewrites it.
//  - Not-UTF-8, too-large and hard-linked files are refused by the host and never opened.

import { toWriteError, type WriteErrorCode, type WriteHost, type SavedNote } from "./write-host.ts";
import { conflictCopyRel } from "./note-ops.ts";
import { WriteQueue } from "./write-queue.ts";

export type EditorPhase = "idle" | "loading" | "clean" | "dirty" | "saving" | "conflict" | "gone" | "error";

export interface EditorSnapshot {
  phase: EditorPhase;
  rel: string;
  /** The editable text (always "\n" line endings). */
  draft: string;
  error: WriteErrorCode | null;
  /** The file uses CRLF; the draft is converted back on save. */
  crlf: boolean;
  /** Mixed endings were found; saving unifies them to the dominant one (shown as a notice). */
  mixedEol: boolean;
  /** Last save succeeded (cleared by the next edit). */
  justSaved: boolean;
}

export interface EditorDeps {
  host: WriteHost;
  queue: WriteQueue;
  /** Called after every successful write with the saved note and the exact text written. */
  onWritten: (saved: SavedNote, text: string) => void;
  /** Free-path check for the conflict copy. */
  taken: (rel: string) => boolean;
}

interface Base {
  /** Text as read, "\n"-normalised (for the dirty check). */
  norm: string;
  hash: string;
  bom: boolean;
}

export function detectEol(text: string): { crlf: boolean; mixed: boolean } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { crlf: crlf > lf, mixed: crlf > 0 && lf > 0 };
}

export const toLf = (s: string): string => s.replaceAll("\r\n", "\n");
export const toFileEol = (s: string, crlf: boolean): string => (crlf ? s.replaceAll("\n", "\r\n") : s);

export class EditorSession {
  private readonly deps: EditorDeps;
  private readonly listeners = new Set<() => void>();
  private base: Base | null = null;
  private gen = 0;
  private snap: EditorSnapshot;

  constructor(rel: string, deps: EditorDeps) {
    this.deps = deps;
    this.snap = { phase: "idle", rel, draft: "", error: null, crlf: false, mixedEol: false, justSaved: false };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): EditorSnapshot => this.snap;

  private set(p: Partial<EditorSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  get dirty(): boolean {
    return this.base !== null && this.snap.draft !== this.base.norm;
  }

  dispose(): void {
    this.gen += 1;
    this.listeners.clear();
  }

  /** Reads the note from disk, replacing any draft. */
  /** Bumped when a save starts and when it lands: lets `checkExternal` discard a read that raced a write. */
  private writeSeq = 0;

  async load(): Promise<void> {
    const g = ++this.gen;
    this.set({ phase: "loading", error: null, justSaved: false });
    try {
      const o = await this.deps.host.open(this.snap.rel);
      if (g !== this.gen) return;
      const eol = detectEol(o.text);
      const norm = toLf(o.text);
      this.base = { norm, hash: o.hash, bom: o.bom };
      this.set({ phase: "clean", draft: norm, crlf: eol.crlf, mixedEol: eol.mixed, error: null });
    } catch (e) {
      if (g !== this.gen) return;
      const code = toWriteError(e).code;
      this.set({ phase: code === "not_found" ? "gone" : "error", error: code });
    }
  }

  edit(draft: string): void {
    if (this.base === null || this.snap.phase === "loading" || this.snap.phase === "gone") return;
    const text = toLf(draft);
    const phase = this.snap.phase === "conflict" ? "conflict" : text === this.base.norm ? "clean" : "dirty";
    this.set({ draft: text, phase: this.snap.phase === "saving" ? "saving" : phase, justSaved: false });
  }

  private fileText(): string {
    return toFileEol(this.snap.draft, this.snap.crlf);
  }

  /** Saves the draft (compare-and-swap). Resolves true when the note on disk now equals the draft. */
  async save(force = false): Promise<boolean> {
    const base = this.base;
    if (base === null || this.snap.phase === "saving" || this.snap.phase === "loading") return false;
    if (this.snap.draft === base.norm) {
      this.set({ phase: "clean", justSaved: false });
      return true; // nothing to write: opening a note never rewrites it
    }
    const g = this.gen;
    this.writeSeq++;
    const text = this.fileText();
    const draftAtStart = this.snap.draft;
    this.set({ phase: "saving", error: null });
    try {
      const saved = await this.deps.queue.run(this.snap.rel, () => this.deps.host.save(this.snap.rel, text, base.bom, base.hash, force));
      if (g !== this.gen) return false;
      this.writeSeq++;
      this.base = { norm: toLf(text), hash: saved.hash, bom: base.bom };
      this.deps.onWritten(saved, text);
      // Edits typed while the save was in flight stay as a new draft on top of the saved base.
      const stillSame = this.snap.draft === draftAtStart;
      this.set({ phase: stillSame ? "clean" : "dirty", error: null, justSaved: stillSame });
      return stillSame;
    } catch (e) {
      if (g !== this.gen) return false;
      const code = toWriteError(e).code;
      if (code === "conflict") this.set({ phase: "conflict", error: "conflict" });
      else if (code === "not_found") this.set({ phase: "gone", error: code });
      else this.set({ phase: "dirty", error: code });
      return false;
    }
  }

  /** Conflict choice 1: overwrite what is on disk with my version. */
  keepMine(): Promise<boolean> {
    return this.save(true);
  }

  /** Conflict choice 2: drop my draft and show what is on disk. */
  async takeTheirs(): Promise<void> {
    await this.load();
  }

  /** Conflict choice 3 (also for a note deleted underneath): write my version as a new note next to it. Returns its path. */
  async saveAsCopy(): Promise<string | null> {
    const g = this.gen;
    const text = this.fileText();
    try {
      const rel = conflictCopyRel(this.snap.rel, this.deps.taken);
      const saved = await this.deps.queue.run(rel, () => this.deps.host.create(rel, text));
      if (g !== this.gen) return null;
      this.deps.onWritten(saved, text);
      return rel;
    } catch (e) {
      if (g !== this.gen) return null;
      this.set({ error: toWriteError(e).code });
      return null;
    }
  }

  /**
   * Called when the window regains focus: re-reads the note's hash. A clean editor silently shows the new
   * text; a dirty one is marked as in conflict BEFORE the user tries to save (the save would fail anyway).
   */
  async checkExternal(): Promise<void> {
    const base = this.base;
    if (base === null || this.snap.phase === "saving" || this.snap.phase === "loading") return;
    const g = this.gen;
    const w = this.writeSeq;
    try {
      const o = await this.deps.host.open(this.snap.rel);
      // A save started or finished while this read was in flight: what it read may be older than our own write.
      if (g !== this.gen || w !== this.writeSeq || this.base !== base || o.hash === this.base?.hash) return;
      if (this.snap.phase === "clean" || (this.snap.phase === "dirty" && this.snap.draft === base.norm)) {
        const eol = detectEol(o.text);
        const norm = toLf(o.text);
        this.base = { norm, hash: o.hash, bom: o.bom };
        this.set({ phase: "clean", draft: norm, crlf: eol.crlf, mixedEol: eol.mixed });
      } else if (this.snap.phase === "dirty") {
        this.set({ phase: "conflict", error: "conflict" });
      }
    } catch (e) {
      if (g !== this.gen) return;
      if (toWriteError(e).code === "not_found") this.set({ phase: this.snap.phase === "dirty" ? "gone" : "gone", error: "not_found" });
    }
  }
}
