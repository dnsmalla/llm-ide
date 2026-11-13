// The model picker lists every provider the chat can run, as the Mac's grouped menu did
// (CodeAssistantModelState+Providers.composerProviderSections, LlmIdeAPIClient+ProviderCatalog.refreshCatalogConnectionIndex).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("provider-groups"); });

const CLAUDE = { "POST /kb/providers/models": { models: ["claude-opus-5"], entries: [{ id: "claude-opus-5", displayName: "Opus 5" }] } };

test("a Claude-compatible endpoint connected in Settings is listed after Claude, with its live models", async () => {
  const core = fakeCore({ json: { ...CLAUDE,
    "GET /kb/providers/custom": { providers: [
      { id: "ac-glm", provider: "custom:ac-glm", name: "GLM", enabled: true, hasKey: true, source: "connection" },
      { id: "ac-off", provider: "custom:ac-off", name: "Off", enabled: false, hasKey: true, source: "connection" },
      { id: "ac-nokey", provider: "custom:ac-nokey", name: "No key", enabled: true, hasKey: false, source: "connection" },
      { id: "uuid-1", provider: "custom:uuid-1", name: "Mac synced", enabled: true, hasKey: true, source: "synced" }] },
    "POST /kb/providers/catalog/models": (body) => body.id === "ac-glm" ? { models: [{ id: "glm-5", toolsSupported: true }] } : { models: [] },
    "GET /kb/providers/catalog": { settings: { toolsEnabled: false }, providers: [] },
  } });
  const { groups } = await c.loadModelGroups(core);
  assert.deepEqual(groups.map((g) => g.id), ["anthropic", "ac-glm"], "Claude stays first; disabled, keyless and synced rows are not listed");
  assert.deepEqual(groups[1], { id: "ac-glm", label: "GLM", catalog: false, provider: "custom:ac-glm", models: [{ provider: "custom:ac-glm", model: "glm-5", label: "glm-5" }] });
  assert.equal(c.providerCannotChat("custom:ac-glm", groups), false, "a chat on it is no longer reported as blocked");
});

test("a keyless local catalog connection (keyRequired false) is listed; a keyed one without its key is not", async () => {
  const core = fakeCore({ json: { ...CLAUDE,
    "GET /kb/providers/catalog": { settings: { toolsEnabled: true }, providers: [
      { id: "ollama", name: "Ollama", keyRequired: false, connections: [{ id: "cat-ollama", provider: "custom:cat-ollama", name: "", enabled: true, hasKey: false }] },
      { id: "openai", name: "OpenAI", keyRequired: true, connections: [{ id: "cat-openai", provider: "custom:cat-openai", name: "OpenAI", enabled: true, hasKey: false }] }] },
    "POST /kb/providers/catalog/models": { models: [{ id: "llama3", toolsSupported: false }] },
  } });
  const { groups } = await c.loadModelGroups(core);
  assert.deepEqual(groups.map((g) => [g.id, g.label]), [["anthropic", "Claude"], ["cat-ollama", "Ollama"]]);
  assert.deepEqual(groups[1].models, [{ provider: "custom:cat-ollama", model: "llama3", label: "llama3", toolsSupported: false }]);
});

test("an empty Claude list says why (the core's detail) instead of showing a bare Default", async () => {
  const core = fakeCore({ json: { "POST /kb/providers/models": { models: [], detail: "no API key configured" } } });
  const { groups } = await c.loadModelGroups(core);
  assert.equal(groups[0].note, "The model list is unavailable: no API key configured");
  const quiet = await c.loadModelGroups(fakeCore({ json: { "POST /kb/providers/models": { models: [] } } }));
  assert.equal(quiet.groups[0].note, "The model list is unavailable.");
});

test("an abort while listing rethrows instead of returning a partial list", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(c.loadModelGroups(fakeCore({ json: CLAUDE }), ac.signal), /aborted/);
});

