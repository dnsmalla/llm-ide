// Project-scoped team roles (ADR 0021 H1.3): the canonical project registry and the per-project
// grant that every project command and turn resolves through.
//
// A `project_members` row exists only for an explicit assignment. NO ROW IS A VIEWER: read/Ask only.
// The effective grant is computed in ONE place (`computeProjectGrant`):
//   - a global team owner/admin overrides every project (team management stays theirs);
//   - a global viewer is never raised above viewer by a project row (H1.2 is not weakened);
//   - a global member/engineer gets the project row's role, or viewer when there is no row;
//   - the run mode is the tighter of the global and project modes;
//   - the USD cap is the tighter positive cap (0 = no cap);
//   - on a HUB, a non-owner/admin is clamped to read_only (R-034 #1 / D1) — a project admin included.
//
// Every helper takes the db handle first (kb convention); every multi-step write is one transaction.

import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { config } from '../core/config.mjs';
import { userRepoAllowlist } from './user.mjs';
import {
  MAX_USD_CAP_MONTH, ROLE_ORDER, atLeast, classRefusal, getMember, hubClampedMode, permittedClasses,
} from './members.mjs';

/** Project roles use the same order as team roles: viewer < member < admin < owner. */
export const PROJECT_ROLES = Object.freeze(['viewer', 'member', 'admin', 'owner']);
export const PROJECT_ROLE_ORDER = ROLE_ORDER;
/** The project id rule Doc Gen already enforces (`kb/project-roots.mjs` PROJECT_ID_RE). */
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_PROJECT_NAME = 120;
export const MAX_PROJECT_ROOT = 4096;

const PROJECT_ROLE_SET = new Set(PROJECT_ROLES);
const MODE_RANK = Object.freeze({ none: 0, read_only: 1, execute: 2 });
const MODES = Object.freeze(['none', 'read_only', 'execute']);

const err = (code, message, status) => new AppError(code, message, { status });

export function isProjectRole(v) {
  return typeof v === 'string' && PROJECT_ROLE_SET.has(v);
}

export function isProjectMaxMode(v) {
  return typeof v === 'string' && MODES.includes(v);
}

export function validUsdCap(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_USD_CAP_MONTH;
}

/** Tighter of two run modes (none < read_only < execute). */
export function tighterMode(a, b) {
  return (MODE_RANK[a] ?? 0) <= (MODE_RANK[b] ?? 0) ? a : b;
}

/** The tighter positive cap; 0 means "no cap", so it never wins over a real cap. */
export function tighterUsdCap(a, b) {
  const caps = [Number(a), Number(b)].filter((n) => Number.isFinite(n) && n > 0);
  return caps.length ? Math.min(...caps) : 0;
}

/**
 * Pure effective project grant. `member` is the caller's `members` row (or null); `projectMember` is
 * their `project_members` row (or null). Returns the role/mode/cap plus the source that won, so a UI
 * can explain it and the tests can pin the matrix. `hub` applies the R-034 #1 clamp: only a global team
 * owner/admin keeps `execute`; a project admin or owner who is a team member is read-only on a hub.
 */
export function computeProjectGrant(member, projectMember, { hub = false } = {}) {
  const globalRole = member?.teamRole ?? 'viewer';
  const globalMax = member?.maxMode ?? 'read_only';
  const globalCap = Number(member?.usdCapMonth ?? 0);
  const projectRole = projectMember?.role ?? null;

  if (globalRole === 'owner' || globalRole === 'admin') {
    return {
      role: globalRole,
      maxMode: hubClampedMode(globalRole, globalMax, hub),
      usdCapMonth: Number.isFinite(globalCap) ? globalCap : 0,
      source: 'team',
      projectRole,
    };
  }
  if (globalRole === 'viewer') {
    // H1.2: a team viewer only ever Asks, whatever a project row says.
    return {
      role: 'viewer',
      maxMode: 'read_only',
      usdCapMonth: Number.isFinite(globalCap) ? globalCap : 0,
      source: 'implicit',
      projectRole,
    };
  }

  // member (engineer): the project row decides, and no row means the implicit viewer default.
  const projectMax = projectMember ? projectMember.maxMode : 'read_only';
  return {
    role: projectRole ?? 'viewer',
    maxMode: hubClampedMode(globalRole, tighterMode(globalMax, projectMax), hub),
    usdCapMonth: tighterUsdCap(globalCap, projectMember?.usdCapMonth ?? 0),
    source: projectMember ? 'project' : 'implicit',
    projectRole,
  };
}

