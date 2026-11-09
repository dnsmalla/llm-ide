// Project-scoped team roles — the project list and membership routes (ADR 0021 H1.3).
//
//   GET    /projects                          the caller's projects + effective role/permissions
//   GET    /projects/:id/members              the project's explicit members (project admin)
//   POST   /projects/:id/members              add an existing team member by email (project admin)
//   PATCH  /projects/:id/members/:userId      change role/max_mode/usd_cap_month (project admin)
//   DELETE /projects/:id/members/:userId      remove the row → implicit viewer (project admin)
//   GET    /projects/:id/plan-tasks           plan tasks tagged with the project + assignee (project member)
//
// The route policy (`extension/server/route-authority.mjs`) gates these with the project-effective
// authority; this handler re-checks the same grant so the module is safe when called directly by tests.
// Membership writes are audited and written through to team.yaml atomically; a failed file write
// restores the DB row, so a completed request never leaves the DB and the audited file disagreeing.
import path from 'node:path';
import { getDb } from '../kb/db.mjs';
import { config } from '../core/config.mjs';
import { send, readJson, clientIp, safeAudit } from '../server/route-http.mjs';
import { persistTeamYaml } from '../kb/team-yaml.mjs';
import { listProjectPlanTasks } from '../kb/plan-assignments.mjs';
import {
  addProjectMemberByEmail, canManageProjectGrant, deleteProjectMemberRow,
  effectiveProjectGrant, getProject, getProjectMemberSnapshot, listProjectMembers, listProjectsForUser,
  removeProjectMember, requireProject, restoreProjectMemberSnapshot, setProjectMember, validUsdCap,
} from '../kb/projects.mjs';

const BODY_MAX = 64 * 1024;
const PROJECT_MEMBERS = /^\/projects\/([A-Za-z0-9_-]{1,128})\/members$/;
const PROJECT_MEMBER = /^\/projects\/([A-Za-z0-9_-]{1,128})\/members\/([A-Za-z0-9_-]{1,64})$/;
const PROJECT_PLAN_TASKS = /^\/projects\/([A-Za-z0-9_-]{1,128})\/plan-tasks$/;
const MEMBERS_SUFFIX = '/members';
const PATCH_KEYS = ['role', 'maxMode', 'usdCapMonth'];
const ADD_KEYS = ['email', 'role', 'maxMode', 'usdCapMonth'];

export function isProjectRoute(url) {
  const p = String(url || '').split('?')[0];
  if (p === '/projects') return true;
  if (!p.startsWith('/projects/')) return false;
  if (PROJECT_PLAN_TASKS.test(p)) return true;
  return p.endsWith(MEMBERS_SUFFIX) || p.includes(`${MEMBERS_SUFFIX}/`);
}

const fail = (res, status, code, message) => {
  send(res, status, { error: { code, message } });
  return true;
};

function closedObject(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) return null;
    out[k] = v;
  }
  return out;
}

async function readBody(req) {
  let body;
  try { body = await readJson(req, BODY_MAX); } catch { return { ok: false, body: null }; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, body: null };
  return { ok: true, body };
}

function assertManage(db, userId, projectId) {
  const grant = effectiveProjectGrant(db, userId, projectId);
  if (!canManageProjectGrant(grant)) {
    const e = new Error('Requires project admin');
    e.name = 'AppError';
    e.code = 'ROLE_DENIED';
    e.status = 403;
    throw e;
  }
}

/**
 * Handle one project route. Returns true when it answered; false when the URL is not a project route.
 * `db`/`dir` are injectable for tests (the dispatcher passes the live handle and the data dir).
 */
