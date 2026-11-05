import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startApp, linkedPair, WEB_ORIGIN } from './helpers.mjs';
import { authed, fakeEnv } from './relay-helpers.mjs';

// After a full relay scenario, no token, proof, plaintext marker or envelope ciphertext may appear in the database
// (outside relay_wraps, which holds the wrap ciphertext by design) or in anything written to stdout/stderr.
test('relay storage and logs are blind', async (t) => {
  const logs = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  t.after(() => Object.assign(console, orig));
  const app = await startApp();
  t.after(() => app.close());
  const p = await linkedPair(app);
  const marker = Buffer.from('PLAINTEXT-MARKER-relay-7f3a').toString('base64url');
  const deskHash = createHash('sha256').update(p.desktop.accessToken).digest('hex');
  const desk = await authed(app.base, { token: p.desktop.accessToken, signingKey: p.desktop.signing.privateKey, role: 'desktop', tokenHash: deskHash });
  const dev = await authed(app.base, { token: p.device.token, signingKey: p.device.signing.privateKey, role: 'device', tokenHash: p.device.tokenHash, origin: WEB_ORIGIN });
  await dev.ws.next(); await desk.ws.next();
  const ct = (marker + 'A'.repeat(1387)).slice(0, 1387);
  dev.ws.send({ t: 'env', env: fakeEnv({ userId: p.userId, desktopId: p.desktop.deviceId, from: p.device.deviceId, to: p.desktop.deviceId, ct }) });
  await desk.ws.next();
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'relay_wraps'").pluck().all();
  const dump = tables.map((n) => JSON.stringify(app.db.prepare(`SELECT * FROM ${n}`).all())).join('\n') + logs.join('\n');
  for (const secret of [p.desktop.accessToken, p.device.token, marker, ct.slice(0, 40)]) {
    assert.equal(dump.includes(secret), false, `found ${secret.slice(0, 8)}…`);
  }
  const events = app.db.prepare("SELECT event, detail FROM audit_events WHERE event LIKE 'relay_%'").all();
  assert.ok(events.some((e) => e.event === 'relay_connected'));
  for (const e of events) assert.doesNotMatch(e.detail, /token|proof|ct|sig/);
});
