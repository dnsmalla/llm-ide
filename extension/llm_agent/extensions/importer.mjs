// Reads today's three state files into catalog items WITHOUT changing them
// (plan section 10: dual-read first, write-through later).
//
//   plugins      plugin-state.json (+ plugin-sources.json provenance) and the
//                installed plugin directory (the loader's plugin objects)
//   llm-sources  llm-sources.json + llm-sources-state.json (enabled sources and
//                the per-source unchecked `disabledItems`)
//   mcp          mcp-plugins.json + mcp-plugins-state.json (enabled AND consented)
//
// plus the catalog's own overlay (store.mjs). Nothing is written. A reader that
// fails (a corrupt file, an odd shape) costs its section, never the whole
// import: the failure is returned in `warnings` and the section is empty, which
// reads as "nothing enabled", the safe direction.

import { basename, dirname } from 'node:path';
import { readSources, validateSource } from '../../plugins/source-store.mjs';
import { defaultPluginDir } from '../../plugins/loader.mjs';
import { listEnabled as listEnabledPlugins, listHooksTrusted, listHooksTrustedKinds } from '../../plugins/state.mjs';
import { listSources, itemKeysOf, BUILTIN_ID } from '../../llm-sources/registry.mjs';
import { listEnabled as listEnabledSources, listDisabledItems } from '../../llm-sources/state.mjs';
import { listMcpPluginsWithState } from '../../mcp/state.mjs';
import { itemId, normalizeItem, parseMemberId, publisherFromSource } from './model.mjs';
import { readOverlay } from './store.mjs';

function skillNameOf(file) {
  return basename(file) === 'SKILL.md' ? basename(dirname(file)) : basename(file).replace(/\.md$/, '');
}

function overlayFor(overlay, kind, name) {
  // Same matching rule as the gate: kind + name, publisher ignored.
  let off = false;
  const disabled = new Set();
  for (const [id, entry] of overlay.items) {
    const m = /^([^:]+):[^/]+\/(.+)$/.exec(id);
    if (!m || m[1] !== kind || m[2] !== name) continue;
    if (entry.enabled === false) off = true;
    for (const d of entry.disabledMembers) disabled.add(d);
  }
  return { off, disabled };
}

/**
 * @param {string} userId
 * @param {{ plugins?: Iterable<object>, pluginDir?: string, withMembers?: boolean, overlay?: object }} [o]
 *   `plugins` are the loader's plugin objects (llm_agent/skills/registry.mjs
 *   owns the loaded registry and hands them in); without them no plugin items.
 * @returns {{ items: object[], warnings: string[], corrupt: boolean }}
 */
