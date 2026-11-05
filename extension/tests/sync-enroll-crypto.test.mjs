// Enrollment crypto (schema/sync/v1/README.md "Enrollment"): the core module reproduces the reference vectors byte for
// byte, and every negative fails closed with the stated code. SP3 (WebCrypto) and SP4 (Swift) run the same vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as S from '../core/sync-envelope.mjs';
import * as E from '../core/sync-enroll.mjs';

const V = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url)));
const X = V.enroll;
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });
const claimOf = () => ({ deviceId: X.deviceId, ecdhSpki: b(V.keys.deviceEcdhSpki), signingSpki: b(X.deviceSigningSpki), name: X.name });
const keysOf = (es = X.pair.es) => E.enrollKeys(b(es), X.pair.sid, X.pair.slot);

test('QR payload: both URL forms parse back to the same fields; junk is refused', () => {
  assert.equal(E.pairUrl(X.pair, 'ios'), X.iosUrl);
  assert.equal(E.pairUrl(X.pair, 'web'), X.webUrl);
  assert.deepEqual(E.parsePair(X.iosUrl), X.pair);
  assert.deepEqual(E.parsePair(X.webUrl), X.pair);
  assert.deepEqual(E.parsePair(`${X.iosUrl}&ip=192.168.1.2&pin=123456&h1port=8443&api=1`), X.pair, 'Host API fields are ignored');
  for (const bad of [X.iosUrl.replace('sv=1', 'sv=2'), X.iosUrl.replace(/es=[^&]+/, 'es=short'), X.iosUrl.replace(/st=[^&]+/, 'st=box%3A1'), 'https://evil.example/#nope', 42]) {
    assert.throws(() => E.parsePair(bad), (e) => e.code === 'bad_pair', String(bad));
  }
});

test('derived keys, deviceId, MAC, claim hash and SAS match the reference', () => {
  const k = keysOf();
  assert.equal(k.enroll.toString('hex'), X.enrollKeyHex);
  assert.equal(k.enrollack.toString('hex'), X.enrollackKeyHex);
  assert.equal(k.bind.toString('hex'), X.bindKeyHex);
  assert.equal(k.sas.toString('hex'), X.sasKeyHex);
  assert.equal(E.deviceIdOf(b(X.deviceSigningSpki)), X.deviceId);
  const f = { ...X.pair, tier: X.tier, ...claimOf() };
  assert.equal(E.claimMac(k.bind, f).toString('hex'), X.macHex);
  assert.equal(E.claimHash(claimOf()).toString('hex'), X.claimHashHex);
  assert.equal(E.sasCode(k.sas, { ...f, nD: Buffer.from(X.nDHex, 'hex') }), X.sas);
  assert.match(X.sas, /^[0-9]{6}$/);
});

test('claim: the desktop opens the vector claim; a re-seal with the same nonce gives the same ciphertext', () => {
  const k = keysOf();
  assert.deepEqual(E.openClaim({ env: X.claim.env, pair: X.pair, tier: X.tier, keys: k }), claimOf());
  const again = E.sealClaim({ pair: X.pair, tier: X.tier, name: X.name, ecdhSpki: b(V.keys.deviceEcdhSpki), signingSpki: b(X.deviceSigningSpki),
    signingKey: priv(V.keys.deviceSigningPkcs8), issuedAt: X.claim.env.issuedAt, nonce: Buffer.from(X.claim.nonceHex, 'hex') });
  assert.equal(again.ct, X.claim.env.ct);
});

test('ack: the device opens the vector ack with the pinned desktop key', () => {
  const out = E.openAck({ env: X.ack.env, pair: X.pair, tier: X.tier, claim: claimOf(), keys: keysOf(), desktopVerifyKey: pub(V.keys.desktopSigningSpki) });
  assert.equal(out.userId, X.userId);
  assert.equal(out.nD.toString('hex'), X.nDHex);
});

test('every enroll negative fails closed with its code', () => {
  for (const n of X.negatives) {
    const env = structuredClone(n.target === 'claim' ? X.claim.env : X.ack.env);
    let pair = X.pair; let tier = X.tier; let claim = claimOf(); let es = X.pair.es; let verify = pub(V.keys.desktopSigningSpki);
    const m = n.mutate;
    if (m.op === 'flip') { const x = b(env[m.field]); x[0] ^= 1; env[m.field] = x.toString('base64url'); }
    else if (m.op === 'set') env[m.field] = m.value;
    else if (m.op === 'expect') { if (m.field === 'tier') tier = m.value; else if (m.field === 'es') es = m.value; else if (m.field === 'name') claim = { ...claim, name: m.value }; else pair = { ...pair, [m.field]: m.value }; }
    else if (m.op === 'verifyKey') verify = pub(V.keys.deviceSigningSpki);
    const keys = E.enrollKeys(b(es), pair.sid, pair.slot);
    const run = () => (n.target === 'claim'
      ? E.openClaim({ env, pair, tier, keys })
      : E.openAck({ env, pair, tier, claim, keys, desktopVerifyKey: verify }));
    assert.throws(run, (e) => e instanceof S.SyncCryptoError && e.code === n.error, `${n.target} ${JSON.stringify(m)} -> ${n.error}`);
  }
});

test('openClaim refuses a claim whose signing key is not P-256', () => {
  const k = keysOf();
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
  assert.throws(() => E.p256Spki(p384), (e) => e.code === 'bad_key');
  const env = { ...X.claim.env, eph: p384.toString('base64url') };
  assert.throws(() => E.openClaim({ env, pair: X.pair, tier: X.tier, keys: k }), (e) => e.code === 'bad_key');
});
