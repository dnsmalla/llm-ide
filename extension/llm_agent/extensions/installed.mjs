// What the user has installed from a catalog source (plan section 5.1/5.3).
//
// File: <pluginDir>/../extensions-installed.json
// Shape: { version: 1, users: { [userId]: { items: { [itemId]: Record } } } }
// Bytes: <pluginDir>/../extensions/store/<hash(userId)>/<item dir>/<commit>/
//
// Per user on purpose: two users installing one repo each get their own pinned
// copy, so one user's update, scan result or uninstall can never touch another's.
// The on/off switches are NOT here: they live in the switch overlay
// (store.mjs), where an install writes `enabled: false`.
//
// Same file discipline as store.mjs: atomic tmp+rename, mode 0600, an unreadable
// file is `corrupt` (writers refuse to overwrite it).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { defaultPluginDir } from '../../plugins/loader.mjs';
import { parseItemId } from './model.mjs';

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const safeUser = (u) => typeof u === 'string' && u && !UNSAFE.has(u);

export const baseDir = () => dirname(defaultPluginDir());
export const installedFilePath = () => join(baseDir(), 'extensions-installed.json');

export function userStoreDir(userId) {
  return join(baseDir(), 'extensions', 'store', createHash('sha256').update(String(userId)).digest('hex').slice(0, 24));
}
export const itemDirName = (id) => id.replace(/[:/]/g, '__');
export const itemStoreDir = (userId, id) => join(userStoreDir(userId), itemDirName(id));

function readAll() {
  const path = installedFilePath();
  if (!existsSync(path)) return { corrupt: false, users: Object.create(null) };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
      return { corrupt: true, users: Object.create(null) };
    }
    const users = Object.create(null);
    for (const [k, v] of Object.entries(data.users)) if (!UNSAFE.has(k)) users[k] = v;
    return { corrupt: false, users };
  } catch { return { corrupt: true, users: Object.create(null) }; }
}

function writeAll(users) {
  const path = installedFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** @returns {{ corrupt: boolean, items: Map<string, any> }} */
export function readInstalled(userId) {
  const all = readAll();
  const items = new Map();
  let corrupt = all.corrupt;
  const entries = safeUser(userId) ? all.users[userId]?.items : undefined;
  if (entries !== undefined) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) corrupt = true;
    else for (const [id, rec] of Object.entries(entries)) {
      if (!parseItemId(id) || !rec || typeof rec !== 'object' || Array.isArray(rec)) { corrupt = true; continue; }
      items.set(id, rec);
    }
  }
  return { corrupt, items };
}

function mutate(userId, fn) {
  if (!safeUser(userId)) return false;
  const all = readAll();
  if (all.corrupt) return false;
  const user = all.users[userId] && typeof all.users[userId] === 'object' ? { ...all.users[userId] } : {};
  const items = user.items && typeof user.items === 'object' && !Array.isArray(user.items) ? { ...user.items } : {};
  fn(items);
  if (Object.keys(items).length) user.items = items; else delete user.items;
  if (Object.keys(user).length) all.users[userId] = user; else delete all.users[userId];
  writeAll(all.users);
  return true;
}

export function putInstalled(userId, id, record) {
  if (!parseItemId(id)) return false;
  return mutate(userId, (items) => { items[id] = record; });
}

export function removeInstalled(userId, id) {
  if (!parseItemId(id)) return false;
  return mutate(userId, (items) => { delete items[id]; });
}

/** Forget one user's records (account deletion). Bytes are removed by the caller (install.mjs). */
export function forgetInstalledUser(userId) {
  if (!safeUser(userId)) return false;
  const all = readAll();
  if (all.corrupt || !(userId in all.users)) return false;
  delete all.users[userId];
  writeAll(all.users);
  return true;
}
