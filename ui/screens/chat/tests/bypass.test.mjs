import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore, sse, until, tick, fixtures, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("bypass"); });

const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const turn = () => [sse(FX.init, FX.mode_set), sse({ type: "delta", text: "ok" }), sse(FX.usage, FX.result)];
const tok = (n = 1) => `v2.${1900000000000 + n}.${"a".repeat(31)}${n % 10}.${"b".repeat(63)}${n % 10}`;
const forbidden = () => Object.assign(new Error("Bypass needs a fresh approval from the desktop app"), { status: 403, code: "HOST_APPROVAL_REQUIRED" });

function gateWith(tokens, extra = {}) {
  let t = 1_000;
  const dialogs = [];
  const asked = [];
  const gate = c.createBypassGate({ now: () => t, confirmSigned: async (chatId, s) => { dialogs.push(s); asked.push(chatId); const v = tokens.shift(); if (v instanceof Error) throw v; return v ?? null; }, ...extra });
  return { gate, dialogs, asked, advance: (ms) => (t += ms) };
}
function make(core, bypass) {
  const store = new c.MemoryChatStore();
  store.seed("a", "Chat A");
  store.seed("b", "Chat B");
  let n = 0;
  let root = "/proj";
  const ctl = new c.ChatController({ core, store, workspaceRoot: () => root, newId: () => `t${++n}`, sleep: () => tick(1), abortGraceMs: 30, ...(bypass ? { bypass } : {}) });
  return { ctl, setRoot: (r) => { root = r; } };
}
const streams = (core) => core.calls.filter((x) => x.method === "STREAM");
const idle = (ctl, id, n, core) => until(() => streams(core).length >= n && ctl.getState(id).phase !== "streaming" && ctl.getState(id).phase !== "aborting", 3000);

test("the token is sent once, as the allowlisted header, then dropped; later turns ride the grant without it", async () => {
  const { gate } = gateWith([tok(1)]);
  const core = fakeCore({ streams: [turn(), turn()] });
  const { ctl } = make(core, gate);
  assert.equal(await gate.request("a", "s"), "approved");
  ctl.send("a", "one", { mode: "ask", permissionMode: "bypass" });
  await idle(ctl, "a", 1, core);
  ctl.send("a", "two", { mode: "ask", permissionMode: "bypass" });
  await idle(ctl, "a", 2, core);
  const [s1, s2] = streams(core);
  assert.deepEqual(s1.headers, { "x-llmide-host-approval": tok(1) });
  assert.equal(s1.body.permissionMode, "bypass");
  assert.equal(s2.headers, undefined);
  assert.equal(s2.body.permissionMode, "bypass");
});

test("decline: nothing held, no header, Bypass is sent as Ask", async () => {
  const { gate } = gateWith([null]);
  const core = fakeCore({ streams: [turn()] });
  const { ctl } = make(core, gate);
  assert.equal(await gate.request("a", "s"), "declined");
  assert.equal(gate.live("a"), false);
  ctl.send("a", "x", { mode: "ask", permissionMode: "bypass" });
  await idle(ctl, "a", 1, core);
  assert.equal(streams(core)[0].body.permissionMode, "ask");
  assert.equal(streams(core)[0].headers, undefined);
});

test("a host error, a malformed token or a non-string reply all count as a decline", async () => {
  for (const v of [new Error("boom"), "not-a-token", "v2.1.2.3", tok(1).replace("v2.", "v1."), 7, undefined]) {
    const { gate } = gateWith([v]);
    assert.equal(await gate.request("a", "s"), "declined");
    assert.deepEqual(gate.prepare("a", "bypass"), { permissionMode: "ask" });
  }
});

