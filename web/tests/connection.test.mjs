import { test } from "node:test";
import assert from "node:assert/strict";
import { HostConnection, HostApiError, ORIGIN_HINT } from "../src/host-api/connection.ts";

const CAPS = ["host", "chat", "approvals"];
const RESULTS = {
  "host.hello": { hostName: "Desk", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: CAPS, protocolVersion: 1, requiresAuth: true },
  "host.auth.token": { capabilities: CAPS },
  "host.auth.pair": { token: "t".repeat(43), capabilities: CAPS },
  "host.auth.revoke": { revoked: true },
  "chat.snapshot": { messages: [] },
  "chat.send": { accepted: true },
};

function harness({ token = null, script = {} } = {}) {
  let stored = token, rev = 0;
  const sockets = [], timers = [], sent = [];
  const tokens = { get: () => stored, set: (t) => { stored = t; } };
  const reply = (s, obj) => queueMicrotask(() => s.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }));
  const host = (s, f) => {
    const handler = script[f.command];
    const out = handler ? handler(f) : { result: RESULTS[f.command] };
    if (out === null) return; // swallow: lets a test time out
    if (out.error) reply(s, { apiVersion: 1, id: `h-${++rev}`, replyTo: f.id, type: "error", error: out.error, ts: 1, rev });
    else reply(s, { apiVersion: 1, id: `h-${++rev}`, replyTo: f.id, type: "response", command: f.command, result: out.result, ts: 1, rev });
  };
  const createSocket = () => {
    const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text) { const f = JSON.parse(text); sent.push(f); host(s, f); },
      close() { s.readyState = 3; queueMicrotask(() => s.onclose?.()); } };
    sockets.push(s);
    queueMicrotask(() => { s.readyState = 1; s.onopen?.(); });
    return s;
  };
  const conn = new HostConnection({
    url: "ws://127.0.0.1:3016/host-api/v1", clientName: "LLM-IDE Web", clientVersion: "0.1.0", tokens, createSocket,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    backoffMs: (n) => n * 1000,
  });
  const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  const event = (s, command, payload, r, replyTo) => reply(s, { apiVersion: 1, id: `h-e${r}`, type: "event", command, payload, ts: 1, rev: r, ...(replyTo ? { replyTo } : {}) });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { conn, sockets, sent, timers, runTimers, event, reply, tick, token: () => stored };
}

test("hello then token auth reaches ready, fires one resync, and sends a well-formed hello", async () => {
  const h = harness({ token: "k".repeat(40) });
  let resyncs = 0; h.conn.onResync(() => resyncs++);
  assert.equal(await h.conn.connect(), "ready");
  const hello = h.sent[0];
  assert.deepEqual({ ...hello, id: undefined, ts: undefined }, { apiVersion: 1, id: undefined, type: "request", command: "host.hello", ts: undefined,
    payload: { clientName: "LLM-IDE Web", clientVersion: "0.1.0", platform: "web", apiVersions: [1] } });
  assert.match(hello.id, /^c-[0-9a-f-]{36}$/);
  assert.deepEqual(h.sent.map((f) => f.command), ["host.hello", "host.auth.token"]);
  assert.equal(resyncs, 1);
  assert.deepEqual([...h.conn.capabilities], CAPS);
});

test("no token: needsPin, then the PIN pairs once and the token is stored", async () => {
  const h = harness();
  assert.equal(await h.conn.connect(), "needsPin");
  await h.conn.pair("123456");
  assert.equal(h.conn.state.kind, "ready");
  assert.equal(h.token(), "t".repeat(43));
  assert.equal(h.sent.filter((f) => JSON.stringify(f).includes("123456")).length, 1, "the PIN travels in exactly one frame");
});

test("a wrong PIN rejects with auth_failed and stays at needsPin", async () => {
  const h = harness({ script: { "host.auth.pair": () => ({ error: { code: "auth_failed", message: "Wrong PIN.", retryable: false } }) } });
  await assert.rejects(h.conn.connect("000000"), (e) => e instanceof HostApiError && e.code === "auth_failed" && !e.retryable);
  assert.equal(h.conn.state.kind, "needsPin");
  assert.equal(h.token(), null);
});

test("a revoked token is deleted and the page asks for a PIN", async () => {
  const h = harness({ token: "k".repeat(40), script: { "host.auth.token": () => ({ error: { code: "auth_failed", message: "Revoked.", retryable: false } }) } });
  assert.equal(await h.conn.connect(), "needsPin");
  assert.equal(h.token(), null);
});