export async function handleProjectRoute(req, res, { db = getDb(), logger, requestId, dir } = {}) {
  const url = String(req.url || '').split('?')[0];
  const method = req.method;
  const ip = clientIp(req);
  const ua = req.headers?.['user-agent'] || '';
  const dataDir = typeof dir === 'string' && dir ? dir : (config.dataDir ?? path.dirname(config.dbPath));

  if (!req.user) {
    if (logger) logger.warn?.('project_route_unauthenticated', { url });
    return fail(res, 401, 'AUTH_REQUIRED', 'Authentication required');
  }

  const audit = (action, detail, resource) => safeAudit(db, {
    userId: req.user.id, requestId, ip, userAgent: ua, action, resource, outcome: 'success', detail,
  });
  const fileAudit = (entry) => safeAudit(db, {
    userId: req.user.id, requestId, ip, userAgent: ua,
    action: entry.action, resource: entry.resource ?? null, outcome: entry.outcome ?? 'success',
    detail: { actor: 'team.yaml', ...(entry.detail ?? {}) },
  });

  try {
    if (method === 'GET' && url === '/projects') {
      send(res, 200, { projects: listProjectsForUser(db, req.user.id) });
      return true;
    }

    const planTasksMatch = PROJECT_PLAN_TASKS.exec(url);
    if (planTasksMatch) {
      const projectId = planTasksMatch[1];
      requireProject(db, projectId);
      if (method === 'GET') {
        // The helper re-checks project membership (role >= member), so a viewer gets 403.
        send(res, 200, listProjectPlanTasks(db, req.user.id, projectId));
        return true;
      }
      return fail(res, 404, 'NOT_FOUND', `No project route for ${method} ${url}`);
    }

    const membersMatch = PROJECT_MEMBERS.exec(url);
    if (membersMatch) {
      const projectId = membersMatch[1];
      requireProject(db, projectId);
      assertManage(db, req.user.id, projectId);

      if (method === 'GET') {
        const project = getProject(db, projectId);
        send(res, 200, {
          project: { id: project.id, name: project.name },
          members: listProjectMembers(db, projectId),
        });
        return true;
      }

      if (method === 'POST') {
        const parsed = await readBody(req);
        const input = parsed.ok ? closedObject(parsed.body, ADD_KEYS) : null;
        if (!input) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid project member');
        if (typeof input.email !== 'string' || !input.email.trim()) {
          return fail(res, 400, 'VALIDATION_FAILED', 'email is required');
        }
        if (input.usdCapMonth !== undefined && !validUsdCap(input.usdCapMonth)) {
          return fail(res, 400, 'VALIDATION_FAILED', 'Invalid USD cap');
        }
        const member = addProjectMemberByEmail(db, req.user.id, projectId, input);
        try {
          persistTeamYaml(db, dataDir, { logger, audit: fileAudit, trigger: 'project.member.add' });
        } catch {
          deleteProjectMemberRow(db, member.userId, projectId);
          return fail(res, 500, 'INTERNAL_ERROR', 'Could not write team.yaml; the project grant was rolled back');
        }
        audit('project.member.grant', {
          projectId, userId: member.userId, role: member.role,
          maxMode: member.maxMode, usdCapMonth: member.usdCapMonth,
        }, `${projectId}:${member.userId}`);
        send(res, 200, { member });
        return true;
      }

      return fail(res, 404, 'NOT_FOUND', `No project route for ${method} ${url}`);
    }

    const memberMatch = PROJECT_MEMBER.exec(url);
    if (memberMatch) {
      const projectId = memberMatch[1];
      const targetId = memberMatch[2];
      requireProject(db, projectId);
      assertManage(db, req.user.id, projectId);

      if (method === 'PATCH') {
        const parsed = await readBody(req);
        const patch = parsed.ok ? closedObject(parsed.body, PATCH_KEYS) : null;
        if (!patch) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid project member patch');
        if (patch.usdCapMonth !== undefined && !validUsdCap(patch.usdCapMonth)) {
          return fail(res, 400, 'VALIDATION_FAILED', 'Invalid USD cap');
        }
        const before = getProjectMemberSnapshot(db, targetId, projectId);
        const member = setProjectMember(db, req.user.id, projectId, targetId, patch);
        try {
          persistTeamYaml(db, dataDir, { logger, audit: fileAudit, trigger: 'project.member.patch' });
        } catch {
          if (before) restoreProjectMemberSnapshot(db, before);
          else deleteProjectMemberRow(db, targetId, projectId);
          return fail(res, 500, 'INTERNAL_ERROR', 'Could not write team.yaml; the project grant was rolled back');
        }
        audit('project.member.grant', {
          projectId, userId: targetId, role: member.role,
          maxMode: member.maxMode, usdCapMonth: member.usdCapMonth,
        }, `${projectId}:${targetId}`);
        send(res, 200, { member });
        return true;
      }

      if (method === 'DELETE') {
        const before = getProjectMemberSnapshot(db, targetId, projectId);
        const removed = removeProjectMember(db, req.user.id, projectId, targetId);
        try {
          persistTeamYaml(db, dataDir, { logger, audit: fileAudit, trigger: 'project.member.remove' });
        } catch {
          restoreProjectMemberSnapshot(db, before);
          return fail(res, 500, 'INTERNAL_ERROR', 'Could not write team.yaml; the removal was rolled back');
        }
        if (removed) audit('project.member.revoke', { projectId, userId: targetId }, `${projectId}:${targetId}`);
        send(res, 200, { removed });
        return true;
      }

      return fail(res, 404, 'NOT_FOUND', `No project route for ${method} ${url}`);
    }

    return fail(res, 404, 'NOT_FOUND', `No project route for ${method} ${url}`);
  } catch (err) {
    if (err && err.name === 'AppError') {
      const code = err.code === 'VALIDATION' ? 'VALIDATION_FAILED' : (err.code || 'VALIDATION_FAILED');
      return fail(res, err.status || 400, code, err.message);
    }
    throw err;
  }
}

