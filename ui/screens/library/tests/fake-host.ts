import { NotesError, type ListPage, type NoteHeadResult, type NotesHost, type NotesRoot, type ReadChunk } from "../host.ts";

export interface FakeFile {
  text: string;
  mtimeMs?: number;
  placeholder?: boolean;
}

/** An in-memory notes folder with the host's paging, head and chunked-read behaviour. */
export class FakeHost implements NotesHost {
  files = new Map<string, FakeFile>();
  root: NotesRoot | null = { name: "notes", root: "/Users/x/notes" };
  chosen: NotesRoot | null = { name: "picked", root: "/Users/x/picked" };
  calls = { list: 0, heads: 0, read: 0, headFiles: 0 };
  failList: NotesError | null = null;
  failHeads = false;
  headDelay: () => Promise<void> = async () => {};
  chunk = 256 * 1024;

  add(rel: string, text: string, extra: Partial<FakeFile> = {}): void {
    this.files.set(rel, { text, mtimeMs: 1_000, ...extra });
  }

  async rootGet(): Promise<NotesRoot | null> {
    return this.root;
  }
  async rootChoose(): Promise<NotesRoot | null> {
    this.root = this.chosen;
    return this.chosen;
  }
  async rootClear(): Promise<void> {
    this.root = null;
  }
  async list(cursor: string | null, limit: number): Promise<ListPage> {
    this.calls.list += 1;
    if (this.failList) throw this.failList;
    const rels = [...this.files.keys()].sort();
    const from = cursor === null ? 0 : rels.findIndex((r) => r > cursor);
    const slice = from < 0 ? [] : rels.slice(from, from + limit);
    const end = from >= 0 && from + limit < rels.length;
    return {
      entries: slice.map((rel) => {
        const f = this.files.get(rel)!;
        return { rel, size: new TextEncoder().encode(f.text).length, mtimeMs: f.mtimeMs ?? 0, placeholder: f.placeholder === true };
      }),
      nextCursor: end ? slice[slice.length - 1]! : null,
      visited: slice.length,
    };
  }
  async read(rel: string, offset: number, maxBytes: number): Promise<ReadChunk> {
    this.calls.read += 1;
    const f = this.files.get(rel);
    if (!f) throw new NotesError("not_found");
    if (f.placeholder) throw new NotesError("not_downloaded");
    const bytes = new TextEncoder().encode(f.text);
    let end = Math.min(bytes.length, offset + Math.min(maxBytes, this.chunk));
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1; // like the host: never split a character
    const text = new TextDecoder().decode(bytes.slice(offset, end));
    return { rel, size: bytes.length, mtimeMs: f.mtimeMs ?? 0, offset, text, nextOffset: end >= bytes.length ? null : end };
  }
  async heads(rels: string[], maxBytes: number): Promise<NoteHeadResult[]> {
    this.calls.heads += 1;
    this.calls.headFiles += rels.length;
    await this.headDelay();
    if (this.failHeads) throw new NotesError("io");
    return rels.map((rel) => {
      const f = this.files.get(rel);
      if (!f) return { rel, size: 0, mtimeMs: 0, head: null, error: "not_found" as const };
      if (f.placeholder) return { rel, size: 0, mtimeMs: 0, head: null, error: "not_downloaded" as const };
      return { rel, size: f.text.length, mtimeMs: f.mtimeMs ?? 0, head: f.text.slice(0, maxBytes), error: null };
    });
  }
}

export const meetingText = (i: number, platform = "meet", extra = ""): string =>
  `---\nid: m${i}\ntitle: Meeting ${i}\nstarted_at: '2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z'\nparticipants:\n- Alice\n- Bob\nplatform: ${platform}\nlanguage: en\ntldr: []\n${extra}---\n\n## Transcript\n\n[10:00:01] **Alice**: hello ${i}\n`;

export const settle = async (store: { getSnapshot(): { listing: { phase: string }; heads: { done: number; total: number } } }, timeoutMs = 20_000): Promise<void> => {
  const t0 = Date.now();
  for (;;) {
    const s = store.getSnapshot();
    if (s.listing.phase === "done" && s.heads.done >= s.heads.total) return;
    if (s.listing.phase === "error") return;
    if (Date.now() - t0 > timeoutMs) throw new Error("store did not settle");
    await new Promise((r) => setTimeout(r, 1));
  }
};
