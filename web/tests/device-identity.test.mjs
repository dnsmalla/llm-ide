import { test } from "node:test";
import assert from "node:assert/strict";
import { HostConnection, MISMATCH_NOTICE } from "../src/host-api/connection.ts";
import { tokenStoreFor } from "../src/host-api/storage.ts";
import { loadUi } from "./helpers.mjs";

const UI = await loadUi();

const CAPS = ["host", "chat", "approvals"];
const U1 = "wss://192.168.1.5:3016/host-api/v1";
const U2 = "wss://192.168.1.9:3016/host-api/v1";
const TOKEN = "k".repeat(40);
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const devices = (st) => JSON.parse(st.getItem("llmide.hostApi.v1.devices") ?? "{}");

// hosts: url -> fingerprint (undefined = dev/plaintext). Records every frame sent per url.
function net(hosts) {
  const frames = [];
  const createSocket = (url) => {
    const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text) {
        const f = JSON.parse(text); frames.push({ url, command: f.command, payload: f.payload });
        const result = f.command === "host.hello"
          ? { hostName: "Desk", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: CAPS, protocolVersion: 1, requiresAuth: true,
              ...(hosts[url] ? { certificateFingerprint: hosts[url] } : {}) }
          : f.command === "host.auth.pair" ? { token: "p".repeat(43), capabilities: CAPS } : { capabilities: CAPS };
        queueMicrotask(() => s.onmessage?.({ data: JSON.stringify({ apiVersion: 1, id: "h", replyTo: f.id, type: "response", command: f.command, result, ts: 1, rev: 1 }) }));
      },
      close() { s.readyState = 3; queueMicrotask(() => s.onclose?.()); } };
    if (url in hosts) queueMicrotask(() => { s.readyState = 1; s.onopen?.(); }); else queueMicrotask(() => s.close());
    return s;
  };
  return { frames, createSocket, sentToken: () => frames.some((f) => f.command === "host.auth.token") };
}
const conn = (url, st, n, from = null) => new HostConnection({ url, clientName: "t", clientVersion: "1", tokens: tokenStoreFor(url, st, from),
  createSocket: n.createSocket, onWake: () => () => {}, setTimer: () => 0, clearTimer: () => {} });

test("a URL-keyed token migrates to a record and gains its fingerprint on the next hello", async () => {
  const st = memory();
  st.setItem(`llmide.hostApi.v1.token:${U1}`, TOKEN);
  const n = net({ [U1]: "AA:BB" });
  assert.equal(tokenStoreFor(U1, st).get(), TOKEN);
  assert.equal(st.getItem(`llmide.hostApi.v1.token:${U1}`), null, "legacy key removed");
  assert.deepEqual(devices(st), { [U1]: { token: TOKEN, fingerprint: null, url: U1, hostName: "" } });
  assert.equal(await conn(U1, st, n).connect(), "ready");
  assert.deepEqual(devices(st), { "AA:BB": { token: TOKEN, fingerprint: "AA:BB", url: U1, hostName: "Desk" } }, "re-keyed by fingerprint");
});

test("matching fingerprint sends the token", async () => {
  const st = memory();
  tokenStoreFor(U1, st).set(TOKEN); // no hello seen: fingerprint null
  const n = net({ [U1]: "AA" });
  await conn(U1, st, n).connect();
  const n2 = net({ [U1]: "AA" });
  assert.equal(await conn(U1, st, n2).connect(), "ready");
  assert.ok(n2.sentToken());
});

test("a different fingerprint withholds the token, flags a mismatch and goes to the PIN path", async () => {
  const st = memory();
  const seeded = tokenStoreFor(U1, st); seeded.observe({ fingerprint: "AA", hostName: "Desk" }); seeded.set(TOKEN);
  const n = net({ [U1]: "ZZ" });
  const c = conn(U1, st, n);
  assert.equal(await c.connect(), "needsPin");
  assert.equal(c.mismatch, true);
  assert.equal(c.state.kind, "needsPin");
  assert.equal(c.state.mismatch, true);
  assert.equal(n.sentToken(), false, "token never sent");
  assert.equal(devices(st)["AA"].token, TOKEN, "old record kept");
  await c.pair("123456");
  assert.equal(devices(st)["ZZ"].url, U1);
  assert.equal(devices(st)["AA"], undefined, "re-pairing replaced the record for this address");
});

test("a missing fingerprint where one was recorded is a mismatch", async () => {
  const st = memory();
  const s = tokenStoreFor(U1, st); s.observe({ fingerprint: "AA", hostName: "Desk" }); s.set(TOKEN);
  const n = net({ [U1]: undefined });
  const c = conn(U1, st, n);
  assert.equal(await c.connect(), "needsPin");
  assert.equal(n.sentToken(), false);
});

test("dev mode without a fingerprint still works by URL", async () => {
  const st = memory();
  const U = "ws://127.0.0.1:3016/host-api/v1";
  tokenStoreFor(U, st).set(TOKEN);
  const n = net({ [U]: undefined });
  assert.equal(await conn(U, st, n).connect(), "ready");
  assert.ok(n.sentToken());
  assert.equal(devices(st)[U].fingerprint, null);
});

function model(st, n) {
  return UI.createAppModel(U1, { tokensFor: (u, from) => tokenStoreFor(u, st, from), remember: (u) => { st.setItem("last", u); }, confirm: () => true, dropPush: async () => {},
    connection: { createSocket: n.createSocket, onWake: () => () => {}, setTimer: () => 0, clearTimer: () => {} } });
}
const seed = (st, fp) => { const s = tokenStoreFor(U1, st); s.observe({ fingerprint: fp, hostName: "Desk" }); s.set(TOKEN); };

test("Change address with a matching fingerprint keeps the session and updates the record and last URL", async () => {
  const st = memory(); seed(st, "AA");
  const n = net({ [U1]: "AA", [U2]: "AA" });
  const m = model(st, n);
  await m.attempt(U1); await tick();
  assert.equal(m.getState().session.url, U1);
  assert.equal(await m.changeAddress(U2), null);
  assert.equal(m.getState().session.url, U2);
  assert.equal(m.getState().session.connection.state.kind, "ready");
  assert.equal(devices(st)["AA"].url, U2);
  assert.equal(Object.keys(devices(st)).length, 1);
  assert.equal(st.getItem("last"), U2);
  m.dispose();
});

test("Change address to a different desktop does not send the token and goes to the PIN path", async () => {
  const st = memory(); seed(st, "AA");
  const n = net({ [U1]: "AA", [U2]: "ZZ" });
  const m = model(st, n);
  await m.attempt(U1); await tick();
  const before = n.frames.filter((f) => f.command === "host.auth.token").length;
  assert.equal(await m.changeAddress(U2), null);
  assert.equal(n.frames.filter((f) => f.command === "host.auth.token").length, before, "no token sent to U2");
  assert.equal(m.getState().session, null);
  assert.equal(m.getState().notice, MISMATCH_NOTICE);
  assert.equal(m.initialUrl, U2);
  assert.equal(devices(st)["AA"].url, U1, "old record kept");
  m.dispose();
});

test("Change address validates the URL and reports an unreachable host without dropping the session", async () => {
  const st = memory(); seed(st, "AA");
  const m = model(st, net({ [U1]: "AA" }));
  await m.attempt(U1); await tick();
  assert.match(await m.changeAddress("ftp://x"), /must start with/);
  assert.match(await m.changeAddress(U2), /./);
  assert.equal(m.getState().session.url, U1);
  m.dispose();
});
