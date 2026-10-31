process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyHead, recordFromEntry, type NoteRecord } from "../notes-model.ts";
import { batchUpserts, BATCH_NOTES, IDLE_REBUILD, indexable, kindOf, MAX_REBUILD_NOTES, makeUpsertInput, rebuildIndex, rebuildMessage, readWhole, SCAN_CHUNK_ENTRIES, type IndexCore, type IndexNoteInput, type RebuildProgress } from "../index-rebuild.ts";
import { FakeHost, meetingText } from "./fake-host.ts";

const sha = async (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function records(host: FakeHost): Promise<NoteRecord[]> {
  const out: NoteRecord[] = [];
  for (const [rel, f] of [...host.files.entries()].sort()) {
    const size = new TextEncoder().encode(f.text).length;
    out.push(applyHead(recordFromEntry({ rel, size, mtimeMs: f.mtimeMs ?? 0, placeholder: f.placeholder === true }), f.text.slice(0, 2048)));
  }
  return out;
}

/** A core that holds an index and answers /kb/index/scan and /kb/index/notes like the real one. */
function fakeCore(held: Record<string, string> = {}) {
  const log: { path: string; body: any }[] = [];
  const upserted: IndexNoteInput[] = [];
  let status = 200;
  const core: IndexCore = {
    async request(_m, path, body) {
      log.push({ path, body });
      if (status !== 200) return { status, body: {} };
      if (path === "/kb/index/scan") {
        const b = body as { entries: { noteKey: string; contentHash: string }[] };
        const missing = b.entries.filter((e) => !(e.noteKey in held)).map((e) => e.noteKey);
        const stale = b.entries.filter((e) => e.noteKey in held && held[e.noteKey] !== e.contentHash).map((e) => e.noteKey);
        return { status: 200, body: { missing, stale, extra: [], pruned: 0 } };
      }
      const b = body as { notes: IndexNoteInput[] };
      for (const n of b.notes) {
        upserted.push(n);
        held[n.noteKey] = n.contentHash;
      }
      return { status: 200, body: { upserted: b.notes.length } };
    },
  };
  return { core, log, upserted, held, setStatus: (s: number) => (status = s) };
}

const run = (host: FakeHost, recs: NoteRecord[], core: IndexCore, signal = new AbortController().signal) => {
  const progress: RebuildProgress[] = [];
  return rebuildIndex(recs, { host, core, sha256Hex: sha, newScanId: () => "scan-test-0001" }, (p) => progress.push(p), signal).then((final) => ({ final, progress }));
};

test("rebuild uploads the notes the core lacks (every kind), never prunes, and reports progress", async () => {
  const host = new FakeHost();
  host.add("source/meetings/a.md", meetingText(1));
  host.add("source/meetings/b.md", meetingText(2));
  host.add("source/meetings/s.md", meetingText(3, "slack"));
  host.add("llm-doc/meetings/g.md", "---\ntitle: g\nplatform: meet\n---\n");
  host.add("raw.txt", "text");
  host.add("icloud.md", "", { placeholder: true });
  const recs = await records(host);
  const bText = host.files.get("source/meetings/b.md")!.text;
  const c = fakeCore({ "source/meetings/b.md": createHash("sha256").update(bText).digest("hex") }); // b is already indexed and current
  const { final, progress } = await run(host, recs, c.core);
  assert.equal(final.phase, "done");
  assert.equal(final.total, 4, "a, b, the slack note and the generated doc are indexable; raw.txt and the iCloud stub are not");
  assert.equal(final.missing, 3);
  assert.equal(final.stale, 0);
  assert.equal(final.uploaded, 3);
  const byKey = new Map(c.upserted.map((n) => [n.noteKey, n]));
  assert.deepEqual([...byKey.keys()].sort(), ["llm-doc/meetings/g.md", "source/meetings/a.md", "source/meetings/s.md"]);
  const a = byKey.get("source/meetings/a.md")!;
  assert.equal(a.kind, "meeting");
  assert.equal(a.title, "Meeting 1");
  assert.deepEqual(a.participants, ["Alice", "Bob"]);
  assert.equal(a.durationSec, 0);
  assert.deepEqual(a.meta, { meetingId: "m1", platform: "meet", language: "en" });
  assert.equal(a.body.trim().startsWith("## Transcript"), true);
  assert.equal(byKey.get("source/meetings/s.md")!.kind, "slack");
  assert.equal(byKey.get("llm-doc/meetings/g.md")!.kind, "document");
  const scan = c.log.filter((l) => l.path === "/kb/index/scan");
  assert.equal(scan.length, 1);
  assert.equal(scan[0]!.body.prune, false, "never prunes");
  assert.equal(scan[0]!.body.complete, true);
  assert.equal(scan[0]!.body.totalEntries, 4);
  assert.equal(scan[0]!.body.scanId, "scan-test-0001");
  assert.ok(!("projectId" in scan[0]!.body));
  assert.deepEqual(progress.map((p) => p.phase).filter((p, i, a) => a.indexOf(p) === i), ["reading", "scanning", "uploading", "done"]);
  assert.equal(final.skipped, 2);
  assert.equal(final.leftOut, 0);
  assert.match(rebuildMessage(final), /3 notes uploaded/);
  // Idempotent: a second run uploads nothing.
  const again = await run(host, recs, c.core);
  assert.equal(again.final.uploaded, 0);
  assert.match(rebuildMessage(again.final), /up to date/);
});

test("stale notes (content changed) are re-uploaded", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  const recs = await records(host);
  const c = fakeCore({ "a.md": "0".repeat(64) });
  const { final } = await run(host, recs, c.core);
  assert.equal(final.stale, 1);
  assert.equal(final.uploaded, 1);
});

