// Per-user metadata: repo allow-list, UI preferences, JTI revocation.
//
// Three small domains kept together because they all share the
// "per-user state, no plan/meeting linkage" shape — distinct from
// the bigger meetings / plans / personas modules. Splitting them
// further would mean three sub-100-line files; this is cleaner.
//
// Extracted from kb/db.mjs as part of the modularization sweep.

import path from 'path';
import { getDb, lazyPrepare, requireUser } from './db.mjs';

// ── Per-user repo allow-list (codegen-apply target safety) ────────

function normalizeRepoPath(p) {
  // Resolve trailing slashes, "./", and "..". Reject anything that
  // doesn't look like an absolute path; the allow-list is meant for
  // local repos the user has on their server's host filesystem.
  if (typeof p !== 'string' || !p) throw new Error('Repo path must be a non-empty string');
  const abs = path.resolve(p);
  if (abs === '/' || abs === '') throw new Error('Refusing to allow-list root');
  return abs;
}

export function listUserRepos(userId) {
  requireUser(userId);
  const db = getDb();
  return db.prepare(
    'SELECT path, label, added_at FROM user_repos WHERE user_id = ? ORDER BY added_at DESC',
  ).all(userId);
}

export function addUserRepo(userId, repoPath, label) {
  requireUser(userId);
  const abs = normalizeRepoPath(repoPath);
  const db = getDb();
  db.prepare(`
    INSERT INTO user_repos (user_id, path, label)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, path) DO UPDATE SET label = excluded.label
  `).run(userId, abs, typeof label === 'string' ? label.slice(0, 200) : null);
  return abs;
}

export function removeUserRepo(userId, repoPath) {
  requireUser(userId);
  const abs = normalizeRepoPath(repoPath);
  const db = getDb();
  db.prepare('DELETE FROM user_repos WHERE user_id = ? AND path = ?').run(userId, abs);
}

// Canonical allow-list — used by codegen-apply approval and the
// guardrail engine. Always read from the DB at decision time,
// never trusted from a client payload.
export function userRepoAllowlist(userId) {
  requireUser(userId);
  const db = getDb();
  return db.prepare(
    'SELECT path FROM user_repos WHERE user_id = ?',
  ).all(userId).map((r) => r.path);
}

// ── Per-user UI preferences ───────────────────────────────────────
// User-shaped (not device-shaped) settings that should follow the
// account across the Chrome extension and the Mac app. Stored in
// user_flags under flag = 'ui.prefs' so we don't need a schema
// migration. Allow-listed keys only — a malformed payload can't
// smuggle arbitrary blobs into the row.
//
// Allowed today:
//   language   — ISO code ('en', 'ja', 'zh-CN', …) used by every LLM
//                prompt and the side panel's caption rendering.
//   bilingual  — boolean opt-in to dual-language transcript display.
//
// Adding a new pref is one entry in ALLOWED_UI_PREF_KEYS + a coercion
// case below; both clients then read/write through the same shape.

const ALLOWED_UI_PREF_KEYS = new Set(['language', 'bilingual']);
const PREF_STR_MAX = 32;

// Returns one of:
//   { ok: true, value: <coerced> }  → store this
//   { clear: true }                 → explicit clear (e.g. empty string)
//   null                            → invalid input; ignore, leave current
function coerceUiPref(key, raw) {
  if (key === 'language') {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().slice(0, PREF_STR_MAX);
    return v ? { ok: true, value: v } : { clear: true };
  }
  if (key === 'bilingual') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === null) return { clear: true };
    return null;
  }
  return null;
}

export function getUserPrefs(userId) {
  requireUser(userId);
  const db = getDb();
  const row = db.prepare(
    "SELECT value FROM user_flags WHERE user_id = ? AND flag = 'ui.prefs'",
  ).get(userId);
  const out = {};
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value);
      for (const k of ALLOWED_UI_PREF_KEYS) {
        const c = coerceUiPref(k, parsed?.[k]);
        if (c?.ok) out[k] = c.value;
      }
    } catch { /* bad blob — return empty defaults */ }
  }
  return out;
}

export function setUserPrefs(userId, patch) {
  requireUser(userId);
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');
  const db = getDb();
  // Wrap read+write in a transaction — concurrent settings updates otherwise race
  // on the JSON blob and the last writer silently clobbers the first's changes.
  return db.transaction(() => {
    const current = getUserPrefs(userId);
    const merged = { ...current };
    for (const k of Object.keys(patch)) {
      if (!ALLOWED_UI_PREF_KEYS.has(k)) continue;       // silently drop unknown keys
      const c = coerceUiPref(k, patch[k]);
      if (c === null) continue;                         // bad type → leave current as-is
      if (c.clear) delete merged[k];                    // explicit clear (null or empty string)
      else merged[k] = c.value;
    }
    if (Object.keys(merged).length === 0) {
      db.prepare("DELETE FROM user_flags WHERE user_id = ? AND flag = 'ui.prefs'").run(userId);
      return {};
    }
    db.prepare(`
      INSERT INTO user_flags (user_id, flag, value)
      VALUES (?, 'ui.prefs', ?)
      ON CONFLICT(user_id, flag) DO UPDATE SET
        value  = excluded.value,
        set_at = datetime('now')
    `).run(userId, JSON.stringify(merged));
    return merged;
  })();
}

// ── JWT revocation list ───────────────────────────────────────────
// One row per revoked jti until its natural expiry; purged
// periodically by purgeExpiredJti(). Pre-revoked tokens fail the
// isJtiRevoked() check before any other auth logic runs.

export function revokeJti(jti, userId, expiresAtIso) {
  if (!jti) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO revoked_jti (jti, user_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(jti) DO NOTHING
  `).run(String(jti), userId ? String(userId) : null, String(expiresAtIso));
}

// Per-user access-token cutoff (unix seconds; 0 = never revoked). The auth
// middleware rejects any access token whose `iat` is below this, so logoutAll
// / password reset invalidate outstanding ACCESS tokens, not just refresh
// tokens. Written by server/users.mjs (logoutAll, password reset).
export function tokensValidAfter(userId) {
  if (!userId) return 0;
  const db = getDb();
  const row = lazyPrepare(db, 'SELECT tokens_valid_after AS t FROM users WHERE id = ?').get(String(userId));
  return row && Number.isFinite(row.t) ? row.t : 0;
}

export function isJtiRevoked(jti) {
  if (!jti) return false;
  const db = getDb();
  // Include expires_at check so tokens whose natural expiry has already
  // passed don't keep the row "hot" in the lookup between purge runs.
  // This is defence-in-depth — the JWT verifier already rejects expired
  // tokens before isJtiRevoked() is ever called — but filtering here
  // keeps the query from hitting rows that the nightly purge hasn't
  // swept yet, which keeps the index tight on busy servers.
  return !!lazyPrepare(
    db,
    "SELECT 1 FROM revoked_jti WHERE jti = ? AND expires_at >= datetime('now')",
  ).get(String(jti));
}

// Sweep — call from a periodic cron or at server start. Removes rows
// for tokens that have expired anyway.
export function purgeExpiredJti() {
  const db = getDb();
  const info = db.prepare("DELETE FROM revoked_jti WHERE expires_at < datetime('now')").run();
  return info.changes;
}
