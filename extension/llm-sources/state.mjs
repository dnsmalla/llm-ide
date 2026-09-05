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
import { defaultSourcesDir } from './registry.mjs';

// Defined here (not registry.mjs) so listEnabled below can default new users
// into it without registry.mjs -> state.mjs -> registry.mjs circularity.
// registry.mjs re-exports this for its own callers.
export const DEFAULT_SOURCES_ID = 'default-sources';

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
  // default them into default-sources so it's genuinely on by default for
  // every user, not just the ones present when enableDefaultSourcesOnce ran.
  // Once any setEnabled call creates their entry, their explicit set (which
  // may or may not include it) takes over, so an intentional opt-out sticks.
  if (!entry) return new Set([DEFAULT_SOURCES_ID]);
  const arr = entry.enabled;
  return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
}

// User ids that have any enable state — used by the server-start hook to
// rebuild the llm_default_sources snapshot for everyone who has one coming
// (realistically a single local user). Keys starting with '__' are reserved
// markers (see enableDefaultSourcesOnce), never user ids.
export function listStateUserIds() {
  return Object.keys(readAll()).filter((k) => !k.startsWith('__'));
}

// One-time: add the default-sources id to every existing user's enabled set
// so it is genuinely enabled by default. A marker (`__defaultsSeeded`)
// guarantees it happens exactly once — a user who later toggles it OFF stays
// off across restarts.
export function enableDefaultSourcesOnce(sourceId) {
  const all = readAll();
  if (all.__defaultsSeeded) return;
  for (const [uid, entry] of Object.entries(all)) {
    if (!uid || uid.startsWith('__')) continue;
    if (entry && Array.isArray(entry.enabled) && !entry.enabled.includes(sourceId)) {
      entry.enabled.push(sourceId);
    }
  }
  all.__defaultsSeeded = true;
  writeAll(all);
}

export function setEnabled(userId, sourceId, enabled) {
  if (!userId || typeof sourceId !== 'string') return new Set();
  const all = readAll();
  // Start from listEnabled's view (not the raw entry) so a brand-new user's
  // first-ever toggle of an unrelated source doesn't wipe out the implicit
  // default-sources membership by materializing an entry without it.
  const cur = listEnabled(userId);
  if (enabled) cur.add(sourceId);
  else cur.delete(sourceId);
  all[userId] = { enabled: [...cur].sort() };
  writeAll(all);
  return cur;
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
