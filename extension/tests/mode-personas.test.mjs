// extension/tests/mode-personas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { personaForMode, restrictsTools, allowedToolNames, PLAN_LIKE_MODES } from '../llm_agent/runtime/mode-personas.mjs';

test('personaForMode returns mode-specific text for plan/assist_plan/review/document', () => {
  assert.match(personaForMode('plan'), /PLAN mode/);
  assert.match(personaForMode('assist_plan'), /ASSIST_PLAN mode/);
  assert.match(personaForMode('review'), /REVIEW mode/);
  assert.match(personaForMode('document'), /DOCUMENT mode/);
});

test('assist_plan persona describes all 5 phases and the round/recommended-answer question format', () => {
  const persona = personaForMode('assist_plan');
  assert.match(persona, /assist-plan skill/);
  assert.match(persona, /ONE numbered round per turn/);
  assert.match(persona, /recommended default/);
  assert.match(persona, /save-plan/);
});

test('personaForMode returns empty string for execute (no persona change)', () => {
  assert.equal(personaForMode('execute'), '');
});

test('personaForMode returns empty string for an unrecognised mode', () => {
  assert.equal(personaForMode('something-else'), '');
});

test('restrictsTools is true for plan/assist_plan/review/document, false for execute', () => {
  assert.equal(restrictsTools('plan'), true);
  assert.equal(restrictsTools('assist_plan'), true);
  assert.equal(restrictsTools('review'), true);
  assert.equal(restrictsTools('document'), true);
  assert.equal(restrictsTools('execute'), false);
  assert.equal(restrictsTools('something-else'), false);
});

test('allowedToolNames returns a Set that does NOT include run-bash (it executes unconfirmed, despite kind: read)', () => {
  const names = allowedToolNames();
  assert.ok(names instanceof Set);
  assert.equal(names.has('run-bash'), false);
  assert.equal(names.has('bash'), false);
});

test('allowedToolNames excludes all write-kind tools (git-op, update-file) alongside run-bash', () => {
  const names = allowedToolNames();
  assert.equal(names.has('git-op'), false);
  assert.equal(names.has('update-file'), false);
});

test('allowedToolNames includes genuinely read-only tools', () => {
  const names = allowedToolNames();
  assert.ok(names.size > 0);
  assert.ok(names.has('search-kb'));
  assert.ok(names.has('read-file'));
  assert.ok(names.has('list-files'));
});

test('allowedToolNames excludes task tracking tools — Plan/Review/Document modes never track a multi-step plan', () => {
  const names = allowedToolNames();
  assert.equal(names.has('task-create'), false);
  assert.equal(names.has('task-update'), false);
  assert.equal(names.has('task-list'), false);
});

test('allowedToolNames excludes save-plan when called with no mode (or a non-plan-like mode)', () => {
  assert.equal(allowedToolNames().has('save-plan'), false);
  assert.equal(allowedToolNames('review').has('save-plan'), false);
  assert.equal(allowedToolNames('document').has('save-plan'), false);
});

test('allowedToolNames includes save-plan on top of the base read-only set for every plan-like mode', () => {
  for (const mode of PLAN_LIKE_MODES) {
    const names = allowedToolNames(mode);
    assert.equal(names.has('save-plan'), true, `expected save-plan for mode "${mode}"`);
    // Base set is still fully present — this is additive, not a replacement.
    assert.equal(names.has('read-file'), true);
    assert.equal(names.has('update-file'), false);
  }
});

test('PLAN_LIKE_MODES is exactly {plan, assist_plan}', () => {
  assert.deepEqual([...PLAN_LIKE_MODES].sort(), ['assist_plan', 'plan']);
});

test('READ_ONLY_TOOL_NAMES is derived from the registry, not hand-maintained', async () => {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(__dirname, '..', 'llm_agent', 'runtime', 'mode-personas.mjs'), 'utf8');
  assert.ok(src.includes("kind === 'read'"), 'expected the read-only set to be derived from registry entry.kind');
  assert.ok(!/const READ_ONLY_TOOL_NAMES = new Set\(\[\s*\n\s*'ask-internal',/.test(src), 'the old hand-maintained literal should be gone');
});

test('allowedToolNames(execute) includes all kind:read tools except task-list', () => {
  const names = [...allowedToolNames('execute')].sort();
  assert.deepEqual(names, ['ask-internal', 'ask-subagent', 'fetch-url', 'find-code', 'list-files', 'project_memory', 'read-file', 'search-kb', 'web-search']);
});

test('allowedToolNames(execute) explicitly excludes task-list despite it being kind:read', () => {
  const names = allowedToolNames('execute');
  assert.equal(names.has('task-list'), false, 'task-list should be excluded even though it is kind:read in the registry');
});

test('allowedToolNames(plan) adds save-plan on top of the base 9-tool read set', () => {
  const names = [...allowedToolNames('plan')].sort();
  assert.ok(names.includes('save-plan'));
  assert.equal(names.length, 10);
});
