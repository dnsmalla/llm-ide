import { HttpError } from './http.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// nginx sets X-Real-IP to $remote_addr (overwriting any client value); trust it only from loopback.
export function clientIp(req, config) {
  const peer = req.socket.remoteAddress ?? '';
  const real = req.headers['x-real-ip'];
  if (config.trustProxy && LOOPBACK.has(peer) && typeof real === 'string' && real.length > 0 && real.length <= 45) return real;
  return peer;
}

export function checkOrigin(req, config) {
  if (req.headers.origin !== config.origin) throw new HttpError(403, 'bad_origin');
}

// Native clients (the desktop's OAuth token exchange and device registration) send no Origin at all.
// A browser still sends one, so a foreign Origin is refused exactly as for cookie routes.
export function checkOriginIfPresent(req, config) {
  if (req.headers.origin !== undefined && req.headers.origin !== config.origin) throw new HttpError(403, 'bad_origin');
}
