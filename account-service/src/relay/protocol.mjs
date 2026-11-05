// Closed-schema parsing of client → relay messages (schema/relay/v1/README.md). Unknown types or fields are refused,
// never ignored. The relay cannot verify envelope crypto (it holds no keys); it checks shape only.
export class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const UP = new Set(['open', 'request', 'keyconfirm']);
const DOWN = new Set(['opened', 'reply', 'wrap']);
const ENV_KEYS = new Set(['v', 'purpose', 'userId', 'desktopId', 'from', 'to', 'epoch', 'session', 'seq', 'issuedAt', 'tier', 'nonce', 'ct', 'sig', 'eph']);
const MAX_CT = 1_398_200; // base64url of 1 MiB + 16-byte tag

const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const b64len = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && B64.test(s);
const fail = (code) => { throw new ProtocolError(code); };

export const isUp = (purpose) => UP.has(purpose);

function only(obj, keys) {
  for (const k of Object.keys(obj)) if (!keys.has(k)) fail('invalid_message');
}

export function envelope(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) fail('invalid_message');
  only(e, ENV_KEYS);
  if (e.v !== 1) fail('invalid_message');
  if (!UP.has(e.purpose) && !DOWN.has(e.purpose)) fail('invalid_message');
  for (const k of ['userId', 'desktopId', 'from', 'to']) if (typeof e[k] !== 'string' || !ID.test(e[k])) fail('invalid_message');
  for (const k of ['epoch', 'seq', 'issuedAt']) if (!uint(e[k])) fail('invalid_message');
  if (!(e.session === '' || b64len(e.session, 22, 22))) fail('invalid_message');
  if (!['', 'web', 'ios'].includes(e.tier)) fail('invalid_message');
  if (!b64len(e.nonce, 16, 16) || !b64len(e.ct, 1387, MAX_CT) || !b64len(e.sig, 86, 86)) fail('invalid_message');
  if (e.purpose === 'wrap' ? !b64len(e.eph, 80, 256) : e.eph !== undefined) fail('invalid_message');
  return e;
}

export function parseClient(text) {
  let m;
  try { m = JSON.parse(text); } catch { fail('invalid_message'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('invalid_message');
  if (m.t === 'auth') {
    only(m, new Set(['t', 'token', 'proof']));
    if (!b64len(m.token, 43, 43) || !b64len(m.proof, 86, 86)) fail('invalid_message');
    return m;
  }
  if (m.t === 'pong') { only(m, new Set(['t'])); return m; }
  if (m.t === 'env') { only(m, new Set(['t', 'env'])); return { t: 'env', env: envelope(m.env) }; }
  fail('invalid_message');
}
