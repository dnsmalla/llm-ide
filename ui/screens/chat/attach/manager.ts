// AttachmentManager: the composer's attachment state machine. Files come from the host's native dialog (opaque
// handles, no paths), from project mentions (project-relative paths read through the host's root-confined fs) and
// from notes. Everything is read eagerly into memory under the core's caps, then the host handle is released at
// once (also on remove, cancel, failure and dispose), so no descriptor outlives the pick. Pure TypeScript with
// injected seams, tested with a fake host.
//
// What the core accepts (extension/core/prompt-framing.mjs): `attachments: [{ path, content }]`. Text is inline.
// Images are `content: "[binary:<mime>]\n<base64>"` (png/jpeg/gif/webp). Chunked UPLOAD is not part of the
// contract: the core takes everything in the request body, so large files are read in 4 MiB chunks here and sent
// capped; what the core would cut anyway (80k characters per text file) is never read or sent.
import { decodeText, imageContent, safeFileName, sniffImage } from "./codec";
import {
  HOST_CHUNK_BYTES, HOST_FILE_MAX_BYTES, MAX_ATTACHMENTS, MAX_IMAGES, MAX_IMAGE_BASE64_CHARS, MAX_IMAGES_TOTAL_BASE64_CHARS, MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS_PER_FILE, MAX_TEXT_CHARS_TOTAL, TEXT_READ_BYTES,
} from "./limits";

export interface PickedFile { handle: string; name: string; size: number; mime: string }
export interface PickResult { files: PickedFile[]; rejected: Array<{ name: string; reason: string }> }

export interface AttachHost {
  /** Native multi-file dialog. An empty result means cancelled. */
  pick(): Promise<PickResult>;
  /** At most HOST_CHUNK_BYTES raw bytes at an offset. */
  read(handle: string, offset: number, len: number): Promise<Uint8Array>;
  release(handle: string): void | Promise<void>;
}

/** Root-confined project reads (the host's fs commands); `path` is project-relative. */
export interface ProjectReader {
  readHead(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean; binary: boolean }>;
}

export interface BlobUrls { create(bytes: Uint8Array, mime: string): string; revoke(url: string): void }

export type AttachStatus = "reading" | "ready" | "error";
export interface AttachmentItem {
  id: string;
  /** What the user sees and the core receives as `path`: a file name, a project-relative path, or `note: title`. */
  label: string;
  source: "file" | "project" | "note";
  kind: "text" | "image";
  status: AttachStatus;
  /** 0..1 while reading. */
  progress: number;
  size: number;
  /** Text was cut to the core's per-file or per-turn cap. */
  truncated: boolean;
  error: string | null;
  previewUrl: string | null;
  chars: number;
}

export interface WireAttachment { path: string; content: string }

export const REJECT_REASONS: Record<string, string> = {
  not_regular: "is not a regular file",
  too_large: "is larger than 25 MB",
  total_limit: "would exceed the 100 MB attachment limit",
  too_many: "was skipped (at most 20 files per pick)",
  unreadable: "cannot be read",
  rate_limited: "was refused (too many picks, try again in a moment)",
};

interface Entry {
  item: AttachmentItem;
  content: string | null;
  base64Chars: number;
  ac: AbortController;
  handle: string | null;
  removed: boolean;
}

export interface ManagerDeps {
  host: AttachHost | null;
  project?: ProjectReader | null;
  blobs?: BlobUrls | null;
  newId?: () => string;
}

let counter = 0;
const defaultId = () => `att${++counter}`;

export class AttachmentManager {
  private entries: Entry[] = [];
  private snapshot: readonly AttachmentItem[] = [];
  private readonly subs = new Set<() => void>();
  private notices: string[] = [];
  private disposed = false;

  constructor(private readonly deps: ManagerDeps) {}