/**
 * The action classes a project grant may use. `project.admin` is project membership management; it is
 * never the team `admin` class. A project-derived grant does not carry team management (`admin`).
 */
export function projectPermissions(grant) {
  const memberLike = {
    teamRole: grant.role, maxMode: grant.maxMode, usdCapMonth: grant.usdCapMonth,
  };
  const out = new Set(permittedClasses(memberLike));
  if (grant.role === 'admin' || grant.role === 'owner') out.add('project.admin');
  if (grant.source !== 'team') out.delete('admin');
  // `host` is the desktop-proof class, not a project permission.
  out.delete('host');
  return [...out];
}

/** The member-shaped view a class check needs. `project.admin` is checked separately. */
export function projectGrantAsMember(grant) {
  return { teamRole: grant.role, maxMode: grant.maxMode, usdCapMonth: grant.usdCapMonth };
}

/**
 * True when a grant may manage the project's membership (project admin/owner, or a global admin/owner).
 * `max_mode` narrows model actions, not management, exactly as the team `admin` class does.
 */
export function canManageProjectGrant(grant) {
  return atLeast(grant.role, 'admin');
}

// ── registry ───────────────────────────────────────────────────────────────

export function getProject(db, projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  return db.prepare(
    'SELECT id, name, root, created_by, created_at, updated_at FROM projects WHERE id = ?',
  ).get(projectId) ?? null;
}

