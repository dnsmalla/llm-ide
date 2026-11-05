import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as S from '../core/sync-envelope.mjs';

const relay = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url)));
const sync = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url)));
const hex = (s) => Buffer.from(s, 'hex');
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });

test('relay v1 vectors: canonical encoding, subkeys, padding and the request envelope are byte-identical', () => {
  assert.equal(S.enc([1, 'ab', '']).toString('hex'), relay.canonical.hex);
  const k = S.deviceKeys(hex(relay.subkeys.rootHex), relay.subkeys.ids, relay.subkeys.epoch);
  assert.equal(k.request.toString('hex'), relay.subkeys.requestHex);
  assert.equal(k.reply.toString('hex'), relay.subkeys.replyHex);
  assert.equal(S.pad(Buffer.from(relay.envelope.frame)).length, relay.padding.bucket);
  const env = relay.envelope.env;
  assert.equal(S.open({ env, key: k.request, verifyKey: pub(relay.keys.deviceSigningSpki) }).toString(), relay.envelope.frame);
  const again = S.seal({ header: relay.envelope.header, key: k.request, plaintext: Buffer.from(relay.envelope.frame), signingKey: priv(relay.keys.deviceSigningPkcs8), nonce: hex(relay.envelope.nonceHex) });
  assert.equal(again.ct, env.ct);
});

test('relay v1 negatives fail closed in the sync port', () => {
  const k = S.deviceKeys(hex(relay.subkeys.rootHex), relay.subkeys.ids, relay.subkeys.epoch);
  for (const n of relay.negatives) {
    const env = structuredClone(relay.envelope.env);
    const [op, rest] = n.split(/:(.*)/s);
    if (op === 'flip') { const x = b(env[rest]); x[0] ^= 1; env[rest] = x.toString('base64url'); }
    else if (op === 'truncate') { env[rest] = b(env[rest]).subarray(0, -1).toString('base64url'); }
    else { const [key, val] = rest.split('='); env[key] = /^[0-9]+$/.test(val) ? Number(val) : val; }
    assert.throws(() => S.open({ env, key: k.request, verifyKey: pub(relay.keys.deviceSigningSpki) }), S.SyncCryptoError, n);
  }
});

test('sync v1 vectors: snapshot and manifest open with the derived per-device keys', () => {
  const k = S.deviceKeys(hex(sync.rootHex), sync.ids, sync.epoch);
  assert.equal(k.snapshot.toString('hex'), sync.snapshotKeyHex);
  assert.equal(k.manifest.toString('hex'), sync.manifestKeyHex);
  const vk = pub(sync.keys.desktopSigningSpki);
  assert.equal(S.open({ env: sync.snapshot.env, key: k.snapshot, verifyKey: vk, expect: { purpose: 'snapshot' } }).toString(), sync.snapshot.plaintext);
  assert.equal(S.open({ env: sync.manifest.env, key: k.manifest, verifyKey: vk, expect: { purpose: 'manifest' } }).toString(), sync.manifest.plaintext);
  assert.throws(() => S.open({ env: sync.snapshot.env, key: k.manifest, verifyKey: vk }), /bad_ciphertext/, 'one key per purpose');
  assert.throws(() => S.open({ env: sync.snapshot.env, key: k.snapshot, verifyKey: vk, expect: { purpose: 'manifest' } }), /bad_purpose/);
});

test('syncwrap: our wrap equals the vector ciphertext, unwraps to the four keys, and a forged signer is refused', () => {
  const k = S.deviceKeys(hex(sync.rootHex), sync.ids, sync.epoch);
  const w = S.makeSyncWrap({ ids: sync.ids, epoch: sync.epoch, tier: 'web', deviceEcdhSpki: b(sync.keys.deviceEcdhSpki), desktopSigningSpki: b(sync.keys.desktopSigningSpki),
    keys: k, signingKey: priv(sync.keys.desktopSigningPkcs8), eph: { privateKey: priv(sync.keys.ephPkcs8), publicKey: pub(sync.keys.ephSpki) }, nonce: Buffer.alloc(12, 0x55), seq: 11, issuedAt: 1762300000002 });
  assert.equal(w.ct, sync.syncwrap.env.ct);
  const opts = { ecdhPrivate: priv(sync.keys.deviceEcdhPkcs8), deviceEcdhSpki: b(sync.keys.deviceEcdhSpki), desktopSigningSpki: b(sync.keys.desktopSigningSpki), verifyKey: pub(sync.keys.desktopSigningSpki), currentEpoch: sync.epoch - 1, deviceId: sync.ids.deviceId };
  const got = S.unwrapSync({ env: sync.syncwrap.env, ...opts });
  for (const name of ['request', 'reply', 'snapshot', 'manifest']) assert.equal(got[name].toString('hex'), k[name].toString('hex'));
  assert.throws(() => S.unwrapSync({ env: sync.syncwrap.env, ...opts, currentEpoch: sync.epoch }), /stale_epoch/);
  const rogue = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => S.unwrapSync({ env: sync.syncwrap.env, ...opts, verifyKey: rogue.publicKey }), /bad_signature/);
});

test('open refuses unknown envelope fields, unknown purposes and an over-cap frame', () => {
  const k = S.deviceKeys(hex(sync.rootHex), sync.ids, sync.epoch);
  const vk = pub(sync.keys.desktopSigningSpki);
  assert.throws(() => S.open({ env: { ...sync.snapshot.env, extra: 1 }, key: k.snapshot, verifyKey: vk }), /bad_envelope/);
  assert.throws(() => S.open({ env: { ...sync.snapshot.env, purpose: 'wrap' }, key: k.snapshot, verifyKey: vk }), /bad_purpose/);
  assert.throws(() => S.pad(Buffer.alloc(S.MAX_FRAME + 1)), /frame_too_large/);
  assert.equal(S.spkiFingerprint(b(sync.keys.desktopSigningSpki)), sync.desktopSigningFingerprint);
});