export function importCatalogItems(userId, { plugins = [], pluginDir = defaultPluginDir(), withMembers = true, overlay } = {}) {
  const warnings = [];
  const items = [];
  const ov = overlay ?? readOverlay(userId);
  if (ov.corrupt) warnings.push('extensions-state.json is unreadable; every item reads as switched off');
  const push = (raw, legacy) => {
    const n = normalizeItem(raw);
    if (n.error) { warnings.push(`${raw?.id ?? '?'}: ${n.error}`); return; }
    items.push({ ...n.item, legacy });
  };

  // ── plugins ────────────────────────────────────────────────────────────
  const pluginById = new Map();
  try {
    const enabled = listEnabledPlugins(userId);
    const granted = listHooksTrusted(userId);
    const grantedKinds = listHooksTrustedKinds(userId);
    let sources = {};
    try { sources = readSources(pluginDir); } catch (err) { warnings.push(`plugin sources: ${err?.message || err}`); }
    for (const p of plugins) {
      try {
        let recorded = Object.hasOwn(sources, p.name) ? sources[p.name] : null;
        if (recorded) {
          // An invalid provenance record is reported and ignored: the plugin is
          // still installed and enabled, it just has no pin to show.
          const v = validateSource(recorded);
          if (v.ok) recorded = v.source;
          else { warnings.push(`plugin ${p.name}: recorded source ignored (${v.error})`); recorded = null; }
        }
        const publisher = publisherFromSource(recorded);
        const members = [];
        for (const f of Array.isArray(p.skillFiles) ? p.skillFiles : []) members.push({ type: 'skill', name: skillNameOf(f) });
        for (const t of Object.keys(p.commands || {})) members.push({ type: 'command', name: t });
        for (const a of Object.keys(p.subagents || {})) members.push({ type: 'agent', name: a });
        for (const s of Array.isArray(p.mcpServers) ? p.mcpServers : []) if (s?.name) members.push({ type: 'mcp', name: s.name });
        const kinds = Array.isArray(p.executableKinds) ? p.executableKinds : [];
        if ((Array.isArray(p.hooks) && p.hooks.length) || p.declaresHooks === true || kinds.includes('hooks')) members.push({ type: 'hook', name: 'hooks' });
        if (kinds.includes('lsp')) members.push({ type: 'lsp', name: 'lsp' });
        if (kinds.includes('bin')) members.push({ type: 'bin', name: 'bin' });
        const o = overlayFor(ov, 'plugin', p.name);
        const legacyEnabled = enabled.has(p.name);
        const id = itemId('plugin', publisher.id, p.name);
        pluginById.set(p.name, { id, publisherId: publisher.id, active: legacyEnabled && !o.off && !ov.corrupt });
        push({
          id, source: recorded && typeof recorded === 'object' ? recorded : { kind: 'local' },
          version: p.version, publisher, members, declared: { executableKinds: kinds },
          state: {
            enabled: legacyEnabled && !o.off && !ov.corrupt,
            disabledMembers: [...o.disabled],
            consents: {
              hooksTrusted: granted.has(p.name),
              hooksTrustedKinds: [...(grantedKinds.get(p.name) ?? [])].sort(),
            },
          },
        }, { enabled: legacyEnabled });
      } catch (err) { warnings.push(`plugin ${p?.name}: ${err?.message || err}`); }
    }
  } catch (err) { warnings.push(`plugins: ${err?.message || err}`); }

  // ── llm sources ────────────────────────────────────────────────────────
  try {
    const enabled = listEnabledSources(userId);
    for (const src of listSources()) {
      try {
        if (!src || typeof src.id !== 'string') continue;
        const publisher = src.origin === 'git' ? { id: 'git', trust: 'unknown' } : { id: 'local', trust: 'local' };
        const members = [];
        if (withMembers && src.location) {
          for (const key of itemKeysOf(src.location)) {
            const m = parseMemberId(key);
            if (m) members.push(m);
          }
        }
        const unchecked = [...listDisabledItems(userId, src.id)];
        const o = overlayFor(ov, 'llm-source', src.id);
        const legacyEnabled = enabled.has(src.id);
        push({
          id: itemId('llm-source', publisher.id, src.id), source: { kind: 'local' },
          version: typeof src.version === 'string' ? src.version : null, publisher, members,
          declared: { executableKinds: [] },
          state: {
            enabled: legacyEnabled && !o.off && !ov.corrupt,
            disabledMembers: [...new Set([...unchecked, ...o.disabled])],
            consents: {},
          },
        }, { enabled: legacyEnabled, builtin: src.id === BUILTIN_ID });
      } catch (err) { warnings.push(`llm-source ${src?.id}: ${err?.message || err}`); }
    }
  } catch (err) { warnings.push(`llm-sources: ${err?.message || err}`); }

  // ── mcp servers ────────────────────────────────────────────────────────
  try {
    for (const rec of listMcpPluginsWithState(userId).plugins) {
      try {
        if (!rec || typeof rec.id !== 'string') continue;
        const fromPlugin = rec.source === 'plugin' && typeof rec.pluginName === 'string';
        const parent = fromPlugin ? pluginById.get(rec.pluginName) : null;
        const publisher = rec.source === 'catalog' ? { id: 'catalog', trust: 'community' }
          : (fromPlugin && parent ? { id: parent.publisherId, trust: 'local' } : { id: 'local', trust: 'local' });
        const o = overlayFor(ov, 'mcp', rec.id);
        const legacyActive = rec.enabled === true && rec.consented === true;
        // A server a plugin declares answers to the plugin's own switch too.
        const parentOk = !fromPlugin || (parent ? parent.active : false);
        push({
          id: itemId('mcp', publisher.id, rec.id), source: { kind: 'local' },
          version: typeof rec.version === 'string' ? rec.version : null, publisher, members: [],
          declared: { executableKinds: ['mcp'] },
          state: {
            enabled: legacyActive && parentOk && !o.off && !ov.corrupt,
            disabledMembers: [...o.disabled],
            consents: { consented: rec.consented === true, transport: rec.transport === 'http' || rec.transport === 'sse' ? rec.transport : 'stdio' },
          },
        }, { enabled: rec.enabled === true, consented: rec.consented === true });
      } catch (err) { warnings.push(`mcp ${rec?.id}: ${err?.message || err}`); }
    }
  } catch (err) { warnings.push(`mcp: ${err?.message || err}`); }

  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, warnings, corrupt: ov.corrupt === true };
}
