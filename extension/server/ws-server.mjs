// Minimal RFC 6455 WebSocket server side (text messages only), dependency-free per the core's
// no-framework rule. Used only by the Host API v1 development listener. Client frames must be masked;
// binary frames, invalid UTF-8, oversize messages and protocol errors close the connection with the
// RFC close code. Messages are capped at MAX_MESSAGE_BYTES (the Host API frame cap).
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE_BYTES = 1048576;

export class WsError extends Error {
  constructor(code) { super(`websocket close ${code}`); this.code = code; }
}

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function handshakeRefusal(req) {
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return 400;
  if (req.headers['sec-websocket-version'] !== '13') return 426;
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 400;
  return null;
}

export function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const rsv = buf[0] & 0x70;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (rsv) throw new WsError(1002);
  if (!masked) throw new WsError(1002);
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new WsError(1009);
    len = Number(big); off = 10;
  }
  if (len > MAX_MESSAGE_BYTES) throw new WsError(1009);
  if (opcode >= 8 && (len > 125 || !fin)) throw new WsError(1002);
  if (buf.length < off + 4 + len) return null;
  const key = buf.subarray(off, off + 4);
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ key[i & 3];
  return { fin, opcode, payload, size: off + 4 + len };
}

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.partBytes = 0;
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006));
    socket.on('error', () => this.#finish(1006));
  }

  send(text) {
    if (this.closed) return;
    this.socket.write(encodeFrame(1, Buffer.from(String(text), 'utf8')));
  }

  close(code = 1000) {
    if (this.closed) return;
    const body = Buffer.alloc(2); body.writeUInt16BE(code, 0);
    this.socket.write(encodeFrame(8, body));
    this.socket.end();
    this.#finish(code);
  }

  #finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const f = readFrame(this.buffer);
        if (!f) return;
        this.buffer = this.buffer.subarray(f.size);
        this.#onFrame(f);
        if (this.closed) return;
      }
    } catch (err) {
      this.close(err instanceof WsError ? err.code : 1011);
    }
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === 9) { this.socket.write(encodeFrame(10, payload)); return; }
    if (opcode === 10) return;
    if (opcode === 8) { this.close(1000); return; }
    if (opcode === 2) throw new WsError(1003);
    if (opcode === 1) {
      if (this.parts.length) throw new WsError(1002);
    } else if (opcode === 0) {
      if (!this.parts.length) throw new WsError(1002);
    } else {
      throw new WsError(1002);
    }
    this.partBytes += payload.length;
    if (this.partBytes > MAX_MESSAGE_BYTES) throw new WsError(1009);
    this.parts.push(payload);
    if (!fin) return;
    const whole = Buffer.concat(this.parts);
    this.parts = []; this.partBytes = 0;
    let text;
    try { text = utf8.decode(whole); } catch { throw new WsError(1007); }
    this.emit('message', text);
  }
}

export function acceptUpgrade(req, socket, head) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const conn = new WsConnection(socket);
  if (head && head.length) socket.emit('data', head);
  return conn;
}
