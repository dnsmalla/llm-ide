// Team members (ADR 0021): the per-user authority row beside `users`. The core
// enforces it in one place — `requireRole`, the turn clamp and the Host API
// pairing filter — never per route. `users.role` stays the legacy flag.
//
// Every helper takes the db handle first (kb convention: one SQLite store, the
// caller owns the connection) and every write is one transaction.

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.mjs';

// Role order: viewer < member < admin < owner.
export const ROLE_ORDER = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });
export const MAX_MODES = Object.freeze(['none', 'read_only', 'execute']);
export const MAX_USD_CAP_MONTH = 100_000;
// Invites: single use, 24 h by default, never more than a week. The token is 32 random bytes, stored
// only as its SHA-256 (a DB leak cannot be replayed).
export const DEFAULT_INVITE_TTL_HOURS = 24;
export const MAX_INVITE_TTL_HOURS = 168;
export const INVITE_ROLES = Object.freeze(['admin', 'member', 'viewer']);
export const INVITE_TOKEN_BYTES = 32;

const ROLES = new Set(Object.keys(ROLE_ORDER));
const INVITE_ROLE_SET = new Set(INVITE_ROLES);

const err = (code, message, status) => new AppError(code, message, { status });

/** True when `role` is at least `minRole` in the role order. Unknown roles never pass. */
export function atLeast(role, minRole) {
  if (!(role in ROLE_ORDER) || !(minRole in ROLE_ORDER)) return false;
  return ROLE_ORDER[role] >= ROLE_ORDER[minRole];
}

/** The user's authority row, or null when no `members` row exists (legacy / unregistered). */
export function getMember(db, userId) {
  if (!userId) return null;
  const row = db.prepare(
    'SELECT user_id, team_role, max_mode, usd_cap_month FROM members WHERE user_id = ?',
  ).get(String(userId));
  if (!row) return null;
  return {
    userId: row.user_id,
    teamRole: row.team_role,
    maxMode: row.max_mode,
    usdCapMonth: row.usd_cap_month,
  };
}

/** Every member joined with the users row, ordered by role then email. */
export function listMembers(db) {
  return db.prepare(`
    SELECT m.user_id, u.email, u.display_name, u.status, m.team_role, m.max_mode,
           m.usd_cap_month, m.updated_at
      FROM members m
      JOIN users u ON u.id = m.user_id
     ORDER BY CASE m.team_role
                WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
              u.email
  `).all().map((r) => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    teamRole: r.team_role,
    maxMode: r.max_mode,
    usdCapMonth: r.usd_cap_month,
    updatedAt: r.updated_at,
  }));
}

