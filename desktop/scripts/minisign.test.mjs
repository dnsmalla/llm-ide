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
  // --ci: no prompt; empty password.
  execFileSync(CLI, ['signer', 'generate', '--ci', '-p', '', '-w', key], { stdio: 'pipe', shell: process.platform === 'win32' });
  return { key, pub: readFileSync(`${key}.pub`, 'utf8').trim() };
}
function sign(file, key) {
  execFileSync(CLI, ['signer', 'sign', '-f', key, '-p', '', file], { stdio: 'pipe', shell: process.platform === 'win32' });
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
