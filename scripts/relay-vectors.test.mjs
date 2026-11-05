import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as R from './relay-reference.mjs';

const ids = { userId: 'u1', desktopId: 'dk1', deviceId: 'dv1' };
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const header = (over = {}) => ({ purpose: 'request', userId: 'u1', desktopId: 'dk1', from: 'dv1', to: 'dk1', epoch: 1, session: 'AAAAAAAAAAAAAAAAAAAAAA', seq: 1, issuedAt: 1_762_300_000_000, tier: '', ...over });

test('committed vectors still check', () => {
  execFileSync(process.execPath, [new URL('./relay-vectors.mjs', import.meta.url).pathname], { stdio: 'pipe' });
});

test('seal/open round trip and padding bucket', () => {
  const dev = pair();
  const { request } = R.deviceKeys(randomBytes(32), ids, 1);
  const env = R.seal({ header: header(), key: request, plaintext: Buffer.from('{"x":1}'), signingKey: dev.privateKey });
  assert.equal(Buffer.from(env.ct, 'base64url').length, 1024 + 16);
  assert.equal(R.open({ env, key: request, verifyKey: dev.publicKey, expect: { to: 'dk1' } }).toString(), '{"x":1}');
});

test('every tampering fails closed', () => {
  const dev = pair();
  const { request } = R.deviceKeys(randomBytes(32), ids, 1);
  const env = R.seal({ header: header(), key: request, plaintext: Buffer.from('hi'), signingKey: dev.privateKey });
  const flip = (s) => { const b = Buffer.from(s, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
  const cases = [
    { ...env, ct: flip(env.ct) }, { ...env, nonce: flip(env.nonce) }, { ...env, sig: flip(env.sig) },
    { ...env, ct: Buffer.from(env.ct, 'base64url').subarray(0, -1).toString('base64url') },
    { ...env, to: 'dk2' }, { ...env, purpose: 'reply' }, { ...env, v: 2 }, { ...env, epoch: 2 },
    { ...env, seq: 2 }, { ...env, userId: 'u2' }, { ...env, session: 'BBBBBBBBBBBBBBBBBBBBBB' }, { ...env, issuedAt: 1 },
  ];
  for (const bad of cases) assert.throws(() => R.open({ env: bad, key: request, verifyKey: dev.publicKey, expect: {} }));
  assert.throws(() => R.open({ env, key: request, verifyKey: pair().publicKey, expect: {} }), /bad_signature/);
});

test('two senders and two recipients never share a key', () => {
  const root = randomBytes(32);
  const a = R.deviceKeys(root, ids, 1);
  const b = R.deviceKeys(root, { ...ids, deviceId: 'dv2' }, 1);
  const keys = [a.request, a.reply, b.request, b.reply, R.deviceKeys(root, ids, 2).request].map((k) => k.toString('hex'));
  assert.equal(new Set(keys).size, keys.length);
});

test('wrap: verifies, unwraps, and refuses rogue signer and stale epoch', () => {
  const desk = pair(); const devEcdh = pair(); const rogue = pair();
  const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' });
  const keys = R.deviceKeys(randomBytes(32), ids, 3);
  const args = { ids, epoch: 3, tier: 'web', deviceEcdhSpki: spki(devEcdh), desktopSigningSpki: spki(desk), keys, hostApiToken: 'tok-0123456789' };
  const env = R.makeWrap({ ...args, signingKey: desk.privateKey });
  const out = R.unwrap({ env, ecdhPrivate: devEcdh.privateKey, deviceEcdhSpki: spki(devEcdh), desktopSigningSpki: spki(desk), verifyKey: desk.publicKey, currentEpoch: 2, deviceId: 'dv1' });
  assert.deepEqual([out.request, out.reply, out.hostApiToken], [keys.request, keys.reply, 'tok-0123456789']);
  const forged = R.makeWrap({ ...args, signingKey: rogue.privateKey });
  assert.throws(() => R.unwrap({ env: forged, ecdhPrivate: devEcdh.privateKey, deviceEcdhSpki: spki(devEcdh), desktopSigningSpki: spki(desk), verifyKey: desk.publicKey, currentEpoch: 2, deviceId: 'dv1' }), /bad_signature/);
  assert.throws(() => R.unwrap({ env, ecdhPrivate: devEcdh.privateKey, deviceEcdhSpki: spki(devEcdh), desktopSigningSpki: spki(desk), verifyKey: desk.publicKey, currentEpoch: 3, deviceId: 'dv1' }), /stale_epoch/);
});

test('pad refuses oversize and bad padding', () => {
  assert.throws(() => R.pad(Buffer.alloc(R.MAX_FRAME + 1)), /frame_too_large/);
  const p = R.pad(Buffer.from('x')); p[100] = 1;
  assert.throws(() => R.unpad(p), /bad_padding/);
});
