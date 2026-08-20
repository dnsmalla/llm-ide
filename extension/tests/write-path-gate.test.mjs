// Containment gate for native Edit/Write on the v2 engine: 'prompt' only when
// the target resolves inside an allowed root; symlink and `..` escapes are
// 'blocked' — never promptable, never always-allowable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePathGate } from '../llm_agent/tools/gates.mjs';

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wpg-'));
  const workspace = path.join(base, 'workspace');
  const extra = path.join(base, 'extra');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(extra, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.txt'), 'hello');
  // A symlink INSIDE the workspace that points OUTSIDE it.
  fs.symlinkSync(outside, path.join(workspace, 'link-out'), 'dir');
  return { base, workspace, extra, outside };
}

test('existing file inside the workspace prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.workspace, 'src', 'a.txt'), [f.workspace]), 'prompt');
});

test('new file in an existing directory inside the workspace prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.workspace, 'src', 'new.txt'), [f.workspace]), 'prompt');
});

test('relative path resolves against the first root and prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate('src/new.txt', [f.workspace]), 'prompt');
});

test('a target under an additional directory prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.extra, 'notes.md'), [f.workspace, f.extra]), 'prompt');
});

test('.. traversal out of the workspace is blocked', () => {
  const f = makeFixture();
  assert.equal(writePathGate('../outside/evil.txt', [f.workspace]), 'blocked');
});

test('an absolute path outside every root is blocked', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.outside, 'evil.txt'), [f.workspace, f.extra]), 'blocked');
});

test('a symlink escape is blocked even though the lexical path is inside', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.workspace, 'link-out', 'evil.txt'), [f.workspace]), 'blocked');
});

test('empty, non-string, or missing roots are blocked', () => {
  const f = makeFixture();
  assert.equal(writePathGate('', [f.workspace]), 'blocked');
  assert.equal(writePathGate(null, [f.workspace]), 'blocked');
  assert.equal(writePathGate('a.txt', []), 'blocked');
});
