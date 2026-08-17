// extension/tests/mode-personas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personaForMode, restrictsTools, allowedToolNames } from '../llm_agent/runtime/mode-personas.mjs';

test('personaForMode returns mode-specific text for plan/review/document', () => {
  assert.match(personaForMode('plan'), /PLAN mode/);
  assert.match(personaForMode('review'), /REVIEW mode/);
  assert.match(personaForMode('document'), /DOCUMENT mode/);
});

test('personaForMode returns empty string for execute (no persona change)', () => {
  assert.equal(personaForMode('execute'), '');
});

test('personaForMode returns empty string for an unrecognised mode', () => {
  assert.equal(personaForMode('something-else'), '');
});

test('restrictsTools is true for plan/review/document, false for execute', () => {
  assert.equal(restrictsTools('plan'), true);
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

test('allowedToolNames excludes save-plan when called with no mode (or a non-plan mode)', () => {
  assert.equal(allowedToolNames().has('save-plan'), false);
  assert.equal(allowedToolNames('review').has('save-plan'), false);
  assert.equal(allowedToolNames('document').has('save-plan'), false);
});

test('allowedToolNames("plan") includes save-plan on top of the base read-only set', () => {
  const names = allowedToolNames('plan');
  assert.equal(names.has('save-plan'), true);
  // Base set is still fully present — this is additive, not a replacement.
  assert.equal(names.has('read-file'), true);
  assert.equal(names.has('update-file'), false);
});