/** Insert-or-ignore: a registration grants the row once; a later login never overwrites it. */
export function ensureMember(db, userId, { teamRole = 'member', maxMode = 'read_only', usdCapMonth = 20, grantedBy = null } = {}) {
  if (!userId) throw err('VALIDATION', 'userId is required', 400);
  if (!ROLES.has(teamRole)) throw err('VALIDATION', 'Invalid team role', 400);
  if (!MAX_MODES.includes(maxMode)) throw err('VALIDATION', 'Invalid max mode', 400);
  if (!validUsdCap(usdCapMonth)) throw err('VALIDATION', 'Invalid USD cap', 400);
  db.prepare(
    `INSERT OR IGNORE INTO members (user_id, team_role, max_mode, usd_cap_month, granted_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(String(userId), teamRole, maxMode, Number(usdCapMonth), grantedBy == null ? null : String(grantedBy));
  return getMember(db, userId);
}

/**
 * Change one member's role and/or grants. The rules live here, not in the route:
 *   - an actor may only touch a member at or below their own role (so an admin
 *     cannot change an owner, and only an owner can grant `owner`);
 *   - nobody changes their own role or grants (SELF_GRANT);
 *   - the last owner cannot be demoted (LAST_OWNER).
 * A `members` row must already exist (registration always inserts one).
 */
export function setMember(db, actorId, userId, patch = {}) {
  const next = {};
  if (patch.teamRole !== undefined) {
    if (!ROLES.has(patch.teamRole)) throw err('VALIDATION', 'Invalid team role', 400);
    next.teamRole = patch.teamRole;
  }
  if (patch.maxMode !== undefined) {
    if (!MAX_MODES.includes(patch.maxMode)) throw err('VALIDATION', 'Invalid max mode', 400);
    next.maxMode = patch.maxMode;
  }
  if (patch.usdCapMonth !== undefined) {
    if (!validUsdCap(patch.usdCapMonth)) throw err('VALIDATION', 'Invalid USD cap', 400);
    next.usdCapMonth = Number(patch.usdCapMonth);
  }
  if (Object.keys(next).length === 0) throw err('VALIDATION', 'Nothing to change', 400);

  const target = getMember(db, userId);
  if (!target) throw err('NOT_FOUND', 'Member not found', 404);
  const actor = getMember(db, actorId);
  if (!actor) throw err('ROLE_DENIED', 'Requires team role admin', 403);
  if (!atLeast(actor.teamRole, 'admin')) throw err('ROLE_DENIED', 'Requires team role admin', 403);
  if (!atLeast(actor.teamRole, target.teamRole)) {
    throw err('ROLE_DENIED', 'Only an owner can change an owner', 403);
  }
  if (next.teamRole !== undefined && !atLeast(actor.teamRole, next.teamRole)) {
    throw err('ROLE_DENIED', 'You cannot grant a role above your own', 403);
  }
  // Checked before SELF_GRANT: the only reachable last-owner demotion is a sole owner editing their own
  // row (two owners may demote either; the last one has no second owner to act for it), and the answer
  // the UI needs there is LAST_OWNER, not "can't edit yourself".
  if (target.teamRole === 'owner' && next.teamRole !== undefined && next.teamRole !== 'owner'
      && ownerCount(db) === 1) {
    throw err('LAST_OWNER', 'The last owner cannot be demoted', 409);
  }
  if (String(actorId) === String(userId)) {
    throw err('SELF_GRANT', 'You cannot change your own role or grants', 403);
  }

  const sets = ['granted_by = ?', 'updated_at = datetime(\'now\')'];
  const vals = [String(actorId)];
  if (next.teamRole !== undefined) { sets.push('team_role = ?'); vals.push(next.teamRole); }
  if (next.maxMode !== undefined) { sets.push('max_mode = ?'); vals.push(next.maxMode); }
  if (next.usdCapMonth !== undefined) { sets.push('usd_cap_month = ?'); vals.push(next.usdCapMonth); }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals, String(userId));
  });
  tx();
  return getMember(db, userId);
}

/** How many owners the install has (the last one is protected). */
export function ownerCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM members WHERE team_role = 'owner'").get().n;
}

function validUsdCap(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_USD_CAP_MONTH;
}

// ── Invites (ADR 0021: invite only) ────────────────────────────────────────
// An admin mints a single-use invite carrying the new member's grants; the invitee registers with it even
// while registration is closed. The raw token is shown once and never stored.

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const inviteErr = () => err('INVITE_INVALID', 'This invite is not valid', 400);

function validEmail(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 254 || !s.includes('@')) throw err('VALIDATION', 'Invalid email', 400);
  return s;
}

function validTtlHours(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INVITE_TTL_HOURS) {
    throw err('VALIDATION', `ttlHours must be 1-${MAX_INVITE_TTL_HOURS}`, 400);
  }
  return n;
}

/** Mint an invite. Returns `{ id, token }` — the only time the token exists in plaintext. */
export function createInvite(db, actorId, {
  email = null, teamRole = 'member', maxMode = 'read_only', usdCapMonth = 20, ttlHours = DEFAULT_INVITE_TTL_HOURS,
} = {}) {
  const actor = getMember(db, actorId);
  if (!actor || !atLeast(actor.teamRole, 'admin')) throw err('ROLE_DENIED', 'Requires team role admin', 403);
  if (teamRole === 'owner') throw err('ROLE_DENIED', 'An invite cannot make an owner', 403);
  if (!INVITE_ROLE_SET.has(teamRole)) throw err('VALIDATION', 'Invalid invite role', 400);
  // An admin invite is a peer grant: only an owner may hand out the admin role.
  if (teamRole === 'admin' && actor.teamRole !== 'owner') {
    throw err('ROLE_DENIED', 'Only an owner can invite an admin', 403);
  }
  if (!MAX_MODES.includes(maxMode)) throw err('VALIDATION', 'Invalid max mode', 400);
  if (!validUsdCap(usdCapMonth)) throw err('VALIDATION', 'Invalid USD cap', 400);
  const boundEmail = validEmail(email);
  const ttl = validTtlHours(ttlHours);

  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  const id = randomBytes(8).toString('hex');
  const row = db.prepare(
    `INSERT INTO invites (id, token_hash, email, team_role, max_mode, usd_cap_month, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
     RETURNING expires_at`,
  ).get(id, hashToken(token), boundEmail, teamRole, maxMode, Number(usdCapMonth), String(actorId), `+${ttl} hours`);
  return { id, token, expiresAt: row.expires_at };
}

/** Every invite, newest first — never the token or its hash. */
export function listInvites(db) {
  return db.prepare(`
    SELECT id, email, team_role, max_mode, usd_cap_month, created_by, created_at, expires_at, used_at
      FROM invites ORDER BY created_at DESC, id
  `).all().map((r) => ({
    id: r.id,
    email: r.email,
    teamRole: r.team_role,
    maxMode: r.max_mode,
    usdCapMonth: r.usd_cap_month,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
  }));
}

/** Delete an unused or used invite. An admin may revoke any invite. */
export function revokeInvite(db, actorId, id) {
  const actor = getMember(db, actorId);
  if (!actor || !atLeast(actor.teamRole, 'admin')) throw err('ROLE_DENIED', 'Requires team role admin', 403);
  return db.prepare('DELETE FROM invites WHERE id = ?').run(String(id)).changes > 0;
}

/**
 * Validate and burn an invite (single use). `userId` is the account it is being used for; `email` is
 * compared case-insensitively when the invite is bound to one. Throws INVITE_INVALID for unknown, used,
 * expired or wrong-email tokens alike — the caller may not reveal which.
 */
export function consumeInvite(db, token, { email = null, userId } = {}) {
  if (typeof token !== 'string' || token.length < 16) throw inviteErr();
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hash);
  if (!row) throw inviteErr();
  const fresh = db.prepare("SELECT datetime('now') < ? AS ok").get(row.expires_at)?.ok;
  if (!fresh) throw inviteErr();
  if (row.used_at) throw inviteErr();
  if (row.email && row.email.toLowerCase() !== String(email ?? '').trim().toLowerCase()) throw inviteErr();

  const burned = db.prepare(
    "UPDATE invites SET used_at = datetime('now'), used_by = ? WHERE id = ? AND used_at IS NULL",
  ).run(userId == null ? null : String(userId), row.id).changes;
  if (burned !== 1) throw inviteErr(); // a concurrent registration won the same token
  return {
    id: row.id,
    email: row.email,
    teamRole: row.team_role,
    maxMode: row.max_mode,
    usdCapMonth: row.usd_cap_month,
    createdBy: row.created_by,
  };
}
