// Device keys are generated non-extractable and stored as CryptoKeys. The IndexedDB code runs on a small fake factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateDeviceKeys, memoryKeyStore, indexedDbKeyStore } from '../src/sync/keystore.ts';
import { fakeIdb } from './helpers/fake-idb.mjs';

const subtle = globalThis.crypto.subtle;

test('device key pairs are P-256, non-extractable, and only their SPKI leaves WebCrypto', async () => {
  const k = await generateDeviceKeys();
  for (const key of [k.ecdhPrivate, k.signingPrivate]) {
    assert.equal(key.extractable, false);
    for (const f of ['pkcs8', 'jwk', 'raw']) await assert.rejects(subtle.exportKey(f, key), f);
  }
  assert.equal(k.ecdhPrivate.algorithm.name, 'ECDH');
  assert.equal(k.signingPrivate.algorithm.name, 'ECDSA');
  for (const spki of [k.ecdhSpki, k.signingSpki]) { assert.equal(spki.length, 91); assert.equal(spki[0], 0x30); }
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.signingPrivate, new Uint8Array([1]));
  const pub = await subtle.importKey('spki', k.signingSpki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, new Uint8Array([1])));
});

test('the IndexedDB store keeps one device record (CryptoKeys as objects) and clears it', async () => {
  assert.equal(indexedDbKeyStore(undefined), null, 'no IndexedDB: the caller falls back to memory');
  const idb = fakeIdb();
  const ks = indexedDbKeyStore(idb);
  assert.equal(await ks.load(), null);
  const k = await generateDeviceKeys();
  const rec = { v: 1, sid: 'S', dir: 'D', ...k, megaEmail: 'sync@example.com' };
  await ks.save(rec);
  assert.equal(idb.data.get('device'), rec);
  assert.equal((await ks.load()).signingPrivate, k.signingPrivate);
  await ks.clear();
  assert.equal(await ks.load(), null);
  const mem = memoryKeyStore();
  await mem.save(rec); assert.equal(await mem.load(), rec); await mem.clear(); assert.equal(await mem.load(), null);
});

test('source guard: nothing in web/src/sync makes or exports an extractable private or secret key', () => {
  const dir = join(import.meta.dirname, '../src/sync');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /exportKey\(\s*"(pkcs8|jwk|raw)"/, f);
    assert.doesNotMatch(src, /generateKey\([^;]*\btrue\b/, f);
    assert.doesNotMatch(src, /importKey\(\s*"(raw|pkcs8|jwk)"[^;]*\btrue\b/, f);
  }
});
