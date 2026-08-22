// Per-user plugin enable state.
//
// Stored as a single JSON file next to the plugin directory so it
// survives plugin install/remove and is trivial to back up by hand.
// Keyed by userId so the same server process can serve multiple
// authenticated users with different enable sets.
//
// File: <pluginDir>/../plugin-state.json
// Shape: { [userId]: { enabled: string[], hooksTrusted?: string[] } }
//
// `hooksTrusted` is additive: a state file written before hooks existed has
// only `enabled` and keeps working (absent means "trusted nothing"). Every
// writer below MERGES into the existing user entry rather than replacing it,
// or toggling one list would silently erase the other.
//
// Writes are atomic (tmp file + rename) so a crash mid-save can't
// corrupt the file.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultPluginDir } from './loader.mjs';

function stateFilePath() {
  return join(dirname(defaultPluginDir()), 'plugin-state.json');
}

function readAll() {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    // Corrupt file — return empty rather than crash. Operator can
    // inspect; next write will overwrite cleanly.
    return {};
  }
}

function writeAll(state) {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Return the Set of plugin names this user has enabled. Empty Set
 * for first-time users — plugins are opt-in, not opt-out.
 */
export function listEnabled(userId) {
  if (!userId) return new Set();
  const all = readAll();
  const arr = all[userId]?.enabled;
  return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
}

/**
 * Toggle one plugin on/off for a user. Returns the new full Set.
 */
export function setEnabled(userId, pluginName, enabled) {
  if (!userId || typeof pluginName !== 'string') return new Set();
  const all = readAll();
  const cur = new Set(all[userId]?.enabled || []);
  if (enabled) cur.add(pluginName);
  else cur.delete(pluginName);
  all[userId] = { ...all[userId], enabled: [...cur].sort() };
  writeAll(all);
  return cur;
}

/**
 * Plugins whose HOOKS this user has trusted. Hooks run shell commands the
 * plugin author wrote, in the server's own process environment — far more
 * capability than a skill or a command template — so trust is separate from
 * enabling, explicit, and default-off. An empty Set is the norm.
 */
export function listHooksTrusted(userId) {
  if (!userId) return new Set();
  const arr = readAll()[userId]?.hooksTrusted;
  return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
}

/** Grant or revoke hook trust for one plugin. Returns the new full Set. */
export function setHooksTrusted(userId, pluginName, trusted) {
  if (!userId || typeof pluginName !== 'string') return new Set();
  const all = readAll();
  const cur = new Set(all[userId]?.hooksTrusted || []);
  if (trusted) cur.add(pluginName);
  else cur.delete(pluginName);
  all[userId] = { ...all[userId], hooksTrusted: [...cur].sort() };
  writeAll(all);
  return cur;
}

/**
 * Garbage-collect orphan enable entries — names of plugins that are
 * no longer installed on disk. Called by the runtime after a plugin
 * reload so the state file doesn't accumulate stale entries every
 * time a plugin is uninstalled.
 *
 * `installedNames` is a Set of plugin slugs currently discoverable.
 * Empty Set means 'no plugins installed' and prunes every entry.
 */
export function pruneOrphans(installedNames) {
  const all = readAll();
  let touched = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (!entry || typeof entry !== 'object') continue;
    const enabled = Array.isArray(entry.enabled) ? entry.enabled : [];
    const trusted = Array.isArray(entry.hooksTrusted) ? entry.hooksTrusted : [];
    const keptEnabled = enabled.filter((n) => installedNames.has(n));
    // Hook trust is pruned with the same rule: an uninstalled plugin must not
    // keep a standing grant to run shell commands, or reinstalling something
    // by the same name would silently inherit it.
    const keptTrusted = trusted.filter((n) => installedNames.has(n));
    if (keptEnabled.length !== enabled.length || keptTrusted.length !== trusted.length) {
      all[userId] = {
        ...entry,
        enabled: keptEnabled,
        ...(keptTrusted.length ? { hooksTrusted: keptTrusted } : {}),
      };
      if (!keptTrusted.length) delete all[userId].hooksTrusted;
      touched = true;
    }
    // Drop the user entry entirely once nothing is left to remember.
    if (keptEnabled.length === 0 && keptTrusted.length === 0) {
      delete all[userId];
      touched = true;
    }
  }
  if (touched) writeAll(all);
}
