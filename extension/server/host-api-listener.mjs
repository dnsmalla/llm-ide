// Host API v1 listener in front of routes/host-api/gateway.mjs. With `tls` it serves pinned TLS (WSS) on every
// interface; without it, the development plaintext listener on loopback only, refusing non-loopback peers.
// Session handle = { id, conn }; the gateway's send/close deps are `sessionTransport` (spread into createGateway).
import http from 'node:http';
import https from 'node:https';
import { config } from '../core/config.mjs';
import { originRefused } from '../core/host-api-origins.mjs';
import { handshakeRefusal, acceptUpgrade } from './ws-server.mjs';

const PATH = '/host-api/v1';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Bounds for the TLS listener, which an unpaired LAN peer can reach in the same process as the main server and
 *  SQLite: a socket must finish TLS and send its upgrade within 10 s, and at most 32 sockets are open at once
 *  (the gateway's 4-session cap and 10 s auth timeout only start after the upgrade). */
export const LISTENER_LIMITS = Object.freeze({ handshakeTimeoutMs: 10_000, maxConnections: 32, requestTimeoutMs: 10_000 });

/** Liveness: every open connection is pinged this often, and closed once nothing (pong or frame) arrived for
 *  LIVENESS_MISSED_INTERVALS intervals, so a peer gone without a FIN (phone off Wi-Fi) frees its gateway session. */
export const LIVENESS_PING_MS = 30_000;
export const LIVENESS_MISSED_INTERVALS = 2;

export const sessionTransport = {
  send: (s, text) => { try { s.conn.send(text); } catch { /* closed */ } },
  close: (s) => { try { s.conn.close(1000); } catch { /* closed */ } },
};

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** The refusal for an upgrade request before the WebSocket handshake check, or null. `event` names the audit
 *  event (null for a wrong path). Plaintext refuses every non-loopback peer; TLS accepts any peer that pinned it.
 *  The plaintext listener honours only the loopback http:// entries: https:// entries exist for the TLS listener. */
export function upgradeRefusal(req, { tls, hub = false, allowlist }) {
  if (!tls && !hub) allowlist = allowlist.filter((o) => o.startsWith('http://'));
  // Behind the hub's TLS terminator the socket peer is always nginx (loopback); the front must say https.
  if (hub && req.headers['x-forwarded-proto'] !== 'https') return { status: 403, event: 'plaintext_refused', detail: '' };
  if ((req.url ?? '').split('?')[0] !== PATH) return { status: 404, event: null, detail: '' };
  if (!tls && !LOOPBACK.has(req.socket?.remoteAddress)) return { status: 403, event: 'plaintext_refused', detail: '' };
  if (originRefused(req.headers, allowlist)) {
    return { status: 403, event: 'origin_refused', detail: String(req.headers.origin ?? '').slice(0, 200) };
  }
  return null;
}

/** The client address for throttles/audit. Behind the hub's nginx every socket peer is 127.0.0.1; the
 *  rightmost X-Forwarded-For is the address nginx appended (never a client-supplied left entry). */
export function clientPeer(req, { hub = false } = {}) {
  const socketPeer = req.socket?.remoteAddress ?? '-';
  if (!hub || !LOOPBACK.has(socketPeer)) return socketPeer;
  const xff = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!xff.length) return socketPeer;
  const last = xff[xff.length - 1];
  // Keep the key bounded and header-safe; a malformed value is not a usable identity.
  return last.length <= 64 && [...last].every((c) => /[0-9A-Fa-f:.]/.test(c)) ? last : socketPeer;
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => { server.off('error', onError); resolve(server.address().port); });
  });
}

export async function startHostApiListener({ gateway, tls = null, hub = false, basePort = 3016, candidates = 10, log = () => {},
  onRefused = () => {}, originAllowlist = config.hostApiWebOrigins, limits = LISTENER_LIMITS, pingIntervalMs = LIVENESS_PING_MS }) {
  let nextId = 0;
  const live = new Set();
  const notFound = (req, res) => { res.writeHead(404, { 'Content-Length': 0 }).end(); };
  const host = tls ? '0.0.0.0' : '127.0.0.1';
  const server = tls
    ? https.createServer({ cert: tls.certPem, key: tls.keyPem, minVersion: 'TLSv1.2', handshakeTimeout: limits.handshakeTimeoutMs }, notFound)
    : http.createServer(notFound);
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = limits.requestTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;

  if (tls) {
    // A pin mismatch shows up here as the client aborting the handshake. Logged by code only, once per peer per minute.
    const seen = new Map();
    server.on('tlsClientError', (err, socket) => {
      const peer = socket?.remoteAddress ?? '-';
      const now = Date.now();
      if (now - (seen.get(peer) ?? -Infinity) < 60_000) return;
      if (seen.size > 1000) seen.clear();
      seen.set(peer, now);
      log(`Host API v1 TLS handshake failed from ${peer}: ${err?.code ?? 'unknown'}`);
    });
  }

  const liveness = setInterval(() => {
    const now = Date.now();
    for (const c of live) {
      if (now - c.lastHeard >= LIVENESS_MISSED_INTERVALS * pingIntervalMs) {
        log('Host API v1 connection silent past its ping deadline — closing');
        try { c.close(1001); } catch { /* closed */ }
      } else {
        try { c.ping(); } catch { /* closed */ }
      }
    }
  }, pingIntervalMs);
  liveness.unref();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const why = upgradeRefusal(req, { tls: !!tls, hub, allowlist: originAllowlist });
    if (why) {
      if (why.event) onRefused(why.event, socket.remoteAddress ?? '-', why.detail);
      return refuse(socket, why.status, why.status === 404 ? 'Not Found' : 'Forbidden');
    }
    const status = handshakeRefusal(req);
    if (status) return refuse(socket, status, 'Bad Request');
    const conn = acceptUpgrade(req, socket, head);
    const session = { id: ++nextId, conn };
    live.add(conn);
    conn.on('message', (text) => gateway.receive(session, text));
    conn.on('close', () => { live.delete(conn); gateway.closed(session); });
    gateway.opened(session, clientPeer(req, { hub }));
  });

  let port = null;
  for (let i = 0; i < candidates && port === null; i++) {
    try { port = await listenOn(server, basePort === 0 ? 0 : basePort + i, host); } catch (e) {
      if (e.code !== 'EADDRINUSE' || i === candidates - 1) { clearInterval(liveness); throw e; }
    }
  }
  log(`Host API v1 listener (${tls ? 'TLS' : 'development plaintext'}) on ${host}:${port}`);
  return {
    port,
    address: host,
    close: () => new Promise((resolve) => {
      clearInterval(liveness);
      for (const c of live) { try { c.close(1001); } catch { /* closed */ } }
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
