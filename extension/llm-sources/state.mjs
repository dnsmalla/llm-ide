// Per-user LLM-source enable state.
//
// Stored as a single JSON file next to the llm-sources directory so it
// survives source add/remove and is trivial to back up by hand. Keyed by
// userId so one server process can serve multiple authenticated users with
// different enabled sets. Writes are atomic (tmp + rename).
//
// File: <sourcesDir>/../llm-sources-state.json
// Shape: { [userId]: { enabled: string[] } }

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
  all[userId] = { enabled: [...cur].sort() };
  writeAll(all);
  return cur;
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
    all[userId] = { enabled: [...next].sort() };
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
    if (filtered.length !== entry.enabled.length) {
      all[userId] = { enabled: filtered };
      touched = true;
    }
    if (filtered.length === 0) { delete all[userId]; touched = true; }
  }
  if (touched) writeAll(all);
}
