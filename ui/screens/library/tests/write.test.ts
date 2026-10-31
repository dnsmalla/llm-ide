import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost, meetingText, settle } from "./fake-host.ts";
import { FakeWriteHost } from "./fake-write-host.ts";
import { LibraryStore } from "../library-store.ts";
import { bulkDelete, bulkMessage, bulkTag, confirmMatches, deletePhrase, needsTypedConfirm, previewNames, type BulkProgress } from "../write/bulk.ts";
import { WriteQueue } from "../write/write-queue.ts";
import { createWriteHost, decodeOutcomes, decodeSaved, toWriteError, WriteError, writeErrorText } from "../write/write-host.ts";
import { readKey } from "../write/frontmatter-edit.ts";

const never = new AbortController().signal;

test("error mapping: host strings become codes, unknown things become io, messages never echo the detail", () => {
  assert.equal(toWriteError("conflict: the file changed on disk since it was opened").code, "conflict");
  assert.equal(toWriteError("exists: x").code, "exists");
  assert.equal(toWriteError("trash_unavailable: cannot move to trash: /secret/path").code, "trash_unavailable");
  assert.equal(toWriteError("outside_root: nope").code, "outside_root");
  assert.equal(toWriteError("something odd").code, "io");
  assert.equal(toWriteError(new Error("not available outside the desktop app")).code, "unavailable");
  assert.ok(!writeErrorText("trash_unavailable").includes("/secret"));
  assert.match(writeErrorText("trash_unavailable"), /never deleted permanently/);
  for (const c of ["conflict", "exists", "not_found", "not_note", "not_utf8", "too_large", "hardlink", "not_regular", "outside_root", "io"] as const) assert.ok(writeErrorText(c).length > 10, c);
});

test("host client: argument shapes, decoding and error conversion", async () => {
  const seen: { cmd: string; args: unknown }[] = [];
  const host = createWriteHost(async (cmd, args) => {
    seen.push({ cmd, args });
    if (cmd === "note_open") return { rel: "a.md", text: "t", hash: "h", bom: true, size: 1, mtime_ms: 5 } as never;
    if (cmd === "note_save") throw "conflict: x";
    if (cmd === "notes_delete_many") return [{ rel: "a.md", ok: true, error: null }, { rel: "b.md", ok: false, error: "not_found: b.md" }, { nonsense: 1 }] as never;
    if (cmd === "note_rename") return 7 as never;
    return {} as never;
  });
  assert.deepEqual(await host.open("a.md"), { rel: "a.md", text: "t", hash: "h", bom: true, size: 1, mtimeMs: 5 });
  await assert.rejects(host.save("a.md", "x", false, "h"), (e: WriteError) => e.code === "conflict");
  assert.deepEqual(seen[1], { cmd: "note_save", args: { req: { rel: "a.md", text: "x", bom: false, expected_hash: "h", force: false } } });
  assert.deepEqual(await host.deleteMany(["a.md", "b.md"]), [{ rel: "a.md", ok: true, error: null }, { rel: "b.md", ok: false, error: "not_found" }]);
  await assert.rejects(host.rename("a.md", "b.md"), (e: WriteError) => e.code === "io");
  assert.throws(() => decodeSaved({}), WriteError);
  assert.deepEqual(decodeOutcomes("garbage"), []);
});

test("write queue: same note serial and in order, different notes independent, a failure does not poison", async () => {
  const q = new WriteQueue();
  const log: string[] = [];
  const gate = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const a1 = q.run("a", async () => (await gate(20), log.push("a1")));
  const a2 = q.run("a", async () => {
    log.push("a2");
    throw new Error("boom");
  });
  const a3 = q.run("a", async () => log.push("a3"));
  const b1 = q.run("b", async () => log.push("b1"));
  await b1;
  assert.deepEqual(log, ["b1"], "b does not wait for a");
  await a1;
  await assert.rejects(a2);
  await a3;
  assert.deepEqual(log, ["b1", "a1", "a2", "a3"]);
  await q.idle();
  assert.equal(q.pending, 0);
});

const mk = (n: number, extra = ""): FakeHost => {
  const host = new FakeHost();
  for (let i = 0; i < n; i++) host.add(`source/meetings/2026/10/n${String(i).padStart(4, "0")}.md`, meetingText(i, "meet", extra));
  return host;
};

