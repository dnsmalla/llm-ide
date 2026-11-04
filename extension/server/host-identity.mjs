// Host API v1 TLS identity for the desktop core (Plan 6). One self-signed P-256 certificate per install;
// clients pin fingerprintOfSpki(SPKI). The private key is stored vault-encrypted (LLMIDE_VAULT_KEY, kept
// in the OS keychain by the Rust host) and never leaves this process. Structure mirrors the Mac's
// HostApiV1Certificate.swift; both are checked against schema/host-api/v1/fixtures/security/.
import crypto, { X509Certificate } from 'node:crypto';
import { encrypt, decrypt, isVaultError } from './vault.mjs';

export const VALIDITY_MS = 5 * 365 * 24 * 3600 * 1000;
const VAULT_SCOPE = 'host-api-identity'; // HKDF salt: separates this key from every per-user vault key

const tlv = (tag, body) => {
  const n = body.length;
  let len;
  if (n < 0x80) len = Buffer.from([n]);
  else { const b = []; for (let v = n; v > 0; v >>= 8) b.unshift(v & 0xff); len = Buffer.from([0x80 | b.length, ...b]); }
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const int = (raw) => {
  let b = raw;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
// RFC 5280 4.1.2.5: UTCTime before 2050, GeneralizedTime from 2050.
const utc = (ms) => {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const p = (n) => String(n).padStart(2, '0');
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y >= 2050 ? tlv(0x18, Buffer.from(`${y}${rest}`)) : tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`));
};
const ECDSA_SHA256 = '2a8648ce3d040302';

export function buildSelfSignedCert({ privateKey, publicKey, commonName, notBefore, notAfter, serial }) {
  const name = seq(tlv(0x31, seq(oid('550403'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  const alg = seq(oid(ECDSA_SHA256));
  const ext = tlv(0xa3, seq(
    seq(oid('551d13'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())),
    seq(oid('551d0f'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80])))),
    seq(oid('551d25'), tlv(0x04, seq(oid('2b06010505070301')))),
  ));
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(serial), alg, name, seq(utc(notBefore), utc(notAfter)), name,
    publicKey.export({ type: 'spki', format: 'der' }), ext);
  return seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
}

export const fingerprintOfSpki = (spki) => `sha256:${crypto.createHash('sha256').update(spki).digest('base64url')}`;

export function resetHostIdentity(db) { db.prepare('DELETE FROM host_api_identity').run(); }

// Only a vault failure or a key/cert parse failure means the stored identity is unrecoverable; anything else is a bug.
const isUnrecoverable = (e) => isVaultError(e) || /^ERR_(OSSL|CRYPTO)/.test(String(e?.code));

export function loadOrCreateHostIdentity(db, { hostName, now = Date.now(), onEvent = () => {}, deps = {} }) {
  const { decryptKey = decrypt } = deps; // test seam
  let reset = false;
  const row = db.prepare('SELECT cert_der, key_enc, fingerprint, not_after FROM host_api_identity WHERE id = 1').get();
  if (row) {
    try {
      const keyPem = crypto.createPrivateKey({ key: Buffer.from(decryptKey(VAULT_SCOPE, row.key_enc), 'base64'), format: 'der', type: 'pkcs8' })
        .export({ type: 'pkcs8', format: 'pem' });
      return { certPem: new X509Certificate(row.cert_der).toString(), keyPem, fingerprint: row.fingerprint, notAfter: row.not_after, created: false };
    } catch (e) {
      if (!isUnrecoverable(e)) throw e;
      // The vault key changed (or the row was tampered with): the old key is unrecoverable. Every pinned
      // client will now fail its pin check, which is the intended fail-closed result; their tokens were
      // bound to the old identity, so they go too (all users: the identity is per install). The wipe
      // happens in the same transaction as the new INSERT below.
      reset = true;
    }
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;
  const notAfter = now + VALIDITY_MS;
  const der = buildSelfSignedCert({ privateKey, publicKey, commonName: `LLM-IDE ${String(hostName || 'host').slice(0, 64)}`, notBefore: now - 300_000, notAfter, serial });
  const fingerprint = fingerprintOfSpki(publicKey.export({ type: 'spki', format: 'der' }));
  const keyEnc = encrypt(VAULT_SCOPE, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
  db.transaction(() => {
    if (reset) { resetHostIdentity(db); db.prepare('DELETE FROM host_api_devices').run(); }
    db.prepare('INSERT INTO host_api_identity (id, cert_der, key_enc, fingerprint, created_at, not_after) VALUES (1, ?, ?, ?, ?, ?)')
      .run(der, keyEnc, fingerprint, now, notAfter);
  })();
  if (reset) onEvent('identity_reset');
  onEvent('identity_created');
  return { certPem: new X509Certificate(der).toString(), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint, notAfter, created: true };
}
