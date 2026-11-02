// The two model-picker action notices: which ones show, and that their button only asks the shell to open Settings
// at Model routing (one bus message, nothing else: no route write, no settings write).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("model-notices"); });

const catalog = { id: "conn-1", label: "OpenAI", catalog: true, provider: "custom:cat-openai", models: [] };
const claude = { id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [] };

test("the tools notice shows when a chat is plain because tools are off; the router notice when it is off and catalog models exist", () => {
  assert.deepEqual(c.modelNotices({ plainChat: "toolsOff", routerOn: true, groups: [claude] }), ["tools"]);
  assert.deepEqual(c.modelNotices({ plainChat: "modelLacksTools", routerOn: true, groups: [claude] }), []);
  assert.deepEqual(c.modelNotices({ plainChat: null, routerOn: false, groups: [claude, catalog] }), ["router"]);
  assert.deepEqual(c.modelNotices({ plainChat: null, routerOn: false, groups: [claude] }), [], "no catalog models, no router offer");
  assert.deepEqual(c.modelNotices({ plainChat: null, routerOn: undefined, groups: [catalog] }), [], "no route read yet: nothing offered");
  assert.deepEqual(c.modelNotices({ plainChat: "toolsOff", routerOn: false, groups: [catalog] }), ["tools", "router"]);
});

test("the notice buttons carry the Mac's labels", () => {
  const out = html(h(c.ModelNotices, { kinds: ["tools", "router"] }));
  assert.match(out, /Allow tools on provider models/);
  assert.match(out, /Turn on the session router \(applies at next backend start\)/);
});

test("the button publishes one goto-section to Settings at Model routing and does nothing else", () => {
  const seen = [];
  const bus = { publish: (ev) => seen.push(ev), subscribe() { return () => {}; }, takePending() { return null; } };
  c.openModelRouting(bus);
  assert.deepEqual(seen, [{ type: "goto-section", section: "settings", anchor: "model-routing" }]);
});
