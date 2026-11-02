process.env.TZ = "UTC";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadEntry, react, server } from "./helpers.mjs";

let L;
let h;
let html;
before(async () => {
  L = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

async function store() {
  const host = new L.FakeHost();
  host.add("source/meetings/2026/10/a.md", L.meetingText(1));
  host.add("source/meetings/2026/10/b.md", L.meetingText(2));
  const s = new L.LibraryStore({ host, storage: null, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await s.init();
  await L.settle(s);
  s.setSection(null);
  return { host, s };
}

test("hidden notes leave the listbox; the line says how many, with Show hidden and Unhide all", async () => {
  const { host, s } = await store();
  s.hideNotes(["source/meetings/2026/10/a.md"]);
  const out = html(h(L.NoteList, { store: s, state: s.getSnapshot(), initialHeight: 600 }));
  assert.match(out, /<span>1 hidden<\/span>/);
  assert.match(out, /aria-pressed="false"[^>]*>Show hidden</);
  assert.match(out, />Unhide all</);
  assert.ok(!out.includes("Meeting 1, "), "the hidden note is not a row");
  assert.ok(out.includes("Meeting 2"));
  assert.ok(host.files.has("source/meetings/2026/10/a.md"), "the file is untouched");
});

test("with Show hidden on, the hidden note is listed as hidden (aria and data attribute)", async () => {
  const { s } = await store();
  s.hideNotes(["source/meetings/2026/10/a.md"]);
  s.setShowHidden(true);
  const out = html(h(L.NoteList, { store: s, state: s.getSnapshot(), initialHeight: 600 }));
  assert.match(out, /aria-pressed="true"[^>]*>Hide hidden</);
  assert.match(out, /data-hidden="true"/);
  assert.match(out, /hidden from the list/);
});

test("each date group offers Remove all, which hides exactly that group", async () => {
  const { s } = await store();
  const out = html(h(L.NoteList, { store: s, state: s.getSnapshot(), initialHeight: 600 }));
  const m = /aria-label="Remove all ([^"]+) from List"/.exec(out);
  assert.ok(m, "a group action is rendered");
  assert.equal(s.getSnapshot().hiddenCount, 0, "rendering hides nothing");
});

test("no hidden notes: no hidden line at all", async () => {
  const { s } = await store();
  const out = html(h(L.NoteList, { store: s, state: s.getSnapshot(), initialHeight: 600 }));
  assert.ok(!out.includes("hidden</span>"));
  assert.ok(!out.includes(">Unhide all<"));
});

test("full-text hits leave out hidden notes unless Show hidden is on", async () => {
  const { s } = await store();
  s.hideNotes(["source/meetings/2026/10/a.md"]);
  const hit = (rel, title) => ({ rel, title, snippet: "x", date: "2026-10-01", kind: "meeting" });
  const search = { query: "meet", phase: "done", hits: [hit("source/meetings/2026/10/a.md", "HiddenHit"), hit("source/meetings/2026/10/b.md", "ShownHit")], error: null };
  const out = html(h(L.NoteList, { store: s, state: { ...s.getSnapshot(), search }, initialHeight: 600 }));
  assert.ok(out.includes("ShownHit") && !out.includes("HiddenHit"));
  const shown = html(h(L.NoteList, { store: s, state: { ...s.getSnapshot(), showHidden: true, search }, initialHeight: 600 }));
  assert.ok(shown.includes("HiddenHit"));
});
