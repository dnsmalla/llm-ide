// The catalog's own per-user state: a switch overlay on the three legacy
// stores (plan section 5.1, 10).
//
// File: <pluginDir>/../extensions-state.json
// Shape: { version: 1, users: { [userId]: { items: { [itemId]: {
//            enabled?: boolean, disabledMembers?: string[] } } } } }
//
// Until the catalog can install anything (P4) the overlay can only RESTRICT:
// an item or member the overlay turns off is off, and one it leaves alone
// follows the legacy state (plugin-state.json, llm-sources-state.json,
// mcp-plugins-state.json), which stays the written source of truth. An
// `enabled: true` is recorded but changes nothing yet.
//
// A file that exists but cannot be read is NOT treated as "nothing is
// switched off": that would re-enable everything a user turned off. It is
// reported as `corrupt`, and consumers fail closed (gate.mjs).
//
// Writes are atomic (tmp + rename), mode 0o600. Every writer merges into the
// existing entry.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultPluginDir } from '../../plugins/loader.mjs';
import { parseItemId, parseMemberId } from './model.mjs';

export function storeFilePath() {
  return join(dirname(defaultPluginDir()), 'extensions-state.json');
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeUser = (userId) => typeof userId === 'string' && userId && !UNSAFE_KEYS.has(userId);

/** @returns {{ corrupt: boolean, users: Record<string, any> }} */
function readAll() {
  const path = storeFilePath();
  if (!existsSync(path)) return { corrupt: false, users: Object.create(null) };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.users !== 'object' || data.users === null
        || Array.isArray(data.users)) {
      return { corrupt: true, users: Object.create(null) };
    }
    const users = Object.create(null);
    for (const [k, v] of Object.entries(data.users)) if (!UNSAFE_KEYS.has(k)) users[k] = v;
    return { corrupt: false, users };
  } catch {
    return { corrupt: true, users: Object.create(null) };
  }
}

function writeAll(users) {
  const path = storeFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * One user's overlay: Map<itemId, { enabled?: boolean, disabledMembers: Set<string> }>.
 * Malformed entries are skipped, not fatal; an unreadable FILE is `corrupt`.
 */
export function readOverlay(userId) {
  const all = readAll();
  const items = new Map();
  if (!safeUser(userId)) return { corrupt: all.corrupt, items };
  const entries = all.users[userId]?.items;
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    for (const [id, raw] of Object.entries(entries)) {
      if (!parseItemId(id) || !raw || typeof raw !== 'object') continue;
      const disabled = new Set((Array.isArray(raw.disabledMembers) ? raw.disabledMembers : [])
        .filter((m) => typeof m === 'string' && parseMemberId(m)));
      items.set(id, { ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}), disabledMembers: disabled });
    }
  }
  return { corrupt: all.corrupt, items };
}

function mutate(userId, itemIdValue, fn) {
  if (!safeUser(userId) || !parseItemId(itemIdValue)) return false;
  const all = readAll();
  // Never overwrite a file we could not read: that would erase the user's
  // switches. The operator has to look at it.
  if (all.corrupt) return false;
  const user = all.users[userId] && typeof all.users[userId] === 'object' ? { ...all.users[userId] } : {};
  const items = user.items && typeof user.items === 'object' && !Array.isArray(user.items) ? { ...user.items } : {};
  const cur = items[itemIdValue] && typeof items[itemIdValue] === 'object' ? { ...items[itemIdValue] } : {};
  const next = fn(cur);
  if (next && Object.keys(next).length) items[itemIdValue] = next; else delete items[itemIdValue];
  if (Object.keys(items).length) user.items = items; else delete user.items;
  if (Object.keys(user).length) all.users[userId] = user; else delete all.users[userId];
  writeAll(all.users);
  return true;
}

/** Switch one item off (or record an explicit on). Returns false when refused. */
export function setItemEnabled(userId, id, enabled) {
  return mutate(userId, id, (cur) => ({ ...cur, enabled: enabled === true }));
}

/** Uncheck or re-check members of one item (`<type>:<name>` ids). */
export function setMembersEnabled(userId, id, memberIds, enabled) {
  const valid = (Array.isArray(memberIds) ? memberIds : []).filter((m) => typeof m === 'string' && parseMemberId(m));
  return mutate(userId, id, (cur) => {
    const set = new Set(Array.isArray(cur.disabledMembers) ? cur.disabledMembers : []);
    for (const m of valid) { if (enabled) set.delete(m); else set.add(m); }
    const next = { ...cur };
    if (set.size) next.disabledMembers = [...set].sort(); else delete next.disabledMembers;
    return next;
  });
}

/** Forget everything for one user (account deletion). */
export function forgetUser(userId) {
  if (!safeUser(userId)) return false;
  const all = readAll();
  if (all.corrupt || !(userId in all.users)) return false;
  delete all.users[userId];
  writeAll(all.users);
  return true;
}
