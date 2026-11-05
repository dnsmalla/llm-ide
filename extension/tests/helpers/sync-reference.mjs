// Independent device-side reference for sync v1 (schema/sync/v1/README.md; design 4.3-4.5, 5.2). Built on
// scripts/relay-reference.mjs and node:crypto only, never on extension/core/sync-*.mjs, so a mistake in the
// implementation cannot also hide in the device the end-to-end and malicious-storage suites drive (review 2026-11-06 I2).
import { createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, hkdfSync, timingSafeEqual, verify } from 'node:crypto';
import * as R from '../../../scripts/relay-reference.mjs';

export const PURPOSES = ['request', 'reply', 'snapshot', 'manifest', 'syncwrap', 'enroll', 'enrollack'];
const ENV_KEYS = ['v', 'purpose', 'userId', 'desktopId', 'from', 'to', 'epoch', 'session', 'seq', 'issuedAt', 'tier', 'nonce', 'ct', 'sig', 'eph'];
const ID22 = /^[A-Za-z0-9_-]{22}$/;
const b = (s) => Buffer.from(s, 'base64url');

export class RefError extends Error { constructor(code) { super(code); this.code = code; } }
export const fail = (code) => { throw new RefError(code); };
const coded = (fn) => { try { return fn(); } catch (e) { throw e instanceof RefError ? e : new RefError(e.message); } };

export const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
export const enc = R.enc;
export const decodeEnc = (buf, n) => coded(() => R.decodeEnc(Buffer.from(buf), n));
export const fingerprint = (spki) => sha256(spki).toString('base64url');
export const deviceIdOf = (signingSpki) => sha256(signingSpki).subarray(0, 16).toString('base64url');
export const seal = (args) => R.seal(args); // R.seal is purpose-agnostic
export function verifyKeyOf(spki) {
  return coded(() => {
    const k = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
    if (k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail('bad_key');
    return k;
  });
}

export function open({ env, key, verifyKey, expect = {} }) {
  if (!env || typeof env !== 'object' || Object.keys(env).some((k) => !ENV_KEYS.includes(k))) fail('bad_envelope');
  if (env.v !== R.VERSION) fail('bad_version');
  if (!PURPOSES.includes(env.purpose)) fail('bad_purpose');
  for (const [k, v] of Object.entries(expect)) if (env[k] !== v) fail(`bad_${k}`);
  const fields = R.headerFields(env);
  const extra = env.eph ? b(env.eph) : Buffer.alloc(0);
  const nonce = b(env.nonce); const ct = b(env.ct);
  if (nonce.length !== 12 || ct.length < 16 + R.BUCKETS[0]) fail('bad_ciphertext');
  let ok = false;
  try { ok = verify('sha256', Buffer.concat([Buffer.from(`llmide/${env.purpose}/v1\0`), enc([...fields, extra, nonce, ct])]), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, b(env.sig)); } catch { ok = false; }
  if (!ok) fail('bad_signature');
  return coded(() => {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(enc([...fields, extra])); d.setAuthTag(ct.subarray(-16));
    let pt;
    try { pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); } catch { fail('bad_ciphertext'); }
    return R.unpad(pt);
  });
}

// Enrollment (README "Enrollment"): QR, keys, claim, ack, SAS.
export function parsePair(url) {
  let q;
  if (typeof url !== 'string') fail('bad_pair');
  if (url.startsWith('llmide://pair?')) q = url.slice(14);
  else if (url.includes('#pair=')) q = decodeURIComponent(url.slice(url.indexOf('#pair=') + 6));
  else fail('bad_pair');
  const s = new URLSearchParams(q);
  const p = Object.fromEntries(['sid', 'sfp', 'dir', 'slot', 'es', 'st'].map((k) => [k, s.get(k) ?? '']));
  if (s.get('sv') !== '1' || ![p.sid, p.dir, p.slot, p.es].every((v) => ID22.test(v)) || !/^[A-Za-z0-9_-]{43}$/.test(p.sfp) || !p.st) fail('bad_pair');
  return p;
}

const ENROLL_SALT = sha256(Buffer.from('llmide-sync-enroll-v1'));
export function enrollKeys(pair) {
  const es = b(pair.es);
  const k = (label) => Buffer.from(hkdfSync('sha256', es, ENROLL_SALT, enc([label, pair.sid, pair.slot]), 32));
  return { enroll: k('enroll'), enrollack: k('enrollack'), bind: k('bind'), sas: k('sas') };
}
const bound = (pair, tier, c) => [pair.sid, pair.slot, pair.dir, b(pair.sfp), tier, c.deviceId, c.ecdhSpki, c.signingSpki, c.name];
export const claimHash = (c) => sha256(enc(['llmide/sync-claim/v1', c.deviceId, c.ecdhSpki, c.signingSpki, c.name]));
export function sas(keys, pair, tier, c, nD) {
  const h = createHmac('sha256', keys.sas).update(enc([...bound(pair, tier, c), nD])).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function sealClaim({ pair, tier, claim, keys, signingKey, issuedAt }) {
  const mac = createHmac('sha256', keys.bind).update(enc(bound(pair, tier, claim))).digest();
  const header = { purpose: 'enroll', userId: '', desktopId: pair.sid, from: claim.deviceId, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, issuedAt, tier: '' };
  return seal({ header, key: keys.enroll, plaintext: enc([claim.ecdhSpki, claim.signingSpki, claim.name, mac]), signingKey, extra: Buffer.from(claim.signingSpki) });
}

export function openAck({ env, pair, tier, claim, keys, verifyKey }) {
  const pt = open({ env, key: keys.enrollack, verifyKey, expect: { purpose: 'enrollack', desktopId: pair.sid, from: pair.sid, to: claim.deviceId, epoch: 0, session: pair.slot, tier } });
  const [nD, hash] = decodeEnc(pt, 2);
  if (nD.length !== 16 || hash.length !== 32) fail('bad_ack');
  if (!timingSafeEqual(hash, claimHash(claim))) fail('ack_mismatch');
  if (typeof env.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(env.userId)) fail('bad_userId');
  return { userId: env.userId, nD: Buffer.from(nD) };
}

// Key wrap (design 4.3): ECDH with the desktop's ephemeral key, then the four per-device keys.
export function unwrapSync({ env, ecdhPrivate, deviceEcdhSpki, desktopSpki, verifyKey, currentEpoch, deviceId }) {
  if (env?.purpose !== 'syncwrap' || !env.eph) fail('bad_purpose');
  if (env.to !== deviceId) fail('bad_to');
  if (!(env.epoch > currentEpoch)) fail('stale_epoch');
  const ephSpki = b(env.eph);
  const z = coded(() => diffieHellman({ privateKey: ecdhPrivate, publicKey: createPublicKey({ key: ephSpki, format: 'der', type: 'spki' }) }));
  const key = Buffer.from(hkdfSync('sha256', z, sha256(enc([ephSpki, deviceEcdhSpki])),
    enc(['llmide/syncwrap/v1', env.epoch, deviceId, sha256(deviceEcdhSpki), sha256(desktopSpki), env.tier]), 32));
  const parts = decodeEnc(open({ env, key, verifyKey, expect: { purpose: 'syncwrap' } }), 4);
  if (parts.some((p) => p.length !== 32)) fail('bad_wrap');
  const [request, reply, snapshot, manifest] = parts.map((p) => Buffer.from(p));
  return { request, reply, snapshot, manifest };
}
