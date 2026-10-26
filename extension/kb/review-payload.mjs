// Review-item payload shape, shared by the submit route (server/review-secrets.mjs),
// the review store read path, and the 0045 data scrub in kb/migrations.mjs.
// Pure functions only (no imports): kb/ may use it, server/ re-uses it.
//
// Two rules:
//   1. Only the keys each kind's consumers read are kept (REVIEW_PAYLOAD_KEYS).
//   2. Any key that names a credential is removed at every depth
//      (REVIEW_SECRET_KEY_RE, applied by scrubSecretKeysDeep).

// Keys the server reads from a stored payload, per kind.
//   dispatch: target, planId, taskIds, config (approve + planning.mjs
//     /kb/dispatch read them), items (guardrails checkDispatch; the server
//     overwrites it with the plan's tasks).
//   codegen-apply: repoPath, taskId, files, tests (applyCodegen), summary and
//     pr (openPullRequest, approve), allowedRepos (guardrails checkCodegenApply;
//     the server overwrites it with the user's allow-list).
export const REVIEW_PAYLOAD_KEYS = Object.freeze({
  dispatch: Object.freeze(['target', 'planId', 'taskIds', 'config', 'items']),
  'codegen-apply': Object.freeze(['repoPath', 'taskId', 'files', 'tests', 'summary', 'pr', 'allowedRepos']),
});

// Key names that carry a credential. Case-insensitive, matched anywhere in the
// key. `auth` covers authorization / oauth / auth*; `credential` and `bearer`
// are listed for the same reason.
export const REVIEW_SECRET_KEY_RE = /token|apikey|api_key|secret|password|credential|auth|bearer/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Keys that would reach the copy's prototype instead of becoming an own
// property (a JSON payload can carry "__proto__" as an ordinary key).
export const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep copy of `node` without any object entry whose key names a credential,
 * at any depth (objects inside arrays included). Non-object values are kept.
 */
export function scrubSecretKeysDeep(node) {
  if (Array.isArray(node)) return node.map(scrubSecretKeysDeep);
  if (!isPlainObject(node)) return node;
  // Object.fromEntries defines own properties, so no key can reach the
  // prototype; the unsafe keys are dropped as well.
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => !REVIEW_SECRET_KEY_RE.test(k) && !UNSAFE_OBJECT_KEYS.has(k))
      .map(([k, v]) => [k, scrubSecretKeysDeep(v)]),
  );
}

/** The payload with only the keys `kind` reads. Unknown kinds keep no keys. */
export function pickReviewPayload(kind, payload) {
  if (!isPlainObject(payload)) return {};
  const keys = REVIEW_PAYLOAD_KEYS[kind] || [];
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
  return out;
}

/**
 * One-time scrub of stored review rows (migration 0045). Rewrites payload with
 * scrubSecretKeysDeep and result the same way, redacting nothing else. Idempotent:
 * a row is written only when its JSON actually changes. Returns the count changed.
 */
export function scrubReviewPayloadRows(db) {
  const rows = db.prepare('SELECT id, payload, result FROM review_items').all();
  const upd = db.prepare('UPDATE review_items SET payload = ?, result = ? WHERE id = ?');
  let changed = 0;
  for (const r of rows) {
    const payload = safeParse(r.payload);
    const result = safeParse(r.result);
    const nextPayload = payload === undefined ? r.payload : JSON.stringify(scrubSecretKeysDeep(payload));
    const nextResult = result === undefined || result === null ? r.result : JSON.stringify(scrubSecretKeysDeep(result));
    if (nextPayload === r.payload && nextResult === r.result) continue;
    upd.run(nextPayload, nextResult, r.id);
    changed += 1;
  }
  return changed;
}

function safeParse(text) {
  if (text == null) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
