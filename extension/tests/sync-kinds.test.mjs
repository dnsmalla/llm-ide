import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKinds, KINDS } from '../routes/sync/kinds.mjs';
import { MAX_FRAME } from '../core/sync-envelope.mjs';

const raw = (over = {}) => ({
  sessions: [{ id: 's1', title: 'Hello', updatedAt: 100, messages: [{ seq: 1, role: 'user', content: 'hi' }, { seq: 2, role: 'system', content: 'x' }, { seq: 3, role: 'assistant', content: 'key sk-ant-api03-' + 'a'.repeat(90) }] }],
  phoneChatId: 's1',
  meetings: [{ id: 'm1', title: 'Standup', date: '2026-11-05', duration_sec: 600, participants: ['A', 'B'] }],
  entities: { m1: [{ kind: 'decision', text: 'Ship it' }] },
  plans: [{ id: 'p1', title: 'Plan', goal: 'G', updatedAt: 5, tasks: [{ title: 'T', status: 'todo', owner: 'me', due: null, milestone: 'M1', risk: 'low', description: 'not synced' }] }],
  usage: { providers: {} },
  ...over,
});

test('every kind is a closed JSON frame; system lines, descriptions and secrets do not leave', () => {
  const k = buildKinds(raw(), 1000);
  assert.deepEqual(Object.keys(k).sort(), [...KINDS].sort());
  const chats = JSON.parse(k.chats);
  assert.equal(chats.v, 1); assert.equal(chats.kind, 'chats'); assert.equal(chats.truncated, false);
  assert.deepEqual(chats.items[0].messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chats.items[0].phoneChat, true);
  assert.ok(!k.chats.toString().includes('sk-ant-api03'), 'secrets are re-redacted');
  assert.ok(!k.plans.toString().includes('not synced'));
  assert.equal(JSON.parse(k.meetings).items[0].notes[0].text, 'Ship it');
  assert.equal(JSON.parse(k.usage).kind, 'usage');
});

test('an oversized kind drops oldest items until it fits and says truncated', () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: 't', updatedAt: 1000 - i,
    messages: Array.from({ length: 30 }, (_, j) => ({ seq: j + 1, role: 'user', content: 'x'.repeat(8000) })) }));
  const k = buildKinds(raw({ sessions: big }), 1);
  const chats = JSON.parse(k.chats);
  assert.ok(k.chats.length <= MAX_FRAME);
  assert.equal(chats.truncated, true);
  assert.equal(chats.items[0].id, 's0', 'newest kept');
});