test("bulk delete: 1,000 notes go in chunks of 100 with monotonic progress, to the trash list only", async () => {
  const host = mk(1000);
  const w = new FakeWriteHost(host);
  const rels = [...host.files.keys()];
  const prog: BulkProgress[] = [];
  const removed: string[] = [];
  const out = await bulkDelete(rels, { host: w, signal: never, onProgress: (p) => prog.push(p), onDeleted: (r) => removed.push(...r) });
  assert.equal(out.phase, "done");
  assert.equal(out.ok, 1000);
  assert.deepEqual(w.deleteBatches, Array(10).fill(100));
  assert.equal(removed.length, 1000);
  assert.equal(w.trash.length, 1000);
  assert.equal(host.files.size, 0);
  const dones = prog.map((p) => p.done);
  assert.deepEqual(dones, [...dones].sort((a, b) => a - b));
  assert.equal(prog[0]!.phase, "running");
  assert.match(bulkMessage(out, "Deleting"), /Finished: 1,000 done/);
});

test("bulk delete: cancel stops between chunks and reports how far it got; failures are isolated and capped", async () => {
  const host = mk(450);
  const w = new FakeWriteHost(host);
  const rels = [...host.files.keys()];
  const ac = new AbortController();
  const out = await bulkDelete(rels, { host: w, signal: ac.signal, onProgress: (p) => { if (p.done >= 200 && !ac.signal.aborted) ac.abort(); }, onDeleted: () => {} });
  assert.equal(out.phase, "cancelled");
  assert.equal(out.done, 200);
  assert.equal(host.files.size, 250);
  assert.match(bulkMessage(out, "Deleting"), /Stopped after 200 of 450/);

  const host2 = mk(300);
  const w2 = new FakeWriteHost(host2);
  const bad = [...host2.files.keys()];
  for (const r of bad.slice(0, 120)) w2.failDelete.add(r);
  const out2 = await bulkDelete(bad, { host: w2, signal: never, onProgress: () => {}, onDeleted: () => {} });
  assert.equal(out2.failed, 120);
  assert.equal(out2.ok, 180);
  assert.equal(out2.errors.length, 50, "reported errors are capped");
  assert.equal(out2.errors[0]!.code, "trash_unavailable");
  // Duplicates are sent once.
  const w3 = new FakeWriteHost(mk(3));
  const o3 = await bulkDelete(["source/meetings/2026/10/n0000.md", "source/meetings/2026/10/n0000.md"], { host: w3, signal: never, onProgress: () => {}, onDeleted: () => {} });
  assert.equal(o3.total, 1);
});

test("bulk delete: a whole-call failure marks the chunk failed and continues", async () => {
  const host = mk(250);
  const w = new FakeWriteHost(host);
  let n = 0;
  const orig = w.deleteMany.bind(w);
  w.deleteMany = async (r) => {
    if (n++ === 1) throw new WriteError("io");
    return orig(r);
  };
  const out = await bulkDelete([...host.files.keys()], { host: w, signal: never, onProgress: () => {}, onDeleted: () => {} });
  assert.equal(out.failed, 100);
  assert.equal(out.ok, 150);
});

test("typed confirmation: required from two notes, exact phrase, previews name what is deleted", () => {
  assert.equal(needsTypedConfirm(1), false);
  assert.equal(needsTypedConfirm(2), true);
  assert.equal(deletePhrase(37), "delete 37 notes");
  assert.equal(confirmMatches(" Delete 37 notes ", 37), true);
  assert.equal(confirmMatches("delete 36 notes", 37), false);
  assert.equal(confirmMatches("", 37), false);
  assert.deepEqual(previewNames(["a", "b", "c"], 2), { shown: ["a", "b"], more: 1 });
});

