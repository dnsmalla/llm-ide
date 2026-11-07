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
  assert.match(screen, /<div className="chat-notes">[\s\S]*<PendingSwitchNote/);
});
