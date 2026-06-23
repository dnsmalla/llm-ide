import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMrkdwn, normalizeMessage, fetchChannelHistory } from '../agents/slack-source.mjs';

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
