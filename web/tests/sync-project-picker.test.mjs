// Offline project picker data (cached list, default selection) and the per-desktop project selection key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineProjectChoice, projectListStoreFor, projectStoreFor, tokenStoreFor, lastHostUrl } from "../src/host-api/storage.ts";

const U1 = "wss://192.168.1.5:3016/host-api/v1";
const U2 = "wss://192.168.1.9:3016/host-api/v1";
const FP = "AB:CD:EF";
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

test('no cached list: nothing to pick, phone chat only', () => {
  const st = memory(); lastHostUrl(st).set(U1);
  assert.deepEqual(offlineProjectChoice(st), { projects: [], selectedId: null });
  assert.deepEqual(offlineProjectChoice(memory()), { projects: [], selectedId: null });
});

test('the picker defaults to the selected project and the list is bounded to ids and names', () => {
  const st = memory(); lastHostUrl(st).set(U1);
  projectListStoreFor(U1, st).set([{ id: "a", name: "Alpha", role: "x", token: "s" }, { id: "bad id", name: "no" }, { id: "b", name: "B".repeat(500) }]);
  projectStoreFor(U1, st).set("b");
  const c = offlineProjectChoice(st);
  assert.deepEqual(c.projects.map((p) => p.id), ["a", "b"]);
  assert.equal(c.projects[1].name.length, 120);
  assert.deepEqual(Object.keys(c.projects[0]).sort(), ["id", "name"]);
  assert.equal(c.selectedId, "b");
  projectStoreFor(U1, st).set("gone");
  assert.equal(offlineProjectChoice(st).selectedId, null, 'a selection missing from the list falls back to the phone chat');
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: "n" }));
  projectListStoreFor(U1, st).set(many);
  assert.equal(projectListStoreFor(U1, st).get().length, 200);
});

test('the project selection survives Change address (fingerprint key) and migrates the old URL-keyed value', () => {
  const st = memory();
  st.setItem("llmide.hostApi.v1.project:" + U1, "legacy1"); // written by the previous build
  const t1 = tokenStoreFor(U1, st); t1.observe({ fingerprint: FP, hostName: "Desk" }); t1.set("t".repeat(43));
  assert.equal(projectStoreFor(U1, st).get(), "legacy1", 'migrated');
  assert.equal(st.getItem("llmide.hostApi.v1.project:" + U1), null, 'old key removed');
  projectStoreFor(U1, st).set("p2");
  projectListStoreFor(U1, st).set([{ id: "p2", name: "Two" }]);
  const t2 = tokenStoreFor(U2, st, U1); t2.observe({ fingerprint: FP, hostName: "Desk" }); t2.confirm();
  assert.equal(projectStoreFor(U2, st, U1).get(), "p2");
  assert.equal(projectStoreFor(U2, st).get(), "p2", 'and after the old URL is forgotten');
  assert.deepEqual(projectListStoreFor(U2, st).get(), [{ id: "p2", name: "Two" }]);
});

test('a URL-only desktop keeps working and migrates through Change address before the fingerprint is known', () => {
  const st = memory();
  projectStoreFor(U1, st).set("p9");
  assert.equal(projectStoreFor(U2, st, U1).get(), "p9");
  assert.equal(projectStoreFor(U2, st).get(), "p9");
});
