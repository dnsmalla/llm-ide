import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createChatController } from "../src/chat/controller.ts";
import { createComposeController } from "../src/chat/compose.ts";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeLink(results = {}, caps = ["host", "chat", "approvals", "compose", "tool_approvals"]) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = []; let n = 0;
  return {
    capabilities: new Set(caps), calls,
    send(command, payload) {
      const id = `c-${++n}`; calls.push({ id, command, payload });
      const r = results[command];
      return { id, done: Promise.resolve(typeof r === "function" ? r(payload) : r ?? {}) };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    emit: (e) => ls.event.forEach((fn) => fn(e)),
    resync: () => ls.resync.forEach((fn) => fn()),
    state: (st) => ls.state.forEach((fn) => fn(st)),
  };
}

test("two surfaces keep separate threads (one turn at a time per connection): each names its own surface and only takes events for its own turn", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.snapshot": { messages: [] }, "chat.new": { sessionId: "s" }, "chat.history.clear": { cleared: true } });
  const ask = createChatController(link);
  const exec = createChatController(link, { surface: "execute" });
  await exec.send("fix the test", { model: "m" });
  const sent = link.calls.find((c) => c.command === "chat.send");
  assert.deepEqual(sent.payload, { text: "fix the test", model: "m", surface: "execute", mode: "execute" });
  assert.equal(exec.getState().turn, sent.id);
  assert.equal(ask.getState().turn, null);
  link.emit({ command: "chat.delta", payload: { text: "done it" }, rev: 1, replyTo: sent.id });
  assert.deepEqual(exec.getState().messages.map((m) => m.text), ["fix the test", "done it"]);
  assert.deepEqual(ask.getState().messages, []);
  // An Ask send in the same session carries no surface and no forced mode.
  link.emit({ command: "chat.done", payload: { requestId: sent.id }, rev: 2, replyTo: sent.id });
  await ask.send("what is this");
  const asked = link.calls.filter((c) => c.command === "chat.send").at(-1);
  assert.deepEqual(asked.payload, { text: "what is this" });
  assert.equal(exec.getState().messages.length, 2);
  // snapshot / new / delete all name the execute surface; Ask's do not.
  await exec.resync(); await exec.newChat(); await exec.clearHistory(); await ask.resync();
  const by = (cmd) => link.calls.filter((c) => c.command === cmd).map((c) => c.payload);
  assert.deepEqual(by("chat.snapshot"), [{ limit: 200, surface: "execute" }, { limit: 200 }]);
  assert.deepEqual(by("chat.new"), [{ surface: "execute" }]);
  assert.deepEqual(by("chat.history.clear"), [{ surface: "execute" }]);
});

test("a tool approval lands on the surface whose turn asked, and answering it is per surface", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "toolApprovals.answer": { accepted: true } });
  const ask = createChatController(link);
  const exec = createChatController(link, { surface: "execute" });
  await exec.send("edit it");
  const turn = exec.getState().turn;
  link.emit({ command: "toolApproval.request", payload: { requestId: "r-1", commandId: turn, toolName: "Edit", summary: "- a\n+ b", filePath: "x.mjs", truncated: false }, rev: 1, replyTo: turn });
  assert.equal(exec.getState().approvals.length, 1);
  assert.equal(ask.getState().approvals.length, 0);
  await exec.answerTool("r-1", "allow_once");
  assert.deepEqual(link.calls.at(-1).payload, { requestId: "r-1", commandId: turn, decision: "allow_once" });
  assert.equal(exec.getState().approvals.length, 0);
});

test("after a drop the execute turn waits, then resumes by its own request id and keeps streaming state", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.resume": { state: "running", text: "partial" }, "chat.snapshot": { messages: [] } });
  const exec = createChatController(link, { surface: "execute" });
  await exec.send("long job");
  const turn = exec.getState().turn;
  link.state({ kind: "reconnecting" });
  assert.equal(exec.getState().waiting, true);
  link.resync(); await tick();
  assert.deepEqual(link.calls.find((c) => c.command === "chat.resume").payload, { requestId: turn });
  assert.equal(exec.getState().waiting, false);
  assert.equal(exec.getState().messages.at(-1).text, "partial");
  assert.equal(exec.getState().turn, turn);
});

test("compose: Ask never offers execute; the Execute compose keeps it and sends no mode (the controller does)", async () => {
  const options = { "chat.options": { modes: ["auto", "ask", "execute"], models: [{ model: "m1", label: "M1" }] } };
  const ask = createComposeController(fakeLink(options)); await ask.load();
  assert.deepEqual(ask.getState().modes, ["auto", "ask"]);
  const exec = createComposeController(fakeLink(options), { surface: "execute" }); await exec.load();
  assert.ok(exec.getState().modes.includes("execute"));
  assert.equal(exec.getState().mode, "execute");
  exec.setModel("m1");
  assert.deepEqual(exec.extras(), { model: "m1" });
});

