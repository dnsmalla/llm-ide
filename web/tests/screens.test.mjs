import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const caps = (...c) => new Set(["host", ...c]);
const project = { id: "p-1", name: "Alpha", role: "member", maxMode: "execute", usdCapMonth: 0, permissions: ["self.read"] };
const projects = { projects: [project], selectedId: "p-1", loading: false, loaded: true, error: null, refusal: null };
const chatProps = (state, extra = {}) => ({ hostName: "Desk", connection: { kind: "ready" }, capabilities: caps("chat", "approvals"), state,
  projects, onSelectProject: noop, onSend: noop, onStop: noop, onClear: noop, onForget: noop, onAnswer: noop, onDecline: noop, onTool: noop, ...extra });
const ev = (command, payload, replyTo = "c-1") => ({ type: "event", event: { command, payload, rev: 1, replyTo } });

test("pairing: labelled address and PIN inputs, the origin hint, no stored PIN", () => {
  const out = html(h(UI.PairingScreen, { initialUrl: "ws://127.0.0.1:3016/host-api/v1", busy: false, error: null, revokedNotice: null, onSubmit: noop }));
  assert.match(out, /<label[^>]*>[^<]*Hub or desktop address/);
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

const readProps = (state, extra = {}) => ({ capabilities: caps("chat", "read"), state, onOpen: noop, onOlder: noop, onClose: noop, onMore: noop, ...extra });

test("read panel: hidden without the read capability", () => {
  assert.equal(html(h(UI.ReadPanel, { ...readProps(UI.initialReadState), capabilities: caps("chat") })), "");
});

test("read panel: usage numbers, chat list with the phone chat marked, host text as text", () => {
  const state = { ...UI.initialReadState,
    usage: [{ provider: "anthropic", status: "ok", models: [
      { model: "m1", label: "Sonnet", state: "warning", unit: "runs", window: "daily", used: 42, limit: 100, pct: 42, resetAt: 0 },
      { model: "m2", state: "ok", unit: "tokens", window: "monthly", used: 5, limit: 0, resetAt: 0 }] }],
    sessions: [{ id: "p", title: "Phone chat", updatedAt: 1, phoneChat: true }, { id: "x", title: "<img src=x onerror=alert(1)>", updatedAt: 2 }],
    nextOffset: 50 };
  const out = html(h(UI.ReadPanel, readProps(state)));
  assert.match(out, /Sonnet: 42 of 100 runs · daily/);
  assert.match(out, /m2: 5 tokens · monthly, no cap/);
  assert.match(out, /Phone chat \(live chat\)/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /More chats/);
});

test("read panel: an open chat is read-only with Show older and Back", () => {
  const state = { ...UI.initialReadState, open: { id: "x", title: "Router", nextBeforeSeq: 3,
    messages: [{ seq: 3, role: "user", content: "<b>q</b>" }, { seq: 4, role: "assistant", content: "a" }] } };
  const out = html(h(UI.ReadPanel, readProps(state)));
  assert.match(out, /Router/);
  assert.match(out, /Read-only/);
  assert.match(out, /Show older/);
  assert.match(out, /Back to the phone chat/);
  assert.doesNotMatch(out, /<b>q/);
  assert.doesNotMatch(out, /<textarea/);
});

const composeProps = (state, extra = {}) => ({ state: { ...UI.initialComposeState, ...state }, canChoose: true, disabled: false,
  onMode: noop, onModel: noop, onFiles: noop, onRemove: noop, ...extra });
test("compose bar: labelled mode and model selects with only offered options; never Execute or Bypass", () => {
  const out = html(h(UI.ComposeBar, composeProps({ modes: ["auto", "ask", "plan"], models: [{ model: "claude-sonnet-5-5", label: "Sonnet 5.5" }] })));
  assert.match(out, /aria-label="Mode"/); assert.match(out, /aria-label="Model"/); assert.match(out, />Plan</); assert.match(out, />Sonnet 5.5</);
  assert.match(out, />Desktop default</); assert.doesNotMatch(out, /Execute|Bypass/); assert.match(out, /read-only on the desktop/);
});
test("compose bar: without compose only the attach input shows; chips have labelled remove buttons", () => {
  const out = html(h(UI.ComposeBar, composeProps({ attachments: [{ name: "<b>a.md</b>", text: "xyz", truncated: true }] }, { canChoose: false })));
  assert.doesNotMatch(out, /aria-label="Mode"/); assert.match(out, /type="file"/); assert.match(out, /Attach text files/);
  assert.match(out, /aria-label="Remove &lt;b&gt;a.md&lt;\/b&gt;"/); assert.match(out, /cut to the limit/);
});
test("web chat: New chat only when offered, disabled during a turn; the compose slot renders", () => {
  const idle = UI.initialChatState;
  assert.doesNotMatch(html(h(UI.WebChat, chatProps(idle))), /New chat/);
  const out = html(h(UI.WebChat, chatProps(idle, { onNewChat: noop, compose: h("p", null, "COMPOSE-SLOT") })));
  assert.match(out, /New chat/); assert.match(out, /COMPOSE-SLOT/);
  const busy = [{ type: "sent", commandId: "c-1", text: "hi" }].reduce(UI.reduce, UI.initialChatState);
  assert.match(html(h(UI.WebChat, chatProps(busy, { onNewChat: noop }))), /<button[^>]*disabled=""[^>]*>New chat/);
});
test("tool approval card says where saved rules live, still offers no saved rule", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "hi" }, ev("toolApproval.request", { requestId: "r-1", commandId: "c-1", toolName: "Edit", summary: "edit a.txt", truncated: false })].reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.WebChat, chatProps(s, { capabilities: caps("chat", "approvals", "tool_approvals") })));
  assert.match(out, /made and revoked on the desktop/); assert.doesNotMatch(out, /[Aa]lways/);
});

