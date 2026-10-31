// HTTP routes of the extensions catalog (plan section 9, P4): install an item
// from GitHub at a pinned commit, list what is installed, switch it on or off,
// uninstall. Registered by routes/extension-routes.mjs; nothing else imports it.
//
//   GET  /auth/me/extensions/installed
//   POST /auth/me/extensions/install    { url, ref?, commit?, path? }
//   POST /auth/me/extensions/toggle     { id, enabled, consents?: string[], members?: string[] }
//   POST /auth/me/extensions/uninstall  { id }
//
// P5 (API 94): updates, rollback, repair, indexes and search. Reads are cache-only;
// every route that reaches the network is a user's POST (never a GET, never a timer):
//   GET  /auth/me/extensions/catalog?q=&kind=&limit=&offset=   browse the cached indexes
//   POST /auth/me/extensions/catalog/refresh  { source?, force? }
//   GET  /auth/me/extensions/active            what is switched on for turns (no configs, no paths)
//   GET  /auth/me/extensions/updates           what the last check found (no network)
//   POST /auth/me/extensions/updates/check     { id? }   resolve refs to commits
//   POST /auth/me/extensions/update/preview    { id, commit? }   diff, nothing written
//   POST /auth/me/extensions/update            { id, commit?, consents? }
//   POST /auth/me/extensions/rollback          { id }
//   POST /auth/me/extensions/repair            { id }
//
// Install allowlist, per user (API 95):
//   GET  /auth/me/extensions/allowlist          { operator, ceiling, user, ignored, effective }
//   PUT  /auth/me/extensions/allowlist { sources: string[] }   replaces the user's additions
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
import { checkUpdates, listUpdates, previewUpdate, applyUpdate, rollback, repair } from '../llm_agent/extensions/update.mjs';
import { refreshIndexes, searchCatalog } from '../llm_agent/extensions/indexes.mjs';
import { allowlistView, setAllowlist, AllowlistError } from '../llm_agent/extensions/allowlist.mjs';

const PATHS = new Set([
  '/auth/me/extensions/installed',
  '/auth/me/extensions/install',
  '/auth/me/extensions/toggle',
  '/auth/me/extensions/uninstall',
  '/auth/me/extensions/catalog',
  '/auth/me/extensions/catalog/refresh',
  '/auth/me/extensions/active',
  '/auth/me/extensions/updates',
  '/auth/me/extensions/updates/check',
  '/auth/me/extensions/update/preview',
  '/auth/me/extensions/update',
  '/auth/me/extensions/rollback',
  '/auth/me/extensions/repair',
  '/auth/me/extensions/allowlist',
]);
const GET_PATHS = new Set(['/auth/me/extensions/installed', '/auth/me/extensions/catalog', '/auth/me/extensions/active', '/auth/me/extensions/updates', '/auth/me/extensions/allowlist']);

export function isCatalogRoute(url) {
  return PATHS.has(String(url || '').split('?')[0]);
}

const STATUS = {
  invalid_url: 400, invalid_ref: 400, invalid_commit: 400, invalid_path: 400, invalid_member: 400, invalid_user: 400,
  not_found: 404, catalog_disabled: 404, source_not_allowed: 403, consent_required: 409, already_installed: 409, busy: 409,
  invalid_source: 400, too_many_sources: 400, source_exceeds_ceiling: 403,
  already_current: 409, bytes_missing: 409, integrity_mismatch: 409, no_previous: 404, previous_unavailable: 409, identity_changed: 422,
  marketplace: 422, nothing_installable: 422, unsafe_path: 422, too_large: 422, bad_archive: 422,
  blocked: 403, upstream: 502, redirect_refused: 502, aborted: 499, state_unreadable: 500, write_failed: 500,
};

function fail(res, err) {
  if (err instanceof InstallError || err instanceof AllowlistError) {
    send(res, STATUS[err.code] ?? 400, { error: { code: err.code.toUpperCase(), message: err.message, ...(Object.keys(err.extra).length ? { details: err.extra } : {}) } });
    return;
  }
  send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } });
}

function abortOnClose(req, res) {
  const ac = new AbortController();
  req.once('close', () => { if (!res.writableEnded) ac.abort(); });
  return ac;
}

/** What is switched on for this user's turns. Names and counts only: no server configs (they can hold credentials), no file paths. */
async function activeView(userId) {
  const { computeActiveSet } = await import('../llm_agent/extensions/active-set.mjs');
  const a = computeActiveSet(userId, 'execute');
  const cap = (arr, n) => arr.slice(0, n);
  return {
    fingerprint: a.fingerprint,
    failClosed: a.failClosed === true,
    items: cap(a.items, 500),
    skills: cap(a.skills.map((x) => ({ id: x.id, name: x.name, description: String(x.description ?? '').slice(0, 200), sourceId: x.sourceId })), 500),
    pluginSkills: cap(a.pluginSkills, 500),
    commands: cap(a.commands, 500),
    subagents: cap(a.subagents, 500),
    sdkPlugins: a.sdkPlugins.length,
    mcpServers: cap(Object.keys(a.mcpServers).sort(), 200),
    excluded: cap(a.excluded, 200),
    warnings: cap(a.warnings.map((w) => String(typeof w === 'string' ? w : w?.message ?? '').slice(0, 200)), 50),
  };
}

const str = (v) => (typeof v === 'string' ? v : undefined);

