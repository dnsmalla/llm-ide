import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const landing = await load("landing.ts");
const nav = await load("sections.ts");
const { safeText } = await load("safe-text.ts");
const host = await load("host.ts");
const { createProjectStore } = await load("project-store.ts");

test("first load: Welcome without a project, the home section with one; an override is never replaced", () => {
  const home = "explorer";
  assert.equal(landing.landingFor({ prev: undefined, now: null, home, overridden: false }), "welcome");
  assert.equal(landing.landingFor({ prev: undefined, now: "/p", home, overridden: false }), "explorer");
  assert.equal(landing.landingFor({ prev: undefined, now: null, home, overridden: true }), null);
  assert.equal(landing.landingFor({ prev: undefined, now: "/p", home: "library", overridden: false }), "library");
});

test("opening a first project lands on home, closing returns to Welcome, switching stays put", () => {
  const base = { home: "explorer", overridden: false };
  assert.equal(landing.landingFor({ ...base, prev: null, now: "/p" }), "explorer");
  assert.equal(landing.landingFor({ ...base, prev: "/p", now: null }), "welcome");
  assert.equal(landing.landingFor({ ...base, prev: "/a", now: "/b" }), null);
  assert.equal(landing.landingFor({ ...base, prev: "/a", now: "/a" }), null);
  assert.equal(landing.landingFor({ ...base, prev: null, now: null }), null);
});

test("home preference: default Explorer, only available sections, storage failures are harmless", () => {
  assert.equal(landing.readHome(), "explorer");
  assert.equal(landing.resolveHome("graph"), "graph");
  for (const bad of ["issues", "autotasks", "spike", "welcome", "nope", "", null, undefined, 3]) assert.equal(landing.resolveHome(bad), "explorer", String(bad));
  assert.doesNotThrow(() => landing.storeHome("library"));
  assert.doesNotThrow(() => landing.storeHome("issues"));
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    landing.storeHome("library");
    assert.equal(landing.readHome(), "library");
    landing.storeHome("issues"); // disabled: ignored
    assert.equal(landing.readHome(), "library");
    store.set("llmide.home", "spike");
    assert.equal(landing.readHome(), "explorer");
    globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.equal(landing.readHome(), "explorer");
    assert.doesNotThrow(() => landing.storeHome("graph"));
  } finally {
    delete globalThis.localStorage;
  }
  assert.ok(landing.HOME_CHOICES.every((id) => nav.isSelectable(id)));
});

