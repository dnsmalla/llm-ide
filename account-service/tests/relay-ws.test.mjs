import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { acceptKey, handshakeRefusal, readFrame, encodeFrame, WsError, acceptUpgrade, MAX_MESSAGE_BYTES, MAX_BUFFERED_BYTES, WsConnection } from '../src/relay/ws.mjs';

// Builds one masked client frame. Handles 7-bit and 16-bit lengths (payloads under 65536 bytes).
const mask = (opcode, payload, fin = true) => {
  const key = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 255]);
  const body = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([head, key, body]);
};

const UPGRADE = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
const PONG_HI = Buffer.from([0x8a, 0x01, 0x70]); // unmasked pong carrying 'p'

// Runs fn against a raw-socket harness; records messages and close codes per server connection.
async function withServer(fn) {
  const server = http.createServer();
  const sockets = new Set();
  const h = { messages: [], closes: [], clients: [] };
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head);
    conn.on('message', (t) => h.messages.push(t));
    conn.on('close', (c) => h.closes.push(c));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  h.port = server.address().port;
  try {
    await fn(h);
  } finally {
    for (const c of h.clients) c.destroy();
    for (const s of sockets) s.destroy();
    server.close();
  }
}

async function connect(h) {
  return new Promise((resolve) => {
    const req = http.request({ port: h.port, host: '127.0.0.1', headers: UPGRADE });
    req.on('upgrade', (_res, socket) => {
      const got = [];
      socket.on('data', (c) => got.push(c));
      h.clients.push(socket);
      resolve({ socket, rx: () => Buffer.concat(got) });
    });
    req.end();
  });
}

async function until(cond, what) {
  const end = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshakeRefusal checks method, upgrade, connection, version and key', () => {
  const ok = { method: 'GET', headers: { upgrade: 'websocket', connection: 'keep-alive, Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
  const with_ = (h) => ({ ...ok, headers: { ...ok.headers, ...h } });
  assert.equal(handshakeRefusal(ok), null);
  assert.equal(handshakeRefusal({ ...ok, method: 'POST' }), 405);
  assert.equal(handshakeRefusal(with_({ upgrade: 'h2c' })), 400);
  assert.equal(handshakeRefusal(with_({ connection: 'keep-alive' })), 400);
  assert.equal(handshakeRefusal(with_({ connection: undefined })), 400);
  assert.equal(handshakeRefusal(with_({ connection: 'UPGRADE' })), null, 'connection token match is case-insensitive');
  assert.equal(handshakeRefusal(with_({ 'sec-websocket-version': '8' })), 426);
  assert.equal(handshakeRefusal(with_({ 'sec-websocket-key': 'short' })), 400);
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

test('a real WebSocket client exchanges one text message and closes', async (t) => {
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

test('fragmented text reassembles into one message', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(Buffer.concat([mask(1, Buffer.from('hel'), false), mask(0, Buffer.from('lo'))]));
  await until(() => h.messages.length === 1, 'message');
  assert.deepEqual(h.messages, ['hello']);
}));

test('a ping gets a pong with the same payload', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(mask(9, Buffer.from('p')));
  await until(() => c.rx().includes(PONG_HI), 'pong');
}));

test('a control frame between fragments is answered and does not break the message', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(Buffer.concat([mask(1, Buffer.from('a'), false), mask(9, Buffer.from('p')), mask(0, Buffer.from('b'))]));
  await until(() => h.messages.length === 1 && c.rx().includes(PONG_HI), 'message and pong');
  assert.deepEqual(h.messages, ['ab']);
  assert.deepEqual(h.closes, []);
}));

test('a continuation without a started message closes with 1002', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(mask(0, Buffer.from('a')));
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1002]);
  assert.deepEqual(h.messages, []);
}));

test('a text frame while fragments are pending closes with 1002', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(Buffer.concat([mask(1, Buffer.from('a'), false), mask(1, Buffer.from('b'))]));
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1002]);
  assert.deepEqual(h.messages, []);
}));

