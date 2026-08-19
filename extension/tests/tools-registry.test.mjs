import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entries, names, get } from '../llm_agent/tools/registry.mjs';

const EXPECTED_NAMES = [
  'ask-internal', 'ask-subagent', 'web-search', 'fetch-url', 'list-files',
  'read-file', 'find-code', 'search-kb', 'task-list', 'task-create',
  'task-update', 'run-bash', 'project_memory',
];

test('names() lists exactly the 13 handler names, frozen', () => {
  const list = names();
  assert.deepEqual([...list].sort(), [...EXPECTED_NAMES].sort());
  assert.throws(() => { list.push('x'); }, /Cannot add property|object is not extensible/);
});

test('every entry has a valid kind and an execute function', () => {
  for (const entry of entries()) {
    assert.ok(entry.name, 'entry missing name');
    assert.ok(entry.kind === 'read' || entry.kind === 'act', `${entry.name}: bad kind ${entry.kind}`);
    assert.equal(typeof entry.execute, 'function', `${entry.name}: execute is not a function`);
  }
});

test('act entries carry a gate function; read entries do not', () => {
  for (const entry of entries()) {
    if (entry.kind === 'act') assert.equal(typeof entry.gate, 'function', `${entry.name}: act entry missing gate`);
    else assert.equal(entry.gate, undefined, `${entry.name}: read entry should not carry a gate`);
  }
});

test('get() resolves a known name and returns undefined for an unknown one', () => {
  assert.equal(get('run-bash').name, 'run-bash');
  assert.equal(get('does-not-exist'), undefined);
});

test('run-bash and the two task tools are kind:act; everything else is kind:read', () => {
  const actNames = entries().filter((e) => e.kind === 'act').map((e) => e.name).sort();
  assert.deepEqual(actNames, ['run-bash', 'task-create', 'task-update']);
});
