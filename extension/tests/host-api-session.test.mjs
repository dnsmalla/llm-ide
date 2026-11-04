import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostApiSession, helloRefusal, internalId, parseId, isV1Id } from '../routes/host-api/session.mjs';
import { HOST_API_COMMANDS } from '../routes/host-api/commands.generated.mjs';

const all = new Set(['host', 'chat', 'approvals', 'tool_approvals']);
const refuse = (code, message) => ({ allow: false, code, message });

test('before hello only host.hello is allowed', () => {
  const s = new HostApiSession();
  assert.deepEqual(s.gate('host.hello', all), { allow: true });
  for (const c of Object.keys(HOST_API_COMMANDS).filter((c) => c !== 'host.hello')) {
    assert.deepEqual(s.gate(c, all), refuse('auth_failed', 'Send host.hello first.'), c);
  }
});

test('after hello only pairing, token auth and ping are allowed', () => {
  const s = new HostApiSession();
  s.greeted('web');
  for (const c of ['host.auth.pair', 'host.auth.token', 'host.ping']) assert.deepEqual(s.gate(c, all), { allow: true });
  assert.deepEqual(s.gate('host.hello', all), refuse('denied', 'This connection already sent host.hello.'));
  assert.deepEqual(s.gate('chat.send', all), refuse('auth_failed', 'Pair or authenticate first.'));
  assert.deepEqual(s.gate('host.auth.revoke', all), refuse('auth_failed', 'Pair or authenticate first.'));
});

test('once authenticated, auth commands are refused and others need their capability', () => {
  const s = new HostApiSession();
  s.greeted('web');
  s.authenticated(1, 'h1-A');
  assert.deepEqual(s.phase, { kind: 'authed', userId: 1, deviceId: 'h1-A', clientName: 'web' });
  s.authenticated(2, 'h1-B');
  assert.equal(s.deviceId, 'h1-A');
  assert.equal(s.userId, 1);
  const again = refuse('denied', 'This connection is already authenticated.');
  assert.deepEqual(s.gate('host.auth.pair', all), again);
  assert.deepEqual(s.gate('host.auth.token', all), again);
  assert.deepEqual(s.gate('host.auth.revoke', all), { allow: true });
  assert.deepEqual(s.gate('chat.send', new Set(['host'])), refuse('capability_unavailable', 'This computer does not serve chat right now.'));
  assert.deepEqual(s.gate('toolApprovals.answer', new Set(['host', 'chat', 'approvals'])),
    refuse('capability_unavailable', 'This computer does not serve tool_approvals right now.'));
  assert.deepEqual(s.gate('chat.send', all), { allow: true });
});

test('authenticated is a no-op before hello', () => {
  const s = new HostApiSession();
  s.authenticated(1, 'x');
  assert.equal(s.phase.kind, 'awaitingHello');
});

test('hello must offer API version 1', () => {
  assert.equal(helloRefusal([1, 2]), null);
  assert.equal(helloRefusal([2]), 'This computer speaks Host API version 1 only.');
});

test('internal command ids round-trip and never look like a v2 UUID', () => {
  const id = internalId(7, 'c-1');
  assert.equal(id, 'h1.7.c-1');
  assert.deepEqual(parseId(id), { session: 7, external: 'c-1' });
  assert.deepEqual(parseId('h1.7.c.1'), { session: 7, external: 'c.1' });
  for (const bad of ['9D2F6A1E-0000-0000-0000-000000000000', 'h1.x.c-1', 'h1.007.x', 'h1.-1.x', 'h1.+7.x', 'h1.', 'h1.7.']) {
    assert.equal(parseId(bad), null, bad);
  }
  assert.equal(isV1Id('llmide_chat_history'), false);
});

test('an unknown command is refused as unknown_command in every phase', () => {
  const s = new HostApiSession();
  assert.deepEqual(s.gate('nope.nothing', all), refuse('unknown_command', 'This host does not serve that command.'));
});
