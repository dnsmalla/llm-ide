// Web Push sent by the desktop core: RFC 8291 encryption against the RFC's own Appendix A vector, RFC 8292 VAPID,
// the push-service allowlist and the response mapping. No network: fetchImpl stands in for fixedHostFetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { es256Jwt } from '../server/push/jwt.mjs';
import { encryptPayload, pushEndpoint, isPushServiceHost, newVapidJwk, vapidKeyOf, sendWebPush, VAPID_SUBJECT, PUSH_TTL_SECONDS } from '../server/push/webpush.mjs';
import { PUSH_KINDS } from '../server/push/kinds.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEC = JSON.parse(readFileSync(path.join(REPO, 'schema/host-api/v1/fixtures/security/push.json'), 'utf8'));
const b = (s) => Buffer.from(s, 'base64url');
// RFC 8291 Appendix A (https://www.rfc-editor.org/rfc/rfc8291#appendix-A).
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: V.uaPublic, auth: V.authSecret };

/** The receiver side of RFC 8291, for round trips. */
function decrypt(message) {
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(b(V.uaPrivate));
  const salt = message.subarray(0, 16); const idlen = message[20];
  const asPub = message.subarray(21, 21 + idlen); const ct = message.subarray(21 + idlen);
  const hk = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const ikm = hk(ua.computeSecret(asPub), b(V.authSecret), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(out[out.length - 1], 2, 'last-record delimiter');
  return { text: out.subarray(0, -1).toString(), rs: message.readUInt32BE(16) };
}

test('RFC 8291 Appendix A: the same keys and salt give the RFC message byte for byte', () => {
  const out = encryptPayload(V.plaintext, { p256dh: V.uaPublic, auth: V.authSecret }, { asPrivate: b(V.asPrivate), salt: b(V.salt) });
  assert.equal(out.toString('base64url'), V.message);
});

test('a fresh message (random sender key and salt) decrypts with the receiver key, and never repeats', () => {
  const a = encryptPayload('{"k":"loop_done","n":1}', SUB);
  const c = encryptPayload('{"k":"loop_done","n":1}', SUB);
  assert.notEqual(a.toString('hex'), c.toString('hex'));
  assert.deepEqual(decrypt(a), { text: '{"k":"loop_done","n":1}', rs: 4096 });
});

test('bad subscription keys and oversized payloads are refused', () => {
  assert.throws(() => encryptPayload('x', { p256dh: V.authSecret, auth: V.authSecret }), { code: 'PUSH_BAD_KEYS' });
  assert.throws(() => encryptPayload('x', { p256dh: V.uaPublic, auth: 'AAAA' }), { code: 'PUSH_BAD_KEYS' });
  assert.throws(() => encryptPayload('x'.repeat(2000), SUB), { code: 'PUSH_TOO_LARGE' });
});

test('push-service endpoints: exactly the shared fixture', () => {
  for (const e of SEC.endpoints.allowed) assert.ok(pushEndpoint(e), e);
  for (const e of SEC.endpoints.refused) assert.equal(pushEndpoint(e), null, e);
  assert.equal(pushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(1100)}`), null, 'over 1024 characters');
  assert.equal(isPushServiceHost('wns2-par02p.notify.windows.com'), true);
  assert.equal(isPushServiceHost('x.y.notify.windows.com'), false);
  assert.deepEqual(SEC.kinds, [...PUSH_KINDS]);
});

test('ES256 JWT: header, claims and a raw r||s signature that verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const [h, p, s] = es256Jwt({ typ: 'JWT' }, { a: 1 }, privateKey).split('.');
  assert.deepEqual(JSON.parse(b(h)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b(p)), { a: 1 });
  assert.equal(b(s).length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(s)));
});

test('VAPID: a push to the endpoint origin, signed with the advertised key, pinned to that one host', async () => {
  const jwkText = newVapidJwk();
  const jwk = JSON.parse(jwkText);
  const vapid = vapidKeyOf(jwkText);
  assert.match(vapid.publicKey, /^[A-Za-z0-9_-]{87}$/);
  const calls = [];
  const fetchImpl = async (url, init, o) => { calls.push({ url, init, o }); return new Response(null, { status: 201 }); };
  const now = 1_800_000_000_000;
  assert.deepEqual(await sendWebPush(SUB, '{"k":"approval_job","n":2}', { vapid, urgency: 'high', topic: 'approval_job', now, fetchImpl }), { ok: true });
  const [c] = calls;
  assert.equal(c.url, SUB.endpoint);
  assert.deepEqual(c.o, { hosts: ['fcm.googleapis.com'], maxBytes: 16 * 1024 });
  assert.equal(c.init.method, 'POST');
  const hd = c.init.headers;
  assert.equal(hd['content-encoding'], 'aes128gcm');
  assert.equal(hd['content-type'], 'application/octet-stream');
  assert.equal(hd.ttl, String(PUSH_TTL_SECONDS));
  assert.equal(hd.urgency, 'high');
  assert.equal(hd.topic, 'approval_job');
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(hd.authorization);
  assert.equal(m[2], vapid.publicKey);
  const [h, p, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(b(p)), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: VAPID_SUBJECT });
  assert.deepEqual(JSON.parse(b(h)), { typ: 'JWT', alg: 'ES256' });
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b(s)));
  assert.equal(decrypt(c.init.body).text, '{"k":"approval_job","n":2}');
});

test('responses: 2xx ok, 404 and 410 gone, other statuses a code, a refused host never fetched', async () => {
  const vapid = vapidKeyOf(newVapidJwk());
  const reply = (status) => async () => new Response(null, { status });
  for (const s of [200, 201, 202]) assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: reply(s) }), { ok: true });
  for (const s of [404, 410]) assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: reply(s) }), { gone: true });
  assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: reply(429) }), { ok: false, code: 'PUSH_HTTP_429' });
  assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'FETCH_REFUSED' }); } }), { ok: false, code: 'FETCH_REFUSED' });
  assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { ok: false, code: 'PUSH_UNREACHABLE' });
  let called = false;
  assert.deepEqual(await sendWebPush({ ...SUB, endpoint: 'https://evil.example/x' }, '{}', { vapid, fetchImpl: async () => { called = true; } }), { ok: false, code: 'PUSH_HOST_REFUSED' });
  assert.deepEqual(await sendWebPush({ ...SUB, p256dh: 'AAAA' }, '{}', { vapid, fetchImpl: async () => { called = true; } }), { ok: false, code: 'PUSH_BAD_KEYS' });
  assert.equal(called, false);
});