export function requireProject(db, projectId) {
  const project = getProject(db, projectId);
  if (!project) throw err('NOT_FOUND', 'Project not found', 404);
  return project;
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * The canonical spelling of a project root for comparison: trimmed, trailing separators removed, symlinks and
 * `..` resolved where the folder exists, and case-folded on the case-insensitive platforms (R-020 #5). Returns
 * null for anything that is not a usable path string.
 */
export function canonicalRoot(root) {
  if (typeof root !== 'string') return null;
  let p = root.trim();
  if (!p || p.length > MAX_PROJECT_ROOT) return null;
  const stripped = p.replace(/[\\/]+$/, '');
  if (stripped) p = stripped; // keep a bare "/" or "C:\\"
  try { p = fs.realpathSync.native(p); } catch { /* not created yet: the trimmed spelling is the best we have */ }
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/**
 * The registered project whose root CONTAINS this folder (longest match, path-segment prefix), or null. R-022 #1:
 * a turn inside a project's subfolder belongs to that project, and `/a/bc` is not inside `/a/b`.
 */
export function projectIdForFolder(db, folder) {
  const key = canonicalRoot(folder);
  if (!key) return null;
  const sep = path.sep;
  let best = null;
  for (const row of db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL').all()) {
    const root = canonicalRoot(row.root);
    if (!root) continue;
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (key === root || key.startsWith(prefix)) {
      if (best === null || root.length > best.root.length) best = { id: row.id, root };
    }
  }
  return best?.id ?? null;
}

/** The longest registered root that CONTAINS `rootKey` (not equal, excluding `excludeId`), or null. */
function enclosingProject(db, rootKey, excludeId) {
  const sep = path.sep;
  let best = null;
  for (const row of db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL AND id <> ?').all(excludeId)) {
    const r = canonicalRoot(row.root);
    if (!r) continue;
    const prefix = r.endsWith(sep) ? r : r + sep;
    if (rootKey.startsWith(prefix) && (best === null || r.length > best.root.length)) best = { id: row.id, root: r };
  }
  return best;
}

/** The registered project whose canonical root is this folder, or null. Lets a turn inherit the project
 *  from the desktop's workspaceRoot without a client change. Compared canonically, not as a raw string. */
export function projectIdForRoot(db, root) {
  const key = canonicalRoot(root);
  if (!key) return null;
  // A small team-wide registry: compare each stored root canonically, so older non-canonical rows still match.
  const rows = db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL ORDER BY updated_at DESC, id').all();
  for (const row of rows) if (canonicalRoot(row.root) === key) return row.id;
  return null;
}

/** True when two canonical paths are equal or one contains the other (path-segment safe). */
function pathsOverlap(a, b) {
  const sep = path.sep;
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * R-034 #2: an allow-list root must not widen a hub caller past the project grants.
 *
 * Returns `{ projectId }` when `folder` is a registered project root, lies inside one, or ENCLOSES one,
 * and the caller has no explicit grant on that project (a project row; a global team owner/admin overrides
 * every project). Ancestors count too: allowing `/srv` would expose every project below it. Off a hub this
 * is always null (local solo mode is unchanged).
 */
export function repoRootRefusal(db, userId, folder, { hub = config.hub } = {}) {
  if (!hub) return null;
  const key = canonicalRoot(folder);
  if (!key) return null;
  const member = getMember(db, userId);
  if (member && (member.teamRole === 'owner' || member.teamRole === 'admin')) return null;
  const rows = db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL').all();
  for (const row of rows) {
    const root = canonicalRoot(row.root);
    if (!root || !pathsOverlap(key, root)) continue;
    // A project row is the grant. No row = implicit viewer for turn purposes, but NOT a grant that
    // widens a filesystem allow-list across projects.
    if (getProjectMember(db, userId, row.id)) continue;
    return { projectId: row.id };
  }
  return null;
}

/**
 * The per-user repo allow-list with R-034 #2 applied: on a hub, roots that overlap a registered project
 * the caller has no grant on are dropped for every read AND write (chat tools, codegen, review, SCIP,
 * connect-git, code graph). Always a fresh DB read — never a client payload.
 */
export function filteredRepoAllowlist(db, userId, { hub = config.hub } = {}) {
  let paths;
  try { paths = userRepoAllowlist(userId) || []; } catch { return []; }
  if (!hub) return paths;
  return paths.filter((p) => !repoRootRefusal(db, userId, p, { hub }));
}


function validName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_PROJECT_NAME) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function defaultName(root) {
  if (typeof root !== 'string') return 'Project';
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1] || 'Project';
  return validName(last) ?? 'Project';
}

/**
 * Create or update the canonical registry entry for a project id.
 *
 * A NEW project needs the team's `fs.write` class (owner/admin/engineer + execute) and gives the
 * creator `owner`/`execute`/no-cap membership, so the first person to register it can manage it.
 * Re-registering an existing project needs project admin (or global admin/owner). The handler also
 * validates the folder through `kb/project-roots.mjs`; this helper is the DB truth.
 */
export function registerProject(db, actorId, { id, root = null, name = null } = {}) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) {
    throw err('VALIDATION', 'project id must be 1 to 128 letters, digits, _ or -', 400);
  }
  const actor = getMember(db, actorId);
  if (!actor) throw err('ROLE_DENIED', 'Requires a team role', 403);
  const cleanName = name == null ? null : validName(name);
  if (name != null && cleanName === null) throw err('VALIDATION', 'Invalid project name', 400);
  if (root != null && (typeof root !== 'string' || root.length === 0 || root.length > MAX_PROJECT_ROOT)) {
    throw err('VALIDATION', 'Invalid project root', 400);
  }

  const canonical = root == null ? null : (canonicalRoot(root) ?? root);
  return db.transaction(() => {
    const existing = getProject(db, id);
    // R-020 #4: one project per canonical root. A second id on the same folder would win root resolution and
    // bypass the real project's grants; the caller must use the id already registered.
    if (canonical != null) {
      const clash = db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL AND id <> ?').all(id)
        .find((r) => canonicalRoot(r.root) === canonical || canonicalRoot(r.root) === canonicalRoot(canonical));
      if (clash) throw err('PROJECT_EXISTS', 'This folder is already registered to another project; open that project', 409);
      // R-023 #2: a sub-folder of an existing project is that project's work. Registering it as a new project would
      // win the longest-root lookup and escape the enclosing project's role; only its admin/owner may split it off.
      const enclosing = enclosingProject(db, canonical, id);
      if (enclosing) {
        const grant = effectiveProjectGrant(db, actorId, enclosing.id);
        if (!canManageProjectGrant(grant)) {
          throw err('PROJECT_NESTED', `This folder is inside project ${enclosing.id}; ask its admin`, 403);
        }
      }
    }
    if (existing) {
      const grant = effectiveProjectGrant(db, actorId, id);
      if (!canManageProjectGrant(grant)) throw err('ROLE_DENIED', 'Requires project admin', 403);
      db.prepare(`
        UPDATE projects
           SET name = COALESCE(?, name), root = COALESCE(?, root), updated_at = datetime('now')
         WHERE id = ?
      `).run(cleanName, canonical, id);
      return { project: getProject(db, id), created: false };
    }

    const refusal = classRefusal(actor, 'fs.write');
    if (refusal) throw err('ROLE_DENIED', 'Requires team role member with execute', 403);
    db.prepare(`
      INSERT INTO projects (id, name, root, created_by)
      VALUES (?, ?, ?, ?)
    `).run(id, cleanName ?? defaultName(root), canonical, String(actorId));
    db.prepare(`
      INSERT INTO project_members (user_id, project_id, role, max_mode, usd_cap_month, granted_by)
      VALUES (?, ?, 'owner', 'execute', 0, ?)
    `).run(String(actorId), id, String(actorId));
    return { project: getProject(db, id), created: true };
  })();
}

