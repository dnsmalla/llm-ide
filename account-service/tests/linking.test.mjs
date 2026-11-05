import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  ORIGIN,
  desktopBody,
  desktopKeys,
  rawRequest,
  signInDesktop,
  signUpAndRegister,
  startApp,
} from './helpers.mjs';
import { linkCommitment, linkSas } from '../src/linking.mjs';

function registerDesktop(app, token) {
  return rawRequest(app.base, 'POST', '/v1/desktop', JSON.stringify(desktopBody(token)), {
    'content-type': 'application/json', authorization: `Bearer ${token}`,
  });
}

function post(app, path, body, headers = {}) {
  return rawRequest(app.base, 'POST', path, JSON.stringify(body), {
    'content-type': 'application/json', origin: ORIGIN, ...headers,
  });
}

function device() {
  const keys = desktopKeys();
  const nonce = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  return { ...keys, nonce, token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

test('device linking: commitment, desktop approval, keys, SAS and confirmation', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { web, tokens } = await signInDesktop(app);
  const desktop = desktopKeys();
  assert.equal((await rawRequest(app.base, 'POST', '/v1/desktop', JSON.stringify(desktopBody(tokens.access_token, desktop)), { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` })).status, 201);

  const dev = device();
  const commit = linkCommitment(dev.signingKey, dev.ecdhKey, dev.nonce);
  const created = await post(app, '/v1/link/requests', { kind: 'web', label: '  Chrome  ', commitment: commit }, { cookie: web.cookie });
  assert.equal(created.status, 201);
  const id = created.body.requestId;
  assert.equal(typeof id, 'string');

  // The request is scoped to the account and starts as pending.
  const pending = await rawRequest(app.base, 'GET', '/v1/link/requests', undefined, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.requests.length, 1);
  assert.equal(pending.body.requests[0].label, 'Chrome');
  assert.equal(pending.body.requests[0].state, 'pending');
  assert.match(pending.body.requests[0].deviceId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(pending.body.requests[0].commitment, commit);

  const desktopNonce = randomBytes(32).toString('base64url');
  const approved = await post(app, '/v1/link/requests/approve', { requestId: id, desktopNonce }, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state, 'approved');
  assert.match(approved.body.desktopNonce, /^[A-Za-z0-9_-]{43}$/);

  const status = await rawRequest(app.base, 'GET', `/v1/link/requests/status?requestId=${id}`, undefined, { cookie: web.cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'approved');
  assert.equal(status.body.deviceId, pending.body.requests[0].deviceId);
  assert.match(status.body.desktopId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(status.body.desktopNonce, approved.body.desktopNonce);
  assert.equal(status.body.desktopSigningKey, desktop.signingKey);

  // Keys are accepted only after approval and only if they match the commitment.
  const revealed = await post(app, '/v1/link/requests/keys', {
    requestId: id, signingKey: dev.signingKey, ecdhKey: dev.ecdhKey, nonce: dev.nonce, tokenHash: dev.tokenHash,
  }, { cookie: web.cookie });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.state, 'keys');
  assert.equal(revealed.body.deviceSigningKey, dev.signingKey);

  const keys = await rawRequest(app.base, 'GET', '/v1/link/requests', undefined, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(keys.body.requests[0].signingKey, dev.signingKey);
  assert.equal(keys.body.requests[0].deviceNonce, dev.nonce);
  const sas = linkSas(dev.signingKey, dev.ecdhKey, desktop.signingKey, dev.nonce, approved.body.desktopNonce);
  assert.match(sas, /^\d{6}$/);

  const confirmed = await post(app, '/v1/link/requests/confirm', { requestId: id }, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.state, 'linked');
  assert.equal(confirmed.body.sas, sas);

  const done = await rawRequest(app.base, 'GET', `/v1/link/requests/status?requestId=${id}`, undefined, { cookie: web.cookie });
  assert.equal(done.body.state, 'linked');
  const row = app.db.prepare('SELECT d.*, r.state FROM devices d JOIN link_requests r ON r.device_id=d.id WHERE r.id=?').get(id);
  assert.equal(row.kind, 'web');
  assert.equal(row.status, 'linked');
  assert.equal(row.token_hash, dev.tokenHash);
  assert.equal(row.signing_key, dev.signingKey);
  assert.equal(row.ecdh_key, dev.ecdhKey);
});

test('a swapped key or stale approval cannot link', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { web, tokens } = await signInDesktop(app);
  await registerDesktop(app, tokens.access_token);
  const dev = device();
  const created = await post(app, '/v1/link/requests', { kind: 'web', label: 'Chrome', commitment: linkCommitment(dev.signingKey, dev.ecdhKey, dev.nonce) }, { cookie: web.cookie });
  const id = created.body.requestId;

  // Keys before approval are refused.
  const early = await post(app, '/v1/link/requests/keys', {
    requestId: id, signingKey: dev.signingKey, ecdhKey: dev.ecdhKey, nonce: dev.nonce, tokenHash: dev.tokenHash,
  }, { cookie: web.cookie });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'not_approved');

  await post(app, '/v1/link/requests/approve', { requestId: id, desktopNonce: randomBytes(32).toString('base64url') }, { authorization: `Bearer ${tokens.access_token}` });
  const swapped = device();
  const mismatch = await post(app, '/v1/link/requests/keys', {
    requestId: id, signingKey: swapped.signingKey, ecdhKey: swapped.ecdhKey, nonce: dev.nonce, tokenHash: swapped.tokenHash,
  }, { cookie: web.cookie });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error, 'commitment_mismatch');

  app.clock.advance(11 * 60_000);
  const expired = await rawRequest(app.base, 'GET', `/v1/link/requests/status?requestId=${id}`, undefined, { cookie: web.cookie });
  assert.equal(expired.body.state, 'unlinked');
  const late = await post(app, '/v1/link/requests/approve', { requestId: id, desktopNonce: randomBytes(32).toString('base64url') }, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(late.status, 409);
});

test('a link request is private to its account and its device session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const first = await signInDesktop(app);
  await registerDesktop(app, first.tokens.access_token);
  const dev = device();
  const created = await post(app, '/v1/link/requests', { kind: 'web', label: 'Chrome', commitment: linkCommitment(dev.signingKey, dev.ecdhKey, dev.nonce) }, { cookie: first.web.cookie });
  const id = created.body.requestId;

  const otherWeb = app.client();
  await signUpAndRegister(app, otherWeb, { email: 'bob@example.com', credentialId: 'cred-bob' });
  const other = await signInDesktop(app, { reuse: otherWeb });
  const otherList = await rawRequest(app.base, 'GET', '/v1/link/requests', undefined, { authorization: `Bearer ${other.tokens.access_token}` });
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.body.requests, []);
  const otherStatus = await rawRequest(app.base, 'GET', `/v1/link/requests/status?requestId=${id}`, undefined, { cookie: otherWeb.cookie });
  assert.equal(otherStatus.status, 404);

  const anonymous = await rawRequest(app.base, 'GET', `/v1/link/requests/status?requestId=${id}`, undefined, {});
  assert.equal(anonymous.status, 401);
});
