// Host API v1 read mappers: closed shapes, redaction on read, size caps, paging hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsOf, historyOf, usageOf, READ_LIMITS } from '../routes/host-api/reads.mjs';
import { response } from '../routes/host-api/frame.mjs';
import { HOST_API_LIMITS } from '../routes/host-api/commands.generated.mjs';

const KEY = `sk-ant-api03-${'A'.repeat(48)}`;
const valid = (command, result) => assert.doesNotThrow(() => response('c-1', command, result, 0));

test('sessionsOf: ms timestamps, redacted titles, phone chat flagged, nextOffset only when more exist', () => {
  const rows = [
    { id: 'chat-1', title: 'Phone chat', updatedAt: 1762300000.5 },
    { id: 'chat-2', title: `paste ${KEY}`, updatedAt: 1762290000 },
    { id: 'chat-3', title: '', updatedAt: 1 },
  ];
  const r = sessionsOf(rows, 2, 0, 'chat-1');
  assert.deepEqual(r.sessions[0], { id: 'chat-1', title: 'Phone chat', updatedAt: 1762300000500, phoneChat: true });
  assert.doesNotMatch(r.sessions[1].title, /sk-ant/);
  assert.equal(r.sessions.length, 2);
  assert.equal(r.nextOffset, 2);
  assert.equal(sessionsOf(rows, 5, 10, null).nextOffset, undefined);
  assert.equal(sessionsOf(rows, 5, 10, null).sessions[2].title, 'New chat');
  valid('chat.sessions', r);
});

test('sessionsOf: an id the wire cannot carry is skipped, never sent', () => {
  const r = sessionsOf([{ id: 'bad/id', title: 't', updatedAt: 1 }, { id: 'ok', title: 't', updatedAt: 1 }], 50, 0, null);
  assert.deepEqual(r.sessions.map((s) => s.id), ['ok']);
});

test('historyOf: only user and assistant lines, no meta, redacted, paging hint from the store', () => {
  const session = { hasMore: true, messages: [
    { seq: 3, role: 'system', content: 'sys', meta: { x: 1 } },
    { seq: 4, role: 'user', content: `my key ${KEY}`, meta: { tool: 'Bash' } },
    { seq: 5, role: 'assistant', content: 'ok' },
  ] };
  const r = historyOf(session, 100);
  assert.deepEqual(r.messages.map((m) => [m.seq, m.role]), [[4, 'user'], [5, 'assistant']]);
  assert.doesNotMatch(r.messages[0].content, /sk-ant/);
  assert.equal(Object.keys(r.messages[0]).sort().join(), 'content,role,seq');
  assert.equal(r.nextBeforeSeq, 3, 'the oldest fetched row, even a filtered one, so the next page does not repeat');
  assert.equal(historyOf({ hasMore: false, messages: session.messages }, 100).nextBeforeSeq, undefined);
  valid('chat.history', r);
});

test('historyOf: trimmed to maxListBytes oldest first, newest kept, nextBeforeSeq at the oldest kept', () => {
  const big = 'x'.repeat(100_000);
  const messages = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: big }));
  const r = historyOf({ hasMore: false, messages }, 500);
  assert.ok(r.messages.length < 12 && r.messages.length >= 1);
  assert.equal(r.messages.at(-1).seq, 12);
  assert.equal(r.nextBeforeSeq, r.messages[0].seq);
  assert.ok(Buffer.byteLength(JSON.stringify(r.messages)) <= HOST_API_LIMITS.maxListBytes + r.messages.length);
  valid('chat.history', r);
});

test('usageOf: numbers and labels only, no limit configuration, bounded', () => {
  const summary = { providers: {
    anthropic: { active: { status: 'ok', model: 'claude-sonnet-4-5', reason: 'x' }, models: [
      { model: 'claude-sonnet-4-5', label: 'Sonnet', enabled: 1, custom: false, priority: 0, unit: 'runs', window_kind: 'daily',
        limit: 100, threshold_pct: 90, used: 42, pct: 42.4, state: 'ok', quota: false, tokens: { input: 1 }, resetAt: '2026-11-06T00:00:00.000Z' },
      { model: 'claude-haiku-4-5', label: '', unit: 'tokens', window_kind: 'monthly', limit: 0, used: 0, pct: null, state: 'ok', resetAt: '2026-12-01T00:00:00.000Z' },
    ] },
    weird: { active: { status: 'nope' }, models: Array.from({ length: 80 }, (_, i) => ({ model: `m${i}`, state: 'boom', unit: 'x', window_kind: 'y', used: -1, limit: NaN, resetAt: 'bad' })) },
  } };
  const r = usageOf(summary);
  const m0 = r.providers[0].models[0];
  assert.deepEqual(m0, { model: 'claude-sonnet-4-5', label: 'Sonnet', state: 'ok', unit: 'runs', window: 'daily', used: 42, limit: 100, pct: 42, resetAt: Date.parse('2026-11-06T00:00:00.000Z') });
  assert.equal(r.providers[0].models[1].pct, undefined);
  assert.equal(r.providers[0].models[1].label, undefined);
  assert.equal(r.providers[1].status, 'unconfigured');
  assert.equal(r.providers[1].models.length, READ_LIMITS.modelsMax);
  assert.deepEqual(r.providers[1].models[0], { model: 'm0', state: 'ok', unit: 'runs', window: 'daily', used: 0, limit: 0, resetAt: 0 });
  valid('usage.get', r);
});
