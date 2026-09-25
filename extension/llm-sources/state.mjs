// Per-user LLM-source enable state.
//
// Stored as a single JSON file next to the llm-sources directory so it
// survives source add/remove and is trivial to back up by hand. Keyed by
// userId so one server process can serve multiple authenticated users with
// different enabled sets. Writes are atomic (tmp + rename).
//
// File: <sourcesDir>/../llm-sources-state.json
// Shape: { [userId]: { enabled: string[], disabledItems?: { [sourceId]: string[] } } }
//
// `disabledItems` holds the items a user UNCHECKED inside a source, keyed
// `<kind>:<name>` (see itemKey). Storing the unchecked set rather than the
// checked one is deliberate: an item nobody has touched — including one that
// only arrived with the latest update — is on, and an uncheck survives
// updates. Every writer below keeps both fields; rewriting an entry as
// `{ enabled }` alone would silently re-check everything the user turned off.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultSourcesDir, BUILTIN_ID, LEGACY_DEFAULT_SOURCES_ID } from './registry.mjs';

function stateFilePath() {
  return join(dirname(defaultSourcesDir()), 'llm-sources-state.json');
}

function readAll() {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch { return {}; }
}

function writeAll(state) {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function listEnabled(userId) {
  if (!userId) return new Set();
  const all = readAll();
  const entry = all[userId];
  // A user with no state entry at all has never touched their enabled set —
  // default them into the builtin (.skills) source so it's genuinely on by
  // default for every user. Once any setEnabled call creates their entry,
  // their explicit set (which may or may not include it) takes over, so an
  // intentional opt-out sticks.
  if (!entry) return new Set([BUILTIN_ID]);
  const arr = entry.enabled;
  return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
}

export function setEnabled(userId, sourceId, enabled) {
  if (!userId || typeof sourceId !== 'string') return new Set();
  const all = readAll();
  // Start from listEnabled's view (not the raw entry) so a brand-new user's
  // first-ever toggle of an unrelated source doesn't wipe out the implicit
  // builtin membership by materializing an entry without it.
  const cur = listEnabled(userId);
  if (enabled) cur.add(sourceId);
  else cur.delete(sourceId);
  all[userId] = { ...all[userId], enabled: [...cur].sort() };
  writeAll(all);
  return cur;
}

// ── Per-item selection ──────────────────────────────────────────────
// The kinds a user can check/uncheck inside a source. Hooks and MCP servers
// are deliberately absent: they stay whole-source, behind their own
// trust/consent gates.
export const ITEM_KINDS = Object.freeze(['skill', 'agent', 'command', 'template']);
// A name is a frontmatter `name` / directory name. The same names are handed
// to the kit installer's --exclude, so anything that could be read as a path
// or an option is refused here rather than there.
const ITEM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function isValidItemName(name) {
  return typeof name === 'string' && ITEM_NAME_RE.test(name) && !name.includes('..');
}

export function itemKey(kind, name) { return `${kind}:${name}`; }

export function listDisabledItems(userId, sourceId) {
  if (!userId || typeof sourceId !== 'string') return new Set();
  const arr = readAll()[userId]?.disabledItems?.[sourceId];
  return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []);
}

export function isItemEnabled(userId, sourceId, kind, name) {
  return !listDisabledItems(userId, sourceId).has(itemKey(kind, name));
}

export function setItemsEnabled(userId, sourceId, kind, names, enabled) {
  if (!userId || typeof sourceId !== 'string' || !ITEM_KINDS.includes(kind)) {
    return listDisabledItems(userId, sourceId);
  }
  const valid = (Array.isArray(names) ? names : []).filter(isValidItemName);
  const all = readAll();
  const cur = listDisabledItems(userId, sourceId);
  for (const n of valid) {
    if (enabled) cur.delete(itemKey(kind, n));
    else cur.add(itemKey(kind, n));
  }
  // Materialize the enabled set from listEnabled's view, for the same reason
  // setEnabled does: a first-ever write must not drop the implicit builtin.
  const entry = { ...all[userId], enabled: [...listEnabled(userId)].sort() };
  const items = { ...entry.disabledItems };
  if (cur.size) items[sourceId] = [...cur].sort();
  else delete items[sourceId];
  if (Object.keys(items).length) entry.disabledItems = items;
  else delete entry.disabledItems;
  all[userId] = entry;
  writeAll(all);
  return cur;
}

// After a source update: forget unchecked keys whose item no longer exists,
// so a later item that reuses the name isn't born unchecked. `presentKeys`
// is the source's full `<kind>:<name>` set after the update.
export function pruneMissingItems(sourceId, presentKeys) {
  const all = readAll();
  let touched = false;
  for (const [userId, entry] of Object.entries(all)) {
    const arr = entry?.disabledItems?.[sourceId];
    if (userId.startsWith('__') || !Array.isArray(arr)) continue;
    const kept = arr.filter((k) => presentKeys.has(k));
    if (kept.length === arr.length) continue;
    const items = { ...entry.disabledItems };
    if (kept.length) items[sourceId] = kept;
    else delete items[sourceId];
    all[userId] = { ...entry, disabledItems: items };
    if (!Object.keys(items).length) delete all[userId].disabledItems;
    touched = true;
  }
  if (touched) writeAll(all);
}

// One-shot repair for state persisted before v44. `default-sources` no longer
// exists as a source, so a user who had it enabled would otherwise be left
// with an enabled set that names nothing installed — no skills at all, and
// silently (listEnabled's builtin fallback only applies to users with NO
// entry). Having the defaults on meant "I want skills", so map it onto the
// builtin (.skills) source rather than merely deleting it. Idempotent; writes
// only when something changed. Called by registry.mjs's seedBuiltinOnce()
// BEFORE it drops the legacy registry row (see the ordering note there), so
// no caller has to remember it and no pruneOrphans() can race it.
export function migrateLegacyDefaultSources() {
  const all = readAll();
  let touched = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (userId.startsWith('__') || !entry || !Array.isArray(entry.enabled)) continue;
    if (!entry.enabled.includes(LEGACY_DEFAULT_SOURCES_ID)) continue;
    const next = new Set(entry.enabled.filter((s) => s !== LEGACY_DEFAULT_SOURCES_ID));
    next.add(BUILTIN_ID);
    all[userId] = { ...entry, enabled: [...next].sort() };
    touched = true;
  }
  if (touched) writeAll(all);
  return touched;
}

export function pruneOrphans(installedIds) {
  const all = readAll();
  let touched = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (!entry || !Array.isArray(entry.enabled)) continue;
    const filtered = entry.enabled.filter((n) => installedIds.has(n));
    let items = entry.disabledItems;
    if (items && typeof items === 'object') {
      const keptItems = Object.fromEntries(
        Object.entries(items).filter(([sid]) => installedIds.has(sid)));
      if (Object.keys(keptItems).length !== Object.keys(items).length) {
        items = Object.keys(keptItems).length ? keptItems : undefined;
        touched = true;
      }
    }
    if (filtered.length !== entry.enabled.length || items !== entry.disabledItems) {
      all[userId] = items ? { ...entry, enabled: filtered, disabledItems: items } : { ...entry, enabled: filtered };
      if (!items) delete all[userId].disabledItems;
      touched = true;
    }
    // An entry left with no sources reverts to the first-time default
    // (builtin on). One that still records unchecked items is kept — with that
    // same default spelled out — or those unchecks would be lost.
    if (filtered.length === 0) {
      if (items) all[userId] = { ...all[userId], enabled: [BUILTIN_ID] };
      else delete all[userId];
      touched = true;
    }
  }
  if (touched) writeAll(all);
}
