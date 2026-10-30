// git-op skill definition. The classic fence loop's validateArgs (which enforced the enum) is gone
// (K1 P6 T6.8); what stays worth pinning is the skill file and that the loader keeps the enum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));

test('git-op skill exists, is a write tool, and declares the allow-listed ops', async () => {
  const md = path.join(__dirname2, '../llm_agent/global/git-op.md');
  assert.ok(fs.existsSync(md), 'git-op.md must exist');
  const src = fs.readFileSync(md, 'utf8');
  assert.match(src, /kind:\s*write/);
  for (const op of ['status', 'commit', 'push', 'merge', 'revert', 'merge_to_main']) {
    assert.ok(src.includes(op), `op '${op}' must be declared in git-op.md`);
  }
});

test('the loader keeps the op enum on the git-op schema', async () => {
  const { globalSkills } = await import('../llm_agent/skills/registry.mjs');
  const gitOp = globalSkills.skills.get('git-op');
  assert.ok(gitOp, 'git-op must load as a global skill');
  assert.equal(gitOp.kind, 'write');
  assert.ok(Array.isArray(gitOp.schema.op?.enum) && gitOp.schema.op.enum.includes('status') && !gitOp.schema.op.enum.includes('force-push'));
});
