// The relay's upgrade gate at /relay/v1 (plan ruling R-2/R-3). No query string (tokens never in URLs), exact path,
// Origin either absent (native) or allowlisted (web), per-IP upgrade rate, socket caps, then the RFC 6455 handshake.
import { clientIp } from '../guard.mjs';
import { ipBucket } from '../rate-limit.mjs';
import { CLOSE, createHub, RELAY_LIMITS } from './hub.mjs';
import { acceptUpgrade, handshakeRefusal } from './ws.mjs';

export const RELAY_PATH = '/relay/v1';
export { CLOSE };

function refuse(socket, status) {
  socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function limitsFor(config, env) {
  if (config.prod) return RELAY_LIMITS;
  const n = (k, d) => (env[k] ? Number(env[k]) : d);
  return Object.freeze({ ...RELAY_LIMITS,
    authDeadlineMs: n('ACCOUNTS_RELAY_TEST_AUTH_DEADLINE_MS', RELAY_LIMITS.authDeadlineMs),
    envelopesPerMinute: n('ACCOUNTS_RELAY_TEST_ENVELOPES_PER_MIN', RELAY_LIMITS.envelopesPerMinute) });
}

export function attachRelay(server, ctx, env = process.env) {
  const hub = createHub(ctx, limitsFor(ctx.config, ctx.relayEnv ?? env));
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (req.url !== RELAY_PATH) return refuse(socket, 404);
    const origin = req.headers.origin;
    if (origin !== undefined && !ctx.config.relay.webOrigins.has(origin)) return refuse(socket, 403);
    const ip = clientIp(req, ctx.config);
    const ipKey = ipBucket(ip);
    try { ctx.limiter.hit(`relay-up:${ipKey}`, 30, 60_000); } catch { return refuse(socket, 429); }
    if (!hub.admit(ipKey)) return refuse(socket, 503);
    const bad = handshakeRefusal(req);
    if (bad) return refuse(socket, bad);
    hub.accept(acceptUpgrade(req, socket, head), { ip, ipKey, origin });
  });
  return hub;
}
