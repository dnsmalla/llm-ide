import { test } from "node:test";
import assert from "node:assert/strict";
import { HostConnection, HostApiError, ORIGIN_HINT, PING_MS } from "../src/host-api/connection.ts";

const CAPS = ["host", "chat", "approvals"];
const RESULTS = {
  "host.hello": { hostName: "Desk", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: CAPS, protocolVersion: 1, requiresAuth: true },
  "host.auth.token": { capabilities: CAPS },
  "host.auth.pair": { token: "t".repeat(43), capabilities: CAPS },
  "host.auth.revoke": { revoked: true },
  "chat.snapshot": { messages: [] },
  "chat.send": { accepted: true },
  "host.ping": {},
};

function harness({ token = null, script = {} } = {}) {
  let stored = token, rev = 0;
  const sockets = [], timers = [], sent = [];
  const wake = { fns: new Set() };
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
    onWake: (fn) => { wake.fns.add(fn); return () => { wake.fns.delete(fn); }; },
  });
  const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  const event = (s, command, payload, r, replyTo) => reply(s, { apiVersion: 1, id: `h-e${r}`, type: "event", command, payload, ts: 1, rev: r, ...(replyTo ? { replyTo } : {}) });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fireWake = () => { for (const fn of wake.fns) fn(); };
  return { conn, sockets, sent, timers, runTimers, event, reply, tick, token: () => stored, wake, fireWake };
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

test("a request timeout while ready closes a half-open socket so the client reconnects", async () => {
  const h = harness({ token: "k".repeat(40), script: { "chat.snapshot": () => null } });
  await h.conn.connect();
  const snap = h.conn.send("chat.snapshot", { limit: 10 });
  h.runTimers(); // resent once
  h.runTimers(); // gives up
  await assert.rejects(snap.done, (e) => e.code === "host_unreachable");
  assert.equal(h.sockets[0].readyState, 3);
  await h.tick();
  assert.equal(h.conn.state.kind, "reconnecting");
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
  assert.deepEqual(h.conn.state, { kind: "reconnecting", attempt: 1, inMs: 1000, unopened: 0 });
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

test("a handshake timeout closes the socket so the client reconnects instead of hanging", async () => {
  const h = harness({ token: "k".repeat(40), script: { "host.hello": () => null } });
  const p = h.conn.connect();
  await h.tick();
  h.runTimers(); // idempotent hello resent
  h.runTimers(); // second timeout
  await assert.rejects(p, (e) => e.code === "host_unreachable");
  assert.equal(h.conn.state.kind, "reconnecting");
});

test("a second connect() closes the old socket and ignores its late frames", async () => {
  const h = harness({ token: "k".repeat(40) });
  const first = h.conn.connect(); // still connecting when superseded
  const second = h.conn.connect();
  await assert.rejects(first, (e) => e.code === "host_unreachable");
  assert.equal(await second, "ready");
  assert.equal(h.sockets.length, 2);
  let seen = 0; h.conn.onEvent(() => seen++);
  h.event(h.sockets[0], "chat.delta", { text: "x" }, 1, "c-1");
  await h.tick();
  assert.equal(seen, 0);
});

test("the PIN does not outlive authentication", async () => {
  let revoke = false;
  const h = harness({ token: "k".repeat(40), script: { "host.auth.token": () => revoke ? { error: { code: "auth_failed", message: "Revoked.", retryable: false } } : { result: { capabilities: CAPS } } } });
  assert.equal(await h.conn.connect("123456"), "ready");
  revoke = true;
  h.sockets[0].close();
  await h.tick();
  h.runTimers();
  await h.tick(); await h.tick();
  assert.equal(h.conn.state.kind, "needsPin");
  assert.equal(h.sent.some((f) => f.command === "host.auth.pair"), false);
});

test("a pairing reply without capabilities is rejected and no token is kept", async () => {
  const h = harness({ script: { "host.auth.pair": () => ({ result: { token: "t".repeat(43) } }) } });
  await assert.rejects(h.conn.connect("123456"), (e) => /invalid pairing reply/.test(e.message));
  assert.equal(h.token(), null);
  assert.equal(h.conn.state.kind, "needsPin");
});

test("refused sends and timeouts never surface as unhandled rejections", async () => {
  const seen = [];
  const on = (e) => seen.push(e);
  process.on("unhandledRejection", on);
  try {
    const h = harness({ token: "k".repeat(40) });
    h.conn.send("chat.snapshot", {}); // not ready: refused locally, result dropped
    const p = h.conn.connect();
    h.sockets[0].onopen = null; h.sockets[0].close();
    await h.tick(); await h.tick();
    assert.equal(seen.length, 0);
    void p;
  } finally { process.off("unhandledRejection", on); }
});

const pingTimers = (h) => h.timers.filter((t) => t.live && t.ms === PING_MS);
const firePing = (h) => { const t = pingTimers(h)[0]; t.live = false; t.fn(); };

test("while ready the client pings every PING_MS and keeps pinging after each answer", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  assert.equal(pingTimers(h).length, 1);
  firePing(h);
  assert.equal(h.sent.at(-1).command, "host.ping");
  assert.deepEqual(h.sent.at(-1).payload, {});
  await h.tick();
  assert.equal(pingTimers(h).length, 1, "the next ping is scheduled after the answer");
  assert.equal(h.conn.state.kind, "ready");
});

test("close clears the ping timer", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  assert.equal(pingTimers(h).length, 1);
  h.conn.close();
  assert.equal(pingTimers(h).length, 0);
});

test("an unanswered ping drops the half-open socket at once and reconnects", async () => {
  const h = harness({ token: "k".repeat(40), script: { "host.ping": () => null } });
  await h.conn.connect();
  firePing(h);
  h.sockets[0].close = () => {}; // a dead TCP socket: the browser never reports the close
  h.runTimers(); // ping resent once
  h.runTimers(); // gives up
  await h.tick();
  assert.equal(h.conn.state.kind, "reconnecting");
  assert.equal(pingTimers(h).length, 0);
});

test("a wake (page visible, network back) reconnects now instead of waiting out the backoff", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  h.sockets[0].close();
  await h.tick();
  assert.equal(h.conn.state.kind, "reconnecting");
  const backoff = h.timers.find((t) => t.live && t.ms === 1000);
  h.fireWake();
  assert.equal(backoff.live, false, "the backoff timer is cleared");
  await h.tick(); await h.tick();
  assert.equal(h.conn.state.kind, "ready");
  assert.equal(h.sockets.length, 2);
  h.fireWake(); // ready: check the socket with a ping
  assert.equal(h.sent.at(-1).command, "host.ping");
  h.conn.close();
  assert.equal(h.wake.fns.size, 0, "close() stops listening");
  assert.equal(h.timers.filter((t) => t.live).length, 0, "close() clears every timer");
});

test("consecutive attempts whose socket never opened are counted and reset by an open", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  h.sockets[0].close(); // opened once: not counted
  await h.tick();
  assert.equal(h.conn.state.unopened, 0);
  for (let i = 1; i <= 3; i++) {
    h.runTimers();
    const s = h.sockets.at(-1);
    s.onopen = null; // refused before open (origin, certificate, port)
    s.close();
    await h.tick();
    assert.equal(h.conn.state.unopened, i);
  }
  h.runTimers();
  await h.tick(); await h.tick();
  assert.equal(h.conn.state.kind, "ready");
  h.sockets.at(-1).close();
  await h.tick();
  assert.equal(h.conn.state.unopened, 0);
});
