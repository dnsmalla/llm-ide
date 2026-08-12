// Tests for getGoogleAccessToken's client-credential resolution
// (connectors/email-source.mjs) — proves BYO always wins as an atomic pair when
// present, hosted config is used only when neither per-user field is set,
// and the missing-refresh-token guard fires before any network call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_GOOGLE_CLIENT_ID = 'hosted-cid';
process.env.LLMIDE_GOOGLE_CLIENT_SECRET = 'hosted-csecret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_email-google-token-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { getGoogleAccessToken } = await import('../connectors/email-source.mjs');

function stubTokenFetch(expectClientId, expectClientSecret) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), expectClientId, `expected token refresh to use client_id=${expectClientId}`);
    assert.equal(body.get('client_secret'), expectClientSecret, `expected token refresh to use client_secret=${expectClientSecret} (paired with client_id=${expectClientId})`);
    return { ok: true, json: async () => ({ access_token: `AT-for-${expectClientId}`, expires_in: 3600 }) };
  };
  return () => { global.fetch = orig; };
}

test('getGoogleAccessToken uses the per-user BYO client when one is stored (not the hosted config)', async () => {
  const u = users.registerUser(kb.getDb(), { email: `byo-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.clientId', 'byo-cid');
  setSecret(kb.getDb(), u.id, 'google.email.clientSecret', 'byo-csecret');
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');

  const restore = stubTokenFetch('byo-cid', 'byo-csecret');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-byo-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken falls back to the hosted config when no per-user client is stored', async () => {
  const u = users.registerUser(kb.getDb(), { email: `hosted-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');
  // Deliberately NOT setting google.email.clientId/clientSecret for this user.

  const restore = stubTokenFetch('hosted-cid', 'hosted-csecret');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-hosted-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken ignores a half-written BYO client (clientId only, no clientSecret) and uses hosted for BOTH', async () => {
  const u = users.registerUser(kb.getDb(), { email: `half-id-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.clientId', 'byo-cid');
  // Deliberately NOT setting google.email.clientSecret.
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');

  const restore = stubTokenFetch('hosted-cid', 'hosted-csecret');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-hosted-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken ignores a half-written BYO client (clientSecret only, no clientId) and uses hosted for BOTH', async () => {
  const u = users.registerUser(kb.getDb(), { email: `half-secret-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.clientSecret', 'byo-csecret');
  // Deliberately NOT setting google.email.clientId.
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');

  const restore = stubTokenFetch('hosted-cid', 'hosted-csecret');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-hosted-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken throws when no refresh token is stored, regardless of client config', async () => {
  const u = users.registerUser(kb.getDb(), { email: `none-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('must not reach the network — the missing-refresh-token guard should short-circuit first'); };
  try {
    await assert.rejects(() => getGoogleAccessToken(kb.getDb(), u.id), /not signed in/i);
  } finally { global.fetch = orig; }
});
