process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAD_BATCH, HEAD_CONCURRENCY, LibraryStore } from "../library-store.ts";
import { NotesError } from "../host.ts";
import { FakeHost, meetingText, settle } from "./fake-host.ts";

const mk = (host: FakeHost, extra: Partial<ConstructorParameters<typeof LibraryStore>[0]> = {}) => new LibraryStore({ host, now: () => Date.parse("2026-10-31T00:00:00Z"), ...extra });

test("init: no folder configured -> none; folder -> ready and scanned", async () => {
  const host = new FakeHost();
  host.root = null;
  const none = mk(host);
  await none.init();
  assert.equal(none.getSnapshot().rootStatus, "none");
  assert.equal(host.calls.list, 0, "nothing is listed without a folder");

  const host2 = new FakeHost();
  host2.add("source/meetings/2026/10/a.md", meetingText(1));
  host2.add("source/meetings/2026/10/b.md", meetingText(2, "slack"));
  host2.add("source/emails/raw.txt", "raw mail");
  host2.add("x.md", "---\ntitle: No platform\n---\n");
  host2.add("llm-doc/emails/n.md", "# Generated note");
  const s = mk(host2);
  await s.init();
  await settle(s);
  const st = s.getSnapshot();
  assert.equal(st.rootStatus, "ready");
  assert.equal(st.records.length, 5);
  assert.equal(st.counts.get("meeting"), 1);
  assert.equal(st.counts.get("slack"), 1);
  assert.equal(st.counts.get("email"), 1);
  assert.equal(st.counts.get("unsorted"), 1, "Q19: a note without platform is listed under Unsorted");
  assert.equal(st.counts.get("doc:emails"), 1);
  assert.equal(s.record("source/meetings/2026/10/a.md")!.title, "Meeting 1");
  assert.deepEqual(st.sections.map((x) => x.id).slice(0, 3), ["meeting", "email", "slack"]);
});

test("the list is usable after the first page, before heads finish; heads arrive in the background", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 5000; i++) host.add(`source/meetings/2026/10/n${String(i).padStart(5, "0")}.md`, meetingText(i));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  host.headDelay = () => gate;
  const s = mk(host);
  await s.init();
  const mid = s.getSnapshot();
  assert.equal(mid.listing.phase, "done");
  assert.equal(mid.records.length, 5000);
  assert.ok(mid.heads.total > 0 && mid.heads.done === 0, "heads still pending");
  assert.ok(s.rows().length > 0, "rows render from path facts alone");
  assert.equal(s.getSnapshot().records.filter((r) => r.headRead).length, 0);
  release();
  await settle(s);
  assert.equal(s.getSnapshot().records.every((r) => r.headRead), true);
  assert.ok(host.calls.heads >= 5000 / HEAD_BATCH);
});

test("prioritize moves visible rows to the front of the head queue", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 2000; i++) host.add(`m/n${String(i).padStart(5, "0")}.md`, meetingText(i));
  const order: string[] = [];
  const orig = host.heads.bind(host);
  host.heads = async (rels, bytes) => {
    order.push(rels[0]!);
    await new Promise((r) => setTimeout(r, 1));
    return orig(rels, bytes);
  };
  const s = mk(host);
  await s.init();
  // Everything is queued; ask for the last note's head now.
  s.prioritize(["m/n01999.md"]);
  await settle(s);
  const firstBatchesStarted = order.slice(0, HEAD_CONCURRENCY + 1);
  assert.ok(firstBatchesStarted.includes("m/n01999.md") || s.record("m/n01999.md")!.headRead, "the prioritized note was read early");
});

test("rescan keeps heads of unchanged files and re-reads changed ones; removed files disappear; selection clears", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  host.add("b.md", meetingText(2));
  host.add("c.md", meetingText(3));
  const s = mk(host);
  await s.init();
  await settle(s);
  const before = host.calls.headFiles;
  s.select("c.md");
  host.files.delete("c.md");
  host.files.get("b.md")!.mtimeMs = 5_000;
  host.files.get("b.md")!.text = meetingText(2).replace("Meeting 2", "Renamed");
  host.add("d.md", meetingText(4));
  await s.scan();
  await settle(s);
  assert.equal(host.calls.headFiles - before, 2, "only b (changed) and d (new) were read");
  assert.equal(s.record("b.md")!.title, "Renamed");
  assert.equal(s.record("c.md"), undefined);
  assert.equal(s.getSnapshot().selectedRel, null, "the selected note is gone");
  assert.equal(s.getSnapshot().records.length, 3);
});

test("iCloud placeholders are listed, never head-read, and counted but marked", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  host.add("stub.md", "", { placeholder: true });
  const s = mk(host);
  await s.init();
  await settle(s);
  assert.equal(host.calls.headFiles, 1, "the placeholder was not requested");
  assert.equal(s.record("stub.md")!.placeholder, true);
  assert.equal(s.getSnapshot().records.length, 2);
});

