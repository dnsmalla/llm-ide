import { test } from "node:test";
import assert from "node:assert/strict";
import { memFs } from "./mem-fs.mjs";
import { ITEMS_FILE, addItem, attachRun, encodeItems, newWorkItem, readItems, removeItem } from "../items.ts";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const issueItem = (id, title = `Issue ${id}`) => newWorkItem({ source: "issue", id, title, body: "body", repo: "acme/web", provider: "github" }, NOW);

test("readItems returns [] when the file is missing", async () => {
  assert.deepEqual(await readItems(memFs()), []);
});

test("addItem writes a schemaVersion 1 file under system/factory", async () => {
  const fs = memFs();
  const r = await addItem(fs, issueItem("github:acme/web#12", "#12 Fix login"));
  assert.equal(r.existed, false);
  assert.equal(r.record.key, "issue:github:acme/web#12");
  assert.equal(r.record.addedAt, "2026-11-09T10:00:00.000Z");
  assert.equal(r.record.provider, "github");
  assert.equal((await readItems(fs))[0].provider, "github", "the provider survives the file round trip");
  assert.equal(newWorkItem({ source: "spec", id: "llm-doc/a.md", title: "A", body: "", repo: null }, NOW).provider, null, "provider defaults to null");
  assert.deepEqual(r.record.runIds, []);
  assert.equal(ITEMS_FILE, "system/factory/items.json");
  assert.ok(fs.dirs.has("system/factory"), "the folder is created first");
  const text = fs.files.get(ITEMS_FILE);
  assert.ok(text.endsWith("\n"));
  const stored = JSON.parse(text);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.items.length, 1);
});

test("addItem dedupes by source and id and returns existed true", async () => {
  const fs = memFs();
  const a = issueItem("github:acme/web#12", "#12 Fix login");
  await addItem(fs, a);
  const again = await addItem(fs, { ...a, title: "changed", addedAt: "2026-11-10T00:00:00.000Z" });
  assert.equal(again.existed, true);
  assert.equal(again.record.title, "#12 Fix login", "the stored record wins");
  assert.equal((await readItems(fs)).length, 1);
});

test("text items get a random key and never dedupe", async () => {
  const fs = memFs();
  const t1 = newWorkItem({ source: "text", id: null, title: "Do X", body: "", repo: null }, NOW, () => 0.1);
  const t2 = newWorkItem({ source: "text", id: null, title: "Do X", body: "", repo: null }, NOW, () => 0.2);
  assert.match(t1.key, /^text:[a-z0-9]+-[a-z0-9]{6}$/);
  assert.notEqual(t1.key, t2.key);
  assert.equal(t1.id, null);
  await addItem(fs, t1);
  await addItem(fs, t2);
  assert.equal((await readItems(fs)).length, 2);
  assert.throws(() => newWorkItem({ source: "issue", id: null, title: "x", body: "", repo: null }), /needs an id/);
  assert.throws(() => newWorkItem({ source: "text", id: null, title: "   ", body: "", repo: null }), /needs a title/);
});

test("readItems tolerates an unknown schemaVersion field and a malformed item", async () => {
  const valid = { key: "issue:x1", source: "issue", id: "x1", title: "One", body: "", repo: null, addedAt: "2026-11-09T00:00:00.000Z", runIds: ["r1", "../bad"], extra: true };
  const fs = memFs({ [ITEMS_FILE]: JSON.stringify({ schemaVersion: 2, future: { a: 1 }, items: [valid, { key: 5 }, "junk", { ...valid, key: "issue:x2", source: "nope" }, { ...valid }] }) });
  const items = await readItems(fs);
  assert.deepEqual(items.map((i) => i.key), ["issue:x1"], "malformed and duplicate-key items are dropped");
  assert.deepEqual(items[0].runIds, ["r1"], "run ids outside the run id pattern are dropped");
  assert.equal(items[0].provider, null, "a missing or unknown provider decodes to null");
  assert.equal("extra" in items[0], false);
});

test("a newer schemaVersion is read but never overwritten", async () => {
  const fs = memFs({ [ITEMS_FILE]: JSON.stringify({ schemaVersion: 2, items: [] }) });
  await assert.rejects(addItem(fs, issueItem("a")), /newer version/);
  assert.equal(JSON.parse(fs.files.get(ITEMS_FILE)).schemaVersion, 2);
});

test("a corrupt items file is reported and never overwritten", async () => {
  const fs = memFs({ [ITEMS_FILE]: "{not json" });
  await assert.rejects(readItems(fs), /not valid JSON/);
  await assert.rejects(addItem(fs, issueItem("a")), /not valid JSON/);
  assert.equal(fs.files.get(ITEMS_FILE), "{not json");
});

test("attachRun appends a run id once, removeItem drops the item, both ignore an unknown key", async () => {
  const fs = memFs();
  const a = issueItem("a");
  await addItem(fs, a);
  await attachRun(fs, a.key, "20261109-100000-abc123");
  await attachRun(fs, a.key, "20261109-100000-abc123");
  await attachRun(fs, "issue:nope", "r2");
  assert.deepEqual((await readItems(fs))[0].runIds, ["20261109-100000-abc123"]);
  await assert.rejects(attachRun(fs, a.key, "../x"), /run id/);
  await removeItem(fs, "issue:nope");
  await removeItem(fs, a.key);
  assert.deepEqual(await readItems(fs), []);
});

test("a write conflict is retried against the fresh file", async () => {
  const fs = memFs();
  const a = issueItem("a");
  const b = issueItem("b");
  await addItem(fs, a);
  // Another writer (the Issues screen) adds B between this call's read and its write.
  fs.beforeWrite = () => fs.put(ITEMS_FILE, encodeItems([a, b]));
  const c = newWorkItem({ source: "spec", id: "llm-doc/c.md", title: "C", body: "", repo: null }, NOW);
  const r = await addItem(fs, c);
  assert.equal(r.existed, false);
  assert.deepEqual((await readItems(fs)).map((i) => i.key), ["issue:a", "issue:b", "spec:llm-doc/c.md"]);
});
