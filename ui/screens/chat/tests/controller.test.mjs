import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore, hangingStream, sse, until, tick, fixtures } from "./helpers.mjs";
import { budget } from "../../test-support/perf.ts";

let c;
before(async () => { c = await loadChat("controller"); });

const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const turn = (...extra) => [sse(FX.init, FX.mode_set), sse({ type: "delta", text: "Hello " }, { type: "delta", text: "world" }), ...extra, sse(FX.usage, FX.result)];

function make(core, extra = {}) {
  const store = new c.MemoryChatStore();
  store.seed("a", "Chat A");
  store.seed("b", "Chat B");
  let n = 0;
  const persistErrors = [];
  const ctl = new c.ChatController({ core, store, workspaceRoot: () => "/proj", newId: () => `t${++n}`, sleep: () => tick(1), abortGraceMs: 30, onPersistError: (id, e) => persistErrors.push([id, e]), ...extra });
  return { ctl, store, persistErrors };
}
const liveGate = () => ({ prepare: (_id, m) => ({ permissionMode: m }), live: () => true, rejected() {}, end() {}, endAll() {}, msLeft: () => null, subscribe: () => () => {}, request: async () => "approved" });
const msgs = async (store, id) => (await store.loadMessages(id, { limit: 100 })).messages;

test("a turn streams to completion, sends the right body, and persists both sides", async () => {
  const core = fakeCore({ streams: [turn()] });
  const { ctl, store } = make(core);
  ctl.send("a", "  hi there  ", { mode: "auto", model: "claude-sonnet-5", provider: "anthropic", permissionMode: "ask" });
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").turnSeq === 1 && ctl.getState("a").messages.at(-1)?.status === "done");
  const call = core.calls.find((x) => x.method === "STREAM");
  assert.equal(call.path, "/agent/v2/stream");
  assert.equal(call.body.message, "hi there");
  assert.equal(call.body.mode, "auto");
  assert.deepEqual(call.body.agentContext, { chatSessionId: "a", workspaceRoot: "/proj", surface: "desktop" });
  assert.equal(call.body.permissionMode, "ask");
  assert.equal(ctl.getState("a").resolvedMode, "execute");
  await until(async () => true);
  await tick(5);
  const rows = await msgs(store, "a");
  assert.deepEqual(rows.map((r) => [r.role, r.content]), [["user", "hi there"], ["assistant", "Hello world"]]);
  assert.deepEqual(rows[1].meta?.tokenUsage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 40000, cacheCreationTokens: 8000 });
});

test("switching chats never touches a running turn (background sessions)", async () => {
  const core = fakeCore({ streams: [hangingStream(sse(FX.init), sse({ type: "delta", text: "partial" })), turn()] });
  const { ctl } = make(core);
  ctl.send("a", "long task", { mode: "execute" });
  await until(() => ctl.getState("a").applied >= 2);
  assert.deepEqual(ctl.busyIds(), ["a"]);
  // user goes to chat B and runs a whole turn there
  await ctl.open("b");
  ctl.send("b", "quick", { mode: "ask" });
  await until(() => ctl.getState("b").messages.at(-1)?.status === "done");
  assert.equal(ctl.getState("a").phase, "streaming", "chat A kept running");
  assert.equal(ctl.forget("a"), false, "a running chat is never dropped");
  ctl.abort("a");
  await until(() => ctl.getState("a").phase === "idle");
});

test("Stop: client abort + server cancel, idle well inside 2 s, message marked aborted, partial text persisted", async () => {
  const core = fakeCore({ streams: [hangingStream(sse(FX.init), sse({ type: "delta", text: "half an answ" }))], json: { "POST /agent/v2/cancel": { cancelled: true } } });
  const { ctl, store } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").applied >= 2);
  const t0 = Date.now();
  ctl.abort("a");
  assert.equal(ctl.getState("a").phase, "aborting");
  await until(() => ctl.getState("a").phase === "idle");
  assert.ok(Date.now() - t0 < budget(500), `idle after ${Date.now() - t0} ms`);
  assert.equal(ctl.getState("a").messages.at(-1).status, "aborted");
  assert.ok(core.calls.some((x) => x.path === "/agent/v2/cancel" && x.body.chatSessionId === "a"));
  await tick(5);
  assert.equal((await msgs(store, "a")).at(-1).content, "half an answ");
});

