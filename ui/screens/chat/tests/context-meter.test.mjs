// The composer's context ring (the Mac's ChatComposer.contextUsageChip + ContextUsagePresentation), restored after
// 6669e115 dropped the "Context N%" chip and left state.context unrendered.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("context-meter"); });

const U = { totalTokens: 41250, maxTokens: 200000, percentage: 21, categories: [
  { name: "System prompt", kind: "used", tokens: 3200 }, { name: "Free space", kind: "free", tokens: 158750 }, { name: "Messages", kind: "used", tokens: 38050 }] };

test("labels and rows follow the Mac's ContextUsagePresentation", () => {
  assert.equal(c.contextPercentLabel(U), "21%");
  assert.equal(c.contextTokensLabel(U), "41,250 / 200,000 tokens");
  assert.deepEqual(c.contextRows(U).used.map((r) => r.name), ["System prompt", "Messages"], "used rows first, SDK order kept");
  assert.deepEqual(c.contextRows(U).other.map((r) => r.name), ["Free space"]);
  assert.equal(c.contextShare(U.categories[0], U), "1.6%");
  assert.equal(c.contextShare(U.categories[0], { ...U, maxTokens: 0 }), "–");
  assert.equal(c.contextWarns(U), false);
  assert.equal(c.contextWarns({ ...U, percentage: 80 }), true, "warning from 80 percent");
  assert.equal(c.contextAdvises({ ...U, percentage: 64 }), false, "no advice before 65");
  assert.equal(c.contextAdvises({ ...U, percentage: 65 }), true, "fresh-chat advice from 65");
});

test("the meter renders nothing before a turn reports usage, and a ring with the percentage after", () => {
  assert.equal(html(h(c.ContextMeter, { usage: null })), "");
  const out = html(h(c.ContextMeter, { usage: U }));
  assert.match(out, /aria-label="Context used 21%"/);
  assert.match(out, /title="Context used: 41,250 \/ 200,000 tokens"/);
  assert.match(out, /<circle[^>]*stroke-dasharray=/);
  assert.doesNotMatch(out, /data-warn/);
  assert.match(html(h(c.ContextMeter, { usage: { ...U, percentage: 92 } })), /data-warn="true"/);
});

test("the chat screen hands the meter to the composer bar", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /meter=\{<>\s*<BudgetMeter budget=\{state\.budget\} \/>\s*<ContextMeter usage=\{state\.context\} onNewChat=/);
});
