// Sync v1 envelope (schema/sync/v1): relay v1 bytes (schema/relay/v1) plus the purposes snapshot, manifest and
// syncwrap. A shipped port of scripts/relay-reference.mjs; checked against both vector files. Node crypto only.
// Verify before decrypt; unknown fields, purposes and versions fail closed.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';

export const VERSION = 1;
export const BUCKETS = Object.freeze([1024, 4096, 16384, 65536, 262144, 1048576]);
export const MAX_FRAME = BUCKETS.at(-1) - 4;
export const PURPOSES = Object.freeze(['request', 'reply', 'snapshot', 'manifest', 'syncwrap', 'enroll', 'enrollack']);
const ID_KEYS = ['purpose', 'userId', 'desktopId', 'from', 'to', 'epoch', 'session', 'seq', 'issuedAt', 'tier'];
const ENV_KEYS = new Set(['v', ...ID_KEYS, 'nonce', 'ct', 'sig', 'eph']);
const B64U = /^[A-Za-z0-9_-]*$/;

export class SyncCryptoError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'SyncCryptoError'; }
}
const fail = (code) => { throw new SyncCryptoError(code); };
const context = (purpose) => Buffer.from(`llmide/${purpose}/v1\0`);
const b64 = (s) => (typeof s === 'string' && B64U.test(s) ? Buffer.from(s, 'base64url') : fail('bad_base64'));
export const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

export function enc(fields) {
  return Buffer.concat(fields.flatMap((f) => {
    let v;
    if (typeof f === 'number' || typeof f === 'bigint') {
      if (typeof f === 'number' && (!Number.isSafeInteger(f) || f < 0)) fail('bad_integer');
      v = Buffer.alloc(8); v.writeBigUInt64BE(BigInt(f));
    } else if (typeof f === 'string') v = Buffer.from(f, 'utf8');
    else v = Buffer.from(f);
    const len = Buffer.alloc(4); len.writeUInt32BE(v.length);
    return [len, v];
  }));
}

export function decodeEnc(buf, count) {
  const out = []; let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) fail('bad_encoding');
    const n = buf.readUInt32BE(off); off += 4;
    if (off + n > buf.length) fail('bad_encoding');
    out.push(buf.subarray(off, off + n)); off += n;
  }
  if (out.length !== count) fail('bad_encoding');
  return out;
}

export const headerFields = (h) => [VERSION, h.purpose, h.userId, h.desktopId, h.from, h.to, h.epoch, h.session, h.seq, h.issuedAt, h.tier];
const headerOf = (env) => Object.fromEntries(ID_KEYS.map((k) => [k, env[k]]));

export function pad(bytes) {
  const body = Buffer.from(bytes);
  if (body.length > MAX_FRAME) fail('frame_too_large');
  const out = Buffer.alloc(BUCKETS.find((s) => s >= body.length + 4));
  out.writeUInt32BE(body.length); body.copy(out, 4);
  return out;
}

export function unpad(buf) {
  if (!BUCKETS.includes(buf.length)) fail('bad_padding');
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) fail('bad_padding');
  for (let i = 4 + n; i < buf.length; i++) if (buf[i] !== 0) fail('bad_padding');
  return buf.subarray(4, 4 + n);
}

const salt = (userId, desktopId) => sha256(Buffer.from('llmide-relay-v1'), enc([userId, desktopId]));

export function subkey(root, { userId, desktopId, purpose, epoch, sender, recipient }) {
  if (!PURPOSES.includes(purpose)) fail('bad_purpose');
  return Buffer.from(hkdfSync('sha256', root, salt(userId, desktopId), enc([purpose, epoch, '', sender, recipient]), 32));
}

export function deviceKeys(root, { userId, desktopId, deviceId }, epoch) {
  const k = (purpose, sender, recipient) => subkey(root, { userId, desktopId, purpose, epoch, sender, recipient });
  return { request: k('request', deviceId, desktopId), reply: k('reply', desktopId, deviceId),
    snapshot: k('snapshot', desktopId, deviceId), manifest: k('manifest', desktopId, deviceId) };
}

