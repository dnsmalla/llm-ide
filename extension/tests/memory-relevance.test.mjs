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

test('IDF: query-relevant fact still wins with mixed common/rare tokens', () => {
  // "uses" appears in all 3 facts (low IDF); "pnpm" in 1 (high IDF).
  // "uses pnpm" matches fact 3 on both tokens, facts 1-2 on "uses" only —
  // fact 3 wins under both scorings; this pins the invariant during the change.
  const content = [
    '# Chat memory', '',
    '- uses jest for unit tests',
    '- uses eslint with max-warnings 0',
    '- uses pnpm workspaces for the monorepo',
  ].join('\n');
  const out = selectChatMemoryFacts(content, { userMessage: 'uses pnpm', room: 40 });
  // room=40 fits only one bullet — must be the pnpm fact.
  assert.match(out, /pnpm workspaces/);
});

test('IDF: one rare-token match outranks two ubiquitous-token matches', () => {
  // "runs"/"node" appear in 4 of 5 facts (df=4, low IDF each: log(1+5/4)≈0.81,
  // two matches ≈1.62); "vault" appears in 1 (df=1, IDF log(6)≈1.79).
  // OLD count-scoring: the node facts score 2 vs vault's 1 and rank first —
  // this test FAILS pre-change, proving the behavior difference.
  const content = [
    '# Chat memory', '',
    '- the api runs on node behind nginx',
    '- the worker runs on node with pm2',
    '- the cron jobs runs on node hourly',
    '- local dev runs on node via nvm',
    '- vault rotation happens weekly',
  ].join('\n');
  const out = selectChatMemoryFacts(content, { userMessage: 'runs node vault', room: 200 });
  // Output is in relevance order — the rare-token fact must rank FIRST.
  assert.match(out.split('\n')[0], /vault rotation/, 'rare token ranks first');
});
