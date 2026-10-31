import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const C = await load("conflict.ts");
const doc = (o = {}) => ({ ...C.newDoc("a.ts", "h1"), ...o });

test("unchanged hash (touch or our own save echo) does nothing", () => {
  const r = C.onDiskProbe(doc({ dirty: true }), { exists: true, hash: "h1" });
  assert.deepEqual(r.action, { type: "none" });
  assert.equal(r.doc.external, "none");
});

test("clean buffer reloads silently on an external change", () => {
  const r = C.onDiskProbe(doc(), { exists: true, hash: "h2" });
  assert.deepEqual(r.action, { type: "reload" });
});

test("dirty buffer gets the changed banner instead of being clobbered", () => {
  const r = C.onDiskProbe(doc({ dirty: true }), { exists: true, hash: "h2" });
  assert.deepEqual(r.action, { type: "banner", kind: "changed" });
  assert.equal(r.doc.external, "changed");
  assert.equal(r.doc.dirty, true);
});

test("deleted on disk always raises the banner and keeps the buffer", () => {
  for (const dirty of [false, true]) {
    const r = C.onDiskProbe(doc({ dirty }), { exists: false });
    assert.deepEqual(r.action, { type: "banner", kind: "deleted" });
    assert.equal(r.doc.external, "deleted");
  }
});

test("save lifecycle: success adopts the new hash; a conflict flips to the changed state", () => {
  let d = C.beginSave(doc({ dirty: true }));
  assert.equal(d.saving, true);
  assert.equal(C.canSave(d, false), false);
  const ok = C.saveSucceeded(d, "h9");
  assert.deepEqual([ok.diskHash, ok.dirty, ok.saving, ok.external], ["h9", false, false, "none"]);
  const conflict = C.saveFailed(d, "conflict", "x");
  assert.deepEqual([conflict.external, conflict.saving, conflict.saveError], ["changed", false, null]);
  assert.equal(conflict.dirty, true);
  assert.equal(C.saveFailed(d, "exists", "x").external, "changed");
  assert.equal(C.saveFailed(d, "not_found", "x").external, "deleted");
  const other = C.saveFailed(d, "permission_denied", "Permission denied");
  assert.deepEqual([other.external, other.saveError], ["none", "Permission denied"]);
});

test("reload and keep-mine resolve the banner", () => {
  const changed = doc({ dirty: true, external: "changed" });
  const r = C.reloaded(changed, "h2");
  assert.deepEqual([r.dirty, r.external, r.diskHash], [false, "none", "h2"]);
  const k = C.keepMine(changed, "h2");
  assert.deepEqual([k.dirty, k.external, k.diskHash], [true, "none", "h2"]);
});

test("canSave rules", () => {
  assert.equal(C.canSave(doc({ dirty: true }), false), true);
  assert.equal(C.canSave(doc({ dirty: true }), true), false);
  assert.equal(C.canSave(doc(), false), false);
  assert.equal(C.canSave(doc({ dirty: true, external: "deleted" }), false), false);
});
