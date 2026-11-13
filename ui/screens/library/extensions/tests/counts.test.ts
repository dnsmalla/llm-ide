// The Library sidebar's Extensions badges: switched-on items per group, read with the panes' own list calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtensionCounts } from "../counts.ts";
import type { LegacyApi } from "../legacy.ts";
import type { ExtensionsApi } from "../api.ts";

const rows = (...enabled: boolean[]) => enabled.map((e) => ({ enabled: e }));

test("counts the switched-on items of every group", async () => {
  const legacy = { plugins: async () => rows(true, false, true), llmSources: async () => rows(false), mcpPlugins: async () => rows(true) } as unknown as LegacyApi;
  const api = { installed: async () => ({ corrupt: false, items: rows(true, true, false, true) }) } as unknown as ExtensionsApi;
  assert.deepEqual(await loadExtensionCounts(legacy, api), { plugins: 2, "llm-sources": 0, "mcp-plugins": 1, extensions: 3 });
});

test("a group whose list fails is null (no badge), the others still count", async () => {
  const legacy = { plugins: async () => { throw new Error("offline"); }, llmSources: async () => rows(true), mcpPlugins: async () => rows() } as unknown as LegacyApi;
  const api = { installed: async () => { throw new Error("corrupt"); } } as unknown as ExtensionsApi;
  assert.deepEqual(await loadExtensionCounts(legacy, api), { plugins: null, "llm-sources": 1, "mcp-plugins": 0, extensions: null });
});

test("an abort rethrows instead of returning stale counts", async () => {
  const ac = new AbortController();
  ac.abort();
  const legacy = { plugins: async () => rows(), llmSources: async () => rows(), mcpPlugins: async () => rows() } as unknown as LegacyApi;
  const api = { installed: async () => ({ corrupt: false, items: [] }) } as unknown as ExtensionsApi;
  await assert.rejects(loadExtensionCounts(legacy, api, ac.signal));
});