test("execute availability: needs compose + tool_approvals and a host that offers it", () => {
  const caps = (...c) => new Set(["host", ...c]);
  const cs = (modes) => ({ ...UI.initialComposeState, modes });
  assert.deepEqual(UI.executeAvailability(caps("chat", "compose", "tool_approvals"), cs(["auto", "execute"])), { ok: true, loading: false });
  assert.deepEqual(UI.executeAvailability(caps("chat", "compose"), cs([])), { ok: false, reason: "no_grant" });
  assert.deepEqual(UI.executeAvailability(caps("chat", "tool_approvals"), cs([])), { ok: false, reason: "no_grant" });
  assert.deepEqual(UI.executeAvailability(caps("chat", "compose", "tool_approvals"), cs(["auto", "ask"])), { ok: false, reason: "not_offered" });
  assert.deepEqual(UI.executeAvailability(new Set(), cs([])), { ok: true, loading: true }, "capabilities unknown: no flash");
  assert.deepEqual(UI.executeAvailability(caps("chat", "compose", "tool_approvals"), cs([])), { ok: true, loading: true }, "still loading");
  assert.deepEqual(UI.executeAvailability(caps("chat", "compose", "tool_approvals"), { ...cs([]), error: "boom" }), { ok: false, reason: "load_failed" });
});

test("execute section: a failed chat.options shows an explanation with Retry, not the composer", () => {
  const sl = slice(); sl.compose = { ...sl.compose, modes: [], error: "boom" }; sl.actions.reload = noop;
  const out = html(h(UI.Shell, { ctx: ctx({ execute: sl }), forceSection: "execute" }));
  assert.match(out, /Could not check whether Execute is available/); assert.match(out, />Retry</); assert.doesNotMatch(out, /<textarea/);
});

test("one turn per connection: each composer is disabled while the other surface has a turn, with a hint", () => {
  const running = [{ type: "sent", commandId: "c-1", text: "go" }].reduce(UI.reduce, UI.initialChatState);
  assert.notEqual(running.turn, null);
  const askOut = html(h(UI.Shell, { ctx: ctx({ execute: slice(running) }), forceSection: "ask" }));
  assert.match(askOut, /Execute is running/); assert.match(askOut, /Go to Execute/);
  assert.match(askOut, /aria-label="Mode: [^"]*"[^>]*disabled/);
  const execOut = html(h(UI.Shell, { ctx: ctx({ chat: running, execute: slice() }), forceSection: "execute" }));
  assert.match(execOut, /Ask is replying/); assert.match(execOut, /Go to Ask/);
  assert.match(execOut, /aria-label="Model: [^"]*"[^>]*disabled/);
  assert.doesNotMatch(html(h(UI.Shell, { ctx: ctx({ execute: slice() }), forceSection: "ask" })), /Execute is running/);
  assert.doesNotMatch(html(h(UI.Shell, { ctx: ctx({ execute: slice() }), forceSection: "execute" })), /Ask is replying/);
});

const ctx = (o = {}) => ({
  session: {}, conn: { kind: "ready" }, capabilities: new Set(["host", "chat", "approvals", "tool_approvals", "read", "compose"]), hub: false, hostName: "Desk", hostUrl: "wss://h:1/host-api/v1",
  chat: UI.initialChatState, read: UI.initialReadState, compose: UI.initialComposeState,
  projects: { projects: [], selectedId: null, loading: false, loaded: true, error: null, refusal: null }, push: { kind: "unavailable", error: null },
  offlineLinked: false, navigate: noop, actions: { changeAddress: async () => null, forget: noop, selectProject: noop, openSources: noop }, ...o,
});
const slice = (chat = UI.initialChatState, modes = ["auto", "execute"]) => ({
  chat, compose: { ...UI.initialComposeState, modes, mode: "execute", models: [{ model: "m1", label: "M1" }] },
  actions: { send: noop, stop: noop, newChat: noop, deleteChat: noop, answerQuestion: noop, declineQuestion: noop, answerTool: noop, setModel: noop, removeAttachment: noop, addFiles: noop },
});

