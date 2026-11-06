import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const URL_ = "ws://127.0.0.1:3016/host-api/v1";
const CAPS = ["host", "chat", "approvals"];
const RESULTS = {
  "host.hello": { hostName: "Desk", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: CAPS, protocolVersion: 1, requiresAuth: true },
  "host.auth.token": { capabilities: CAPS },
  "host.auth.revoke": { revoked: true },
  "chat.snapshot": { messages: [] },
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake desktop: `up` false refuses the socket before it opens; `script` overrides replies per command.
function desk({ token = null, up = true, script = {} } = {}) {
  const d = { stored: token, up, script, sockets: [], timers: [], sent: [], confirms: [] };
  const tokens = { get: () => d.stored, set: (t) => { d.stored = t; } };
  const createSocket = () => {
    const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text) {
        const f = JSON.parse(text); d.sent.push(f.command);
        const out = d.script[f.command]?.(f) ?? { result: RESULTS[f.command] };
        const frame = out.error ? { type: "error", error: out.error } : { type: "response", command: f.command, result: out.result };
        queueMicrotask(() => s.onmessage?.({ data: JSON.stringify({ apiVersion: 1, id: "h", replyTo: f.id, ts: 1, rev: 1, ...frame }) }));
      },
      close() { s.readyState = 3; queueMicrotask(() => s.onclose?.()); } };
    d.sockets.push(s);
    queueMicrotask(() => { if (d.up) { s.readyState = 1; s.onopen?.(); } else s.close(); });
    return s;
  };
  d.runTimers = () => { for (const t of d.timers.splice(0)) if (t.live) t.fn(); };
  d.model = (confirm = () => true) => UI.createAppModel(URL_, {
    tokensFor: () => tokens, remember: () => {}, confirm: (m) => { d.confirms.push(m); return confirm(m); },
    connection: { createSocket, backoffMs: () => 1000, setTimer: (fn, ms) => { const t = { fn, ms, live: true }; d.timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; } },
  });
  return d;
}

test("paired browser, desktop down at load: the chat screen is adopted and keeps retrying, no Pairing", async () => {
  const d = desk({ token: "k".repeat(40), up: false });
  const m = d.model();
  m.start();
  await tick(); await tick();
  assert.ok(m.getState().session, "adopted");
  assert.equal(m.getState().session.connection.state.kind, "reconnecting");
  const out = html(h(UI.App, { model: m }));
  assert.match(out, /Reconnecting in 1 s/);
  assert.match(out, /isn&#x27;t reachable yet — retrying|isn't reachable yet — retrying/);
  assert.doesNotMatch(out, /Pairing PIN|LLMIDE_HOST_API_WEB_ORIGINS/);
  d.up = true; d.runTimers(); await tick(); await tick();
  assert.equal(m.getState().session.connection.state.kind, "ready");
  m.dispose();
});

test("a token revoked mid-session returns to Pairing with the revoked notice", async () => {
  const d = desk({ token: "k".repeat(40) });
  const m = d.model();
  m.start();
  await tick(); await tick();
  assert.equal(m.getState().session.connection.state.kind, "ready");
  d.script["host.auth.token"] = () => ({ error: { code: "auth_failed", message: "Unknown token.", retryable: false } });
  d.sockets.at(-1).close(); // the desktop drops the socket
  await tick();
  d.runTimers(); await tick(); await tick(); await tick();
  assert.equal(m.getState().session, null);
  assert.equal(d.stored, null);
  const out = html(h(UI.App, { model: m }));
  assert.match(out, /Pairing PIN/);
  assert.ok(out.includes("removed or expired this browser"), out);
  m.dispose();
});

test("throttled pairing says too many attempts, not wrong PIN", async () => {
  const d = desk({ script: { "host.auth.pair": () => ({ error: { code: "auth_failed", message: "Slow down.", retryable: true, details: { retryAfterMs: 30000 } } }) } });
  const m = d.model();
  await m.attempt(URL_, "123456");
  assert.equal(m.getState().error, "Too many attempts — wait 30 s and try again.");
  assert.match(html(h(UI.App, { model: m })), /Too many attempts/);
  m.dispose();
});

test("forget asks first; a declined confirm keeps the session and the token", async () => {
  const d = desk({ token: "k".repeat(40) });
  let answer = false;
  const m = d.model(() => answer);
  m.start();
  await tick(); await tick();
  m.forget();
  await tick();
  assert.deepEqual(d.confirms, [UI.FORGET_CONFIRM]);
  assert.ok(m.getState().session);
  assert.ok(d.stored);
  answer = true;
  m.forget();
  await tick(); await tick();
  assert.equal(m.getState().session, null);
  assert.equal(d.stored, null);
  assert.ok(d.sent.includes("host.auth.revoke"));
  assert.equal(m.getState().notice, null, "revoked on the host, and not mistaken for a revocation notice");
  m.dispose();
});

const fakeSync = (phase) => {
  const state = { phase, pairStep: null, sas: null, busy: false, error: null, notice: null, online: true, email: '', snapshot: null, stale: false, checkedAt: null, pending: [], answered: [] };
  return { getState: () => state, subscribe: () => () => {}, start: async () => {}, dispose: () => {}, pause: () => {}, resume: () => {},
    acceptLink: () => true, pair: async () => {}, cancelPairing: () => {}, unlock: async () => {}, refresh: async () => {}, send: async () => true, lock: async () => {}, forget: async () => {} };
};

test("sync: desktop unreachable and this browser linked shows the sync tier; desktop live shows the chat", async () => {
  const down = desk({ token: "k".repeat(40), up: false });
  const m = down.model();
  m.start(); await tick(); await tick();
  assert.match(html(h(UI.App, { model: m, sync: fakeSync("locked") })), /offline sync/);
  const up = desk({ token: "k".repeat(40) });
  const m2 = up.model();
  m2.start(); await tick(); await tick(); await tick();
  const out = html(h(UI.App, { model: m2, sync: fakeSync("locked") }));
  assert.doesNotMatch(out, /offline sync/);
  assert.match(out, /Clear history/);
});

test("sync: never paired and not linked shows Pairing with the paste-a-link form", () => {
  const m = desk().model();
  const out = html(h(UI.App, { model: m, sync: fakeSync("none") }));
  assert.match(out, /Pairing link/);
  assert.match(out, /Pair browser/);
});

test("sync: while the first connection attempt is running, the sync tier does not flash before the chat", () => {
  const up = desk({ token: "k".repeat(40) });
  const m = up.model();
  m.start(); // attempt in flight: busy, no session yet
  assert.equal(m.getState().busy, true);
  assert.doesNotMatch(html(h(UI.App, { model: m, sync: fakeSync("locked") })), /offline sync/);
});

test("sources: Pairing and the sync tier both offer documents and code", () => {
  const m = desk().model();
  assert.match(html(h(UI.App, { model: m, sync: fakeSync("none") })), /Open documents and code/);
  const down = desk({ up: false }).model();
  assert.match(html(h(UI.App, { model: down, sync: fakeSync("locked") })), />Documents and code<\/button>/);
});
