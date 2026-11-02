// "Add model..." (the Mac's "Add a model" alert): the id rules, the per-connection list that is kept in this browser,
// how the ids join the model groups, the dialog markup, and the Remove that drops an id the core refused.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("model-additions"); });

const claude = { id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [{ provider: "anthropic", model: "claude-opus-5", label: "claude-opus-5" }] };
const catalog = { id: "conn-1", label: "OpenAI", catalog: true, provider: "custom:cat-openai", models: [] };

test("a model id is trimmed and must be non-empty, at most 100 characters, with no spaces or control characters", () => {
  assert.deepEqual(c.validateModelId("  gpt-5 "), { ok: true, id: "gpt-5" });
  assert.deepEqual(c.validateModelId("claude-opus-4-9"), { ok: true, id: "claude-opus-4-9" });
  assert.equal(c.validateModelId("   ").ok, false, "empty after trim");
  assert.equal(c.validateModelId("a".repeat(101)).ok, false);
  assert.equal(c.validateModelId("a".repeat(100)).ok, true);
  assert.equal(c.validateModelId("gpt 5").ok, false, "a space inside the id");
  assert.equal(c.validateModelId("gpt\u0007-5").ok, false, "a control character");
  assert.equal(c.validateModelId("gpt​-5").ok, false, "an invisible format character");
});

test("the stored list is read defensively: bad JSON or a wrong shape reads as empty, bad entries are dropped", () => {
  const storage = (raw) => ({ getItem: () => raw, setItem() {} });
  assert.deepEqual(c.loadUserModels(storage("not json")), {});
  assert.deepEqual(c.loadUserModels(storage("[1,2]")), {});
  assert.deepEqual(c.loadUserModels(storage(JSON.stringify({ anthropic: ["x-1", "x-1", "bad id", 7], other: "no" }))), { anthropic: ["x-1"] });
  assert.deepEqual(c.loadUserModels({ getItem() { throw new Error("denied"); } }), {});
});

test("an id is kept once per connection and at most 50 per connection", () => {
  let d = c.addUserModel({}, "conn-1", "gpt-5");
  d = c.addUserModel(d, "conn-1", "gpt-5");
  assert.deepEqual(d, { "conn-1": ["gpt-5"] });
  for (let i = 0; i < 60; i++) d = c.addUserModel(d, "conn-1", `m-${i}`);
  assert.equal(d["conn-1"].length, 50);
  assert.equal(d["conn-1"].at(-1), "m-59", "the newest ids are kept");
  assert.equal(c.addUserModel({}, "conn-1", "gpt-5")["conn-1"].length, 1, "a new object: the input is not changed");
});

test("the ids join their connection's group as models of that connection's provider, and never twice", () => {
  const dict = { anthropic: ["claude-opus-5", "claude-next-9"], "conn-1": ["gpt-5"] };
  const out = c.withUserModels([claude, catalog], dict);
  assert.deepEqual(out[0].models.map((m) => m.model), ["claude-opus-5", "claude-next-9"]);
  assert.deepEqual(out[0].models[1], { provider: "anthropic", model: "claude-next-9", label: "claude-next-9" });
  assert.deepEqual(out[1].models, [{ provider: "custom:cat-openai", model: "gpt-5", label: "gpt-5" }]);
  assert.equal(out[1].models[0].toolsSupported, undefined, "an added catalog id has no known tool support");
});

test("the target connection is the one the composer uses; a custom provider has none", () => {
  assert.equal(c.addTargetGroup([claude, catalog], "custom:cat-openai")?.id, "conn-1");
  assert.equal(c.addTargetGroup([claude, catalog], null)?.id, "anthropic");
  assert.equal(c.addTargetGroup([claude, catalog], "custom:some-uuid"), undefined);
});

test("Remove drops one id from one connection and leaves the rest", () => {
  const d = c.forgetUserModel({ anthropic: ["a-1", "a-2"], "conn-1": ["gpt-5"] }, "anthropic", "a-1");
  assert.deepEqual(d, { anthropic: ["a-2"], "conn-1": ["gpt-5"] });
});

test("the dialog offers the Mac's title, placeholder and Add / Cancel buttons", () => {
  const out = html(h(c.AddModelDialog, { groupLabel: "OpenAI", onAdd: () => {}, onCancel: () => {} }));
  assert.match(out, /aria-label="Add a model"/);
  assert.match(out, /placeholder="model id, e\.g\. gpt-5 \/ claude-opus-4-9 \/ gemini-2\.5-pro"/);
  assert.match(out, />Add</);
  assert.match(out, />Cancel</);
});

test("a refused pin drops the added id only when the core refused the id itself; a transient failure keeps it", () => {
  const groups = [claude, catalog];
  const dict = { "conn-1": ["gpt-x"], anthropic: ["claude-next-9"] };
  const err = (status, code) => Object.assign(new Error("m"), { status, code });
  const pin = { provider: "custom:cat-openai", model: "gpt-x" };
  assert.deepEqual(c.afterRefusedPin(groups, dict, pin, err(400, "VALIDATION_FAILED")), { "conn-1": [], anthropic: ["claude-next-9"] });
  assert.equal(c.afterRefusedPin(groups, dict, pin, err(0, "NETWORK")), dict, "core unreachable: kept");
  assert.equal(c.afterRefusedPin(groups, dict, pin, err(503, "ROUTE_UNAVAILABLE")), dict, "store down: kept");
  assert.equal(c.afterRefusedPin(groups, dict, pin, err(409, "ROUTER_DISABLED")), dict);
  assert.equal(c.afterRefusedPin(groups, dict, { provider: "anthropic", model: "gpt-x" }, err(400, "VALIDATION_FAILED")), dict, "another connection's id is not touched");
  assert.equal(c.afterRefusedPin(groups, dict, { provider: "", model: "" }, err(400, "VALIDATION_FAILED")), dict, "an unpin drops nothing");
});
