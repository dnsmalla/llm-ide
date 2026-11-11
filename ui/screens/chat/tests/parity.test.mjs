// Mac parity fixes: mode labels and permission copy, the cap tooltip, the Cmd+M dictation key, "Jump to latest",
// and the per-reply / per-chat token labels. Pure logic plus static markup; nothing runs in a real window.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html, fixtures } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("parity"); });
const ev = (type, o = {}) => c.decodeEvent({ type, ...o }).event;
const resultEvent = () => c.decodeEvent(fixtures().find((f) => f.name === "result.json").json).event;
const last = (s) => s.messages.at(-1);
const noop = () => {};

test("mode labels follow the Mac: \"Assist Plan\" and \"Code Review\" (not the bare \"Review\")", () => {
  const labels = c.MODES.map((m) => m.label);
  assert.deepEqual(labels, ["Auto", "Ask", "Plan", "Assist Plan", "Code Review", "Document", "Execute"]);
  assert.equal(c.MODES.find((m) => m.id === "review").label, "Code Review");
});

test("mode hints state what each mode does not do, as the Mac's help text does", () => {
  assert.match(c.MODES.find((m) => m.id === "ask").hint, /read-only/);
  assert.match(c.MODES.find((m) => m.id === "review").hint, /no file edits or commands/);
  assert.match(c.MODES.find((m) => m.id === "plan").hint, /no file edits or commands except saving it/);
});

test("Bypass copy says blocked commands and outside-project writes are still refused (not just \"No confirmations\")", () => {
  const bypass = c.PERMISSION_MODES.find((m) => m.id === "bypass");
  assert.equal(bypass.label, "Bypass");
  assert.match(bypass.hint, /Blocked commands and writes outside the project are still refused\./);
  assert.notEqual(bypass.hint, "No confirmations");
});

test("the permission select shows the chosen mode's hint as its tooltip", () => {
  const out = html(h(c.PermissionChip, { value: "bypass", onChange: noop }));
  assert.match(out, /aria-label="Permission mode"/);
  assert.match(out, /title="Apply edits and run commands without asking\./);
});

test("the raise-limit tooltip is the Mac's wording", () => {
  assert.equal(c.RAISE_LIMIT_HELP, "Raises the limit by half again (at least 50k above what is used)");
});

test("Cmd+M (Ctrl+M off macOS) toggles dictation; other modifiers and keys do not", () => {
  const k = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(c.isDictationShortcut(k("m", { metaKey: true }), true), true);
  assert.equal(c.isDictationShortcut(k("M", { ctrlKey: true }), false), true);
  assert.equal(c.isDictationShortcut(k("m", { ctrlKey: true }), true), false, "Ctrl+M on macOS is a text binding, not dictation");
  assert.equal(c.isDictationShortcut(k("m", { metaKey: true }), false), false, "the Windows/Super key is not the shortcut off macOS");
  assert.equal(c.isDictationShortcut(k("m", { metaKey: true, shiftKey: true }), true), false);
  assert.equal(c.isDictationShortcut(k("m", { metaKey: true, altKey: true }), true), false);
  assert.equal(c.isDictationShortcut(k("n", { metaKey: true }), true), false);
  assert.equal(c.isDictationShortcut(k("m"), true), false);
  assert.equal(c.dictationShortcutLabel(true), "Cmd+M");
  assert.equal(c.dictationShortcutLabel(false), "Ctrl+M");
  assert.equal(c.isGlobalDictationShortcut(k("m", { metaKey: true, defaultPrevented: true }), true), false, "a focused composer wins");
  assert.equal(c.isGlobalDictationShortcut(k("m", { metaKey: true }), true), true);
  assert.equal(c.dictationEnabled(true, () => {}), true);
  assert.equal(c.dictationEnabled(false, () => {}), false, "a hidden Chat surface must not bind");
  assert.equal(c.dictationEnabled(true, null), false);
});

test("Jump to latest shows only for a non-empty conversation the reader has scrolled away from", () => {
  assert.equal(c.showJumpToLatest(0, 500, 0), false, "empty list");
  assert.equal(c.showJumpToLatest(1500, 500, 2000), false, "at the bottom");
  assert.equal(c.showJumpToLatest(1460, 500, 2000), false, "within the 48px slack");
  assert.equal(c.showJumpToLatest(1400, 500, 2000), true, "100px short of the bottom is outside the slack");
  assert.equal(c.showJumpToLatest(0, 500, 2000), true, "scrolled up while a reply streams");
});

test("billable tokens weight cache writes at 1.25x and cache reads at 0.1x, output and input at 1x", () => {
  const u = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 200 };
  assert.equal(c.billableTokens(u), 100 + 50 + Math.round(200 * 1.25 + 1000 * 0.1));
  assert.equal(c.billableTokens(u), 500);
  assert.equal(c.processedTokens(u), 1350);
});

