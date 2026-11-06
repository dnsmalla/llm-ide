// desktop/scripts/release-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { releaseConfig, windowsSignArgs, CHANNEL_URL } from './release-config.mjs';

const W = { signtool: 'C:\\sdk\\x64\\signtool.exe', dlib: 'C:\\as\\bin\\x64\\Azure.CodeSigning.Dlib.dll', metadata: 'C:\\t\\metadata.json' };

test('empty overlay when nothing is asked', () => {
  assert.deepEqual(releaseConfig({}), {});
});

test('windows signCommand: object form, SHA-256, Microsoft timestamp, dlib + metadata, %1 last', () => {
  const c = releaseConfig({ windowsSign: W });
  const sc = c.bundle.windows.signCommand;
  assert.equal(sc.cmd, W.signtool);
  assert.deepEqual(sc.args, ['sign', ...windowsSignArgs(W), '%1']);
  assert.deepEqual(windowsSignArgs(W), ['/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', W.dlib, '/dmdf', W.metadata]);
});

test('missing windows inputs throw instead of producing an unsigned config', () => {
  assert.throws(() => releaseConfig({ windowsSign: { ...W, dlib: '' } }), /dlib/);
});

const KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QKUldTMTIzNDU2Nzg5MAo=';

test('updater overlay: artifacts on, one https channel endpoint, passive Windows install', () => {
  const c = releaseConfig({ updater: { pubkey: KEY } });
  assert.equal(c.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(c.plugins.updater, { pubkey: KEY, endpoints: [CHANNEL_URL], windows: { installMode: 'passive' } });
});

test('windows signing and updater merge into one bundle object', () => {
  const c = releaseConfig({ windowsSign: { signtool: 's', dlib: 'd', metadata: 'm' }, updater: { pubkey: KEY } });
  assert.ok(c.bundle.windows.signCommand);
  assert.equal(c.bundle.createUpdaterArtifacts, true);
});

test('an empty or short pubkey throws', () => {
  assert.throws(() => releaseConfig({ updater: { pubkey: ' ' } }), /pubkey/);
});

test('CHANNEL_URL matches the Rust host constant', () => {
  const rs = readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'src', 'updater.rs'), 'utf8');
  assert.ok(rs.includes(`pub const CHANNEL_URL: &str = "${CHANNEL_URL}";`));
});

test('updater overlay only carries the keys updater.rs config_problem accepts', () => {
  const rs = readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'src', 'updater.rs'), 'utf8');
  assert.ok(rs.includes('"pubkey" | "endpoints" | "windows"'));
  assert.deepEqual(Object.keys(releaseConfig({ updater: { pubkey: KEY } }).plugins.updater).sort(), ['endpoints', 'pubkey', 'windows']);
});

test('CLI reads the pubkey file (throwaway key in a temp dir)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'rc-')), 'updater.pubkey');
  writeFileSync(f, KEY + '\n');
  const out = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, 'release-config.mjs'), '--updater', f]).toString());
  assert.equal(out.plugins.updater.pubkey, KEY);
});
