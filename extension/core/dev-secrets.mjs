// Dev secrets (JWT signing key and vault key) auto-generated for local runs.
//
// The file is the only copy of the vault key: vault-encrypted secrets are
// undecryptable without it, and a new JWT key invalidates every session. So:
//   - the primary file (the system data dir when set, else <repo>/kb) is read first;
//   - a legacy <repo>/kb file is read when the primary does not exist yet;
//   - a file that exists but cannot be read or parsed is a hard error, never
//     a reason to generate a new key;
//   - a key is generated only when neither file exists.
// Pure apart from the file reads and the one write, so tests use temp paths.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function readDevSecretsFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`dev secrets file ${file} exists but cannot be read (${err.message}); refusing to generate a new key. Restore it or set LLMIDE_JWT_SECRET and LLMIDE_VAULT_KEY.`);
  }
  if (typeof parsed?.jwtSecret !== 'string' || typeof parsed?.vaultKey !== 'string') {
    throw new Error(`dev secrets file ${file} is missing jwtSecret or vaultKey; refusing to generate a new key.`);
  }
  return { jwtSecret: parsed.jwtSecret, vaultKey: parsed.vaultKey, source: file };
}

/**
 * @param {object} opts
 * @param {string} opts.primaryFile file to read first and to create when no key exists
 * @param {string|null} [opts.legacyFile] fallback file (the repo kb copy), read only if the primary is missing
 * @returns {{jwtSecret: string, vaultKey: string, source: string, generated: boolean}}
 */
export function loadDevSecrets({ primaryFile, legacyFile = null }) {
  if (fs.existsSync(primaryFile)) return { ...readDevSecretsFile(primaryFile), generated: false };
  if (legacyFile && legacyFile !== primaryFile && fs.existsSync(legacyFile)) {
    return { ...readDevSecretsFile(legacyFile), generated: false };
  }
  const fresh = {
    jwtSecret: crypto.randomBytes(48).toString('base64url'),
    vaultKey:  crypto.randomBytes(48).toString('base64url'),
  };
  try {
    fs.mkdirSync(path.dirname(primaryFile), { recursive: true });
    fs.writeFileSync(primaryFile, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  } catch { /* ignore — the key is still returned in-memory */ }
  return { ...fresh, source: primaryFile, generated: true };
}
