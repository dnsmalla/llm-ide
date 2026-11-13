// A catalog install's own switch never restricts a legacy item of the same kind and name (review R1/R2 of the
// catalog activation): an install is recorded off, and the switches match by kind + name.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { makeGate } = await import('../llm_agent/extensions/gate.mjs');
const overlay = (entries, corrupt = false) => ({ corrupt, items: new Map(entries.map(([id, enabled, disabledMembers = []]) => [id, { enabled, disabledMembers }])) });

test('an installed catalog item that is off (or on) leaves the legacy plugin, MCP server and LLM source of that name alone', () => {
  const o = overlay([['plugin:acme/foo', false], ['mcp:acme/github', false], ['llm-source:acme/kit', false, ['skill:x']]]);
  const g = makeGate('u1', { overlay: o, installedIds: new Set(['plugin:acme/foo', 'mcp:acme/github', 'llm-source:acme/kit']) });
  assert.equal(g.pluginActive('foo'), true);
  assert.equal(g.mcpActive('github'), true);
  assert.equal(g.llmSourceActive('kit'), true);
  assert.equal(g.librarySkillActive('kit', 'x'), true);
  // The catalog item itself is still off until it is switched on.
  assert.equal(g.installedActive('plugin', 'foo'), false);
});

test('a switch that is not a catalog install still restricts the legacy item (nothing else changed)', () => {
  const g = makeGate('u1', { overlay: overlay([['plugin:local/foo', false], ['llm-source:local/kit', true, ['skill:x']]]), installedIds: new Set() });
  assert.equal(g.pluginActive('foo'), false);
  assert.equal(g.librarySkillActive('kit', 'x'), false);
  assert.equal(g.librarySkillActive('kit', 'y'), true);
});

test('an installed item switched on loads; an unreadable switch file still turns everything off', () => {
  const on = makeGate('u1', { overlay: overlay([['skill:acme/tidy', true]]), installedIds: new Set(['skill:acme/tidy']) });
  assert.equal(on.installedActive('skill', 'tidy'), true);
  const closed = makeGate('u1', { overlay: overlay([], true), installedIds: new Set() });
  assert.equal(closed.failClosed, true);
  assert.equal(closed.pluginActive('anything'), false);
});

test('a catalog plugin itself still reads its own switch and unchecked members; the legacy plugin of that name does not', () => {
  const g = makeGate('u1', { overlay: overlay([['plugin:acme/foo', true, ['skill:solo']]]), installedIds: new Set(['plugin:acme/foo']) });
  assert.deepEqual(g.pluginDisabledMembers('foo', true), ['skill:solo']);
  assert.equal(g.pluginMemberActive('foo', 'skill', 'solo', true), false);
  assert.deepEqual(g.pluginDisabledMembers('foo'), []);
  assert.equal(g.pluginMemberActive('foo', 'skill', 'solo'), true);
});
