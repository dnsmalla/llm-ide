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

/**
 * The full row state, for undoing a grant when the team.yaml write-through fails (R-013#2). Unlike
 * `getMember` it keeps `granted_by`/`updated_at`, so the rollback restores the row exactly.
 */
export function getMemberSnapshot(db, userId) {
  if (!userId) return null;
  return db.prepare(
    'SELECT user_id, team_role, max_mode, usd_cap_month, granted_by, updated_at FROM members WHERE user_id = ?',
  ).get(String(userId)) ?? null;
}

/** Restore a row captured by `getMemberSnapshot`. A null snapshot is a no-op (nothing to undo). */
export function restoreMemberSnapshot(db, snapshot) {
  if (!snapshot) return;
  db.prepare(`
    UPDATE members
       SET team_role = ?, max_mode = ?, usd_cap_month = ?, granted_by = ?, updated_at = ?
     WHERE user_id = ?
  `).run(
    snapshot.team_role, snapshot.max_mode, snapshot.usd_cap_month,
    snapshot.granted_by, snapshot.updated_at, snapshot.user_id,
  );
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

/**
 * Refuse a delete that would take an owner the actor may not touch, or the last owner (self-delete
 * included). Called by both delete routes — DELETE /admin/users/:id and POST /auth/me/delete — inside
 * their delete flow, so the rule has one home (ADR 0021 Global Constraints).
 */
export function assertDeletable(db, actorId, targetId) {
  const target = getMember(db, targetId);
  if (!target || target.teamRole !== 'owner') return; // no authority row, or not an owner: nothing to protect
  const actor = getMember(db, actorId);
  if (!actor || actor.teamRole !== 'owner') {
    throw err('ROLE_DENIED', 'Only an owner can delete an owner', 403);
  }
  if (ownerCount(db) === 1) throw err('LAST_OWNER', 'The last owner cannot be deleted', 409);
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

/** The invite row for a valid token, or INVITE_INVALID (unknown, used, expired, wrong email — one code). */
function validInviteRow(db, token, email) {
  if (typeof token !== 'string' || token.length < 16) throw inviteErr();
  const row = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashToken(token));
  if (!row) throw inviteErr();
  const fresh = db.prepare("SELECT datetime('now') < ? AS ok").get(row.expires_at)?.ok;
  if (!fresh) throw inviteErr();
  if (row.used_at) throw inviteErr();
  if (row.email && row.email.toLowerCase() !== String(email ?? '').trim().toLowerCase()) throw inviteErr();
  return row;
}

/**
 * Validate an invite WITHOUT burning it. The register route calls this before hashing a password, so a
 * garbage token is refused cheaply on a closed server; the burn still happens in the same transaction.
 */
export function peekInvite(db, token, { email = null } = {}) {
  const row = validInviteRow(db, token, email);
  return {
    id: row.id,
    email: row.email,
    teamRole: row.team_role,
    maxMode: row.max_mode,
    usdCapMonth: row.usd_cap_month,
    createdBy: row.created_by,
  };
}

/**
 * Validate and burn an invite (single use). `userId` is the account it is being used for; `email` is
 * compared case-insensitively when the invite is bound to one. Throws INVITE_INVALID for unknown, used,
 * expired or wrong-email tokens alike — the caller may not reveal which.
 */
export function consumeInvite(db, token, { email = null, userId } = {}) {
  const row = validInviteRow(db, token, email);

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

// ── Action classes (plan H1.2): what each kind of action needs ──────────────────────────────────
// One table. A route, a Host API command or a background job names its class; nothing else
// decides who may do what. `null` = public (no account needed).
export const CLASS_GRANTS = Object.freeze({
  public: null,
  'self.read': Object.freeze({ role: 'viewer', mode: 'none', cap: false }),
  'self.write': Object.freeze({ role: 'viewer', mode: 'none', cap: false }),
  // A viewer may only Ask (user decision 2026-11-08): the chat turn is forced to `ask` mode.
  'model.ask': Object.freeze({ role: 'viewer', mode: 'read_only', cap: true }),
  'model.read': Object.freeze({ role: 'member', mode: 'read_only', cap: true }),
  'model.exec': Object.freeze({ role: 'member', mode: 'execute', cap: true }),
  'fs.read': Object.freeze({ role: 'member', mode: 'read_only', cap: false }),
  'fs.write': Object.freeze({ role: 'member', mode: 'execute', cap: false }),
  'external.read': Object.freeze({ role: 'member', mode: 'read_only', cap: false }),
  'external.write': Object.freeze({ role: 'member', mode: 'execute', cap: false }),
  // Engineers install too (user decision 2026-11-08); only team management stays admin.
  install: Object.freeze({ role: 'member', mode: 'execute', cap: false }),
  admin: Object.freeze({ role: 'admin', mode: 'none', cap: false }),
  host: Object.freeze({ role: 'viewer', mode: 'none', cap: false }),
});

const MODE_RANK = Object.freeze({ none: 0, read_only: 1, execute: 2 });

/**
 * Why `member` may not perform an action of class `cls`, or null when it may. Pure. `usedUsd` is a
 * function returning the member's USD spend this month (called only for a capped class with a
 * non-zero cap); pass null to leave the cap to the caller.
 */
export function classRefusal(member, cls, usedUsd = null) {
  if (!Object.prototype.hasOwnProperty.call(CLASS_GRANTS, cls)) return 'unknown_class';
  const need = CLASS_GRANTS[cls];
  if (need === null) return null;
  if (!member || !atLeast(member.teamRole, need.role)) return 'role_denied';
  if ((MODE_RANK[member.maxMode] ?? 0) < MODE_RANK[need.mode]) {
    return member.maxMode === 'none' ? 'max_mode_none' : 'max_mode_insufficient';
  }
  if (need.cap && typeof usedUsd === 'function') {
    const cap = Number(member.usdCapMonth);
    if (cap > 0 && usedUsd() >= cap) return 'usd_cap';
  }
  return null;
}

/** The classes `member` may use (cap ignored), in table order. For `/auth/me`. */
export function permittedClasses(member) {
  return Object.keys(CLASS_GRANTS).filter((cls) => CLASS_GRANTS[cls] !== null && classRefusal(member, cls) === null);
}
