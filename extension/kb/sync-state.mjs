// Durable state for encrypted sync (migration 0064). Every helper takes userId first. No key material here: the
// vault holds it. store_config is non-secret JSON.
import { randomBytes } from 'node:crypto';
import { getDb, requireUser } from './db.mjs';

const parse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const rowToState = (r) => r && ({
  syncId: r.sync_id, enabled: r.enabled === 1, storeKind: r.store_kind, storeConfig: parse(r.store_config),
  epoch: r.epoch, seq: r.seq, lastPublishAt: r.last_publish_at ?? null, lastError: r.last_error ?? null,
  passwordChangedAt: r.password_changed_at ?? null,
});

export function getSyncState(userId) {
  requireUser(userId);
  return rowToState(getDb().prepare('SELECT * FROM sync_state WHERE user_id = ?').get(userId)) ?? null;
}

export function ensureSyncState(userId, { storeKind, storeConfig }) {
  requireUser(userId);
  const db = getDb();
  db.prepare(`INSERT INTO sync_state (user_id, sync_id, store_kind, store_config) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET store_kind = excluded.store_kind, store_config = excluded.store_config`)
    .run(userId, randomBytes(16).toString('base64url'), storeKind, JSON.stringify(storeConfig ?? {}));
  return getSyncState(userId);
}

/** Record that the storage password was changed after a revoke (C5); the Settings reminder reads it back. */
export function markPasswordChanged(userId, at = Date.now()) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_state SET password_changed_at = ? WHERE user_id = ?').run(Number(at) || Date.now(), userId);
}

export function setSyncEnabled(userId, enabled) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_state SET enabled = ? WHERE user_id = ?').run(enabled ? 1 : 0, userId);
}

export function setEpoch(userId, epoch) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_state SET epoch = ? WHERE user_id = ?').run(epoch, userId);
}

/** Hybrid counter (relay design 4.3): monotonic, and never behind the clock, so a restored DB cannot replay a seq. */
export function nextSeq(userId, now = Date.now()) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const { seq } = db.prepare('SELECT seq FROM sync_state WHERE user_id = ?').get(userId);
    const next = Math.max(seq + 1, Math.floor(now));
    db.prepare('UPDATE sync_state SET seq = ? WHERE user_id = ?').run(next, userId);
    return next;
  })();
}

export function recordPublish(userId, { at, error = null }) {
  requireUser(userId);
  if (error) getDb().prepare('UPDATE sync_state SET last_error = ? WHERE user_id = ?').run(String(error).slice(0, 200), userId);
  else getDb().prepare('UPDATE sync_state SET last_publish_at = ?, last_error = NULL WHERE user_id = ?').run(at, userId);
}

export function listEnabledSyncUsers() {
  return getDb().prepare('SELECT user_id FROM sync_state WHERE enabled = 1').all().map((r) => r.user_id);
}

export function addSyncDevice(userId, { deviceId, dir, tier, name, ecdhSpki, signingSpki, now = Date.now() }) {
  requireUser(userId);
  getDb().prepare('INSERT INTO sync_devices (user_id, device_id, dir, tier, name, ecdh_spki, signing_spki, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, deviceId, dir, tier, String(name).slice(0, 120), Buffer.from(ecdhSpki), Buffer.from(signingSpki), now);
}

export function listSyncDevices(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM sync_devices WHERE user_id = ? ORDER BY added_at').all(userId).map((r) => ({
    deviceId: r.device_id, dir: r.dir, tier: r.tier, name: r.name, ecdhSpki: Buffer.from(r.ecdh_spki),
    signingSpki: Buffer.from(r.signing_spki), addedAt: r.added_at, wrapEpoch: r.wrap_epoch,
  }));
}

export function setDeviceWrapEpoch(userId, deviceId, epoch) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_devices SET wrap_epoch = ? WHERE user_id = ? AND device_id = ?').run(epoch, userId, deviceId);
}

export function getPublished(userId, deviceId) {
  requireUser(userId);
  const out = {};
  for (const r of getDb().prepare('SELECT * FROM sync_published WHERE user_id = ? AND device_id = ?').all(userId, deviceId)) {
    out[r.kind] = { file: r.file, seq: r.seq, fileSha256: r.file_sha256, plainSha256: r.plain_sha256, epoch: r.epoch };
  }
  return out;
}

/** A new MEGA account or folder is a new location: forget every blob record and force fresh key/wrap files there. */
export function resetSyncPublish(userId) {
  requireUser(userId);
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM sync_published WHERE user_id = ?').run(userId);
    getDb().prepare('UPDATE sync_devices SET wrap_epoch = 0 WHERE user_id = ?').run(userId);
  })();
}

export function setPublished(userId, deviceId, kind, { file, seq, fileSha256, plainSha256, epoch }) {
  requireUser(userId);
  getDb().prepare(`INSERT INTO sync_published (user_id, device_id, kind, file, seq, file_sha256, plain_sha256, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id, device_id, kind) DO UPDATE SET file = excluded.file, seq = excluded.seq,
                   file_sha256 = excluded.file_sha256, plain_sha256 = excluded.plain_sha256, epoch = excluded.epoch`)
    .run(userId, deviceId, kind, file, seq, fileSha256, plainSha256, epoch);
}

/** Record-before-execute (relay design 5.2 step 5): true only the first time this request id is seen. */
export function recordRequest(userId, deviceId, requestId, now = Date.now()) {
  requireUser(userId);
  return getDb().prepare("INSERT OR IGNORE INTO sync_requests (user_id, device_id, request_id, state, received_at) VALUES (?, ?, ?, 'running', ?)")
    .run(userId, deviceId, requestId, now).changes === 1;
}

export function finishRequest(userId, deviceId, requestId, state) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_requests SET state = ? WHERE user_id = ? AND device_id = ? AND request_id = ?').run(state, userId, deviceId, requestId);
}

export function countRequestsSince(userId, deviceId, sinceMs) {
  requireUser(userId);
  return getDb().prepare('SELECT COUNT(*) n FROM sync_requests WHERE user_id = ? AND device_id = ? AND received_at >= ?').get(userId, deviceId, sinceMs).n;
}

/** Revoke (design 5.3): the device row and its published-blob records go together; its request history stays. */
export function deleteSyncDevice(userId, deviceId) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM sync_published WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
    return db.prepare('DELETE FROM sync_devices WHERE user_id = ? AND device_id = ?').run(userId, deviceId).changes === 1;
  })();
}

/** Publish records for one device in one transaction, so a crash cannot leave half a manifest's kinds recorded. */
export function setPublishedMany(userId, deviceId, entries) {
  requireUser(userId);
  const db = getDb();
  db.transaction(() => { for (const [kind, e] of Object.entries(entries)) setPublished(userId, deviceId, kind, e); })();
}

/** A storage-kind switch: every device's pairing names the old storage, so all go; request history stays. */
export function forgetSyncDevices(userId) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM sync_published WHERE user_id = ?').run(userId);
    return db.prepare('DELETE FROM sync_devices WHERE user_id = ?').run(userId).changes;
  })();
}
