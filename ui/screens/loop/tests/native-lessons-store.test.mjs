// Loop step lessons live in system/self-improvement/lessons.json (plan 2026-11-19, phase 2), not in loop.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLoops, saveLoops } from "../native/store.ts";
import { encodeProjectStore } from "../native/model.ts";
import { initialProjectStore } from "../native/templates.ts";
import { boundedLesson, decodeLessons, MAX_LESSON_CHARS } from "../native/lessons.ts";

const LOOP = "system/loop.json";
const LESSONS = "system/self-improvement/lessons.json";

/** A tiny in-memory project fs with hashes; the folder must be created before a file in it can be. */
function memFs(files = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set(["system", ...[...map.keys()].map((k) => k.slice(0, k.lastIndexOf("/")))]);
  let n = 0;
  const hashes = new Map([...map.keys()].map((k) => [k, `h${n++}`]));
  const fs = {
    read: async (p) => {
      if (!map.has(p)) throw Object.assign(new Error("missing"), { code: "not_found" });
      return { status: "ok", text: map.get(p), hash: hashes.get(p) };
    },
    write: async (p, text, opts) => {
      if (!dirs.has(p.slice(0, p.lastIndexOf("/")))) throw Object.assign(new Error("no parent"), { code: "io" });
      if ((hashes.get(p) ?? null) !== opts.expected_hash) throw Object.assign(new Error("conflict"), { code: "conflict" });
      map.set(p, text);
      hashes.set(p, `h${n++}`);
      return { hash: hashes.get(p) };
    },
    create: async (p) => { dirs.add(p); return p; },
  };
  return { fs, map };
}

function storeWithLesson(text = "Keep the plan short.") {
  const store = initialProjectStore();
  const loop = store.loops.find((l) => l.defaultKey === "plan");
  const stage = loop.config.stages.find((s) => s.kind === "skill");
  stage.promptAddendum = text;
  return { store, loop, stage };
}

test("an old loop.json's lessons are moved into lessons.json on load and loop.json no longer holds them", async () => {
  const { store, loop, stage } = storeWithLesson();
  const { fs, map } = memFs({ [LOOP]: encodeProjectStore(store) });
  const r = await loadLoops(fs);
  assert.equal(r.kind, "ok");
  assert.equal(r.store.loops.find((l) => l.id === loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum, "Keep the plan short.", "still on the stage in memory");
  assert.doesNotMatch(map.get(LOOP), /Keep the plan short/);
  const entries = decodeLessons(JSON.parse(map.get(LESSONS)));
  assert.deepEqual(entries.map((e) => [e.loopId, e.loopKey, e.stageId, e.stageKey, e.text]), [[loop.id, "plan", stage.id, stage.defaultKey, "Keep the plan short."]]);
  // The returned hash is loop.json's new one, so the next save does not conflict.
  r.store.loops[0].name = "renamed";
  await saveLoops(fs, r.store, r.hash);
});

test("lessons.json wins over loop.json, and a save writes nothing when the lessons did not change", async () => {
  const { store, loop, stage } = storeWithLesson("old text");
  const lessons = { format: 1, lessons: [{ loopId: loop.id, loopKey: "plan", stageId: stage.id, stageKey: stage.defaultKey, text: "file text", updatedAt: "2026-11-01T00:00:00.000Z" }] };
  const { fs, map } = memFs({ [LOOP]: encodeProjectStore(store), [LESSONS]: JSON.stringify(lessons) });
  const r = await loadLoops(fs);
  assert.equal(r.store.loops.find((l) => l.id === loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum, "file text");
  const before = map.get(LESSONS);
  await saveLoops(fs, r.store, r.hash);
  assert.equal(map.get(LESSONS), before, "unchanged lessons keep the file (and its dates) as they were");
});

test("a hand-typed lesson is cleaned and capped like an accepted one; a lesson of a loop not in the store is kept", async () => {
  const { store, loop, stage } = storeWithLesson("");
  delete stage.promptAddendum;
  const other = { loopId: "gone-loop", loopKey: null, stageId: "s1", stageKey: null, text: "imported lesson", updatedAt: "x", origin: "imported:other" };
  const { fs, map } = memFs({ [LOOP]: encodeProjectStore(store), [LESSONS]: JSON.stringify({ format: 1, lessons: [other] }) });
  const r = await loadLoops(fs);
  r.store.loops.find((l) => l.id === loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum = `‮evil\t${"x".repeat(5000)}`;
  await saveLoops(fs, r.store, r.hash);
  const entries = decodeLessons(JSON.parse(map.get(LESSONS)));
  assert.deepEqual(entries[0], other);
  assert.equal(entries[1].text.length, MAX_LESSON_CHARS);
  assert.ok(entries[1].text.startsWith("evil x"), "bidi removed, tab made a space");
  assert.equal(boundedLesson("  ​  "), "");
});

test("a corrupt lessons.json is reported, never overwritten, and a save with lessons is refused", async () => {
  const { store } = storeWithLesson();
  const { fs, map } = memFs({ [LOOP]: encodeProjectStore(store), [LESSONS]: "{not json" });
  const r = await loadLoops(fs);
  assert.match(r.lessonsProblem, /not a valid lessons file/);
  assert.match(map.get(LOOP), /Keep the plan short/, "nothing was moved out of loop.json");
  await assert.rejects(saveLoops(fs, r.store, r.hash), /never overwritten/);
  assert.equal(map.get(LESSONS), "{not json");
});

test("the first lesson creates the self-improvement folder", async () => {
  const { store } = storeWithLesson();
  const { fs, map } = memFs({});
  await saveLoops(fs, store, null);
  assert.ok(map.has(LESSONS) && !map.get(LOOP).includes("Keep the plan short"));
  assert.deepEqual(JSON.parse(map.get("system/self-improvement/manifest.json")), { format: 1, root: null, createdBy: "desktop" }, "a new folder gets a manifest at once");
});

test("a save from a stale view never overwrites a lesson written since it was loaded", async () => {
  const { store, loop, stage } = storeWithLesson("first");
  const { fs, map } = memFs({});
  await saveLoops(fs, store, null);
  const a = await loadLoops(fs); // window A
  const b = await loadLoops(fs); // window B
  b.store.loops.find((l) => l.id === loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum = "second";
  await saveLoops(fs, b.store, b.hash);
  // A still holds "first" and changes something else: its lessons differ from the file, so it must not win.
  a.store.loops.find((l) => l.id === loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum = "first, edited";
  await assert.rejects(saveLoops(fs, a.store, a.hash), (e) => e.code === "conflict");
  assert.match(map.get(LESSONS), /"second"/);
  // A save that leaves the lessons as the file has them goes through even from an older view.
  const c = await loadLoops(fs);
  c.store.loops[0].name = "renamed";
  await saveLoops(fs, c.store, c.hash);
});
