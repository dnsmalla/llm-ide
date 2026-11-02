process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_KEY, HIDDEN_LIMIT, hideRels, isVisible, loadHidden, pruneHidden, refusedMessage, saveHidden, unhideRels } from "../hidden-notes.ts";
import { LibraryStore } from "../library-store.ts";
import { NotesError } from "../host.ts";
import { FakeHost, meetingText, settle } from "./fake-host.ts";

class MemStore {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const A = "source/meetings/2026/10/a.md";
const B = "source/meetings/2026/10/b.md";
const C = "source/meetings/2026/10/c.md";

// ---- pure helpers -------------------------------------------------------------------------

test("hide and unhide are set operations that never touch anything but the set", () => {
  const { hidden, refused } = hideRels(new Set([A]), [B, A]);
  assert.deepEqual([...hidden].sort(), [A, B]);
  assert.equal(refused, 0);
  assert.deepEqual([...unhideRels(hidden, [A])], [B]);
  assert.deepEqual([...unhideRels(hidden, [])].sort(), [A, B], "unhiding nothing changes nothing");
});

test("the hidden list is bounded at 10,000 paths; the rest are refused, not dropped silently", () => {
  const many = Array.from({ length: HIDDEN_LIMIT + 3 }, (_, i) => `source/x/${i}.md`);
  const { hidden, refused } = hideRels(new Set(), many);
  assert.equal(hidden.size, HIDDEN_LIMIT);
  assert.equal(refused, 3);
  assert.ok(hidden.has(many[0]!) && !hidden.has(many[HIDDEN_LIMIT]!));
});

test("persistence is keyed by project root; a corrupt or hostile stored value loads as empty or filtered", () => {
  const s = new MemStore();
  saveHidden(s, "/p/one", new Set([A, B]));
  saveHidden(s, "/p/two", new Set([C]));
  assert.deepEqual([...loadHidden(s, "/p/one")].sort(), [A, B]);
  assert.deepEqual([...loadHidden(s, "/p/two")], [C]);
  assert.deepEqual([...loadHidden(s, "/p/none")], []);

  s.setItem(HIDDEN_KEY, "{not json");
  assert.deepEqual([...loadHidden(s, "/p/one")], []);
  s.setItem(HIDDEN_KEY, JSON.stringify({ "/p/one": ["ok.md", "", 7, "x\u0000y", "a".repeat(2000), { no: 1 }] }));
  assert.deepEqual([...loadHidden(s, "/p/one")], ["ok.md"], "only plain path strings survive");
  s.setItem(HIDDEN_KEY, JSON.stringify({ "/p/one": "not-a-list" }));
  assert.deepEqual([...loadHidden(s, "/p/one")], []);
  assert.deepEqual([...loadHidden(null, "/p/one")], [], "no storage at all: nothing hidden, no crash");
});

test("a saved list is capped at the bound when read back", () => {
  const s = new MemStore();
  s.setItem(HIDDEN_KEY, JSON.stringify({ "/p": Array.from({ length: HIDDEN_LIMIT + 50 }, (_, i) => `n${i}.md`) }));
  assert.equal(loadHidden(s, "/p").size, HIDDEN_LIMIT);
});

test("stale paths are pruned against what the folder still has", () => {
  const kept = pruneHidden(new Set([A, B, C]), (rel) => rel !== B);
  assert.deepEqual([...kept].sort(), [A, C]);
});

test("visibility: hidden notes are out unless the Show hidden toggle is on", () => {
  assert.equal(isVisible(A, new Set([A]), false), false);
  assert.equal(isVisible(A, new Set([A]), true), true);
  assert.equal(isVisible(B, new Set([A]), false), true);
});

// ---- store --------------------------------------------------------------------------------

async function mk(files: Record<string, string>, storage = new MemStore()) {
  const host = new FakeHost();
  for (const [rel, text] of Object.entries(files)) host.add(rel, text);
  const store = new LibraryStore({ host, storage, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await store.init();
  await settle(store);
  store.setSection(null);
  return { host, store, storage };
}

const three = { [A]: meetingText(1), [B]: meetingText(2), [C]: meetingText(3, "slack") };

test("a hidden note leaves the list, the section counts and the filter results; the file stays", async () => {
  const { host, store } = await mk(three);
  assert.equal(store.getSnapshot().counts.get("meeting"), 2);
  store.hideNotes([A]);
  const st = store.getSnapshot();
  assert.equal(st.hiddenCount, 1);
  assert.equal(st.counts.get("meeting"), 1, "section count drops");
  assert.equal(store.rows().filter((r) => r.kind === "note").length, 2, "All lists the two visible notes");
  store.setFilters({ query: "Meeting 1" });
  const hit = store.rows().some((r) => r.kind === "note" && r.rec.rel === A);
  assert.equal(hit, false, "the filter cannot bring the hidden note back");
  assert.ok(host.files.has(A), "the note file is not touched");
});

test("Show hidden brings hidden notes back; Unhide restores one note or all", async () => {
  const { store } = await mk(three);
  store.hideNotes([A, B]);
  store.setShowHidden(true);
  assert.equal(store.rows().filter((r) => r.kind === "note").length, 3);
  store.unhideNotes([A]);
  assert.deepEqual([...store.getSnapshot().hidden], [B]);
  store.unhideNotes([...store.getSnapshot().hidden]);
  assert.equal(store.getSnapshot().hiddenCount, 0);
  store.setShowHidden(false);
  assert.equal(store.rows().filter((r) => r.kind === "note").length, 3);
});

test("the hidden set survives a restart for the same folder and is separate per folder", async () => {
  const storage = new MemStore();
  const first = await mk(three, storage);
  first.store.hideNotes([A]);
  const again = new LibraryStore({ host: first.host, storage, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await again.init();
  await settle(again);
  assert.deepEqual([...again.getSnapshot().hidden], [A]);
  first.host.root = { name: "other", root: "/Users/x/other" };
  const other = new LibraryStore({ host: first.host, storage, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await other.init();
  await settle(other);
  assert.deepEqual([...other.getSnapshot().hidden], []);
});

test("a note re-ingested at the same path keeps its hidden state", async () => {
  const { host, store } = await mk(three);
  store.hideNotes([A]);
  host.add(A, meetingText(9));
  await store.scan();
  await settle(store);
  assert.ok(store.getSnapshot().hidden.has(A));
  assert.equal(store.getSnapshot().counts.get("meeting"), 1);
  store.noteWritten({ rel: A, size: 1, mtimeMs: 2 }, meetingText(9));
  assert.equal(store.getSnapshot().counts.get("meeting"), 1, "a save from the editor does not unhide it either");
});

test("a rescan prunes hidden paths whose notes no longer exist, and saves the pruned list", async () => {
  const storage = new MemStore();
  const { host, store } = await mk(three, storage);
  store.hideNotes([A, B]);
  host.files.delete(A);
  await store.scan();
  await settle(store);
  assert.deepEqual([...store.getSnapshot().hidden], [B]);
  assert.deepEqual([...loadHidden(storage, "/Users/x/notes")], [B]);
});

test("a failed listing does not prune: a partial view must not forget hidden notes", async () => {
  const { host, store } = await mk(three);
  store.hideNotes([A]);
  host.files.delete(A);
  host.failList = new NotesError("io");
  await store.scan();
  assert.ok(store.getSnapshot().hidden.has(A));
});

test("hiding past the bound is refused with a count, and nothing already hidden is lost", async () => {
  const { store } = await mk(three);
  store.hideNotes([A]);
  const big = Array.from({ length: HIDDEN_LIMIT }, (_, i) => `source/x/${i}.md`);
  const r = store.hideNotes(big);
  assert.equal(r.refused, 1, "A took one slot, so the last of the bound's new entries is refused");
  assert.ok(store.getSnapshot().hidden.has(A));
});

test("the refused-count message is empty when nothing was refused and says what to do when the bound is hit", () => {
  assert.equal(refusedMessage(0), null);
  assert.match(refusedMessage(3) ?? "", /10,000/);
  assert.match(refusedMessage(3) ?? "", /3 notes were not hidden/);
  assert.match(refusedMessage(1) ?? "", /1 note was not hidden/);
});

test("storage that throws (quota, disabled) never breaks the Library: hiding still works for the session", async () => {
  const broken = { getItem(): string | null { throw new Error("SecurityError"); }, setItem(): void { throw new Error("QuotaExceededError"); } };
  assert.deepEqual([...loadHidden(broken, "/p")], []);
  assert.doesNotThrow(() => saveHidden(broken, "/p", new Set([A])));
  const { store } = await mk(three, broken as unknown as MemStore);
  store.hideNotes([A]);
  assert.equal(store.getSnapshot().hiddenCount, 1);
});
