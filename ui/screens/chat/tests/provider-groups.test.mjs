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
