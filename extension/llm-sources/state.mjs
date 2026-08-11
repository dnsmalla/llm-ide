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

function stateFilePath() {
  return join(dirname(defaultSourcesDir()), 'llm-sources-state.json');
}

export const STATE_FILE = stateFilePath();

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
  const arr = all[userId]?.enabled;
  return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
}

export function setEnabled(userId, sourceId, enabled) {
  if (!userId || typeof sourceId !== 'string') return new Set();
  const all = readAll();
  const cur = new Set(all[userId]?.enabled || []);
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
