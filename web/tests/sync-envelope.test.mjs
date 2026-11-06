// Sync v1 envelope in WebCrypto against shared vectors and the shipped Node port: same plaintexts, same ciphertext for
// a fixed nonce, non-extractable keys, and the same error code for every negative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import * as N from '../../extension/core/sync-envelope.mjs';
import { open, seal, unwrapSync, importAes, importVerify, SyncCryptoError } from '../src/sync/envelope.ts';
import { unb64u, MAX_FRAME } from '../src/sync/wire.ts';

const V = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url), 'utf8'));
const RV = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url), 'utf8'));
const subtle = globalThis.crypto.subtle;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const hexb = (h) => Buffer.from(h, 'hex');
const td = (u) => new TextDecoder().decode(u);
const te = (s) => new TextEncoder().encode(s);
const nodePub = (s) => createPublicKey({ key: unb64u(s), format: 'der', type: 'spki' });
const nodePriv = (s) => createPrivateKey({ key: unb64u(s), format: 'der', type: 'pkcs8' });
const webPriv = (s, alg, use) => subtle.importKey('pkcs8', unb64u(s), alg, false, use);
const headerOf = ({ v, nonce, ct, sig, eph, ...h }) => h;
function mutate(src, n) {
  const env = structuredClone(src);
  const [op, rest] = n.includes(':') ? n.split(/:(.*)/s) : ['set', n];
  if (op === 'flip') { const x = Buffer.from(env[rest], 'base64url'); x[0] ^= 1; env[rest] = x.toString('base64url'); }
  else if (op === 'truncate') env[rest] = Buffer.from(env[rest], 'base64url').subarray(0, -1).toString('base64url');
  else { const [k, val] = rest.split('='); env[k] = /^[0-9]+$/.test(val) ? Number(val) : val; }
  return env;
}
const nodeCode = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
async function webCode(p) {
  try { await p; return null; } catch (e) { assert.ok(e instanceof SyncCryptoError, `not a SyncCryptoError: ${e}`); return e.code; }
}

test('opens the vector snapshot and manifest; one key per purpose; the expected purpose is enforced', async () => {
  const vk = await importVerify(unb64u(V.keys.desktopSigningSpki));
  const snapKey = await importAes(hexb(V.snapshotKeyHex), 'decrypt');
  assert.equal(td(await open({ env: V.snapshot.env, key: snapKey, verifyKey: vk, expect: { purpose: 'snapshot' } })), V.snapshot.plaintext);
  assert.equal(td(await open({ env: V.manifest.env, key: await importAes(hexb(V.manifestKeyHex), 'decrypt'), verifyKey: vk, expect: { purpose: 'manifest' } })), V.manifest.plaintext);
  assert.equal(await webCode(open({ env: V.snapshot.env, key: await importAes(hexb(V.manifestKeyHex), 'decrypt'), verifyKey: vk })), 'bad_ciphertext');
  assert.equal(await webCode(open({ env: V.snapshot.env, key: snapKey, verifyKey: vk, expect: { purpose: 'manifest' } })), 'bad_purpose');
});

test('WebCrypto seal reproduces the vector ciphertext and the Node port verifies its signature', async () => {
  const sk = await webPriv(V.keys.desktopSigningPkcs8, ECDSA, ['sign']);
  const sealed = await seal({ header: headerOf(V.snapshot.env), key: await importAes(hexb(V.snapshotKeyHex), 'encrypt'),
    plaintext: te(V.snapshot.plaintext), signingKey: sk, nonce: new Uint8Array(12).fill(0x44) });
  assert.equal(sealed.ct, V.snapshot.env.ct);
  assert.equal(N.open({ env: sealed, key: hexb(V.snapshotKeyHex), verifyKey: nodePub(V.keys.desktopSigningSpki) }).toString(), V.snapshot.plaintext);
});

