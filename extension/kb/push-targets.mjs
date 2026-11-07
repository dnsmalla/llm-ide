// Push targets of paired Host API devices (push notifications plan): one Web Push subscription or APNs device token
// per device. A row goes with its device (FOREIGN KEY … ON DELETE CASCADE): revoke, idle expiry, the device cap and an
// identity reset all remove it. Endpoints and tokens are capability values: never logged, never returned by a route.
import { getDb, requireUser } from './db.mjs';
import { parseScopes } from './host-api-devices.mjs';

export function setPushTarget(userId, deviceId, t, now = Date.now()) {
  requireUser(userId);
  getDb().prepare(`INSERT INTO host_api_push (user_id, device_id, kind, endpoint, p256dh, auth, token, environment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET kind = excluded.kind, endpoint = excluded.endpoint, p256dh = excluded.p256dh,
      auth = excluded.auth, token = excluded.token, environment = excluded.environment, created_at = excluded.created_at,
      last_result = NULL, last_at = NULL`)
    .run(userId, String(deviceId), t.kind, t.endpoint ?? null, t.p256dh ?? null, t.auth ?? null, t.token ?? null, t.environment ?? null, now);
}
export function clearPushTarget(userId, deviceId) {
  requireUser(userId);
  return getDb().prepare('DELETE FROM host_api_push WHERE user_id = ? AND device_id = ?').run(userId, String(deviceId)).changes > 0;
}
export function pushTargetKind(userId, deviceId) {
  requireUser(userId);
  return getDb().prepare('SELECT kind FROM host_api_push WHERE user_id = ? AND device_id = ?').get(userId, String(deviceId))?.kind ?? null;
}
export function listPushTargets(userId) {
  requireUser(userId);
  return getDb().prepare(`SELECT p.device_id, d.name, d.scopes, p.kind, p.endpoint, p.p256dh, p.auth, p.token, p.environment, p.last_result, p.last_at
    FROM host_api_push p JOIN host_api_devices d ON d.user_id = p.user_id AND d.device_id = p.device_id
    WHERE p.user_id = ? ORDER BY d.last_seen_at DESC`).all(userId)
    .map((r) => ({ deviceId: r.device_id, name: r.name, scopes: parseScopes(r.scopes), kind: r.kind, endpoint: r.endpoint, p256dh: r.p256dh,
      auth: r.auth, token: r.token, environment: r.environment, lastResult: r.last_result, lastAt: r.last_at }));
}
export function notePushResult(userId, deviceId, result, now = Date.now()) {
  requireUser(userId);
  getDb().prepare('UPDATE host_api_push SET last_result = ?, last_at = ? WHERE user_id = ? AND device_id = ?').run(String(result).slice(0, 80), now, userId, String(deviceId));
}