// ── membership ─────────────────────────────────────────────────────────────

export function getProjectMember(db, userId, projectId) {
  if (!userId || typeof projectId !== 'string') return null;
  const row = db.prepare(`
    SELECT user_id, project_id, role, max_mode, usd_cap_month, granted_by, updated_at
      FROM project_members
     WHERE user_id = ? AND project_id = ?
  `).get(String(userId), projectId);
  if (!row) return null;
  return {
    userId: row.user_id,
    projectId: row.project_id,
    role: row.role,
    maxMode: row.max_mode,
    usdCapMonth: row.usd_cap_month,
    grantedBy: row.granted_by,
    updatedAt: row.updated_at,
  };
}

/** The effective project grant for a caller. Missing project or account fails closed to viewer. */
export function effectiveProjectGrant(db, userId, projectId, { hub = config.hub } = {}) {
  const member = getMember(db, userId);
  if (!getProject(db, projectId)) {
    return computeProjectGrant(member, null, { hub });
  }
  return computeProjectGrant(member, getProjectMember(db, userId, projectId), { hub });
}

export function canManageProject(db, userId, projectId) {
  if (!getProject(db, projectId)) return false;
  return canManageProjectGrant(effectiveProjectGrant(db, userId, projectId));
}

/** The project list a client shows: id, name, the caller's effective role and permissions. */
export function listProjectsForUser(db, userId, { hub = config.hub } = {}) {
  const member = getMember(db, userId);
  const rows = db.prepare('SELECT id, name, created_at FROM projects ORDER BY name, id').all();
  const membership = new Map(
    db.prepare(
      'SELECT project_id, role, max_mode, usd_cap_month FROM project_members WHERE user_id = ?',
    ).all(String(userId)).map((r) => [r.project_id, {
      role: r.role, maxMode: r.max_mode, usdCapMonth: r.usd_cap_month,
    }]),
  );
  return rows.map((row) => {
    const grant = computeProjectGrant(member, membership.get(row.id) ?? null, { hub });
    return {
      id: row.id,
      name: row.name,
      role: grant.role,
      maxMode: grant.maxMode,
      usdCapMonth: grant.usdCapMonth,
      permissions: projectPermissions(grant),
    };
  });
}

