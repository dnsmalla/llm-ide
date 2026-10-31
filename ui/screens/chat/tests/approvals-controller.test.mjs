import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore, hangingStream, sse, until, tick, fixtures } from "./helpers.mjs";

let c, A;
before(async () => { const m = await loadChat("approvals-controller"); c = m; A = m.approvals; });
const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const initEv = { ...FX.init, sessionId: "sdk-1" };

function make(core) {
  const store = new c.MemoryChatStore();
  store.seed("a", "A");
  const ctl = new c.ChatController({ core, store, workspaceRoot: () => "/proj", newId: () => "t1", sleep: () => tick(1), abortGraceMs: 30 });
  return { ctl };
}
const decisionCore = (extra = {}) => fakeCore({
  streams: [hangingStream(sse(initEv), sse(FX.approval_request_tool, FX.approval_request_question))],
  json: { "POST /agent/v2/decision": () => ({ ok: true }), "POST /agent/v2/cancel": { cancelled: true }, ...extra },
});

test("approval and question events park in state with the SDK session id and the offered rule", async () => {
  const { ctl } = make(decisionCore());
  ctl.send("a", "do it", { mode: "execute" });
  await until(() => ctl.getState("a").pendingApprovals.length === 2);
  const s = ctl.getState("a");
  assert.equal(s.sdkSessionId, "sdk-1");
  assert.equal(s.pendingApprovals[0].toolName, "Edit");
  assert.equal(s.pendingApprovals[0].suggestion, null);
  assert.equal(s.pendingApprovals[1].kind, "AskUserQuestion");
  ctl.abort("a");
});

test("decide posts requestId + sdkSessionId + action, removes the card, and a deny carries the note", async () => {
  const core = decisionCore();
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").pendingApprovals.length === 2);
  const id = FX.approval_request_tool.requestId;
  assert.deepEqual(await ctl.decide("a", { requestId: id, action: "allow" }), { ok: true });
  const post = core.calls.find((x) => x.path === "/agent/v2/decision");
  assert.deepEqual(post.body, { requestId: id, sdkSessionId: "sdk-1", action: "allow" });
  assert.equal(ctl.getState("a").pendingApprovals.length, 1);
  const q = FX.approval_request_question.requestId;
  assert.deepEqual(await ctl.decide("a", { requestId: q, action: "answer", answers: { "Which approach should I take?": "New channel" } }), { ok: true });
  assert.deepEqual(core.calls.filter((x) => x.path === "/agent/v2/decision")[1].body, { requestId: q, sdkSessionId: "sdk-1", action: "answer", answers: { "Which approach should I take?": "New channel" } });
  ctl.abort("a");
});

test("deny feedback is trimmed and capped; allow never carries feedback", async () => {
  const core = decisionCore();
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").pendingApprovals.length === 2);
  await ctl.decide("a", { requestId: FX.approval_request_tool.requestId, action: "deny", feedback: "  use the other file " + "x".repeat(3000) });
  const body = core.calls.find((x) => x.path === "/agent/v2/decision").body;
  assert.equal(body.feedback.length, 2000);
  assert.ok(body.feedback.startsWith("use the other file"));
  await ctl.decide("a", { requestId: FX.approval_request_question.requestId, action: "deny", feedback: "" });
  assert.ok(!("feedback" in core.calls.filter((x) => x.path === "/agent/v2/decision")[1].body));
  ctl.abort("a");
});

test("fail closed: unreachable core, expired and forbidden answers never mark a request allowed", async () => {
  let mode = "down";
  const core = decisionCore({
    "POST /agent/v2/decision": () => {
      if (mode === "down") throw Object.assign(new Error("connection refused"), { status: 0, code: "NETWORK" });
      throw Object.assign(new Error("gone"), { status: 404, code: mode });
    },
  });
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").pendingApprovals.length === 2);
  const id = FX.approval_request_tool.requestId;
  const down = await ctl.decide("a", { requestId: id, action: "allow" });
  assert.equal(down.ok, false);
  assert.equal(down.permanent, false, "a transport failure can be retried");
  assert.match(down.message, /Cannot confirm.*Nothing was allowed/);
  assert.equal(ctl.getState("a").pendingApprovals.length, 2, "still pending");
  for (const code of ["DECISION_EXPIRED", "DECISION_UNKNOWN", "DECISION_FORBIDDEN"]) {
    mode = code;
    const r = await ctl.decide("a", { requestId: id, action: "allow" });
    assert.deepEqual([r.ok, r.permanent, r.code], [false, true, code]);
  }
  assert.equal(ctl.getState("a").pendingApprovals.length, 2);
  ctl.abort("a");
});

