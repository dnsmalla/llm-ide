// Loopback WebSocket path the desktop host uses to carry relay-delivered Host API frames into the gateway (relay plan
// ruling R-4/R-5). Only the host that spawned this core can open it (bus host proof); never a browser (no Origin).
// After the upgrade the session is an ordinary Host API session: hello, then PIN pairing or a device token.
import { handshakeRefusal, acceptUpgrade } from './ws-server.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { RELAY_TIER_SCOPES } from '../core/host-api-relay.mjs';

export const RELAY_BRIDGE_PATH = '/host-api/relay-bridge';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function bridgeRefusal(req, env = process.env) {
  if (req.url !== RELAY_BRIDGE_PATH) return 404;
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return 403;
  if (req.headers.origin !== undefined) return 403;
  if (!verifyBusHostProof(req, env)) return 403;
  if (!Object.hasOwn(RELAY_TIER_SCOPES, req.headers['x-llmide-relay-tier'] ?? '')) return 400;
  return handshakeRefusal(req);
}

export function attachRelayBridge(server, { ensureGateway, env = process.env, maxConnections = 8 }) {
  let nextId = 0;
  const live = new Set();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const status = bridgeRefusal(req, env) ?? (live.size >= maxConnections ? 503 : null);
    if (status) {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    socket.pause();
    ensureGateway().then((gateway) => {
      const conn = acceptUpgrade(req, socket, head);
      socket.resume();
      const session = { id: `relay-${++nextId}`, conn, relayTier: req.headers['x-llmide-relay-tier'] };
      live.add(conn);
      conn.on('message', (text) => gateway.receive(session, text));
      conn.on('close', () => { live.delete(conn); gateway.closed(session); });
      gateway.opened(session, socket.remoteAddress);
    }, () => socket.destroy());
  });
  return { close: () => { for (const c of live) { try { c.close(1001); } catch { /* closed */ } } } };
}
