import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html, fakeCore } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("components"); });
const count = (s, re) => (s.match(re) ?? []).length;
const noop = () => {};

const sessions = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Chat ${i}`, surface: "any", mode: null, projectId: null, createdAt: 1e9 - i, updatedAt: 1.7e9 - i * 3600 }));
const listProps = (n, extra = {}) => ({ sessions: sessions(n), activeId: "s3", busyIds: new Set(["s2"]), hasMore: false, onLoadMore: noop, onSelect: noop, onNew: noop, onRename: noop, onDelete: noop, nowMs: 1.7e12, ...extra });

test("SessionList: 2,000 chats render a bounded window with named controls", () => {
  const out = html(h(c.SessionList, listProps(2000)));
  assert.match(out, /<nav[^>]*aria-label="Chats"/);
  assert.match(out, /role="list"[^>]*aria-label="2000 chats"/);
  assert.ok(count(out, /role="listitem"/g) <= 30, `rendered ${count(out, /role="listitem"/g)} rows`);
  assert.match(out, /aria-label="Search chats"/);
  assert.match(out, /aria-label="New chat"/);
  assert.match(out, /aria-label="Rename Chat 0"/);
  assert.match(out, /aria-label="Delete Chat 0"/);
  assert.match(out, /aria-current="true"/);
  assert.match(out, /Running/);                           // busy chat is flagged
});

test("SessionList: empty and filtered states, untitled chats get a name", () => {
  assert.match(html(h(c.SessionList, listProps(0))), /No chats yet/);
  const untitled = html(h(c.SessionList, listProps(1, { sessions: [{ ...sessions(1)[0], title: "" }] })));
  assert.match(untitled, /Rename Untitled chat/);
  assert.deepEqual(c.filterSessions(sessions(5), "chat 3").map((s) => s.id), ["s3"]);
});

test("SessionList titles are escaped text", () => {
  const out = html(h(c.SessionList, listProps(1, { sessions: [{ ...sessions(1)[0], title: "<img src=x onerror=alert(1)>" }] })));
  assert.ok(!out.includes("<img"));
});

const asst = (over = {}) => ({ role: "assistant", id: "a1", status: "done", notices: [], parts: [], ...over });

test("MessageView: user text is escaped; assistant is an article with busy state while streaming", () => {
  const host = {};
  const u = html(h(c.MessageView, { m: { role: "user", id: "u", text: "<script>alert(1)</script>" }, host }));
  assert.ok(!u.includes("<script"));
  assert.match(u, /aria-label="Your message"/);
  const a = html(h(c.MessageView, { m: asst({ status: "streaming", parts: [c.appendText(c.emptyText(), "Hi\n\nthere")] }), host }));
  assert.match(a, /<article[^>]*aria-label="Assistant message"[^>]*aria-busy="true"/);
  assert.match(a, /chat-caret/);
  assert.ok(!html(h(c.MessageView, { m: asst(), host })).includes("chat-caret"));
});

test("MessageView: tool cards are collapsed buttons with aria-expanded; thinking placeholder; notices by level", () => {
  const tool = { kind: "tool", index: 0, id: "t1", name: "Read", args: "{}", argsTruncated: false, result: { text: "x", isError: true, truncated: false, totalChars: 1 } };
  const out = html(h(c.MessageView, { host: {}, m: asst({ parts: [tool], notices: [
    { kind: "retry", level: "warning", text: "retrying", count: 3, visible: true },
    { kind: "route_switch", level: "info", text: "hidden info", count: 1, visible: false },
    { kind: "x", level: "error", text: "bad", count: 1, visible: true }] }) }));
  assert.match(out, /<button[^>]*class="chat-tool-head"[^>]*aria-expanded="false"[^>]*aria-controls="tool-t1"/);
  assert.match(out, /data-state="failed"/);
  assert.match(out, /retrying \(x3\)/);
  assert.ok(!out.includes("hidden info"));
  assert.match(out, /role="alert"/);
  assert.match(html(h(c.MessageView, { host: {}, m: asst({ status: "streaming" }) })), /Thinking/);
  assert.match(html(h(c.MessageView, { host: {}, m: asst({ status: "aborted" }) })), /Stopped/);
});

test("tool output preview is capped; 'show more' steps reveal the rest lazily", () => {
  const big = "z".repeat(10_000);
  const p = c.clipPreview(big, c.TOOL_PREVIEW_CHARS);
  assert.equal(p.text.length, 1500);
  assert.equal(p.rest, 8500);
  assert.equal(c.clipPreview("short", 1500).rest, 0);
});

test("MessageList: 5,000 messages render a small window; log and list roles; empty slot", () => {
  const msgs = Array.from({ length: 5000 }, (_, i) => ({ role: "user", id: `m${i}`, text: `message ${i}` }));
  const out = html(h(c.MessageList, { messages: msgs, hasMoreOlder: false, onLoadOlder: async () => 0, initialScrollTop: null, onScrollState: noop }));
  assert.match(out, /role="log"[^>]*aria-label="Conversation"/);
  assert.ok(count(out, /role="listitem"/g) <= 20, `rendered ${count(out, /role="listitem"/g)}`);
  const empty = html(h(c.MessageList, { messages: [], hasMoreOlder: false, onLoadOlder: async () => 0, initialScrollTop: null, onScrollState: noop, empty: h("p", null, "Nothing yet") }));
  assert.match(empty, /Nothing yet/);
  const older = html(h(c.MessageList, { messages: msgs.slice(0, 3), hasMoreOlder: true, onLoadOlder: async () => 0, initialScrollTop: null, onScrollState: noop }));
  assert.match(older, /Loading earlier messages/);
});

const comp = (o = {}) => h(c.Composer, { draft: "", onDraft: noop, busy: false, aborting: false, queue: [], history: [], onSend: noop, onStop: noop, onDropQueued: noop, ...o });

test("Composer: labelled textarea, Send disabled when empty, Stop and queue while busy", () => {
  const idle = html(comp());
  assert.match(idle, /<form[^>]*aria-label="Message composer"/);
  assert.match(idle, /<textarea[^>]*aria-label="Message"/);
  assert.match(idle, /<button type="submit"[^>]*disabled=""[^>]*>Send</);
  assert.ok(!idle.includes("Stop the running turn"));
  const busy = html(comp({ busy: true, draft: "next", queue: ["queued one"], onAttach: noop }));
  assert.match(busy, /aria-label="Stop the running turn"/);
  assert.match(busy, /<button type="submit"[^>]*>Queue</);
  assert.match(busy, /aria-label="Queued messages"/);
  assert.match(busy, /aria-label="Remove queued message 1"/);
  assert.match(busy, /aria-label="Attach files"/);
  assert.match(html(comp({ busy: true, aborting: true })), /Stopping/);
});

test("Composer: too-long message is an alert and cannot be sent; no attach button without a host dialog", () => {
  const out = html(comp({ draft: "x".repeat(c.MAX_MESSAGE_CHARS + 1) }));
  assert.match(out, /role="alert"/);
  assert.match(out, /<button type="submit"[^>]*disabled=""/);
  assert.ok(!out.includes("Attach files"));
  assert.match(html(comp({ draft: "ok", disabledReason: "Cannot reach the core" })), /Cannot reach the core/);
});

test("Composer history recall walks up and back down to an empty draft", () => {
  const hist = ["one", "two", "three"];
  let r = c.nextRecall(hist, null, "up"); assert.deepEqual(r, { cursor: 2, text: "three" });
  r = c.nextRecall(hist, r.cursor, "up"); assert.equal(r.text, "two");
  r = c.nextRecall(hist, 0, "up"); assert.equal(r.text, "one");
  r = c.nextRecall(hist, 2, "down"); assert.deepEqual(r, { cursor: null, text: "" });
  assert.equal(c.nextRecall([], null, "up").text, null);
});

test("Pickers: mode select lists all modes; model select groups by provider with the tools badge and the plain-chat note", () => {
  const mode = html(h(c.ModePicker, { value: "auto", resolved: "plan", onChange: noop }));
  assert.match(mode, /<select[^>]*aria-label="Mode"/);
  assert.equal(count(mode, /<option/g), 7);
  assert.match(mode, /running as plan/);
  const groups = [{ id: "anthropic", label: "Claude", catalog: false, models: [{ provider: "anthropic", model: "m", label: "Claude M" }] },
    { id: "cat-groq", label: "Groq", catalog: true, models: [{ provider: "custom:cat-groq", model: "l", label: "l", toolsSupported: true }, { provider: "custom:cat-groq", model: "t", label: "t", toolsSupported: false }], note: "Could not list models." }];
  const model = html(h(c.ModelPicker, { groups, provider: "custom:cat-groq", model: "t", onChange: noop, plainChat: "modelLacksTools" }));
  assert.match(model, /<select[^>]*aria-label="Model"/);
  assert.match(model, /<optgroup label="Groq"/);
  assert.match(model, /\(tools\)/);
  assert.match(model, /\(no tools\)/);
  assert.match(model, /Plain chat \(no tools\)/);
  assert.match(model, /Could not list models/);
  assert.match(html(h(c.PermissionChip, { value: "bypass", onChange: noop })), /data-bypass="true"/);
});

test("CapChip: hidden when the router is off; a labelled button with the meter otherwise (dialog closed)", () => {
  assert.equal(html(h(c.CapChip, { route: null, onSetLimit: noop })), "");
  assert.equal(html(h(c.CapChip, { route: { enabled: false }, onSetLimit: noop })), "");
  const route = { enabled: true, capEnforced: true, chatSessionId: "a", provider: "p", model: "m", pinned: true, tokenLimit: 50000, used: { in: 1, out: 1, cacheWrite: 0, cacheRead: 0, billable: 45000 }, remaining: 5000, switchSeq: 1 };
  const out = html(h(c.CapChip, { route, onSetLimit: noop }));
  assert.match(out, /data-level="warn"/);
  assert.match(out, /aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-label="Token limit 45k \/ 50k"/);
  assert.ok(!out.includes("role=\"dialog\""));
});

test("ChatScreen renders its landmarks and the empty state (server render, no network)", () => {
  const store = new c.MemoryChatStore();
  const controller = new c.ChatController({ core: fakeCore(), store, workspaceRoot: () => "/p" });
  const out = html(h(c.ChatScreen, { controller, store, core: fakeCore(), host: { openLink: noop, copy: noop } }));
  assert.match(out, /<nav[^>]*aria-label="Chats"/);
  assert.match(out, /<section[^>]*aria-label="Chat"/);
  assert.match(out, /Select a chat or start a new one/);
});

test("ChatScreen with an open chat has the conversation log, composer, mode and model controls", () => {
  const store = new c.MemoryChatStore();
  const controller = new c.ChatController({ core: fakeCore(), store, workspaceRoot: () => "/p" });
  const out = html(h(c.ChatScreen, { controller, store, core: fakeCore(), host: { openLink: noop, copy: noop }, initialSessionId: "x", approvals: () => h("div", { id: "slot-g" }) }));
  for (const re of [/role="log"|chat-empty|Ask anything/, /aria-label="Mode"/, /aria-label="Model"/, /aria-label="Permission mode"/, /aria-label="Message composer"/, /id="slot-g"/]) assert.match(out, re);
});

test("source rules: no dangerouslySetInnerHTML, innerHTML, eval, <img>, remote URLs or inline colours in the chat screen", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { CHAT } = await import("./helpers.mjs");
  const files = readdirSync(CHAT).filter((f) => /\.(ts|tsx|css)$/.test(f));
  assert.ok(files.length >= 15);
  for (const f of files) {
    const src = readFileSync(join(CHAT, f), "utf8");
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), `${f}: raw HTML or eval`);
    assert.ok(!/<img\b|<iframe\b|<script\b|<link\b/.test(src.replace(/\/\/.*$/gm, "").replace(/"[^"\n]*"/g, '""')), `${f}: remote-resource element`);
    if (f.endsWith(".css")) {
      assert.ok(!/url\(|@import|#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(src), `${f}: remote or raw colour`);
    }
  }
});

test("IME: the committing Enter after compositionend (keyCode 229, isComposing false) is not a send; Escape does not stop during composition", () => {
  let now = 1000;
  const g = new c.ImeGuard(() => now);
  const enter = { key: "Enter", keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } };
  assert.equal(g.isIme(enter), false, "a plain Enter is a send");
  // typing a conversion: keydowns during composition
  g.onCompositionStart();
  assert.equal(g.isIme({ key: "Process", keyCode: 229, nativeEvent: { isComposing: true } }), true);
  assert.equal(g.isIme({ key: "Escape", keyCode: 27, nativeEvent: { isComposing: false } }), true, "Escape cancels the conversion, it does not stop the turn");
  // WKWebView: compositionend first, then the committing Enter keydown
  now += 5; g.onCompositionEnd();
  now += 3;
  assert.equal(g.isIme({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } }), true, "keyCode 229");
  assert.equal(g.isIme(enter), true, "even reported as 13, it is inside the commit window");
  now += 500;
  assert.equal(g.isIme(enter), false, "a later, deliberate Enter sends");
  assert.equal(g.isIme({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } }), true, "Chrome isComposing");
});

test("windowBlocks: a message renders within the cap, cut at a line end, the rest is counted for Show more", () => {
  const blocks = ["aaaa\nbbbb\n\n", "cccc\ndddd\n\n"];
  assert.deepEqual(c.windowBlocks(blocks, 100), { blocks, hidden: 0 });
  const w = c.windowBlocks(blocks, 17);
  assert.deepEqual(w.blocks, ["aaaa\nbbbb\n\n", "cccc\n"]);
  assert.equal(w.hidden, 6);
  assert.deepEqual(c.windowBlocks(["x".repeat(50)], 20), { blocks: ["x".repeat(20)], hidden: 30 }, "one long line is cut at the limit");
  const big = c.windowBlocks(["y\n".repeat(2_000_000)], c.RENDER_CAP_CHARS);
  assert.ok(big.blocks[0].length <= c.RENDER_CAP_CHARS && big.hidden > 0);
});

test("SessionList: the unreadable footer row renders when the host reports unreadable chats", () => {
  const out = html(h(c.SessionList, listProps(1, { unreadableNotice: "3 chats could not be read (not touched)" })));
  assert.match(out, /3 chats could not be read \(not touched\)/);
  assert.doesNotMatch(html(h(c.SessionList, listProps(1))), /could not be read/);
});
