// The legacy loop's phase:'tool' progress event names the subagent an
// ask-subagent call runs (API v71) — `detail` is only the question.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolProgressEvent } from '../llm_agent/runtime/loop.mjs';

test('ask-subagent progress carries subagent: <name>', () => {
  const ev = toolProgressEvent('ask-subagent', { name: 'reviewer', question: 'check this' }, 2);
  assert.equal(ev.phase, 'tool');
  assert.equal(ev.tool, 'ask-subagent');
  assert.equal(ev.subagent, 'reviewer');
  assert.equal(ev.iteration, 2);
});

test('other tools carry no subagent field', () => {
  const ev = toolProgressEvent('read-file', { path: 'a.swift' }, 1);
  assert.equal('subagent' in ev, false);
});

test('ask-subagent without a string name omits the field', () => {
  assert.equal('subagent' in toolProgressEvent('ask-subagent', { question: 'q' }, 1), false);
});
