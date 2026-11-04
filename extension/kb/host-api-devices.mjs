// Host API v1 paired devices (desktop host). Only SHA-256 hashes of tokens are stored; a token is
// shown once, at pairing. Lookup is by hash (a unique index), so the token itself never touches SQL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb, requireUser } from './db.mjs';

export const MAX_DEVICES_PER_USER = 20;
export const MAX_IDLE_MS = 30 * 24 * 3600 * 1000;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function issueDeviceToken(userId, name, now = Date.now()) {
  requireUser(userId);
  const deviceId = `h1-${randomUUID()}`;
  const token = randomBytes(32).toString('base64url');
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO host_api_devices (user_id, device_id, name, token_hash, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, deviceId, String(name || 'Device').slice(0, 120), hash(token), now, now);
    const extra = db.prepare('SELECT device_id FROM host_api_devices WHERE user_id = ? ORDER BY last_seen_at DESC, paired_at DESC LIMIT -1 OFFSET ?')
      .all(userId, MAX_DEVICES_PER_USER);
    for (const r of extra) db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(userId, r.device_id);
  })();
  return { deviceId, token };
}

export function authenticateDeviceToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const db = getDb();
  const row = db.prepare('SELECT user_id, device_id, last_seen_at FROM host_api_devices WHERE token_hash = ?').get(hash(token));
  if (!row) return null;
  if (now - row.last_seen_at > MAX_IDLE_MS) {
    db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(row.user_id, row.device_id);
    return null;
  }
  db.prepare('UPDATE host_api_devices SET last_seen_at = ? WHERE user_id = ? AND device_id = ?').run(now, row.user_id, row.device_id);
  return { userId: row.user_id, deviceId: row.device_id };
}

export function revokeDevice(userId, deviceId) {
  requireUser(userId);
  return getDb().prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(userId, String(deviceId)).changes > 0;
}

export function listDevices(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT device_id, name, paired_at, last_seen_at FROM host_api_devices WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId).map((r) => ({ deviceId: r.device_id, name: r.name, pairedAt: r.paired_at, lastSeenAt: r.last_seen_at }));
}

export function getQuickChatId(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT chat_session_id FROM host_api_quick_chat WHERE user_id = ?').get(userId)?.chat_session_id ?? null;
}

export function setQuickChatId(userId, chatSessionId) {
  requireUser(userId);
  getDb().prepare('INSERT INTO host_api_quick_chat (user_id, chat_session_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET chat_session_id = excluded.chat_session_id')
    .run(userId, String(chatSessionId));
}
