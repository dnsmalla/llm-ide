// HTTP routes of workspace trust (migration 0056). Registered by routes/extension-routes.mjs; nothing else imports it.
//
//   GET /auth/me/workspace-trust                 → { enforced, items: [{ path, trusted, updatedAt }] }
//   PUT /auth/me/workspace-trust { path, trusted } → { ok, item }
//
// Trust is only ever set here, by the signed-in user's explicit request; nothing trusts a folder on its own.
// The path is stored as its real path (symlinks resolved), so a link and its target are one folder.
import { config } from '../core/config.mjs';
import { isTooBroadTrustRoot } from '../core/broad-root.mjs';
import { send, readJson, clientIp, safeAudit } from '../server/route-http.mjs';
import { normalizeWorkspaceRoot } from '../llm_agent/adapter/tool-bridge.mjs';
import { workspaceTrustEnabled } from '../llm_agent/extensions/flags.mjs';
import { listWorkspaceTrust, setWorkspaceTrust, realFolder } from '../kb/workspace-trust.mjs';

export function isWorkspaceTrustRoute(url) {
  const path = String(url || '').split('?')[0];
  return path === '/auth/me/workspace-trust';
}

const bad = (res, status, code, message) => send(res, status, { error: { code, message } });

export async function handleWorkspaceTrustRoute(req, res, { db, requestId }) {
  const userId = req.user.id;
  try {
    if (req.method === 'GET') { send(res, 200, { enforced: workspaceTrustEnabled(), items: listWorkspaceTrust(userId) }); return; }
    if (req.method !== 'PUT') { bad(res, 405, 'METHOD_NOT_ALLOWED', 'GET or PUT only'); return; }
    let body;
    try { body = await readJson(req, config.bodyLimitMB * 1024 * 1024); }
    catch (err) { bad(res, 400, 'VALIDATION_FAILED', err.message); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { bad(res, 400, 'VALIDATION_FAILED', 'body must be an object'); return; }
    if (typeof body.trusted !== 'boolean') { bad(res, 400, 'VALIDATION_FAILED', 'trusted must be a boolean'); return; }
    if (typeof body.path !== 'string' || !body.path.trim()) { bad(res, 400, 'VALIDATION_FAILED', 'path must be a non-empty string'); return; }
    let abs;
    try { abs = normalizeWorkspaceRoot(body.path.trim()); } catch (e) { bad(res, 400, 'VALIDATION_FAILED', e.message); return; }
    const real = realFolder(abs);
    if (!real) { bad(res, 404, 'NOT_FOUND', 'that folder does not exist'); return; }
    if (isTooBroadTrustRoot(real)) { bad(res, 400, 'INVALID_PATH', 'that folder is too broad to trust as one project'); return; }
    const r = setWorkspaceTrust(userId, real, body.trusted);
    if (r.error) { bad(res, 400, 'VALIDATION_FAILED', 'too many trust records; remove one first'); return; }
    safeAudit(db, { userId, requestId, ip: clientIp(req), userAgent: req.headers['user-agent'] || '', action: 'workspace.trust', resource: real, outcome: 'success', detail: { trusted: body.trusted } });
    send(res, 200, { ok: true, item: r });
  } catch { send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } }); }
}