test("stale approvals: unknown request, ended turn and missing session id are refused without a network call", async () => {
  const core = decisionCore();
  const { ctl } = make(core);
  assert.equal((await ctl.decide("a", { requestId: "x", action: "allow" })).code, "TURN_ENDED");
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").pendingApprovals.length === 2);
  assert.equal((await ctl.decide("a", { requestId: "nope", action: "allow" })).code, "NOT_PENDING");
  ctl.abort("a");
  await until(() => ctl.getState("a").phase === "idle");
  assert.equal(ctl.getState("a").pendingApprovals.length, 0, "the turn ending clears every parked request");
  assert.equal((await ctl.decide("a", { requestId: FX.approval_request_tool.requestId, action: "allow" })).code, "TURN_ENDED");
  assert.equal(core.calls.filter((x) => x.path === "/agent/v2/decision").length, 0);

  const noSession = fakeCore({ streams: [hangingStream(sse({ ...FX.init, sessionId: null }), sse(FX.approval_request_tool))], json: { "POST /agent/v2/cancel": { cancelled: true } } });
  const m = make(noSession);
  m.ctl.send("a", "go", { mode: "execute" });
  await until(() => m.ctl.getState("a").pendingApprovals.length === 1);
  const r = await m.ctl.decide("a", { requestId: FX.approval_request_tool.requestId, action: "allow" });
  assert.deepEqual([r.ok, r.code], [false, "NO_SESSION"]);
  assert.equal(noSession.calls.filter((x) => x.path === "/agent/v2/decision").length, 0);
  m.ctl.abort("a");
});

test("approval_resolved from the stream removes a card the user answered elsewhere", async () => {
  const core = fakeCore({ streams: [hangingStream(sse(initEv), sse(FX.approval_request_tool), sse(FX.approval_resolved))], json: { "POST /agent/v2/cancel": { cancelled: true } } });
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").applied >= 3);
  assert.equal(ctl.getState("a").pendingApprovals.length, 0);
  ctl.abort("a");
});

test("workspace_trust notice lands in state and is cleared only when the trusted path still matches", async () => {
  const notice = { type: "notice", kind: "workspace_trust", level: "warning", text: "untrusted", data: { path: "/proj", trusted: false, skipped: [{ kind: "mcp-stdio", name: "fs", file: ".mcp.json", withheld: true }, { bogus: true }] } };
  const core = fakeCore({ streams: [hangingStream(sse(initEv), sse(notice))], json: { "POST /agent/v2/cancel": { cancelled: true } } });
  const { ctl } = make(core);
  ctl.send("a", "go", { mode: "execute" });
  await until(() => ctl.getState("a").workspaceTrust !== null);
  assert.deepEqual(ctl.getState("a").workspaceTrust.skipped, [{ kind: "mcp-stdio", name: "fs", file: ".mcp.json", withheld: true }]);
  ctl.trustGranted("a", "/other");
  assert.notEqual(ctl.getState("a").workspaceTrust, null, "a different path does not clear it");
  ctl.trustGranted("a", "/proj");
  assert.equal(ctl.getState("a").workspaceTrust, null);
  ctl.abort("a");
});

test("decider: binding mismatch re-shows instead of sending; success, refusal and batch stop-at-first-failure", async () => {
  const mk = (id, file) => ({ requestId: id, kind: "ToolApproval", toolName: "Edit", args: { filePath: file, oldString: "a", newString: "b" }, argsSummary: null });
  let pending = [mk("a", "/p/a"), mk("b", "/p/b"), mk("c", "/p/c")];
  let ui = A.emptyQueueUi;
  const log = [];
  const dispatch = (act) => { log.push(act.type); ui = A.reduceUi(ui, act); };
  const sent = [];
  let failOn = null;
  const decider = A.makeDecider({
    getUi: () => ui, getPending: () => pending, dispatch,
    decide: async (req) => { sent.push(req.requestId); return req.requestId === failOn ? { ok: false, code: "NETWORK", message: "offline", permanent: false } : { ok: true }; },
  });
  // never shown: refused, nothing sent
  assert.equal(await decider.send(pending[0], { action: "allow" }), false);
  assert.deepEqual(sent, []);
  assert.equal(ui.cards.a.error, A.CHANGED_MESSAGE);
  // shown, then the request changes under the card: refused again, re-shown with the new digest
  for (const p of pending) dispatch({ type: "show", requestId: p.requestId, digest: A.approvalDigest(p) });
  pending = [{ ...pending[0], args: { ...pending[0].args, newString: "evil" } }, pending[1], pending[2]];
  assert.equal(await decider.send(pending[0], { action: "allow" }), false);
  assert.deepEqual(sent, []);
  assert.equal(await decider.send(pending[0], { action: "allow" }), true, "after re-showing, the same content can be answered");
  assert.deepEqual(sent, ["a"]);
  // batch: b allowed, c refused -> stops, reports 1
  failOn = "c";
  const progress = [];
  assert.equal(await decider.batch([pending[1], pending[2]], (d, t) => progress.push([d, t])), 1);
  assert.deepEqual(sent, ["a", "b", "c"]);
  assert.equal(ui.cards.c.phase, "failed");
  assert.deepEqual(progress, [[0, 2], [1, 2]]);
  // permanent refusal expires the card
  failOn = null;
  const d2 = A.makeDecider({ getUi: () => ui, getPending: () => pending, dispatch, decide: async () => ({ ok: false, code: "DECISION_EXPIRED", message: "gone", permanent: true }) });
  assert.equal(await d2.send(pending[2], { action: "allow" }), false);
  assert.equal(ui.cards.c.phase, "expired");
  // double submit is refused while in flight (a is still "submitting" until its card is pruned)
  assert.equal(ui.cards.a.phase, "submitting");
  assert.equal(await decider.send(pending[0], { action: "allow" }), false);
  assert.deepEqual(sent, ["a", "b", "c"]);
});