test("bulk tag: edits headers surgically, skips unchanged, retries a conflict once, saves only changes", async () => {
  const host = mk(30, "x-unknown: keep me\n");
  host.add("source/meetings/2026/10/has.md", meetingText(99, "meet", "tags:\n- Urgent\n"));
  const w = new FakeWriteHost(host);
  const rels = [...host.files.keys()];
  const saved: string[] = [];
  const out = await bulkTag(rels, ["urgent", "Q4"], "add", { host: w, signal: never, onProgress: () => {}, onSaved: (s) => saved.push(s.rel) });
  assert.equal(out.ok, 31);
  assert.equal(out.skipped, 0);
  assert.deepEqual(readKey(host.files.get("source/meetings/2026/10/has.md")!.text, "tags"), ["Urgent", "Q4"]);
  const one = host.files.get("source/meetings/2026/10/n0003.md")!.text;
  assert.deepEqual(readKey(one, "tags"), ["urgent", "Q4"]);
  assert.ok(one.includes("x-unknown: keep me\n") && one.includes("participants:\n- Alice\n- Bob\n"), "other header lines untouched");
  // Second run: everything already tagged -> nothing saved.
  const before = w.calls.save;
  const again = await bulkTag(rels, ["URGENT"], "add", { host: w, signal: never, onProgress: () => {}, onSaved: () => {} });
  assert.equal(again.skipped, 31);
  assert.equal(w.calls.save, before);
  // Remove.
  const rm = await bulkTag(rels, ["urgent", "q4"], "remove", { host: w, signal: never, onProgress: () => {}, onSaved: () => {} });
  assert.equal(rm.ok, 31);
  assert.equal(readKey(host.files.get("source/meetings/2026/10/n0003.md")!.text, "tags"), undefined);
  // Conflict once: retried and succeeds; conflict twice: reported.
  const k = "source/meetings/2026/10/n0001.md";
  w.failSave.set(k, new WriteError("conflict"));
  const r1 = await bulkTag([k], ["z"], "add", { host: w, signal: never, onProgress: () => {}, onSaved: () => {} });
  assert.equal(r1.ok, 1);
  const k2 = "source/meetings/2026/10/n0002.md";
  const origSave = w.save.bind(w);
  w.save = async (...a) => {
    if (a[0] === k2) throw new WriteError("conflict");
    return origSave(...a);
  };
  const r2 = await bulkTag([k2], ["z"], "add", { host: w, signal: never, onProgress: () => {}, onSaved: () => {} });
  assert.deepEqual(r2.errors, [{ rel: k2, code: "conflict" }]);
});

test("bulk tag: cancel stops workers promptly", async () => {
  const host = mk(100);
  const w = new FakeWriteHost(host);
  const ac = new AbortController();
  const out = await bulkTag([...host.files.keys()], ["t"], "add", { host: w, signal: ac.signal, onProgress: (p) => { if (p.done >= 10) ac.abort(); }, onSaved: () => {}, concurrency: 2 });
  assert.equal(out.phase, "cancelled");
  assert.ok(out.done >= 10 && out.done < 20, String(out.done));
});

test("store: writes update the list incrementally, with no folder rescan", async () => {
  const host = mk(5);
  const store = new LibraryStore({ host, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await store.init();
  await settle(store);
  const listCalls = host.calls.list;
  const rel = "source/meetings/2026/10/n0001.md";
  store.select(rel);
  store.noteWritten({ rel, size: 10, mtimeMs: 9_999 }, meetingText(1).replace("Meeting 1", "Renamed Title"));
  assert.equal(store.record(rel)!.title, "Renamed Title");
  assert.equal(store.record(rel)!.mtimeMs, 9_999);
  const fresh = "source/meetings/2026/10/zz-new.md";
  store.noteWritten({ rel: fresh, size: 5, mtimeMs: 10_000 }, meetingText(7));
  assert.equal(store.getSnapshot().records.length, 6);
  assert.equal(store.getSnapshot().listing.loaded, 6);
  store.noteRenamed(rel, { rel: "source/meetings/2026/10/moved.md", size: 10, mtimeMs: 9_999 });
  assert.equal(store.getSnapshot().selectedRel, "source/meetings/2026/10/moved.md");
  assert.equal(store.record(rel), undefined);
  assert.equal(store.record("source/meetings/2026/10/moved.md")!.title, "Renamed Title", "head facts survive a rename");
  store.noteRemoved(["source/meetings/2026/10/moved.md", "nope.md"]);
  assert.equal(store.getSnapshot().selectedRel, null);
  assert.equal(store.getSnapshot().records.length, 5);
  store.noteRemoved(["nope.md"]);
  assert.equal(host.calls.list, listCalls, "no rescan");
  assert.equal(store.getSnapshot().listing.phase, "done");
  store.dispose();
});
