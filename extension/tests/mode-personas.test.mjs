// extension/tests/mode-personas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personaForMode, restrictsTools } from '../llm_agent/runtime/mode-personas.mjs';

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
