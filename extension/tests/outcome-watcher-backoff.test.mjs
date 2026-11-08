// The background outcome poller backs off while nothing changes and snaps back on any change (REQ-014 B6):
// a quiet install polls once an hour instead of every 5 minutes, which matters on a shared hub where every task
// poll is a provider API call with the user's token.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { nextPollDelayMs } = await import('../agents/outcome-watcher.mjs');

const BASE = 5 * 60_000;
const MAX = 60 * 60_000;

test('the poll interval doubles on a quiet cycle, caps at an hour, and resets on a change', () => {
  let ms = BASE;
  const seen = [];
  for (let i = 0; i < 6; i += 1) { ms = nextPollDelayMs(ms, false); seen.push(ms); }
  assert.deepEqual(seen, [10 * 60_000, 20 * 60_000, 40 * 60_000, MAX, MAX, MAX]);
  assert.equal(nextPollDelayMs(MAX, false), MAX, 'never beyond the ceiling');
  assert.equal(nextPollDelayMs(MAX, true), BASE, 'any change resets to the base interval');
  assert.equal(nextPollDelayMs(60_000, false), 10 * 60_000, 'a value below the base doubles from the base');
});
