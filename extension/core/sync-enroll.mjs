// Sync v1 enrollment (design 5.2 as amended; schema/sync/v1/README.md "Enrollment"): the pairing QR, the device's claim,
// the desktop's signed ack and the 6-digit SAS. Node crypto only (L0). Each side computes the SAS only from values it
// holds or that were committed before the other side revealed; nothing the storage supplies enters a trust decision.
import { createHmac, createPublicKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { enc, decodeEnc, seal, open, sha256, SyncCryptoError } from './sync-envelope.mjs';

export const PAIR_VERSION = '1';
export const PAIR_FIELDS = Object.freeze(['sid', 'sfp', 'dir', 'slot', 'es', 'st']);
export const ID22 = /^[A-Za-z0-9_-]{22}$/;
export const NAME_MAX = 64;
const FP43 = /^[A-Za-z0-9_-]{43}$/;
const ST_RE = /^((mega|box):[A-Za-z0-9_.-]{1,64}|sftp:(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|memory:)$/; // box: = Box folder; sftp: = own server HTTPS host; memory: test adapter only
export const BOX_APP_RE = /^[A-Za-z0-9]{16,128}$/;
const USER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ENROLL_SALT = sha256(Buffer.from('llmide-sync-enroll-v1'));
const fail = (code) => { throw new SyncCryptoError(code); };

export const newId22 = () => randomBytes(16).toString('base64url');

export function pairQuery(p) {
  const box = p.st.startsWith('box:') ? `&bi=${encodeURIComponent(p.bi)}&bs=${encodeURIComponent(p.bs)}` : '';
  return `sv=${PAIR_VERSION}&${PAIR_FIELDS.map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&')}${box}`;
}

export function pairUrl(p, tier, webOrigin = 'https://llm-ide.com') {
  const q = pairQuery(p);
  return tier === 'ios' ? `llmide://pair?${q}` : `${webOrigin}/#pair=${encodeURIComponent(q)}`;
}

export function parsePair(url) {
  if (typeof url !== 'string') fail('bad_pair');
  let q;
  if (url.startsWith('llmide://pair?')) q = url.slice('llmide://pair?'.length);
  else {
    const i = url.indexOf('#pair=');
    if (i < 0) fail('bad_pair');
    try { q = decodeURIComponent(url.slice(i + '#pair='.length)); } catch { fail('bad_pair'); }
  }
  const s = new URLSearchParams(q);
  if (s.get('sv') !== PAIR_VERSION) fail('bad_pair');
  const p = Object.fromEntries(PAIR_FIELDS.map((k) => [k, s.get(k) ?? '']));
  if (![p.sid, p.dir, p.slot, p.es].every((v) => ID22.test(v)) || !FP43.test(p.sfp) || !ST_RE.test(p.st)) fail('bad_pair');
  if (p.st.startsWith('box:')) {
    p.bi = s.get('bi') ?? ''; p.bs = s.get('bs') ?? '';
    if (!BOX_APP_RE.test(p.bi) || !BOX_APP_RE.test(p.bs)) fail('bad_pair');
  }
  return p;
}

export function enrollKeys(es, sid, slot) {
  const ikm = Buffer.from(es);
  if (ikm.length !== 16) fail('bad_secret');
  const k = (label) => Buffer.from(hkdfSync('sha256', ikm, ENROLL_SALT, enc([label, sid, slot]), 32));
  return { enroll: k('enroll'), enrollack: k('enrollack'), bind: k('bind'), sas: k('sas') };
}

export const deviceIdOf = (signingSpki) => sha256(signingSpki).subarray(0, 16).toString('base64url');

/** A P-256 public key whose DER is canonical (re-export gives the same bytes), so ids and hashes cannot be malleated. */
export function p256Spki(bytes) {
  const der = Buffer.from(bytes);
  let key;
  try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch { fail('bad_key'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || !key.export({ type: 'spki', format: 'der' }).equals(der)) fail('bad_key');
  return key;
}

export const validName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(n);

const bound = (f) => [f.sid, f.slot, f.dir, Buffer.from(f.sfp, 'base64url'), f.tier, f.deviceId, f.ecdhSpki, f.signingSpki, f.name];
export const claimMac = (bindKey, f) => createHmac('sha256', bindKey).update(enc(bound(f))).digest();
export const claimHash = ({ deviceId, ecdhSpki, signingSpki, name }) => sha256(enc(['llmide/sync-claim/v1', deviceId, ecdhSpki, signingSpki, name]));

export function sasCode(sasKey, f) {
  const h = createHmac('sha256', sasKey).update(enc([...bound(f), f.nD])).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

const checkTier = (tier) => { if (tier !== 'web' && tier !== 'ios') fail('bad_tier'); };

/** Device: the claim it writes to e/<slot>/<Id22>.bin. extra = its signing SPKI, so the signature verifies before decrypt. */
export function sealClaim({ pair, tier, name, ecdhSpki, signingSpki, signingKey, issuedAt, nonce }) {
  checkTier(tier);
  if (!validName(name)) fail('bad_name');
  const keys = enrollKeys(Buffer.from(pair.es, 'base64url'), pair.sid, pair.slot);
  const deviceId = deviceIdOf(signingSpki);
  const mac = claimMac(keys.bind, { ...pair, tier, deviceId, ecdhSpki, signingSpki, name });
  const header = { purpose: 'enroll', userId: '', desktopId: pair.sid, from: deviceId, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, issuedAt, tier: '' };
  return seal({ header, key: keys.enroll, plaintext: enc([ecdhSpki, signingSpki, name, mac]), signingKey, extra: Buffer.from(signingSpki), ...(nonce ? { nonce } : {}) });
}

/** Desktop: open a claim with the slot's own values (pair, tier) and keys. Every check fails closed. */
export function openClaim({ env, pair, tier, keys }) {
  checkTier(tier);
  if (!env || typeof env !== 'object' || typeof env.eph !== 'string') fail('bad_envelope');
  const spki = Buffer.from(env.eph, 'base64url');
  const verifyKey = p256Spki(spki);
  const pt = open({ env, key: keys.enroll, verifyKey, expect: { purpose: 'enroll', userId: '', desktopId: pair.sid, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, tier: '' } });
  const [ecdhSpki, signingSpki, nameBytes, mac] = decodeEnc(pt, 4).map((p) => Buffer.from(p));
  if (!signingSpki.equals(spki)) fail('bad_key');
  p256Spki(ecdhSpki);
  const name = nameBytes.toString('utf8');
  if (!validName(name) || !Buffer.from(name, 'utf8').equals(nameBytes)) fail('bad_name');
  const deviceId = deviceIdOf(signingSpki);
  if (env.from !== deviceId) fail('bad_from');
  const want = claimMac(keys.bind, { ...pair, tier, deviceId, ecdhSpki, signingSpki, name });
  if (mac.length !== 32 || !timingSafeEqual(mac, want)) fail('bad_mac');
  return { deviceId, ecdhSpki, signingSpki, name };
}

/** Desktop: the one ack per slot, bound to the pinned claim and a fresh nD chosen after the claim was pinned. */
export function sealAck({ userId, pair, tier, claim, nD, keys, signingKey, seq, issuedAt, nonce }) {
  checkTier(tier);
  const header = { purpose: 'enrollack', userId, desktopId: pair.sid, from: pair.sid, to: claim.deviceId, epoch: 0, session: pair.slot, seq, issuedAt, tier };
  return seal({ header, key: keys.enrollack, plaintext: enc([nD, claimHash(claim)]), signingKey, ...(nonce ? { nonce } : {}) });
}

/** Device: verify the ack with the desktop key pinned by sfp; refuse an ack for anyone else's claim. */
export function openAck({ env, pair, tier, claim, keys, desktopVerifyKey }) {
  checkTier(tier);
  const pt = open({ env, key: keys.enrollack, verifyKey: desktopVerifyKey, expect: { purpose: 'enrollack', desktopId: pair.sid, from: pair.sid, to: claim.deviceId, epoch: 0, session: pair.slot, tier } });
  const [nD, hash] = decodeEnc(pt, 2).map((p) => Buffer.from(p));
  if (nD.length !== 16 || hash.length !== 32) fail('bad_ack');
  if (!timingSafeEqual(hash, claimHash(claim))) fail('ack_mismatch');
  if (typeof env.userId !== 'string' || !USER_RE.test(env.userId)) fail('bad_userId');
  return { userId: env.userId, nD };
}
