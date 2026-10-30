// computeActiveSet: the one function that says what is ON for a user's turn
// (plan section 5.2): skills, commands, subagents, SDK plugins, hooks, MCP
// servers and a fingerprint of all of it.
//
// It does not re-derive the loading rules. It runs the SAME builders the
// consumers use (plugin delivery, the skill set, the skill library, the user MCP
// builder), forced through the catalog gate (gate.mjs), so the answer cannot
// drift from what a flag-on consumer loads. The flag decides who reads it; the
// computation itself is always available (the shadow compare and the provider
// adapter use it whatever LLMIDE_EXT_ACTIVE_SET says).
//
// The result carries MCP server configs (they may hold a vault-resolved
// credential): never log it. `summarizeActiveSet` is the loggable view.

import { createHash } from 'node:crypto';
import {
  buildUserPluginDelivery, buildPerUserSkillSet, listSkillLibrary, loadedPlugins,
} from '../skills/index.mjs';
import { buildUserMcpServers } from './mcp-servers.mjs';
import { importCatalogItems } from './importer.mjs';
import { makeGate } from './gate.mjs';

const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/**
 * @param {string} userId
 * @param {string} [mode]
 * @param {{ nativeEnabled?: boolean, cwd?: string, env?: object, onNote?: Function, readSecret?: Function,
 *           restrictsToolsFn?: Function, plugins?: object[], gate?: object }} [o]
 */
export function computeActiveSet(userId, mode = 'execute', o = {}) {
  const gate = o.gate ?? makeGate(userId);
  const plugins = o.plugins ?? loadedPlugins();
  const excluded = [];

  const delivery = buildUserPluginDelivery(userId, {
    nativeEnabled: o.nativeEnabled ?? true, cwd: o.cwd, env: o.env, onNote: o.onNote, gate,
    onExcluded: (e) => excluded.push({ kind: 'plugin', name: e.plugin, reason: e.reason }),
  });
  const set = buildPerUserSkillSet(userId, { gate });
  const library = listSkillLibrary(userId, { gate });
  const mcp = buildUserMcpServers(userId, mode, {
    gate, readSecret: o.readSecret, ...(o.restrictsToolsFn ? { restrictsToolsFn: o.restrictsToolsFn } : {}),
  });
  const imported = importCatalogItems(userId, { plugins, withMembers: false });

  const pluginSkills = [];
  for (const [name, s] of set.skills) if (s.pluginName) pluginSkills.push({ name, plugin: s.pluginName });
  const commands = [...set.commands].map(([trigger, c]) => ({ trigger, plugin: c.pluginName }));
  const subagents = [...set.subagents].map(([name, s]) => ({ name, plugin: s.pluginName }));
  const skills = library.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, sourceId: s.sourceId, path: s.path }));
  const activeItems = imported.items.filter((i) => i.state.enabled);

  // What identifies "this exact set of loaded things", never their text or secrets.
  const fingerprint = sha({
    items: activeItems.map((i) => [i.id, i.source?.commit ?? i.version ?? null, i.state.disabledMembers]),
    skills: skills.map((s) => s.id).sort(),
    pluginSkills: pluginSkills.map((s) => `${s.plugin}/${s.name}`).sort(),
    commands: commands.map((c) => `${c.plugin}/${c.trigger}`).sort(),
    subagents: subagents.map((s) => `${s.plugin}/${s.name}`).sort(),
    native: [...delivery.native].sort(),
    translated: [...delivery.translated].sort(),
    mcp: Object.entries(mcp.servers).map(([id, cfg]) => [id, sha(cfg)]).sort((a, b) => a[0].localeCompare(b[0])),
  });

  return {
    mode,
    items: activeItems.map((i) => ({ id: i.id, kind: i.kind, trust: i.publisher.trust })),
    skills, pluginSkills, commands, subagents,
    sdkPlugins: delivery.sdkPlugins,
    nativePlugins: delivery.native,
    translatedPlugins: delivery.translated,
    hooks: delivery.hooks,
    mcpServers: mcp.servers,
    allowedTools: mcp.allowedTools,
    fingerprint,
    excluded,
    failClosed: gate.failClosed,
    warnings: imported.warnings,
  };
}

/** Counts only: safe for a log line or a notice. */
export function summarizeActiveSet(active) {
  return {
    fingerprint: active.fingerprint,
    items: active.items.length,
    skills: active.skills.length,
    pluginSkills: active.pluginSkills.length,
    commands: active.commands.length,
    subagents: active.subagents.length,
    sdkPlugins: active.sdkPlugins.length,
    mcpServers: Object.keys(active.mcpServers).length,
    excluded: active.excluded.length,
    failClosed: active.failClosed === true,
  };
}
