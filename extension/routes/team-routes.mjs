// Team Hub admin routes (ADR 0021 H1): team members and their invites. Dispatched from server.mjs like
// routes/self-heal.mjs — always on, no feature group. Every route needs the JWT and the admin team role;
// `requireRole` is the one gate (it reads the `members` row, never the JWT claim). Writes carry the
// kbWrite rate-limit bucket (server.mjs rateLimitProfile) and each change is audited:
//
//   GET    /admin/members        { members: [{ userId, email, displayName, status, teamRole, maxMode, usdCapMonth, updatedAt }] }
//   PATCH  /admin/members/:id    { teamRole?, maxMode?, usdCapMonth? } → { member }   audit team.grant
//   POST   /admin/invites        { email?, teamRole?, maxMode?, usdCapMonth?, ttlHours? } → { id, token, expiresAt }
//                                                                                     audit team.invite (never the token)
//   GET    /admin/invites        { invites: [...] }                                   never the token
//   DELETE /admin/invites/:id    { revoked }                                          audit team.invite.revoke
//
// Validation is a closed object per route (an unknown key is a 400, not silently ignored), enums as in
// migration 0068, usdCapMonth 0-100000, ttlHours 1-168, email <= 254 chars.
import { getDb } from '../kb/db.mjs';
import { requireRole } from '../server/auth.mjs';
import { send, readJson, clientIp, safeAudit } from '../server/route-http.mjs';
import {
  MAX_USD_CAP_MONTH, createInvite, listInvites, listMembers, revokeInvite, setMember,
} from '../kb/members.mjs';

const BODY_MAX = 64 * 1024;
const MEMBER_PATH = /^\/admin\/members\/([A-Za-z0-9_-]{1,64})$/;
const INVITE_PATH = /^\/admin\/invites\/([0-9a-f]{16})$/;
const PATCH_KEYS = ['teamRole', 'maxMode', 'usdCapMonth'];
const INVITE_KEYS = ['email', 'teamRole', 'maxMode', 'usdCapMonth', 'ttlHours'];

export function isTeamRoute(url) {
  const p = String(url || '').split('?')[0];
  return p === '/admin/members' || p.startsWith('/admin/members/')
    || p === '/admin/invites' || p.startsWith('/admin/invites/');
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

/** A bounded JSON object body: { ok, body }. ok:false = malformed JSON or a non-object body (400). */
async function readBody(req) {
  let body;
  try { body = await readJson(req, BODY_MAX); } catch { return { ok: false, body: null }; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, body: null };
  return { ok: true, body };
}

export async function handleTeamRoute(req, res, { db = getDb(), logger, requestId } = {}) {
  const url = String(req.url || '').split('?')[0];
  const method = req.method;
  const ip = clientIp(req);
  const ua = req.headers?.['user-agent'] || '';

  if (!req.user) {
    if (logger) logger.warn?.('team_route_unauthenticated', { url });
    return fail(res, 401, 'AUTH_REQUIRED', 'Authentication required');
  }
  const audit = (action, detail, resource) => safeAudit(db, {
    userId: req.user.id, requestId, ip, userAgent: ua, action, resource, outcome: 'success', detail,
  });

  try {
    // The one team gate: reads the caller's `members` row. A refused caller gets 403 ROLE_DENIED.
    requireRole(db, req, 'admin');
    return await handleAuthorized();
  } catch (err) {
    // AppError (ROLE_DENIED, SELF_GRANT, LAST_OWNER, VALIDATION, NOT_FOUND, INVITE_INVALID) carries its own
    // status and code; anything else is a bug and reaches server.mjs's sendError.
    if (err && err.name === 'AppError') {
      // The store's internal `VALIDATION` code is the API's VALIDATION_FAILED on the wire.
      const code = err.code === 'VALIDATION' ? 'VALIDATION_FAILED' : (err.code || 'VALIDATION_FAILED');
      return fail(res, err.status || 400, code, err.message);
    }
    throw err;
  }

  async function handleAuthorized() {
  if (method === 'GET' && url === '/admin/members') {
    send(res, 200, { members: listMembers(db) });
    return true;
  }

  const memberMatch = MEMBER_PATH.exec(url);
  if (method === 'PATCH' && memberMatch) {
    const parsed = await readBody(req);
    const patch = parsed.ok ? closedObject(parsed.body, PATCH_KEYS) : null;
    if (!patch) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid member patch');
    if (patch.usdCapMonth !== undefined) {
      const n = Number(patch.usdCapMonth);
      if (!Number.isFinite(n) || n < 0 || n > MAX_USD_CAP_MONTH) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid USD cap');
    }
    const updated = setMember(db, req.user.id, memberMatch[1], patch);
    audit('team.grant', patch, memberMatch[1]);
    // The same row shape GET /admin/members returns (the store helper answers the four grant fields).
    const member = listMembers(db).find((m) => m.userId === updated.userId) ?? updated;
    send(res, 200, { member });
    return true;
  }

  if (method === 'POST' && url === '/admin/invites') {
    const parsed = await readBody(req);
    if (!parsed.ok) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid invite');
    const input = closedObject(parsed.body, INVITE_KEYS);
    if (!input) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid invite');
    if (input.email !== undefined && input.email !== null
        && (typeof input.email !== 'string' || input.email.length > 254)) {
      return fail(res, 400, 'VALIDATION_FAILED', 'Invalid email');
    }
    const out = createInvite(db, req.user.id, input);
    // The token is returned once and never logged or stored in plaintext.
    audit('team.invite', {
      invite: out.id, email: input.email ?? null, teamRole: input.teamRole ?? 'member',
      maxMode: input.maxMode ?? 'read_only', usdCapMonth: input.usdCapMonth ?? 20,
    }, out.id);
    send(res, 200, { id: out.id, token: out.token, expiresAt: out.expiresAt });
    return true;
  }

  if (method === 'GET' && url === '/admin/invites') {
    send(res, 200, { invites: listInvites(db) });
    return true;
  }

  const inviteMatch = INVITE_PATH.exec(url);
  if (method === 'DELETE' && inviteMatch) {
    const revoked = revokeInvite(db, req.user.id, inviteMatch[1]);
    audit('team.invite.revoke', { invite: inviteMatch[1] }, inviteMatch[1]);
    send(res, 200, { revoked });
    return true;
  }

  // /admin/members and /admin/invites belong to this module: an unmatched method or an id that cannot be
  // valid is a 404 here, not a fall-through to another router.
  return fail(res, 404, 'NOT_FOUND', `No team route for ${method} ${url}`);
  }
}
