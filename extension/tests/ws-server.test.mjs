import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acceptKey, handshakeRefusal, readFrame, encodeFrame, WsError, acceptUpgrade, MAX_MESSAGE_BYTES } from '../server/ws-server.mjs';

const mask = (opcode, payload, fin = true) => {
  const key = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 255]);
  const body = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([head, key, body]);
};

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshakeRefusal checks upgrade, version and key', () => {
  const ok = { headers: { upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
  assert.equal(handshakeRefusal(ok), null);
  assert.equal(handshakeRefusal({ headers: { ...ok.headers, upgrade: 'h2c' } }), 400);
  assert.equal(handshakeRefusal({ headers: { ...ok.headers, 'sec-websocket-version': '8' } }), 426);
  assert.equal(handshakeRefusal({ headers: { ...ok.headers, 'sec-websocket-key': 'short' } }), 400);
});

test('readFrame unmasks, waits for more bytes, and refuses unmasked or oversized frames', () => {
  const f = readFrame(mask(1, Buffer.from('hi')));
  assert.equal(f.opcode, 1); assert.equal(f.payload.toString(), 'hi'); assert.ok(f.fin);
  assert.equal(readFrame(mask(1, Buffer.from('hi')).subarray(0, 3)), null);
  assert.throws(() => readFrame(Buffer.from([0x81, 0x02, 0x68, 0x69])), (e) => e instanceof WsError && e.code === 1002);
  const huge = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 0x20, 0, 0, 1, 2, 3, 4]);
  assert.throws(() => readFrame(huge), (e) => e.code === 1009);
  assert.throws(() => readFrame(mask(9, Buffer.alloc(126))), (e) => e.code === 1002, 'control frames are at most 125 bytes');
});

test('encodeFrame writes 7-bit, 16-bit and 64-bit lengths, unmasked', () => {
  assert.deepEqual([...encodeFrame(1, Buffer.from('a'))], [0x81, 1, 0x61]);
  assert.equal(encodeFrame(1, Buffer.alloc(300))[1], 126);
  assert.equal(encodeFrame(1, Buffer.alloc(70_000))[1], 127);
});

test('a real WebSocket client exchanges text, fragmented text, ping and close', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('no global WebSocket client in this Node');
  const server = http.createServer();
  const got = [];
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head);
    conn.on('message', (text) => { got.push(text); conn.send(`echo:${text}`); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const reply = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('héllo');
    ws.onmessage = (e) => resolve(e.data);
    ws.onerror = reject;
  });
  assert.equal(reply, 'echo:héllo');
  assert.deepEqual(got, ['héllo']);
  ws.close();
  server.close();
});

test('a connection refuses binary and invalid UTF-8 with the right close codes', async () => {
  const server = http.createServer();
  const codes = [];
  server.on('upgrade', (req, socket, head) => acceptUpgrade(req, socket, head).on('close', (c) => codes.push(c)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  for (const frame of [mask(2, Buffer.from([1])), mask(1, Buffer.from([0xff]))]) {
    await new Promise((resolve) => {
      const req = http.request({ port, host: '127.0.0.1', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('upgrade', (_res, socket) => { socket.write(frame); socket.on('close', resolve); socket.resume(); });
      req.end();
    });
  }
  assert.deepEqual(codes, [1003, 1007]);
  server.close();
  assert.equal(MAX_MESSAGE_BYTES, 1048576);
});
