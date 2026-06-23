import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMrkdwn, normalizeMessage } from '../agents/slack-source.mjs';

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