test('syncwrap: unwraps to four non-extractable keys that open, seal and answer like the vector keys', async () => {
  const ecdh = await webPriv(V.keys.deviceEcdhPkcs8, { name: 'ECDH', namedCurve: 'P-256' }, ['deriveBits']);
  const vk = await importVerify(unb64u(V.keys.desktopSigningSpki));
  const o = { ecdhPrivate: ecdh, deviceEcdhSpki: unb64u(V.keys.deviceEcdhSpki), desktopSigningSpki: unb64u(V.keys.desktopSigningSpki),
    verifyKey: vk, currentEpoch: V.epoch - 1, deviceId: V.ids.deviceId };
  const k = await unwrapSync({ env: V.syncwrap.env, ...o });
  for (const key of Object.values(k)) {
    assert.equal(key.extractable, false);
    await assert.rejects(subtle.exportKey('raw', key));
  }
  assert.equal(td(await open({ env: V.snapshot.env, key: k.snapshot, verifyKey: vk })), V.snapshot.plaintext);
  assert.equal(td(await open({ env: V.manifest.env, key: k.manifest, verifyKey: vk })), V.manifest.plaintext);
  const devSign = await webPriv(V.keys.deviceSigningPkcs8, ECDSA, ['sign']);
  const rq = await seal({ header: { purpose: 'request', userId: V.ids.userId, desktopId: V.ids.desktopId, from: V.ids.deviceId, to: V.ids.desktopId,
    epoch: V.epoch, session: '', seq: 1, issuedAt: 1762300000500, tier: '' }, key: k.request, plaintext: te('{"v":1}'), signingKey: devSign });
  assert.equal(N.open({ env: rq, key: hexb(V.requestKeyHex), verifyKey: nodePub(V.keys.deviceSigningSpki), expect: { purpose: 'request' } }).toString(), '{"v":1}');
  const rp = N.seal({ header: { purpose: 'reply', userId: V.ids.userId, desktopId: V.ids.desktopId, from: V.ids.desktopId, to: V.ids.deviceId,
    epoch: V.epoch, session: '', seq: 2, issuedAt: 1762300000600, tier: '' }, key: hexb(V.replyKeyHex), plaintext: Buffer.from('{"ok":true}'), signingKey: nodePriv(V.keys.desktopSigningPkcs8) });
  assert.equal(td(await open({ env: rp, key: k.reply, verifyKey: vk })), '{"ok":true}');
  assert.equal(await webCode(unwrapSync({ env: V.syncwrap.env, ...o, currentEpoch: V.epoch })), 'stale_epoch');
  assert.equal(await webCode(unwrapSync({ env: V.syncwrap.env, ...o, deviceId: 'someone-else' })), 'bad_to');
  const rogue = N.newSigningKey();
  const forged = N.makeSyncWrap({ ids: V.ids, epoch: V.epoch, tier: 'web', deviceEcdhSpki: unb64u(V.keys.deviceEcdhSpki), desktopSigningSpki: unb64u(V.keys.desktopSigningSpki),
    keys: N.deviceKeys(hexb(V.rootHex), V.ids, V.epoch), signingKey: rogue.privateKey, seq: 11, issuedAt: 1 });
  assert.equal(await webCode(unwrapSync({ env: forged, ...o })), 'bad_signature');
});

test("every sync and relay negative fails closed with the Node port's error code", async () => {
  const cases = [
    ...V.negatives.map((n) => ({ n, env: V.snapshot.env, keyHex: V.snapshotKeyHex, spki: V.keys.desktopSigningSpki })),
    ...RV.negatives.map((n) => ({ n, env: RV.envelope.env, keyHex: RV.envelope.keyHex, spki: RV.keys.deviceSigningSpki })),
  ];
  assert.ok(cases.length >= 18);
  for (const c of cases) {
    const env = mutate(c.env, c.n);
    const want = nodeCode(() => N.open({ env, key: hexb(c.keyHex), verifyKey: nodePub(c.spki) }));
    assert.ok(want, `${c.n}: the Node port refuses it`);
    const got = await webCode(open({ env, key: await importAes(hexb(c.keyHex), 'decrypt'), verifyKey: await importVerify(unb64u(c.spki)) }));
    assert.equal(got, want, c.n);
  }
});

test('closed envelope: unknown fields and purposes are refused; an over-cap frame never seals', async () => {
  const vk = await importVerify(unb64u(V.keys.desktopSigningSpki));
  const key = await importAes(hexb(V.snapshotKeyHex), 'decrypt');
  assert.equal(await webCode(open({ env: { ...V.snapshot.env, extra: 1 }, key, verifyKey: vk })), 'bad_envelope');
  assert.equal(await webCode(open({ env: { ...V.snapshot.env, purpose: 'wrap' }, key, verifyKey: vk })), 'bad_purpose');
  assert.equal(await webCode(open({ env: null, key, verifyKey: vk })), 'bad_envelope');
  const sk = await webPriv(V.keys.desktopSigningPkcs8, ECDSA, ['sign']);
  assert.equal(await webCode(seal({ header: headerOf(V.snapshot.env), key: await importAes(hexb(V.snapshotKeyHex), 'encrypt'),
    plaintext: new Uint8Array(MAX_FRAME + 1), signingKey: sk })), 'frame_too_large');
});