test("scan is chunked at 500 entries; only the last chunk is complete; every chunk shares the scan id", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 1203; i++) host.add(`m/n${String(i).padStart(5, "0")}.md`, meetingText(i));
  const recs = await records(host);
  const c = fakeCore(Object.fromEntries([...host.files.keys()].map((k) => [k, createHash("sha256").update(host.files.get(k)!.text).digest("hex")])));
  const { final } = await run(host, recs, c.core);
  const scans = c.log.filter((l) => l.path === "/kb/index/scan").map((l) => l.body);
  assert.deepEqual(scans.map((s) => [s.index, s.total, s.complete, s.entries.length]), [[0, 3, false, 500], [1, 3, false, 500], [2, 3, true, 203]]);
  assert.equal(scans[2].totalEntries, 1203);
  assert.ok(scans.every((s) => s.scanId === "scan-test-0001" && s.prune === false));
  assert.equal(final.uploaded, 0);
  assert.equal(final.chunksTotal, 3);
  assert.equal(SCAN_CHUNK_ENTRIES, 500);
});

test("a file that changes between hashing and upload is skipped, not uploaded with a wrong hash", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  const recs = await records(host);
  const c = fakeCore();
  const inner = c.core.request.bind(c.core);
  c.core.request = async (m, p, b, s) => {
    if (p === "/kb/index/scan") host.files.get("a.md")!.text += "\nedited during the rebuild\n";
    return inner(m, p, b, s);
  };
  const { final } = await run(host, recs, c.core);
  assert.equal(final.phase, "done");
  assert.equal(final.uploaded, 0);
  assert.ok(final.skipped >= 1);
});

test("errors: 404 -> unavailable, 401 -> unauthorized, 500 -> failed; transport failure -> failed", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  const recs = await records(host);
  for (const [status, error] of [[404, "unavailable"], [401, "unauthorized"], [500, "failed"]] as const) {
    const c = fakeCore();
    c.setStatus(status);
    const { final } = await run(host, recs, c.core);
    assert.equal(final.phase, "error");
    assert.equal(final.error, error);
    assert.ok(rebuildMessage(final).length > 10);
  }
  const down: IndexCore = { request: async () => { throw new Error("ECONNREFUSED"); } };
  assert.equal((await run(host, recs, down)).final.error, "failed");
});

test("cancel mid-way: stops, reports cancelled, uploads nothing more", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 50; i++) host.add(`m/n${i}.md`, meetingText(i));
  const recs = await records(host);
  const ac = new AbortController();
  let reads = 0;
  const orig = host.read.bind(host);
  host.read = async (...a) => {
    if (++reads === 10) ac.abort();
    return orig(...a);
  };
  const c = fakeCore();
  const { final } = await run(host, recs, c.core, ac.signal);
  assert.equal(final.phase, "cancelled");
  assert.equal(c.upserted.length, 0);
  assert.ok(c.log.length === 0, "the abort happened before the scan");
  assert.match(rebuildMessage(final), /Nothing was removed/);
});

test("batching respects the note and byte limits; oversize notes are dropped and counted", () => {
  const note = (i: number, body: string): IndexNoteInput => ({ noteKey: `n${i}.md`, kind: "meeting", title: "t", date: "d", durationSec: 0, participants: [], body, contentHash: "h", mtimeMs: 0, meta: { meetingId: "", platform: "", language: "" } });
  const many = Array.from({ length: 120 }, (_, i) => note(i, "x"));
  assert.deepEqual(batchUpserts(many).batches.map((b) => b.length), [BATCH_NOTES, BATCH_NOTES, 20]);
  const big = [note(1, "x".repeat(400_000)), note(2, "x".repeat(400_000)), note(3, "x".repeat(400_000)), note(4, "x".repeat(1_000_000))];
  const r = batchUpserts(big);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.batches.map((b) => b.length), [2, 1]);
});