test("chat banner: after UNOPENED_LIMIT never-opened attempts it shows the origin and certificate hints with a forget action", () => {
  const re = (unopened) => html(h(UI.WebChat, chatProps(UI.initialChatState, { connection: { kind: "reconnecting", attempt: 3, inMs: 1000, unopened } })));
  const early = re(UI.UNOPENED_LIMIT - 1);
  assert.doesNotMatch(early, /Forget and re-enter/);
  const late = re(UI.UNOPENED_LIMIT);
  assert.doesNotMatch(late, /LLMIDE_HOST_API_WEB_ORIGINS/);
  assert.match(late, /Settings \u2192 Host API \u2192 Allowed browser origins/);
  assert.match(late, /trust the certificate/);
  assert.match(late, /Forget and re-enter the address/);
});

test("chat banner: names this page's origin and links the host's https address to trust its certificate", () => {
  const conn = { kind: "reconnecting", attempt: 3, inMs: 1000, unopened: UI.UNOPENED_LIMIT };
  const out = html(h(UI.WebChat, chatProps(UI.initialChatState, { connection: conn, hostUrl: "wss://192.168.1.20:3016/host-api/v1", pageOrigin: "https://llm-ide.com" })));
  assert.match(out, /This page&#x27;s origin is https:\/\/llm-ide\.com\./);
  assert.match(out, /href="https:\/\/192\.168\.1\.20:3016\/"/);
  assert.match(out, /Open the desktop&#x27;s address to trust its certificate/);
  const plain = html(h(UI.WebChat, chatProps(UI.initialChatState, { connection: conn, hostUrl: "ws://127.0.0.1:3016/host-api/v1", pageOrigin: "http://localhost:5173" })));
  assert.doesNotMatch(plain, /trust its certificate/);
  assert.equal(UI.trustUrl("wss://h.example.com:3016/host-api/v1"), "https://h.example.com:3016/");
  assert.equal(UI.trustUrl("nonsense"), null);
});

test("sync tier: the Pair a desktop / Connect desktop action follows hostPaired", () => {
  const st = { phase: "locked", pairStep: null, sas: null, busy: false, error: null, notice: null, online: true, email: "", snapshot: null, stale: false, checkedAt: null, pending: [], answered: [] };
  const sync = new Proxy({}, { get: () => noop });
  assert.match(html(h(UI.SyncTier, { state: st, sync, hostPaired: false, onHost: noop })), /Pair a desktop/);
  assert.match(html(h(UI.SyncTier, { state: st, sync, hostPaired: true, onHost: noop })), /Connect desktop/);
});

test("Chat reconnecting banner offers Open offline copy only when wired", () => {
  const rc = { kind: "reconnecting", attempt: 1, inMs: 1000, unopened: 0 };
  assert.ok(html(h(UI.WebChat, { ...chatProps(UI.initialChatState, { connection: rc }), onOpenOffline: () => {} })).includes("Open offline copy"));
  assert.ok(!html(h(UI.WebChat, chatProps(UI.initialChatState, { connection: rc }))).includes("Open offline copy"));
});
