// Per-user encrypted credential vault.
//
// Threat model: an attacker who reads our SQLite file (operator with
// shell access, backup leak, supply-chain compromise) must NOT be
// able to recover plaintext credentials.  They must additionally
// possess the master `LLMIDE_VAULT_KEY` env var.  The user_id is
// mixed into key derivation so a leak of one user's data doesn't
// trivially compromise another.
//
// Crypto:
//   data_key = HKDF-SHA256(master, salt=user_id, info='llmide-vault-v1', length=32)
//   ciphertext = iv(12) || AES-256-GCM_data_key(plaintext) || tag(16)
//
// Rotation: we store the key version in the first byte of the iv prefix
// (currently always 0x01) so a future rotation can decrypt v1 records
// while writing v2.

import crypto from 'crypto';
import { config } from '../core/config.mjs';

const KEY_VERSION = 0x01;
const VERSION_BYTE_LEN = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Tagged vault error. Carries an operator-facing `message` for logs +
 * a generic `publicMessage` safe to ship to clients. Callers that
 * forward errors to HTTP responses should prefer `publicMessage` so
 * internal state (blob length, key version, decipher failures) can
 * never reach the user.
 */
class VaultError extends Error {
  constructor(message, { publicMessage } = {}) {
    super(message);
    this.name = 'VaultError';
    this.code = 'VAULT_ERROR';
    this.publicMessage = publicMessage || 'Vault operation failed';
    // Mark with a non-enumerable sentinel so cross-realm checks still
    // work if this module is ever loaded twice.
    Object.defineProperty(this, '__isVaultError', { value: true, enumerable: false });
  }
}

export function isVaultError(err) {
  return Boolean(err && (err.__isVaultError || err?.code === 'VAULT_ERROR'));
}

function deriveDataKey(userId) {
  const master = Buffer.from(config.vaultKey);
  return crypto.hkdfSync('sha256', master, Buffer.from(String(userId)), Buffer.from('llmide-vault-v1'), 32);
}

export function encrypt(userId, plaintext) {
  if (typeof plaintext !== 'string') throw new VaultError('plaintext must be a string', { publicMessage: 'Invalid secret value' });
  const key = Buffer.from(deriveDataKey(userId));
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const versionByte = Buffer.from([KEY_VERSION]);
  // Bind the key-version byte into the GCM tag as additional authenticated
  // data. Without this an attacker with DB write access could flip the
  // version prefix; once multiple key versions exist this would become a
  // downgrade/confusion vector. AAD makes any tampering fail the tag check.
  cipher.setAAD(versionByte);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([versionByte, iv, ct, tag]);
}

export function decrypt(userId, blob) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  if (blob.length < VERSION_BYTE_LEN + IV_LEN + TAG_LEN) {
    throw new VaultError('Vault blob too short');
  }
  const version = blob[0];
  if (version !== KEY_VERSION) throw new VaultError(`Unsupported vault version: ${version}`);
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(1 + IV_LEN, blob.length - TAG_LEN);
  const key = Buffer.from(deriveDataKey(userId));
  const versionByte = blob.subarray(0, VERSION_BYTE_LEN);
  // Decrypt with the version byte bound as AAD (current format). Blobs
  // written before AAD was introduced have no AAD, so on tag failure we
  // retry once without it. The retry can only ever succeed for a genuine
  // legacy v1 blob (an attacker who flips the version byte is rejected by
  // the `version !== KEY_VERSION` check above), and any such record is
  // re-encrypted with AAD on its next setSecret write.
  const attempt = (useAad) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (useAad) decipher.setAAD(versionByte);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  };
  try {
    return attempt(true);
  } catch {
    try {
      return attempt(false); // legacy pre-AAD blob
    } catch (err) {
      // GCM auth-tag mismatch reveals nothing useful to clients; map to
      // a generic VaultError so internal cipher state stays private.
      throw new VaultError(`Vault decrypt failed: ${err.message}`);
    }
  }
}

// --- DB-bound helpers.  Take a `db` (better-sqlite3 instance) so the
// caller controls connection lifecycle.

const ALLOWED_KEYS = new Set([
  'github.token',
  'backlog.apiKey',
  'linear.apiKey',
  'slack.webhookUrl',
  // IMAP app password for the Email input source. The Mac client stores
  // it here via /auth/me/secrets; the server reads it back when fetching
  // recent messages so the password never travels on the fetch request.
  'email.imapPassword',
  // Per-user Anthropic API key.  When present, agent calls run with
  // ANTHROPIC_API_KEY=<this> so each user's LLM spend is attributed
  // to their own account instead of the operator's Claude CLI login.
  'claude.apiKey',
  // Per-user keys for the other model providers (see agents/providers.mjs).
  // A configured key routes that provider's models over the fast HTTP API
  // instead of the local CLI subprocess.
  'openai.apiKey',
  'google.apiKey',
  // Generic OpenAI-compatible "custom" provider (OpenRouter, Ollama, etc.):
  // an API key + the endpoint base URL (the base URL isn't secret, but it
  // rides the same per-user secrets channel for simplicity).
  'custom.apiKey',
  'custom.baseUrl',
]);

