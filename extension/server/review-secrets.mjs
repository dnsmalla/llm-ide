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

import { REVIEW_SECRET_KEY_RE, UNSAFE_OBJECT_KEYS, scrubSecretKeysDeep } from '../kb/review-payload.mjs';

// payload sections whose top-level credential leaves are held for approval
const SECRET_SECTIONS = ['config', 'pr'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Split `payload` into { payload: <without credentials>, secrets: {config, pr} }.
 * The payload is scrubbed at every depth (scrubSecretKeysDeep). The secrets
 * returned are only the credential leaves directly under config / pr: those
 * are held in memory for approval; anything nested elsewhere is dropped.
 */
export function stripReviewSecrets(payload) {
  const base = isPlainObject(payload) ? payload : {};
  const secrets = {};
  for (const section of SECRET_SECTIONS) {
    const obj = base[section];
    if (!isPlainObject(obj)) continue;
    const taken = Object.fromEntries(
      Object.entries(obj).filter(([k, v]) => REVIEW_SECRET_KEY_RE.test(k) && v && !UNSAFE_OBJECT_KEYS.has(k)),
    );
    if (Object.keys(taken).length) secrets[section] = taken;
  }
  return { payload: scrubSecretKeysDeep(base), secrets };
}

/** Public view of a review item: payload never carries credentials, at any depth. */
export function redactReviewItem(item) {
  if (!item || !item.payload) return item;
  return { ...item, payload: stripReviewSecrets(item.payload).payload };
}

// Held credentials are bounded: entries expire after HELD_TTL_MS (checked
// lazily on access/insert) and each user keeps at most HELD_MAX_PER_USER
// (oldest evicted first — Map preserves insertion order).
export const HELD_TTL_MS = 24 * 60 * 60 * 1000;
export const HELD_MAX_PER_USER = 100;

const held = new Map(); // `${userId}:${reviewId}` -> { secrets, at, userId }
const holdKey = (userId, id) => `${userId}:${id}`;

function sweepExpired(now) {
  for (const [k, v] of held) if (now - v.at > HELD_TTL_MS) held.delete(k);
}

export function holdSecrets(userId, id, secrets, now = Date.now()) {
  if (!secrets || !Object.keys(secrets).length) return;
  sweepExpired(now);
  const key = holdKey(userId, id);
  held.delete(key); // re-insert so it counts as newest
  held.set(key, { secrets, at: now, userId });
  const mine = [...held].filter(([, v]) => v.userId === userId);
  for (let i = 0; i < mine.length - HELD_MAX_PER_USER; i++) held.delete(mine[i][0]);
}
export function takeHeldSecrets(userId, id, now = Date.now()) {
  const key = holdKey(userId, id);
  const e = held.get(key);
  if (!e) return {};
  if (now - e.at > HELD_TTL_MS) { held.delete(key); return {}; }
  return e.secrets;
}
export function dropHeldSecrets(userId, id) { held.delete(holdKey(userId, id)); }
/** Drop every held credential of one user (account deletion). */
export function dropAllHeldSecretsForUser(userId) {
  for (const [k, v] of held) if (v.userId === userId) held.delete(k);
}

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
