import { test } from "node:test";
import assert from "node:assert/strict";
import { persistEnsuredDefaults } from "../native/defaults-save.ts";
import { initialProjectStore } from "../native/templates.ts";

const okLoad = (store) => ({ kind: "ok", store, hash: "h1" });
const fake = (write) => ({ read: async () => ({ status: "ok", text: "" }), write });

test("missing built-in loops are written on open, not left dirty", async () => {
  const writes = [];
  const store = { schemaVersion: 2, loops: [] };
  const r = await persistEnsuredDefaults(fake(async (path, text) => { writes.push([path, text]); return { hash: "h2" }; }), okLoad(store), null);
  assert.equal(r.saved, true, r.error ?? "");
  assert.ok(r.added.length > 0);
  assert.equal(r.load.hash, "h2");
  assert.equal(r.load.store.loops.length, r.added.length);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "system/loop.json");
  assert.match(writes[0][1], /"schemaVersion"/);
});

test("an existing store is left alone and a failed write keeps the loops dirty", async () => {
  const store = initialProjectStore(null);
  const untouched = await persistEnsuredDefaults(fake(async () => { throw new Error("should not write"); }), okLoad(store), null);
  assert.deepEqual(untouched.added, []);
  assert.equal(untouched.saved, false);

  const failed = await persistEnsuredDefaults(fake(async () => { throw new Error("disk full"); }), okLoad({ schemaVersion: 2, loops: [] }), null);
  assert.equal(failed.saved, false);
  assert.match(failed.error, /disk full/);
  assert.equal(failed.load.hash, "h1");
  assert.ok(failed.load.store.loops.length > 0);
});
