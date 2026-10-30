// HTTP routes of the extensions catalog (plan section 9, P4): install an item
// from GitHub at a pinned commit, list what is installed, switch it on or off,
// uninstall. Registered by routes/extension-routes.mjs; nothing else imports it.
//
//   GET  /auth/me/extensions/installed
//   POST /auth/me/extensions/install    { url, ref?, commit?, path? }
//   POST /auth/me/extensions/toggle     { id, enabled, consents?: string[], members?: string[] }
//   POST /auth/me/extensions/uninstall  { id }
//
// Every download is the user's request and goes through the pinned fetch
// (github.com only). Installing never enables or runs anything; enabling an
// item that declares executable parts needs consent per kind. Per-user: a user
// only ever sees and changes their own items. Gated by LLMIDE_EXT_CATALOG
// (install only; reading and switching what is installed keeps working).

import { config } from '../core/config.mjs';
import { send, readJson, clientIp, safeAudit } from '../server/route-http.mjs';
import { parseItemId } from '../llm_agent/extensions/model.mjs';
import {
  installFromGithub, listInstalled, setInstalledEnabled, setInstalledMembers, uninstall, InstallError,
} from '../llm_agent/extensions/install.mjs';

const PATHS = new Set([
  '/auth/me/extensions/installed',
  '/auth/me/extensions/install',
  '/auth/me/extensions/toggle',
  '/auth/me/extensions/uninstall',
]);

export function isCatalogRoute(url) {
  return PATHS.has(String(url || '').split('?')[0]);
}

const STATUS = {
  invalid_url: 400, invalid_ref: 400, invalid_commit: 400, invalid_path: 400, invalid_member: 400, invalid_user: 400,
  not_found: 404, catalog_disabled: 404, source_not_allowed: 403, consent_required: 409, already_installed: 409, busy: 409,
  marketplace: 422, nothing_installable: 422, unsafe_path: 422, too_large: 422, bad_archive: 422,
  blocked: 403, upstream: 502, redirect_refused: 502, aborted: 499, state_unreadable: 500, write_failed: 500,
};

function fail(res, err) {
  if (err instanceof InstallError) {
    send(res, STATUS[err.code] ?? 400, { error: { code: err.code.toUpperCase(), message: err.message, ...(Object.keys(err.extra).length ? { details: err.extra } : {}) } });
    return;
  }
  send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } });
}

const str = (v) => (typeof v === 'string' ? v : undefined);

export async function handleCatalogRoute(req, res, { db, requestId }) {
  const url = String(req.url || '').split('?')[0];
  const method = req.method;
  const userId = req.user.id;
  const audit = (action, resource, outcome, detail) => safeAudit(db, {
    userId, requestId, ip: clientIp(req), userAgent: req.headers['user-agent'] || '', action, resource, outcome, ...(detail ? { detail } : {}),
  });

  if (url === '/auth/me/extensions/installed') {
    if (method !== 'GET') { send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } }); return; }
    send(res, 200, listInstalled(userId));
    return;
  }
  if (method !== 'POST') { send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }); return; }

  let body;
  try { body = await readJson(req, config.bodyLimitMB * 1024 * 1024); }
  catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'body must be an object' } }); return; }

  try {
    if (url === '/auth/me/extensions/install') {
      const ac = new AbortController();
      req.once('close', () => { if (!res.writableEnded) ac.abort(); });
      const r = await installFromGithub({ userId, url: str(body.url) ?? '', ref: str(body.ref), commit: str(body.commit), path: str(body.path) }, { signal: ac.signal });
      audit('extension.install', r.item.id, 'success', { commit: r.item.pinnedCommit, trust: r.item.publisher.trust, findings: r.item.scan.count });
      send(res, 200, r);
      return;
    }
    if (!parseItemId(body.id)) throw new InstallError('not_found', 'not installed');
    if (url === '/auth/me/extensions/toggle') {
      if (typeof body.enabled !== 'boolean') { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'enabled must be a boolean' } }); return; }
      const arr = (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined);
      if ((body.consents !== undefined && !arr(body.consents)) || (body.members !== undefined && !arr(body.members))) {
        send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'consents and members must be arrays of strings' } }); return;
      }
      const item = Array.isArray(body.members) && body.members.length
        ? setInstalledMembers(userId, body.id, body.members, body.enabled)
        : setInstalledEnabled(userId, body.id, body.enabled, { consents: body.consents ?? [] });
      audit(body.members?.length ? 'extension.members' : (body.enabled ? 'extension.enable' : 'extension.disable'), body.id, 'success',
        { commit: item.pinnedCommit, ...(body.consents?.length ? { consents: body.consents } : {}) });
      send(res, 200, { ok: true, item });
      return;
    }
    // /auth/me/extensions/uninstall
    const r = uninstall(userId, body.id);
    audit('extension.uninstall', body.id, 'success');
    send(res, 200, r);
  } catch (err) {
    if (err instanceof InstallError && body?.id) audit(`extension.${url.split('/').pop()}`, String(body.id).slice(0, 120), 'failure', { code: err.code });
    fail(res, err);
  }
}
