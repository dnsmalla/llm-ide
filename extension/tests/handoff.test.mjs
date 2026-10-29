import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildHandoff, HANDOFF_NOTE_CHARS } = await import('../providers/handoff.mjs');

const conv = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} ${'x'.repeat(50)}` }));

test('a short chat is just the turns: no note', () => {
  const h = buildHandoff({ history: conv(4) });
  assert.equal(h.source, 'none');
  assert.equal(h.history.length, 4);
  assert.equal(h.noteChars, 0);
});

test('a long chat becomes a note plus the last turns, never the whole transcript', () => {
  const h = buildHandoff({ history: conv(60) });
  assert.equal(h.source, 'extractive');
  assert.ok(h.noteChars > 0 && h.noteChars <= HANDOFF_NOTE_CHARS);
  assert.match(h.history[0].content, /^\[Handoff note/);
  assert.equal(h.history[0].role, 'user');
  assert.equal(h.history[1].role, 'assistant', 'roles alternate after the note');
  assert.ok(h.history.length <= 6 + 2);
  assert.match(h.history.at(-1).content, /^turn 59/);
  assert.equal(h.coveredTurns, 54);
  assert.ok(!h.history.slice(2).some((t) => /^turn 3 /.test(t.content)), 'old turns are not replayed');
});

test('the client\'s summary wins and is the single copy: no derived text is added', () => {
  const h = buildHandoff({ history: conv(60), summary: 'Decided to use SQLite. Open: auth.' });
  assert.equal(h.source, 'client');
  assert.match(h.history[0].content, /Decided to use SQLite/);
  assert.ok(!/turn 5 /.test(h.history[0].content));
});

test('secrets are redacted in the note and in the kept turns, and the cap holds', () => {
  const secret = 'sk-ant-api03-' + 'a'.repeat(40);
  const hist = conv(40);
  hist[2].content = `my key is ${secret}`;
  hist[39].content = `again ${secret}`;
  const h = buildHandoff({ history: hist, summary: null });
  assert.ok(!JSON.stringify(h).includes(secret));
  const big = buildHandoff({ history: conv(2000), maxChars: 500 });
  assert.ok(big.noteChars <= 500);
  const clamped = buildHandoff({ history: conv(2000), maxChars: -5 });
  assert.ok(clamped.noteChars <= HANDOFF_NOTE_CHARS, 'a bad cap falls back to the default');
});

test('garbage input never throws', () => {
  for (const history of [null, 'x', [null, 1, { role: 'system', content: 'x' }, { role: 'user', content: 5 }]]) {
    assert.deepEqual(buildHandoff({ history }).history, []);
  }
  assert.equal(buildHandoff({ history: conv(10), keepTurns: 0 }).history.length >= 1, true);
});