test("safeText strips control, bidi and zero-width characters and caps by code point", () => {
  assert.equal(safeText("a‮b​c\u0000d\ne⁦f"), "abcd ef");
  assert.equal(safeText("  many   spaces\t here "), "many spaces here");
  assert.equal(safeText("x".repeat(500), 10), "xxxxxxxxx…");
  assert.equal(Array.from(safeText("\u{1F600}".repeat(50), 5)).length, 5, "never splits a surrogate pair");
  assert.equal(safeText(null), "");
  assert.equal(safeText({ toString: () => "x" }), "");
  assert.equal(safeText("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "text is kept as text; rendering escapes it");
});

test("decodeRecentList is defensive: bad shapes read as empty, ok needs an open index, extras are capped", () => {
  assert.deepEqual(host.decodeRecentList(null), { entries: [], reset: false });
  assert.deepEqual(host.decodeRecentList("x"), { entries: [], reset: false });
  assert.deepEqual(host.decodeRecentList({ entries: "no" }), { entries: [], reset: false });
  const r = host.decodeRecentList({
    reset: true,
    entries: [
      { name: "a", root: "/a", status: "ok", reason: null, open_index: 0, stored_index: 0 },
      { name: "b", root: "/b", status: "missing", reason: "gone", open_index: null, stored_index: 1 },
      { name: "c", root: "/c", status: "ok", open_index: null, stored_index: 2 }, // ok without an index cannot be opened
      { name: "d", root: "/d", status: "weird", stored_index: 3 },
      { name: 5, root: "/e", stored_index: 4 },
      { name: "f", root: "/f", status: "ok", open_index: 1, stored_index: -1 },
      null,
    ],
  });
  assert.equal(r.reset, true);
  assert.deepEqual(r.entries.map((e) => [e.name, e.status, e.openIndex, e.storedIndex]), [["a", "ok", 0, 0], ["b", "missing", null, 1], ["c", "missing", null, 2], ["d", "missing", null, 3]]);
  const many = host.decodeRecentList({ entries: Array.from({ length: 80 }, (_, i) => ({ name: "n", root: `/r${i}`, status: "ok", open_index: i, stored_index: i })) });
  assert.equal(many.entries.length, host.MAX_RECENT_SHOWN);
});

test("host: create, close, recent-all and forget go through the bridge with plain arguments", async () => {
  const calls = [];
  host.setHostBridge({ invoke: async (c, a) => (calls.push([c, a]), c === "project_recent_all" ? { entries: [], reset: false } : c === "project_forget_recent" ? true : { name: "p", root: "/r" }) });
  try {
    assert.deepEqual(await host.host.projectCreate("My App"), { name: "p", root: "/r" });
    await host.host.projectClose();
    assert.deepEqual(await host.host.projectRecentAll(), { entries: [], reset: false });
    assert.equal(await host.host.projectForgetRecent(2, "/x"), true);
    assert.deepEqual(calls.map((c) => c[0]), ["project_create", "project_close", "project_recent_all", "project_forget_recent"]);
    assert.deepEqual(calls[0][1], { name: "My App" });
    assert.deepEqual(calls[3][1], { index: 2, root: "/x" });
    await assert.rejects(host.host.projectForgetRecent(-1, "/x"), RangeError);
  } finally {
    host.setHostBridge(null);
  }
  assert.equal(await host.host.projectCreate("x"), null, "no host: nothing to create");
  assert.deepEqual(await host.host.projectRecentAll(), { entries: [], reset: false });
});

function fakeHost(over = {}) {
  const st = { active: null, recent: [], created: [], closed: 0, forgotten: [] };
  const h = {
    projectActive: async () => st.active,
    projectRecent: async () => st.recent,
    projectOpen: async () => null,
    projectOpenRecent: async (i) => { st.active = st.recent[i]; return st.active; },
    projectRecentAll: async () => ({ entries: st.recent.map((p, i) => ({ name: p.name, root: p.root, status: "ok", reason: null, openIndex: i, storedIndex: i })), reset: false }),
    projectCreate: async (name) => { const p = { name, root: `/tmp/${name}` }; st.created.push(name); st.active = p; st.recent = [p, ...st.recent]; return p; },
    projectClose: async () => { st.closed++; st.active = null; },
    projectForgetRecent: async (i, root) => { st.forgotten.push([i, root]); st.recent = st.recent.filter((p) => p.root !== root); return true; },
    ...over,
  };
  return { h, st };
}

test("project store: create runs the after-hook before publishing, warnings become a notice, never an error", async () => {
  const { h, st } = fakeHost();
  const store = createProjectStore(h);
  await store.refresh();
  assert.equal(store.getSnapshot().project, null);
  const order = [];
  store.subscribe(() => order.push(store.getSnapshot().project?.name ?? null));
  const p = await store.createProject("Alpha", async () => ["Skills were not installed."]);
  assert.equal(p.name, "Alpha");
  assert.equal(store.getSnapshot().project.name, "Alpha");
  assert.match(store.getSnapshot().notice, /Alpha.*created.*Skills were not installed/);
  assert.equal(store.getSnapshot().error, null);
  assert.deepEqual(st.created, ["Alpha"]);
  store.dismissNotice();
  assert.equal(store.getSnapshot().notice, null);
  // a throwing hook is a warning too
  const q = await store.createProject("Beta", async () => { throw new Error("core down"); });
  assert.equal(q.name, "Beta");
  assert.match(store.getSnapshot().notice, /core down/);
});

test("project store: cancel changes nothing, a host refusal is the error, close and forget keep files out of it", async () => {
  const { h, st } = fakeHost({ projectCreate: async () => null });
  const store = createProjectStore(h);
  await store.refresh();
  assert.equal(await store.createProject("x"), null);
  assert.deepEqual([store.getSnapshot().project, store.getSnapshot().error, store.getSnapshot().notice], [null, null, null]);
  const refusing = createProjectStore(fakeHost({ projectCreate: async () => { throw "\"Alpha\" already exists in that location"; } }).h);
  assert.equal(await refusing.createProject("Alpha"), null);
  assert.match(refusing.getSnapshot().error, /already exists/);

  const f = fakeHost();
  f.st.recent = [{ name: "a", root: "/a" }, { name: "b", root: "/b" }];
  f.st.active = f.st.recent[0];
  const s2 = createProjectStore(f.h);
  await s2.refresh();
  assert.equal(s2.getSnapshot().project.name, "a");
  await s2.closeProject();
  assert.equal(s2.getSnapshot().project, null);
  assert.equal(f.st.closed, 1);
  assert.equal(s2.getSnapshot().recentAll.entries.length, 2, "closing keeps the recent list");
  await s2.forgetRecent(s2.getSnapshot().recentAll.entries[1]);
  assert.deepEqual(f.st.forgotten, [[1, "/b"]]);
  assert.deepEqual(s2.getSnapshot().recentAll.entries.map((e) => e.name), ["a"]);
  void st;
});

test("project store: a host without the new commands (older build) still loads", async () => {
  const store = createProjectStore({ projectActive: async () => null, projectRecent: async () => [], projectOpen: async () => null, projectOpenRecent: async () => ({ name: "x", root: "/x" }) });
  await store.refresh();
  assert.equal(store.getSnapshot().loaded, true);
  assert.deepEqual(store.getSnapshot().recentAll, { entries: [], reset: false });
  assert.equal(await store.createProject("x"), null);
  assert.match(store.getSnapshot().error, /desktop app/);
});
