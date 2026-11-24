// The shared seams feed Self-Heal: a section crash and an unexpected host-command failure each become one report.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const w = await load("tests/self-heal-wiring-entry.ts");
let posted = [];
const tick = () => w.pumpOnce({ take: async () => ({ enabled: true, incidents: [] }), post: async (b) => { posted.push(...b); } });
beforeEach(async () => {
  w.resetSelfHealForTests();
  posted = [];
  await tick(); // enable, as a debug build's first answer does
});

test("a section crash is one Self-Heal report", async () => {
  new w.SectionErrorBoundary({ name: "Library", children: null }).componentDidCatch(new Error("kaboom"), { componentStack: "\n    in Library" });
  await tick();
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].source, posted[0].category, posted[0].message], ["ui", "section:Library", "kaboom"]);
  assert.match(posted[0].stack, /in Library/);
});

test("a host command's internal failure is reported and rethrown unchanged", async () => {
  const err = { code: "internal", message: "db" };
  w.setHostBridge({ async invoke() { throw err; } });
  await assert.rejects(w.invokeHost("kb_x"), (e) => e === err);
  await tick();
  assert.deepEqual(posted.map((r) => [r.category, r.message]), [["host:kb_x", "db"]]);
});

test("an expected host refusal is not reported", async () => {
  w.setHostBridge({ async invoke() { throw { code: "cancelled", message: "m" }; } });
  await assert.rejects(w.invokeHost("pick_folder"));
  await tick();
  assert.deepEqual(posted, []);
});
