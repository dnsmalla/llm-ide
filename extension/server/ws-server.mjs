// Minimal RFC 6455 WebSocket server side (text messages only), dependency-free per the core's
// no-framework rule. Used only by the Host API v1 development listener. Client frames must be masked;
// binary frames, invalid UTF-8, oversize messages and protocol errors close the connection with the
// RFC close code. Messages are capped at MAX_MESSAGE_BYTES (the Host API frame cap).
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE_BYTES = 1048576;
const MAX_FRAGMENTS = 1024; // bounds parts[] even when fragments carry few bytes
const CLOSE_GRACE_MS = 1000; // peer gets this long to answer our close before the socket is destroyed
// A peer that stops reading must not make us buffer without limit: past this many unsent bytes the connection
// is closed with 1013 (try again later) instead of queueing the next message.
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export class WsError extends Error {
  constructor(code) { super(`websocket close ${code}`); this.code = code; }
}

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function handshakeRefusal(req) {
  if (req.method !== 'GET') return 405;
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return 400;
  const tokens = String(req.headers.connection || '').split(',').map((t) => t.trim().toLowerCase());
  if (!tokens.includes('upgrade')) return 400;
  if (req.headers['sec-websocket-version'] !== '13') return 426;
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 400;
  return null;
}

// Validates a frame header. Returns null while the header itself is incomplete; throws on protocol errors
// as soon as they are visible, so an oversize or malformed frame is refused before its body is buffered.
function frameLayout(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  if (b0 & 0x70) throw new WsError(1002);
  if (!(b1 & 0x80)) throw new WsError(1002);
  let len = b1 & 0x7f;
  let off = 2;
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
  const opcode = b0 & 0x0f;
  if (opcode >= 8 && (len > 125 || !(b0 & 0x80))) throw new WsError(1002);
  return { fin: (b0 & 0x80) !== 0, opcode, off, len, total: off + 4 + len };
}

function unmask(buf, h) {
  const key = buf.subarray(h.off, h.off + 4);
  const payload = Buffer.allocUnsafe(h.len);
  for (let i = 0; i < h.len; i++) payload[i] = buf[h.off + 4 + i] ^ key[i & 3];
  return { fin: h.fin, opcode: h.opcode, payload, size: h.total };
}

export function readFrame(buf) {
  const h = frameLayout(buf);
  return h && buf.length >= h.total ? unmask(buf, h) : null;
}

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Close codes a peer may legally send (RFC 6455 section 7.4).
function validPeerCloseCode(c) {
  return (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1011) || (c >= 3000 && c <= 4999);
}

export class WsConnection extends EventEmitter {
  #closeTimer = null;

  constructor(socket) {
    super();
    this.socket = socket;
    this.chunks = [];   // unparsed input; concatenated only once `need` bytes have arrived
    this.pending = 0;
    this.need = 0;
    this.parts = [];    // fragments of the message being assembled
    this.partBytes = 0;
    this.closed = false;
    this.lastHeard = Date.now(); // any inbound bytes (a pong included): the listener's liveness check reads it
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('end', () => socket.destroy());
    socket.on('close', () => { clearTimeout(this.#closeTimer); this.#finish(1006); });
    socket.on('error', () => this.#finish(1006));
  }

  send(text) {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_BUFFERED_BYTES) { this.close(1013); return; }
    this.socket.write(encodeFrame(1, Buffer.from(String(text), 'utf8')));
  }

  /** Sends an empty ping; a live peer answers with a pong, which refreshes lastHeard. */
  ping() {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_BUFFERED_BYTES) { this.close(1013); return; }
    this.socket.write(encodeFrame(9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.closed) return;
    // 1005/1006/1015 are reserved for local reporting and must never be put on the wire.
    const wire = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    const body = Buffer.alloc(2); body.writeUInt16BE(wire, 0);
    this.socket.write(encodeFrame(8, body));
    this.socket.end();
    this.chunks = []; this.pending = 0; this.need = 0; this.parts = []; this.partBytes = 0;
    this.#closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS);
    this.#closeTimer.unref();
    this.#finish(wire);
  }

  #finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }

  #onData(chunk) {
    if (this.closed) return;
    this.lastHeard = Date.now();
    this.chunks.push(chunk);
    this.pending += chunk.length;
    if (this.pending < this.need) return;
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.pending);
    this.chunks = []; this.pending = 0; this.need = 0;
    try {
      for (;;) {
        const h = frameLayout(buf);
        if (!h || buf.length < h.total) {
          this.need = h ? h.total : 2;
          if (buf.length) { this.chunks.push(buf); this.pending = buf.length; }
          return;
        }
        const frame = unmask(buf, h);
        buf = buf.subarray(h.total);
        this.#onFrame(frame);
        if (this.closed) return;
      }
    } catch (err) {
      this.close(err instanceof WsError ? err.code : 1011);
    }
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === 8) return this.#onPeerClose(payload);
    if (opcode === 9) { this.socket.write(encodeFrame(10, payload)); return; }
    if (opcode === 10) return;
    if (opcode === 2) throw new WsError(1003);
    if (opcode !== 0 && opcode !== 1) throw new WsError(1002);
    // A new message may start only when none is pending; a continuation only when one is.
    if ((opcode === 1) === (this.parts.length > 0)) throw new WsError(1002);
    // Empty non-final fragments carry no bytes, so they are refused rather than counted.
    if (!fin && payload.length === 0) throw new WsError(1002);
    if (this.parts.length >= MAX_FRAGMENTS) throw new WsError(1009);
    this.partBytes += payload.length;
    if (this.partBytes > MAX_MESSAGE_BYTES) throw new WsError(1009);
    this.parts.push(payload);
    if (!fin) return;
    const whole = this.parts.length === 1 ? payload : Buffer.concat(this.parts, this.partBytes);
    this.parts = []; this.partBytes = 0;
    let text;
    try { text = utf8.decode(whole); } catch { throw new WsError(1007); }
    this.emit('message', text);
  }

  #onPeerClose(payload) {
    if (payload.length === 1) throw new WsError(1002);
    let code = 1000;
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validPeerCloseCode(code)) throw new WsError(1002);
    }
    this.close(code);
  }
}

export function acceptUpgrade(req, socket, head) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const conn = new WsConnection(socket);
  // Replayed on the next tick: the caller attaches its listeners after this returns, and a pipelined first frame
  // (a hello) in `head` would otherwise be parsed and emitted to nobody. nextTick still runs before later socket data.
  if (head && head.length) process.nextTick(() => socket.emit('data', head));
  return conn;
}
