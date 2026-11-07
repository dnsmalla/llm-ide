// Push notifications sent by the desktop core (push notifications plan): the VAPID and APNs credentials in the user's
// vault, the de-dup / coalesce / per-device gate (the desktop notifier's rules, enforced again here), and the fan-out of
// one fixed kind to the user's paired devices that registered a target and were granted `push`. Never logs an
// endpoint, a device token or a key.
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { clearPushTarget, listPushTargets, notePushResult, pushTargetKind, setPushTarget } from '../../kb/push-targets.mjs';
import { newVapidJwk, vapidKeyOf, sendWebPush } from '../../server/push/webpush.mjs';
import { APNS_ID_RE, apnsKeyOf, sendApns } from '../../server/push/apns.mjs';
import { COUNTED, isPushKind, webPayload, apnsPayload } from '../../server/push/kinds.mjs';
import { TokenBucket } from './rate.mjs';

export const PUSH_LIMITS = Object.freeze({ coalesceMs: 10_000, seenMax: 256, deviceBurst: 10, devicePerHour: 30 });
const APNS_KEYS = ['push.apnsKey', 'push.apnsKeyId', 'push.apnsTeamId'];

export function vapidFor(userId, db = getDb()) {
  let text = getSecret(db, userId, 'push.vapidKey');
  if (!text) { text = newVapidJwk(); setSecret(db, userId, 'push.vapidKey', text); }
  return vapidKeyOf(text);
}

export function apnsCredentials(userId, db = getDb()) {
  const key = apnsKeyOf(getSecret(db, userId, 'push.apnsKey'));
  const keyId = getSecret(db, userId, 'push.apnsKeyId');
  const teamId = getSecret(db, userId, 'push.apnsTeamId');
  return key && APNS_ID_RE.test(keyId ?? '') && APNS_ID_RE.test(teamId ?? '') ? { key, keyId, teamId } : null;
}

export function apnsStatus(userId, db = getDb()) {
  const c = apnsCredentials(userId, db);
  return { configured: c !== null, keyId: c?.keyId ?? null, teamId: c?.teamId ?? null };
}

export function setApnsCredentials(userId, { key, keyId, teamId } = {}, db = getDb()) {
  if (!apnsKeyOf(key)) return { ok: false, field: 'key' };
  if (typeof keyId !== 'string' || !APNS_ID_RE.test(keyId)) return { ok: false, field: 'keyId' };
  if (typeof teamId !== 'string' || !APNS_ID_RE.test(teamId)) return { ok: false, field: 'teamId' };
  db.transaction(() => { setSecret(db, userId, APNS_KEYS[0], key); setSecret(db, userId, APNS_KEYS[1], keyId); setSecret(db, userId, APNS_KEYS[2], teamId); })();
  return { ok: true, keyId };
}

export function clearApnsCredentials(userId, db = getDb()) {
  db.transaction(() => { for (const k of APNS_KEYS) setSecret(db, userId, k, null); })();
}

export const pushConfig = (userId, deviceId) => ({ webPushKey: vapidFor(userId).publicKey, apns: apnsCredentials(userId) !== null, registered: pushTargetKind(userId, deviceId) ?? 'none' });
export const registerTarget = (userId, deviceId, target) => setPushTarget(userId, deviceId, target);
export const unregisterTarget = (userId, deviceId) => clearPushTarget(userId, deviceId);

/** The Settings card's view: never an endpoint, a token or a key. */
export function pushStatus(userId, served) {
  return {
    served: Boolean(served), apns: apnsStatus(userId),
    devices: listPushTargets(userId).map(({ deviceId, name, kind, lastResult, lastAt }) => ({ deviceId, name, kind, lastResult, lastAt })),
  };
}

export function createPushGate(limits = PUSH_LIMITS) {
  const seen = [];
  const last = new Map();    // `${userId}\0${kind}` -> ms
  const buckets = new Map(); // deviceId -> TokenBucket (bounded by the paired devices)
  return {
    admit(userId, kind, key, now) {
      if (key) {
        const k = `${userId}\0${kind}\0${key}`;
        if (seen.includes(k)) return false;
        seen.push(k);
        if (seen.length > limits.seenMax) seen.shift();
      }
      const lk = `${userId}\0${kind}`;
      const t = last.get(lk);
      if (t != null && now - t < limits.coalesceMs) return false;
      last.set(lk, now);
      return true;
    },
    device(deviceId, now) {
      let b = buckets.get(deviceId);
      if (!b) { b = new TokenBucket(limits.deviceBurst, limits.devicePerHour / 3600, now); buckets.set(deviceId, b); }
      return b.take(now) == null;
    },
  };
}
export const pushGate = createPushGate();

/** Sends one kind to every paired device of the user with a target and a `push` grant. Never throws. */
export async function dispatchPush(userId, { kind, key = null, count = 1 }, { gate, served, now = Date.now(), send = { webpush: sendWebPush, apns: sendApns }, db = getDb(), log = () => {} }) {
  if (!served || !isPushKind(kind) || !gate.admit(userId, kind, key, now)) return { sent: 0 };
  let sent = 0;
  let vapid = null;
  let apns;
  for (const t of listPushTargets(userId).filter((x) => x.scopes.includes('push'))) {
    if (!gate.device(t.deviceId, now)) { notePushResult(userId, t.deviceId, 'rate_limited', now); continue; }
    let r;
    try {
      if (t.kind === 'webpush') {
        vapid ??= vapidFor(userId, db);
        r = await send.webpush(t, webPayload(kind, count), { vapid, urgency: COUNTED.has(kind) ? 'high' : 'normal', topic: kind, now });
      } else {
        if (apns === undefined) apns = apnsCredentials(userId, db);
        r = apns ? await send.apns({ token: t.token, environment: t.environment, payload: apnsPayload(kind, count), collapseId: kind, credentials: apns, now })
          : { ok: false, code: 'APNS_NOT_CONFIGURED' };
      }
    } catch { r = { ok: false, code: 'PUSH_FAILED' }; }
    if (r.gone) { clearPushTarget(userId, t.deviceId); log(`push ${t.kind} target gone — removed`); continue; }
    notePushResult(userId, t.deviceId, r.ok ? 'ok' : r.code, now);
    if (r.ok) sent += 1; else log(`push ${t.kind} failed (${r.code})`);
  }
  return { sent };
}