const TIERS = {
  tiers: { strong: { provider: "anthropic", model: "claude-opus-5" }, standard: { provider: "openai", model: "gpt-5" }, cheap: { provider: "openai", model: "gpt-5" },
    decision: { provider: "anthropic", model: "claude-haiku-5" }, image: { provider: "openai", model: "gpt-image-1" } },
  status: { strong: { usable: true }, standard: { usable: true, via: "cli" }, cheap: { usable: true, via: "cli" }, decision: { usable: true }, image: { usable: true, via: "cli" } },
};

test("models set in Tiers & Roles are listed too: a Claude one is selectable, a keyless CLI one is disabled with the reason", async () => {
  const { groups } = await c.loadModelGroups(fakeCore({ json: CLAUDE }));
  assert.equal(groups.some((g) => g.id === "tier-routing"), false, "the picker's own list never waits for the tiers call");
  const cfg = await c.loadTierRouting(fakeCore({ json: { "GET /kb/routing-tiers": TIERS } }));
  const tiers = c.tierRoutingGroup(cfg, groups);
  assert.equal(tiers.id, "tier-routing");
  assert.deepEqual(tiers.models.map((m) => m.model), ["gpt-5", "claude-haiku-5"], "a listed model is not repeated, one row per model, media tiers are not chat models");
  const gpt = tiers.models[0];
  assert.match(gpt.label, /^Codex CLI · gpt-5 \(Standard, Cheap\) — not available in chat$/);
  assert.match(gpt.unavailable, /Codex CLI/);
  assert.equal(tiers.models[1].unavailable, undefined, "a Claude model runs on the Agent SDK");
  const all = [...groups, tiers];
  assert.equal(c.providerCannotChat("openai", all), true, "a disabled row never makes its provider count as chat-ready");
  assert.notEqual(c.defaultModelForMode(all, "execute")?.model, "gpt-5", "the mode default never picks a disabled row");
});

test("Tiers & Roles: a custom provider is selectable, an API-key OpenAI tier is not called a CLI, a user-added id is not repeated", () => {
  const listed = [{ id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [{ provider: "anthropic", model: "claude-haiku-5", label: "claude-haiku-5" }] }];
  const g = c.tierRoutingGroup({
    tiers: { strong: { provider: "custom:cat-x", model: "glm-6" }, standard: { provider: "openai", model: "gpt-5" }, cheap: { provider: "anthropic", model: "claude-haiku-5" } },
    status: { strong: { usable: true }, standard: { usable: true, via: "api" }, cheap: { usable: true } },
  }, listed);
  assert.deepEqual(g.models.map((m) => [m.model, m.unavailable === undefined]), [["glm-6", true], ["gpt-5", false]]);
  assert.doesNotMatch(g.models[1].label, /CLI/);
  assert.doesNotMatch(g.models[1].unavailable, /CLI/);
});

test("no tier config, or a failed tiers call, adds nothing; an abort rethrows", async () => {
  assert.equal(await c.loadTierRouting(fakeCore({ json: CLAUDE })), null);
  assert.equal(c.tierRoutingGroup(null, []), null);
  assert.equal(c.tierRoutingGroup({ tiers: {} }, []), null);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(c.loadTierRouting(fakeCore({ json: { "GET /kb/routing-tiers": TIERS } }), ac.signal), /aborted/);
});

test("an empty picker says why (the core's reason) next to Connect a provider", async () => {
  const { h, renderToStaticMarkup } = await import("./helpers.mjs");
  const groups = [{ id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [], note: "The model list is unavailable: Claude Code is not installed" }];
  const out = renderToStaticMarkup(h(c.ModelPicker, { groups, provider: null, model: null, route: null, onChange() {}, onConnectProvider() {} }));
  assert.match(out, /Connect a provider/);
  assert.match(out, /The model list is unavailable: Claude Code is not installed/);
  assert.doesNotMatch(out, /Add a model key/);
});
