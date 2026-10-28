// Unit tests for scripts/graphkit-pin-check.mjs: the pure parsing, comparison
// and rewrite functions, over fixture strings (no git, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePins,
  parseGitlink,
  parseLsRemote,
  parseResolvedPin,
  parseSwiftPins,
  pinIsRemoteTip,
  rewriteSwiftPin,
  GRAPHKIT_URL,
} from '../../scripts/graphkit-pin-check.mjs';

const SHA_A = 'b9235ddfa50c890ae3243fbbada29191b8f1b38f';
const SHA_B = '1ec4949b1ee8d56c17985e9988fb3570e08a14a2';

const swiftFixture = (sha, extra = '') =>
  [
    'let package = Package(',
    '    dependencies: [',
    '        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),',
    `        .package(url: "https://github.com/dnsmalla/graph-kit.git", revision: "${sha}")${extra},`,
    '    ] + sharedProtocolPackage,',
    ')',
    '',
  ].join('\n');

const resolvedFixture = (sha, location = GRAPHKIT_URL) =>
  JSON.stringify({
    pins: [
      {
        identity: 'sparkle',
        kind: 'remoteSourceControl',
        location: 'https://github.com/sparkle-project/Sparkle.git',
        state: { revision: 'ac2def288cbff5cfc7df3ffef6abdf45b72bcb0a', version: '2.9.6' },
      },
      { identity: 'graph-kit', kind: 'remoteSourceControl', location, state: { revision: sha } },
    ],
    version: 3,
  });

test('parseGitlink reads the sha of a mode-160000 index entry', () => {
  const out = `160000 ${SHA_A} 0\tmac/LocalPackages/graph-kit\n`;
  assert.equal(parseGitlink(out), SHA_A);
});

test('parseGitlink ignores non-gitlink entries and returns null when absent', () => {
  assert.equal(parseGitlink(`100644 ${SHA_A} 0\tmac/LocalPackages/graph-kit\n`), null);
  assert.equal(parseGitlink(''), null);
});

test('parseSwiftPins finds the graph-kit revision and ignores other packages', () => {
  assert.deepEqual(parseSwiftPins(swiftFixture(SHA_A)), [SHA_A]);
  assert.deepEqual(parseSwiftPins('.package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0")'), []);
});

test('parseSwiftPins reports every graph-kit pin so duplicates are caught', () => {
  const text = swiftFixture(SHA_A) + swiftFixture(SHA_B);
  assert.deepEqual(parseSwiftPins(text), [SHA_A, SHA_B]);
});

test('parseResolvedPin reads the graph-kit entry by identity', () => {
  assert.deepEqual(parseResolvedPin(resolvedFixture(SHA_A)), { revision: SHA_A, location: GRAPHKIT_URL });
  assert.deepEqual(parseResolvedPin('{"pins":[],"version":3}'), { revision: null, location: null });
});

test('comparePins passes when all three pins agree', () => {
  const r = comparePins({ gitlink: SHA_A, swiftShas: [SHA_A], resolved: parseResolvedPin(resolvedFixture(SHA_A)) });
  assert.deepEqual(r.problems, []);
});

test('comparePins fails when the gitlink disagrees with Package.swift', () => {
  const r = comparePins({ gitlink: SHA_B, swiftShas: [SHA_A], resolved: { revision: SHA_A, location: GRAPHKIT_URL } });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /disagree/);
  assert.match(r.problems[0], new RegExp(SHA_B));
});

test('comparePins fails when Package.resolved lags Package.swift', () => {
  const r = comparePins({ gitlink: SHA_A, swiftShas: [SHA_A], resolved: { revision: SHA_B, location: GRAPHKIT_URL } });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /Package.resolved revision/);
});

test('comparePins fails on a missing gitlink, missing resolved entry, or two Swift pins', () => {
  const noGitlink = comparePins({
    gitlink: null,
    swiftShas: [SHA_A],
    resolved: { revision: SHA_A, location: GRAPHKIT_URL },
  });
  assert.ok(noGitlink.problems.some((p) => /gitlink/.test(p)));
  const noResolved = comparePins({ gitlink: SHA_A, swiftShas: [SHA_A], resolved: { revision: null, location: null } });
  assert.ok(noResolved.problems.some((p) => /no graph-kit entry/.test(p)));
  const twoPins = comparePins({
    gitlink: SHA_A,
    swiftShas: [SHA_A, SHA_B],
    resolved: { revision: SHA_A, location: GRAPHKIT_URL },
  });
  assert.ok(twoPins.problems.some((p) => /exactly one/.test(p)));
});

test('comparePins fails when Package.resolved points at another repository', () => {
  const r = comparePins({
    gitlink: SHA_A,
    swiftShas: [SHA_A],
    resolved: { revision: SHA_A, location: 'https://example.com/fork.git' },
  });
  assert.ok(r.problems.some((p) => /location/.test(p)));
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

test('rewriteSwiftPin replaces only the revision and keeps the rest of the line', () => {
  const out = rewriteSwiftPin(swiftFixture(SHA_A), SHA_B);
  assert.equal(parseSwiftPins(out)[0], SHA_B);
  assert.equal(out, swiftFixture(SHA_B));
});

test('rewriteSwiftPin writes the tag comment and replaces a previous one', () => {
  const tagged = rewriteSwiftPin(swiftFixture(SHA_A), SHA_B, '1.7.0');
  assert.match(tagged, new RegExp(`revision: "${SHA_B}"\\), // graph-kit 1\\.7\\.0`));
  const retagged = rewriteSwiftPin(tagged, SHA_A, '1.7.1');
  assert.match(retagged, /\/\/ graph-kit 1\.7\.1$/m);
  assert.equal(retagged.match(/graph-kit 1\.7\.0/), null);
  const untagged = rewriteSwiftPin(tagged, SHA_A);
  assert.equal(untagged, swiftFixture(SHA_A));
});

test('rewriteSwiftPin refuses malformed input', () => {
  assert.throws(() => rewriteSwiftPin(swiftFixture(SHA_A), 'abc'), /not a full sha/);
  assert.throws(() => rewriteSwiftPin(swiftFixture(SHA_A), SHA_B, 'v1.7'), /not a semver/);
  assert.throws(() => rewriteSwiftPin('no pin here', SHA_B), /exactly one/);
  assert.throws(() => rewriteSwiftPin(swiftFixture(SHA_A) + swiftFixture(SHA_B), SHA_A), /exactly one/);
});
