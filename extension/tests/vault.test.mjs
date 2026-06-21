// Vault tests — encryption roundtrip, per-user key isolation, and
// resistance to wrong-key decryption.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { encrypt, decrypt, migrateLegacySecrets } = await import('../server/vault.mjs');

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

// ── SRV-5: legacy no-AAD migration ──────────────────────────────────────────

// Build a legacy blob (version byte + IV + CT + tag, no AAD) to simulate
// pre-AAD vault rows without touching private vault internals.
function makeLegacyBlob(userId, plaintext) {
  const KEY_VERSION = 0x01;
  const IV_LEN = 12;
  // Reproduce the HKDF key derivation from vault.mjs (same params).
  const master = Buffer.from('b'.repeat(48));
  const key = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(String(userId)), Buffer.from('llmide-vault-v1'), 32));
  const iv = crypto.randomBytes(IV_LEN);
  // No setAAD — this is the legacy path.
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, ct, tag]);
}

test('migrateLegacySecrets re-encrypts legacy blobs with AAD', () => {
  // Create an in-memory DB with the minimal user_secrets schema.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_secrets (
      user_id TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, secret_key)
    )
  `);

  const userId = 'user-legacy-1';
  const plaintext = 'my-secret-value';
  const legacy = makeLegacyBlob(userId, plaintext);

  db.prepare('INSERT INTO user_secrets (user_id, secret_key, ciphertext) VALUES (?, ?, ?)')
    .run(userId, 'github.token', legacy);

  // Verify the legacy blob decrypts before migration (legacy path).
  assert.equal(decrypt(userId, legacy), plaintext, 'legacy blob must decrypt before migration');

  // Run the migration.
  migrateLegacySecrets(db, userId);

  // Fetch the row after migration.
  const row = db.prepare('SELECT ciphertext FROM user_secrets WHERE user_id = ? AND secret_key = ?')
    .get(userId, 'github.token');
  assert.ok(row, 'row must still exist after migration');

  const migrated = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
  // The migrated blob should now decrypt correctly with the current (AAD) path.
  assert.equal(decrypt(userId, migrated), plaintext, 'migrated blob must decrypt with current format');

  // The migrated blob must be different bytes (new IV, new AAD binding).
  assert.notEqual(Buffer.compare(migrated, legacy), 0, 'migrated blob must differ from legacy blob');
});

test('migrateLegacySecrets does not alter already-current-format blobs', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_secrets (
      user_id TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, secret_key)
    )
  `);

  const userId = 'user-current-1';
  const plaintext = 'modern-secret';
  const modern = encrypt(userId, plaintext);

  db.prepare('INSERT INTO user_secrets (user_id, secret_key, ciphertext) VALUES (?, ?, ?)')
    .run(userId, 'github.token', modern);

  migrateLegacySecrets(db, userId);

  const row = db.prepare('SELECT ciphertext FROM user_secrets WHERE user_id = ? AND secret_key = ?')
    .get(userId, 'github.token');
  const after = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
  // The blob should be identical — current-format blobs are not rewritten.
  assert.equal(Buffer.compare(after, modern), 0, 'current-format blob must not be modified');
});
