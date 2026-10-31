import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from './check-capabilities.mjs';

const libRs = 'tauri::generate_handler![ping, pty::thing_two, core_host::core_status]';
const buildRs = 'const COMMANDS: &[&str] = &["ping", "thing_two", "core_status"];';
const cap = (permissions, extra = {}) => ({ windows: ['main'], permissions, ...extra });
const ok = () => ({ libRs, buildRs, capabilities: { 'a.json': cap(['allow-ping', 'allow-thing-two', 'allow-core-status']) } });

test('complete least-privilege set passes', () => assert.deepEqual(check(ok()), []));
test('wildcard, core:default and fs permissions fail', () => {
  for (const bad of ['fs:*', 'core:default', 'shell:allow-execute', 'opener:default']) {
    const c = ok(); c.capabilities['a.json'].permissions.push(bad);
    assert.ok(check(c).length, bad);
  }
});
test('ungranted or undeclared command fails', () => {
  const a = ok(); a.capabilities['a.json'].permissions.pop();
  assert.ok(check(a).some((p) => p.includes('core_status')));
  const b = { ...ok(), buildRs: 'const COMMANDS: &[&str] = &["ping"];' };
  assert.ok(check(b).some((p) => p.includes('not in build.rs')));
});
test('remote scope and other windows fail', () => {
  assert.ok(check({ ...ok(), capabilities: { 'a.json': cap(['allow-ping', 'allow-thing-two', 'allow-core-status'], { remote: { urls: ['https://x'] } }) } }).length);
  assert.ok(check({ ...ok(), capabilities: { 'a.json': { ...cap(['allow-ping', 'allow-thing-two', 'allow-core-status']), windows: ['*'] } } }).length);
});
test('the real repo config passes', () => {
  const t = join(import.meta.dirname, '..', 'src-tauri');
  const capabilities = Object.fromEntries(['default.json', 'spike.json'].map((f) => [f, JSON.parse(readFileSync(join(t, 'capabilities', f), 'utf8'))]));
  assert.deepEqual(check({ libRs: readFileSync(join(t, 'src/lib.rs'), 'utf8'), buildRs: readFileSync(join(t, 'build.rs'), 'utf8'), capabilities }), []);
});

test('core permissions outside the allowlist and unknown permissions fail; allowlisted core passes', () => {
  const base = ['allow-ping', 'allow-thing-two', 'allow-core-status'];
  const withPerm = (p) => ({ ...ok(), capabilities: { 'a.json': cap([...base, p]) } });
  assert.deepEqual(check(withPerm('core:window:allow-start-dragging')), []);
  for (const bad of ['core:window:allow-close', 'core:webview:allow-create-webview-window', 'core:event:allow-listen', 'weird:thing']) {
    assert.ok(check(withPerm(bad)).length, bad);
  }
});

test('--product fails while spike.json exists', () => {
  const c = ok();
  assert.deepEqual(check({ ...c, product: true }), []);
  c.capabilities['spike.json'] = cap([]);
  assert.ok(check(c).length === 0);
  assert.ok(check({ ...c, product: true }).some((p) => p.includes('spike.json')));
});

test('a #[cfg]-gated handler fails loudly; comments in the handler list are ignored', () => {
  const gated = { ...ok(), libRs: 'tauri::generate_handler![ping, #[cfg(target_os = "macos")] pty::thing_two, core_host::core_status]' };
  assert.ok(check(gated).some((p) => p.includes('#[cfg]')));
  const commented = { ...ok(), libRs: 'tauri::generate_handler![ping, // note: not_a_command\n pty::thing_two, core_host::core_status]' };
  assert.deepEqual(check(commented), []);
  assert.ok(check({ ...ok(), libRs: 'no handler here' }).length);
});

// The CLI must actually fail (exit 1) on a bad tree, including from a directory whose path
// has spaces: the old `import.meta.url === file://argv[1]` guard was false there and the
// script exited 0 without checking anything.
test('the CLI exits 1 on a bad tree and 0 on a good one, from a path with spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap check '));
  try {
    const scripts = join(root, 'my desktop', 'scripts');
    const tauri = join(root, 'my desktop', 'src-tauri');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(tauri, 'src'), { recursive: true });
    mkdirSync(join(tauri, 'capabilities'), { recursive: true });
    copyFileSync(join(import.meta.dirname, 'check-capabilities.mjs'), join(scripts, 'check-capabilities.mjs'));
    writeFileSync(join(tauri, 'src', 'lib.rs'), libRs);
    writeFileSync(join(tauri, 'build.rs'), buildRs);
    const capFile = join(tauri, 'capabilities', 'default.json');
    writeFileSync(capFile, JSON.stringify(cap(['allow-ping', 'allow-thing-two', 'allow-core-status'])));
    const run = (...a) => spawnSync(process.execPath, [join(scripts, 'check-capabilities.mjs'), ...a], { encoding: 'utf8' });
    assert.equal(run().status, 0, run().stderr);
    writeFileSync(capFile, JSON.stringify(cap(['allow-ping', 'allow-thing-two', 'allow-core-status', 'fs:default'])));
    assert.equal(run().status, 1);
    writeFileSync(capFile, JSON.stringify(cap(['allow-ping', 'allow-thing-two', 'allow-core-status'])));
    writeFileSync(join(tauri, 'capabilities', 'spike.json'), JSON.stringify(cap([])));
    assert.equal(run('--product').status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
