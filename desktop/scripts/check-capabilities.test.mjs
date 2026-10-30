import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
