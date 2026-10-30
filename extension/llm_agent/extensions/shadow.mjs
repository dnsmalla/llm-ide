// Shadow compare (plan P1, like kb/agent-usage.mjs compareLedgerShadow): the
// computed active set against what the legacy consumers ACTUALLY loaded for a
// turn. Counts only: no item ids, no names, no configs reach the log.
//
// A mismatch is not automatically a bug: with LLMIDE_EXT_ACTIVE_SET off the
// catalog's switches have no effect on loading, so an item the catalog has
// switched off shows up as "loaded by legacy, absent from the active set". That
// number is exactly what turning the flag on would change, which is why it is
// worth logging. With the flag on, any mismatch is a defect.
//
// Rate-limited to once per user per local day, so it costs one extra compute
// per user per day and nothing on the other turns.

import { logger } from '../../core/logger.mjs';
import { computeActiveSet, summarizeActiveSet } from './active-set.mjs';
import { shadowEnabled, activeSetEnabled } from './flags.mjs';

const log = logger.child({ component: 'extensions-shadow' });
const MAX_USERS = 2000;
const lastRun = new Map();   // userId -> 'YYYY-MM-DD'
let lastResult = null;

const day = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function diff(legacy, active) {
  const a = new Set(legacy);
  const b = new Set(active);
  let onlyLegacy = 0;
  let onlyActive = 0;
  for (const x of a) if (!b.has(x)) onlyLegacy += 1;
  for (const x of b) if (!a.has(x)) onlyActive += 1;
  return { legacy: a.size, active: b.size, onlyLegacy, onlyActive };
}

/**
 * Compare an active set with what a turn loaded.
 * @param {object} active  computeActiveSet(...)
 * @param {{ sdkPlugins?: string[], pluginSkills?: string[], commands?: string[], subagents?: string[], mcpServers?: string[] }} loaded
 *   plain lists of identities (plugin names, `plugin/skill` keys, trigger names, server ids)
 */
export function compareActiveSetToLoaded(active, loaded) {
  const categories = {
    nativePlugins: diff(loaded.nativePlugins ?? [], active.nativePlugins),
    pluginSkills: diff(loaded.pluginSkills ?? [], active.pluginSkills.map((s) => `${s.plugin}/${s.name}`)),
    commands: diff(loaded.commands ?? [], active.commands.map((c) => `${c.plugin}/${c.trigger}`)),
    subagents: diff(loaded.subagents ?? [], active.subagents.map((s) => `${s.plugin}/${s.name}`)),
    mcpServers: diff(loaded.mcpServers ?? [], Object.keys(active.mcpServers)),
  };
  const mismatches = Object.values(categories).reduce((n, c) => n + c.onlyLegacy + c.onlyActive, 0);
  return { ok: mismatches === 0, mismatches, categories };
}

/**
 * Run at most once per user per day. Never throws; never blocks a turn on
 * anything but one synchronous compute of already-small local state.
 * @returns {object | null} the result, or null when skipped
 */
export function runTurnShadow(userId, mode, loaded, { now = Date.now(), compute = computeActiveSet, computeOpts = {} } = {}) {
  try {
    if (!shadowEnabled() || !userId) return null;
    const today = day(now);
    if (lastRun.get(userId) === today) return null;
    if (lastRun.size >= MAX_USERS) lastRun.clear();
    lastRun.set(userId, today);
    const active = compute(userId, mode, computeOpts);
    const cmp = compareActiveSetToLoaded(active, loaded);
    const result = { at: new Date(now).toISOString(), flagOn: activeSetEnabled(), ...cmp, summary: summarizeActiveSet(active) };
    lastResult = result;
    const line = { flagOn: result.flagOn, mismatches: result.mismatches, ...result.summary, categories: result.categories };
    if (!cmp.ok && result.flagOn) log.warn('extensions_shadow_mismatch', line);
    else log.info('extensions_shadow', line);
    return result;
  } catch (err) {
    log.warn('extensions_shadow_failed', { error: String(err?.message || err).slice(0, 160) });
    return null;
  }
}

export function lastShadowResult() { return lastResult; }
export function _resetShadowForTests() { lastRun.clear(); lastResult = null; }
