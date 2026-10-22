// LLMIDE_FEATURES parsing (core/config.mjs#parseFeatures). The Mac app passes
// the same comma-separated ENABLED-feature list it builds with (mac/Package.swift),
// so the server must read it with the same semantics: unset/empty = all
// features, the file_explorer dependency closure applied, agent_chat always on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
// A developer shell may export the Mac's list; this file asserts the default.
delete process.env.LLMIDE_FEATURES;

const { parseFeatures, FEATURE_KEYS, config } = await import('../core/config.mjs');

function collectWarnings() {
  const lines = [];
  return { warn: (line) => lines.push(line), lines };
}

test('parseFeatures: unset or empty means every feature (null)', () => {
  const { warn, lines } = collectWarnings();
  assert.equal(parseFeatures(undefined, warn), null);
  assert.equal(parseFeatures('', warn), null);
  assert.equal(parseFeatures('  ', warn), null);
  assert.deepEqual(lines, [], 'no warning for the default');
});

test('parseFeatures: a list becomes a Set of enabled keys, whitespace trimmed, agent_chat always on', () => {
  const { warn, lines } = collectWarnings();
  const features = parseFeatures('auto_tasks, gantt_issues ,file_explorer', warn);
  assert.ok(features instanceof Set);
  assert.deepEqual([...features].sort(),
    ['agent_chat', 'auto_tasks', 'file_explorer', 'gantt_issues']);
  assert.deepEqual(lines, []);
});

test('parseFeatures: unknown keys are ignored with exactly one warning line', () => {
  const { warn, lines } = collectWarnings();
  const features = parseFeatures('auto_tasks,bogus,also_bogus', warn);
  assert.deepEqual([...features].sort(), ['agent_chat', 'auto_tasks']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /LLMIDE_FEATURES/);
  assert.match(lines[0], /bogus/);
  assert.match(lines[0], /also_bogus/);
});

test('parseFeatures: features that need file_explorer are dropped without it (mac/Package.swift closure)', () => {
  const { warn, lines } = collectWarnings();
  const features = parseFeatures('gantt_issues,code_graph_3d,doc_gen,terminal', warn);
  assert.deepEqual([...features].sort(), ['agent_chat', 'terminal']);
  assert.equal(lines.length, 1, 'the closure drop is visible, once');
  assert.match(lines[0], /file_explorer/);
});

test('parseFeatures: the returned set is read-only', () => {
  const features = parseFeatures('auto_tasks', () => {});
  assert.ok(Object.isFrozen(features));
  assert.throws(() => features.add('gantt_issues'), TypeError);
  assert.throws(() => features.delete('auto_tasks'), TypeError);
  assert.throws(() => features.clear(), TypeError);
  assert.ok(features.has('auto_tasks'));
});

test('FEATURE_KEYS matches the Mac AppFeature raw values', () => {
  assert.deepEqual([...FEATURE_KEYS].sort(), [
    'agent_chat', 'auto_tasks', 'code_graph_3d', 'doc_gen',
    'file_explorer', 'gantt_issues', 'mobile_sync', 'terminal',
  ]);
});

test('config.features is parsed once from the environment (unset here → null)', () => {
  assert.equal(config.features, null);
});
