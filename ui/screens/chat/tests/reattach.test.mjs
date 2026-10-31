// Turn re-attach (core API 96): detach flag, follow-after-drop, replay sequence rules, markers, 404/429, Stop, bounds.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore, hangingStream, sse, until, tick, fixtures } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("reattach"); });

const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const frame = (id, ev) => ({ id: id === null ? null : String(id), data: typeof ev === "string" ? ev : JSON.stringify(ev) });
const delta = (text) => ({ type: "delta", text });
const httpErr = (status, code) => Object.assign(new Error(code), { status, code });

function make(core, extra = {}) {
  const store = new c.MemoryChatStore();
  store.seed("a", "Chat A", [{ role: "user", content: "earlier question" }]);
  let n = 0;
  const ctl = new c.ChatController({ core, store, workspaceRoot: () => "/proj", newId: () => `t${++n}`, sleep: () => tick(1), abortGraceMs: 30, ...extra });
  return { ctl, store };
}
const text = (st) => st.messages.at(-1).parts.map((p) => (p.kind === "text" ? p.sealed.join("") + p.open + p.line : "")).join("");

test("detach is requested only when the transport can re-attach", async () => {
  const withAttach = fakeCore({ streams: [[sse(FX.init, FX.result)]], attaches: [] });
  make(withAttach).ctl.send("a", "hi", { mode: "ask" });
  await until(() => withAttach.calls.some((x) => x.method === "STREAM"));
  assert.equal(withAttach.calls.find((x) => x.method === "STREAM").body.detach, true);
  const plain = fakeCore({ streams: [[sse(FX.init, FX.result)]] });
  make(plain).ctl.send("a", "hi", { mode: "ask" });
  await until(() => plain.calls.some((x) => x.method === "STREAM"));
  assert.equal("detach" in plain.calls.find((x) => x.method === "STREAM").body, false);
});

test("a dropped primary stream is followed from the last event: continuity, no duplicates", async () => {
  // The primary stream delivered 3 frames (init, delta, delta) and closed; the replay re-sends frames 2..N around the cursor.
  const core = fakeCore({
    streams: [[sse(FX.init), sse(delta("Hello ")), sse(delta("wor"))]],
    attaches: [[frame(3, delta("wor")), frame(2, delta("Hello ")), frame(4, delta("ld")), frame(5, FX.result)]],
  });
  const { ctl, store } = make(core);
  ctl.send("a", "hi", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1)?.status === "done");
  assert.match(core.calls.find((x) => x.method === "ATTACH").path, /^\/agent\/v2\/turns\/stream\?sessionId=a&after=3$/);
  assert.equal(text(ctl.getState("a")), "Hello world", "stale ids 3 and 2 are ignored, 4 is applied once");
  await tick(5);
  const rows = (await store.loadMessages("a", { limit: 50 })).messages;
  assert.equal(rows.at(-1).content, "Hello world", "the complete reply is saved");
});

test("replay frames: non-monotonic, repeated and unnumbered frames are never applied", async () => {
  const core = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "2026-10-31T00:00:00Z", mode: "ask" }] } },
    attaches: [[frame(1, FX.init), frame(2, delta("A")), frame(2, delta("X")), frame(1, delta("Y")), frame(null, delta("Z")), frame("abc", delta("W")), frame(0, delta("V")), frame(3, delta("B")), frame(4, FX.result)]],
  });
  const { ctl } = make(core);
  assert.deepEqual(await ctl.reattachRunning(), ["a"]);
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1)?.role === "assistant");
  assert.equal(text(ctl.getState("a")), "AB");
});

test("reattachRunning attaches at 0, shows a gap marker for replay_info, and does not save an incomplete reply", async () => {
  const core = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] } },
    attaches: [[{ id: null, data: JSON.stringify({ type: "replay_info", gap: 5, dropped: 5, ended: false }) }, frame(6, delta("tail")), frame(7, { type: "replay_truncated", originalType: "tool_result" }), frame(8, FX.result)]],
  });
  const { ctl, store } = make(core);
  await ctl.open("a");
  await ctl.reattachRunning();
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1)?.status === "done");
  assert.match(core.calls.find((x) => x.method === "ATTACH").path, /after=0$/);
  const st = ctl.getState("a");
  assert.equal(st.messages[0].text, "earlier question", "history stays; no user bubble is added");
  const kinds = st.messages.at(-1).notices.map((n) => n.kind);
  assert.deepEqual(kinds, ["replay_gap", "replay_truncated"]);
  assert.ok(st.messages.at(-1).notices.every((n) => n.visible && n.level === "warning"));
  await tick(10);
  assert.equal((await store.loadMessages("a", { limit: 50 })).messages.length, 1, "an incomplete reply is not written to the history");
});

test("a chat already live here is not re-attached; a missing or malformed list attaches nothing", async () => {
  const core = fakeCore({
    streams: [hangingStream(sse(FX.init))],
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: null }] } },
    attaches: [],
  });
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "streaming");
  assert.deepEqual(await ctl.reattachRunning(), []);
  ctl.abort("a");
  const bad = fakeCore({ json: { "GET /agent/v2/turns": { turns: "nope" } }, attaches: [] });
  assert.deepEqual(await make(bad).ctl.reattachRunning(), []);
  assert.deepEqual(c.decodeRunningTurns({ turns: [{ sessionId: "x".repeat(201) }, { sessionId: "" }, 5, { sessionId: "ok", startedAt: 3 }] }), [{ sessionId: "ok", startedAt: "" }]);
  assert.equal(c.decodeRunningTurns({ turns: Array.from({ length: 200 }, (_, i) => ({ sessionId: `s${i}` })) }).length, c.MAX_REATTACH_TURNS);
});