test("403 HOST_APPROVAL_REQUIRED: grant ends, picker callback fires, notice shown, never retried in a loop", async () => {
  const { gate } = gateWith([tok(2)]);
  const core = fakeCore({ streams: [forbidden(), turn()] });
  const { ctl } = make(core, gate);
  const rejected = [];
  ctl.onBypassRejected = (id) => rejected.push(id);
  await gate.request("a", "s");
  ctl.send("a", "x", { mode: "ask", permissionMode: "bypass" });
  await idle(ctl, "a", 1, core);
  await tick(20);
  assert.equal(streams(core).length, 1, "exactly one request, no automatic retry");
  assert.deepEqual(rejected, ["a"]);
  assert.equal(gate.live("a"), false);
  const st = ctl.getState("a");
  assert.equal(st.phase, "error");
  assert.match(st.error.message, /Bypass needs your approval again/);
  // the user's explicit Retry runs as Ask, not as a second Bypass attempt
  ctl.retry("a");
  await idle(ctl, "a", 2, core);
  assert.equal(streams(core)[1].body.permissionMode, "ask");
  assert.equal(streams(core)[1].headers, undefined);
});

test("queued messages never take a waiting token, and ride Bypass only while the grant is live", async () => {
  // Grant not yet started (token pending) when the queued message is dequeued: it must not take the token.
  const gate2 = gateWith([tok(5)]).gate;
  await gate2.request("a", "s");
  assert.deepEqual(gate2.prepare("a", "bypass", { allowToken: false }), { permissionMode: "ask" });
  assert.equal(gate2.live("a"), true, "token still waiting for an explicit turn");
  const first = gate2.prepare("a", "bypass");
  assert.ok(first.headers);
  assert.deepEqual(gate2.prepare("a", "bypass", { allowToken: false }), { permissionMode: "bypass" }, "grant live: queued rides it");
});

test("a queued message through the controller: no header, Ask once the grant is gone", async () => {
  const { gate } = gateWith([tok(6)]);
  let release;
  const slow = async function* (signal) {
    yield* [sse(FX.init, FX.mode_set)].flatMap((s) => s.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: ?/, "")));
    await new Promise((r) => { release = r; signal.addEventListener("abort", r); });
    yield* [sse(FX.usage, FX.result)].flatMap((s) => s.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: ?/, "")));
  };
  const core = fakeCore({ streams: [slow, turn()] });
  const { ctl } = make(core, gate);
  await gate.request("a", "s");
  ctl.send("a", "first", { mode: "ask", permissionMode: "bypass" });
  await until(() => streams(core).length === 1 && release);
  ctl.send("a", "queued", { mode: "ask", permissionMode: "bypass" });
  gate.end("a"); // the chat left Bypass while the message waited
  release();
  await until(() => streams(core).length === 2 && ctl.getState("a").phase === "idle", 3000);
  assert.equal(streams(core)[0].headers["x-llmide-host-approval"], tok(6));
  assert.equal(streams(core)[1].headers, undefined);
  assert.equal(streams(core)[1].body.permissionMode, "ask");
});

test("project change and sign-out end every grant (endAll)", async () => {
  const { gate } = gateWith([tok(7), tok(8)]);
  await gate.request("a", "s");
  await gate.request("b", "s");
  gate.prepare("a", "bypass"); // grant live for a, token still waiting for b
  assert.equal(gate.live("a") && gate.live("b"), true);
  gate.endAll();
  assert.equal(gate.live("a") || gate.live("b"), false);
  assert.deepEqual(gate.prepare("a", "bypass"), { permissionMode: "ask" });
});

test("a message queued under project A is not sent under project B (and so carries nothing)", async () => {
  const { gate } = gateWith([tok(9)]);
  let release;
  const slow = async function* (signal) { await new Promise((r) => { release = r; signal.addEventListener("abort", r); }); };
  const core = fakeCore({ streams: [slow, turn()] });
  const { ctl, setRoot } = make(core, gate);
  await gate.request("a", "s");
  ctl.send("a", "first", { mode: "ask", permissionMode: "bypass" });
  await until(() => streams(core).length === 1 && release);
  ctl.send("a", "queued", { mode: "ask", permissionMode: "bypass" });
  setRoot("/other");
  release();
  await tick(40);
  assert.equal(streams(core).length, 1);
});

