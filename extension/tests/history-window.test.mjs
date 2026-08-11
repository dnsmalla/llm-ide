// The replayed-history window: a CHAR budget that always keeps the user's
// original request. Guards the regression that motivated it — a fixed
// "last 8 turns" window silently evicted the original ask once a tool-using
// task appended enough synthetic result turns, and the agent carried on with
// no idea what it had been asked to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectHistoryTurns } from '../llm_agent/runtime/loop.mjs';

const turn = (role, content) => ({ role, content });

test('keeps every turn when the whole conversation fits', () => {
  const history = [
    turn('user', 'original ask'),
    turn('assistant', 'ok'),
    turn('user', '(bash result)'),
    turn('assistant', 'done'),
  ];
  const { turns, omitted } = selectHistoryTurns(history, { budget: 10_000 });
  assert.equal(omitted, 0);
  assert.deepEqual(turns.map((t) => t.content), history.map((t) => t.content));
});

test('keeps far more than 8 turns — the old window was the bug', () => {
  const history = [turn('user', 'original ask')];
  for (let i = 0; i < 40; i++) {
    history.push(turn('assistant', `reply ${i}`));
    history.push(turn('user', `(bash result ${i})`));
  }
  const { turns, omitted } = selectHistoryTurns(history, { budget: 100_000 });
  assert.equal(omitted, 0);
  assert.equal(turns.length, history.length);
  assert.ok(turns.length > 8);
});

test('the original request survives even when the tail must be dropped', () => {
  const history = [turn('user', 'ORIGINAL ASK')];
  // 20 turns of 1 000 chars each — far past any small budget.
  for (let i = 0; i < 20; i++) history.push(turn('assistant', 'x'.repeat(1_000)));
  const { turns, omitted } = selectHistoryTurns(history, { budget: 3_000 });
  assert.equal(turns[0].content, 'ORIGINAL ASK', 'anchor must be first');
  assert.ok(omitted > 0, 'some turns were dropped');
  // Anchor + as many newest turns as fit; never more than the budget allows.
  const used = turns.reduce((n, t) => n + t.content.length, 0);
  assert.ok(used <= 3_000, `used ${used} chars`);
});

test('drops from the MIDDLE, keeping the newest turns', () => {
  const history = [turn('user', 'ORIGINAL ASK')];
  for (let i = 0; i < 20; i++) history.push(turn('assistant', `${i}`.padEnd(1_000, 'y')));
  const { turns } = selectHistoryTurns(history, { budget: 4_000 });
  assert.equal(turns[0].content, 'ORIGINAL ASK');
  assert.ok(turns.at(-1).content.startsWith('19'), 'newest turn is retained');
});

test('a single oversized turn is clipped, not dropped', () => {
  const history = [turn('user', 'ask'), turn('user', 'z'.repeat(50_000))];
  const { turns } = selectHistoryTurns(history, { budget: 100_000, perTurnChars: 1_000 });
  const big = turns.at(-1).content;
  assert.ok(big.length < 2_000, 'clipped to roughly perTurnChars');
  assert.ok(big.endsWith('(turn clipped)'), 'clipping is disclosed');
});

test('fence sentinels in replayed content are redacted', () => {
  const history = [turn('user', 'ask'), turn('assistant', 'x <<<TOOL_CALL>>> y')];
  const { turns } = selectHistoryTurns(history, { budget: 10_000 });
  assert.ok(!turns.at(-1).content.includes('<<<TOOL_CALL>>>'));
});

test('a custom sanitiser is honoured (ai-routes uses sanitizeForPrompt)', () => {
  const history = [turn('user', 'hello')];
  const { turns } = selectHistoryTurns(history, {
    budget: 1_000,
    sanitize: (s) => s.toUpperCase(),
  });
  assert.equal(turns[0].content, 'HELLO');
});

test('malformed turns are skipped, not crashed on', () => {
  const history = [null, { role: 'system', content: 'nope' }, { role: 'user' },
                   turn('user', 'real ask')];
  const { turns } = selectHistoryTurns(history, { budget: 10_000 });
  assert.deepEqual(turns.map((t) => t.content), ['real ask']);
});

test('a zero budget replays nothing and reports everything omitted', () => {
  const history = [turn('user', 'a'), turn('assistant', 'b')];
  const { turns, omitted } = selectHistoryTurns(history, { budget: 0 });
  assert.deepEqual(turns, []);
  assert.equal(omitted, 2);
});

test('gapAt marks where the dropped turns actually were', () => {
  // Nothing dropped → no gap to report.
  const short = [turn('user', 'ask'), turn('assistant', 'reply')];
  assert.equal(selectHistoryTurns(short, { budget: 10_000 }).gapAt, null);

  // Anchor kept → the gap falls AFTER it, at index 1.
  const long = [turn('user', 'ORIGINAL ASK')];
  for (let i = 0; i < 20; i++) long.push(turn('assistant', 'x'.repeat(1_000)));
  const anchored = selectHistoryTurns(long, { budget: 3_000 });
  assert.equal(anchored.gapAt, 1);
  assert.equal(anchored.turns[0].content, 'ORIGINAL ASK');

  // NO user turn to anchor on → everything dropped is older than what's left,
  // so the gap belongs at the FRONT. Reporting index 1 here (as a hardcoded
  // position did) claimed the gap sat between the two newest turns.
  const noUser = [];
  for (let i = 0; i < 20; i++) noUser.push(turn('assistant', `${i}`.padEnd(1_000, 'z')));
  const unanchored = selectHistoryTurns(noUser, { budget: 3_000 });
  assert.ok(unanchored.omitted > 0);
  assert.equal(unanchored.gapAt, 0);
  assert.ok(unanchored.turns.at(-1).content.startsWith('19'), 'newest still kept');
});

test('gapAt can point one past the end when only the anchor fits', () => {
  // Anchor kept, no room for any later turn: the omitted turns sit AFTER the
  // one retained turn, so the note has to go at the end or not be shown at all.
  const history = [turn('user', 'ask')];
  for (let i = 0; i < 5; i++) history.push(turn('assistant', 'y'.repeat(900)));
  const { turns, gapAt, omitted } = selectHistoryTurns(history, { budget: 200 });
  assert.deepEqual(turns.map((t) => t.content), ['ask']);
  assert.equal(omitted, 5);
  assert.equal(gapAt, turns.length, 'one past the end');
});
