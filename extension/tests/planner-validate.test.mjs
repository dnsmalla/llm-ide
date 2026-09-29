import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// planner.mjs imports the kb + provider layers; give them the test env first.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '_planner-validate-test.db');

const { validatePlan } = await import('../agents/planner.mjs');

const meeting = { title: 'Sync', participants: ['Aiko Tanaka', 'Ben'] };
const plan = (owner) => ({
  title: 'P', goal: 'G',
  milestones: [{ name: 'M1', tasks: [{ title: 'Do it', owner }] }],
});

test('an owner from the participant list is kept (case-insensitive)', () => {
  assert.equal(validatePlan(plan('aiko tanaka'), meeting, 'G').tasks[0].owner, 'aiko tanaka');
});

test('an invented owner becomes null', () => {
  assert.equal(validatePlan(plan('Someone Else'), meeting, 'G').tasks[0].owner, null);
});

test('with no participants recorded, owners are left as given', () => {
  assert.equal(validatePlan(plan('Ben'), { title: 'Sync', participants: [] }, 'G').tasks[0].owner, 'Ben');
});