test("grant lasts 30 minutes from the first accepted turn, a mode change off Bypass ends it", () => {
  const { gate, advance } = gateWith([tok(10), tok(11)]);
  return gate.request("a", "s").then(() => {
    gate.prepare("a", "bypass");
    advance(c.GRANT_TTL_MS - 1);
    assert.equal(gate.live("a"), true);
    advance(2);
    assert.equal(gate.live("a"), false);
    assert.deepEqual(gate.prepare("a", "bypass"), { permissionMode: "ask" });
    return gate.request("a", "s");
  }).then(() => {
    assert.equal(gate.live("a"), true);
    assert.deepEqual(gate.prepare("a", "accept-edits"), { permissionMode: "accept-edits" });
    assert.equal(gate.live("a"), false);
  });
});

test("an already-approved chat is not asked again; no host gate means Bypass is Ask", async () => {
  const { gate, dialogs } = gateWith([tok(12)]);
  await gate.request("a", "s");
  assert.equal(await gate.request("a", "s"), "approved");
  assert.equal(dialogs.length, 1);
  const core = fakeCore({ streams: [turn()] });
  const { ctl } = make(core, null); // browser/dev: no gate
  ctl.send("a", "x", { mode: "ask", permissionMode: "bypass" });
  await idle(ctl, "a", 1, core);
  assert.equal(streams(core)[0].body.permissionMode, "ask");
  assert.equal(streams(core)[0].headers, undefined);
});

test("summary is a fixed template: title and folder, stripped and capped", () => {
  const s = c.bypassSummary("Fix‮ the\nbug " + "x".repeat(200), "/Users/me/very/deep/proj\u0007");
  assert.match(s, /^Chat "Fix the bug x+…" in deep\/proj$/);
  assert.ok(s.length < 160);
  assert.equal(c.bypassSummary("", null), 'Chat "Untitled chat" in no project');
});

test("no token in any controller state, snapshot or log output after a Bypass turn", async () => {
  const { gate } = gateWith([tok(13)]);
  const core = fakeCore({ streams: [turn()] });
  const { ctl } = make(core, gate);
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => logs.push(a.map(String).join(" "));
  try {
    await gate.request("a", "s");
    ctl.send("a", "x", { mode: "ask", permissionMode: "bypass" });
    await idle(ctl, "a", 1, core);
  } finally { Object.assign(console, orig); }
  const needle = tok(13);
  assert.ok(!JSON.stringify(ctl.getState("a")).includes(needle));
  assert.ok(!JSON.stringify(streams(core)[0].body).includes(needle));
  assert.ok(!logs.join("\n").includes(needle));
  assert.ok(!JSON.stringify(Object.keys(gate)).includes("v2."));
  for (const k of Object.keys(gate)) assert.ok(!String(gate[k]).includes(needle));
});

test("ModeBanner: red BYPASS ON only while the grant is live, otherwise 'needs approval'", () => {
  const A = c.approvals;
  const live = html(h(A.ModeBanner, { mode: "bypass", bypassLive: true }));
  assert.match(live, /data-mode="bypass"/);
  assert.match(live, /BYPASS ON/);
  const pending = html(h(A.ModeBanner, { mode: "bypass", bypassLive: false }));
  assert.match(pending, /data-mode="bypass-pending"/);
  assert.match(pending, /needs approval/);
  assert.doesNotMatch(pending, /BYPASS ON/);
});

test("the host is asked to sign for THIS chat (the token is chat-bound), and a legacy v1 token is dropped unseen", async () => {
  const { gate, asked } = gateWith([tok(20), tok(21).replace("v2.", "v1.")]);
  assert.equal(await gate.request("chat-a", "s"), "approved");
  assert.equal(await gate.request("chat-b", "s"), "declined", "v1 shape is not accepted");
  assert.deepEqual(asked, ["chat-a", "chat-b"]);
});
