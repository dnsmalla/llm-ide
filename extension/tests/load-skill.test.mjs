// extension/tests/load-skill.test.mjs
// The load-skill tool (llm_agent/runtime/handlers/load-skill.mjs) — how a
// skill that ends by naming another skill hands over to it. Stage 2 of the
// planning pipeline depends on this: brainstorming's terminal step is
// "invoke the writing-plans skill", and before this tool that line was a
// dead end in every restricted mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLoadSkill } from '../llm_agent/runtime/handlers/load-skill.mjs';
import { entries, names } from '../llm_agent/tools/registry.mjs';

const CATALOG = [
  { id: 'skills/writing-plans', name: 'writing-plans' },
  { id: 'skills/brainstorming', name: 'brainstorming' },
];
const ctx = (over = {}) => ({
  userId: 'u1',
  readSkill: (id) => (id === 'skills/writing-plans'
    ? { id, name: 'writing-plans', content: '# Writing Plans\nSave plans to…' }
    : null),
  listSkills: () => ({ skills: CATALOG }),
  ...over,
});

test('resolves a known id to its followable instructions', async () => {
  const out = await handleLoadSkill({ id: 'skills/writing-plans' }, ctx());
  assert.equal(out.id, 'skills/writing-plans');
  assert.equal(out.name, 'writing-plans');
  assert.match(out.content, /# Writing Plans/);
  assert.ok(!out.error);
});

test('trims whitespace around the id', async () => {
  const out = await handleLoadSkill({ id: '  skills/writing-plans \n' }, ctx());
  assert.equal(out.id, 'skills/writing-plans');
});

test('an unknown id returns available ids rather than throwing', async () => {
  // The realistic miss: the model drops the family prefix. Ending the turn
  // on a thrown tool would strand it mid-process; naming the real ids lets
  // it correct itself in the same turn.
  const out = await handleLoadSkill({ id: 'writing-plans' }, ctx());
  assert.equal(out.error, 'unknown skill id');
  assert.deepEqual(out.available, ['skills/writing-plans', 'skills/brainstorming']);
});

test('a missing id is reported, not guessed at', async () => {
  for (const args of [{}, { id: '' }, { id: 42 }, null]) {
    const out = await handleLoadSkill(args, ctx());
    assert.equal(out.error, 'missing skill id');
  }
});

test('a broken catalog degrades to an empty suggestion list', async () => {
  const out = await handleLoadSkill({ id: 'nope' }, ctx({
    listSkills: () => { throw new Error('no repo'); },
  }));
  assert.equal(out.error, 'unknown skill id');
  assert.deepEqual(out.available, []);
});

test('tool-result content is fence-redacted', async () => {
  // The loop parses on <<<TOOL_RESULT>>>; a SKILL.md that documents a fence
  // (writing-skills does) would otherwise close the block early.
  const out = await handleLoadSkill({ id: 'x' }, ctx({
    readSkill: (id) => ({ id, name: 'writing-skills', content: 'emit <<<TOOL_CALL>>> like this' }),
  }));
  assert.ok(!out.content.includes('<<<TOOL_CALL>>>'), `fence survived redaction: ${out.content}`);
});

test('load-skill is registered as a read tool', () => {
  assert.ok(names().includes('load-skill'));
  const entry = entries().find((e) => e.name === 'load-skill');
  assert.equal(entry.kind, 'read', 'must be kind:read — it returns text and is needed in restricted modes');
  assert.equal(entry.gate, undefined, 'a read tool carries no safety gate');
});