test("compact counts match the Mac: one decimal above 1K and 1M", () => {
  assert.equal(c.compactTokenCount(0), "0");
  assert.equal(c.compactTokenCount(999), "999");
  assert.equal(c.compactTokenCount(1200), "1.2K");
  assert.equal(c.compactTokenCount(200000), "200.0K");
  assert.equal(c.compactTokenCount(2500000), "2.5M");
});

test("the usage tooltip names each part and its rate, as the Mac does", () => {
  const tip = c.usageTooltip({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 200 });
  assert.equal(tip, "100 in · 50 out · 1000 cache read (×0.1) · 200 cache write (×1.25) · 1350 processed in total");
  assert.equal(c.usageTooltip({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }), "1 in · 2 out · 3 processed in total");
});

test("a chat's total is the sum of its replies; no replies with counts gives no total", () => {
  assert.equal(c.sessionUsage([]), null);
  const t = c.sessionUsage([
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
    { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
  ]);
  assert.deepEqual(t, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 });
});

test("a live reply carries its own usage; the next turn's usage does not overwrite it", () => {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "one" });
  s = c.reduce(s, { type: "events", events: [ev("delta", { text: "a" }), ev("usage", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }), resultEvent()] });
  assert.equal(s.phase, "idle");
  assert.deepEqual(last(s).usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
  s = c.reduce(s, { type: "send", id: "t2", text: "two" });
  s = c.reduce(s, { type: "events", events: [ev("delta", { text: "b" }), ev("usage", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 0 })] });
  const replies = s.messages.filter((m) => m.role === "assistant");
  assert.deepEqual(replies[0].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.deepEqual(replies[1].usage, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 0 });
});

test("a reply that reported no usage has none (no invented count)", () => {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "hi" });
  s = c.reduce(s, { type: "events", events: [ev("delta", { text: "a" }), resultEvent()] });
  assert.equal(last(s).usage, undefined);
});

test("a finished reply shows its billable count with the breakdown as a tooltip; a streaming one shows none", () => {
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 200 };
  const done = html(h(c.MessageView, { m: { role: "assistant", id: "a1", parts: [{ kind: "text", sealed: [], open: "Hi" }], notices: [], status: "done", usage }, host: {} }));
  assert.match(done, /500 tokens/);
  assert.match(done, /title="100 in · 50 out · 1000 cache read \(×0\.1\) · 200 cache write \(×1\.25\) · 1350 processed in total"/);
  const live = html(h(c.MessageView, { m: { role: "assistant", id: "a2", parts: [], notices: [], status: "streaming", usage }, host: {} }));
  assert.doesNotMatch(live, /tokens<\/p>/);
});

// Review fixes.
test("a reply's usage is summed across a turn's usage events (provider turns send one per step, as the Mac sums)", () => {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "one" });
  s = c.reduce(s, { type: "events", events: [ev("usage", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 })] });
  s = c.reduce(s, { type: "events", events: [ev("usage", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }), resultEvent()] });
  assert.deepEqual(last(s).usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 103, cacheCreationTokens: 24 });
});

test("Jump to latest shows only while a reply streams, as on the Mac (engine.busy)", () => {
  const streaming = [{ role: "user", id: "u", text: "x" }, { role: "assistant", id: "a", parts: [], notices: [], status: "streaming" }];
  const done = [streaming[0], { ...streaming[1], status: "done" }];
  assert.equal(c.jumpPillVisible(streaming, 0, 500, 2000), true);
  assert.equal(c.jumpPillVisible(streaming, 1500, 500, 2000), false, "at the bottom");
  assert.equal(c.jumpPillVisible(done, 0, 500, 2000), false, "scrolled up in a finished chat: nothing to miss");
  assert.equal(c.jumpPillVisible([], 0, 500, 0), false);
});

test("the header total never calls a partial sum \"This chat\" (reloaded replies carry no count)", () => {
  const u = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 200 };
  const reply = (id, usage) => ({ role: "assistant", id, parts: [], notices: [], status: "done", ...(usage ? { usage } : {}) });
  assert.equal(c.chatTotalLabel([reply("a")], false), null);
  const full = c.chatTotalLabel([reply("a", u), reply("b", u)], false);
  assert.equal(full.text, "1.0K tokens");
  assert.match(full.title, /^This chat: /);
  assert.equal(full.ariaLabel, "This chat used 1000 tokens");
  const reloaded = c.chatTotalLabel([reply("old"), reply("new", u)], false);
  assert.equal(reloaded.text, "500 tokens");
  assert.doesNotMatch(reloaded.title, /^This chat/);
  assert.match(reloaded.title, /since this chat was opened/);
  assert.doesNotMatch(c.chatTotalLabel([reply("new", u)], true).title, /^This chat/, "older pages not loaded");
  const live = c.chatTotalLabel([reply("a", u), { ...reply("b", u), status: "streaming" }], false);
  assert.equal(live.ariaLabel, "This chat used 500 tokens", "an in-flight reply is not counted yet");
  const costed = c.chatTotalLabel([{ ...reply("a", u), costUsd: 0.01 }, { ...reply("b", u), costUsd: 0.02 }], false);
  assert.equal(costed.text, "1.0K tokens · $0.03", "the header sums reported reply costs");
});
