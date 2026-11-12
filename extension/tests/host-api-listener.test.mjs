import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startHostApiListener, sessionTransport } from '../server/host-api-listener.mjs';

const skip = typeof WebSocket === 'undefined' ? 'no global WebSocket' : false;

function fakeGateway() {
  const calls = [];
  return {
    calls,
    opened: (s, peer) => calls.push(['opened', s.id, peer]),
    receive: (s, t) => { calls.push(['receive', s.id, t]); sessionTransport.send(s, `echo:${t}`); },
    closed: (s) => calls.push(['closed', s.id]),
  };
}
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f()); };
const upgrade = (port, { path = '/host-api/v1', origin } = {}) => new Promise((resolve, reject) => {
  const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16, 1).toString('base64') };
  if (origin) headers.Origin = origin;
  const req = http.request({ host: '127.0.0.1', port, path, headers });
  req.on('upgrade', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
  req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end();
});

test('delivers frames, assigns monotonic session ids, releases the port', { skip }, async () => {
  const gw = fakeGateway();
  const l = await startHostApiListener({ gateway: gw, basePort: 0, originAllowlist: [] });
  const open = (ws) => new Promise((r) => ws.addEventListener('open', r));
  const a = new WebSocket(`ws://127.0.0.1:${l.port}/host-api/v1`);
  await open(a);
  const got = new Promise((r) => a.addEventListener('message', (e) => r(e.data)));
  a.send('hi');
  assert.equal(await got, 'echo:hi');
  const b = new WebSocket(`ws://127.0.0.1:${l.port}/host-api/v1`);
  await open(b);
  assert.deepEqual(gw.calls.filter((c) => c[0] === 'opened').map((c) => c[1]), [1, 2]);
  assert.ok(gw.calls.some((c) => c[0] === 'receive' && c[1] === 1 && c[2] === 'hi'));
  a.close();
  await until(() => gw.calls.some((c) => c[0] === 'closed' && c[1] === 1));
  await l.close();
  await new Promise((resolve, reject) => net.connect(l.port, '127.0.0.1').on('connect', () => reject(new Error('still open'))).on('error', resolve));
});

test('refuses other paths, foreign origins, unlisted origins; non-upgrade gets 404', { skip }, async () => {
  const gw = fakeGateway();
  const l = await startHostApiListener({ gateway: gw, basePort: 0, originAllowlist: ['http://localhost:5173'] });
  assert.equal(await upgrade(l.port, { path: '/other' }), 404);
  assert.equal(await upgrade(l.port, { origin: 'https://evil.example' }), 403);
  assert.equal(await upgrade(l.port, { origin: 'http://localhost:5174' }), 403);
  assert.equal(await upgrade(l.port, { origin: 'http://localhost:5173' }), 101);
  assert.equal(await upgrade(l.port), 101);
  const st = await new Promise((r) => http.get({ host: '127.0.0.1', port: l.port, path: '/host-api/v1' }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(st, 404);
  assert.equal(gw.calls.filter((c) => c[0] === 'opened').length, 2);
  await l.close();
});

test('slides to the next port when the base is taken', async () => {
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const base = blocker.address().port;
  const l = await startHostApiListener({ gateway: fakeGateway(), basePort: base, originAllowlist: [] });
  assert.ok(l.port > base);
  await l.close(); blocker.close();
});

test('a refused upgrade reports its event; a wrong path reports none', { skip }, async () => {
  const refused = [];
  const l = await startHostApiListener({ gateway: fakeGateway(), basePort: 0, originAllowlist: [], onRefused: (...a) => refused.push(a) });
  assert.equal(await upgrade(l.port, { path: '/other' }), 404);
  assert.equal(await upgrade(l.port, { origin: 'https://evil.example' }), 403);
  assert.deepEqual(refused.map((r) => [r[0], r[2]]), [['origin_refused', 'https://evil.example']]);
  assert.equal(l.address, '127.0.0.1');
  await l.close();
});

test('liveness: a peer that never answers pings is closed; a pinging client stays open', { skip }, async () => {
  const gw = fakeGateway();
  const l = await startHostApiListener({ gateway: gw, basePort: 0, originAllowlist: [], pingIntervalMs: 40 });
  // A raw upgraded socket that reads nothing back: the phone that dropped off Wi-Fi without a FIN.
  const silent = await new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16, 2).toString('base64') };
    const r = http.request({ host: '127.0.0.1', port: l.port, path: '/host-api/v1', headers });
    r.on('upgrade', (_res, sock) => { sock.on('error', () => {}); resolve(sock); });
    r.on('error', reject);
    r.end();
  });
  const live = new WebSocket(`ws://127.0.0.1:${l.port}/host-api/v1`); // answers pings with pongs
  await new Promise((r) => live.addEventListener('open', r));
  await until(() => gw.calls.some((c) => c[0] === 'closed' && c[1] === 1));
  await new Promise((r) => setTimeout(r, 200)); // several more intervals
  assert.ok(!gw.calls.some((c) => c[0] === 'closed' && c[1] === 2), 'a client that pongs is kept');
  assert.equal(live.readyState, WebSocket.OPEN);
  live.close(); silent.destroy();
  await l.close();
});
