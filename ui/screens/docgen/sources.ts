// Source selection and lazy reading for a generation run. The selection is a map of small descriptors (no content),
// so 5,000 selected sources cost kilobytes. Content is read only when Generate is pressed, a few at a time, each
// capped to what the core would keep, and reading stops as soon as the core's source budget is certain to be full.
// Everything is cancellable.
import { MAX_BODY_CHARS, MAX_SELECTED_SOURCES, MAX_SOURCE_CONTENT, MAX_TOTAL_SOURCE_CHARS, MIN_SOURCE_CONTENT, type SourcePayload } from "./model.ts";

export type SourceKind = "paste" | "note" | "file";

export interface SourceItem {
  /** Unique within a selection: `file:<rel>`, `note:<rel>`, `paste:<n>`. */
  key: string;
  kind: SourceKind;
  /** Project-relative (file) or notes-folder-relative (note) path; unused for paste. */
  rel: string;
  /** Display name sent to the model (`### <name>`): the file name, or the paste label. */
  name: string;
  /** Size on disk in bytes (0 for paste: measured from text). */
  bytes: number;
  /** Pasted text, held in memory (bounded). */
  text?: string;
}

/** Reads the start of a source as text. `null` text = not text (binary, placeholder, missing). */
export interface SourceReaders {
  file(rel: string, maxBytes: number, signal: AbortSignal): Promise<{ text: string | null; truncated: boolean }>;
  note(rel: string, maxBytes: number, signal: AbortSignal): Promise<{ text: string | null; truncated: boolean }>;
}

export const READ_BYTES = MAX_SOURCE_CONTENT * 4;
export const READ_CONCURRENCY = 4;
/** One pasted block may not exceed this; larger text belongs in a file. */
export const MAX_PASTE_CHARS = 200_000;

const KIND_RANK: Record<SourceKind, number> = { paste: 0, note: 1, file: 2 };

/** Deterministic send order (the core drops from the END when over budget, so the order decides what survives). */
export function sendOrder(items: Iterable<SourceItem>): SourceItem[] {
  return [...items].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || (a.key < b.key ? -1 : 1));
}

export function fileName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

export interface Totals {
  count: number;
  bytes: number;
}

