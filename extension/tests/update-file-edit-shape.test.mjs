// update-file accepts two mutually exclusive edit shapes — a whole-file
// `content` rewrite, or an anchored `old_text`/`new_text` replacement. The
// per-argument schema can't express "exactly one of these", so validateArgs
// applies the cross-field rule whenever it's given the tool name.
//
// Why this matters: `content` for a file the agent only read PART of replaces
// the file with that excerpt. The anchored shape exists so a partially-read
// file can still be edited safely, and these tests pin the rules that keep the
// two shapes from being mixed into something ambiguous.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateArgs, validateEditShape } from '../llm_agent/runtime/fence.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The real schema, so a change to the skill file can't drift from these tests.
const SCHEMA = (() => {
  const { skills } = loadSkills(join(__dirname, '..', 'llm_agent', 'global'));
  const s = skills.get('update-file');
  assert.ok(s, 'update-file skill must load');
  return s.schema;
})();

const valid = (args) => validateArgs(SCHEMA, args, 'update-file');

test('anchored edit is accepted and preserved verbatim', () => {
  const { value, error } = valid({
    path: 'extension/server.mjs',
    old_text: '  const PORT = 3456\n',
    new_text: '  const PORT = 3457\n',
  });
  assert.equal(error, undefined);
  assert.equal(value.old_text, '  const PORT = 3456\n', 'indentation must survive validation');
  assert.equal(value.new_text, '  const PORT = 3457\n');
});

test('whole-file content is accepted', () => {
  const { error } = valid({ path: '/Users/x/README.md', content: '# Hi\n' });
  assert.equal(error, undefined);
});

test('empty new_text is a deletion, not a missing argument', () => {
  const { value, error } = valid({ path: 'a.mjs', old_text: 'dead();\n', new_text: '' });
  assert.equal(error, undefined);
  assert.equal(value.new_text, '');
});

test('rejects mixing content with an anchored edit', () => {
  const { error } = valid({ path: 'a.mjs', content: 'whole', old_text: 'a', new_text: 'b' });
  assert.match(error, /EITHER 'content'.*OR 'old_text'/);
});

test('rejects old_text without new_text', () => {
  const { error } = valid({ path: 'a.mjs', old_text: 'a' });
  assert.match(error, /also requires 'new_text'/);
});

test('rejects new_text without old_text', () => {
  const { error } = valid({ path: 'a.mjs', new_text: 'b' });
  assert.match(error, /also requires 'old_text'/);
});

test('rejects a path with no edit at all', () => {
  const { error } = valid({ path: 'a.mjs' });
  assert.match(error, /needs either 'content'.*or 'old_text'/);
});

test('rejects an empty anchor — it would match every file at offset 0', () => {
  const { error } = valid({ path: 'a.mjs', old_text: '', new_text: 'x' });
  assert.match(error, /must not be empty/);
});

test('path stays required', () => {
  const { error } = valid({ old_text: 'a', new_text: 'b' });
  assert.match(error, /missing required argument 'path'/);
});

test('cross-field rules only apply to update-file', () => {
  // A tool that legitimately takes none of these args must be unaffected.
  assert.deepEqual(validateEditShape('read-file', { path: 'a.mjs' }), {});
  const { error } = validateArgs({ path: { type: 'string', required: true } },
                                 { path: 'a.mjs' }, 'read-file');
  assert.equal(error, undefined);
});

test('validateArgs without a tool name skips cross-field rules', () => {
  // Back-compat: existing call sites that pass two arguments keep working.
  const { error } = validateArgs(SCHEMA, { path: 'a.mjs' });
  assert.equal(error, undefined);
});

test('skill doc warns against whole-file content for a partially-read file', () => {
  // The guardrail that prevents the worst failure mode is prose in the skill
  // body, so assert it is actually there.
  const doc = readFileSync(new URL('../llm_agent/global/update-file.md', import.meta.url), 'utf8');
  assert.match(doc, /Never guess `content` for a file you only saw an excerpt of/);
  assert.match(doc, /match \*\*exactly once\*\*/);
});