test("404 NO_TURN on the first attach: the empty bubble is removed and the history is reloaded", async () => {
  const core = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] } },
    attaches: [httpErr(404, "NO_TURN")],
  });
  const { ctl, store } = make(core);
  await store.appendMessage("a", { role: "assistant", content: "saved reply" }); // the turn finished and was saved meanwhile
  await ctl.reattachRunning();
  await until(() => ctl.getState("a").phase === "idle");
  await until(() => ctl.getState("a").messages.some((m) => m.role === "assistant" && m.parts?.[0]?.sealed?.[0] === "saved reply"));
  assert.equal(ctl.getState("a").messages.filter((m) => m.role === "assistant" && m.seq === undefined).length, 0);
});

test("429 TOO_MANY_READERS retries with backoff and then follows; a persistent 429 ends in a retryable error", async () => {
  const ok = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] } },
    attaches: [httpErr(429, "TOO_MANY_READERS"), httpErr(429, "TOO_MANY_READERS"), [frame(1, FX.init), frame(2, delta("hi")), frame(3, FX.result)]],
  });
  const { ctl } = make(ok);
  await ctl.reattachRunning();
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  assert.equal(ok.calls.filter((x) => x.method === "ATTACH").length, 3);
  const never = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] } },
    attaches: Array.from({ length: 8 }, () => httpErr(429, "TOO_MANY_READERS")),
  });
  const b = make(never).ctl;
  await b.reattachRunning();
  await until(() => b.getState("a").phase === "error");
  assert.equal(b.getState("a").error.code, "TOO_MANY_READERS");
  assert.equal(b.getState("a").error.retryable, true);
});

test("Stop works on a re-attached turn: aborts the replay read and calls the cancel route", async () => {
  const core = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] }, "POST /agent/v2/cancel": { cancelled: true } },
    attaches: [async function* (signal) {
      yield frame(1, FX.init); yield frame(2, delta("working"));
      await new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }],
  });
  const { ctl } = make(core);
  await ctl.reattachRunning();
  await until(() => text(ctl.getState("a")) === "working");
  ctl.abort("a");
  await until(() => ctl.getState("a").phase === "idle");
  assert.equal(ctl.getState("a").messages.at(-1).status, "aborted");
  const cancel = core.calls.find((x) => x.method === "POST" && x.path === "/agent/v2/cancel");
  assert.ok(cancel, "cancel route called");
  assert.equal(cancel.body.chatSessionId, "a");
});

test("2,000 buffered events are reduced in micro-batches and yield to the UI between them", async () => {
  const N = 2000;
  const frames = [frame(1, FX.init)];
  for (let i = 2; i < N; i++) frames.push(frame(i, delta(`w${i} `)));
  frames.push(frame(N, FX.result));
  const core = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] } },
    attaches: [frames],
  });
  const { ctl } = make(core);
  let renders = 0;
  ctl.subscribe(() => { renders++; });
  let timerTicks = 0;
  const iv = setInterval(() => { timerTicks++; }, 0);
  await ctl.reattachRunning();
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1)?.status === "done", 10_000);
  clearInterval(iv);
  assert.ok(renders < 120, `renders ${renders}: one pass per batch, not per event`);
  assert.ok(timerTicks > 5, `the event loop ran ${timerTicks} times during the replay`);
  assert.equal(ctl.getState("a").applied, N);
  assert.ok(text(ctl.getState("a")).startsWith("w2 w3 w4 "));
});

test("a failed re-attach with no progress gives up with an error; dispose aborts reads without cancelling the turn", async () => {
  const core = fakeCore({
    json: { "GET /agent/v2/turns": { turns: [{ sessionId: "a", startedAt: "t0", mode: "ask" }] }, "POST /agent/v2/cancel": { cancelled: true } },
    attaches: [(signal) => (async function* () { yield frame(1, FX.init); await new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); })()],
  });
  const { ctl } = make(core);
  await ctl.reattachRunning();
  await until(() => ctl.getState("a").phase === "streaming" && ctl.getState("a").applied === 1);
  ctl.dispose();
  await tick(20);
  assert.equal(core.calls.some((x) => x.path === "/agent/v2/cancel"), false, "the core keeps the detached turn running");
  assert.deepEqual(await ctl.reattachRunning(), [], "a disposed controller attaches nothing");
});

test("reducer and decoder: markers are plain notices; sequence parser is strict", () => {
  assert.equal(c.parseReplaySeq("12"), 12);
  for (const bad of [null, "", "0", "-1", "1.5", "1e3", "12345678901", " 5"]) assert.equal(c.parseReplaySeq(bad), null, String(bad));
  assert.deepEqual(c.decodeReplayMarker('{"type":"replay_info","gap":-3,"dropped":"x","ended":true}'), { kind: "info", gap: 0, dropped: 0, ended: true });
  assert.equal(c.decodeReplayMarker('{"type":"delta","text":"replay_info"}'), null);
  assert.equal(c.decodeReplayMarker("not json replay_"), null);
});
