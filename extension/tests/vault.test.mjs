// Vault tests — encryption roundtrip, per-user key isolation, and
// resistance to wrong-key decryption.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEETNOTES_JWT_SECRET = 'a'.repeat(48);
process.env.MEETNOTES_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { encrypt, decrypt } = await import('../server/vault.mjs');

test('encrypt/decrypt roundtrips for the same user', () => {
  const blob = encrypt('user-1', 'super-secret-token');
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(decrypt('user-1', blob), 'super-secret-token');
});

test('blob format starts with version byte 0x01', () => {
  const blob = encrypt('user-1', 'x');
  assert.equal(blob[0], 1);
});

test('decrypt with a different userId fails', () => {
  const blob = encrypt('user-A', 'A-secret');
  assert.throws(() => decrypt('user-B', blob));
});

test('decrypt fails on bit-flipped ciphertext (auth tag check)', () => {
  const blob = encrypt('user-1', 'tampered');
  // Flip a byte in the ciphertext region (after version byte and IV).
  const tampered = Buffer.from(blob);
  tampered[20] = tampered[20] ^ 0xff;
  assert.throws(() => decrypt('user-1', tampered));
});

test('two encryptions of the same plaintext produce different ciphertexts', () => {
  // AES-GCM with random IV must produce distinct ciphertexts.
  const a = encrypt('user-1', 'same');
  const b = encrypt('user-1', 'same');
  assert.notEqual(Buffer.compare(a, b), 0);
});

test('decrypt rejects truncated blob', () => {
  const blob = encrypt('user-1', 'x');
  assert.throws(() => decrypt('user-1', blob.subarray(0, 10)));
});