/** Selection of sources by key. Immutable-style updates so React/stores can compare by identity. */
export class SourceSelection {
  private readonly map: ReadonlyMap<string, SourceItem>;
  private pasteSeq: number;
  constructor(map: ReadonlyMap<string, SourceItem> = new Map(), pasteSeq = 0) {
    this.map = map;
    this.pasteSeq = pasteSeq;
  }
  get size(): number {
    return this.map.size;
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  items(): SourceItem[] {
    return [...this.map.values()];
  }
  /** Adds items up to the cap; returns the new selection and how many were refused because of the cap. */
  add(items: readonly SourceItem[]): { selection: SourceSelection; refused: number } {
    const next = new Map(this.map);
    let refused = 0;
    for (const it of items) {
      if (next.has(it.key)) continue;
      if (next.size >= MAX_SELECTED_SOURCES) {
        refused += 1;
        continue;
      }
      next.set(it.key, it);
    }
    return { selection: new SourceSelection(next, this.pasteSeq), refused };
  }
  remove(keys: Iterable<string>): SourceSelection {
    const next = new Map(this.map);
    for (const k of keys) next.delete(k);
    return new SourceSelection(next, this.pasteSeq);
  }
  clear(): SourceSelection {
    return new SourceSelection(new Map(), this.pasteSeq);
  }
  addPaste(text: string): { selection: SourceSelection; item: SourceItem | null; reason: "empty" | "too_long" | "cap" | null } {
    const t = text.trim();
    if (t === "") return { selection: this, item: null, reason: "empty" };
    if (t.length > MAX_PASTE_CHARS) return { selection: this, item: null, reason: "too_long" };
    const n = this.pasteSeq + 1;
    const item: SourceItem = { key: `paste:${n}`, kind: "paste", rel: "", name: `Pasted text ${n}`, bytes: t.length, text: t };
    const r = this.add([item]);
    if (r.refused) return { selection: this, item: null, reason: "cap" };
    return { selection: new SourceSelection(new Map(r.selection.map), n), item, reason: null };
  }
  totals(): Totals {
    let bytes = 0;
    for (const it of this.map.values()) bytes += it.bytes;
    return { count: this.map.size, bytes };
  }
}

export function fileItem(rel: string, bytes: number): SourceItem {
  return { key: `file:${rel}`, kind: "file", rel, name: fileName(rel), bytes };
}

export function noteItem(rel: string, bytes: number, title?: string): SourceItem {
  return { key: `note:${rel}`, kind: "note", rel, name: (title && title.trim()) || fileName(rel), bytes };
}

/** Rough UTF-16 character count from a byte size, for the pre-run estimate (UTF-8 text averages ~1.2 bytes/char). */
export function estimateChars(bytes: number): number {
  return Math.ceil(bytes / 1.2);
}

export interface CollectProgress {
  done: number;
  total: number;
  chars: number;
}

export interface CollectResult {
  sources: SourcePayload[];
  /** Names that could not be read as text. */
  skipped: string[];
  /** Selected sources never read because the core's budget was already full (they would be dropped anyway). */
  notRead: number;
  /** Sources whose text was cut to the per-source cap before sending. */
  clipped: number;
  chars: number;
}

/**
 * Reads the selection in send order, `READ_CONCURRENCY` at a time. Stops reading once the sources read so far already
 * fill the core's budget the way its prefix rule counts it (heading + at least MIN_SOURCE_CONTENT each), or the request
 * would exceed the body cap: the rest would be left out by the core anyway, so they are reported as `notRead`.
 */
export async function collectSources(items: readonly SourceItem[], readers: SourceReaders, signal: AbortSignal, onProgress?: (p: CollectProgress) => void): Promise<CollectResult> {
  const ordered = sendOrder(items);
  const sources: SourcePayload[] = [];
  const skipped: string[] = [];
  let clipped = 0;
  let chars = 0;
  let need = 0;
  let done = 0;
  let notRead = 0;
  const readOne = async (it: SourceItem): Promise<{ it: SourceItem; text: string | null; cut: boolean }> => {
    if (it.kind === "paste") return { it, text: (it.text ?? "").slice(0, MAX_SOURCE_CONTENT), cut: (it.text ?? "").length > MAX_SOURCE_CONTENT };
    try {
      const r = it.kind === "file" ? await readers.file(it.rel, READ_BYTES, signal) : await readers.note(it.rel, READ_BYTES, signal);
      if (r.text === null) return { it, text: null, cut: false };
      return { it, text: r.text.slice(0, MAX_SOURCE_CONTENT), cut: r.truncated || r.text.length > MAX_SOURCE_CONTENT };
    } catch (e) {
      if (signal.aborted) throw e;
      return { it, text: null, cut: false };
    }
  };
  let i = 0;
  while (i < ordered.length) {
    if (signal.aborted) throw abortError();
    const batch = ordered.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.all(batch.map(readOne));
    if (signal.aborted) throw abortError();
    i += batch.length;
    let full = false;
    for (const r of results) {
      done += 1;
      if (full) {
        notRead += 1;
        continue;
      }
      if (r.text === null || r.text.trim() === "") {
        skipped.push(r.it.name);
        continue;
      }
      const step = `### ${r.it.name}\n`.length + Math.min(MIN_SOURCE_CONTENT, r.text.length) + (sources.length > 0 ? 2 : 0);
      if (need + step > MAX_TOTAL_SOURCE_CHARS || chars + r.text.length + r.it.name.length > MAX_BODY_CHARS) {
        full = true;
        notRead += 1;
        continue;
      }
      need += step;
      chars += r.text.length + r.it.name.length;
      if (r.cut) clipped += 1;
      sources.push({ name: r.it.name, content: r.text });
    }
    onProgress?.({ done, total: ordered.length, chars });
    if (full) {
      notRead += ordered.length - i;
      break;
    }
  }
  return { sources, skipped, notRead, clipped, chars };
}

function abortError(): Error {
  return Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
}
