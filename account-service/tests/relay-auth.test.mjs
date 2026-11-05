import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, sign } from 'node:crypto';
import { startApp, linkedPair } from './helpers.mjs';
import { authenticate, authMessage, DEVICE_IDLE_MS, newChallenge } from '../src/relay/auth.mjs';
import { parseClient } from '../src/relay/protocol.mjs';

const vectors = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url), 'utf8'));
const proof = (key, challenge, role, tokenHash) => sign('sha256', authMessage(challenge, role, tokenHash), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const ctxOf = (app) => ({ db: app.db, now: app.clock.now });

test('auth message matches the shared vector', () => {
  const [, challenge, role, hash] = vectors.auth.messageUtf8.split('\n');
  assert.equal(authMessage(challenge, role, hash).toString('utf8'), vectors.auth.messageUtf8);
});

test('desktop and device authenticate only with a proof from their registered key', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  const c = newChallenge();
  const dHash = createHash('sha256').update(p.desktop.accessToken).digest('hex');
  const desk = authenticate(ctxOf(app), { token: p.desktop.accessToken, proof: proof(p.desktop.signing.privateKey, c, 'desktop', dHash), challenge: c });
  assert.equal(desk.role, 'desktop');
  assert.equal(desk.deviceId, p.desktop.deviceId);
  const dev = authenticate(ctxOf(app), { token: p.device.token, proof: proof(p.device.signing.privateKey, c, 'device', p.device.tokenHash), challenge: c });
  assert.deepEqual([dev.role, dev.deviceId, dev.desktopId, dev.userId], ['device', p.device.deviceId, p.desktop.deviceId, p.userId]);
  assert.equal(authenticate(ctxOf(app), { token: p.device.token, proof: proof(p.desktop.signing.privateKey, c, 'device', p.device.tokenHash), challenge: c }), null);
  assert.equal(authenticate(ctxOf(app), { token: p.device.token, proof: proof(p.device.signing.privateKey, newChallenge(), 'device', p.device.tokenHash), challenge: c }), null);
  assert.equal(authenticate(ctxOf(app), { token: p.device.token, proof: proof(p.device.signing.privateKey, c, 'desktop', p.device.tokenHash), challenge: c }), null);
});

test('revoked, idle or expired credentials are refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  const c = newChallenge();
  const devProof = proof(p.device.signing.privateKey, c, 'device', p.device.tokenHash);
  app.clock.advance(DEVICE_IDLE_MS + 1);
  assert.equal(authenticate(ctxOf(app), { token: p.device.token, proof: devProof, challenge: c }), null, 'idle 30 days');
  app.db.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(p.device.deviceId);
  app.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(app.clock.now(), p.device.deviceId);
  assert.equal(authenticate(ctxOf(app), { token: p.device.token, proof: devProof, challenge: c }), null, 'revoked');
  const dHash = createHash('sha256').update(p.desktop.accessToken).digest('hex');
  assert.equal(authenticate(ctxOf(app), { token: p.desktop.accessToken, proof: proof(p.desktop.signing.privateKey, c, 'desktop', dHash), challenge: c }), null, 'access token expired after 30 days');
});

test('parseClient accepts only the closed message set', () => {
  const env = { v: 1, purpose: 'request', userId: 'u', desktopId: 'd', from: 'x', to: 'd', epoch: 1, session: 'AAAAAAAAAAAAAAAAAAAAAA', seq: 1, issuedAt: 1, tier: '', nonce: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(1388), sig: 'A'.repeat(86) };
  assert.equal(parseClient(JSON.stringify({ t: 'env', env })).env.to, 'd');
  for (const bad of [
    '{', '[]', JSON.stringify({ t: 'nope' }), JSON.stringify({ t: 'pong', x: 1 }),
    JSON.stringify({ t: 'env', env: { ...env, extra: 1 } }), JSON.stringify({ t: 'env', env: { ...env, v: 2 } }),
    JSON.stringify({ t: 'env', env: { ...env, purpose: 'snapshot' } }), JSON.stringify({ t: 'env', env: { ...env, eph: 'AAAA' } }),
    JSON.stringify({ t: 'env', env: { ...env, seq: -1 } }), JSON.stringify({ t: 'auth', token: 'x', proof: 'y' }),
    JSON.stringify({ t: 'env', env: { ...env, purpose: 'wrap' } }),
  ]) assert.throws(() => parseClient(bad), (e) => typeof e.code === 'string');
});
