// Host-only HTTP routes of the Host API v1 desktop adapter (contract schema/http/host-api.schema.json). Registered by
// server.mjs after authenticate and the rate limiter; nothing else imports it. Every route needs the JWT (req.user) AND
// the bus host proof, so only the desktop UI the Tauri host spawned this core for can mint a PIN or manage devices.
//
//   POST   /host-api/pin           { pin, expiresAt, port, fingerprint, addresses }   mint the user's one-use 10-minute
//                                   pairing PIN (fingerprint: the TLS listener's certificate pin, null for the dev
//                                   listener; addresses: this computer's IPv4s for the pairing QR, [] unless TLS)
//   GET    /host-api/devices       { devices: [...] }         the user's paired devices (never a token)
//   DELETE /host-api/devices/:id   { revoked }                revoke one device and drop its live sessions
//
// Order: proof first (403 HOST_PROOF_REQUIRED), then the flag (404 HOST_API_DISABLED), so an unproven caller learns
// nothing about the flag. The PIN is returned once and never logged.
import { networkInterfaces } from 'node:os';
import { send } from '../../server/route-http.mjs';
import { sendError } from '../../core/errors.mjs';
import { config } from '../../core/config.mjs';
import { logger } from '../../core/logger.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import { mintPin } from './pin.mjs';
import { listDevices, revokeDevice } from '../../kb/host-api-devices.mjs';
import { sharedAuditSink } from './audit.mjs';

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (res, status, code, message) => { send(res, status, { error: { code, message } }); return true; };

const isTailscale = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
const VIRTUAL_IFACE_RE = /^(docker|br-|veth|vmnet|vboxnet|virbr|vEthernet)/i;

/** The IPv4s a phone can dial for the pairing QR, best first: Tailscale (100.64.0.0/10, works across networks, as the
 *  Mac prefers it), then LAN, then container/VM bridges. Never loopback, link-local 169.254 or IPv6. */
export function pairingAddresses(ifaces = networkInterfaces()) {
  const rank = (name, ip) => (isTailscale(ip) ? 0 : VIRTUAL_IFACE_RE.test(name) ? 2 : 1);
  const out = [];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    for (const a of list ?? []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, r: rank(name, a.address) });
    }
  }
  return [...new Set(out.sort((x, y) => x.r - y.r).map((x) => x.ip))];
}

export function isHostApiRoute(url) {
  const path = String(url || '').split('?')[0];
  return path === '/host-api' || path.startsWith('/host-api/');
}

/** `hostApi()` returns the running { gateway, listener, fingerprint } or null; `enabled` defaults to a v1 listener
 *  mode being on, TLS or dev (test seam); `interfaces` is os.networkInterfaces (test seam);
 *  `logger` is the request logger (server.mjs passes reqLog), so a 500 is logged like every other route's. */
export async function handleHostApiRoute(req, res, opts = {}) {
  // A store failure (listDevices, revokeDevice) must still answer: the standard JSON 500 envelope.
  try { return await route(req, res, opts); } catch (err) {
    if (!res.headersSent) sendError(res, err, { logger: opts.logger ?? logger });
    else { (opts.logger ?? logger).error('request_failed', { message: err.message, stack: err.stack }); res.end(); }
    return true;
  }
}

async function route(req, res, { hostApi = () => null, enabled = config.hostApiMode !== 'off' || config.hostApiRelay, env = process.env, audit = sharedAuditSink, interfaces = networkInterfaces }) {
  const path = String(req.url || '').split('?')[0];
  const userId = req.user?.id;
  if (!verifyBusHostProof(req, env)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  if (!enabled) return fail(res, 404, 'HOST_API_DISABLED', 'Host API is not enabled on this core');
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');

  if (req.method === 'POST' && path === '/host-api/pin') {
    const api = hostApi();
    // Relay mode has no listener: pairing happens over the relay bridge on the main core port.
    const port = api?.listener?.port ?? (config.hostApiRelay ? config.port : null);
    if (!port) return fail(res, 503, 'HOST_API_UNAVAILABLE', 'The Host API listener is not running');
    const { pin, expiresAt } = mintPin(userId);
    const fingerprint = api.fingerprint ?? null;
    // Addresses only with TLS: the dev listener is loopback-only, and a plaintext host is never offered to a phone.
    send(res, 200, { pin, expiresAt, port, fingerprint, addresses: fingerprint ? pairingAddresses(interfaces()) : [] });
    return true;
  }
  if (req.method === 'GET' && path === '/host-api/devices') {
    send(res, 200, { devices: listDevices(userId) });
    return true;
  }
  if (req.method === 'DELETE' && path.startsWith('/host-api/devices/')) {
    let id;
    try { id = decodeURIComponent(path.slice('/host-api/devices/'.length)); } catch { id = ''; }
    if (!DEVICE_ID_RE.test(id)) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid device id');
    const revoked = revokeDevice(userId, id);
    if (revoked) audit().record('revoke_host', { peer: req.socket?.remoteAddress, userId, deviceId: id });
    // Drop live sessions either way: disconnectDevice is per user, so another user's id closes nothing.
    try { hostApi()?.gateway?.disconnectDevice(userId, id); } catch { /* best effort */ }
    send(res, 200, { revoked });
    return true;
  }
  return fail(res, 404, 'NOT_FOUND', 'No such Host API route');
}