export function seal({ header, key, plaintext, signingKey, nonce = randomBytes(12), extra = Buffer.alloc(0) }) {
  if (!PURPOSES.includes(header.purpose)) fail('bad_purpose');
  const fields = headerFields(header);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(enc([...fields, extra]));
  const ct = Buffer.concat([c.update(pad(plaintext)), c.final(), c.getAuthTag()]);
  const sig = sign('sha256', Buffer.concat([context(header.purpose), enc([...fields, extra, nonce, ct])]), { key: signingKey, dsaEncoding: 'ieee-p1363' });
  return { v: VERSION, ...headerOf(header), nonce: nonce.toString('base64url'), ct: ct.toString('base64url'), sig: sig.toString('base64url'), ...(extra.length ? { eph: extra.toString('base64url') } : {}) };
}

export function open({ env, key, verifyKey, expect = {} }) {
  if (!env || typeof env !== 'object' || Object.keys(env).some((k) => !ENV_KEYS.has(k))) fail('bad_envelope');
  if (env.v !== VERSION) fail('bad_version');
  if (!PURPOSES.includes(env.purpose)) fail('bad_purpose');
  const header = headerOf(env);
  for (const [k, v] of Object.entries(expect)) if (header[k] !== v) fail(`bad_${k}`);
  const extra = env.eph ? b64(env.eph) : Buffer.alloc(0);
  const nonce = b64(env.nonce); const ct = b64(env.ct);
  if (nonce.length !== 12 || ct.length < 16 + BUCKETS[0]) fail('bad_ciphertext');
  const fields = headerFields(header);
  let ok = false;
  try { ok = verify('sha256', Buffer.concat([context(env.purpose), enc([...fields, extra, nonce, ct])]), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, b64(env.sig)); } catch { ok = false; }
  if (!ok) fail('bad_signature');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(enc([...fields, extra])); d.setAuthTag(ct.subarray(-16));
  let pt;
  try { pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); } catch { fail('bad_ciphertext'); }
  return unpad(pt);
}

function syncWrapKey({ z, ephSpki, deviceEcdhSpki, epoch, deviceId, desktopSigningSpki, tier }) {
  return Buffer.from(hkdfSync('sha256', z, sha256(enc([ephSpki, deviceEcdhSpki])),
    enc(['llmide/syncwrap/v1', epoch, deviceId, sha256(deviceEcdhSpki), sha256(desktopSigningSpki), tier]), 32));
}

export function makeSyncWrap({ ids, epoch, tier, deviceEcdhSpki, desktopSigningSpki, keys, signingKey, eph = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), nonce, seq, issuedAt }) {
  if (tier !== 'web' && tier !== 'ios') fail('bad_tier');
  const ephSpki = eph.publicKey.export({ type: 'spki', format: 'der' });
  const z = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: deviceEcdhSpki, format: 'der', type: 'spki' }) });
  const key = syncWrapKey({ z, ephSpki, deviceEcdhSpki, epoch, deviceId: ids.deviceId, desktopSigningSpki, tier });
  z.fill(0);
  const header = { purpose: 'syncwrap', userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq, issuedAt, tier };
  return seal({ header, key, plaintext: enc([keys.request, keys.reply, keys.snapshot, keys.manifest]), signingKey, extra: ephSpki, ...(nonce ? { nonce } : {}) });
}

/** Device side; shipped for tests and for a future Node device. Verifies the desktop signature first. */
export function unwrapSync({ env, ecdhPrivate, deviceEcdhSpki, desktopSigningSpki, verifyKey, currentEpoch, deviceId }) {
  if (env?.purpose !== 'syncwrap' || !env.eph) fail('bad_purpose');
  if (env.to !== deviceId) fail('bad_to');
  if (!(env.epoch > currentEpoch)) fail('stale_epoch');
  const ephSpki = b64(env.eph);
  const z = diffieHellman({ privateKey: ecdhPrivate, publicKey: createPublicKey({ key: ephSpki, format: 'der', type: 'spki' }) });
  const key = syncWrapKey({ z, ephSpki, deviceEcdhSpki, epoch: env.epoch, deviceId, desktopSigningSpki, tier: env.tier });
  const parts = decodeEnc(open({ env, key, verifyKey, expect: { purpose: 'syncwrap' } }), 4);
  if (parts.some((p) => p.length !== 32)) fail('bad_wrap');
  const [request, reply, snapshot, manifest] = parts.map((p) => Buffer.from(p));
  return { request, reply, snapshot, manifest };
}

export const spkiFingerprint = (spki) => sha256(spki).toString('base64url');

export function newSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey, spki: publicKey.export({ type: 'spki', format: 'der' }), pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }) };
}
