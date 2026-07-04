import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelayMs,
  testConnection,
  fetchChannelHistory,
  _setSleepForTest,
  _resetUserCache,
} from '../agents/slack-source.mjs';

// Build a fake fetch Response. `retryAfter` (seconds, string) is exposed via a
// minimal headers.get shim; undefined → header absent.
function resp(status, body, retryAfter) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null) },
    json: async () => body,
  };
}

// Replace the backoff sleep with a no-op that records the requested delays, so
// the retry loop runs instantly instead of blocking the suite.
function stubSleep() {
  const waits = [];
  _setSleepForTest(async (ms) => { waits.push(ms); });
  return waits;
}

test('backoffDelayMs honors Retry-After (seconds), else exponential, both capped', () => {
  // Valid Retry-After header wins, converted to ms.
  assert.equal(backoffDelayMs(0, '2'), 2000);
  assert.equal(backoffDelayMs(3, '5'), 5000);
  // Retry-After of 0 is respected (Slack occasionally sends it).
  assert.equal(backoffDelayMs(1, '0'), 0);
  // Absent/garbage header → exponential 1s, 2s, 4s…
  assert.equal(backoffDelayMs(0, null), 1000);
  assert.equal(backoffDelayMs(1, undefined), 2000);
  assert.equal(backoffDelayMs(2, 'nope'), 4000);
  // Capped at 30s regardless of source.
  assert.equal(backoffDelayMs(0, '9999'), 30000);
  assert.equal(backoffDelayMs(20, null), 30000);
});

test('slackCall retries on HTTP 429, honoring Retry-After, then succeeds', async () => {
  const orig = global.fetch;
  const waits = stubSleep();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return resp(429, {}, '3');           // rate limited, retry after 3s
    return resp(200, { ok: true, team: 'Acme', user: 'bot' });
  };
  try {
    const r = await testConnection({ token: 't' });
    assert.equal(r.ok, true);
    assert.equal(r.team, 'Acme');
    assert.equal(calls, 2, 'should retry exactly once after the 429');
    assert.deepEqual(waits, [3000], 'should wait the Retry-After duration');
  } finally { global.fetch = orig; _setSleepForTest(null); }
});

test('slackCall gives up after bounded retries and surfaces a rate-limit error', async () => {
  const orig = global.fetch;
  stubSleep();
  let calls = 0;
  global.fetch = async () => { calls += 1; return resp(429, {}, '1'); };
  try {
    await assert.rejects(() => testConnection({ token: 't' }), /rate limit/i);
    // Initial attempt + MAX_RETRIES(3) retries = 4 total.
    assert.equal(calls, 4, `expected 4 attempts, got ${calls}`);
  } finally { global.fetch = orig; _setSleepForTest(null); }
});

test('slackCall retries on an ok:false ratelimited body (HTTP 200)', async () => {
  const orig = global.fetch;
  const waits = stubSleep();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return resp(200, { ok: false, error: 'ratelimited' }, '2');
    return resp(200, { ok: true, team: 'Acme', user: 'bot' });
  };
  try {
    const r = await testConnection({ token: 't' });
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2000]);
  } finally { global.fetch = orig; _setSleepForTest(null); }
});

test('fetchChannelHistory resolves names from a cached team roster (no per-author users.info)', async () => {
  _resetUserCache();
  const orig = global.fetch;
  const counts = { authTest: 0, history: 0, list: 0, info: 0 };
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    if (url.includes('auth.test')) { counts.authTest += 1; return resp(200, { ok: true, team_id: 'T1', team: 'Acme' }); }
    if (url.includes('conversations.history')) {
      counts.history += 1;
      return resp(200, { ok: true, messages: [
        { ts: '9.0', type: 'message', user: 'U1', text: 'a' },
        { ts: '9.1', type: 'message', user: 'U2', text: 'b' },
        { ts: '9.2', type: 'message', user: 'U3', text: 'c' },
      ]});
    }
    if (url.includes('users.list')) {
      counts.list += 1;
      return resp(200, { ok: true, members: [
        { id: 'U1', profile: { display_name: 'Alice' } },
        { id: 'U2', real_name: 'Bob' },
        { id: 'U3', name: 'carol' },
      ]});
    }
    if (url.includes('users.info')) { counts.info += 1; return resp(200, { ok: true, user: { name: 'x' } }); }
    return resp(200, { ok: false, error: 'unexpected' });
  };
  try {
    const first = await fetchChannelHistory({ token: 't', channelId: 'C1', oldestTs: null, seenTs: [] });
    const names = first.messages.map((m) => m.user).sort();
    assert.deepEqual(names, ['Alice', 'Bob', 'carol']);
    assert.equal(counts.info, 0, 'must not call users.info when the roster covers every author');
    assert.equal(counts.list, 1, 'roster is fetched with a single users.list');

    // A second fetch within the TTL window reuses the cached roster.
    await fetchChannelHistory({ token: 't', channelId: 'C1', oldestTs: null, seenTs: [] });
    assert.equal(counts.list, 1, 'second fetch must reuse the cached roster');
    assert.equal(counts.info, 0);
  } finally { global.fetch = orig; _resetUserCache(); }
});

test('fetchChannelHistory falls back to users.info for authors missing from the roster', async () => {
  _resetUserCache();
  const orig = global.fetch;
  const counts = { list: 0, info: 0 };
  const infoUsers = [];
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    if (url.includes('auth.test')) return resp(200, { ok: true, team_id: 'T2' });
    if (url.includes('conversations.history')) return resp(200, { ok: true, messages: [
      { ts: '9.0', type: 'message', user: 'U1', text: 'a' },
      { ts: '9.1', type: 'message', user: 'U9', text: 'b' },
    ]});
    if (url.includes('users.list')) { counts.list += 1; return resp(200, { ok: true, members: [
      { id: 'U1', profile: { display_name: 'Alice' } },
    ]}); }
    if (url.includes('users.info')) {
      counts.info += 1;
      const id = new URL(url).searchParams.get('user');
      infoUsers.push(id);
      return resp(200, { ok: true, user: { real_name: 'Nine' } });
    }
    return resp(200, { ok: false, error: 'unexpected' });
  };
  try {
    const { messages } = await fetchChannelHistory({ token: 't', channelId: 'C1', oldestTs: null, seenTs: [] });
    const byName = messages.map((m) => m.user).sort();
    assert.deepEqual(byName, ['Alice', 'Nine']);
    assert.equal(counts.list, 1);
    assert.deepEqual(infoUsers, ['U9'], 'only the roster-missing author triggers users.info');
  } finally { global.fetch = orig; _resetUserCache(); }
});
