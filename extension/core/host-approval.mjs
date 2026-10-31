// Host-signed approval tokens, the core half (docs/spec/api-server.md "Host approval", desktop/PACKAGING.md).
//
// Format v2 (current). The Tauri host mints `v2.<expiry_ms>.<nonce_hex32>.<mac_hex64>` after a native Cancel-first
// dialog, where
//   mac = HMAC-SHA256(key, "llmide-host-approval/v2|<purpose>|<expiry_ms>|<nonce_hex32>")
// and `key` is the hex-decoded LLMIDE_HOST_APPROVAL_KEY the host passes ONLY to the core it spawned. The purpose of a
// Bypass approval is `bypass:<chatId>`: the token is BOUND TO ONE CHAT (chatId matches CHAT_ID_RE, so the `|` separator
// can never be smuggled into the signed text). It carries no user id and no core nonce: the key is per launch and per
// spawned core, so a token can never work on another core, and it is 60 s and single use.
//
// Format v1 (legacy, `v1.<expiry>.<nonce>.<mac>` over "llmide-host-approval/v1|bypass|..."): not bound to a chat. Accepted
// ONLY when LLMIDE_HOST_APPROVAL_COMPAT=1 (default off) for a host that has not been updated yet.
//
// Verifier rules: strict shape, constant-time MAC compare, expiry in (now, now + 60 s + 5 s skew], the nonce is
// remembered until expiry (single use; a bounded in-memory map that fails closed when full). The key and tokens are
// secrets: nothing here logs or returns them.
import crypto from 'node:crypto';

export const HOST_APPROVAL_HEADER = 'x-llmide-host-approval';
export const TOKEN_TTL_MS = 60_000;
export const CLOCK_SKEW_MS = 5_000;
export const MAX_USED_NONCES = 4096;

/** True when the core was started by the host (the env var is present and non-empty). */
export function hostApprovalEnabled(env = process.env) {
  return typeof env.LLMIDE_HOST_APPROVAL_KEY === 'string' && env.LLMIDE_HOST_APPROVAL_KEY.length > 0;
}

/** The key bytes, or null when the value is not 64 hex characters (fail closed: nothing then verifies). */
export function hostApprovalKey(env = process.env) {
  const v = env.LLMIDE_HOST_APPROVAL_KEY;
  return typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : null;
}

// ---- command-bus host proof ----
// A bearer secret DERIVED from the approval key: proof = hex(HMAC-SHA256(key, "bus-host-proof/v1")). The host sends it as
// `x-llmide-host-nonce` ONLY to the core it spawned; the core accepts a declared client class above `extension` only with
// it. It is NOT the /health identity nonce (LLMIDE_CORE_NONCE): that one is served unauthenticated, so it can identify a
// core but must never act as a credential. The proof is equal in power to the approval key for bus approvals, so it must
// never be logged, stored or sent to an adopted core. One proof per launch (the key is per launch).
export const BUS_PROOF_HEADER = 'x-llmide-host-nonce';
export const BUS_PROOF_LABEL = 'bus-host-proof/v1';
const BUS_PROOF_RE = /^[0-9a-f]{64}$/;

/** The expected proof (64 hex), or null when the key is unset or malformed (nothing then verifies). */
export function busHostProof(env = process.env) {
  const key = hostApprovalKey(env);
  return key ? crypto.createHmac('sha256', key).update(BUS_PROOF_LABEL).digest('hex') : null;
}