test("Stop still returns to idle when a transport swallows the abort (grace timer)", async () => {
  const stuck = async function* () { yield JSON.stringify(FX.init); await new Promise(() => {}); };
  const core = fakeCore({ streams: [stuck], json: { "POST /agent/v2/cancel": { cancelled: true } } });
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "ask" });
  await until(() => ctl.getState("a").applied >= 1);
  ctl.abort("a");
  await until(() => ctl.getState("a").phase === "idle", 1000);
});

test("messages sent while streaming are queued and sent in order after the turn", async () => {
  const core = fakeCore({ streams: [turn(), turn()] });
  const { ctl } = make(core);
  ctl.send("a", "first", { mode: "ask" });
  ctl.send("a", "second", { mode: "ask" });
  assert.deepEqual(ctl.getState("a").queue, ["second"]);
  await until(() => core.calls.filter((x) => x.method === "STREAM").length === 2 && ctl.getState("a").phase === "idle" && ctl.getState("a").queue.length === 0 && ctl.getState("a").messages.at(-1).status === "done");
  const sent = core.calls.filter((x) => x.method === "STREAM").map((x) => x.body.message);
  assert.deepEqual(sent, ["first", "second"]);
  assert.equal(ctl.getState("a").messages.filter((m) => m.role === "user").length, 2);
});

test("server error event ends the turn; retry resends the same text", async () => {
  const core = fakeCore({ streams: [[sse(FX.init), sse({ type: "error", code: "ENGINE_ERROR", message: "boom", retryable: true })], turn()] });
  const { ctl, store } = make(core);
  ctl.send("a", "do it", { mode: "execute" });
  await until(() => ctl.getState("a").phase === "error");
  assert.equal(ctl.getState("a").error.message, "boom");
  ctl.retry("a");
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1)?.status === "done");
  const sent = core.calls.filter((x) => x.method === "STREAM");
  assert.deepEqual(sent.map((x) => x.body.message), ["do it", "do it"]);
  assert.equal(ctl.getState("a").messages.filter((m) => m.role === "user").length, 1, "the failed attempt's bubbles were replaced");
  await tick(5);
  assert.equal((await msgs(store, "a")).filter((r) => r.role === "user").length, 1, "the user message is persisted once");
});

test("SESSION_UNRESUMABLE retries with a fresh SDK session", async () => {
  const core = fakeCore({ streams: [[sse(FX.error)], turn()] });
  const { ctl } = make(core);
  ctl.send("a", "x", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "error");
  ctl.retry("a");
  await until(() => core.calls.filter((x) => x.method === "STREAM").length === 2);
  assert.equal(core.calls.filter((x) => x.method === "STREAM")[1].body.fresh, true);
});

test("stream dropped mid-turn (core restart): retryable error, then reconnect by retry works", async () => {
  const core = fakeCore({ streams: [[sse(FX.init), sse({ type: "delta", text: "par" })], turn()] });
  const { ctl } = make(core);
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "error");
  assert.equal(ctl.getState("a").error.code, "STREAM_ENDED");
  ctl.retry("a");
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
});

test("transport failure before the stream: unreachable core is a retryable error", async () => {
  const core = fakeCore({ streams: [new Error("connect ECONNREFUSED")] });
  const { ctl } = make(core);
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "error");
  assert.equal(ctl.getState("a").error.code, "CORE_UNREACHABLE");
  assert.equal(ctl.getState("a").error.retryable, true);
});

test("409 TURN_IN_PROGRESS right after a Stop is retried until the server lock clears", async () => {
  const busy = new c.CoreHttpError(409, "TURN_IN_PROGRESS", "A turn is already in progress");
  const core = fakeCore({ streams: [busy, busy, turn()] });
  const { ctl } = make(core);
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  assert.equal(core.calls.filter((x) => x.method === "STREAM").length, 3);
});

test("a non-409 refusal (402 cap reached) is shown, not retried", async () => {
  const core = fakeCore({ streams: [new c.CoreHttpError(402, "SESSION_TOKEN_LIMIT", "This chat reached its token limit")] });
  const { ctl } = make(core);
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "error");
  assert.equal(ctl.getState("a").error.code, "SESSION_TOKEN_LIMIT");
  assert.equal(core.calls.filter((x) => x.method === "STREAM").length, 1);
});

