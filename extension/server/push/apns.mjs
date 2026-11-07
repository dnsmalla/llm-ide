// APNs from the desktop core (push notifications plan): token-based auth (an ES256 provider JWT from the user's .p8
// key, kid = key id, iss = team id), HTTP/2 POST /3/device/<token> to one of two fixed Apple hosts. The socket dials
// only an address the classifier accepts (as server/pinned-fetch.mjs does for https). The only reviewed http2 path in
// extension/ (tests/provider-fetch-pinned-guard.test.mjs). Never log a device token or the key.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { es256Jwt } from './jwt.mjs';
import { systemResolver } from '../pinned-fetch.mjs';
import { ipRefusal } from '../ip-classifier.mjs';

export const APNS_TOPIC = 'dotsoft.llmide.com'; // ios_app PRODUCT_BUNDLE_IDENTIFIER
export const APNS_HOSTS = Object.freeze({ production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' });
export const APNS_ID_RE = /^[A-Z0-9]{10}$/;
export const JWT_MAX_AGE_MS = 50 * 60 * 1000; // Apple: no older than 60 min, refreshed no more than every 20 min
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
const GONE = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
const STALE_JWT = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

/** The .p8 key when it is an EC P-256 PKCS#8 private key, else null. */
export function apnsKeyOf(pem) {
  if (typeof pem !== 'string' || !pem || pem.length > 4096) return null;
  try {
    const k = crypto.createPrivateKey({ key: pem, format: 'pem' });
    return k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? k : null;
  } catch { return null; }
}

const jwtCache = new Map(); // `${teamId}:${keyId}` -> { jwt, at }
export function providerToken({ key, keyId, teamId }, now = Date.now(), { fresh = false } = {}) {
  const id = `${teamId}:${keyId}`;
  const c = jwtCache.get(id);
  if (!fresh && c && now - c.at < JWT_MAX_AGE_MS) return c.jwt;
  const jwt = es256Jwt({ kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) }, key);
  jwtCache.set(id, { jwt, at: now });
  return jwt;
}
export const _resetApnsForTests = () => jwtCache.clear();

function checkedLookup(hostname, options, cb) {
  const done = typeof options === 'function' ? options : cb;
  const all = typeof options === 'object' && options?.all;
  Promise.resolve(systemResolver(hostname)).then((list) => {
    const addrs = (Array.isArray(list) ? list : [list]).filter(Boolean);
    if (!addrs.length) return done(Object.assign(new Error(`could not resolve ${hostname}`), { code: 'ENOTFOUND' }));
    if (addrs.some((a) => ipRefusal(a.address))) return done(Object.assign(new Error('APNs host resolves to a refused address'), { code: 'SSRF_BLOCKED' }));
    const fam = (a) => a.family || (a.address.includes(':') ? 6 : 4);
    if (all) done(null, addrs.map((a) => ({ address: a.address, family: fam(a) })));
    else done(null, addrs[0].address, fam(addrs[0]));
  }, done);
}

const defaultConnect = (origin) => http2.connect(origin, { lookup: checkedLookup });

function outcome(status, body) {
  if (status === 200) return { ok: true };
  let reason = '';
  try { reason = String(JSON.parse(body)?.reason ?? ''); } catch { /* not JSON */ }
  if (!/^[A-Za-z]{1,40}$/.test(reason)) reason = '';
  if (status === 410 || GONE.has(reason)) return { gone: true };
  return { ok: false, code: `APNS_${status}${reason ? `_${reason}` : ''}`, ...(status === 403 && STALE_JWT.has(reason) ? { staleJwt: true } : {}) };
}

function post(session, { token, payload, jwt, collapseId, expiration, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = session.request({
        ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`, 'apns-topic': APNS_TOPIC,
        'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(expiration),
        'apns-collapse-id': collapseId, 'content-type': 'application/json',
      });
    } catch { return done({ ok: false, code: 'APNS_UNREACHABLE' }); }
    req.setTimeout(timeoutMs, () => { req.close(http2.constants.NGHTTP2_CANCEL); done({ ok: false, code: 'APNS_TIMEOUT' }); });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (d) => { if (body.length < 4096) body += d; });
    req.on('end', () => done(outcome(status, body)));
    req.on('error', () => done({ ok: false, code: 'APNS_UNREACHABLE' }));
    req.end(payload);
  });
}

/** One push. shortcut: one HTTP/2 connection per push, closed after; pool it if volume ever grows past a few per minute. */
export async function sendApns({ token, environment, payload, collapseId, credentials, now = Date.now(), connect = defaultConnect, timeoutMs = 10_000 }) {
  if (!Object.hasOwn(APNS_HOSTS, environment) || !TOKEN_RE.test(String(token))) return { ok: false, code: 'APNS_BAD_TARGET' };
  const session = connect(`https://${APNS_HOSTS[environment]}`);
  session.on('error', () => { /* reported by the request */ });
  const a = { token, payload, collapseId, expiration: Math.floor(now / 1000) + 3600, timeoutMs };
  try {
    let r = await post(session, { ...a, jwt: providerToken(credentials, now) });
    if (r.staleJwt) r = await post(session, { ...a, jwt: providerToken(credentials, now, { fresh: true }) });
    const rest = { ...r };
    delete rest.staleJwt;
    return rest;
  } finally {
    session.close();
  }
}