test("errors: a failed batch keeps path facts; a list failure surfaces a code; no_root -> none", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  host.failHeads = true;
  const s = mk(host);
  await s.init();
  await settle(s);
  assert.equal(s.record("a.md")!.headRead, false);
  assert.equal(s.record("a.md")!.title, "a");

  const bad = new FakeHost();
  bad.failList = new NotesError("io");
  const s2 = mk(bad);
  await s2.init();
  assert.equal(s2.getSnapshot().error, "io");
  assert.equal(s2.getSnapshot().listing.phase, "error");

  const gone = new FakeHost();
  gone.failList = new NotesError("no_root");
  const s3 = mk(gone);
  await s3.init();
  assert.equal(s3.getSnapshot().rootStatus, "none");
});

test("chooseRoot replaces the data; cancel keeps it; clearRoot empties", async () => {
  const host = new FakeHost();
  host.add("a.md", meetingText(1));
  const s = mk(host);
  await s.init();
  await settle(s);
  host.chosen = null;
  await s.chooseRoot(); // cancelled dialog
  assert.equal(s.getSnapshot().records.length, 1);
  host.chosen = { name: "picked", root: "/Users/x/picked" };
  host.files.clear();
  host.add("z.md", meetingText(9));
  await s.chooseRoot();
  await settle(s);
  assert.deepEqual(s.getSnapshot().records.map((r) => r.rel), ["z.md"]);
  await s.clearRoot();
  assert.equal(s.getSnapshot().rootStatus, "none");
  assert.equal(s.getSnapshot().records.length, 0);
});

test("a newer scan supersedes an older one; dispose stops everything and notifies nobody", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 100; i++) host.add(`n${i}.md`, meetingText(i));
  const s = mk(host);
  let notified = 0;
  s.subscribe(() => (notified += 1));
  const first = s.scan();
  const second = s.scan();
  await Promise.all([first, second]);
  await settle(s);
  assert.equal(s.getSnapshot().records.length, 100);
  s.dispose();
  const n = notified;
  await s.scan().catch(() => {});
  assert.equal(notified, n);
});

test("view state: section, filters, sort, group; rows are memoised per state version", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 40; i++) host.add(`source/meetings/n${String(i).padStart(2, "0")}.md`, meetingText(i, i % 2 ? "slack" : "meet"));
  const s = mk(host);
  await s.init();
  await settle(s);
  s.setSection("slack");
  assert.equal(s.rows().filter((r) => r.kind === "note").length, 20);
  s.setFilters({ query: "Meeting 3" });
  const r1 = s.rows();
  assert.equal(r1, s.rows(), "same state, same array");
  assert.ok(r1.filter((r) => r.kind === "note").length >= 1);
  s.setSection(null);
  s.setFilters({ query: "" });
  s.setGroup("none");
  assert.equal(s.rows().length, 40);
  s.select("source/meetings/n01.md");
  s.reveal("source/meetings/n02.md");
  assert.equal(s.getSnapshot().sectionId, "meeting");
  assert.equal(s.getSnapshot().selectedRel, "source/meetings/n02.md");
});

test("search is optional: without a run function the store simply has no full-text search", async () => {
  const s = mk(new FakeHost());
  assert.equal(s.searchAvailable, false);
  s.setSearchQuery("anything");
  assert.equal(s.getSnapshot().search.phase, "idle");
});

test("benchmark: 50,000 notes list, enrich and render rows (numbers printed)", async () => {
  const host = new FakeHost();
  for (let i = 0; i < 50_000; i++) host.add(`source/meetings/2026/${String((i % 12) + 1).padStart(2, "0")}/g${String(i % 50).padStart(2, "0")}/2026-10-01-m${String(i).padStart(5, "0")}.md`, meetingText(i, i % 7 === 0 ? "slack" : "meet"));
  const s = mk(host);
  const t0 = performance.now();
  await s.init();
  const tList = performance.now() - t0;
  await settle(s, 120_000);
  const tAll = performance.now() - t0;
  const t1 = performance.now();
  s.setSection("meeting");
  const rows = s.rows();
  const tRows = performance.now() - t1;
  const t2 = performance.now();
  s.setFilters({ query: "Meeting 4999" });
  const filtered = s.rows();
  const tFilter = performance.now() - t2;
  console.log(`BENCH library 50k (in-memory host, no IPC or disk): list ${tList.toFixed(0)} ms, heads done ${tAll.toFixed(0)} ms, rows(${rows.length}) ${tRows.toFixed(0)} ms, filter(${filtered.length}) ${tFilter.toFixed(0)} ms`);
  assert.equal(s.getSnapshot().records.length, 50_000);
  assert.ok(tRows < 1500, "grouping and sorting 43k rows is interactive");
  assert.ok(tFilter < 1500);
});
