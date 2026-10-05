import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, versionsDiffer, upstreamTier, pickInstalledEntry } from '../plugins/plugin-version.mjs';
import { semverNewer } from '../plugins/vendor-import-shared.mjs';

test('semver ordering is numeric, not lexicographic', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
  assert.equal(isNewer('2.0.0', '2.0.0-beta.1'), true);
  assert.equal(semverNewer('1.10.0', '1.9.0'), true);
});

test('SHA versions compare by prefix', () => {
  assert.equal(versionsDiffer('d182ca456ca0', 'd182ca456ca09d31d139f7d3818d1d333b103cce'), false);
  assert.equal(versionsDiffer('d182ca456ca0', '1390c811e039'), true);
  assert.equal(versionsDiffer('1.0.0', '1.0.0'), false);
});

test('upstream tier rules', () => {
  assert.equal(upstreamTier({ installedVersion: '1.0.0', available: { version: '1.1.0' } }), 'upstream');
  assert.equal(upstreamTier({ installedVersion: '1.1.0', available: { version: '1.1.0' } }), null);
  assert.equal(upstreamTier({ installedVersion: 'abc1234', available: { version: 'def5678' } }), 'upstream');
  assert.equal(upstreamTier({ installedVersion: '1390c811e039', available: { source: { source: 'url', sha: '1390c811e03922b8' } } }), null);
  assert.equal(upstreamTier({ installedVersion: '1390c811e039', available: { source: { source: 'url', sha: 'ffff0000aaaa' } } }), 'upstream');
  assert.equal(upstreamTier({ installedVersion: 'd182ca456ca0', available: { source: './plugins/x' } }), null);
});

test('picks the entry matching the imported scope', () => {
  const inst = [
    { id: 'a@mp', scope: 'project', installPath: '/proj' },
    { id: 'a@mp', scope: 'user', installPath: '/user' },
  ];
  assert.equal(pickInstalledEntry(inst, 'a@mp', 'project').installPath, '/proj');
  assert.equal(pickInstalledEntry(inst, 'a@mp').installPath, '/user');
  assert.equal(pickInstalledEntry(inst, 'b@mp'), null);
});
