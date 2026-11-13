// The composer bar in the Mac's order (ChatComposer.toolbarSingleRow): Library/Attach, the pickers, memory, then
// at the right the context meter, the key hint, dictation, Stop and Send. The pickers left the row above the composer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("composer-layout"); });

const noop = () => {};
const base = { draft: "hi", onDraft: noop, busy: true, aborting: false, queue: [], history: [], onSend: noop, onStop: noop, onDropQueued: noop, onAttach: noop };

test("bar order: Attach, controls, memory, spacer, meter, key hint, Stop, Send", () => {
  const out = html(h(c.Composer, { ...base,
    controls: h("span", { id: "ctl" }, "CTL"), memory: h("span", { id: "mem" }, "MEM"), meter: h("span", { id: "mtr" }, "MTR") }));
  const bar = out.slice(out.indexOf('class="chat-composer-bar"'));
  const at = (needle) => { const i = bar.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const order = [at('aria-label="Attach files"'), at('id="ctl"'), at('id="mem"'), at('class="chat-spacer"'), at('id="mtr"'), at('role="img"'), at('aria-label="Stop the running turn"'), at('type="submit"')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("the chat screen passes the pickers to the composer and keeps only the notices above it", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.doesNotMatch(screen, /className="chat-controls"/);
  const controls = screen.slice(screen.indexOf("controls={<>"), screen.indexOf("</>}", screen.indexOf("controls={<>")));
  for (const picker of ["<ModePicker", "<ModelPicker", "<EffortPicker", "<PermissionChip"]) assert.ok(controls.includes(picker), `${picker} is in the composer bar`);
  // Notices about the next message sit in the strip on top of the prompt box, not in the transcript.
  assert.match(screen, /notices=\{<PromptNotices items=\{promptNotices\} onClose=\{closeNotice\} \/>\}/);
  for (const id of ['"mode"', '"budget"', '"tools"', '"router"', '"pending"', '"notice"']) assert.ok(screen.includes(`id: ${id}`), `${id} notice is in the prompt strip`);
  assert.doesNotMatch(screen, /<ModeBanner|className="chat-budget-warning"|<StatusBanner severity="info" message=\{notice\}/);
});

test("a full queue turns Send off and keeps the draft: the composer never clears what it cannot queue", () => {
  const queue = Array.from({ length: c.MAX_QUEUE }, (_, i) => `q${i}`);
  const full = html(h(c.Composer, { ...base, draft: "next one", queue }));
  const sendOf = (out) => out.slice(out.lastIndexOf("<button type=\"submit\""), out.indexOf("</button>", out.lastIndexOf("<button type=\"submit\"")));
  assert.match(sendOf(full), /disabled=""/, "Send is disabled");
  assert.match(full, /Queue full/);
  const room = html(h(c.Composer, { ...base, draft: "next one", queue: queue.slice(1) }));
  assert.doesNotMatch(sendOf(room), /disabled=""/, "one slot free: Send is on");
  assert.doesNotMatch(room, /Queue full/);
});

test("prompt notices: shown on top of the prompt box, closable, and back when their text changes", () => {
  const n = (id, text) => ({ id, tone: "info", text });
  const closed = new Set([c.noticeKey(n("budget", "94% used"))]);
  assert.deepEqual(c.visibleNotices([n("budget", "94% used"), null, n("mode", "Bypass"), n("mode", "Bypass")], closed).map((x) => x.id), ["mode"], "closed and duplicate notices are hidden");
  assert.deepEqual(c.visibleNotices([n("budget", "97% used")], closed).map((x) => x.id), ["budget"], "a new value shows again");
  const out = html(h(c.Composer, { ...base, busy: false, notices: h(c.PromptNotices, { items: [{ id: "budget", tone: "warn", text: "You've used 94%", action: { label: "Start a fresh chat", run: noop } }], onClose: noop }) }));
  const card = out.slice(out.indexOf('class="chat-input-card"'));
  assert.ok(card.indexOf("chat-prompt-notice") >= 0 && card.indexOf("chat-prompt-notice") < card.indexOf("<textarea"), "the strip is inside the card, above the message");
  assert.match(out, /aria-label="Close: You&#x27;ve used 94%"/);
  assert.match(out, /Start a fresh chat/);
  assert.equal(html(h(c.PromptNotices, { items: [], onClose: noop })), "");
});

test("Bypass is the desktop default; a browser without the host starts on Ask", () => {
  assert.equal(c.createChatUiStore(null, "bypass").getSnapshot().permission, "bypass");
  assert.equal(c.createChatUiStore(null).getSnapshot().permission, "ask");
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /createChatUiStore\(initialSessionId, host\.bypass \? "bypass" : "ask"\)/);
  // The host's approval is still required: asked on a chat's first message, never skipped.
  assert.match(screen, /gate\.request\(activeId, bypassSummary/);
  assert.match(screen, /\(busy \? Promise\.resolve\(\) : ensureBypass\(\)\)\.then\(\(\) => controller\.send\(activeId, text/);
  const surface = readFileSync(join(CHAT, "surface.tsx"), "utf8");
  assert.match(surface, /createChatUiStore\(null, bypass \? "bypass" : "ask"\)/);
});
