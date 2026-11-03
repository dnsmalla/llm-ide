// The two model-picker action notices: which ones show, and that their button only asks the shell to open Settings
// at Model routing; Allow tools now writes the same switch the Mac writes.
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
  assert.match(out, /Allow tools/);
  assert.match(out, /Turn on the session router \(applies at next backend start\)/);
});

test("Allow tools writes the provider settings switch and never opens Settings", async () => {
  const calls = [];
  const core = { async json(method, path, body) { calls.push({ method, path, body }); return {}; } };
  await c.enableProviderTools(core);
  assert.deepEqual(calls, [{ method: "PUT", path: "/kb/providers/settings", body: { toolsEnabled: true } }]);
});

test("the router button publishes one goto-section to Settings at Model routing", () => {
  const seen = [];
  const bus = { publish: (ev) => seen.push(ev), subscribe() { return () => {}; }, takePending() { return null; } };
  c.openModelRouting(bus);
  assert.deepEqual(seen, [{ type: "goto-section", section: "settings", anchor: "model-routing" }]);
});
