import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSkills } from '../llm_agent/skills/loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function writeFixture(dir, name, body) {
  writeFileSync(join(dir, name), body, 'utf8');
}

function newDir() {
  const d = mkdtempSync(join(tmpdir(), 'agent-skills-'));
  return d;
}

test('loader returns the _base.md body separately', () => {
  const d = newDir();
  writeFixture(d, '_base.md', '# Base\nbase content');
  writeFixture(d, 'search-kb.md',
    '---\nname: search-kb\nkind: read\nschema:\n  query:\n    type: string\n    required: true\n---\n# search-kb\nbody');
  const result = loadSkills(d);
  assert.equal(result.base.trim(), '# Base\nbase content');
  assert.equal(result.skills.size, 1);
  assert.ok(result.skills.has('search-kb'));
});

test('loader parses kind + schema from frontmatter', () => {
  const d = newDir();
  writeFixture(d, '_base.md', 'base');
  writeFixture(d, 'create-issue.md',
    '---\nname: create-issue\nkind: write\nconfirmation: editable-sheet\nschema:\n  title:\n    type: string\n    required: true\n    maxLength: 200\n  labels:\n    type: "string[]"\n    required: false\n---\n# create-issue\nbody');
  const result = loadSkills(d);
  const s = result.skills.get('create-issue');
  assert.equal(s.kind, 'write');
  assert.equal(s.confirmation, 'editable-sheet');
  assert.equal(s.schema.title.type, 'string');
  assert.equal(s.schema.title.required, true);
  assert.equal(s.schema.title.maxLength, 200);
  assert.equal(s.schema.labels.type, 'string[]');
});

test('loader drops a skill with invalid frontmatter and records a warning', () => {
  const d = newDir();
  writeFixture(d, '_base.md', 'base');
  writeFixture(d, 'broken.md', '---\nname: broken\nkind: invalid-kind\n---\nbody');
  const result = loadSkills(d);
  assert.equal(result.skills.size, 0);
  assert.ok(result.warnings.some(w => w.includes('broken')));
});

test('loader drops a skill whose name does not match the file basename', () => {
  const d = newDir();
  writeFixture(d, '_base.md', 'base');
  writeFixture(d, 'foo.md', '---\nname: bar\nkind: read\nschema: {}\n---\nbody');
  const result = loadSkills(d);
  assert.equal(result.skills.size, 0);
  assert.ok(result.warnings.some(w => w.includes('foo')));
});

test('real internal skills directory exposes comment-gitlab-issue as a write tool', () => {
  const dir = join(__dirname, '..', 'llm_agent', 'internal', 'skills');
  const result = loadSkills(dir);
  const s = result.skills.get('comment-gitlab-issue');
  assert.ok(s, 'comment-gitlab-issue skill must be loaded');
  assert.equal(s.kind, 'write');
  assert.equal(s.confirmation, 'editable-sheet');
  assert.equal(s.schema.iid.type, 'number');
  assert.equal(s.schema.iid.required, true);
  assert.equal(s.schema.body.type, 'string');
  assert.equal(s.schema.body.required, true);
  assert.equal(s.schema.body.maxLength, 50000);
});

test('real internal skills directory exposes trigger-review-code as a write tool', () => {
  const dir = join(__dirname, '..', 'llm_agent', 'internal', 'skills');
  const result = loadSkills(dir);
  const s = result.skills.get('trigger-review-code');
  assert.ok(s, 'trigger-review-code skill must be loaded');
  assert.equal(s.kind, 'write');
  assert.equal(s.confirmation, 'editable-sheet');
  assert.equal(s.schema.plan.type, 'string');
  assert.equal(s.schema.plan.required, true);
  assert.equal(s.schema.plan.maxLength, 50000);
  assert.equal(s.schema.iid.type, 'number');
  assert.equal(s.schema.iid.required, true);
});

test('real global skills directory exposes update-file as a write tool', () => {
  const dir = join(__dirname, '..', 'llm_agent', 'global');
  const result = loadSkills(dir);
  const s = result.skills.get('update-file');
  assert.ok(s, 'update-file skill must be loaded');
  assert.equal(s.kind, 'write');
  assert.equal(s.confirmation, 'editable-sheet');
  assert.equal(s.schema.path.type, 'string');
  assert.equal(s.schema.path.required, true);
  assert.equal(s.schema.path.maxLength, 1000);
  assert.equal(s.schema.content.type, 'string');
  assert.equal(s.schema.content.required, true);
  assert.equal(s.schema.content.maxLength, 200000);
  // Sanity: ask-internal still loads alongside update-file.
  assert.ok(result.skills.has('ask-internal'),
    'global agent should still have ask-internal');
});

test('loader returns empty base when _base.md is missing', () => {
  const d = newDir();
  writeFixture(d, 'search-kb.md',
    '---\nname: search-kb\nkind: read\nschema:\n  query:\n    type: string\n---\n# search-kb');
  const result = loadSkills(d);
  assert.equal(result.base, '');
  assert.ok(result.warnings.some(w => w.includes('_base.md')));
});
