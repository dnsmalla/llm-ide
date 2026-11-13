// The switch view every consumer reads once the catalog drives them
// (LLMIDE_EXT_ACTIVE_SET on). A gate only RESTRICTS what the legacy builders
// already allow: a consumer still applies its own enable/consent checks and then
// asks the gate "is this item, or this member of it, switched on in the
// catalog?". That is what makes the flag-on result equal the legacy result for
// unchanged data, by construction, while honouring a switched-off item.
//
// Items are matched by kind and name. The publisher segment of an item id is
// ignored on purpose: two installed things of one kind never share a local name,
// and an overlay entry that names a different publisher can then only ever
// switch more off, never less.
//
// Fail closed: an unreadable catalog state file (store.mjs) turns EVERYTHING
// off for the flag-on consumers, and says so once in the log. The three legacy
// files fail toward "nothing enabled" on their own; this one holds switches
// that exist to restrict, so reading it as empty would re-enable them.

import { logger } from '../../core/logger.mjs';
import { readOverlay } from './store.mjs';
import { readInstalled } from './installed.mjs';
import { parseItemId } from './model.mjs';
import { activeSetEnabled } from './flags.mjs';

const log = logger.child({ component: 'extensions-gate' });
let warnedCorrupt = false;

/** Ids of this user's catalog installs (an unreadable record reads as none: entries then restrict as before). */
function installedIdsOf(userId) {
  try {
    const r = readInstalled(userId);
    return r.corrupt ? new Set() : new Set(r.items.keys());
  } catch {
    return new Set();
  }
}

function indexOverlay(overlay, skip = null) {
  const byKindName = new Map();
  for (const [id, entry] of overlay.items) {
    if (skip?.has(id)) continue;
    const p = parseItemId(id);
    if (!p) continue;
    const key = `${p.kind}\u0000${p.name}`;
    const cur = byKindName.get(key);
    // Several publishers for one name: the union of restrictions.
    byKindName.set(key, {
      off: (cur?.off === true) || entry.enabled === false,
      // An explicit enable: only an INSTALLED item needs it (an installed item is
      // recorded switched off); the legacy builders never read it.
      on: (cur?.on === true) || entry.enabled === true,
      disabled: new Set([...(cur?.disabled ?? []), ...entry.disabledMembers]),
    });
  }
  return byKindName;
}

/**
 * @param {string} userId
 * @param {{ overlay?: ReturnType<typeof readOverlay> }} [o]
 */
export function makeGate(userId, { overlay = readOverlay(userId), installedIds = installedIdsOf(userId) } = {}) {
  const failClosed = overlay.corrupt === true;
  if (failClosed && !warnedCorrupt) {
    warnedCorrupt = true;
    log.warn('extensions_state_unreadable', { note: 'extensions-state.json cannot be read; extensions are switched off for catalog-driven consumers until it is fixed or removed' });
  }
  const idx = indexOverlay(overlay);
  // A catalog install's own switch (it is recorded off at install) must never restrict a legacy Plugins / MCP Plugins /
  // LLM Sources item of the same kind and name: the legacy builders read only entries that are not catalog installs.
  const legacyIdx = installedIds.size ? indexOverlay(overlay, installedIds) : idx;
  const entry = (kind, name) => idx.get(`${kind}\u0000${name}`);
  const legacyEntry = (kind, name) => legacyIdx.get(`${kind}\u0000${name}`);
  // `installed` = the asker is a catalog install itself (a plugin with `installedItem`): it reads every switch.
  const pick = (installed) => (installed ? entry : legacyEntry);
  const itemOn = (kind, name, installed = false) => !failClosed && pick(installed)(kind, name)?.off !== true;
  const memberOn = (kind, name, type, member, installed = false) => itemOn(kind, name, installed) && !pick(installed)(kind, name)?.disabled.has(`${type}:${member}`);
  // A stable fingerprint of the restrictions, for caches keyed by the gate.
  const signature = failClosed ? 'closed' : JSON.stringify([[...idx], [...legacyIdx]].map((m) => m.map(([k, v]) => [k, v.off, v.on, [...v.disabled].sort()]).sort()));
  return {
    failClosed,
    signature,
    pluginActive: (name, installed = false) => itemOn('plugin', name, installed),
    pluginMemberActive: (name, type, member, installed = false) => memberOn('plugin', name, type, member, installed),
    /** Names of this plugin's unchecked members, as `<type>:<name>` ids. */
    pluginDisabledMembers: (name, installed = false) => [...(pick(installed)('plugin', name)?.disabled ?? [])].sort(),
    llmSourceActive: (sourceId) => itemOn('llm-source', sourceId),
    librarySkillActive: (sourceId, skillName) => memberOn('llm-source', sourceId, 'skill', skillName),
    mcpActive: (id) => itemOn('mcp', id),
    /**
     * An item installed from a catalog source is loaded only after an explicit
     * enable (it is recorded off), and any entry that switches its name off wins.
     */
    installedActive: (kind, name) => !failClosed && entry(kind, name)?.on === true && entry(kind, name)?.off !== true,
    installedMemberActive: (kind, name, type, member) =>
      !failClosed && entry(kind, name)?.on === true && entry(kind, name)?.off !== true && !entry(kind, name)?.disabled.has(`${type}:${member}`),
  };
}

/**
 * The per-record predicate `effectiveMcpServers` takes: a standalone server
 * answers to its own item switch; a plugin-declared one also to the plugin's
 * `mcp:<server>` member (the registry row is named `<plugin> · <server>`).
 */
export function mcpServerGate(gate) {
  return (rec) => {
    if (!gate.mcpActive(rec.id)) return false;
    if (rec.source === 'plugin' && typeof rec.pluginName === 'string') {
      const server = typeof rec.name === 'string' ? rec.name.split(' \u00b7 ')[1] : undefined;
      if (!gate.pluginActive(rec.pluginName)) return false;
      if (server && !gate.pluginMemberActive(rec.pluginName, 'mcp', server)) return false;
    }
    return true;
  };
}

/** The gate for a flag-on consumer; null when the flag is off (legacy behaviour untouched). */
export function gateFor(userId) {
  return activeSetEnabled() ? makeGate(userId) : null;
}

export function _resetGateWarningForTests() { warnedCorrupt = false; }
