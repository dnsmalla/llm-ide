// Web Push sent by the desktop core (push notifications plan): RFC 8291 message encryption (aes128gcm, RFC 8188)
// and RFC 8292 VAPID, by hand on node:crypto (no dependency). Each send goes through fixedHostFetch pinned to the ONE
// host of the subscription's endpoint, and that host must be a known browser push service. Never log an endpoint:
// it is a capability URL for that browser.
import crypto from 'node:crypto';
import { fixedHostFetch } from '../fixed-host-fetch.mjs';
import { es256Jwt } from './jwt.mjs';

/** Chrome / Chromium Edge (FCM), Firefox, Safari. */
export const PUSH_SERVICE_HOSTS = Object.freeze(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
// Legacy Edge / Windows WNS: one regional label, e.g. wns2-par02p.notify.windows.com; nothing deeper, nothing else.
const WNS_HOST = /^[a-z0-9-]{1,63}\.notify\.windows\.com$/;
export const isPushServiceHost = (h) => typeof h === 'string' && (PUSH_SERVICE_HOSTS.includes(h) || WNS_HOST.test(h));
export const VAPID_SUBJECT = 'https://llm-ide.com';
export const PUSH_TTL_SECONDS = 3600;
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = 1024; // our payloads are ~40 bytes; one 4096-byte record allows 3993

/** The endpoint as a URL when it is https on 443 to a push service with no userinfo; else null. */
export function pushEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return isPushServiceHost(u.hostname) ? u : null;
}

const b64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** RFC 8291: one aes128gcm record for the subscription's keys. `asPrivate` and `salt` are the Appendix A test seam. */
export function encryptPayload(plaintext, { p256dh, auth }, { asPrivate, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = b64u(p256dh);
  const authSecret = b64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw refuse('PUSH_BAD_KEYS', 'invalid subscription keys');
  const data = Buffer.from(plaintext);
  if (data.length > MAX_PLAINTEXT) throw refuse('PUSH_TOO_LARGE', 'push payload too large');
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  let shared;
  try { shared = ecdh.computeSecret(uaPublic); } catch { throw refuse('PUSH_BAD_KEYS', 'invalid subscription keys'); }
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so the delimiter is 0x02 (last record) and no padding follows.
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** A new VAPID key pair as private JWK JSON (it carries x and y, so the public key derives from it). */
export function newVapidJwk() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return JSON.stringify(privateKey.export({ format: 'jwk' }));
}

/** The signing key and the 65-byte uncompressed public key (base64url) the browser subscribes with. */
export function vapidKeyOf(jwkText) {
  const jwk = JSON.parse(jwkText);
  return {
    privateKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
    publicKey: Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]).toString('base64url'),
  };
}

/** One push. `{ gone: true }` means the browser dropped the subscription (404/410): forget it. */
export async function sendWebPush(sub, plaintext, { vapid, urgency = 'normal', topic, now = Date.now(), fetchImpl = fixedHostFetch }) {
  const u = pushEndpoint(sub?.endpoint);
  if (!u) return { ok: false, code: 'PUSH_HOST_REFUSED' };
  let body;
  try { body = encryptPayload(plaintext, sub); } catch (e) { return { ok: false, code: e?.code ?? 'PUSH_BAD_KEYS' }; }
  const jwt = es256Jwt({ typ: 'JWT' }, { aud: u.origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT }, vapid.privateKey);
  const headers = {
    'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(PUSH_TTL_SECONDS), urgency,
    authorization: `vapid t=${jwt}, k=${vapid.publicKey}`, ...(topic ? { topic } : {}),
  };
  let res;
  try {
    res = await fetchImpl(u.href, { method: 'POST', headers, body }, { hosts: [u.hostname], maxBytes: 16 * 1024 });
  } catch (e) {
    return { ok: false, code: e?.code === 'FETCH_REFUSED' || e?.code === 'SSRF_BLOCKED' ? e.code : 'PUSH_UNREACHABLE' };
  }
  try { await res.body?.cancel(); } catch { /* already closed */ }
  if (res.status >= 200 && res.status < 300) return { ok: true };
  if (res.status === 404 || res.status === 410) return { gone: true };
  return { ok: false, code: `PUSH_HTTP_${res.status}` };
}
