// Host API v1 development listener: a loopback-only WebSocket endpoint in front of routes/host-api/gateway.mjs.
// Session handle = { id, conn }; the gateway's send/close deps are `sessionTransport` (spread into createGateway).
import http from 'node:http';
import { config } from '../core/config.mjs';
import { handshakeRefusal, acceptUpgrade } from './ws-server.mjs';

const PATH = '/host-api/v1';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const sessionTransport = {
  send: (s, text) => { try { s.conn.send(text); } catch { /* closed */ } },
  close: (s) => { try { s.conn.close(1000); } catch { /* closed */ } },
};

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(server.address().port); });
  });
}

export async function startHostApiListener({ gateway, basePort = 3016, candidates = 10, log = () => {}, webOrigins = config.hostApiWebOrigins }) {
  let nextId = 0;
  const live = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404, { 'Content-Length': 0 }).end(); });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const url = (req.url ?? '').split('?')[0];
    if (url !== PATH) return refuse(socket, 404, 'Not Found');
    if (!LOOPBACK.has(socket.remoteAddress)) return refuse(socket, 403, 'Forbidden');
    const origin = req.headers.origin;
    if (origin !== undefined && !webOrigins.includes(origin)) return refuse(socket, 403, 'Forbidden');
    const status = handshakeRefusal(req);
    if (status) return refuse(socket, status, 'Bad Request');
    const conn = acceptUpgrade(req, socket, head);
    const session = { id: ++nextId, conn };
    live.add(conn);
    conn.on('message', (text) => gateway.receive(session, text));
    conn.on('close', () => { live.delete(conn); gateway.closed(session); });
    gateway.opened(session, socket.remoteAddress);
  });

  let port = null;
  for (let i = 0; i < candidates && port === null; i++) {
    try { port = await listenOn(server, basePort === 0 ? 0 : basePort + i); } catch (e) {
      if (e.code !== 'EADDRINUSE' || i === candidates - 1) throw e;
    }
  }
  log(`Host API v1 listener on 127.0.0.1:${port}`);
  return {
    port,
    close: () => new Promise((resolve) => {
      for (const c of live) { try { c.close(1001); } catch { /* closed */ } }
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
