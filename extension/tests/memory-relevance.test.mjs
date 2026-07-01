// F1/F2/F9: relevance-ranked chat-memory selection at read time.
//
// The old reader injected chat-memory.md as a raw string clipped to the budget
// head — which (a) ignored the user's actual question and (b) kept the OLDEST
// facts and dropped the newest when it overflowed (facts are stored
// oldest->newest, clip keeps the head). selectChatMemoryFacts ranks facts by
// overlap with the current question (recency as tiebreak) and greedily fits the
// room, so the most relevant facts survive a tight budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectChatMemoryFacts } from '../graphkit/memory.mjs';

const FILE = (facts) => `# Chat memory\n\n${facts.map((f) => `- ${f}`).join('\n')}\n`;

test('returns all facts (as bullets) when they all fit the room', () => {
  const content = FILE(['uses pnpm workspaces', 'deploys via Fly.io']);
  const out = selectChatMemoryFacts(content, { userMessage: 'anything', room: 10_000 });
  assert.ok(out.includes('- uses pnpm workspaces'));
  assert.ok(out.includes('- deploys via Fly.io'));
});

test('prefers facts that overlap the question when the room is tight', () => {
  const content = FILE([
    'the auth flow uses JWT access and refresh tokens',
    'the CSS build runs through postcss',
    'database migrations live in kb/migrations',
  ]);
  // Room fits only ~one fact. The question is about auth → the auth fact must win.
  const room = '- the auth flow uses JWT access and refresh tokens'.length + 5;
  const out = selectChatMemoryFacts(content, { userMessage: 'how does auth and jwt work?', room });
  assert.ok(out.includes('auth flow uses JWT'), 'the query-relevant fact must survive');
  assert.ok(!out.includes('postcss'), 'an irrelevant fact must be dropped under a tight budget');
});

test('with no question, keeps the NEWEST facts first (fixes old drop-newest clip)', () => {
  // Facts stored oldest->newest. Under a tight room and no relevance signal,
  // the newest should be preferred (the old raw-clip kept the oldest).
  const content = FILE(['oldest fact about the parser', 'newest fact about the deployer']);
  const room = '- newest fact about the deployer'.length + 5;
  const out = selectChatMemoryFacts(content, { userMessage: '', room });
  assert.ok(out.includes('newest fact about the deployer'), 'newest fact must survive');
  assert.ok(!out.includes('oldest fact about the parser'), 'oldest dropped when only one fits');
});

test('empty / factless content yields an empty string', () => {
  assert.equal(selectChatMemoryFacts('# Chat memory\n', { userMessage: 'x', room: 1000 }), '');
  assert.equal(selectChatMemoryFacts('', { userMessage: 'x', room: 1000 }), '');
});

test('category tag counts toward relevance and is preserved in output', () => {
  const content = FILE(['[tooling] vite powers the dev server', '[architecture] the API is REST']);
  const room = 60;
  const out = selectChatMemoryFacts(content, { userMessage: 'what tooling do we use?', room });
  assert.ok(out.includes('[tooling] vite'), 'category-matched fact wins and keeps its tag');
});
