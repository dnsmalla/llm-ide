// Minimal masked WebSocket client for relay tests (the service parser is server-side only).
import http from 'node:http';
import { randomBytes, sign } from 'node:crypto';

function parse(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 0x7f; let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len), size: off + len };
}

function masked(payload) {
  const mask = randomBytes(4); const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.from(payload);
  for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

function client(socket, head) {
  const inbox = []; const waiters = []; let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0); let code = null;
  const push = (m) => { const w = waiters.shift(); if (w) w(m); else inbox.push(m); };
  const drain = () => {
    for (let f = parse(buf); f; f = parse(buf)) {
      buf = buf.subarray(f.size);
      if (f.opcode === 1) push(JSON.parse(f.payload.toString('utf8')));
      if (f.opcode === 8) { code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005; push({ t: '__closed', code }); }
    }
  };
  socket.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
  socket.on('close', () => { if (code === null) push({ t: '__closed', code: 1006 }); });
  drain();
  return {
    send(obj) { socket.write(masked(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))); },
    next(ms = 2000) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    close() { socket.destroy(); },
  };
}

export function wsConnect(base, { origin, path = '/relay/v1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...(origin ? { origin } : {}) } });
    req.on('upgrade', (_res, socket, head) => resolve(client(socket, head)));
    req.on('response', (res) => { res.resume(); resolve({ refused: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

export async function authed(base, { token, signingKey, role, tokenHash, origin }) {
  const ws = await wsConnect(base, { origin });
  const challenge = await ws.next();
  const msg = Buffer.from(`llmide/relay/auth/v1\n${challenge.nonce}\n${role}\n${tokenHash}`);
  ws.send({ t: 'auth', token, proof: sign('sha256', msg, { key: signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
  return { ws, ready: await ws.next() };
}

export const fakeEnv = (over) => ({ v: 1, purpose: 'request', epoch: 1, session: 'AAAAAAAAAAAAAAAAAAAAAA', seq: 1, issuedAt: 1, tier: '', nonce: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(1387), sig: 'A'.repeat(86), ...over });
