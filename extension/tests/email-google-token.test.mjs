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
const { getGoogleAccessToken } = await import('../agents/email-source.mjs');

function stubTokenFetch(expectClientId) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), expectClientId, `expected token refresh to use client_id=${expectClientId}`);
    return { ok: true, json: async () => ({ access_token: `AT-for-${expectClientId}`, expires_in: 3600 }) };
  };
  return () => { global.fetch = orig; };
}

test('getGoogleAccessToken uses the per-user BYO client when one is stored (not the hosted config)', async () => {
  const u = users.registerUser(kb.getDb(), { email: `byo-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.clientId', 'byo-cid');
  setSecret(kb.getDb(), u.id, 'google.email.clientSecret', 'byo-csecret');
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');

  const restore = stubTokenFetch('byo-cid');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-byo-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken falls back to the hosted config when no per-user client is stored', async () => {
  const u = users.registerUser(kb.getDb(), { email: `hosted-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');
  // Deliberately NOT setting google.email.clientId/clientSecret for this user.

  const restore = stubTokenFetch('hosted-cid');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-hosted-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken throws when no refresh token is stored, regardless of client config', async () => {
  const u = users.registerUser(kb.getDb(), { email: `none-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  await assert.rejects(() => getGoogleAccessToken(kb.getDb(), u.id), /not signed in/i);
});
