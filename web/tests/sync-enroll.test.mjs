// Enrollment crypto in WebCrypto against the shared `enroll` vectors. Claim negatives: the browser seals with the
// mutated value and the Node desktop opens with the slot's real values. Ack negatives run in browser code directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import * as NE from '../../extension/core/sync-enroll.mjs';
import * as W from '../src/sync/enroll.ts';
import { importVerify, SyncCryptoError, hex } from '../src/sync/envelope.ts';
import { unb64u } from '../src/relay/wire.ts';

const V = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url), 'utf8'));
const X = V.enroll;
const subtle = globalThis.crypto.subtle;
const hexb = (h) => Buffer.from(h, 'hex');
const ecdhSpki = unb64u(V.keys.deviceEcdhSpki);
const signingSpki = unb64u(X.deviceSigningSpki);
const claimOf = () => ({ deviceId: X.deviceId, ecdhSpki, signingSpki, name: X.name });
const keysOf = (es = X.pair.es, pair = X.pair) => W.enrollKeys(unb64u(es), pair.sid, pair.slot);
const devSign = () => subtle.importKey('pkcs8', unb64u(V.keys.deviceSigningPkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const desktopVK = () => importVerify(unb64u(V.keys.desktopSigningSpki));
const flip = (env, f) => { const x = Buffer.from(env[f], 'base64url'); x[0] ^= 1; env[f] = x.toString('base64url'); };

test('QR payload: both URL forms parse to the vector fields; Host API fields are ignored; junk is refused', () => {
  assert.deepEqual(W.parsePair(X.iosUrl), X.pair);
  assert.deepEqual(W.parsePair(X.webUrl), X.pair);
  assert.deepEqual(W.parsePair(`${X.iosUrl}&ip=192.168.1.2&pin=123456&h1port=8443&api=1`), X.pair);
  for (const bad of [X.iosUrl.replace('sv=1', 'sv=2'), X.iosUrl.replace(/es=[^&]+/, 'es=short'), X.iosUrl.replace(/st=[^&]+/, 'st=box%3A1'), 'https://evil.example/#nope', 'https://llm-ide.com/#pair=%E0%A4%A', 42]) {
    assert.throws(() => W.parsePair(bad), (e) => e instanceof SyncCryptoError && e.code === 'bad_pair', String(bad));
  }
});

test('derived keys are non-extractable; deviceId, MAC, claim hash and SAS match the reference', async () => {
  const k = await keysOf();
  for (const key of Object.values(k)) assert.equal(key.extractable, false);
  assert.equal(await W.deviceIdOf(signingSpki), X.deviceId);
  const f = { ...X.pair, tier: X.tier, ...claimOf() };
  assert.equal(hex(await W.claimMac(k.bind, f)), X.macHex);
  assert.equal(hex(await W.claimHash(claimOf())), X.claimHashHex);
  assert.equal(await W.sasCode(k.sas, { ...f, nD: hexb(X.nDHex) }), X.sas);
  await assert.rejects(W.enrollKeys(new Uint8Array(15), X.pair.sid, X.pair.slot), (e) => e.code === 'bad_secret');
});

test('claim: WebCrypto reproduces the vector ciphertext and the Node desktop opens it', async () => {
  const env = await W.sealClaim({ pair: X.pair, tier: X.tier, name: X.name, ecdhSpki, signingSpki, signingKey: await devSign(),
    issuedAt: X.claim.env.issuedAt, keys: await keysOf(), nonce: hexb(X.claim.nonceHex) });
  assert.equal(env.ct, X.claim.env.ct);
  assert.equal(env.eph, X.claim.env.eph);
  const nodeKeys = NE.enrollKeys(Buffer.from(X.pair.es, 'base64url'), X.pair.sid, X.pair.slot);
  assert.equal(NE.openClaim({ env, pair: X.pair, tier: X.tier, keys: nodeKeys }).deviceId, X.deviceId);
});

test('ack: the browser opens the vector ack with the pinned desktop key', async () => {
  const out = await W.openAck({ env: X.ack.env, pair: X.pair, tier: X.tier, claim: claimOf(), keys: await keysOf(), desktopVerifyKey: await desktopVK() });
  assert.equal(out.userId, X.userId);
  assert.equal(hex(out.nD), X.nDHex);
});

test('every enroll negative fails closed with its vector code', async () => {
  const nodeKeys = NE.enrollKeys(Buffer.from(X.pair.es, 'base64url'), X.pair.sid, X.pair.slot);
  assert.ok(X.negatives.length >= 11);
  for (const n of X.negatives) {
    const m = n.mutate;
    const label = `${n.target} ${JSON.stringify(m)} -> ${n.error}`;
    if (n.target === 'ack') {
      const env = structuredClone(X.ack.env);
      let tier = X.tier; let claim = claimOf(); let verify = await desktopVK();
      if (m.op === 'flip') flip(env, m.field);
      else if (m.op === 'set') env[m.field] = m.value;
      else if (m.op === 'expect') { if (m.field === 'tier') tier = m.value; else if (m.field === 'name') claim = { ...claim, name: m.value }; else assert.fail(label); }
      else if (m.op === 'verifyKey') verify = await importVerify(unb64u(V.keys.deviceSigningSpki));
      await assert.rejects(W.openAck({ env, pair: X.pair, tier, claim, keys: await keysOf(), desktopVerifyKey: verify }),
        (e) => e instanceof SyncCryptoError && e.code === n.error, label);
    } else {
      let pair = X.pair; let tier = X.tier; let es = X.pair.es;
      if (m.op === 'expect') { if (m.field === 'tier') tier = m.value; else if (m.field === 'es') es = m.value; else pair = { ...pair, [m.field]: m.value }; }
      const env = await W.sealClaim({ pair, tier, name: X.name, ecdhSpki, signingSpki, signingKey: await devSign(), issuedAt: 1, keys: await keysOf(es, pair) });
      if (m.op === 'flip') flip(env, m.field);
      else if (m.op === 'set') env[m.field] = m.value;
      assert.throws(() => NE.openClaim({ env, pair: X.pair, tier: X.tier, keys: nodeKeys }), (e) => e.code === n.error, label);
    }
  }
});

test('names, tiers and key types are validated', async () => {
  const base = { pair: X.pair, ecdhSpki, signingSpki, signingKey: await devSign(), issuedAt: 1, keys: await keysOf() };
  await assert.rejects(W.sealClaim({ ...base, tier: 'android', name: 'x' }), (e) => e.code === 'bad_tier');
  for (const name of ['', 'a'.repeat(W.NAME_MAX + 1), 'bad\nname']) await assert.rejects(W.sealClaim({ ...base, tier: 'web', name }), (e) => e.code === 'bad_name');
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
  await assert.rejects(W.p256Spki(new Uint8Array(p384)), (e) => e.code === 'bad_key');
  await assert.rejects(W.p256Spki(new Uint8Array([1, 2, 3])), (e) => e.code === 'bad_key');
  assert.equal((await W.p256Spki(unb64u(V.keys.desktopSigningSpki))).extractable, false);
  assert.match(W.newId22(), W.ID22);
});

test('parsePair: an sftp: store must be a lower-case DNS host', () => {
  const q = (st) => `llmide://pair?sv=1&sid=${'A'.repeat(22)}&sfp=${'B'.repeat(43)}&dir=${'C'.repeat(22)}&slot=${'D'.repeat(22)}&es=${'E'.repeat(22)}&st=${encodeURIComponent(st)}`;
  assert.equal(W.parsePair(q('sftp:llm-ide.com')).st, 'sftp:llm-ide.com');
  for (const bad of ['sftp:evil.com:8443', 'sftp:localhost', 'sftp:1.2.3.4', 'sftp:a-.com']) assert.throws(() => W.parsePair(q(bad)), (e) => e.code === 'bad_pair', bad);
});

test('parsePair: box links carry the Box app; a bad or missing one is refused', () => {
  const q = (extra) => `llmide://pair?sv=1&sid=${'A'.repeat(22)}&sfp=${'B'.repeat(43)}&dir=${'C'.repeat(22)}&slot=${'D'.repeat(22)}&es=${'E'.repeat(22)}&st=box%3Allmide-sync${extra}`;
  const p = W.parsePair(q('&bi=cid0123456789abcdef&bs=csec0123456789abcdef'));
  assert.equal(p.st, 'box:llmide-sync'); assert.equal(p.bi, 'cid0123456789abcdef'); assert.equal(p.bs, 'csec0123456789abcdef');
  assert.throws(() => W.parsePair(q('')), (e) => e.code === 'bad_pair');
  assert.throws(() => W.parsePair(q('&bi=x&bs=y')), (e) => e.code === 'bad_pair');
});