export async function handleCatalogRoute(req, res, { db, requestId }) {
  const url = String(req.url || '').split('?')[0];
  const method = req.method;
  const userId = req.user.id;
  const audit = (action, resource, outcome, detail) => safeAudit(db, {
    userId, requestId, ip: clientIp(req), userAgent: req.headers['user-agent'] || '', action, resource, outcome, ...(detail ? { detail } : {}),
  });

  if (url === '/auth/me/extensions/allowlist' && method === 'PUT') {
    let b;
    try { b = await readJson(req, config.bodyLimitMB * 1024 * 1024); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!b || typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.sources)) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'sources must be an array of owner/repo patterns' } }); return; }
    try {
      const view = setAllowlist(userId, b.sources);
      audit('extension.allowlist_set', 'allowlist', 'success', { count: view.user.length });
      send(res, 200, view);
    } catch (err) {
      if (err instanceof AllowlistError) audit('extension.allowlist_set', 'allowlist', 'failure', { code: err.code });
      fail(res, err);
    }
    return;
  }
  if (GET_PATHS.has(url)) {
    if (method !== 'GET') { send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } }); return; }
    try {
      if (url === '/auth/me/extensions/installed') send(res, 200, listInstalled(userId));
      else if (url === '/auth/me/extensions/updates') send(res, 200, listUpdates(userId));
      else if (url === '/auth/me/extensions/allowlist') send(res, 200, allowlistView(userId));
      else if (url === '/auth/me/extensions/catalog') {
        const sp = new URL(req.url, 'http://x').searchParams;
        const num = (k) => (sp.has(k) && /^\d{1,6}$/.test(sp.get(k)) ? Number(sp.get(k)) : undefined);
        const kind = sp.get('kind') ?? undefined;
        if (kind !== undefined && !['skill', 'plugin', 'mcp', 'llm-source'].includes(kind)) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'kind must be skill, plugin, mcp or llm-source' } }); return; }
        send(res, 200, searchCatalog(userId, { q: (sp.get('q') ?? '').slice(0, 200), kind, limit: num('limit'), offset: num('offset') }));
      } else if (url === '/auth/me/extensions/active') send(res, 200, await activeView(userId));
    } catch { send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } }); }
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
    if (url === '/auth/me/extensions/catalog/refresh') {
      if ((body.source !== undefined && typeof body.source !== 'string') || (body.force !== undefined && typeof body.force !== 'boolean')) {
        send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'source must be a string and force a boolean' } }); return;
      }
      const ac = abortOnClose(req, res);
      try { send(res, 200, await refreshIndexes({ sourceId: body.source, force: body.force === true, signal: ac.signal })); }
      catch (err) {
        if (err?.code === 'not_found') throw new InstallError('not_found', 'unknown index source');
        if (err?.code === 'catalog_disabled') throw new InstallError('catalog_disabled', 'the extensions catalog is switched off');
        throw err;
      }
      return;
    }
    if (url === '/auth/me/extensions/updates/check') {
      if (body.id !== undefined && !parseItemId(body.id)) throw new InstallError('not_found', 'not installed');
      const r = await checkUpdates(userId, { id: body.id, signal: abortOnClose(req, res).signal });
      audit('extension.updates_check', body.id ? String(body.id) : 'all', 'success', { updates: r.results.filter((x) => x.updateAvailable).length });
      send(res, 200, r);
      return;
    }
    if (!parseItemId(body.id)) throw new InstallError('not_found', 'not installed');
    if (url === '/auth/me/extensions/update/preview' || url === '/auth/me/extensions/update') {
      if (body.commit !== undefined && typeof body.commit !== 'string') { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'commit must be a string' } }); return; }
      const ac = abortOnClose(req, res);
      if (url.endsWith('/preview')) { send(res, 200, await previewUpdate(userId, body.id, { commit: body.commit, signal: ac.signal })); return; }
      if (body.consents !== undefined && !(Array.isArray(body.consents) && body.consents.every((x) => typeof x === 'string'))) {
        send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'consents must be an array of strings' } }); return;
      }
      const r = await applyUpdate(userId, body.id, { commit: body.commit, consents: body.consents ?? [], signal: ac.signal });
      audit('extension.update', body.id, 'success', { from: r.update.from, to: r.update.to, enabled: r.update.enabled, ...(r.update.reason ? { reason: r.update.reason } : {}), ...(body.consents?.length ? { consents: body.consents } : {}) });
      send(res, 200, r);
      return;
    }
    if (url === '/auth/me/extensions/rollback') {
      const r = rollback(userId, body.id);
      audit('extension.rollback', body.id, 'success', { from: r.rollback.from, to: r.rollback.to, enabled: r.rollback.enabled });
      send(res, 200, r);
      return;
    }
    if (url === '/auth/me/extensions/repair') {
      const r = await repair(userId, body.id, { signal: abortOnClose(req, res).signal });
      audit('extension.repair', body.id, 'success', { status: r.status });
      send(res, 200, r);
      return;
    }
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
    if (url === '/auth/me/extensions/uninstall') {
      const r = uninstall(userId, body.id);
      audit('extension.uninstall', body.id, 'success');
      send(res, 200, r);
      return;
    }
    throw new InstallError('not_found', 'unknown route');
  } catch (err) {
    if (err instanceof InstallError && body?.id) audit(`extension.${url.split('/').pop()}`, String(body.id).slice(0, 120), 'failure', { code: err.code });
    fail(res, err);
  }
}
