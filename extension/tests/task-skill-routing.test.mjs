// extension/tests/task-skill-routing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskType } from '../llm_agent/runtime/task-skill-routing.mjs';

test('classifyTaskType maps bug/fix/debug keywords to systematic-debugging', () => {
  assert.equal(classifyTaskType('Fix the null-pointer bug in AuthMiddleware'), 'skills/systematic-debugging');
  assert.equal(classifyTaskType('Debug why the login flow hangs'), 'skills/systematic-debugging');
});

test('classifyTaskType maps test keywords to test-driven-development', () => {
  assert.equal(classifyTaskType('Write tests for the new route'), 'skills/test-driven-development');
  assert.equal(classifyTaskType('Add a test case for the edge case'), 'skills/test-driven-development');
});

test('classifyTaskType maps doc keywords to documentation', () => {
  assert.equal(classifyTaskType('Update the docs for this endpoint'), 'skills/documentation');
  assert.equal(classifyTaskType('Document the new config option'), 'skills/documentation');
});

test('classifyTaskType maps review keywords to code-review', () => {
  assert.equal(classifyTaskType('Review the changes before merging'), 'skills/code-review');
});

test('classifyTaskType maps feature keywords to add-feature', () => {
  assert.equal(classifyTaskType('Add a feature for CSV export'), 'skills/add-feature');
});

test('classifyTaskType returns null for a title with no recognisable keyword', () => {
  assert.equal(classifyTaskType('Update the config value'), null);
});

test('classifyTaskType is case-insensitive', () => {
  assert.equal(classifyTaskType('FIX THE BUG IN PARSER'), 'skills/systematic-debugging');
});

test('classifyTaskType does not false-positive on substrings (doc inside docker, test inside latest/contest)', () => {
  assert.equal(classifyTaskType('Update the docker config'), null);
  assert.equal(classifyTaskType('Update the latest changelog'), null);
  assert.equal(classifyTaskType('Add a contest leaderboard feature'), 'skills/add-feature');
});
