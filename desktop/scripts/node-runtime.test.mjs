import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PIN, hostTarget, nodeFileName, pinFor, shasumFor, verifyHashes } from './node-runtime.mjs';

const H = 'a'.repeat(64);

test('every pinned target has a well-formed sha256, a file named for the version, and the four ship targets exist', () => {
  for (const t of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) {
    const e = pinFor(t);
    assert.match(e.sha256, /^[0-9a-f]{64}$/, t);
    assert.ok(e.file.startsWith(`node-v${PIN.version}-`), t);
    assert.ok(/\.(tar\.gz|zip)$/.test(e.file), t);
  }
  assert.throws(() => pinFor('freebsd-x64'), /no pinned Node runtime/);
  assert.match(PIN.version, /^22\.\d+\.\d+$/, 'better-sqlite3 13 needs node >= 22; LTS line is 22');
});

test('shasumFor reads the published line for exactly that file', () => {
  const body = `${H}  node-v1-darwin-arm64.tar.gz\n${'b'.repeat(64)}  node-v1-win-x64.zip\n${'c'.repeat(64)} *node-v1-linux-x64.tar.gz\n`;
  assert.equal(shasumFor(body, 'node-v1-win-x64.zip'), 'b'.repeat(64));
  assert.equal(shasumFor(body, 'node-v1-linux-x64.tar.gz'), 'c'.repeat(64));
  assert.equal(shasumFor(body, 'node-v1-darwin-x64.tar.gz'), null);
  assert.equal(shasumFor('garbage', 'x'), null);
});

test('verifyHashes fails closed on any mismatch or a missing published line', () => {
  const ok = { file: 'f', actual: H, pinned: H, published: H };
  assert.doesNotThrow(() => verifyHashes(ok));
  assert.throws(() => verifyHashes({ ...ok, actual: 'b'.repeat(64) }), /does not match the pinned/);
  assert.throws(() => verifyHashes({ ...ok, published: 'b'.repeat(64) }), /differs from nodejs.org/);
  assert.throws(() => verifyHashes({ ...ok, published: null }), /not listed/);
});

test('node file name per target and host target format', () => {
  assert.equal(nodeFileName('win32-x64'), 'node.exe');
  assert.equal(nodeFileName('darwin-arm64'), 'node');
  assert.equal(hostTarget(), `${process.platform}-${process.arch}`);
});
