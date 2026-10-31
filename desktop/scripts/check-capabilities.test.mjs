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
  const base = { libRs: readFileSync(join(t, 'src/lib.rs'), 'utf8'), buildRs: readFileSync(join(t, 'build.rs'), 'utf8'), cargoToml: readFileSync(join(t, 'Cargo.toml'), 'utf8'), capabilities };
  assert.deepEqual(check(base), []);
  assert.deepEqual(check({ ...base, product: true }), []);
});

test('core permissions outside the allowlist and unknown permissions fail; allowlisted core passes', () => {
  const base = ['allow-ping', 'allow-thing-two', 'allow-core-status'];
  const withPerm = (p) => ({ ...ok(), capabilities: { 'a.json': cap([...base, p]) } });
  assert.deepEqual(check(withPerm('core:window:allow-start-dragging')), []);
  for (const bad of ['core:window:allow-close', 'core:webview:allow-create-webview-window', 'core:event:allow-listen', 'weird:thing']) {
    assert.ok(check(withPerm(bad)).length, bad);
  }
});

// ---- the spike feature (--product) ----------------------------------------------------------------

const spikeLib = `macro_rules! product_handlers { ($($spike:path),* $(,)?) => { tauri::generate_handler![ pty::thing_two, core_host::core_status, $($spike),* ] }; }
#[cfg(feature = "spike")]
macro_rules! app_handler { () => { product_handlers![ ping, bench::bench ] }; }
#[cfg(not(feature = "spike"))]
macro_rules! app_handler { () => { product_handlers![] }; }`;
const spikeBuild = `const COMMANDS: &[&str] = &["ping", "bench", "thing_two", "core_status"];
fn main() { if std::env::var_os("CARGO_FEATURE_SPIKE").is_none() { attrs.capabilities_path_pattern("./capabilities/default.json"); } }`;
const cargo = '[package]\nname = "x"\n\n[features]\nspike = []\n\n[dependencies]\n';
const spikeTree = () => ({
  libRs: spikeLib,
  buildRs: spikeBuild,
  cargoToml: cargo,
  capabilities: { 'default.json': cap(['allow-thing-two', 'allow-core-status']), 'spike.json': cap(['allow-ping', 'allow-bench']) },
});

test('--product: the spike commands live only behind the spike feature and spike.json', () => {
  assert.deepEqual(check(spikeTree()), []);
  assert.deepEqual(check({ ...spikeTree(), product: true }), []);
});
test('--product fails when `spike` is a default cargo feature, or Cargo.toml is unreadable', () => {
  for (const toml of ['[features]\ndefault = ["spike"]\nspike = []\n', '[features]\nspike = []\ndefault = ["a", "spike"]\n']) {
    assert.ok(check({ ...spikeTree(), cargoToml: toml, product: true }).some((p) => p.includes('default feature')), toml);
  }
  assert.deepEqual(check({ ...spikeTree(), cargoToml: '[features]\ndefault = []\nspike = []\n[dependencies]\nx = "1"\n', product: true }), []);
  assert.ok(check({ ...spikeTree(), cargoToml: undefined, product: true }).some((p) => p.includes('Cargo.toml')));
});
test('--product fails when build.rs does not gate the capability embedding on the feature', () => {
  const t = { ...spikeTree(), buildRs: 'const COMMANDS: &[&str] = &["ping", "bench", "thing_two", "core_status"]; fn main() {}', product: true };
  assert.ok(check(t).some((p) => p.includes('CARGO_FEATURE_SPIKE')));
});
test('--product fails when a non-spike capability grants a spike command, or spike.json is the only grant of an always-on one', () => {
  const t = spikeTree();
  t.capabilities['default.json'] = cap(['allow-thing-two', 'allow-core-status', 'allow-bench']);
  assert.ok(check({ ...t, product: true }).some((p) => p.includes('spike command bench is granted by a non-spike capability')));
  const u = spikeTree();
  u.capabilities['default.json'] = cap(['allow-thing-two']);
  u.capabilities['spike.json'] = cap(['allow-ping', 'allow-bench', 'allow-core-status']);
  assert.ok(check(u).some((p) => p.includes('core_status') && p.includes('only spike.json')));
});
test('a command registered in the always-on list but granted only by spike.json is caught', () => {
  const t = { ...spikeTree(), libRs: spikeLib.replace('pty::thing_two,', 'pty::thing_two, bench::bench,') };
  assert.ok(check({ ...t, product: true }).some((p) => p.includes('only spike.json grants it')));
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
    // --product also needs Cargo.toml and the build.rs gate
    writeFileSync(join(tauri, 'Cargo.toml'), '[features]\ndefault = ["spike"]\nspike = []\n');
    assert.equal(run('--product').status, 1);
    writeFileSync(join(tauri, 'Cargo.toml'), '[features]\nspike = []\n');
    writeFileSync(join(tauri, 'build.rs'), buildRs + ' // CARGO_FEATURE_SPIKE capabilities_path_pattern');
    assert.equal(run('--product').status, 0, run('--product').stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
