// APNs from the desktop core, against an in-process cleartext HTTP/2 server standing in for Apple (the connect seam).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { sendApns, apnsKeyOf, providerToken, _resetApnsForTests, APNS_TOPIC, APNS_HOSTS, JWT_MAX_AGE_MS } from '../server/push/apns.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const credentials = { key: apnsKeyOf(PEM), keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' };
const TOKEN = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;
const seen = [];
let reply = () => ({ status: 200, body: '' });
const server = http2.createServer();
server.on('stream', (stream, headers) => {
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => { body += d; });
  stream.on('end', () => {
    seen.push({ headers, body });
    const r = reply(seen.length);
    stream.respond({ ':status': r.status, 'content-type': 'application/json' });
    stream.end(r.body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const connect = (origin) => { assert.match(origin, /^https:\/\/api(\.sandbox)?\.push\.apple\.com$/); return http2.connect(`http://127.0.0.1:${server.address().port}`); };
after(() => server.close());
beforeEach(() => { seen.length = 0; reply = () => ({ status: 200, body: '' }); _resetApnsForTests(); });
const args = (o = {}) => ({ token: TOKEN, environment: 'sandbox', payload: '{"aps":{}}', collapseId: 'loop_done', credentials, now: NOW, connect, ...o });
const claims = (auth) => JSON.parse(Buffer.from(auth.split(' ')[1].split('.')[1], 'base64url'));

test('a push is one POST to /3/device/<token> with the provider token and the APNs headers', async () => {
  assert.deepEqual(await sendApns(args()), { ok: true });
  const { headers, body } = seen[0];
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], `/3/device/${TOKEN}`);
  assert.equal(headers['apns-topic'], APNS_TOPIC);
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-priority'], '10');
  assert.equal(headers['apns-collapse-id'], 'loop_done');
  assert.equal(headers['apns-expiration'], String(NOW / 1000 + 3600));
  assert.equal(body, '{"aps":{}}');
  const [h, p, s] = headers.authorization.slice('bearer '.length).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { kid: 'ABCDE12345', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: '9A3YFRQ7SM', iat: NOW / 1000 });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('the provider token is reused for 50 minutes, then minted again', () => {
  const a = providerToken(credentials, NOW);
  assert.equal(providerToken(credentials, NOW + JWT_MAX_AGE_MS - 1), a);
  assert.notEqual(providerToken(credentials, NOW + JWT_MAX_AGE_MS), a);
});

test('410 and dead-token reasons mean gone; other failures carry a code', async () => {
  reply = () => ({ status: 410, body: '{"reason":"Unregistered"}' });
  assert.deepEqual(await sendApns(args()), { gone: true });
  for (const reason of ['BadDeviceToken', 'DeviceTokenNotForTopic']) {
    reply = () => ({ status: 400, body: JSON.stringify({ reason }) });
    assert.deepEqual(await sendApns(args()), { gone: true }, reason);
  }
  reply = () => ({ status: 400, body: '{"reason":"BadTopic"}' });
  assert.deepEqual(await sendApns(args()), { ok: false, code: 'APNS_400_BadTopic' });
  reply = () => ({ status: 500, body: '{"reason":"bad reason with spaces"}' });
  assert.deepEqual(await sendApns(args()), { ok: false, code: 'APNS_500' }, 'an odd reason is never echoed');
});

test('an expired provider token is minted fresh and the push retried once', async () => {
  reply = (n) => (n === 1 ? { status: 403, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200, body: '' });
  assert.deepEqual(await sendApns(args()), { ok: true });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].headers.authorization, seen[1].headers.authorization);
  assert.equal(claims(seen[1].headers.authorization).iss, '9A3YFRQ7SM');
  reply = () => ({ status: 403, body: '{"reason":"InvalidProviderToken"}' });
  assert.deepEqual(await sendApns(args()), { ok: false, code: 'APNS_403_InvalidProviderToken' }, 'only one retry');
});

test('a bad token or environment never connects; an unreachable host is a code', async () => {
  let dialled = false;
  const spy = () => { dialled = true; return connect('https://api.push.apple.com'); };
  for (const o of [{ token: 'AB'.repeat(32) }, { token: 'ab' }, { environment: 'staging' }, { environment: '__proto__' }]) {
    assert.deepEqual(await sendApns(args({ ...o, connect: spy })), { ok: false, code: 'APNS_BAD_TARGET' }, JSON.stringify(o));
  }
  assert.equal(dialled, false);
  const dead = () => http2.connect('http://127.0.0.1:1');
  assert.deepEqual(await sendApns(args({ connect: dead, timeoutMs: 2000 })), { ok: false, code: 'APNS_UNREACHABLE' });
});

test('apnsKeyOf accepts only an EC P-256 PKCS#8 key; the hosts are the two fixed Apple hosts', () => {
  assert.ok(apnsKeyOf(PEM));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const bad of [rsa, p384, 'not a key', '', null, 42]) assert.equal(apnsKeyOf(bad), null);
  assert.deepEqual({ ...APNS_HOSTS }, { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' });
});
