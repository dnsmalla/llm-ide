// Host API v1 paired devices (desktop host). Only SHA-256 hashes of tokens are stored; a token is
// shown once, at pairing. Lookup is by hash (a unique index), so the token itself never touches SQL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb, requireUser } from './db.mjs';
import { DEVICE_TOKEN_MAX_LIFETIME_MS, isDeviceTokenExpired } from '../core/device-lifetime.mjs';

export const MAX_DEVICES_PER_USER = 20;
export const MAX_IDLE_MS = 30 * 24 * 3600 * 1000;
// C5: a paired device is never permanent — 90 days after pairing it must re-pair, whatever its activity.
// The rule is shared with the sync manifest grace in core/device-lifetime.mjs (vector: schema/sync/v1).
export const MAX_LIFETIME_MS = DEVICE_TOKEN_MAX_LIFETIME_MS;
// What a token paired before scopes existed (scopes NULL) may use: never tool_approvals.
export const LEGACY_SCOPES = Object.freeze(['host', 'chat', 'approvals']);
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function parseScopes(text) {
  if (text == null) return [...LEGACY_SCOPES];
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v) && v.every((c) => typeof c === 'string')) return v;
  } catch { /* fall through */ }
  return ['host']; // unreadable grant: fail closed to the minimum
}

export function issueDeviceToken(userId, name, now = Date.now(), scopes = null) {
  requireUser(userId);
  const deviceId = `h1-${randomUUID()}`;
  const token = randomBytes(32).toString('base64url');
  const db = getDb();
  // Devices pushed out by the cap; the caller ends their live sessions.
  const evicted = db.transaction(() => {
    db.prepare('INSERT INTO host_api_devices (user_id, device_id, name, token_hash, paired_at, last_seen_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, deviceId, String(name || 'Device').slice(0, 120), hash(token), now, now, scopes == null ? null : JSON.stringify(scopes));
    const extra = db.prepare('SELECT device_id FROM host_api_devices WHERE user_id = ? AND device_id != ? ORDER BY last_seen_at DESC, paired_at DESC LIMIT -1 OFFSET ?')
      .all(userId, deviceId, MAX_DEVICES_PER_USER - 1);
    for (const r of extra) db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(userId, r.device_id);
    return extra.map((r) => r.device_id);
  })();
  return { deviceId, token, evicted };
}

export function authenticateDeviceToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const db = getDb();
  const row = db.prepare('SELECT user_id, device_id, paired_at, last_seen_at, scopes FROM host_api_devices WHERE token_hash = ?').get(hash(token));
  if (!row) return null;
  if (isDeviceTokenExpired(row.paired_at, now)) {
    // Past its lifetime: delete it, so the next request re-pairs instead of reusing a stale grant.
    db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(row.user_id, row.device_id);
    return null;
  }
  if (now - row.last_seen_at > MAX_IDLE_MS) {
    db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(row.user_id, row.device_id);
    return null;
  }
  db.prepare('UPDATE host_api_devices SET last_seen_at = ? WHERE user_id = ? AND device_id = ?').run(now, row.user_id, row.device_id);
  return { userId: row.user_id, deviceId: row.device_id, pairedAt: row.paired_at, scopes: parseScopes(row.scopes) };
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

// One current Host API chat per (user, project). No project means the legacy/global chat, stored under
// project_id '' (migration 0074); `host_api_quick_chat` is the pre-0074 pointer and is only read by the
// migration that copies it.
// The pointer is valid only while its session still exists AND belongs to the same project. A stale or
// cross-project row reads as absent, so a turn creates a chat in the frame's project instead of writing
// history into another project's session (API 128 PROJECT_MISMATCH).
// The Execute surface keeps its own chat: its pointer is stored under a prefixed key (no migration), while the
// session itself still belongs to the real project, which is what the JOIN checks.
const surfaceKey = (pid, surface) => (surface === 'execute' ? `~execute:${pid}` : pid);

export function getQuickChatId(userId, projectId = null, surface = 'ask') {
  requireUser(userId);
  const pid = projectId || '';
  const key = surfaceKey(pid, surface);
  return getDb().prepare(`
    SELECT q.chat_session_id
      FROM host_api_project_chat q
      JOIN chat_sessions s ON s.id = q.chat_session_id AND s.user_id = q.user_id
     WHERE q.user_id = ? AND q.project_id = ?
       AND ((? = '' AND s.project_id IS NULL) OR s.project_id = ?)
  `).get(userId, key, pid, pid)?.chat_session_id ?? null;
}

export function setQuickChatId(userId, chatSessionId, projectId = null, surface = 'ask') {
  requireUser(userId);
  getDb().prepare(`
    INSERT INTO host_api_project_chat (user_id, project_id, chat_session_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, project_id) DO UPDATE SET chat_session_id = excluded.chat_session_id
  `).run(userId, surfaceKey(projectId || '', surface), String(chatSessionId));
}
