import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const T = await load("tabs-model.ts");
const run = (...actions) => actions.reduce((s, a) => T.tabsReduce(s, a), T.emptyTabs);
const ids = (s) => s.tabs.map((t) => t.id);

test("preview tab is replaced by the next preview open; regular tabs stay", () => {
  let s = run({ type: "open", path: "a", preview: true }, { type: "open", path: "b", preview: true });
  assert.deepEqual(ids(s), ["b"]);
  assert.equal(s.activeId, "b");
  s = run({ type: "open", path: "a", preview: true }, { type: "promote", id: "a" }, { type: "open", path: "b", preview: true }, { type: "open", path: "c", preview: true });
  assert.deepEqual(ids(s), ["a", "c"]);
});

test("editing promotes a preview and a dirty preview is never replaced", () => {
  let s = run({ type: "open", path: "a", preview: true }, { type: "edit", id: "a", dirty: true });
  assert.equal(s.tabs[0].preview, false);
  s = T.tabsReduce(s, { type: "open", path: "b", preview: true });
  assert.deepEqual(ids(s), ["a", "b"]);
  assert.equal(T.requestClose(s, "a"), "prompt");
  assert.equal(T.requestClose(s, "b"), "close");
  assert.equal(T.requestClose(s, "zzz"), "missing");
});

test("opening an existing tab as a regular tab promotes it; activation tracks MRU", () => {
  let s = run({ type: "open", path: "a", preview: true });
  s = T.tabsReduce(s, { type: "open", path: "a", preview: false });
  assert.equal(s.tabs[0].preview, false);
  s = run({ type: "open", path: "a", preview: false }, { type: "open", path: "b", preview: false }, { type: "open", path: "c", preview: false }, { type: "activate", id: "a" });
  assert.deepEqual(s.mru, ["a", "c", "b"]);
  s = T.tabsReduce(s, { type: "close", id: "a" });
  assert.equal(s.activeId, "c");
  assert.deepEqual(ids(s), ["b", "c"]);
});

test("closing the last tab leaves nothing active", () => {
  const s = run({ type: "open", path: "a", preview: false }, { type: "close", id: "a" });
  assert.deepEqual(s, T.emptyTabs);
});

test("pinning keeps pinned tabs left; move respects the region", () => {
  let s = run({ type: "open", path: "a", preview: false }, { type: "open", path: "b", preview: false }, { type: "open", path: "c", preview: false }, { type: "pin", id: "c", pinned: true });
  assert.deepEqual(ids(s), ["c", "a", "b"]);
  s = T.tabsReduce(s, { type: "move", id: "b", to: 0 });
  assert.deepEqual(ids(s), ["c", "b", "a"]);
  s = T.tabsReduce(s, { type: "move", id: "c", to: 5 });
  assert.deepEqual(ids(s), ["c", "b", "a"]);
  s = T.tabsReduce(s, { type: "move", id: "a", to: 1 });
  assert.deepEqual(ids(s), ["c", "a", "b"]);
});

test("close others / close all skip pinned and dirty tabs", () => {
  let s = run(
    { type: "open", path: "a", preview: false }, { type: "open", path: "b", preview: false }, { type: "open", path: "c", preview: false },
    { type: "open", path: "d", preview: false }, { type: "pin", id: "a", pinned: true }, { type: "edit", id: "d", dirty: true },
  );
  assert.deepEqual(ids(T.tabsReduce(s, { type: "closeOthers", id: "b" })), ["a", "b", "d"]);
  assert.equal(T.tabsReduce(s, { type: "closeOthers", id: "b" }).activeId, "b");
  assert.deepEqual(ids(T.tabsReduce(s, { type: "closeAll" })), ["a", "d"]);
  assert.deepEqual(T.dirtyTabs(s).map((t) => t.id), ["d"]);
});

test("rename moves tabs under a renamed folder; remove keeps dirty tabs", () => {
  let s = run({ type: "open", path: "src/a.ts", preview: false }, { type: "open", path: "srcx/b.ts", preview: false });
  s = T.tabsReduce(s, { type: "renamed", from: "src", to: "lib" });
  assert.deepEqual(ids(s), ["lib/a.ts", "srcx/b.ts"]);
  assert.equal(s.activeId, "srcx/b.ts");
  s = T.tabsReduce(s, { type: "edit", id: "lib/a.ts", dirty: true });
  assert.deepEqual(ids(T.tabsReduce(s, { type: "removed", id: "lib/a.ts" })), ["lib/a.ts", "srcx/b.ts"]);
  assert.deepEqual(ids(T.tabsReduce(s, { type: "removed", id: "srcx/b.ts" })), ["lib/a.ts"]);
});

test("tab count is bounded: oldest clean tab makes room, none available refuses", () => {
  let s = T.emptyTabs;
  for (let i = 0; i < T.MAX_TABS; i++) s = T.tabsReduce(s, { type: "open", path: `f${i}`, preview: false });
  s = T.tabsReduce(s, { type: "open", path: "extra", preview: false });
  assert.equal(s.tabs.length, T.MAX_TABS);
  assert.ok(!ids(s).includes("f0"));
  assert.equal(s.activeId, "extra");
  let dirty = T.emptyTabs;
  for (let i = 0; i < T.MAX_TABS; i++) dirty = T.tabsReduce(T.tabsReduce(dirty, { type: "open", path: `f${i}`, preview: false }), { type: "edit", id: `f${i}`, dirty: true });
  assert.equal(T.tabsReduce(dirty, { type: "open", path: "more", preview: false }), dirty);
});

test("session round trip and hostile input", () => {
  const s = run({ type: "open", path: "a/b.ts", preview: false }, { type: "open", path: "c.md", preview: true }, { type: "pin", id: "a/b.ts", pinned: true });
  const back = T.restoreTabs(JSON.parse(JSON.stringify(T.serializeTabs(s))));
  assert.deepEqual(ids(back), ["a/b.ts", "c.md"]);
  assert.equal(back.tabs[0].pinned, true);
  assert.equal(back.tabs.every((t) => !t.dirty), true);
  assert.deepEqual(T.restoreTabs(null), T.emptyTabs);
  assert.deepEqual(T.restoreTabs({ v: 2, tabs: [] }), T.emptyTabs);
  const hostile = T.restoreTabs({ v: 1, active: "../x", tabs: [{ path: "../x" }, { path: "/etc/passwd" }, { path: "a/./b" }, { path: "ok.ts" }, { path: "ok.ts" }, { path: 5 }, null, { path: "a\0b" }] });
  assert.deepEqual(ids(hostile), ["ok.ts"]);
  assert.equal(hostile.activeId, "ok.ts");
  assert.equal(T.restoreTabs({ v: 1, tabs: Array.from({ length: 1000 }, (_, i) => ({ path: `p${i}` })) }).tabs.length, T.MAX_TABS);
});
