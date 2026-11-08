// R-026#1: behind the hub's nginx every socket peer is 127.0.0.1. The throttle must key on the
// rightmost X-Forwarded-For entry (the one nginx appended), only for a loopback peer in hub mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientPeer } from '../server/host-api-listener.mjs';
import { PairingThrottle, LOCKOUT_THRESHOLD } from '../routes/host-api/throttle.mjs';

const req = (xff, peer = '127.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } });

test('hub clientPeer takes the rightmost forwarded address, never the client-supplied left one', () => {
  assert.equal(clientPeer(req('203.0.113.9, 198.51.100.7'), { hub: true }), '198.51.100.7');
  assert.equal(clientPeer(req(undefined), { hub: true }), '127.0.0.1');
  assert.equal(clientPeer(req('not-an-ip'), { hub: true }), '127.0.0.1');
  assert.equal(clientPeer(req('203.0.113.9'), { hub: false }), '127.0.0.1');
  assert.equal(clientPeer(req('203.0.113.9', '10.0.0.5'), { hub: true }), '10.0.0.5');
});

test('two forwarded peers have separate pairing buckets and one cannot lock the other', () => {
  const t = new PairingThrottle();
  const now = 1_000_000;
  const a = clientPeer(req('203.0.113.9, 198.51.100.7'), { hub: true });
  const b = clientPeer(req('203.0.113.9, 198.51.100.8'), { hub: true });
  for (let i = 0; i < LOCKOUT_THRESHOLD; i++) t.failure(a, now);
  assert.equal(t.decision(a, now + 1).kind, 'lockedOut');
  assert.equal(t.decision(b, now + 1).kind, 'allow');
});