test("makeUpsertInput: needs title and started_at; clips; keeps the body after the header", () => {
  const ok = makeUpsertInput("a.md", meetingText(3, "meet", "duration_seconds: 90\n"), "h", 1234.9)!;
  assert.equal(ok.durationSec, 90);
  assert.equal(ok.mtimeMs, 1234);
  assert.equal(ok.date, "2026-10-04T10:00:00.000Z");
  assert.equal(makeUpsertInput("a.md", "---\ntitle: x\n---\nb", "h", 0), null);
  assert.equal(makeUpsertInput("a.md", "no frontmatter", "h", 0), null);
  const long = makeUpsertInput("a.md", `---\ntitle: ${"t".repeat(900)}\nstarted_at: '2026-10-01T10:00:00Z'\nparticipants: [${Array.from({ length: 300 }, (_, i) => `p${i}`).join(", ")}]\n---\nb`, "h", 0)!;
  assert.equal(long.title.length, 500);
  assert.equal(long.participants.length, 200);
});

test("indexable: readable Markdown under the size cap, not hidden, not in iCloud; a meeting needs frontmatter", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  host.add("b.md", meetingText(2, "slack"));
  host.add("c.md", "# a plain note, no frontmatter");
  host.add("d.txt", meetingText(3));
  host.add("llm-doc/plans/e.md", "# plan");
  host.add("f.md", "", { placeholder: true });
  host.add(".git/notes.md", "# hidden dir");
  host.add("src/.secret.md", "# hidden file");
  host.add("source/meetings/nofm.md", "no frontmatter but in the meetings dir");
  const recs = await records(host);
  const { keep, skipped, leftOut } = indexable(recs);
  assert.deepEqual(keep.map((r) => r.rel).sort(), ["a.md", "b.md", "c.md", "llm-doc/plans/e.md"]);
  assert.equal(skipped, 5);
  assert.equal(leftOut, 0);
});

test("kinds follow the Library classification and non-meeting notes need no frontmatter", async () => {
  const host = new FakeHost();
  host.add("notes/idea.md", "# Big idea\n\nSearch me.");
  host.add("llm-doc/plans/q4.md", "# Q4 plan");
  host.add("llm-doc/guides/how.md", "# How");
  host.add("source/emails/m.md", "---\ntitle: Re: budget\nplatform: email\n---\nbody");
  host.add("source/repos/r.md", "# repo readme");
  host.add("source/misc/x.md", "# other");
  host.add("source/documents/d.md", "# doc");
  const recs = await records(host);
  const kinds = Object.fromEntries(recs.map((r) => [r.rel, kindOf(r)]));
  assert.deepEqual(kinds, { "notes/idea.md": "note", "llm-doc/plans/q4.md": "plan", "llm-doc/guides/how.md": "document", "source/emails/m.md": "email", "source/repos/r.md": "repo", "source/misc/x.md": "other", "source/documents/d.md": "document" });
  const idea = recs.find((r) => r.rel === "notes/idea.md")!;
  const input = makeUpsertInput(idea.rel, host.files.get(idea.rel)!.text, "h", 5000.7, idea)!;
  assert.equal(input.kind, "note");
  assert.equal(input.title, "Big idea");
  assert.match(input.date, /^\d{4}-\d\d-\d\dT/);
  assert.equal(input.mtimeMs, 5000);
  assert.deepEqual(input.meta, { platform: "" });
  const mail = recs.find((r) => r.rel === "source/emails/m.md")!;
  assert.equal(makeUpsertInput(mail.rel, host.files.get(mail.rel)!.text, "h", 1, mail)!.title, "Re: budget");
});

test("more than 50,000 notes: the newest 50,000 are scanned, the rest is counted as left out (no error)", () => {
  const recs: NoteRecord[] = [];
  for (let i = 0; i < MAX_REBUILD_NOTES + 7; i++) recs.push(recordFromEntry({ rel: `n/${String(i).padStart(6, "0")}.md`, size: 10, mtimeMs: i, placeholder: false }));
  const { keep, skipped, leftOut } = indexable(recs);
  assert.equal(keep.length, MAX_REBUILD_NOTES);
  assert.equal(leftOut, 7);
  assert.equal(skipped, 0);
  assert.equal(Math.min(...keep.map((r) => r.mtimeMs)), 7, "the 7 oldest are the ones left out");
  const done = { ...IDLE_REBUILD, phase: "done" as const, uploaded: 3, leftOut: 7 };
  assert.match(rebuildMessage(done), /7 older notes were left out/);
});

test("readWhole reassembles a multi-chunk file and returns null for unreadable or aborted", async () => {
  const host = new FakeHost();
  host.chunk = 4096;
  const text = "あいう\n".repeat(5000);
  host.add("big.md", text);
  host.add("stub.md", "", { placeholder: true });
  const ac = new AbortController();
  assert.equal(await readWhole(host, "big.md", ac.signal), text);
  assert.equal(await readWhole(host, "stub.md", ac.signal), null);
  assert.equal(await readWhole(host, "missing.md", ac.signal), null);
  ac.abort();
  assert.equal(await readWhole(host, "big.md", ac.signal), null);
});
