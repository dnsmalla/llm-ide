// desktop/scripts/update-manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, manifestProblems, sha256Sums, PLATFORMS, RELEASE_BASE } from './update-manifest.mjs';

const V = '0.2.0';
const names = ['LLM-IDE_0.2.0_aarch64.app.tar.gz', 'LLM-IDE_0.2.0_x64.app.tar.gz', 'LLM-IDE_0.2.0_x64-setup.exe', 'LLM-IDE_0.2.0_amd64.AppImage'];
const files = [...names, ...names.map((n) => `${n}.sig`), 'LLM-IDE_0.2.0_amd64.deb', 'LLM-IDE_0.2.0_aarch64.dmg'];
const read = (n) => Buffer.from(n.endsWith('.sig') ? `SIG:${n}`.padEnd(120, '=') : `BODY:${n}`);
const okVerify = () => ({ ok: true });

test('every platform gets its url and signature text', () => {
  const { manifest, problems } = buildManifest({ version: V, notes: 'n', pubDate: '2026-11-05T00:00:00Z', files, read, pubkey: 'k', verifySig: okVerify });
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), PLATFORMS.map((p) => p.key).sort());
  assert.equal(manifest.platforms['windows-x86_64'].url, `${RELEASE_BASE}desktop-v0.2.0/LLM-IDE_0.2.0_x64-setup.exe`);
  assert.equal(manifest.platforms['linux-x86_64'].signature, 'SIG:LLM-IDE_0.2.0_amd64.AppImage.sig'.padEnd(120, '='));
  assert.deepEqual(manifestProblems(manifest, V), []);
});

test('a missing platform, a missing sig or a failed verification is a problem', () => {
  const drop = files.filter((f) => !f.startsWith('LLM-IDE_0.2.0_x64-setup.exe'));
  assert.match(buildManifest({ version: V, notes: '', pubDate: 'x', files: drop, read, pubkey: 'k', verifySig: okVerify }).problems.join(), /windows-x86_64/);
  const noSig = files.filter((f) => f !== 'LLM-IDE_0.2.0_amd64.AppImage.sig');
  assert.match(buildManifest({ version: V, notes: '', pubDate: 'x', files: noSig, read, pubkey: 'k', verifySig: okVerify }).problems.join(), /AppImage\.sig/);
  const bad = () => ({ ok: false, reason: 'bad signature' });
  assert.match(buildManifest({ version: V, notes: '', pubDate: 'x', files, read, pubkey: 'k', verifySig: bad }).problems.join(), /bad signature/);
});

test('manifestProblems refuses a wrong version, http, another repo or tag, and an empty signature', () => {
  const { manifest } = buildManifest({ version: V, notes: '', pubDate: 'x', files, read, pubkey: 'k', verifySig: okVerify });
  assert.match(manifestProblems(manifest, '0.3.0').join(), /version/);
  const m = structuredClone(manifest);
  m.platforms['darwin-aarch64'].url = 'http://evil.example/x';
  m.platforms['linux-x86_64'].signature = '';
  m.platforms['windows-x86_64'].url = `${RELEASE_BASE}desktop-v0.1.0/x.exe`;
  const p = manifestProblems(m, V).join('\n');
  assert.match(p, /darwin-aarch64/); assert.match(p, /linux-x86_64/); assert.match(p, /windows-x86_64/);
});

test('SHA256SUMS lists every non-sig file, sorted, sha256sum format', () => {
  const out = sha256Sums(['b.deb', 'a.dmg', 'a.dmg.sig'], (n) => Buffer.from(n));
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^[0-9a-f]{64} {2}a\.dmg$/);
  assert.match(lines[1], /^[0-9a-f]{64} {2}b\.deb$/);
});

test('the default verifier is wired in: an invalid key makes every platform a problem', () => {
  const { problems } = buildManifest({ version: V, notes: '', pubDate: 'x', files, read, pubkey: 'k' });
  for (const p of PLATFORMS) assert.match(problems.join('\n'), new RegExp(p.key));
});
