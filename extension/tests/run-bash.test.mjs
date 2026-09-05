import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBashCwd, handleRunBash } from '../llm_agent/runtime/handlers/run-bash.mjs';

// A model-supplied `cwd` relocates the command. Before containment existed,
// `{ cwd: "/Users/me/.aws", command: "cat credentials" }` ran a gate-approved
// command on a file the gate never saw.

let tmp;
let workspace;
let outside;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bash-cwd-'));
  workspace = path.join(tmp, 'workspace');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET\n');
  fs.writeFileSync(path.join(workspace, 'sub', 'ok.txt'), 'OK\n');
  // A symlink inside the workspace that points outside it.
  fs.symlinkSync(outside, path.join(workspace, 'escape'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('no cwd arg: workspace root, else home', () => {
  assert.equal(resolveBashCwd({}, { workspaceRoot: workspace }).cwd, workspace);
  assert.equal(resolveBashCwd({ command: 'ls' }, {}).cwd, os.homedir());
});

test('a relative cwd resolves against the workspace, not the server process cwd', () => {
  const r = resolveBashCwd({ cwd: 'sub' }, { workspaceRoot: workspace });
  assert.equal(r.cwd, path.join(workspace, 'sub'));
});

test('a cwd that escapes the workspace is refused', () => {
  for (const cwd of ['..', '../outside', outside, path.join(workspace, '..', 'outside'), '/']) {
    const r = resolveBashCwd({ cwd }, { workspaceRoot: workspace });
    assert.ok(r.error, `expected error for cwd=${cwd}`);
    assert.equal(r.cwd, undefined);
  }
});

test('a symlink inside the workspace that points outside is refused (realpath containment)', () => {
  const r = resolveBashCwd({ cwd: 'escape' }, { workspaceRoot: workspace });
  assert.ok(r.error);
});

test('a non-existent cwd is refused rather than guessed', () => {
  const r = resolveBashCwd({ cwd: 'does-not-exist' }, { workspaceRoot: workspace });
  assert.ok(r.error);
});

test('a cwd that is a file, not a directory, is refused up front', () => {
  const r = resolveBashCwd({ cwd: 'sub/ok.txt' }, { workspaceRoot: workspace });
  assert.ok(r.error);
});

test('a model-supplied cwd with no workspace is refused — nothing to contain it in', () => {
  // Previously resolved against $HOME with no containment, so
  // `{ cwd: ".config/gh", command: "cat hosts.yml" }` ran in ~/.config/gh.
  for (const cwd of ['.', '.config/gh', 'Library/Keychains', outside]) {
    const r = resolveBashCwd({ cwd }, {});
    assert.ok(r.error, `expected error for cwd=${cwd}`);
  }
});

test('handleRunBash does not execute when the cwd is refused', async () => {
  const marker = path.join(tmp, 'ran.txt');
  const r = await handleRunBash(
    { command: `touch ${marker}`, cwd: outside },
    { workspaceRoot: workspace },
  );
  assert.ok(r.error);
  assert.equal(fs.existsSync(marker), false, 'command must not have run');
});

test('handleRunBash runs inside a contained cwd', async () => {
  const r = await handleRunBash({ command: 'cat ok.txt', cwd: 'sub' }, { workspaceRoot: workspace });
  assert.equal(r.error, undefined);
  assert.equal(r.stdout.trim(), 'OK');
});
