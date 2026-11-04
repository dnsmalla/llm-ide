import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const caps = (...c) => new Set(["host", ...c]);
const chatProps = (state, extra = {}) => ({ hostName: "Desk", connection: { kind: "ready" }, capabilities: caps("chat", "approvals"), state,
  onSend: noop, onStop: noop, onClear: noop, onForget: noop, onAnswer: noop, onDecline: noop, onTool: noop, ...extra });
const ev = (command, payload, replyTo = "c-1") => ({ type: "event", event: { command, payload, rev: 1, replyTo } });

test("pairing: labelled address and PIN inputs, the origin hint, no stored PIN", () => {
  const out = html(h(UI.PairingScreen, { initialUrl: "ws://127.0.0.1:3016/host-api/v1", busy: false, error: null, revokedNotice: null, onSubmit: noop }));
  assert.match(out, /<label[^>]*>[^<]*Host address/);
  assert.match(out, /inputMode="numeric"|inputmode="numeric"/);
  assert.match(out, /autoComplete="one-time-code"|autocomplete="one-time-code"/);
  assert.match(out, /LLMIDE_HOST_API_WEB_ORIGINS/);
  assert.match(out, /value="ws:\/\/127\.0\.0\.1:3016\/host-api\/v1"/);
});

test("chat renders host text as text, never as markup", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "<b>hi</b>" }, ev("chat.delta", { text: "<img src=x onerror=alert(1)>" }), ev("chat.done", { requestId: "c-1" })]
    .reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.WebChat, chatProps(s)));
  assert.doesNotMatch(out, /<img|<b>hi/);
  assert.match(out, /&lt;b&gt;hi&lt;\/b&gt;/);
});

test("tool approvals appear only with the capability, with Allow once and Deny and no always-allow", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "hi" },
    ev("toolApproval.request", { requestId: "r-1", commandId: "c-1", toolName: "Edit", summary: "edit a.txt", truncated: true })].reduce(UI.reduce, UI.initialChatState);
  assert.doesNotMatch(html(h(UI.WebChat, chatProps(s))), /Allow once/);
  const out = html(h(UI.WebChat, chatProps(s, { capabilities: caps("chat", "approvals", "tool_approvals") })));
  assert.match(out, /Allow once/);
  assert.match(out, /Deny/);
  assert.match(out, /shortened/);
  assert.doesNotMatch(out, /[Aa]lways/);
});

test("a question renders through the shared QuestionCard with the decline note", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "hi" },
    ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: [{ question: "Pick one?", multiSelect: false, options: [{ label: "Yes" }] }] })]
    .reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.WebChat, chatProps(s)));
  assert.match(out, /Pick one\?/);
  assert.match(out, /Declining stops the reply/);
});

test("no chat capability: the composer is disabled with a reason, not a dead screen", () => {
  const out = html(h(UI.WebChat, chatProps(UI.initialChatState, { capabilities: caps() })));
  assert.match(out, /does not serve chat/);
});

test("the list renders at most 50 messages and offers older ones", () => {
  const s = UI.reduce(UI.initialChatState, { type: "snapshot", messages: Array.from({ length: 120 }, (_, i) => ({ role: "user", content: `line-${i}` })) });
  const out = html(h(UI.WebChat, chatProps(s)));
  assert.equal((out.match(/line-\d+/g) ?? []).length, 50);
  assert.match(out, /Show older/);
  assert.doesNotMatch(out, /line-69\b/);
});

test("an over-long send keeps the draft, raises the alert and never reaches send", () => {
  const calls = { send: 0, draft: [], error: [] };
  const g = UI.createDraftGuard({ send: () => calls.send++, setDraft: (t) => calls.draft.push(t), setError: (m) => calls.error.push(m) });
  g.onSend("x".repeat(100_001)); g.onDraft(""); // the Composer clears right after onSend
  assert.equal(calls.send, 0);
  assert.deepEqual(calls.draft, []);
  assert.match(calls.error.at(-1), /under 100,000/);
  g.onSend("ok"); g.onDraft("");
  assert.equal(calls.send, 1);
  assert.deepEqual(calls.draft, [""]);
  assert.equal(calls.error.at(-1), null);
});

test("clear history is disabled while offline or without chat", () => {
  assert.match(html(h(UI.WebChat, chatProps(UI.initialChatState, { connection: { kind: "idle" } }))), /<button[^>]*disabled[^>]*>Clear history/);
  assert.doesNotMatch(html(h(UI.WebChat, chatProps(UI.initialChatState, { capabilities: caps("chat") }))), /<button[^>]*disabled[^>]*>Clear history/);
});

test("clear history stays mounted but disabled during a turn", () => {
  const s = UI.reduce(UI.initialChatState, { type: "sent", commandId: "c-1", text: "hi" });
  assert.match(html(h(UI.WebChat, chatProps(s))), /<button[^>]*disabled[^>]*>Clear history/);
});
