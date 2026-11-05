import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import * as R from '../../scripts/relay-reference.mjs';
import { createRelaySocket } from '../src/relay/socket.ts';

const subtle = globalThis.crypto.subtle;
const ids = { userId: 'u1', desktopId: 'dk1', deviceId: 'dv1' };

function fakeWs() {
  const ws = { readyState: 0, sent: [], onopen: null, onmessage: null, onclose: null, onerror: null,
    send(t) { ws.sent.push(JSON.parse(t)); }, close() { ws.readyState = 3; ws.onclose?.(); },
    deliver(obj) { ws.onmessage({ data: JSON.stringify(obj) }); } };
  return ws;
}
const tick = () => new Promise((r) => setTimeout(r, 80));

test('auth, wrap + keyconfirm, open/opened, then request/reply carry Host API frames E2E', async () => {
  const desk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ecdhSpki = new Uint8Array(await subtle.exportKey('spki', ecdh.publicKey));
  const devSpki = new Uint8Array(await subtle.exportKey('spki', sign.publicKey));
  const devVerify = createPublicKey({ key: Buffer.from(devSpki), format: 'der', type: 'spki' });
  const deskSpki = desk.publicKey.export({ type: 'spki', format: 'der' });
  const rawToken = randomBytes(32);
  const ws = fakeWs();
  const session = { epoch: 0, request: null, reply: null, hostApiToken: null, sent: 0 };
  const sock = createRelaySocket({ url: 'wss://relay.test/relay/v1', createWs: () => ws, session,
    device: { token: rawToken.toString('base64url'), signingKey: sign.privateKey, ecdhKey: ecdh.privateKey, ecdhSpki, desktopSigningSpki: new Uint8Array(deskSpki) } });
  const got = []; let opened = false;
  sock.onopen = () => { opened = true; }; sock.onmessage = (e) => got.push(e.data);

  ws.readyState = 1; ws.onopen?.();
  ws.deliver({ t: 'challenge', nonce: 'c'.repeat(43) }); await tick();
  const auth = ws.sent.shift();
  assert.equal(auth.t, 'auth');
  assert.ok(verify('sha256', R.authMessage('c'.repeat(43), 'device', createHash('sha256').update(rawToken).digest('hex')), { key: devVerify, dsaEncoding: 'ieee-p1363' }, Buffer.from(auth.proof, 'base64url')));
  ws.deliver({ t: 'ready', role: 'device', ...ids });
  const keys = R.deviceKeys(randomBytes(32), ids, 1);
  const wrap = R.makeWrap({ ids, epoch: 1, tier: 'web', deviceEcdhSpki: Buffer.from(ecdhSpki), desktopSigningSpki: deskSpki, keys, hostApiToken: 'host-tok', signingKey: desk.privateKey });
  ws.deliver({ t: 'env', env: wrap }); await tick();
  const kc = ws.sent.shift().env;
  assert.equal(kc.purpose, 'keyconfirm');
  assert.deepEqual(R.open({ env: kc, key: keys.request, verifyKey: devVerify }), R.keyConfirmPlaintext(Buffer.from(wrap.sig, 'base64url')));
  assert.equal(session.hostApiToken, 'host-tok');

  ws.deliver({ t: 'peer', id: 'dk1', online: true }); await tick();
  const op = ws.sent.shift().env;
  const nD = R.open({ env: op, key: keys.request, verifyKey: devVerify, expect: { purpose: 'open', to: 'dk1' } });
  const sid = randomBytes(16).toString('base64url');
  const hdr = (purpose, seq) => ({ purpose, userId: 'u1', desktopId: 'dk1', from: 'dk1', to: 'dv1', epoch: 1, session: sid, seq, issuedAt: Date.now(), tier: '' });
  ws.deliver({ t: 'env', env: R.seal({ header: hdr('opened', 0), key: keys.reply, plaintext: nD, signingKey: desk.privateKey }) }); await tick();
  assert.equal(opened, true);

  sock.send('{"hello":1}'); await tick();
  const rq = ws.sent.shift().env;
  assert.equal(R.open({ env: rq, key: keys.request, verifyKey: devVerify, expect: { session: sid, seq: 1 } }).toString(), '{"hello":1}');
  const reply = R.seal({ header: hdr('reply', 1), key: keys.reply, plaintext: Buffer.from('{"ok":1}'), signingKey: desk.privateKey });
  ws.deliver({ t: 'env', env: reply }); await tick();
  ws.deliver({ t: 'env', env: reply }); await tick();
  assert.deepEqual(got, ['{"ok":1}']);

  ws.deliver({ t: 'peer', id: 'dk1', online: false }); await tick();
  assert.equal(sock.readyState, 3);
});
