// P4.2: the hub's PIN answer carries the public WSS URL and the front certificate's leaf SPKI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontPin, hubPublicUrl } from '../routes/host-api/http-routes.mjs';

test('frontPin reads only a well-formed sha256 SPKI pin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-pin-'));
  const good = path.join(dir, 'pin');
  fs.writeFileSync(good, 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  assert.equal(frontPin(good), 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  fs.writeFileSync(good, 'sha256:short\n');
  assert.equal(frontPin(good), null);
  assert.equal(frontPin(path.join(dir, 'missing')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hubPublicUrl accepts only the v1 WSS path', () => {
  assert.equal(hubPublicUrl('wss://hub.example.com/host-api/v1'), 'wss://hub.example.com/host-api/v1');
  assert.equal(hubPublicUrl('wss://hub.example.com:8443/host-api/v1'), 'wss://hub.example.com:8443/host-api/v1');
  for (const bad of ['https://hub.example.com/host-api/v1', 'wss://hub.example.com/other', 'wss://hub.example.com/host-api/v1?x']) {
    assert.equal(hubPublicUrl(bad), null, bad);
  }
});