test("a host without v1 fails clearly", async () => {
  const h = harness({ script: { "host.hello": () => ({ result: { ...RESULTS["host.hello"], apiVersions: [2] } }) } });
  await assert.rejects(h.conn.connect(), (e) => e.code === "internal" && /does not speak Host API v1/.test(e.message));
  assert.equal(h.conn.state.kind, "failed");
});

test("send is gated locally by state and capability, without a frame", async () => {
  const h = harness({ token: "k".repeat(40) });
  await assert.rejects(h.conn.send("chat.snapshot", {}).done, (e) => e.code === "host_unreachable");
  await h.conn.connect();
  const before = h.sent.length;
  await assert.rejects(h.conn.send("toolApprovals.answer", { requestId: "r", commandId: "c", decision: "deny" }).done, (e) => e.code === "capability_unavailable");
  assert.equal(h.sent.length, before);
});

test("timeouts resend an idempotent command once and never a non-idempotent one", async () => {
  const h = harness({ token: "k".repeat(40), script: { "chat.snapshot": () => null, "chat.send": () => null } });
  await h.conn.connect();
  const snap = h.conn.send("chat.snapshot", { limit: 10 });
  const send = h.conn.send("chat.send", { text: "hi" });
  h.runTimers(); // first timeout: snapshot resent, send rejected
  await assert.rejects(send.done, (e) => e.code === "host_unreachable");
  assert.equal(h.sent.filter((f) => f.id === snap.id).length, 2);
  assert.equal(h.sent.filter((f) => f.id === send.id).length, 1);
  h.runTimers();
  await assert.rejects(snap.done, (e) => e.code === "host_unreachable");
});

test("events are delivered, a rev gap triggers resync, host.capabilities updates the set first", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  let resyncs = 0; h.conn.onResync(() => resyncs++);
  const seen = [];
  h.conn.onEvent((e) => seen.push([e.command, e.rev, [...h.conn.capabilities].includes("tool_approvals")]));
  const s = h.sockets[0];
  h.event(s, "chat.delta", { text: "a" }, 3, "c-1");
  h.event(s, "host.capabilities", { capabilities: [...CAPS, "tool_approvals", "bogus"] }, 4);
  await h.tick();
  assert.equal(resyncs, 0, "contiguous revs do not resync");
  h.event(s, "chat.delta", { text: "b" }, 9, "c-1");
  h.event(s, "nope.event", {}, 10);
  h.reply(s, "not json");
  await h.tick();
  assert.deepEqual(seen, [["chat.delta", 3, false], ["host.capabilities", 4, true], ["chat.delta", 9, true]]);
  assert.equal(resyncs, 1);
  assert.deepEqual([...h.conn.capabilities].sort(), [...CAPS, "tool_approvals"].sort());
});

test("an unexpected close rejects pending work, backs off, re-auths with the token and resyncs", async () => {
  const h = harness({ token: "k".repeat(40), script: { "chat.snapshot": () => null } });
  await h.conn.connect();
  let resyncs = 0; h.conn.onResync(() => resyncs++);
  const pending = h.conn.send("chat.snapshot", {});
  h.sockets[0].close();
  await assert.rejects(pending.done, (e) => e.code === "host_unreachable");
  assert.deepEqual(h.conn.state, { kind: "reconnecting", attempt: 1, inMs: 1000 });
  h.runTimers(); // the backoff timer reopens
  await h.tick(); await h.tick();
  assert.equal(h.conn.state.kind, "ready");
  assert.equal(h.sockets.length, 2);
  assert.equal(resyncs, 1);
});

test("a never-paired page that cannot connect shows the origin hint and does not retry", async () => {
  const h = harness();
  const p = h.conn.connect();
  h.sockets[0].onopen = null; // the handshake is refused before open (wrong URL, host down, origin not allowed)
  h.sockets[0].close();
  await assert.rejects(p, (e) => e.code === "host_unreachable");
  assert.deepEqual(h.conn.state, { kind: "failed", code: "host_unreachable", message: ORIGIN_HINT });
  assert.equal(h.timers.filter((t) => t.live).length, 0);
});

test("forget revokes with the stored token, deletes it and closes", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  assert.equal(await h.conn.forget(), true);
  assert.deepEqual(h.sent.at(-1).payload, { token: "k".repeat(40) });
  assert.equal(h.token(), null);
  assert.equal(h.conn.state.kind, "idle");
});
