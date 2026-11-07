// The closed model picker names the provider and the model (the Mac's composer chip), and says where more
// providers come from while only Claude is set up (ComposerCatalog.moreProvidersHint).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("model-chip"); });

const noop = () => {};
const CLAUDE = { id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [{ provider: "anthropic", model: "claude-a", label: "Claude A" }] };
const GROQ = { id: "cat-groq", label: "Groq", catalog: true, provider: "custom:cat-groq", models: [{ provider: "custom:cat-groq", model: "llama", label: "llama", toolsSupported: true }, { provider: "custom:cat-groq", model: "tiny", label: "tiny", toolsSupported: false }] };
const selected = (out) => /<option value="([^"]*)" selected="">([^<]*)</.exec(out)?.slice(1, 3) ?? null;
const picker = (props) => html(h(c.ModelPicker, { groups: [CLAUDE, GROQ], provider: "custom:cat-groq", model: "llama", onChange: noop, ...props }));

test("the chosen option carries its provider; the other options keep the bare name and the tools badge", () => {
  const out = picker({});
  assert.deepEqual(selected(out), ["custom:cat-groq|llama", "Groq · llama  (tools)"]);
  assert.match(out, /<option value="custom:cat-groq\|tiny">tiny  \(no tools\)<\/option>/);
  assert.match(out, /<option value="anthropic\|claude-a">Claude A<\/option>/);
});

test("modelOptionText is one string (one text node), chosen or not", () => {
  assert.equal(c.modelOptionText(CLAUDE, CLAUDE.models[0], true), "Claude · Claude A");
  assert.equal(c.modelOptionText(CLAUDE, CLAUDE.models[0], false), "Claude A");
  assert.equal(c.modelOptionText(GROQ, { label: "x" }, true), "Groq · x", "no badge without a known tools flag");
});

test("only Claude set up: the picker says where more providers come from; with another provider it does not", () => {
  assert.match(html(h(c.ModelPicker, { groups: [CLAUDE], provider: null, model: null, onChange: noop })), /More providers: Settings → Providers/);
  assert.doesNotMatch(picker({}), /More providers/);
});
