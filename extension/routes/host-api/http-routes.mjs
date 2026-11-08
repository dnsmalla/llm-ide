// Host-only HTTP routes of the Host API v1 desktop adapter (contract schema/http/host-api.schema.json). Registered by
// server.mjs after authenticate and the rate limiter; nothing else imports it. Every route needs the JWT (req.user)
// and, outside hub mode, the bus host proof, so only the desktop UI the Tauri host spawned this core for can mint a
// PIN or manage devices. In hub mode (ADR 0021) the proof cannot exist — no desktop spawned this core — so the
// member's `member` team role is the authority instead (a viewer is refused ROLE_DENIED).
//
//   POST   /host-api/pin           { pin, expiresAt, port, fingerprint, addresses }   mint the user's one-use 10-minute
//                                   pairing PIN (fingerprint: the TLS listener's certificate pin, null for the dev
//                                   listener; addresses: this computer's IPv4s for the pairing QR, [] unless TLS)
//   GET    /host-api/devices       { devices: [...] }         the user's paired devices (never a token)
//   DELETE /host-api/devices/:id   { revoked }                revoke one device and drop its live sessions
//
// Order: proof/role first (403 HOST_PROOF_REQUIRED or ROLE_DENIED), then the flag (404 HOST_API_DISABLED), so an
// unproven caller learns nothing about the flag. The PIN is returned once and never logged.
import { networkInterfaces } from 'node:os';
import { send, readJson } from '../../server/route-http.mjs';
import { sendError } from '../../core/errors.mjs';
import { config } from '../../core/config.mjs';
import { logger } from '../../core/logger.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import fs from 'node:fs';
import { requireRole } from '../../server/auth.mjs';
import { getDb } from '../../kb/db.mjs';
import { mintPin } from './pin.mjs';
import { listDevices, revokeDevice } from '../../kb/host-api-devices.mjs';
import { sharedAuditSink } from './audit.mjs';
import { hostApiCapabilities } from './gateway.mjs';
import { isPushKind } from '../../server/push/kinds.mjs';
import { dispatchPush, pushGate, pushStatus, apnsStatus, setApnsCredentials, clearApnsCredentials } from './push.mjs';

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

async function route(req, res, { hostApi = () => null, enabled = config.hostApiMode !== 'off', hub = config.hub, env = process.env, audit = sharedAuditSink, interfaces = networkInterfaces, pushDeps = {} }) {
  const path = String(req.url || '').split('?')[0];
  const userId = req.user?.id;
  if (hub) {
    // ADR 0021 hub: no desktop spawned this core, so there is no host proof to present. The member's own JWT plus
    // the `member` team role (an engineer or above) is the authority to pair a phone or browser. A viewer stays
    // Ask-only; the role is read from `members` on every request, never the JWT.
    try { requireRole(getDb(), req, 'member'); } catch (e) {
      return fail(res, e.status ?? 403, e.code ?? 'ROLE_DENIED', e.message);
    }
  } else if (!verifyBusHostProof(req, env)) {
    return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  }
  if (!enabled) return fail(res, 404, 'HOST_API_DISABLED', 'Host API is not enabled on this core');
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');

  if (req.method === 'POST' && path === '/host-api/pin') {
    const api = hostApi();
    const port = api?.listener?.port ?? null;
    if (!port) return fail(res, 503, 'HOST_API_UNAVAILABLE', 'The Host API listener is not running');
    const { pin, expiresAt } = mintPin(userId);
    if (hub) {
      // P4.2: the hub's v1 listener is plaintext on loopback; the public origin is nginx, and the pin is the
      // front certificate's leaf SPKI (written by the deploy). A missing/malformed file is a hard 503.
      const fingerprint = frontPin();
      const url = hubPublicUrl();
      if (!fingerprint || !url) return fail(res, 503, 'HUB_PIN_UNAVAILABLE', 'The hub certificate pin or public URL is not configured');
      const host = new URL(url).hostname;
      send(res, 200, { pin, expiresAt, port: 443, fingerprint, addresses: [host], url });
      return true;
    }
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
  if (path.startsWith('/host-api/push/')) return pushRoute(req, res, path, userId, { env, audit, pushDeps });
  return fail(res, 404, 'NOT_FOUND', 'No such Host API route');
}

const PIN_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const HUB_URL_RE = /^wss:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/host-api\/v1$/;

/** The front certificate's leaf SPKI, read from the root-owned file written by the deploy. */
export function frontPin(file = config.hostApiFingerprintFile) {
  if (!file) return null;
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return PIN_RE.test(value) ? value : null;
  } catch { return null; }
}

/** The public WSS URL of the hub listener, validated; null when unset or not a v1 URL. */
export function hubPublicUrl(value = config.hostApiPublicUrl) {
  return typeof value === 'string' && HUB_URL_RE.test(value) ? value : null;
}

const PUSH_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const bodyOf = async (req) => { try { return await readJson(req, 16 * 1024); } catch { return null; } };
async function pushRoute(req, res, path, userId, { env, audit, pushDeps }) {
  const served = hostApiCapabilities(env).includes('push');
  if (req.method === 'POST' && path === '/host-api/push/send') {
    const b = await bodyOf(req);
    if (!b || !isPushKind(b.kind)) return fail(res, 400, 'VALIDATION_FAILED', 'Unknown push kind');
    if (b.key != null && !(typeof b.key === 'string' && PUSH_KEY_RE.test(b.key))) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid push key');
    if (b.count != null && !(Number.isInteger(b.count) && b.count >= 1 && b.count <= 999)) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid push count');
    const out = await dispatchPush(userId, { kind: b.kind, key: b.key ?? null, count: b.count ?? 1 }, { gate: pushGate, served, log: (m) => logger.info('host_api_push', { message: m }), ...pushDeps });
    send(res, 200, { sent: out.sent }); return true;
  }
  if (req.method === 'GET' && path === '/host-api/push/status') { send(res, 200, pushStatus(userId, served)); return true; }
  if (req.method === 'PUT' && path === '/host-api/push/apns') {
    const r = setApnsCredentials(userId, (await bodyOf(req)) ?? {});
    if (!r.ok) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${r.field}`);
    audit().record('push_apns_set', { peer: req.socket?.remoteAddress, userId, detail: `key ${r.keyId}` });
    send(res, 200, apnsStatus(userId)); return true;
  }
  if (req.method === 'DELETE' && path === '/host-api/push/apns') {
    clearApnsCredentials(userId); audit().record('push_apns_removed', { peer: req.socket?.remoteAddress, userId }); send(res, 200, apnsStatus(userId)); return true;
  }
  return fail(res, 404, 'NOT_FOUND', 'No such Host API route');
}
