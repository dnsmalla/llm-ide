import { test } from 'node:test';
import assert from 'node:assert/strict';
// Load the pinned fetch before any test swaps global.fetch: its NODE_ENV=test seam honours a swap
// only when the module saw the original fetch first.
import '../server/pinned-fetch.mjs';
process.env.NODE_ENV = 'test';
import { buildAuthUrl, exchangeCode, putState, getState, completeState, takeStatus } from '../connectors/slack-oauth.mjs';

test('buildAuthUrl includes client_id, redirect_uri, user_scope (no bot scope), state', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:3456/auth/slack/callback', state: 'st' }));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:3456/auth/slack/callback');
  assert.equal(u.searchParams.get('user_scope'), 'channels:history,groups:history,channels:read,groups:read,users:read');
  assert.equal(u.searchParams.get('scope'), null, 'no bot scope requested — no bot user should be installed');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('exchangeCode posts and parses the user token + team name', async () => {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://slack.com/api/oauth.v2.access');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'CODE');
    assert.equal(body.get('client_id'), 'c');
    assert.equal(body.get('client_secret'), 's');
    return {
      ok: true,
      json: async () => ({ ok: true, authed_user: { access_token: 'xoxp-abc' }, team: { name: 'Acme' } }),
    };
  };
  try {
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'CODE', redirectUri: 'http://127.0.0.1:3456/auth/slack/callback' });
    assert.deepEqual(t, { accessToken: 'xoxp-abc', teamName: 'Acme' });
  } finally { global.fetch = orig; }
});

test('exchangeCode throws a clean error when Slack reports ok:false', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'invalid_code' }) });
  try {
    await assert.rejects(
      () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'r' }),
      /invalid_code/,
    );
  } finally { global.fetch = orig; }
});

test('exchangeCode throws when the HTTP request itself fails', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await assert.rejects(
      () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }),
      /500/,
    );
  } finally { global.fetch = orig; }
});

test('exchangeCode throws when Slack returns ok:true but no user token (bot scope misconfiguration)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, team: { name: 'Acme' } }) });
  try {
    await assert.rejects(
      () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }),
      /user_scope|no user token/i,
    );
  } finally { global.fetch = orig; }
});

test('state store: put/get/complete/take with single-use status, carrying teamName + channels', () => {
  putState('S1', { userId: 'u1' });
  assert.equal(getState('S1').userId, 'u1');
  completeState('S1', { status: 'complete', teamName: 'Acme', channels: [{ id: 'C1', name: 'general' }] });
  assert.deepEqual(takeStatus('S1'), { status: 'complete', teamName: 'Acme', channels: [{ id: 'C1', name: 'general' }] });
  // status is single-read: after take it's gone (or pending→unknown)
  assert.equal(getState('S1'), undefined);
});

test('getState returns undefined for an unknown state', () => {
  assert.equal(getState('does-not-exist'), undefined);
});

test('exchangeCode reaches only slack.com and refuses a redirect', async () => {
  const orig = global.fetch; const seen = [];
  global.fetch = async (url, init) => { seen.push({ url: String(url), redirect: init.redirect }); return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }); };
  try { await assert.rejects(() => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }), /redirect 302 not followed/); assert.deepEqual(seen, [{ url: 'https://slack.com/api/oauth.v2.access', redirect: 'manual' }]); } finally { global.fetch = orig; }
});
