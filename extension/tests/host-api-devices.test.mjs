import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-devices-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const pins = await import('../routes/host-api/pin.mjs');
const { PairingThrottle, peerKey } = await import('../routes/host-api/throttle.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `h1-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'h' }).id;

test('a device token authenticates exactly its device; nothing stores the token', () => {
  const u = user();
  const { deviceId, token } = dev.issueDeviceToken(u, 'web');
  assert.match(deviceId, /^h1-[0-9a-f-]{36}$/);
  assert.ok(token.length >= 40);
  const auth = dev.authenticateDeviceToken(token);
  assert.equal(auth.userId, u);
  assert.equal(auth.deviceId, deviceId);
  assert.deepEqual(auth.scopes, ['host', 'chat', 'approvals']);
  assert.equal(typeof auth.pairedAt, 'number', 'the session can re-check the 90-day lifetime per frame');
  assert.equal(dev.authenticateDeviceToken(token + 'x'), null);
  assert.equal(dev.authenticateDeviceToken(''), null);
  assert.ok(!JSON.stringify(dev.listDevices(u)).includes(token));
  assert.equal(kb.getDb().prepare('SELECT COUNT(*) n FROM host_api_devices WHERE token_hash = ?').get(token).n, 0);
});

test('revoke and idle expiry retire a token', () => {
  const u = user();
  const a = dev.issueDeviceToken(u, 'web', 0);
  assert.equal(dev.authenticateDeviceToken(a.token, dev.MAX_IDLE_MS + 1), null, 'idle too long');
  assert.equal(dev.listDevices(u).length, 0, 'an expired device is forgotten');
  const b = dev.issueDeviceToken(u, 'web');
  assert.equal(dev.revokeDevice(u, b.deviceId), true);
  assert.equal(dev.authenticateDeviceToken(b.token), null);
});

test('a user keeps at most 20 devices, the least recently seen evicted', () => {
  const u = user();
  const first = dev.issueDeviceToken(u, 'd0', 1);
  const issued = [];
  for (let i = 1; i <= 20; i++) issued.push(dev.issueDeviceToken(u, `d${i}`, 1 + i));
  assert.equal(dev.listDevices(u).length, 20);
  assert.ok(!dev.listDevices(u).some((d) => d.deviceId === first.deviceId), 'oldest evicted');
  assert.deepEqual(issued.slice(0, 19).map((d) => d.evicted), Array(19).fill([]), 'nothing evicted under the cap');
  assert.deepEqual(issued[19].evicted, [first.deviceId], 'the evicted id is returned so the gateway can drop its sockets');
  const newest = dev.issueDeviceToken(u, 'd21', 100);
  assert.equal(dev.listDevices(u).length, 20);
  assert.ok(dev.authenticateDeviceToken(newest.token, 101));
});

test('a new device is never evicted, even with an older clock', () => {
  const u = user();
  for (let i = 0; i < 20; i++) dev.issueDeviceToken(u, `d${i}`, 1000 + i);
  const fresh = dev.issueDeviceToken(u, 'late', 5);
  assert.equal(dev.listDevices(u).length, 20);
  const round = dev.authenticateDeviceToken(fresh.token, 6);
  assert.equal(round.userId, u);
  assert.equal(round.deviceId, fresh.deviceId);
  assert.deepEqual(round.scopes, ['host', 'chat', 'approvals']);
});

test('the quick chat id is per user and per project, and must name that project\'s live session', () => {
  const u = user();
  assert.equal(dev.getQuickChatId(u), null);
  const global = chats.createChatSession(u, { title: 'Phone chat', surface: 'any', mode: 'agent' });
  dev.setQuickChatId(u, global.id);
  assert.equal(dev.getQuickChatId(u), global.id);
  assert.equal(dev.getQuickChatId(user()), null, 'another user has no pointer');

  const alpha = chats.createChatSession(u, { title: 'Alpha', surface: 'any', mode: 'agent', projectId: 'p-alpha' });
  dev.setQuickChatId(u, alpha.id, 'p-alpha');
  assert.equal(dev.getQuickChatId(u, 'p-alpha'), alpha.id);
  assert.equal(dev.getQuickChatId(u, 'p-beta'), null);
  // A pointer naming another project's session is refused, not returned.
  dev.setQuickChatId(u, alpha.id, 'p-beta');
  assert.equal(dev.getQuickChatId(u, 'p-beta'), null);
  // A deleted session makes its pointer stale.
  chats.deleteChatSession(u, global.id);
  assert.equal(dev.getQuickChatId(u), null);
});

test('a PIN is six digits, one-use, per user and expires', () => {
  pins.__resetPinsForTest();
  const { pin } = pins.mintPin('u1', 0);
  assert.match(pin, /^[0-9]{6}$/);
  assert.equal(pins.consumePin('000000x', 1), null);
  assert.equal(pins.consumePin(pin, 1), 'u1');
  assert.equal(pins.consumePin(pin, 2), null, 'one use');
  const late = pins.mintPin('u2', 0).pin;
  assert.equal(pins.consumePin(late, pins.PIN_TTL_MS + 1), null, 'expired');
  const old = pins.mintPin('u3', 0).pin;
  const fresh = pins.mintPin('u3', 1).pin;
  assert.notEqual(old, fresh);
  assert.equal(pins.consumePin(old, 2), null, 'a new PIN replaces the old one');
});

// Constants follow mac PairingThrottle.swift: lockout after 8 failures, server-wide budget 40.
test('the throttle locks a peer out after repeated failures and has a server-wide budget', () => {
  const t = new PairingThrottle();
  for (let i = 0; i < 8; i++) {
    assert.notEqual(t.decision('p', i * 200_000).kind, 'lockedOut');
    t.failure('p', i * 200_000);
  }
  assert.equal(t.decision('p', 7 * 200_000 + 1000).kind, 'lockedOut');
  assert.equal(t.decision('p', 7 * 200_000 + 15 * 60_000 + 1).kind, 'allow', 'lockout ends');
  t.success('q');
  const s = new PairingThrottle();
  s.success('paired');
  for (let i = 0; i < 40; i++) s.failure(`peer-${i}`, 0);
  assert.equal(s.decision('fresh', 1).kind, 'serverThrottled');
  assert.equal(s.decision('paired', 1).kind, 'allow', 'a paired peer is exempt');
});

test('peers key by IPv6 /64, IPv4-mapped as IPv4, IPv4 unchanged', () => {
  assert.equal(peerKey('fe80::1'), peerKey('FE80:0000::2'));
  assert.equal(peerKey('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(peerKey('10.0.0.5'), '10.0.0.5');
  assert.notEqual(peerKey('fe80::1'), peerKey('fe81::1'));
  const t = new PairingThrottle();
  for (let i = 0; i < 8; i++) t.failure(`2001:db8:1:2::${i + 1}`, 0);
  assert.equal(t.decision('2001:db8:1:2:aaaa::9', 1000).kind, 'lockedOut');
});