test('fragments accumulating past the relay cap close with 1009', () => withServer(async (h) => {
  const c = await connect(h);
  const chunk = Buffer.alloc(60_000, 0x78); // 27 x 60 KB = 1.62 MB, over the cap on the 27th
  const frames = Array.from({ length: 27 }, (_, i) => mask(i === 0 ? 1 : 0, chunk, false));
  c.socket.write(Buffer.concat(frames));
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1009]);
  assert.deepEqual(h.messages, []);
}));

test('more than 1024 fragments of one message close with 1009', () => withServer(async (h) => {
  const c = await connect(h);
  const frames = Array.from({ length: 1100 }, (_, i) => mask(i === 0 ? 1 : 0, Buffer.from('a'), false));
  c.socket.write(Buffer.concat(frames));
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1009]);
}));

test('100k empty continuation frames are refused with 1002 quickly', () => withServer(async (h) => {
  const c = await connect(h);
  const empty = mask(0, Buffer.alloc(0), false);
  const t0 = Date.now();
  c.socket.write(Buffer.concat([mask(1, Buffer.from('a'), false), Buffer.concat(Array(100_000).fill(empty))]));
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1002]);
  assert.ok(Date.now() - t0 < 2000, 'refused without buffering the whole flood');
}));

test('a peer close frame is echoed with the peer code', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(mask(8, Buffer.from([0x03, 0xe9]))); // 1001 going away
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1001]);
  await until(() => c.rx().includes(Buffer.from([0x88, 0x02, 0x03, 0xe9])), 'echoed close');
}));

test('a close frame with a one-byte body closes with 1002', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(mask(8, Buffer.from([0x03])));
  await until(() => h.closes.length === 1, 'close');
  assert.deepEqual(h.closes, [1002]);
}));

test('data after a peer close frame produces no message', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(Buffer.concat([mask(8, Buffer.from([0x03, 0xe9])), mask(1, Buffer.from('late'))]));
  await until(() => h.closes.length === 1, 'close');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.closes, [1001]);
}));

test('data after a protocol error produces no message', () => withServer(async (h) => {
  const c = await connect(h);
  c.socket.write(Buffer.concat([mask(2, Buffer.from([1])), mask(1, Buffer.from('late'))]));
  await until(() => h.closes.length === 1, 'close');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.closes, [1003]);
}));

test('a binary frame closes with 1003 and invalid UTF-8 with 1007', () => withServer(async (h) => {
  const c1 = await connect(h);
  c1.socket.write(mask(2, Buffer.from([1])));
  await until(() => h.closes.length === 1, 'binary close');
  const c2 = await connect(h);
  c2.socket.write(mask(1, Buffer.from([0xff])));
  await until(() => h.closes.length === 2, 'utf8 close');
  assert.deepEqual(h.closes, [1003, 1007]);
}));

test('MAX_MESSAGE_BYTES is the relay text cap', () => {
  assert.equal(MAX_MESSAGE_BYTES, 1_572_864);
});

test('a frame pipelined in the upgrade head reaches listeners attached after acceptUpgrade returns', async () => {
  const { EventEmitter } = await import('node:events');
  const socket = Object.assign(new EventEmitter(), { write() {}, setNoDelay() {}, end() {}, destroy() {} });
  const hello = '{"type":"request","command":"host.hello"}';
  const conn = acceptUpgrade({ headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, socket, mask(1, Buffer.from(hello)));
  const got = [];
  conn.on('message', (t) => got.push(t));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [hello]);
});

test('a peer that stops reading is closed with 1013 once more than MAX_BUFFERED_BYTES are unsent', () => {
  assert.equal(MAX_BUFFERED_BYTES, 4 * 1024 * 1024);
  const socket = Object.assign(new EventEmitter(), {
    writableLength: 0, writes: 0,
    write(b) { this.writableLength += b.length; this.writes += 1; },
    end() {}, destroy() {},
  });
  const conn = new WsConnection(socket);
  const closes = [];
  conn.on('close', (c) => closes.push(c));
  const big = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 5; i++) conn.send(big); // the 5th finds more than 4 MiB queued
  assert.deepEqual(closes, [1013]);
  assert.equal(socket.writes, 5, 'four messages and one close frame, never the fifth message');
  conn.send(big);
  assert.equal(socket.writes, 5);
});
