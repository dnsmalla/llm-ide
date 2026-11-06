// Unit tests for scripts/graphkit-pin-check.mjs: the pure parsing, comparison
// and rewrite functions, over fixture strings (no git, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePins,
  parseGitlink,
  parseLsRemote,
  pinIsRemoteTip,
  classifyGhProbe,
  classifyShaFetch,
  decideOnline,
  GRAPHKIT_URL,
  SUBMODULE_PATH,
} from '../../scripts/graphkit-pin-check.mjs';

const SHA_A = 'b9235ddfa50c890ae3243fbbada29191b8f1b38f';
const SHA_B = '1ec4949b1ee8d56c17985e9988fb3570e08a14a2';

test('parseGitlink reads the sha of a mode-160000 index entry', () => {
  const out = `160000 ${SHA_A} 0\tgraph-kit\n`;
  assert.equal(parseGitlink(out), SHA_A);
});

test('parseGitlink ignores non-gitlink entries and returns null when absent', () => {
  assert.equal(parseGitlink(`100644 ${SHA_A} 0\tgraph-kit\n`), null);
  assert.equal(parseGitlink(''), null);
});

test('the submodule lives at the repo top level', () => {
  assert.equal(SUBMODULE_PATH, 'graph-kit');
});

test('comparePins passes with a gitlink and fails without one', () => {
  assert.deepEqual(comparePins({ gitlink: SHA_A }).problems, []);
  assert.ok(comparePins({ gitlink: null }).problems.some((p) => /gitlink/.test(p)));
});

test('parseLsRemote reads sha and ref pairs and pinIsRemoteTip matches tips and peeled tags', () => {
  const text = [
    `${SHA_A}\trefs/heads/main`,
    `${SHA_B}\trefs/tags/1.0.0`,
    '4f15e3a81be9a0bd288aeb559edfb0e25fdd7418\trefs/tags/1.4.0^{}',
    'garbage line',
    '',
  ].join('\n');
  const refs = parseLsRemote(text);
  assert.equal(refs.length, 3);
  assert.equal(pinIsRemoteTip(SHA_A, refs), true);
  assert.equal(pinIsRemoteTip(SHA_B, refs), true);
  assert.equal(pinIsRemoteTip('4f15e3a81be9a0bd288aeb559edfb0e25fdd7418', refs), true);
  assert.equal(pinIsRemoteTip('0'.repeat(40), refs), false);
});

test('classifyShaFetch: success is present, the server "not our ref" is absent, anything else unknown', () => {
  assert.equal(classifyShaFetch({ ok: true }), 'present');
  assert.equal(
    classifyShaFetch({ ok: false, stderr: 'fatal: remote error: upload-pack: not our ref ' + SHA_A }),
    'absent',
  );
  assert.equal(classifyShaFetch({ ok: false, stderr: 'fatal: unable to access: Could not resolve host' }), 'unknown');
  assert.equal(classifyShaFetch({ ok: false, stderr: '' }), 'unknown');
});

test('classifyGhProbe: 200 is present, 404 is absent, missing gh is skipped, other errors unknown', () => {
  assert.equal(classifyGhProbe({ ok: true }), 'present');
  assert.equal(classifyGhProbe({ ok: false, stderr: 'gh: Not Found (HTTP 404)' }), 'absent');
  assert.equal(classifyGhProbe({ ok: false, missing: true }), 'skipped');
  assert.equal(classifyGhProbe({ ok: false, stderr: 'HTTP 403: rate limit exceeded' }), 'unknown');
});

test('decideOnline: a branch or tag tip passes without probing', () => {
  const r = decideOnline({ sha: SHA_A, remoteRefs: [{ sha: SHA_A, ref: 'refs/heads/main' }] });
  assert.deepEqual(r, { problems: [], warnings: [] });
});

test('decideOnline: a non-tip sha the remote serves passes (submodule fetch or GitHub API)', () => {
  const refs = [{ sha: SHA_B, ref: 'refs/heads/main' }];
  assert.deepEqual(decideOnline({ sha: SHA_A, remoteRefs: refs, shaProbe: 'present' }).problems, []);
  assert.deepEqual(decideOnline({ sha: SHA_A, remoteRefs: refs, shaProbe: 'unknown', ghProbe: 'present' }).problems, []);
});

test('decideOnline: a definite absent fails with a fix that names both remedies', () => {
  const refs = [{ sha: SHA_B, ref: 'refs/heads/main' }];
  const r = decideOnline({ sha: SHA_A, remoteRefs: refs, shaProbe: 'absent', ghProbe: 'absent', fetchOk: true, hasSub: true });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], new RegExp(`does not exist on ${GRAPHKIT_URL.replace(/\./g, '\\.')}`));
  assert.match(r.problems[0], /push graph-kit/);
  assert.match(r.problems[0], /git submodule update --init/);
  assert.deepEqual(r.warnings, []);
});

test('decideOnline: a remote-ahead, unfetched submodule does not fail when the remote serves the sha', () => {
  // The old shortcut looked only at the stale local origin/main and failed here.
  const refs = [{ sha: SHA_B, ref: 'refs/heads/main' }];
  const r = decideOnline({ sha: SHA_A, remoteRefs: refs, shaProbe: 'present', fetchOk: false, hasSub: true });
  assert.deepEqual(r, { problems: [], warnings: [] });
});

test('decideOnline: an absent submodule with no GitHub answer warns, it does not fail', () => {
  const refs = [{ sha: SHA_B, ref: 'refs/heads/main' }];
  const r = decideOnline({ sha: SHA_A, remoteRefs: refs, shaProbe: 'skipped', ghProbe: 'unknown', hasSub: false });
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not checked out/);
  assert.match(r.warnings[0], /could not confirm/);
});

test('decideOnline: a failed submodule fetch is reported as possibly stale in the warning', () => {
  const refs = [{ sha: SHA_B, ref: 'refs/heads/main' }];
  const r = decideOnline({ sha: SHA_A, remoteRefs: refs, shaProbe: 'unknown', ghProbe: 'unknown', fetchOk: false, hasSub: true });
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings[0], /may be stale/);
});

test('decideOnline: an unreachable remote warns and never fails', () => {
  const r = decideOnline({ sha: SHA_A, remoteRefs: null, remoteError: 'Could not resolve host' });
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings[0], /unreachable.*Could not resolve host/);
});
