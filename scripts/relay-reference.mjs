// Independent node:crypto reference for schema/relay/v1 (both desktop and device sides). Used to generate and check
// the shared vectors and as the fake desktop/device in web tests. Never shipped in a client.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';

export const VERSION = 1;
export const BUCKETS = [1024, 4096, 16384, 65536, 262144, 1048576];
export const MAX_FRAME = BUCKETS.at(-1) - 4;
export const PURPOSES = ['open', 'opened', 'request', 'reply', 'wrap', 'keyconfirm'];
const ID_KEYS = ['purpose', 'userId', 'desktopId', 'from', 'to', 'epoch', 'session', 'seq', 'issuedAt', 'tier'];
const context = (purpose) => Buffer.from(`llmide/${purpose}/v1\0`);
const b = (s) => Buffer.from(s, 'base64url');
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

export function enc(fields) {
  return Buffer.concat(fields.flatMap((f) => {
    let v;
    if (typeof f === 'number' || typeof f === 'bigint') {
      if (typeof f === 'number' && !Number.isSafeInteger(f)) throw new Error('bad_integer');
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
    if (off + 4 > buf.length) throw new Error('bad_encoding');
    const n = buf.readUInt32BE(off); off += 4;
    if (off + n > buf.length) throw new Error('bad_encoding');
    out.push(buf.subarray(off, off + n)); off += n;
  }
  if (out.length !== count) throw new Error('bad_encoding');
  return out;
}

export const headerFields = (h) => [VERSION, h.purpose, h.userId, h.desktopId, h.from, h.to, h.epoch, h.session, h.seq, h.issuedAt, h.tier];
const headerOf = (env) => Object.fromEntries(ID_KEYS.map((k) => [k, env[k]]));

export function pad(bytes) {
  const body = Buffer.from(bytes);
  if (body.length > MAX_FRAME) throw new Error('frame_too_large');
  const out = Buffer.alloc(BUCKETS.find((s) => s >= body.length + 4));
  out.writeUInt32BE(body.length); body.copy(out, 4);
  return out;
}

export function unpad(buf) {
  if (!BUCKETS.includes(buf.length)) throw new Error('bad_padding');
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) throw new Error('bad_padding');
  for (let i = 4 + n; i < buf.length; i++) if (buf[i] !== 0) throw new Error('bad_padding');
  return buf.subarray(4, 4 + n);
}

export const relaySalt = (userId, desktopId) => sha256(Buffer.from('llmide-relay-v1'), enc([userId, desktopId]));

export function subkey(root, { userId, desktopId, purpose, epoch, sender, recipient }) {
  return Buffer.from(hkdfSync('sha256', root, relaySalt(userId, desktopId), enc([purpose, epoch, '', sender, recipient]), 32));
}

export function deviceKeys(root, { userId, desktopId, deviceId }, epoch) {
  return {
    request: subkey(root, { userId, desktopId, purpose: 'request', epoch, sender: deviceId, recipient: desktopId }),
    reply: subkey(root, { userId, desktopId, purpose: 'reply', epoch, sender: desktopId, recipient: deviceId }),
  };
}

export function seal({ header, key, plaintext, signingKey, nonce = randomBytes(12), extra = Buffer.alloc(0) }) {
  const fields = headerFields(header);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(enc([...fields, extra]));
  const ct = Buffer.concat([c.update(pad(plaintext)), c.final(), c.getAuthTag()]);
  const sig = sign('sha256', Buffer.concat([context(header.purpose), enc([...fields, extra, nonce, ct])]), { key: signingKey, dsaEncoding: 'ieee-p1363' });
  return { v: VERSION, ...headerOf(header), nonce: nonce.toString('base64url'), ct: ct.toString('base64url'), sig: sig.toString('base64url'), ...(extra.length ? { eph: extra.toString('base64url') } : {}) };
}

export function open({ env, key, verifyKey, expect = {} }) {
  if (env.v !== VERSION) throw new Error('bad_version');
  if (!PURPOSES.includes(env.purpose)) throw new Error('bad_purpose');
  const header = headerOf(env);
  for (const [k, v] of Object.entries(expect)) if (header[k] !== v) throw new Error(`bad_${k}`);
  const extra = env.eph ? b(env.eph) : Buffer.alloc(0);
  const nonce = b(env.nonce); const ct = b(env.ct);
  if (nonce.length !== 12 || ct.length < 16 + BUCKETS[0]) throw new Error('bad_ciphertext');
  const fields = headerFields(header);
  if (!verify('sha256', Buffer.concat([context(env.purpose), enc([...fields, extra, nonce, ct])]), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, b(env.sig))) throw new Error('bad_signature');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(enc([...fields, extra])); d.setAuthTag(ct.subarray(-16));
  let pt;
  try { pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); } catch { throw new Error('bad_ciphertext'); }
  return unpad(pt);
}

function wrapKey({ z, ephSpki, deviceEcdhSpki, epoch, deviceId, desktopSigningSpki, tier }) {
  return Buffer.from(hkdfSync('sha256', z, sha256(enc([ephSpki, deviceEcdhSpki])),
    enc(['llmide/wrap/v1', epoch, deviceId, sha256(deviceEcdhSpki), sha256(desktopSigningSpki), tier]), 32));
}

export function makeWrap({ ids, epoch, tier, deviceEcdhSpki, desktopSigningSpki, keys, hostApiToken, signingKey, eph = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), nonce, seq = 1, issuedAt = Date.now() }) {
  const ephSpki = eph.publicKey.export({ type: 'spki', format: 'der' });
  const z = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: deviceEcdhSpki, format: 'der', type: 'spki' }) });
  const key = wrapKey({ z, ephSpki, deviceEcdhSpki, epoch, deviceId: ids.deviceId, desktopSigningSpki, tier });
  const header = { purpose: 'wrap', userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq, issuedAt, tier };
  return seal({ header, key, plaintext: enc([keys.request, keys.reply, hostApiToken]), signingKey, extra: ephSpki, ...(nonce ? { nonce } : {}) });
}

export function unwrap({ env, ecdhPrivate, deviceEcdhSpki, desktopSigningSpki, verifyKey, currentEpoch, deviceId }) {
  if (env.purpose !== 'wrap' || !env.eph) throw new Error('bad_purpose');
  if (env.to !== deviceId) throw new Error('bad_to');
  if (!(env.epoch > currentEpoch)) throw new Error('stale_epoch');
  const ephSpki = b(env.eph);
  const z = diffieHellman({ privateKey: ecdhPrivate, publicKey: createPublicKey({ key: ephSpki, format: 'der', type: 'spki' }) });
  const key = wrapKey({ z, ephSpki, deviceEcdhSpki, epoch: env.epoch, deviceId, desktopSigningSpki, tier: env.tier });
  const [request, reply, token] = decodeEnc(open({ env, key, verifyKey, expect: { purpose: 'wrap' } }), 3);
  if (request.length !== 32 || reply.length !== 32) throw new Error('bad_wrap');
  return { request: Buffer.from(request), reply: Buffer.from(reply), hostApiToken: token.toString('utf8') };
}

export const keyConfirmPlaintext = (wrapSig) => sha256(Buffer.from('llmide/keyconfirm/v1'), Buffer.from(wrapSig));
export const authMessage = (challenge, role, tokenHash) => Buffer.from(`llmide/relay/auth/v1\n${challenge}\n${role}\n${tokenHash}`);
