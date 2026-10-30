// Fills a createWorld() world with state: three users with different choices.
//   u1  everything on: plugins alpha/hooky(trusted)/owned/codexy, builtin skill
//       `beta` unchecked, extra source on, MCP linear + sentry + alpha-srv
//       consented and enabled, `unused` consented only
//   u2  one own-format plugin
//   u3  untouched first-time user
// Call after createWorld() and after the users exist (freshDb).
import assert from 'node:assert/strict';
import { mcpRows } from './extensions-world.mjs';

export async function populateWorld(world, [u1, u2, u3]) {
  const registry = await import('../../llm_agent/skills/registry.mjs');
  const pluginState = await import('../../plugins/state.mjs');
  const sources = await import('../../llm-sources/registry.mjs');
  const sourceState = await import('../../llm-sources/state.mjs');
  const mcp = await import('../../mcp/state.mjs');
  const { setPluginHookTrust } = await import('../../plugins/hook-trust.mjs');

  registry.reloadPlugins();
  sources.seedBuiltinOnce();
  sources.writeRegistry([...sources.readRegistry(), { id: 'extra', name: 'Extra', origin: 'local', location: world.extra }]);
  mcp.writeMcpRegistry([...mcp.readMcpRegistry(), ...mcpRows()]);
  registry.reloadPlugins(); // registers alpha's declared server as the plugin-sourced row `alpha-srv`

  for (const n of ['alpha', 'hooky', 'owned', 'codexy']) pluginState.setEnabled(u1, n, true);
  const trust = setPluginHookTrust(u1, 'hooky', true, { listPlugins: (uid) => registry.listInstalledPlugins(uid).plugins });
  assert.equal(trust.ok, true, JSON.stringify(trust));
  sourceState.setEnabled(u1, 'extra', true);
  sourceState.setItemsEnabled(u1, 'builtin', 'skill', ['beta'], false);
  for (const id of ['linear', 'sentry', 'alpha-srv']) { mcp.setConsented(u1, id, true); mcp.setEnabledMcp(u1, id, true); }
  mcp.setConsented(u1, 'unused', true);
  pluginState.setEnabled(u2, 'owned', true);
  return { u1, u2, u3 };
}
