import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, desktopBody, rawRequest, signInDesktop, signUpAndRegister, startApp } from './helpers.mjs';

async function registerDesktop(app, token) {
  return rawRequest(app.base, 'POST', '/v1/desktop', JSON.stringify(desktopBody(token)), {
    'content-type': 'application/json', authorization: `Bearer ${token}`,
  });
}

test('device list shows the registered desktop and revoke is fresh-checked', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { web, tokens } = await signInDesktop(app);
  assert.equal((await registerDesktop(app, tokens.access_token)).status, 201);

  const list = await rawRequest(app.base, 'GET', '/v1/devices', undefined, { cookie: web.cookie, origin: ORIGIN });
  assert.equal(list.status, 200);
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].kind, 'desktop');

  const id = list.body.devices[0].id;
  app.clock.advance(6 * 60_000); // the web session's passkey proof is now stale
  const noFresh = await rawRequest(app.base, 'DELETE', `/v1/devices/${id}`, undefined, { cookie: web.cookie, origin: ORIGIN });
  assert.equal(noFresh.status, 401);
  assert.deepEqual(noFresh.body, { error: 'reauth_required' });

  const fresh = app.client();
  const opts = await fresh.call('POST', '/v1/signin/options', {});
  const signed = await fresh.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } });
  assert.equal(signed.status, 200);
  const revoked = await rawRequest(app.base, 'DELETE', `/v1/devices/${id}`, undefined, { cookie: fresh.cookie, origin: ORIGIN });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { revoked: true });
  const again = await rawRequest(app.base, 'GET', '/v1/devices', undefined, { cookie: fresh.cookie, origin: ORIGIN });
  assert.equal(again.body.devices[0].status, 'revoked');

  // The one-desktop rule counts only live desktops: after a revoke a new one can register.
  const second = await registerDesktop(app, tokens.access_token);
  assert.equal(second.status, 201);
  const after = await rawRequest(app.base, 'GET', '/v1/devices', undefined, { cookie: fresh.cookie, origin: ORIGIN });
  assert.deepEqual(after.body.devices.map((d) => d.status), ['revoked', 'linked']);
  assert.equal((await registerDesktop(app, tokens.access_token)).status, 409);
});

test('device list is scoped to the signed-in account', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);
  assert.equal((await registerDesktop(app, tokens.access_token)).status, 201);

  const other = app.client();
  await signUpAndRegister(app, other, { email: 'other@example.com', credentialId: 'cred-other' });
  const list = await rawRequest(app.base, 'GET', '/v1/devices', undefined, { cookie: other.cookie, origin: ORIGIN });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.devices, []);
});
