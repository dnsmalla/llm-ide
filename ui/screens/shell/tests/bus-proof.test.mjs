import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createBusProofStore } = await load("bus-proof.ts");
const PROOF = "d4".repeat(32);
const status = (o = {}) => ({ state: "ready", trust: "spawned", url: "http://127.0.0.1:1", restarts: 0, pid: 1, ...o });
const tick = () => new Promise((r) => setTimeout(r, 5));

function make(initial, { reply = PROOF } = {}) {
  let st = initial;
  const ls = new Set();
  const calls = [];
  const store = createBusProofStore({
    invoke: async (cmd) => { calls.push(cmd); if (reply instanceof Error) throw reply; return reply; },
    getStatus: () => st,
    subscribeStatus: (l) => { ls.add(l); return () => ls.delete(l); },
    isHost: () => true,
  });
  return { store, calls, set: (s) => { st = s; for (const l of [...ls]) l(); } };
}

test("fetches the proof once for a spawned, ready core and serves it from memory", async () => {
  const { store, calls } = make(status());
  await tick();
  assert.equal(store.get(), PROOF);
  assert.deepEqual(calls, ["host_bus_proof"]);
});

test("never serves the proof for an adopted, pending or failed core, and drops it when trust is lost", async () => {
  const m = make(status());
  await tick();
  assert.equal(m.store.get(), PROOF);
  for (const s of [status({ trust: "adopted_unverified" }), status({ trust: "pending" }), status({ state: "restarting" }), null]) {
    m.set(s);
    assert.equal(m.store.get(), null);
  }
  const adopted = make(status({ trust: "adopted_unverified" }));
  await tick();
  assert.equal(adopted.calls.length, 0, "never even asked");
});

test("a malformed reply, a null reply or a host error yields no proof", async () => {
  for (const reply of ["nope", null, 5, new Error("denied")]) {
    const m = make(status(), { reply });
    await tick();
    assert.equal(m.store.get(), null);
  }
});
