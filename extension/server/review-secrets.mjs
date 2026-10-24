// Review-queue credential handling. Tracker / GitHub credentials must never
// be persisted in review_items.payload or returned by the review GET
// endpoints: submit strips them, approve/execute resolves them from the
// per-user vault (github.token / backlog.apiKey / linear.apiKey, the same
// keys /kb/outcomes/refresh uses), with a credential supplied on the approve
// request (or held in memory from submit time) taking precedence.
//
// Credentials supplied at submit time are held ONLY in this in-memory map
// keyed by user + review id — lost on restart, in which case approval needs
// the vault or a credential on the approve body.

import { getSecret } from './vault.mjs';

const SECRET_KEY_RE = /token|apikey|api_key|secret|password/i;

// payload sections whose credential-looking leaves are stripped
const SECRET_SECTIONS = ['config', 'pr'];

/** Split `payload` into { payload: <without secrets>, secrets: {config, pr} }. */
export function stripReviewSecrets(payload) {
  const out = { ...(payload || {}) };
  const secrets = {};
  for (const section of SECRET_SECTIONS) {
    const obj = out[section];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const kept = {};
    const taken = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY_RE.test(k)) { if (v) taken[k] = v; } else kept[k] = v;
    }
    out[section] = kept;
    if (Object.keys(taken).length) secrets[section] = taken;
  }
  return { payload: out, secrets };
}

/** Public view of a review item: payload never carries credentials. */
export function redactReviewItem(item) {
  if (!item || !item.payload) return item;
  return { ...item, payload: stripReviewSecrets(item.payload).payload };
}

const held = new Map(); // `${userId}:${reviewId}` -> secrets
const holdKey = (userId, id) => `${userId}:${id}`;
export function holdSecrets(userId, id, secrets) {
  if (secrets && Object.keys(secrets).length) held.set(holdKey(userId, id), secrets);
}
export function takeHeldSecrets(userId, id) { return held.get(holdKey(userId, id)) || {}; }
export function dropHeldSecrets(userId, id) { held.delete(holdKey(userId, id)); }

function vaultGet(db, userId, key) {
  try { return getSecret(db, userId, key) || undefined; } catch { return undefined; }
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
const pick = (src, section) => stripReviewSecrets({ [section]: src?.[section] || {} }).secrets[section] || {};

/**
 * The credentials an item will execute with. Precedence, low to high:
 * vault, in-memory (from submit), supplied on the approve/dispatch request.
 * Returns { config, pr } leaf maps (only keys that resolved).
 */
export function resolveReviewCreds(db, userId, payload, { held: heldSecrets = {}, supplied = {} } = {}) {
  const target = payload?.target;
  const config = {};
  if (target === 'github') config.token = vaultGet(db, userId, 'github.token');
  else if (target === 'backlog') config.apiKey = vaultGet(db, userId, 'backlog.apiKey');
  else if (target === 'linear') config.apiKey = vaultGet(db, userId, 'linear.apiKey');
  const pr = { ghToken: vaultGet(db, userId, 'github.token') };
  return {
    config: clean({ ...config, ...pick(heldSecrets, 'config'), ...pick(supplied, 'config') }),
    pr: clean({ ...pr, ...pick(heldSecrets, 'pr'), ...pick(supplied, 'pr') }),
  };
}

/** `payload` with resolved credentials merged back in (never persisted). */
export function withCreds(payload, creds) {
  const out = { ...payload, config: { ...(payload.config || {}), ...creds.config } };
  if (payload.pr) out.pr = { ...payload.pr, ...creds.pr };
  return out;
}
