// rollupCodeRefs ref-hygiene + repo allow-list gate.
//
// Absolute refs are how local-repo code is ingested (connectors/git.mjs
// stores `ref: <absPath>`). They must be surfaced to the agent ONLY when
// they live under a repo the user has allow-listed — never an arbitrary
// path a malicious KB row could smuggle to codegen's file reader. `..`
// traversal is always rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rollupCodeRefs } from '../graphkit/graph.mjs';

const row = (ref, extra = {}) => ({ ref, title: `${ref}:1-10`, body: 'x', rank: -1, ...extra });

test('rollupCodeRefs: relative refs pass through', () => {
  const out = rollupCodeRefs([row('src/a.ts'), row('src/b.ts')]);
  assert.deepEqual(out.map((r) => r.ref).sort(), ['src/a.ts', 'src/b.ts']);
});

test('rollupCodeRefs: traversal refs are always rejected', () => {
  const out = rollupCodeRefs([row('../../etc/passwd'), row('a/../../b')], ['/']);
  assert.equal(out.length, 0);
});

test('rollupCodeRefs: absolute ref dropped without an allow-list', () => {
  const out = rollupCodeRefs([row('/Users/me/repo/src/a.ts')]);
  assert.equal(out.length, 0);
});

test('rollupCodeRefs: absolute ref kept when under an allow-listed root', () => {
  const root = `${path.sep}Users${path.sep}me${path.sep}repo`;
  const inside = `${root}${path.sep}src${path.sep}a.ts`;
  const out = rollupCodeRefs([row(inside)], [root]);
  assert.deepEqual(out.map((r) => r.ref), [inside]);
});

test('rollupCodeRefs: absolute ref outside every root is dropped', () => {
  const root = `${path.sep}Users${path.sep}me${path.sep}repo`;
  const out = rollupCodeRefs([row(`${path.sep}etc${path.sep}passwd`)], [root]);
  assert.equal(out.length, 0);
});

test('rollupCodeRefs: sibling prefix is not treated as inside the root', () => {
  // /Users/me/repo-evil must NOT match allow-list root /Users/me/repo
  const root = `${path.sep}Users${path.sep}me${path.sep}repo`;
  const sibling = `${path.sep}Users${path.sep}me${path.sep}repo-evil${path.sep}a.ts`;
  const out = rollupCodeRefs([row(sibling)], [root]);
  assert.equal(out.length, 0);
});

test('rollupCodeRefs: rolls multiple chunks of one file into a single entry', () => {
  const out = rollupCodeRefs([row('src/a.ts'), row('src/a.ts', { rank: -2 })]);
  assert.equal(out.length, 1);
});
