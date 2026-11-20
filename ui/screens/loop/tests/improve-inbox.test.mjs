// Loop lessons and changes from another project, waiting in system/self-improvement/inbox (plan 2026-11-19, phase 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptInboxItem, dismissInboxItem, inboxSources, readLoopInbox } from "../native/improve/inbox.ts";
import { loadLoops, saveLoops } from "../native/store.ts";
import { initialProjectStore } from "../native/templates.ts";
import { parseChangeLog, CHANGES_FILE } from "../native/improve/changes-log.ts";

const SRC = "web-shop-2026-11-19";
const IN = `system/self-improvement/inbox/${SRC}`;

function memFs(files = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set(["system", "system/self-improvement", ...[...map.keys()].map((k) => k.slice(0, k.lastIndexOf("/")))]);
  const hash = (p) => (map.has(p) ? `h${map.get(p).length}:${map.get(p).slice(-8)}` : null);
  return {
    map,
    read: async (p) => { if (!map.has(p)) throw Object.assign(new Error("missing"), { code: "not_found" }); return { status: "ok", text: map.get(p), hash: hash(p) }; },
    write: async (p, text, opts) => {
      if (!dirs.has(p.slice(0, p.lastIndexOf("/")))) throw Object.assign(new Error("no parent"), { code: "io" });
      if (!opts.force && hash(p) !== opts.expected_hash) throw Object.assign(new Error("conflict"), { code: "conflict" });
      map.set(p, text); return { hash: hash(p) };
    },
    create: async (p) => { dirs.add(p); return p; },
  };
}

async function setup() {
  const store = initialProjectStore();
  const fs = memFs();
  await saveLoops(fs, store, null);
  const loaded = await loadLoops(fs);
  const loop = loaded.store.loops.find((l) => l.defaultKey === "plan");
  const stage = loop.config.stages.find((s) => s.kind === "skill" && s.defaultKey);
  await fs.create(IN);
  // What another project's folder holds: ids from THAT project, keys shared with this one.
  fs.map.set(`${IN}/lessons.json`, JSON.stringify({ format: 1, lessons: [
    { loopId: "their-loop", loopKey: "plan", stageId: "their-stage", stageKey: stage.defaultKey, text: "Name the files you read.", updatedAt: "x" },
    { loopId: "their-loop", loopKey: "nope", stageId: "s9", stageKey: "unknown-step", text: "No match here.", updatedAt: "x" },
  ] }));
  const change = { op: "setConfig", field: "maxIterations", before: loop.config.maxIterations, after: loop.config.maxIterations - 1 };
  const stale = { op: "setConfig", field: "maxRepairsPerStage", before: 99, after: 3 };
  fs.map.set(`${IN}/changes.jsonl`, [
    { id: "c1", action: "accept", at: "t", loopId: "their-loop", loopKey: "plan", stageKey: null, change, rationale: "runs ran out of rounds" },
    { id: "c1", action: "outcome", at: "t", loopId: "their-loop", loopKey: "plan", stageKey: null, verdict: "better" },
    { id: "c2", action: "accept", at: "t", loopId: "their-loop", loopKey: "plan", stageKey: null, change: stale },
    { id: "c3", action: "accept", at: "t", loopId: "their-loop", loopKey: "plan", stageKey: null, change },
    { id: "c3", action: "revert", at: "t", loopId: "their-loop", loopKey: "plan", stageKey: null, change },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { fs, load: { store: loaded.store, hash: loaded.hash }, loop, stage };
}

test("items are matched to this project's loop and step by the shared keys; reverted changes are not offered", async () => {
  const { fs, load, loop, stage } = await setup();
  const items = await readLoopInbox(fs, load.store, [{ name: SRC, projectName: "web-shop" }]);
  assert.deepEqual(items.map((i) => [i.kind, i.key, i.loopId]), [
    ["lesson", "their-loop/their-stage", loop.id], ["lesson", "their-loop/s9", null], ["change", "c1", loop.id], ["change", "c2", loop.id],
  ]);
  assert.equal(items[0].stageName, stage.name);
  assert.match(items[2].text, /^maxIterations: \d+ → \d+ — runs ran out of rounds \(there: better\)$/);
});

test("adopting a lesson puts it on the matched step (saved in lessons.json) and removes it from the inbox", async () => {
  const { fs, load, loop, stage } = await setup();
  const [item] = await readLoopInbox(fs, load.store, [{ name: SRC, projectName: "web-shop" }]);
  const out = await adoptInboxItem({ fs, load, runningLoopIds: new Set() }, item);
  assert.equal(out.store.loops.find((l) => l.id === loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum, "Name the files you read.");
  assert.match(fs.map.get("system/self-improvement/lessons.json"), /Name the files you read/);
  assert.doesNotMatch(fs.map.get(`${IN}/lessons.json`), /Name the files you read/);
  await assert.rejects(adoptInboxItem({ fs, load, runningLoopIds: new Set([loop.id]) }, item), /Finish or stop the run first/);
});

test("adopting a change applies it through the strict rules, logs it as imported, and a stale one is refused untouched", async () => {
  const { fs, load, loop } = await setup();
  const items = await readLoopInbox(fs, load.store, [{ name: SRC, projectName: "web-shop" }]);
  const good = items.find((i) => i.key === "c1");
  const out = await adoptInboxItem({ fs, load, runningLoopIds: new Set() }, good);
  assert.equal(out.store.loops.find((l) => l.id === loop.id).config.maxIterations, good.line.change.after);
  const [logged] = parseChangeLog(fs.map.get(CHANGES_FILE));
  assert.deepEqual([logged.action, logged.id, logged.origin, logged.decide], ["adopt", `${SRC}:c1`, "imported:web-shop", undefined]);
  await assert.rejects(adoptInboxItem({ fs, load: out, runningLoopIds: new Set() }, items.find((i) => i.key === "c2")), /out of date/);
  assert.match(fs.map.get(`${IN}/changes.jsonl`), /"c2"/, "a refused item stays in the inbox");
  assert.doesNotMatch(fs.map.get(`${IN}/changes.jsonl`), /"c1"/);
});

test("dismiss only removes the item; an item with no match here cannot be adopted", async () => {
  const { fs, load } = await setup();
  const items = await readLoopInbox(fs, load.store, [{ name: SRC, projectName: "web-shop" }]);
  const unmatched = items.find((i) => i.loopId === null);
  await assert.rejects(adoptInboxItem({ fs, load, runningLoopIds: new Set() }, unmatched), /no matching loop or step/);
  await dismissInboxItem(fs, unmatched);
  assert.doesNotMatch(fs.map.get(`${IN}/lessons.json`), /No match here/);
  assert.match(fs.map.get(`${IN}/lessons.json`), /Name the files you read/);
});

test("inbox sources come from the core; an older core or a bad name lists none", async () => {
  const core = { request: async (path) => { assert.match(path, /^\/kb\/agent\/self-improvement\/inbox\?workspaceRoot=%2Fp$/); return { sources: [{ name: SRC, projectName: "web-shop" }, { name: "../x" }] }; } };
  assert.deepEqual(await inboxSources(core, "/p"), [{ name: SRC, projectName: "web-shop" }]);
  assert.deepEqual(await inboxSources({ request: async () => { throw new Error("404"); } }, "/p"), []);
});
