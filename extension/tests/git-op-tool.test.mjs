import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../llm_agent/runtime/fence.mjs';

const SCHEMA = {
  op: { type: 'string', required: true, enum: ['status', 'commit', 'merge_to_main'] },
  message: { type: 'string', required: false, maxLength: 500 },
};

test('validateArgs accepts an allow-listed enum value', () => {
  const r = validateArgs(SCHEMA, { op: 'commit', message: 'hi' });
  assert.equal(r.error, undefined);
  assert.equal(r.value.op, 'commit');
});

test('validateArgs rejects a value outside the enum', () => {
  const r = validateArgs(SCHEMA, { op: 'force-push' });
  assert.match(r.error || '', /must be one of/);
});

test('validateArgs still enforces required + type without enum', () => {
  assert.match(validateArgs(SCHEMA, {}).error || '', /missing required/);
  assert.match(validateArgs(SCHEMA, { op: 5 }).error || '', /must be a string/);
});

// ---------------------------------------------------------------------------
// Task 2: git-op skill integration tests — uses the real skill loader
// ---------------------------------------------------------------------------
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));

test('git-op skill exists, is a write tool, and enum-validates op', async () => {
  const md = path.join(__dirname2, '../llm_agent/global/git-op.md');
  assert.ok(fs.existsSync(md), 'git-op.md must exist');
  const src = fs.readFileSync(md, 'utf8');
  assert.match(src, /kind:\s*write/);
  // The op enum must include the allow-listed ops and the protected-main op.
  for (const op of ['status', 'commit', 'push', 'merge', 'revert', 'merge_to_main']) {
    assert.ok(src.includes(op), `op '${op}' must be declared in git-op.md`);
  }
});

test('git-op schema rejects an unknown op and accepts a known one', async () => {
  // Load via the real registry (same path used at runtime)
  const { globalSkills } = await import('../llm_agent/skills/registry.mjs');
  // globalSkills is the object returned by loadSkills: { skills: Map, base, warnings }
  const gitOp = globalSkills.skills.get('git-op');
  assert.ok(gitOp, 'git-op must load as a global skill');
  assert.equal(gitOp.kind, 'write');

  // The loader must preserve enum so fence.mjs can enforce it at runtime.
  const reject = validateArgs(gitOp.schema, { op: 'force-push' });
  assert.match(reject.error || '', /must be one of/, 'unknown op must be rejected');

  const accept = validateArgs(gitOp.schema, { op: 'status' });
  assert.equal(accept.error, undefined, 'known op must be accepted');
});
