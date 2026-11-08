// C5: the shared `devicePolicy` vector is executable by every client, not only a snapshot of numbers. Node's
// shipped policy module and the independent reference device both read schema/sync/v1/vectors/v1.json directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_TOKEN_MAX_LIFETIME_MS, MANIFEST_STALE_AFTER_MS, deviceTokenState, manifestState } from '../core/device-lifetime.mjs';
import { STALE_MANIFEST_MS, manifestState as referenceManifestState } from './helpers/sync-reference.mjs';

const vector = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url)));
const policy = vector.devicePolicy;

test('the shared devicePolicy vector pins the manifest grace and the device-token lifetime', () => {
  assert.equal(policy.manifest.staleAfterMs, MANIFEST_STALE_AFTER_MS, 'Node and the vector agree on 7 days');
  assert.equal(policy.manifest.staleAfterMs, STALE_MANIFEST_MS, 'the independent reference agrees on 7 days');
  assert.equal(policy.deviceToken.maxLifetimeMs, DEVICE_TOKEN_MAX_LIFETIME_MS, 'Node and the vector agree on 90 days');
  assert.equal(DEVICE_TOKEN_MAX_LIFETIME_MS, 90 * 86_400_000);
});

test('every manifest case: fresh inside validUntil, withheld after it, stale_manifest past the grace', () => {
  for (const c of policy.manifest.cases) {
    assert.equal(manifestState(policy.manifest.validUntil, c.nowMs), c.expect, `manifest ${c.name}`);
    assert.equal(referenceManifestState(policy.manifest.validUntil, c.nowMs), c.expect, `reference manifest ${c.name}`);
  }
});

test('every device-token case: live through exactly 90 days, expired by 1 ms after', () => {
  for (const c of policy.deviceToken.cases) {
    assert.equal(deviceTokenState(policy.deviceToken.pairedAt, c.nowMs), c.expect, `token ${c.name}`);
  }
});