test("history: open loads the newest page, loadOlder pages back without duplicates", async () => {
  const core = fakeCore();
  const { ctl, store } = make(core);
  store.seed("big", "Big", Array.from({ length: 250 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i + 1}` })));
  await ctl.open("big");
  let s = ctl.getState("big");
  assert.equal(s.messages.length, 100);
  assert.equal(s.messages[0].seq, 151);
  assert.equal(s.hasMoreOlder, true);
  assert.equal(await ctl.loadOlder("big"), 100);
  assert.equal(await ctl.loadOlder("big"), 50);
  s = ctl.getState("big");
  assert.equal(s.messages.length, 250);
  assert.equal(s.hasMoreOlder, false);
  assert.deepEqual(s.messages.map((m) => m.seq), Array.from({ length: 250 }, (_, i) => i + 1));
  assert.equal(await ctl.loadOlder("big"), 0);
});

test("per-chat view state (draft, scroll) is kept per chat", () => {
  const { ctl } = make(fakeCore());
  ctl.setView("a", { draft: "typing in a", scrollTop: 420, stickToBottom: false });
  ctl.setView("b", { draft: "in b" });
  assert.deepEqual([ctl.getView("a").draft, ctl.getView("a").scrollTop, ctl.getView("b").draft, ctl.getView("b").scrollTop], ["typing in a", 420, "in b", null]);
});

test("a persistence failure never breaks the turn and is reported", async () => {
  const core = fakeCore({ streams: [turn()] });
  const { ctl, store, persistErrors } = make(core);
  store.appendMessage = async () => { throw new Error("disk full"); };
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  await until(() => persistErrors.length >= 2);
});

test("malformed and unknown events are counted/ignored without stopping the stream", async () => {
  const core = fakeCore({ streams: [[sse(FX.init), 'data: {"type":"delta","text":5}\n\ndata: {"type":"from_the_future"}\n\n', sse({ type: "delta", text: "ok" }), sse(FX.result)]] });
  const { ctl } = make(core);
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  assert.equal(ctl.getState("a").ignored, 1);
  assert.equal(c.assistantText(ctl.getState("a").messages.at(-1)), "ok");
});

test("remote busy hint reads the core's running chat turns", async () => {
  const core = fakeCore({ json: { "GET /kb/os/state": { running: { chatTurns: [{ chatSessionId: "b" }] } } } });
  const { ctl } = make(core);
  await ctl.refreshRemoteBusy();
  assert.equal(ctl.isRemoteBusy("b"), true);
  assert.equal(ctl.isRemoteBusy("a"), false);
});

test("subscribers are notified, and unsubscribe stops it", async () => {
  const core = fakeCore({ streams: [turn()] });
  const { ctl } = make(core);
  let n = 0;
  const off = ctl.subscribe(() => n++);
  ctl.send("a", "q", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  assert.ok(n >= 2);
  off();
  const before = n;
  ctl.setView("a", { draft: "x" });
  ctl.send("b", "z", { mode: "ask" });
  assert.equal(n, before);
});

test("a 10k-delta reply is micro-batched: far fewer state commits than events, text intact", async () => {
  const deltas = Array.from({ length: 10_000 }, (_, i) => JSON.stringify({ type: "delta", text: i % 25 === 24 ? "w.\n\n" : "w " }));
  const core = fakeCore({ streams: [async function* () { yield JSON.stringify(FX.init); for (const d of deltas) yield d; yield JSON.stringify(FX.result); }] });
  const { ctl } = make(core);
  let commits = 0;
  ctl.subscribe(() => commits++);
  const t0 = Date.now();
  ctl.send("a", "long", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done", 10_000);
  assert.ok(commits < 1500, `${commits} commits for 10002 events`);
  assert.ok(Date.now() - t0 < budget(5000));
  const text = c.assistantText(ctl.getState("a").messages.at(-1));
  assert.equal((text.match(/w/g) ?? []).length, 10_000);
});

test("queued messages keep their OWN options: nothing is sent with the next message's attachments or permission mode", async () => {
  const core = fakeCore({ streams: [turn(), turn(), turn()] });
  const { ctl } = make(core, { bypass: liveGate() });
  const a1 = [{ path: "one.txt", content: "1" }], a2 = [{ path: "two.txt", content: "2" }];
  ctl.send("a", "first", { mode: "ask" });
  ctl.send("a", "second", { mode: "ask", attachments: a1, permissionMode: "ask" });
  ctl.send("a", "third", { mode: "execute", attachments: a2, permissionMode: "bypass", planExecute: true, fresh: true });
  await until(() => core.calls.filter((x) => x.method === "STREAM").length === 3 && ctl.getState("a").phase === "idle" && ctl.getState("a").queue.length === 0 && ctl.getState("a").messages.at(-1).status === "done", 3000);
  const [b1, b2, b3] = core.calls.filter((x) => x.method === "STREAM").map((x) => x.body);
  assert.deepEqual([b1.message, b2.message, b3.message], ["first", "second", "third"]);
  assert.equal(b1.attachments, undefined);
  assert.deepEqual(b2.attachments, a1);
  assert.equal(b2.permissionMode, "ask");
  assert.equal(b2.planExecute, undefined);
  assert.equal(b2.fresh, undefined);
  assert.deepEqual(b3.attachments, a2);
  assert.equal(b3.permissionMode, "bypass");
  assert.equal(b3.planExecute, true);
  assert.equal(b3.mode, "execute");
});

test("a dropped queued message does not shift the options of the others", async () => {
  const core = fakeCore({ streams: [turn(), turn()] });
  const { ctl } = make(core);
  ctl.send("a", "first", { mode: "ask" });
  ctl.send("a", "dropped", { mode: "ask", permissionMode: "bypass" });
  ctl.send("a", "kept", { mode: "ask", permissionMode: "ask" });
  ctl.dropQueued("a", 0);
  await until(() => core.calls.filter((x) => x.method === "STREAM").length === 2 && ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1).status === "done", 3000);
  const bodies = core.calls.filter((x) => x.method === "STREAM").map((x) => x.body);
  assert.deepEqual(bodies.map((b) => b.message), ["first", "kept"]);
  assert.equal(bodies[1].permissionMode, "ask");
});

test("a message queued for project A is not run in project B: it goes back to the composer", async () => {
  let root = "/projA";
  const core = fakeCore({ streams: [turn(), turn()] });
  const { ctl } = make(core, { workspaceRoot: () => root });
  ctl.send("a", "first", { mode: "ask" });
  ctl.send("a", "for project A", { mode: "ask" });
  ctl.send("a", "also A", { mode: "ask" });
  root = "/projB"; // the user switched project while the first turn ran
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").queue.length === 0 && ctl.getState("a").messages.at(-1).status === "done", 3000);
  await tick(20);
  const sent = core.calls.filter((x) => x.method === "STREAM");
  assert.equal(sent.length, 1, "only the first message ran");
  assert.equal(sent[0].body.agentContext.workspaceRoot, "/projA");
  assert.equal(ctl.getView("a").draft, "for project A\n\nalso A");
  assert.ok(ctl.getView("a").draftRev > 0);
  assert.ok(ctl.getState("a").messages.some((m) => m.role === "assistant" && m.notices.some((n) => n.text === "Project changed: message kept as a draft")));
  assert.equal(ctl.getState("a").messages.filter((m) => m.role === "user").length, 1, "no bubble for unsent messages");
});

test("queued messages run in the project they were typed in", async () => {
  let root = "/projA";
  const core = fakeCore({ streams: [turn(), turn()] });
  const { ctl } = make(core, { workspaceRoot: () => root });
  ctl.send("a", "first", { mode: "ask" });
  ctl.send("a", "second", { mode: "ask" });
  await until(() => core.calls.filter((x) => x.method === "STREAM").length === 2 && ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1).status === "done", 3000);
  assert.deepEqual(core.calls.filter((x) => x.method === "STREAM").map((x) => x.body.agentContext.workspaceRoot), ["/projA", "/projA"]);
});

test("StrictMode double effect (mount, unmount, mount) leaves the controller alive; only an explicit dispose stops it", async () => {
  const core = fakeCore({ streams: [turn(), turn(), turn()] });
  const { ctl, store } = make(core);
  // dev StrictMode: effect, cleanup, effect - all synchronous
  const off1 = ctl.mount(); off1(); const off2 = ctl.mount();
  await tick(5);
  ctl.send("a", "first", { mode: "ask" });
  ctl.send("a", "second", { mode: "ask" });
  await until(() => core.calls.filter((x) => x.method === "STREAM").length === 2 && ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1).status === "done", 3000);
  await tick(10);
  assert.deepEqual((await msgs(store, "a")).map((r) => r.role), ["user", "assistant", "user", "assistant"], "persistence and the queue still work");
  off1(); // a repeated cleanup call is a no-op
  await tick(5);
  ctl.send("a", "third", { mode: "ask" }); // still alive
  assert.equal(ctl.getState("a").phase, "streaming");
  off2(); // the real unmount: the turn keeps being read (see the dock test below)
  await tick(5);
  assert.equal(ctl.getState("a").phase !== "idle" || ctl.getState("a").messages.at(-1).status === "done", true, "the unmount did not drop the turn");
  ctl.dispose();
  assert.deepEqual(await ctl.reattachRunning(), [], "disposed: no re-attach");
});

test("a dock closed mid-turn keeps reading: the reply is saved with no view, and a parked approval is kept", async () => {
  let finish;
  const done = new Promise((r) => { finish = r; });
  // A turn that parks an approval, then (once answered, here: released) finishes.
  const parked = async function* (signal) {
    for (const ev of [FX.init, { type: "delta", text: "Hello " }, FX.approval_request_tool]) yield JSON.stringify(ev);
    await Promise.race([done, new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))]);
    for (const ev of [{ type: "delta", text: "world" }, FX.usage, FX.result]) yield JSON.stringify(ev);
  };
  const core = fakeCore({ streams: [parked] });
  const { ctl, store } = make(core);
  const off = ctl.mount();
  ctl.send("a", "hi", { mode: "ask" });
  await until(() => ctl.getState("a").pendingApprovals.length === 1);
  off(); // the dock collapses, or the popup closes, mid-turn
  await tick(10);
  assert.equal(ctl.getState("a").phase, "streaming", "the stream is still being read");
  assert.equal(ctl.getState("a").pendingApprovals.length, 1, "the approval is not dropped with the view");
  assert.deepEqual(ctl.pendingApprovalCounts(), [{ chatId: "a", count: 1 }], "and it is still reported for the app-wide badge");
  finish();
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").messages.at(-1).status === "done");
  await tick(10);
  assert.deepEqual((await msgs(store, "a")).map((r) => [r.role, r.content]), [["user", "hi"], ["assistant", "Hello world"]], "saved without the view ever coming back");
  assert.deepEqual(ctl.pendingApprovalCounts(), [], "nothing waits once the turn has ended");
});

test("fullHistoryNext: a marker, then exactly the next message carries continueMode replay (cleared only after the next message is accepted)", async () => {
  const core = fakeCore({ streams: [turn(), turn(), turn()] });
  const { ctl } = make(core);
  ctl.send("a", "one", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  ctl.fullHistoryNext("a");
  ctl.fullHistoryNext("a");
  const marks = ctl.getState("a").messages.at(-1).notices.filter((x) => x.kind === "full_history_next");
  assert.equal(marks.length, 1, "asking twice adds one marker");
  assert.equal(marks[0].text, c.FULL_HISTORY_NEXT_NOTICE);
  ctl.send("a", "two", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done" && ctl.getState("a").turnSeq === 2);
  ctl.send("a", "three", { mode: "ask" });
  await until(() => ctl.getState("a").turnSeq === 3 && ctl.getState("a").messages.at(-1)?.status === "done");
  const bodies = core.calls.filter((x) => x.method === "STREAM").map((x) => x.body);
  assert.equal(bodies[0].continueMode, undefined);
  assert.equal(bodies[1].continueMode, "replay");
  assert.equal(bodies[2].continueMode, undefined);
});

test("a stream that dies mid-reply keeps the partial text as Interrupted", async () => {
  // A generator stream yields payloads (the framing is stripped, as the real transport does).
  const dying = async function* () {
    yield JSON.stringify(FX.init);
    yield JSON.stringify({ type: "delta", text: "half a repl" });
    throw new Error("the core went away");
  };
  const core = fakeCore({ streams: [dying] });
  const { ctl, store } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").phase === "error");
  const live = ctl.getState("a").messages.at(-1);
  assert.equal(live.role, "assistant");
  assert.equal(live.interrupted, true, "the live bubble says Interrupted, not only after a reload");
  await tick(5);
  const rows = await msgs(store, "a");
  const last = rows.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.content, "half a repl", "what arrived before the stream died is kept");
  assert.equal(last.meta?.interrupted, true);
  assert.equal(last.meta?.status, "interrupted");
});

test("retry replaces the interrupted partial and keeps the conversation context (U#F5)", async () => {
  const dying = async function* () {
    yield JSON.stringify(FX.init);
    yield JSON.stringify({ type: "delta", text: "half a repl" });
    throw new Error("the core went away");
  };
  const core = fakeCore({ streams: [dying, turn()] });
  const { ctl, store } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").phase === "error");
  assert.equal(ctl.getState("a").messages.at(-1).interrupted, true);
  ctl.retry("a");
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done" || ctl.getState("a").phase === "done");
  assert.equal(ctl.getState("a").messages.some((m) => m.role === "assistant" && m.interrupted), false,
    "the partial is gone, the full reply is the only assistant turn");
  assert.equal(ctl.getState("a").messages.filter((m) => m.role === "user").length, 1, "the retried message appears once in the view");
  const body = core.calls.filter((x) => x.method === "STREAM").at(-1).body;
  assert.notEqual(body.fresh, true, "the retry keeps the conversation context (no fresh session)");
  await tick(5);
  const rows = await msgs(store, "a");
  assert.deepEqual(rows.map((r) => [r.role, r.content]), [["user", "go"], ["assistant", "Hello world"]],
    "the dead turn's partial is gone from the store too; the full reply is the only assistant row");
});

test("retry drops only THIS turn's partial: an older interrupted partial and other turns stay, and a reload is clean (U#F5)", async () => {
  const dying = async function* () {
    yield JSON.stringify(FX.init);
    yield JSON.stringify({ type: "delta", text: "half a repl" });
    throw new Error("the core went away");
  };
  const core = fakeCore({ streams: [dying, turn()] });
  const { ctl, store } = make(core);
  store.seed("a", "Chat A", [
    { role: "user", content: "q1" },
    { role: "assistant", content: "old partial", meta: { interrupted: true, status: "interrupted" } },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
  await ctl.open("a");
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").phase === "error");
  ctl.retry("a");
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  await tick(5);

  const rows = await msgs(store, "a");
  assert.deepEqual(rows.map((r) => [r.role, r.content]), [
    ["user", "q1"], ["assistant", "old partial"], ["user", "q2"], ["assistant", "a2"], ["user", "go"], ["assistant", "Hello world"],
  ], "the older interrupted partial and every earlier turn survive; the dead turn's partial is gone");
  assert.equal(rows.filter((r) => r.content === "go").length, 1, "the retried user message is stored once");
  assert.equal(rows[1].meta?.interrupted, true, "the kept older partial is still marked Interrupted");

  // A reload is a new controller over the same store (the app reopens the chat from the file).
  const ctl2 = new c.ChatController({ core: fakeCore(), store, workspaceRoot: () => "/proj", newId: () => "reload", sleep: () => tick(1) });
  await ctl2.open("a");
  const view = ctl2.getState("a").messages;
  assert.deepEqual(view.map((m) => (m.role === "user" ? m.text : c.assistantText(m))), [
    "q1", "old partial", "q2", "a2", "go", "Hello world",
  ], "the reload shows history + the retried turn, never the partial and the full reply side by side");
  assert.equal(view.some((m) => m.role === "assistant" && m.interrupted && c.assistantText(m) === "half a repl"), false);
});


test("a failed history load is a load error with its own state, never a turn error; a later open() clears it", async () => {
  const core = fakeCore();
  const { ctl, store } = make(core);
  const real = store.loadMessages.bind(store);
  let down = true;
  store.loadMessages = async (...args) => { if (down) throw Object.assign(new Error("core down"), { status: 0, code: "NETWORK" }); return real(...args); };
  await ctl.open("a");
  const failed = ctl.getState("a");
  assert.equal(failed.phase, "idle", "no turn error: the Retry banner is not a dead button");
  assert.equal(failed.error, null);
  assert.ok(failed.loadError, "the load error is kept apart");
  down = false;
  await ctl.open("a");
  assert.equal(ctl.getState("a").loadError, null);
  assert.equal(ctl.getState("a").phase, "idle");
});

test("a message that cannot be saved is reported to the screen (and onPersistError), and the notice stays until dismissed", async () => {
  const core = fakeCore({ streams: [turn()] });
  const { ctl, store, persistErrors } = make(core);
  store.appendMessage = async () => { throw Object.assign(new Error("disk full"), { status: 500, code: "DISK" }); };
  ctl.send("a", "hi", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  await tick(5);
  assert.ok(persistErrors.length >= 1, "onPersistError is passed");
  assert.match(ctl.getPersistFailure() ?? "", /could not be saved/);
  ctl.dismissPersistFailure();
  assert.equal(ctl.getPersistFailure(), null);
});

test("a message sent while the queue is full is not dropped: its text goes back to the composer", async () => {
  const core = fakeCore({ streams: [hangingStream(sse(FX.init))] });
  const { ctl } = make(core);
  ctl.send("a", "long task", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "streaming");
  for (let i = 0; i < c.MAX_QUEUE; i++) ctl.send("a", `queued ${i}`, { mode: "ask" });
  assert.equal(ctl.getState("a").queue.length, c.MAX_QUEUE);
  ctl.send("a", "one too many", { mode: "ask" });
  assert.equal(ctl.getState("a").queue.length, c.MAX_QUEUE, "the reducer still caps the queue");
  assert.equal(ctl.getView("a").draft, "one too many", "the refused text is kept in the composer");
  ctl.abort("a");
  await until(() => ctl.getState("a").phase === "idle");
});

test("a chat waiting for an approval is listed by the controller, even when it is not the open chat", async () => {
  const core = fakeCore({
    streams: [hangingStream(sse(FX.init), sse(FX.approval_request_tool))],
  });
  const { ctl } = make(core);
  ctl.send("b", "edit it", { mode: "ask" });
  await until(() => ctl.getState("b").pendingApprovals.length === 1);
  assert.deepEqual(ctl.approvalChatIds(), ["b"]);
  ctl.abort("b");
  await until(() => ctl.getState("b").phase === "idle");
  assert.deepEqual(ctl.approvalChatIds(), []);
});

test("a question asked again while the history loads is kept; a live copy claims only a trailing saved row", async () => {
  const core = fakeCore({ streams: [[sse(FX.init, FX.result)], [sse(FX.init, FX.result)]] });
  const store = new c.MemoryChatStore();
  store.seed("a", "Chat A", [{ role: "user", content: "continue" }, { role: "assistant", content: "Sure." }]);
  store.seed("b", "Chat B", [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "go" }]);
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const load = store.loadMessages.bind(store);
  store.loadMessages = async (...args) => { const page = await load(...args); await gate; return page; };
  const ctl = new c.ChatController({ core, store, workspaceRoot: () => "/proj", newId: () => "t1", sleep: () => tick(1) });
  const openA = ctl.open("a");
  const openB = ctl.open("b");
  ctl.send("a", "continue", { mode: "ask" }); // answered earlier: a repeated question, not a copy
  ctl.send("b", "go", { mode: "ask" }); // still unanswered in the page: this live message is the saved copy
  release();
  await Promise.all([openA, openB]);
  await until(() => ctl.getState("a").phase === "idle" && ctl.getState("b").phase === "idle");
  const count = (id, content) => ctl.getState(id).messages.filter((m) => m.role === "user" && m.text === content).length;
  assert.equal(count("a", "continue"), 2, "the repeated question is shown after the earlier answered one");
  assert.equal(count("b", "go"), 1, "the saved copy of a live message is not shown twice");
});

test("a stream that drops with an approval parked leaves nothing counted for the app-wide badge", async () => {
  // No attach transport (the plain browser): the stream just ends, with no terminal event.
  const core = fakeCore({ streams: [[sse(FX.init), sse(FX.approval_request_tool)]] });
  const { ctl } = make(core);
  ctl.send("a", "hi", { mode: "ask" });
  await until(() => ctl.getState("a").phase === "error");
  assert.equal(ctl.getState("a").error.code, "STREAM_ENDED");
  assert.deepEqual(ctl.getState("a").pendingApprovals, [], "the turn is over: its approval can no longer be answered");
  assert.deepEqual(ctl.pendingApprovalCounts(), []);
});
