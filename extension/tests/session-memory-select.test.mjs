// Which session facts ride the prompt when a chat has no transcript to lean on
// (llm_agent/runtime/session-memory-select.mjs): all of them when they fit,
// otherwise the newest few plus the ones the message is about.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

test('selectSessionMemory: everything when it fits; else the newest plus what the message is about', async () => {
  const { selectSessionMemory } = await import('../llm_agent/runtime/session-memory-select.mjs');
  assert.deepEqual(selectSessionMemory(['a fact', 'b fact'], 'x'), ['a fact', 'b fact']);
  const facts = [
    'The database schema uses a partitioned events table',          // old but relevant
    ...Array.from({ length: 60 }, (_, i) => `Filler decision ${i} about unrelated styling`),
  ];
  const picked = selectSessionMemory(facts, 'go back to the partitioned schema we agreed on', { maxFacts: 15 });
  assert.equal(picked.length, 15);
  assert.ok(picked.includes(facts[0]), 'an old fact the message is about is kept');
  assert.ok(picked.includes(facts[facts.length - 1]), 'the newest fact is always kept');
  assert.deepEqual(picked, [...picked].sort((a, b) => facts.indexOf(a) - facts.indexOf(b)), 'original order');
});
