// Host API v1 `push.register` checks beyond the schema (push notifications plan): exactly one target shape per kind,
// a web endpoint on a known browser push service, real P-256 subscription keys. Pure.
import { pushEndpoint } from '../../server/push/webpush.mjs';
const P256 = /^[A-Za-z0-9_-]{87}$/;
const AUTH = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[0-9a-f]{64,200}$/;
const refuse = (message) => ({ ok: false, message });
export function pushTargetOf(p) {
  if (p?.kind === 'webpush') {
    if (p.token !== undefined || p.environment !== undefined) return refuse('A web push registration carries no APNs token.');
    if (!pushEndpoint(p.endpoint)) return refuse('That push endpoint is not a known browser push service.');
    if (!P256.test(p.p256dh ?? '') || Buffer.from(p.p256dh, 'base64url')[0] !== 4 || !AUTH.test(p.auth ?? '')) return refuse('The subscription keys are not valid.');
    return { ok: true, target: { kind: 'webpush', endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth } };
  }
  if (p?.kind === 'apns') {
    if (p.endpoint !== undefined || p.p256dh !== undefined || p.auth !== undefined) return refuse('An APNs registration carries only a token and an environment.');
    if (!TOKEN.test(p.token ?? '') || (p.environment !== 'sandbox' && p.environment !== 'production')) return refuse('The device token or environment is not valid.');
    return { ok: true, target: { kind: 'apns', token: p.token, environment: p.environment } };
  }
  return refuse('Unknown push kind.');
}
