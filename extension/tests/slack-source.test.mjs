import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMrkdwn, normalizeMessage, fetchChannelHistory, resolveOldestTs, listUserConversations } from '../agents/slack-source.mjs';

test('resolveOldestTs: high-water wins; else lookbackDays, clamped 1..60', () => {
  // Forward-only high-water always wins, verbatim.
  assert.equal(resolveOldestTs({ oldestTs: '1718900000.000100', lookbackDays: 7 }), '1718900000.000100');
  const now = Date.now() / 1000;
  // No high-water → ~7 days ago.
  const seven = Number(resolveOldestTs({ oldestTs: null, lookbackDays: 7 }));
  assert.ok(seven < now && seven > now - 8 * 86400, `7d bound off: ${seven}`);
  // Clamp: 1000 days → 60 days.
  const clamped = Number(resolveOldestTs({ oldestTs: null, lookbackDays: 1000 }));
  assert.ok(clamped >= now - 61 * 86400 && clamped <= now - 59 * 86400, `clamp off: ${clamped}`);
  // Invalid → default 7 days.
  const def = Number(resolveOldestTs({ oldestTs: null, lookbackDays: 'x' }));
  assert.ok(def < now && def > now - 8 * 86400, `default off: ${def}`);
});

test('stripMrkdwn unwraps links and decodes entities', () => {
  assert.equal(stripMrkdwn('see <https://x.com|the docs> &amp; more'), 'see the docs & more');
  assert.equal(stripMrkdwn('raw <https://x.com>'), 'raw https://x.com');
  assert.equal(stripMrkdwn('a &lt;b&gt; c'), 'a <b> c');
  assert.equal(stripMrkdwn(''), '');
});

test('normalizeMessage produces the stable shape with resolved user name', () => {
  const raw = { ts: '1718900000.000100', user: 'U123', text: 'hi <@U999>', thread_ts: '1718900000.000100' };
  const out = normalizeMessage(raw, 'C1', 'Alice');
  assert.equal(out.ts, '1718900000.000100');
  assert.equal(out.channelId, 'C1');
  assert.equal(out.user, 'Alice');
  assert.equal(out.threadTs, '1718900000.000100');
  assert.ok(out.text.includes('hi'));
});

test('normalizeMessage falls back to the user id when no name is known', () => {
  const out = normalizeMessage({ ts: '1.1', user: 'U7', text: 'x' }, 'C1', null);
  assert.equal(out.user, 'U7');
  assert.equal(out.threadTs, null);
});

test('fetchChannelHistory includes thread replies', async () => {
  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    const json = (o) => ({ ok: true, json: async () => o });
    if (url.includes('conversations.history')) return json({ ok: true, messages: [
      { ts: '9.0', type: 'message', user: 'U1', text: 'plain' },
      { ts: '10.0', thread_ts: '10.0', reply_count: 1, type: 'message', user: 'U1', text: 'parent' },
    ]});
    if (url.includes('conversations.replies')) return json({ ok: true, messages: [
      { ts: '10.0', thread_ts: '10.0', type: 'message', user: 'U1', text: 'parent' },
      { ts: '10.5', thread_ts: '10.0', type: 'message', user: 'U2', text: 'a reply' },
    ]});
    if (url.includes('users.info')) return json({ ok: true, user: { name: 'someone' } });
    return json({ ok: false, error: 'unexpected' });
  };
  try {
    const { messages } = await fetchChannelHistory({ token: 't', channelId: 'C1', oldestTs: null, seenTs: [] });
    const texts = messages.map((m) => m.text).join(' | ');
    assert.ok(texts.includes('a reply'), `expected a reply, got: ${texts}`);
    assert.ok(texts.includes('parent'));
    const reply = messages.find((m) => m.text.includes('a reply'));
    assert.equal(reply.threadTs, '10.0');
  } finally { global.fetch = orig; }
});

test('listUserConversations paginates and returns {id, name} pairs', async () => {
  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    const json = (o) => ({ ok: true, json: async () => o });
    if (url.includes('users.conversations')) {
      if (url.includes('cursor=page2')) {
        return json({ ok: true, channels: [{ id: 'C3', name: 'random' }], response_metadata: { next_cursor: '' } });
      }
      return json({ ok: true, channels: [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'eng' }], response_metadata: { next_cursor: 'page2' } });
    }
    return json({ ok: false, error: 'unexpected' });
  };
  try {
    const { channels, complete } = await listUserConversations({ token: 't' });
    assert.deepEqual(channels, [
      { id: 'C1', name: 'general' },
      { id: 'C2', name: 'eng' },
      { id: 'C3', name: 'random' },
    ]);
    assert.equal(complete, true);
  } finally { global.fetch = orig; }
});

test('listUserConversations degrades to an empty list on failure (never throws)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const { channels, complete } = await listUserConversations({ token: 't' });
    assert.deepEqual(channels, []);
    assert.equal(complete, false);
  } finally { global.fetch = orig; }
});

test('listUserConversations preserves earlier pages when a later page fails', async () => {
  const orig = global.fetch;
  let call = 0;
  global.fetch = async (_urlStr) => {
    call++;
    const json = (o) => ({ ok: true, json: async () => o });
    if (call === 1) {
      return json({ ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: 'page2' } });
    }
    throw new Error('network blip');
  };
  try {
    const { channels, complete } = await listUserConversations({ token: 't' });
    assert.deepEqual(channels, [{ id: 'C1', name: 'general' }], 'page 1 results must survive the page-2 failure');
    assert.equal(complete, false);
  } finally { global.fetch = orig; }
});

test('listUserConversations stops at MAX_CONVERSATIONS_PAGES on an endless cursor', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ ok: true, channels: [{ id: `C${calls}`, name: `ch${calls}` }], response_metadata: { next_cursor: 'always-more' } }) };
  };
  try {
    const { channels, complete } = await listUserConversations({ token: 't' });
    assert.equal(calls, 20, 'must stop at the page cap, not loop forever');
    assert.equal(channels.length, 20);
    assert.equal(complete, false, 'hitting the cap is not a complete/natural end');
  } finally { global.fetch = orig; }
});
