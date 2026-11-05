import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startApp, linkedPair, ORIGIN, WEB_ORIGIN } from './helpers.mjs';
import { authed, fakeEnv, wsConnect } from './relay-helpers.mjs';

async function both(app, p) {
  const desk = await authed(app.base, { token: p.desktop.accessToken, signingKey: p.desktop.signing.privateKey, role: 'desktop', tokenHash: createHash('sha256').update(p.desktop.accessToken).digest('hex') });
  const dev = await authed(app.base, { token: p.device.token, signingKey: p.device.signing.privateKey, role: 'device', tokenHash: p.device.tokenHash, origin: WEB_ORIGIN });
  return { desk, dev };
}
const ids = (p) => ({ userId: p.userId, desktopId: p.desktop.deviceId });

test('forwards envelopes desktop ↔ linked device and reports presence', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  const { desk, dev } = await both(app, p);
  assert.deepEqual(desk.ready, { t: 'ready', role: 'desktop', userId: p.userId, deviceId: p.desktop.deviceId, desktopId: p.desktop.deviceId });
  assert.equal(dev.ready.role, 'device');
  assert.deepEqual(await dev.ws.next(), { t: 'peer', id: p.desktop.deviceId, online: true });
  assert.deepEqual(await desk.ws.next(), { t: 'peer', id: p.device.deviceId, online: true });
  const up = fakeEnv({ ...ids(p), purpose: 'open', session: '', from: p.device.deviceId, to: p.desktop.deviceId });
  dev.ws.send({ t: 'env', env: up });
  assert.deepEqual(await desk.ws.next(), { t: 'env', env: up });
  const down = fakeEnv({ ...ids(p), purpose: 'opened', from: p.desktop.deviceId, to: p.device.deviceId });
  desk.ws.send({ t: 'env', env: down });
  assert.deepEqual(await dev.ws.next(), { t: 'env', env: down });
  dev.ws.close();
  assert.deepEqual(await desk.ws.next(), { t: 'peer', id: p.device.deviceId, online: false });
});

test('refuses spoofed sender, wrong direction, foreign recipient and offline peer', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const a = await linkedPair(app);
  const { desk, dev } = await both(app, a);
  await dev.ws.next(); await desk.ws.next();
  dev.ws.send({ t: 'env', env: fakeEnv({ ...ids(a), from: a.desktop.deviceId, to: a.desktop.deviceId }) });
  assert.equal((await dev.ws.next()).code, 'bad_sender');
  dev.ws.send({ t: 'env', env: fakeEnv({ ...ids(a), purpose: 'reply', from: a.device.deviceId, to: a.desktop.deviceId }) });
  assert.equal((await dev.ws.next()).code, 'bad_direction');
  desk.ws.send({ t: 'env', env: fakeEnv({ ...ids(a), purpose: 'reply', from: a.desktop.deviceId, to: 'someone-else' }) });
  assert.equal((await desk.ws.next()).code, 'bad_recipient');
  dev.ws.close(); await desk.ws.next();
  desk.ws.send({ t: 'env', env: fakeEnv({ ...ids(a), purpose: 'reply', from: a.desktop.deviceId, to: a.device.deviceId }) });
  assert.equal((await desk.ws.next()).code, 'peer_offline');
});

test('origin rules: web device needs an allowlisted origin, desktop must send none, accounts origin refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  assert.equal((await wsConnect(app.base, { origin: ORIGIN })).refused, 403);
  assert.equal((await wsConnect(app.base, { path: '/relay/v1?token=x' })).refused, 404);
  const noOrigin = await authed(app.base, { token: p.device.token, signingKey: p.device.signing.privateKey, role: 'device', tokenHash: p.device.tokenHash });
  assert.equal(noOrigin.ready.code, 'auth_failed');
  const deskInBrowser = await authed(app.base, { token: p.desktop.accessToken, signingKey: p.desktop.signing.privateKey, role: 'desktop', tokenHash: createHash('sha256').update(p.desktop.accessToken).digest('hex'), origin: WEB_ORIGIN });
  assert.equal(deskInBrowser.ready.code, 'auth_failed');
});

test('revoking the device on the web closes its socket at once and drops its stored wrap', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  const { desk, dev } = await both(app, p);
  await dev.ws.next(); await desk.ws.next();
  desk.ws.send({ t: 'env', env: fakeEnv({ ...ids(p), purpose: 'wrap', session: '', tier: 'web', eph: 'A'.repeat(122), from: p.desktop.deviceId, to: p.device.deviceId }) });
  await dev.ws.next();
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM relay_wraps').pluck().get(), 1);
  const opts = await p.web.call('POST', '/v1/signin/options', {});
  await p.web.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } });
  const r = await p.web.call('DELETE', `/v1/devices/${p.device.deviceId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await dev.ws.next(), { t: '__closed', code: 4003 });
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM relay_wraps').pluck().get(), 0);
});

test('a stored wrap is delivered when the device connects later; a second socket replaces the first', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  const desk = await authed(app.base, { token: p.desktop.accessToken, signingKey: p.desktop.signing.privateKey, role: 'desktop', tokenHash: createHash('sha256').update(p.desktop.accessToken).digest('hex') });
  const wrap = fakeEnv({ ...ids(p), purpose: 'wrap', session: '', tier: 'web', eph: 'A'.repeat(122), from: p.desktop.deviceId, to: p.device.deviceId, epoch: 1 });
  desk.ws.send({ t: 'env', env: wrap });
  const dev = await authed(app.base, { token: p.device.token, signingKey: p.device.signing.privateKey, role: 'device', tokenHash: p.device.tokenHash, origin: WEB_ORIGIN });
  assert.deepEqual(await dev.ws.next(), { t: 'env', env: wrap });
  const again = await authed(app.base, { token: p.device.token, signingKey: p.device.signing.privateKey, role: 'device', tokenHash: p.device.tokenHash, origin: WEB_ORIGIN });
  assert.equal(again.ready.role, 'device');
  let m; do { m = await dev.ws.next(); } while (m.t !== '__closed');
  assert.equal(m.code, 4009);
});

test('rate limit: over-budget envelopes are refused, repeated overs close 4008', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_RELAY_TEST_ENVELOPES_PER_MIN: '3' } });
  t.after(() => app.close());
  const p = await linkedPair(app);
  const { desk, dev } = await both(app, p);
  await dev.ws.next(); await desk.ws.next();
  const env = fakeEnv({ ...ids(p), from: p.device.deviceId, to: p.desktop.deviceId });
  for (let i = 0; i < 6; i++) dev.ws.send({ t: 'env', env });
  const seen = [];
  for (;;) { const m = await dev.ws.next(); seen.push(m.t === 'err' ? m.code : m.t); if (m.t === '__closed') { assert.equal(m.code, 4008); break; } }
  assert.equal(seen.filter((s) => s === 'rate_limited').length, 3);
});

test('unauthenticated sockets are closed after the deadline; garbage closes 1008', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_RELAY_TEST_AUTH_DEADLINE_MS: '50' } });
  t.after(() => app.close());
  const ws = await wsConnect(app.base);
  assert.equal((await ws.next()).t, 'challenge');
  assert.deepEqual(await ws.next(), { t: '__closed', code: 4001 });
  const g = await wsConnect(app.base);
  await g.next();
  g.send('{"t":"env"}');
  assert.equal((await g.next()).code, 'invalid_message');
  assert.deepEqual(await g.next(), { t: '__closed', code: 1008 });
});