function ensureAllowed(key) {
  // This one stays in the open: callers (auth-routes) already enumerate
  // the allowed keys in the same response when this fires, so the name
  // isn't sensitive. Use a vanilla Error so the existing validation
  // pathway in auth-routes keeps surfacing "Unknown vault key" verbatim.
  if (!ALLOWED_KEYS.has(key)) throw new Error(`Unknown vault key: ${key}`);
}

export function setSecret(db, userId, key, value) {
  ensureAllowed(key);
  if (value == null || value === '') {
    db.prepare('DELETE FROM user_secrets WHERE user_id = ? AND secret_key = ?')
      .run(String(userId), key);
    return;
  }
  const blob = encrypt(userId, String(value));
  db.prepare(`
    INSERT INTO user_secrets (user_id, secret_key, ciphertext)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, secret_key) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      updated_at = datetime('now')
  `).run(String(userId), key, blob);
}

export function getSecret(db, userId, key) {
  ensureAllowed(key);
  const row = db.prepare(
    'SELECT ciphertext FROM user_secrets WHERE user_id = ? AND secret_key = ?',
  ).get(String(userId), key);
  if (!row) return null;
  return decrypt(userId, row.ciphertext);
}

export function listSecretKeys(db, userId) {
  return db.prepare(
    'SELECT secret_key, updated_at FROM user_secrets WHERE user_id = ?',
  ).all(String(userId));
}

// Fetch multiple secrets in one DB round-trip.  Returns a plain object
// keyed by secret_key with decrypted values; missing keys are absent.
// Unknown keys are silently skipped (same policy as getSecret).
export function getSecrets(db, userId, keys) {
  const allowed = keys.filter((k) => ALLOWED_KEYS.has(k));
  if (allowed.length === 0) return {};
  const ph = allowed.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT secret_key, ciphertext FROM user_secrets WHERE user_id = ? AND secret_key IN (${ph})`,
  ).all(String(userId), ...allowed);
  const out = {};
  for (const row of rows) {
    try { out[row.secret_key] = decrypt(userId, row.ciphertext); }
    catch { /* skip corrupt row */ }
  }
  return out;
}

export const VAULT_KEYS = Array.from(ALLOWED_KEYS);

/**
 * Re-encrypt any secrets for `userId` that were stored without AAD
 * (legacy pre-AAD blobs).  Call once per user at login — best-effort,
 * never throws so a migration failure never blocks login.
 *
 * A legacy blob succeeds under `attempt(false)` but fails under
 * `attempt(true)`.  We detect it by trying the current-format decrypt
 * first; if that throws and the legacy path succeeds, we immediately
 * re-encrypt with AAD and update the row.
 *
 * Emits a structured info line to stderr for observability:
 *   { level: 'info', msg: 'vault_legacy_migrated', userId, key }
 */
export function migrateLegacySecrets(db, userId) {
  let rows;
  try {
    rows = db.prepare(
      'SELECT secret_key, ciphertext FROM user_secrets WHERE user_id = ?',
    ).all(String(userId));
  } catch {
    return; // DB error — don't block login
  }

  for (const row of rows) {
    try {
      const blob = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
      if (blob.length < VERSION_BYTE_LEN + IV_LEN + TAG_LEN) continue;
      const version = blob[0];
      if (version !== KEY_VERSION) continue;

      const iv = blob.subarray(1, 1 + IV_LEN);
      const tag = blob.subarray(blob.length - TAG_LEN);
      const ct = blob.subarray(1 + IV_LEN, blob.length - TAG_LEN);
      const key = Buffer.from(deriveDataKey(userId));
      const versionByte = blob.subarray(0, VERSION_BYTE_LEN);

      // Try current-format (with AAD) first — if it succeeds the blob is
      // already migrated, skip it.
      let plaintext;
      let isLegacy = false;
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAAD(versionByte);
        d.setAuthTag(tag);
        plaintext = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      } catch {
        // Current-format failed — try legacy (no AAD).
        try {
          const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
          d.setAuthTag(tag);
          plaintext = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
          isLegacy = true;
        } catch {
          continue; // Neither path works — corrupt blob, skip.
        }
      }

      if (!isLegacy) continue; // Already uses current format.

      // Re-encrypt with AAD and overwrite the row.
      const newBlob = encrypt(userId, plaintext);
      db.prepare(`
        UPDATE user_secrets SET ciphertext = ?, updated_at = datetime('now')
        WHERE user_id = ? AND secret_key = ?
      `).run(newBlob, String(userId), row.secret_key);

      process.stderr.write(JSON.stringify({
        level: 'info',
        msg: 'vault_legacy_migrated',
        userId: String(userId),
        key: row.secret_key,
      }) + '\n');
    } catch {
      // Per-secret errors are non-fatal — keep going.
    }
  }
}