  subscribe = (fn: () => void): (() => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getItems = (): readonly AttachmentItem[] => this.snapshot;
  /** Messages about refused files (names only, never paths); cleared by `dismissNotices`. */
  getNotices = (): readonly string[] => this.notices;
  dismissNotices(): void { if (this.notices.length) { this.notices = []; this.emit(); } }
  get canPick(): boolean { return this.deps.host !== null; }
  /** Sending must wait while a read is still running. */
  isBusy(): boolean { return this.entries.some((e) => e.item.status === "reading"); }
  hasAny(): boolean { return this.entries.length > 0; }

  private emit(): void {
    this.snapshot = this.entries.map((e) => e.item);
    for (const f of [...this.subs]) f();
  }
  private notice(msg: string): void { if (this.notices.length < 5) this.notices = [...this.notices, msg]; }
  private patch(e: Entry, p: Partial<AttachmentItem>): void { e.item = { ...e.item, ...p }; this.emit(); }

  private uniqueLabel(raw: string): string {
    const taken = new Set(this.entries.map((e) => e.item.label));
    if (!taken.has(raw)) return raw;
    const dot = raw.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [raw.slice(0, dot), raw.slice(dot)] : [raw, ""];
    for (let n = 2; n < 1000; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
    return `${stem} (${Date.now()})${ext}`;
  }

  private add(label: string, source: AttachmentItem["source"], size: number): Entry | null {
    if (this.disposed) return null;
    if (this.entries.length >= MAX_ATTACHMENTS) { this.notice(`At most ${MAX_ATTACHMENTS} attachments per message.`); return null; }
    const item: AttachmentItem = {
      id: (this.deps.newId ?? defaultId)(), label: this.uniqueLabel(label), source, kind: "text", status: "reading", progress: 0, size,
      truncated: false, error: null, previewUrl: null, chars: 0,
    };
    const e: Entry = { item, content: null, base64Chars: 0, ac: new AbortController(), handle: null, removed: false };
    this.entries.push(e);
    this.emit();
    return e;
  }

  private textBudgetLeft(): number {
    return MAX_TEXT_CHARS_TOTAL - this.entries.reduce((n, e) => n + (e.item.kind === "text" && e.item.status === "ready" ? e.item.chars : 0), 0);
  }

  private fail(e: Entry, error: string): void {
    e.content = null;
    this.patch(e, { status: "error", error, progress: 0 });
  }

  /** Clamps text to the core's per-file and per-turn caps without splitting a surrogate pair. */
  private finishText(e: Entry, text: string, alreadyCut: boolean): void {
    const left = this.textBudgetLeft();
    if (left <= 0) return this.fail(e, `The ${MAX_TEXT_CHARS_TOTAL.toLocaleString("en-US")}-character attachment budget for one message is used up.`);
    const cap = Math.min(MAX_TEXT_CHARS_PER_FILE, left);
    let out = text, cut = alreadyCut;
    if (out.length > cap) {
      let end = cap;
      const c = out.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end--; // do not end on a lone high surrogate
      out = out.slice(0, end);
      cut = true;
    }
    if (out.trim() === "") return this.fail(e, "The file is empty.");
    e.content = out;
    this.patch(e, { status: "ready", progress: 1, chars: out.length, truncated: cut, kind: "text" });
  }

  // --- sources -------------------------------------------------------------------------------

  /** Native dialog, then read every accepted file. Resolves when all reads finished. */
  async pickFiles(): Promise<void> {
    const host = this.deps.host;
    if (!host || this.disposed) return;
    let res: PickResult;
    try { res = await host.pick(); } catch { this.notice("The file dialog could not be opened."); this.emit(); return; }
    for (const r of res.rejected) this.notice(`${safeFileName(r.name)} ${REJECT_REASONS[r.reason] ?? "was refused"}.`);
    const entries: Array<[Entry, PickedFile]> = [];
    for (const f of res.files) {
      const e = this.add(safeFileName(f.name), "file", f.size);
      if (!e) { try { void host.release(f.handle); } catch { /* best effort */ } continue; }
      e.handle = f.handle;
      entries.push([e, f]);
    }
    if (res.rejected.length) this.emit();
    for (const [e, f] of entries) await this.readPicked(e, f);
  }

  private async readPicked(e: Entry, f: PickedFile): Promise<void> {
    const host = this.deps.host!;
    try {
      if (!Number.isFinite(f.size) || f.size <= 0) return this.fail(e, "The file is empty.");
      if (f.size > HOST_FILE_MAX_BYTES) return this.fail(e, "The file is larger than 25 MB.");
      // The first read is just enough for text (and to sniff an image); an image continues in 4 MiB chunks.
      const first = await this.readChunk(e, host, f.handle, 0, Math.min(f.size, TEXT_READ_BYTES));
      if (!first) return;
      const sniffed = sniffImage(first);
      if (sniffed) return await this.readImage(e, host, f, first, sniffed);
      if (f.mime.startsWith("image/") && f.mime !== "image/svg+xml") return this.fail(e, "Not a supported image (png, jpeg, gif, webp).");
      const head = first.length > TEXT_READ_BYTES ? first.subarray(0, TEXT_READ_BYTES) : first;
      const dec = decodeText(head, f.size > head.length);
      if (!dec.ok) return this.fail(e, dec.reason === "binary" ? "Binary files can't be attached (text and images only)." : "The file is not UTF-8 text.");
      this.finishText(e, dec.text, f.size > head.length);
    } catch {
      if (!e.removed) this.fail(e, "The file could not be read.");
    } finally {
      this.releaseHandle(e);
    }
  }

  private async readChunk(e: Entry, host: AttachHost, handle: string, offset: number, len: number): Promise<Uint8Array | null> {
    if (e.ac.signal.aborted || e.removed) return null;
    const bytes = await host.read(handle, offset, len);
    if (e.ac.signal.aborted || e.removed) return null;
    return bytes;
  }

  private async readImage(e: Entry, host: AttachHost, f: PickedFile, first: Uint8Array, mime: string): Promise<void> {
    if (f.size > MAX_IMAGE_BYTES) return this.fail(e, "The image is larger than the 4.5 MB the model accepts.");
    const images = this.entries.filter((x) => x !== e && x.item.kind === "image" && x.item.status !== "error");
    if (images.length >= MAX_IMAGES) return this.fail(e, `At most ${MAX_IMAGES} images per message.`);
    const out = new Uint8Array(f.size);
    out.set(first, 0);
    let off = first.length;
    this.patch(e, { kind: "image", progress: off / f.size });
    while (off < f.size) {
      const chunk = await this.readChunk(e, host, f.handle, off, Math.min(HOST_CHUNK_BYTES, f.size - off));
      if (!chunk) return;
      if (chunk.length === 0 || off + chunk.length > f.size) return this.fail(e, "The file changed while it was being read.");
      out.set(chunk, off);
      off += chunk.length;
      this.patch(e, { progress: off / f.size });
    }
    const content = imageContent(mime, out);
    const b64 = content.length - content.indexOf("\n") - 1;
    const used = this.entries.reduce((n, x) => n + (x !== e ? x.base64Chars : 0), 0);
    if (b64 > MAX_IMAGE_BASE64_CHARS || used + b64 > MAX_IMAGES_TOTAL_BASE64_CHARS) return this.fail(e, "The images in this message are too large in total.");
    e.content = content;
    e.base64Chars = b64;
    let previewUrl: string | null = null;
    try { previewUrl = this.deps.blobs ? this.deps.blobs.create(out, mime) : null; } catch { previewUrl = null; }
    this.patch(e, { status: "ready", progress: 1, kind: "image", previewUrl });
  }

  /** A file of the open project, by project-relative path (the caller has already confined it). */
  async addProjectFile(path: string): Promise<void> {
    const reader = this.deps.project;
    if (!reader || this.disposed) { this.notice("Project files need an open project."); this.emit(); return; }
    const e = this.add(path, "project", 0);
    if (!e) { this.emit(); return; }
    try {
      const r = await reader.readHead(path, TEXT_READ_BYTES);
      if (e.removed) return;
      if (r.binary) return this.fail(e, "Binary files can't be attached (text and images only).");
      this.finishText(e, r.text, r.truncated);
    } catch {
      if (!e.removed) this.fail(e, "The file could not be read.");
    }
  }

  /** A note excerpt: text only, `note: <title>` as its label. */
  addNote(label: string, content: string): void {
    const e = this.add(`note: ${label}`.slice(0, 120), "note", content.length);
    if (e) this.finishText(e, content, false);
  }

  // --- lifecycle -----------------------------------------------------------------------------

  private releaseHandle(e: Entry): void {
    const h = e.handle;
    if (h === null) return;
    e.handle = null;
    try { const r = this.deps.host?.release(h); if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined); } catch { /* released by TTL */ }
  }

  private drop(e: Entry): void {
    e.removed = true;
    e.ac.abort();
    this.releaseHandle(e);
    if (e.item.previewUrl) { try { this.deps.blobs?.revoke(e.item.previewUrl); } catch { /* ignore */ } }
    e.content = null;
  }

  remove(id: string): void {
    const i = this.entries.findIndex((e) => e.item.id === id);
    if (i < 0) return;
    this.drop(this.entries[i]);
    this.entries.splice(i, 1);
    this.emit();
  }

  /** Cancels running reads and discards everything (chat switch, Escape on the chip row). */
  clear(): void {
    for (const e of this.entries) this.drop(e);
    this.entries = [];
    this.notices = [];
    this.emit();
  }

  /** The ready attachments for the outgoing turn; clears the rest (handles released, blob URLs revoked). */
  consume(): WireAttachment[] {
    const out = this.entries.filter((e) => e.item.status === "ready" && e.content !== null).map((e) => ({ path: e.item.label, content: e.content as string }));
    this.clear();
    return out;
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.subs.clear();
  }
}

/** The browser blob seam (object URLs are revoked on remove, clear and unmount). */
export const browserBlobs: BlobUrls = {
  create: (bytes, mime) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
  revoke: (url) => URL.revokeObjectURL(url),
};
