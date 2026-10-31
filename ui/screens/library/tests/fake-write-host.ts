import { createHash } from "node:crypto";
import { WriteError, type DeleteOutcome, type OpenedNote, type SavedNote, type WriteHost } from "../write/write-host.ts";
import type { FakeHost } from "./fake-host.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** In-memory write host sharing the files of a FakeHost: CAS saves, never-overwrite create, trash list. */
export class FakeWriteHost implements WriteHost {
  trash: string[] = [];
  calls = { open: 0, save: 0, create: 0, rename: 0, delete: 0 };
  /** Make the next save of this path fail with this code. */
  failSave = new Map<string, WriteError>();
  /** Paths whose delete fails. */
  failDelete = new Set<string>();
  deleteBatches: number[] = [];
  private clock = 2_000;
  readonly fake: FakeHost;
  constructor(fake: FakeHost) {
    this.fake = fake;
  }

  private entry(rel: string): { text: string; mtimeMs: number } {
    const f = this.fake.files.get(rel);
    if (!f) throw new WriteError("not_found");
    return { text: f.text, mtimeMs: f.mtimeMs ?? 0 };
  }
  async open(rel: string): Promise<OpenedNote> {
    this.calls.open += 1;
    const f = this.entry(rel);
    return { rel, text: f.text, hash: sha(f.text), bom: false, size: new TextEncoder().encode(f.text).length, mtimeMs: f.mtimeMs };
  }
  async save(rel: string, text: string, _bom: boolean, expectedHash: string, force = false): Promise<SavedNote> {
    this.calls.save += 1;
    const fail = this.failSave.get(rel);
    if (fail) {
      this.failSave.delete(rel);
      throw fail;
    }
    const f = this.entry(rel);
    if (!force && sha(f.text) !== expectedHash) throw new WriteError("conflict");
    this.clock += 1;
    this.fake.files.set(rel, { text, mtimeMs: this.clock });
    return { rel, hash: sha(text), size: new TextEncoder().encode(text).length, mtimeMs: this.clock };
  }
  async create(rel: string, text: string): Promise<SavedNote> {
    this.calls.create += 1;
    if (this.fake.files.has(rel)) throw new WriteError("exists");
    this.clock += 1;
    this.fake.files.set(rel, { text, mtimeMs: this.clock });
    return { rel, hash: sha(text), size: new TextEncoder().encode(text).length, mtimeMs: this.clock };
  }
  async rename(from: string, to: string): Promise<string> {
    this.calls.rename += 1;
    const f = this.entry(from);
    if (this.fake.files.has(to)) throw new WriteError("exists");
    this.fake.files.delete(from);
    this.fake.files.set(to, { text: f.text, mtimeMs: f.mtimeMs });
    return to;
  }
  async deleteMany(rels: string[]): Promise<DeleteOutcome[]> {
    this.calls.delete += 1;
    this.deleteBatches.push(rels.length);
    return rels.map((rel) => {
      if (this.failDelete.has(rel)) return { rel, ok: false, error: "trash_unavailable" as const };
      if (!this.fake.files.has(rel)) return { rel, ok: false, error: "not_found" as const };
      this.fake.files.delete(rel);
      this.trash.push(rel);
      return { rel, ok: true, error: null };
    });
  }
}
