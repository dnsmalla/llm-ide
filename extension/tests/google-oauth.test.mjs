import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pkcePair, buildAuthUrl, exchangeCode, refreshAccessToken, putState, getState, completeState, takeStatus } from '../agents/google-oauth.mjs';

test('pkcePair: challenge is base64url(SHA256(verifier))', () => {
  const { verifier, challenge } = pkcePair();
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
});

test('buildAuthUrl includes scope, offline, consent, S256, state, challenge', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:3456/auth/google/callback', state: 'st', challenge: 'ch' }));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('scope'), 'https://mail.google.com/');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge'), 'ch');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('response_type'), 'code');
});

test('exchangeCode posts and parses tokens', async () => {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code_verifier'), 'ver');
    return { ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) };
  };
  try {
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'CODE', verifier: 'ver', redirectUri: 'http://127.0.0.1:3456/auth/google/callback' });
    assert.deepEqual(t, { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
  } finally { global.fetch = orig; }
});

test('refreshAccessToken posts refresh grant', async () => {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'RT');
    return { ok: true, json: async () => ({ access_token: 'AT2', expires_in: 3599 }) };
  };
  try {
    const t = await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'RT' });
    assert.equal(t.accessToken, 'AT2');
  } finally { global.fetch = orig; }
});

test('exchangeCode throws a clean error on non-ok', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }) });
  try {
    await assert.rejects(() => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'r' }), /invalid_grant|bad code/);
  } finally { global.fetch = orig; }
});

test('state store: put/get/complete/take with single-use status', () => {
  putState('S1', { userId: 'u1', verifier: 'v1' });
  assert.equal(getState('S1').userId, 'u1');
  completeState('S1', { status: 'complete', email: 'a@b.com' });
  assert.deepEqual(takeStatus('S1'), { status: 'complete', email: 'a@b.com' });
  // status is single-read: after take it's gone (or pending→unknown)
  assert.equal(getState('S1'), undefined);
});
