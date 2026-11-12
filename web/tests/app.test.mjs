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
  "projects.list": { projects: [] },
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake desktop: `up` false refuses the socket before it opens; `script` overrides replies per command.
function desk({ token = null, up = true, script = {} } = {}) {
  const d = { stored: token, up, script, sockets: [], timers: [], sent: [], frames: [], confirms: [] };
  const tokens = { get: () => d.stored, set: (t) => { d.stored = t; } };
  const createSocket = () => {
    const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text) {
        const f = JSON.parse(text); d.sent.push(f.command); d.frames.push(f);
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
  d.pushDrops = 0;
  d.model = (confirm = () => true, dropPush = async () => { d.pushDrops++; }) => UI.createAppModel(URL_, {
    tokensFor: () => tokens, remember: () => {}, confirm: (m) => { d.confirms.push(m); return confirm(m); }, dropPush,
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
  assert.match(out, /Reconnecting…/);
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
  assert.equal(d.pushDrops, 1, "the browser push subscription is dropped with the host");
  m.dispose();
});

test("forget unregisters push on a host that serves it, and a failing unsubscribe never blocks the forget", async () => {
  const d = desk({ token: "k".repeat(40) });
  const caps = [...CAPS, "push"];
  d.script["host.hello"] = () => ({ result: { ...RESULTS["host.hello"], capabilities: caps } });
  d.script["host.auth.token"] = () => ({ result: { capabilities: caps } });
  d.script["push.unregister"] = () => ({ result: {} });
  const m2 = d.model(() => true, () => Promise.reject(new Error("no service worker")));
  m2.start(); await tick(); await tick();
  m2.forget(); await tick(); await tick();
  assert.ok(d.sent.indexOf("push.unregister") >= 0 && d.sent.indexOf("push.unregister") < d.sent.indexOf("host.auth.revoke"), JSON.stringify(d.sent));
  assert.equal(m2.getState().session, null);
  m2.dispose();
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

test("sources: Pairing and the sync tier both offer documents and code", async () => {
  const m = desk().model();
  assert.match(html(h(UI.App, { model: m, sync: fakeSync("none") })), /Open documents and code/);
  const down = desk({ token: "k".repeat(40), up: false }).model();
  down.start(); await tick(); await tick();
  assert.match(html(h(UI.App, { model: down, sync: fakeSync("locked") })), />Documents and code<\/button>/);
  down.dispose();
});

test("sync linked but no desktop paired: Pairing stays reachable and offers the offline copy, with the revoked notice", async () => {
  const m = desk().model();
  const out = html(h(UI.App, { model: m, sync: fakeSync("locked") }));
  assert.match(out, /Pair browser/);
  assert.match(out, /Open offline copy/);
  assert.doesNotMatch(out, /Pairing link/, "already linked: no paste-a-link form");
  const d = desk({ token: "k".repeat(40) });
  const r = d.model();
  r.start(); await tick(); await tick();
  d.script["host.auth.token"] = () => ({ error: { code: "auth_failed", message: "Unknown token.", retryable: false } });
  d.sockets.at(-1).close();
  await tick(); d.runTimers(); await tick(); await tick(); await tick();
  const revoked = html(h(UI.App, { model: r, sync: fakeSync("locked") }));
  assert.ok(revoked.includes("removed or expired this browser"), "the REVOKED notice is shown even with sync linked");
  r.dispose();
});

test("screen choice: a blip keeps Chat; SyncTier only for a paired, unreachable desktop or on request", () => {
  const base = { hub: false, syncPhase: "locked", session: true, down: false, view: "auto" };
  assert.equal(UI.chooseScreen(base), "chat");
  assert.equal(UI.chooseScreen({ ...base, down: true }), "sync");
  assert.equal(UI.chooseScreen({ ...base, down: true, view: "host" }), "chat", "Connect desktop from SyncTier");
  assert.equal(UI.chooseScreen({ ...base, session: false, down: true }), "pairing", "no session: Pairing, never SyncTier on its own");
  assert.equal(UI.chooseScreen({ ...base, session: false, view: "sync" }), "sync", "Open offline copy");
  assert.equal(UI.chooseScreen({ ...base, syncPhase: "none", down: true }), "chat");
  assert.equal(UI.chooseScreen({ ...base, hub: true, down: true }), "chat");
  assert.equal(UI.chooseScreen({ ...base, session: false, syncPhase: "pairing" }), "sync");
});

test("host unreachable: a reconnect counts only from SYNC_AFTER_ATTEMPTS once the session was live; failed at once", () => {
  const rc = (attempt) => ({ kind: "reconnecting", attempt, inMs: 1000, unopened: 0 });
  assert.equal(UI.hostUnreachable(rc(1), true), false, "a 1-2 s blip");
  assert.equal(UI.hostUnreachable(rc(UI.SYNC_AFTER_ATTEMPTS - 1), true), false);
  assert.equal(UI.hostUnreachable(rc(UI.SYNC_AFTER_ATTEMPTS), true), true);
  assert.equal(UI.hostUnreachable(rc(1), false), true, "desktop off at load: no chat to keep");
  assert.equal(UI.hostUnreachable({ kind: "failed", code: "internal", message: "x" }, true), true);
  assert.equal(UI.hostUnreachable({ kind: "ready" }, true), false);
  assert.equal(UI.hostUnreachable(null, false), false);
});

test("host unreachable: reconnecting -> connecting -> reconnecting past the threshold stays down", () => {
  const rc = (attempt) => ({ kind: "reconnecting", attempt, inMs: 1000, unopened: 0 });
  const connecting = { kind: "connecting" };
  const last = rc(UI.SYNC_AFTER_ATTEMPTS);
  assert.equal(UI.hostUnreachable(last, true, null), true);
  assert.equal(UI.hostUnreachable(connecting, true, last), true, "retry in flight keeps down");
  assert.equal(UI.hostUnreachable(rc(UI.SYNC_AFTER_ATTEMPTS + 1), true, last), true);
  assert.equal(UI.hostUnreachable(connecting, true, rc(1)), false, "a short blip stays a blip");
  assert.equal(UI.hostUnreachable(connecting, true, null), false);
});

test("sync traffic follows the same rule: paused during a blip and the first connect, running when down or shown", () => {
  const base = { hub: false, session: true, busy: false, down: false, view: "auto" };
  assert.equal(UI.syncShouldRun(base), false);
  assert.equal(UI.syncShouldRun({ ...base, down: true }), true);
  assert.equal(UI.syncShouldRun({ ...base, session: false, busy: true }), false);
  assert.equal(UI.syncShouldRun({ ...base, session: false }), true);
  assert.equal(UI.syncShouldRun({ ...base, view: "sync" }), true);
  assert.equal(UI.syncShouldRun({ ...base, hub: true, down: true }), false);
});

test("hub flips pause and resume sync and never dispose it", () => {
  const calls = [];
  const sync = { start: async () => { calls.push("start"); }, pause: () => calls.push("pause"), resume: () => calls.push("resume"), dispose: () => calls.push("dispose") };
  UI.driveSync(sync, { hub: false, run: true });
  UI.driveSync(sync, { hub: true, run: false });
  UI.driveSync(sync, { hub: false, run: true });
  assert.deepEqual(calls, ["resume", "start", "pause", "resume", "start"]);
});

test("projects: on load it asks projects.list, shows the first project and scopes the chat snapshot", async () => {
  const d = desk({ token: "k".repeat(40) });
  d.script["projects.list"] = () => ({ result: { projects: [
    { id: "p-1", name: "Alpha", role: "member", maxMode: "execute", usdCapMonth: 0, permissions: ["self.read"] },
    { id: "p-2", name: "Beta", role: "owner", maxMode: "execute", usdCapMonth: 0, permissions: [] },
  ] } });
  const m = d.model();
  m.start();
  await tick(); await tick(); await tick();
  assert.ok(d.sent.includes("projects.list"), JSON.stringify(d.sent));
  const out = html(h(UI.App, { model: m, sync: fakeSync("locked") }));
  assert.match(out, /Project/);
  assert.match(out, /Alpha/);
  assert.match(out, /member/);
  const snaps = d.frames.filter((f) => f.command === "chat.snapshot");
  assert.ok(snaps.some((f) => f.payload.projectId === "p-1"), JSON.stringify(snaps));
  m.dispose();
});

test("projects: no projects shows the empty state and keeps the chat usable", async () => {
  const d = desk({ token: "k".repeat(40), script: { "projects.list": () => ({ result: { projects: [] } }) } });
  const m = d.model();
  m.start();
  await tick(); await tick(); await tick();
  assert.match(html(h(UI.App, { model: m, sync: fakeSync("locked") })), /No projects are available to this account\./);
  m.dispose();
});
