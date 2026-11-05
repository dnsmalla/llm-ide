import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, verify as nodeVerify, createPublicKey } from 'node:crypto';
import * as R from '../../scripts/relay-reference.mjs';
import { enc, b64u, unb64u, pad } from '../src/relay/wire.ts';
import { open, seal, unwrap, importAesKey, importVerifyKey, keyConfirmPlaintext, authProof } from '../src/relay/crypto.ts';

const V = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url), 'utf8'));
const subtle = globalThis.crypto.subtle;
const hex = (u) => Buffer.from(u).toString('hex');
const importPriv = (pk8, alg, usages) => subtle.importKey('pkcs8', unb64u(pk8), alg, false, usages);

test('canonical encoding and padding match the vectors', () => {
  assert.equal(hex(enc(V.canonical.fields)), V.canonical.hex);
  assert.equal(pad(new TextEncoder().encode(V.envelope.frame)).length, V.padding.bucket);
});

test('opens the vector envelope; WebCrypto seal reproduces its ciphertext', async () => {
  const key = await importAesKey(Buffer.from(V.envelope.keyHex, 'hex'), 'decrypt');
  const vk = await importVerifyKey(unb64u(V.keys.deviceSigningSpki));
  assert.equal(new TextDecoder().decode(await open(V.envelope.env, key, vk, {})), V.envelope.frame);
  const ek = await importAesKey(Buffer.from(V.envelope.keyHex, 'hex'), 'encrypt');
  const sk = await importPriv(V.keys.deviceSigningPkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, ['sign']);
  const sealed = await seal(V.envelope.header, ek, new TextEncoder().encode(V.envelope.frame), sk, Buffer.from(V.envelope.nonceHex, 'hex'));
  assert.equal(sealed.ct, V.envelope.env.ct);
  R.open({ env: sealed, key: Buffer.from(V.envelope.keyHex, 'hex'), verifyKey: createPublicKey({ key: unb64u(V.keys.deviceSigningSpki), format: 'der', type: 'spki' }) });
});

test('every vector negative fails closed', async () => {
  const key = await importAesKey(Buffer.from(V.envelope.keyHex, 'hex'), 'decrypt');
  const vk = await importVerifyKey(unb64u(V.keys.deviceSigningSpki));
  for (const n of V.negatives) {
    const env = { ...V.envelope.env };
    const [op, rest] = n.split(':');
    if (op === 'flip') { const b = unb64u(env[rest]); b[0] ^= 1; env[rest] = b64u(b); }
    if (op === 'truncate') env[rest] = b64u(unb64u(env[rest]).subarray(0, -1));
    if (op === 'set') { const [k, v] = rest.split('='); env[k] = /^\d+$/.test(v) ? Number(v) : v; }
    await assert.rejects(open(env, key, vk, {}), `${n} must fail`);
  }
});

test('unwraps the vector wrap; refuses a rogue signer and a stale epoch', async () => {
  const ecdh = await importPriv(V.keys.deviceEcdhPkcs8, { name: 'ECDH', namedCurve: 'P-256' }, ['deriveBits']);
  const desktopVerify = await importVerifyKey(unb64u(V.keys.desktopSigningSpki));
  const opts = { deviceId: V.subkeys.ids.deviceId, ecdhPrivate: ecdh, ecdhSpki: unb64u(V.keys.deviceEcdhSpki), desktopVerify, desktopSigningSpki: unb64u(V.keys.desktopSigningSpki), currentEpoch: V.wrap.currentEpoch };
  const out = await unwrap(V.wrap.env, opts);
  assert.equal(out.hostApiToken, V.wrap.hostApiToken);
  assert.equal(hex(await keyConfirmPlaintext(out.sig)), V.keyconfirm.plaintextHex);
  await assert.rejects(unwrap(V.wrap.env, { ...opts, currentEpoch: V.wrap.env.epoch }), /stale_epoch/);
  const rogue = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forged = R.makeWrap({ ids: V.subkeys.ids, epoch: 9, tier: 'web', deviceEcdhSpki: unb64u(V.keys.deviceEcdhSpki), desktopSigningSpki: unb64u(V.keys.desktopSigningSpki), keys: { request: randomBytes(32), reply: randomBytes(32) }, hostApiToken: 'x', signingKey: rogue.privateKey });
  await assert.rejects(unwrap(forged, opts), /bad_signature/);
});

test('auth proof verifies under node:crypto', async () => {
  const sk = await importPriv(V.keys.deviceSigningPkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, ['sign']);
  const [, challenge, role, th] = V.auth.messageUtf8.split('\n');
  const proof = await authProof(sk, challenge, role, th);
  assert.ok(nodeVerify('sha256', Buffer.from(V.auth.messageUtf8), { key: createPublicKey({ key: unb64u(V.keys.deviceSigningSpki), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, unb64u(proof)));
});
