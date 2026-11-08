import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteProjects, decodeProjects } from "../remote-projects.ts";

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const list = { projects: [
  { id: "p1", name: "Alpha", role: "member", maxMode: "execute", usdCapMonth: 20, permissions: ["model.ask", "model.exec"] },
  { id: "p2", name: "Beta", role: "viewer", maxMode: "read_only", usdCapMonth: 20, permissions: ["model.ask"] },
] };

test("remote projects load, persist per hub, and expose the role", async () => {
  const s = memory();
  const r = new RemoteProjects({ request: async () => list }, s, "sha256:AAA");
  await r.whenReady();
  assert.deepEqual(r.getState().projects.map((p) => p.id), ["p1", "p2"]);
  assert.equal(r.getState().selectedId, "p1");
  r.select("p2");
  assert.equal(new RemoteProjects({ request: async () => list }, s, "sha256:AAA").getState().selectedId, null);
  const again = new RemoteProjects({ request: async () => list }, s, "sha256:AAA");
  await again.whenReady();
  assert.equal(again.getState().selectedId, "p2");
});

test("an invented projects answer is refused", () => {
  assert.equal(decodeProjects({ projects: [{ id: "p", name: "x", role: "god", maxMode: "execute", usdCapMonth: 1, permissions: [] }] }), null);
});