/** Constant-time check of the request's proof header; false for an absent, repeated or malformed header. */
export function verifyBusHostProof(req, env = process.env) {
  const want = busHostProof(env);
  const got = req.headers?.[BUS_PROOF_HEADER];
  if (!want || typeof got !== 'string' || !BUS_PROOF_RE.test(got)) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

const TOKEN_RE = /^(v1|v2)\.(\d{1,15})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
/** A chat id a Bypass token can be bound to (the host refuses others). */
export const CHAT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const bypassPurpose = (chatId) => `bypass:${chatId}`;

export function signedPart(purpose, expiry, nonce, version = 'v2') {
  return `llmide-host-approval/${version}|${purpose}|${expiry}|${nonce}`;
}

export function createHostApprovalVerifier({ now = Date.now } = {}) {
  const used = new Map(); // nonce -> expiry
  return {
    /**
     * True at most once per valid, unexpired token for `purpose` (v2: the full purpose, `bypass:<chatId>`). A v1 token
     * has no chat binding: it is accepted only with `compat` and only for a `bypass:` purpose (it signed plain `bypass`).
     */
    verify(token, key, purpose, { compat = false } = {}) {
      if (typeof token !== 'string' || token.length > 200 || !Buffer.isBuffer(key) || typeof purpose !== 'string') return false;
      const m = TOKEN_RE.exec(token);
      if (!m) return false;
      const version = m[1];
      let signedPurpose = purpose;
      if (version === 'v1') {
        if (!compat || !purpose.startsWith('bypass:')) return false;
        signedPurpose = 'bypass';
      } else if (purpose.includes('|')) return false;
      const expiry = Number(m[2]);
      const nonce = m[3];
      const t = now();
      if (!Number.isSafeInteger(expiry) || t >= expiry || expiry > t + TOKEN_TTL_MS + CLOCK_SKEW_MS) return false;
      const want = crypto.createHmac('sha256', key).update(signedPart(signedPurpose, expiry, nonce, version)).digest();
      const got = Buffer.from(m[4], 'hex');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
      for (const [n, e] of used) if (e <= t) used.delete(n);
      if (used.has(nonce) || used.size >= MAX_USED_NONCES) return false;
      used.set(nonce, expiry);
      return true;
    },
    _size: () => used.size,
  };
}

/** The process-wide verifier (the used-nonce set must outlive one request). */
export const hostApprovalVerifier = createHostApprovalVerifier();

/** Verifies the request header against the env key; false when the header is absent or repeated. */
export function verifyRequestApproval(req, { env = process.env, verifier = hostApprovalVerifier, purpose } = {}) {
  const key = hostApprovalKey(env);
  const h = req.headers?.[HOST_APPROVAL_HEADER];
  if (!key || typeof h !== 'string' || typeof purpose !== 'string') return false;
  return verifier.verify(h.trim(), key, purpose, { compat: env.LLMIDE_HOST_APPROVAL_COMPAT === '1' });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CAPPED_SURFACES = new Set(['extension', 'phone', 'mobile', 'ios', 'ios-native', 'phone-pwa', 'web']);

/**
 * Origins that may never use Bypass, token or not: a declared client class other than `desktop-ui` (the phone, the
 * extension, a relay bridge), a non-desktop surface, or a non-loopback peer.
 */
export function bypassForbiddenOrigin(req, agentContext) {
  // The grant path requires an explicit `x-llmide-client: desktop-ui` (an absent header is not enough) ...
  const declared = req.headers?.['x-llmide-client'];
  if (typeof declared !== 'string' || declared.trim().toLowerCase() !== 'desktop-ui') return true;
  // ... and the bus host proof (derived from the approval key; the same proof the command bus requires for desktop-ui),
  // so a bearer-token holder that merely claims desktop-ui cannot reach Bypass.
  if (!verifyBusHostProof(req)) return true;
  const surface = typeof agentContext?.surface === 'string' ? agentContext.surface.trim().toLowerCase() : '';
  if (CAPPED_SURFACES.has(surface)) return true;
  const peer = req.socket?.remoteAddress;
  if (typeof peer === 'string' && peer && !LOOPBACK.has(peer)) return true;
  return false;
}

// A valid token enables Bypass for ONE chat for a while (the user enabled it once, like the terminal consent), so the
// UI sends a token per Bypass enable, not per message. The grant ends at GRANT_TTL_MS, or when any turn of that chat
// asks for another mode (the user switched Bypass off), or with the core. Bounded; a full table refuses new grants.
export const GRANT_TTL_MS = 30 * 60_000;
export const MAX_GRANTS = 1024;

export function createBypassGrants({ now = Date.now } = {}) {
  const grants = new Map(); // `${userId}\0${chatSessionId}` -> expiry
  const k = (u, c) => `${u}\0${c}`;
  return {
    has(u, c) {
      const e = grants.get(k(u, c));
      if (e === undefined) return false;
      if (e <= now()) { grants.delete(k(u, c)); return false; }
      return true;
    },
    grant(u, c) {
      const t = now();
      for (const [key, e] of grants) if (e <= t) grants.delete(key);
      if (!grants.has(k(u, c)) && grants.size >= MAX_GRANTS) return false;
      grants.set(k(u, c), t + GRANT_TTL_MS);
      return true;
    },
    revoke(u, c) { grants.delete(k(u, c)); },
    _size: () => grants.size,
  };
}

export const bypassGrants = createBypassGrants();