/** The team-facing member row joined with the users row, ordered by role then email. */
export function listProjectMembers(db, projectId) {
  requireProject(db, projectId);
  return db.prepare(`
    SELECT pm.user_id, u.email, u.display_name, u.status, pm.role, pm.max_mode,
           pm.usd_cap_month, pm.updated_at
      FROM project_members pm
      JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?
     ORDER BY CASE pm.role
                WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
              u.email
  `).all(projectId).map((r) => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    role: r.role,
    maxMode: r.max_mode,
    usdCapMonth: r.usd_cap_month,
    updatedAt: r.updated_at,
  }));
}

function memberView(db, userId, projectId) {
  const row = db.prepare(`
    SELECT pm.user_id, u.email, u.display_name, u.status, pm.role, pm.max_mode,
           pm.usd_cap_month, pm.updated_at
      FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.user_id = ? AND pm.project_id = ?
  `).get(String(userId), projectId);
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    role: row.role,
    maxMode: row.max_mode,
    usdCapMonth: row.usd_cap_month,
    updatedAt: row.updated_at,
  };
}

/**
 * Change one project membership, inserting the row when the member had none.
 *
 * Rules (one home, like `setMember`):
 *   - the actor must manage the project (project admin/owner or global admin/owner);
 *   - an actor may only touch a member at or below their own project role;
 *   - nobody changes their own project role;
 *   - a role above the actor's own cannot be granted (only a project/team owner grants project owner).
 */
export function setProjectMember(db, actorId, projectId, userId, patch = {}) {
  requireProject(db, projectId);
  if (!userId) throw err('VALIDATION', 'userId is required', 400);
  const grant = effectiveProjectGrant(db, actorId, projectId);
  if (!canManageProjectGrant(grant)) throw err('ROLE_DENIED', 'Requires project admin', 403);

  const next = {};
  if (patch.role !== undefined) {
    if (!isProjectRole(patch.role)) throw err('VALIDATION', 'Invalid project role', 400);
    next.role = patch.role;
  }
  if (patch.maxMode !== undefined) {
    if (!isProjectMaxMode(patch.maxMode)) throw err('VALIDATION', 'Invalid max mode', 400);
    next.maxMode = patch.maxMode;
  }
  if (patch.usdCapMonth !== undefined) {
    if (!validUsdCap(patch.usdCapMonth)) throw err('VALIDATION', 'Invalid USD cap', 400);
    next.usdCapMonth = Number(patch.usdCapMonth);
  }
  if (Object.keys(next).length === 0) throw err('VALIDATION', 'Nothing to change', 400);

  const targetUser = db.prepare('SELECT id, email FROM users WHERE id = ?').get(String(userId));
  if (!targetUser) throw err('NOT_FOUND', 'Member not found', 404);
  if (String(actorId) === String(userId)) throw err('SELF_GRANT', 'You cannot change your own project role', 403);

  const target = getProjectMember(db, userId, projectId);
  if (target && !atLeast(grant.role, target.role)) {
    throw err('ROLE_DENIED', 'You cannot change a project role above your own', 403);
  }
  if (next.role !== undefined && !atLeast(grant.role, next.role)) {
    throw err('ROLE_DENIED', 'You cannot grant a project role above your own', 403);
  }

  db.prepare(`
    INSERT INTO project_members (user_id, project_id, role, max_mode, usd_cap_month, granted_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      role = excluded.role,
      max_mode = excluded.max_mode,
      usd_cap_month = excluded.usd_cap_month,
      granted_by = excluded.granted_by,
      updated_at = datetime('now')
  `).run(
    String(userId), projectId,
    next.role ?? target?.role ?? 'viewer',
    next.maxMode ?? target?.maxMode ?? 'read_only',
    next.usdCapMonth ?? Number(target?.usdCapMonth ?? 20),
    String(actorId),
  );
  return memberView(db, userId, projectId);
}

