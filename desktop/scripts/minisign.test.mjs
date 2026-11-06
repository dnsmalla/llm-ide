// desktop/scripts/minisign.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMinisign } from './minisign.mjs';

const CLI = join(import.meta.dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const have = existsSync(CLI);

function keypair(dir, name) {
  const key = join(dir, name);
  // --ci: no prompt. A throwaway non-empty password: on Windows the CLI runs through a shell, which drops an empty '' argument.
  execFileSync(CLI, ['signer', 'generate', '--ci', '-p', 'test-only-pass', '-w', key], { stdio: 'pipe', shell: process.platform === 'win32' });
  return { key, pub: readFileSync(`${key}.pub`, 'utf8').trim() };
}
function sign(file, key) {
  execFileSync(CLI, ['signer', 'sign', '-f', key, '-p', 'test-only-pass', file], { stdio: 'pipe', shell: process.platform === 'win32' });
  return readFileSync(`${file}.sig`, 'utf8').trim();
}

test('a signature made by the Tauri CLI verifies; tampering, another key and garbage do not', { skip: !have && 'desktop/node_modules missing' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'minisign-'));
  const a = keypair(dir, 'a.key');
  const b = keypair(dir, 'b.key');
  const file = join(dir, 'payload.bin');
  writeFileSync(file, Buffer.from('LLM-IDE update payload'));
  const sig = sign(file, a.key);
  const bytes = readFileSync(file);
  assert.deepEqual(verifyMinisign(a.pub, sig, bytes), { ok: true });
  const tampered = Buffer.from(bytes); tampered[0] ^= 1;
  assert.equal(verifyMinisign(a.pub, sig, tampered).ok, false);
  assert.match(verifyMinisign(b.pub, sig, bytes).reason, /key id/);
  assert.equal(verifyMinisign(a.pub, 'not base64 at all', bytes).ok, false);
  assert.equal(verifyMinisign('', sig, bytes).ok, false);
});

const reBox = (sig, edit) => Buffer.from(edit(Buffer.from(sig, 'base64').toString('utf8').split('\n')).join('\n')).toString('base64');

test('a rewritten trusted comment, a missing comment line or non-base64 noise is refused', { skip: !have && 'desktop/node_modules missing' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'minisign-'));
  const a = keypair(dir, 'a.key');
  const file = join(dir, 'payload.bin');
  writeFileSync(file, Buffer.from('LLM-IDE update payload'));
  const sig = sign(file, a.key);
  const bytes = readFileSync(file);
  assert.match(verifyMinisign(a.pub, reBox(sig, (l) => { l[2] = 'trusted comment: forged'; return l; }), bytes).reason, /trusted-comment/);
  assert.equal(verifyMinisign(a.pub, reBox(sig, (l) => { l[0] = 'bogus'; return l; }), bytes).ok, false);
  assert.match(verifyMinisign(a.pub, reBox(sig, (l) => { l[2] = 'timestamp:1'; return l; }), bytes).reason, /trusted-comment/);
  assert.equal(verifyMinisign(a.pub, `${sig}\n!!`, bytes).ok, false);
});
