// Per-user connector selection state — which catalog connectors the user
// has added (and therefore sees in Settings → Connections).
//
// Mirror of plugins/state.mjs: a single JSON file beside the plugin dir so
// it is trivial to back up by hand, keyed by userId, atomic writes.
//
// File: <pluginDir>/../connector-state.json
// Shape: { [userId]: { selected: string[] } }
//
// First read for a user pre-selects box and slack: those connectors shipped
// hardcoded in Settings before this catalog existed, so an upgrading user's
// look must not change until they choose (spec constraint 2).
//
// The base-dir derivation is deliberately duplicated from
// mcp/state.mjs — connectors may not import plugins/ or mcp/ (ESLint
// layer rules), and the duplication is three lines.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { catalogEntry } from './connector-catalog.mjs';

const PRESELECTED = ['box', 'slack'];

function baseDir() {
  return process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
}

function statePath() {
  return join(dirname(baseDir()), 'connector-state.json');
}

function readAll() {
  const p = statePath();
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {}; // corrupt — next write overwrites cleanly
  }
}

function writeAll(data) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, p);
}

function selectedArray(userId) {
  const all = readAll();
  const entry = all[userId];
  if (!entry || !Array.isArray(entry.selected)) return null;
  return entry.selected.filter((id) => typeof id === 'string');
}

/** The user's selected connector ids. First read pre-selects box+slack. */
export function selectedConnectors(userId) {
  const existing = selectedArray(userId);
  if (existing === null) {
    const all = readAll();
    all[userId] = { selected: [...PRESELECTED] };
    writeAll(all);
    return new Set(PRESELECTED);
  }
  return new Set(existing);
}

/** Select a catalog connector. Returns false for unknown ids. */
export function selectConnector(userId, id) {
  if (!catalogEntry(id)) return false;
  const all = readAll();
  const current = selectedArray(userId) ?? [...PRESELECTED];
  if (!current.includes(id)) current.push(id);
  all[userId] = { selected: current };
  writeAll(all);
  return true;
}

/** Deselect a connector. Removing never deletes data (spec constraint 3). */
export function deselectConnector(userId, id) {
  const all = readAll();
  const current = selectedArray(userId) ?? [...PRESELECTED];
  all[userId] = { selected: current.filter((x) => x !== id) };
  writeAll(all);
}

/** Drop selections whose ids no longer exist in the catalog. */
export function pruneOrphanSelections() {
  const all = readAll();
  let changed = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (!entry || !Array.isArray(entry.selected)) continue;
    const kept = entry.selected.filter((id) => catalogEntry(id));
    if (kept.length !== entry.selected.length) {
      all[userId] = { selected: kept };
      changed = true;
    }
  }
  if (changed) writeAll(all);
}