test("execute section: empty state, own composer chips, New chat and Delete this chat", () => {
  const out = html(h(UI.Shell, { ctx: ctx({ execute: slice() }), forceSection: "execute" }));
  assert.match(out, /Run a code change/);
  assert.match(out, /Describe it; the desktop edits the project and reports back\./);
  assert.match(out, /data-static="true"[^>]*><span>Execute<\/span><\/span>/); assert.doesNotMatch(out, /aria-label="Mode:/);
  assert.match(out, /New chat/); assert.match(out, /Delete this chat/);
  assert.doesNotMatch(out, /Clear history|Ask your desktop anything/);
});

test("execute section: a pending tool approval shows the preview with Allow once and Deny", () => {
  const chat = [{ type: "sent", commandId: "c-1", text: "fix" },
    { type: "event", event: { command: "toolApproval.request", payload: { requestId: "r-1", commandId: "c-1", toolName: "Edit", filePath: "a.mjs", summary: "- x\n+ y", truncated: false }, rev: 1, replyTo: "c-1" } },
    { type: "capabilities", capabilities: new Set(["tool_approvals"]) }].reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.Shell, { ctx: ctx({ execute: slice(chat) }), forceSection: "execute" }));
  assert.match(out, /Allow once/); assert.match(out, /Deny/); assert.match(out, /a\.mjs/); assert.match(out, /\+ y/);
});

test("execute section: without the tool_approvals grant (or when not offered) an explanation replaces the composer", () => {
  const noGrant = html(h(UI.Shell, { ctx: ctx({ capabilities: new Set(["host", "chat", "compose", "read"]), execute: slice() }), forceSection: "execute" }));
  assert.match(noGrant, /Let paired devices answer tool approvals/); assert.match(noGrant, /pair this browser again/);
  assert.doesNotMatch(noGrant, /<textarea|aria-label="Message composer"/);
  const notOffered = html(h(UI.Shell, { ctx: ctx({ execute: slice(UI.initialChatState, ["auto", "ask"]) }), forceSection: "execute" }));
  assert.match(notOffered, /not offering Execute/); assert.doesNotMatch(notOffered, /<textarea/);
  assert.doesNotMatch(html(h(UI.Shell, { ctx: ctx({ execute: slice() }), forceSection: "execute" })), /not offering Execute|not turned on/);
});

test("execute is listed when compose is granted (so the page can explain), hidden without compose", () => {
  const ids = (c) => UI.visibleSections({ capabilities: new Set(["host", ...c]), hub: false }).map((s) => s.id);
  assert.ok(ids(["chat", "compose"]).includes("execute"));
  assert.ok(!ids(["chat"]).includes("execute"));
});

test("compose row: mode and model chips, attach and no read-only paragraph on the row; the hint is in the chip tooltip", () => {
  const props = { state: { ...UI.initialComposeState, modes: ["auto", "ask", "plan"], mode: "plan", models: [{ model: "m1", label: "M1" }], model: "m1" }, canChoose: true, disabled: false, onMode: noop, onModel: noop, onFiles: noop, onRemove: noop };
  const out = html(h(UI.ComposeBar, props));
  assert.match(out, /aria-label="Mode: Plan"/); assert.match(out, /aria-label="Model: M1"/);
  assert.match(out, /aria-label="Attach text files"/); assert.match(out, /type="file"/);
  assert.doesNotMatch(out, /<select|<p[^>]*>Runs read-only/);
  assert.match(out, /title="Runs read-only on the desktop/);
  assert.match(html(h(UI.ComposeBar, { ...props, state: { ...props.state, model: null } })), /aria-label="Model: Desktop default"/);
  assert.doesNotMatch(html(h(UI.ComposeBar, { ...props, canChoose: false })), /aria-label="Mode/);
});

test("delete chat confirm: names both places and the Ask chat is untouched; only Delete confirms", () => {
  const calls = [];
  const el = UI.DeleteChatSheet({ open: true, onCancel: () => calls.push("cancel"), onConfirm: () => calls.push("delete") });
  assert.equal(el.props.open, true);
  assert.equal(el.props.children.props.children, UI.DELETE_CHAT_CONFIRM);
  assert.match(UI.DELETE_CHAT_CONFIRM, /Delete on this browser and the desktop/); assert.match(UI.DELETE_CHAT_CONFIRM, /the Ask chat is not affected/);
  const [cancel, del] = el.props.footer.props.children;
  cancel.props.onClick(); del.props.onClick();
  assert.deepEqual(calls, ["cancel", "delete"]);
  // Execute's bar opens the sheet instead of deleting at once.
  const out = html(h(UI.WebChat, { variant: "execute", connection: { kind: "ready" }, capabilities: new Set(["host", "chat"]), state: UI.initialChatState, onSend: noop, onStop: noop, onClear: () => calls.push("CLEARED"), onForget: noop, onAnswer: noop, onDecline: noop, onTool: noop }));
  assert.match(out, /Delete this chat/); assert.doesNotMatch(out, /CLEARED/);
});

test("help: sections, troubleshooting, and Settings links to it", () => {
  const out = html(h(UI.HelpScreen, { ctx: ctx() }));
  for (const t of [/Ask\./, /Execute\./, /Auto Tasks\./, /Loop\./, /History\./, /Offline sync/, /Origin not allowed/, /Certificate/, /Desktop asleep/]) assert.match(out, t);
  assert.match(html(h(UI.SettingsScreen, { ctx: ctx() })), /Help &amp; FAQ/);
});