/** Add an existing team member to a project by email (the project admin path, no team list needed). */
export function addProjectMemberByEmail(db, actorId, projectId, { email, role = 'viewer', maxMode = 'read_only', usdCapMonth = 20 } = {}) {
  requireProject(db, projectId);
  const clean = typeof email === 'string' ? email.trim() : '';
  if (!clean || clean.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(clean)) {
    throw err('VALIDATION', 'Invalid email', 400);
  }
  const user = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(clean);
  if (!user) throw err('NOT_FOUND', 'Member not found', 404);
  // R-021 #6: adding is not an overwrite — an existing row is edited through PATCH, so a default form cannot
  // silently reset a member's role/mode/cap.
  if (getProjectMember(db, user.id, projectId)) {
    throw err('ALREADY_MEMBER', 'This member already has a project role; edit it instead', 409);
  }
  return setProjectMember(db, actorId, projectId, user.id, { role, maxMode, usdCapMonth });
}

/** Remove a project membership. The member returns to the implicit viewer default (no row). */
export function removeProjectMember(db, actorId, projectId, userId) {
  requireProject(db, projectId);
  const grant = effectiveProjectGrant(db, actorId, projectId);
  if (!canManageProjectGrant(grant)) throw err('ROLE_DENIED', 'Requires project admin', 403);
  const target = getProjectMember(db, userId, projectId);
  if (!target) return false;
  if (!atLeast(grant.role, target.role)) {
    throw err('ROLE_DENIED', 'You cannot remove a project role above your own', 403);
  }
  return db.prepare(
    'DELETE FROM project_members WHERE user_id = ? AND project_id = ?',
  ).run(String(userId), projectId).changes > 0;
}

// ── team.yaml support ──────────────────────────────────────────────────────

/** Every explicit project assignment, in the shape team.yaml writes. */
export function listProjectAssignmentRows(db) {
  return db.prepare(`
    SELECT pm.project_id, p.name AS project_name, u.email, pm.role, pm.max_mode, pm.usd_cap_month
      FROM project_members pm
      JOIN users u ON u.id = pm.user_id
      JOIN projects p ON p.id = pm.project_id
     ORDER BY p.name, p.id, u.email
  `).all().map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name,
    email: String(r.email).trim().toLowerCase(),
    role: r.role,
    maxMode: r.max_mode,
    usdCapMonth: Number(r.usd_cap_month),
  }));
}

/** The full row for undoing a write-through failure (R-013#2). */
export function getProjectMemberSnapshot(db, userId, projectId) {
  return db.prepare(
    'SELECT user_id, project_id, role, max_mode, usd_cap_month, granted_by, updated_at FROM project_members WHERE user_id = ? AND project_id = ?',
  ).get(String(userId), projectId) ?? null;
}

export function restoreProjectMemberSnapshot(db, snapshot) {
  if (!snapshot) return;
  db.prepare(`
    INSERT INTO project_members (user_id, project_id, role, max_mode, usd_cap_month, granted_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      role = excluded.role,
      max_mode = excluded.max_mode,
      usd_cap_month = excluded.usd_cap_month,
      granted_by = excluded.granted_by,
      updated_at = excluded.updated_at
  `).run(
    snapshot.user_id, snapshot.project_id, snapshot.role, snapshot.max_mode,
    snapshot.usd_cap_month, snapshot.granted_by, snapshot.updated_at,
  );
}

/** Remove a row captured by `getProjectMemberSnapshot` (undoing an insert). */
export function deleteProjectMemberRow(db, userId, projectId) {
  db.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id = ?').run(String(userId), projectId);
}
