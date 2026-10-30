// HTTP routes for the extension surface: plugins (native, Claude, Codex),
// LLM sources and MCP plugins, all under /auth/me/*. Moved out of
// server/auth-routes.mjs (Track Q, T-Q.1) as a PURE MOVE: same paths, methods,
// admin gates, error codes and response shapes. The URLs keep the /auth/me
// prefix (a wire rename would be an API break); only the owning module changed.
//
// Dispatch order is unchanged: server.mjs authenticates, then tries
// isAuthRoute, then isExtensionRoute, both before rate limiting. Every route
// here needs a signed-in user (the same 401 guard auth-routes applies below its
// public block), and the admin-gated ones call requireAdmin per route.
//
// Layer: L4 route module. May import plugins/, mcp/, llm-sources/, llm_agent/
// and connectors/; nothing imports this file except server.mjs.

import { join } from 'node:path';
import { config } from '../core/config.mjs';
import { errValidation } from '../core/errors.mjs';
import { requireAdmin } from '../server/auth.mjs';
import { flushWarmCliPool } from '../providers/warm-cli-pool.mjs';
import { RESERVED_MCP_NAME } from '../llm_agent/sdk/constants.mjs';
import {
  send, readJson, readRawBody, clientIp, safeAudit, publicMessageFor,
} from '../server/route-http.mjs';
import { isCatalogRoute, handleCatalogRoute } from './extensions-catalog.mjs';

// Redact an MCP plugin's env VALUES for a client response — key names are
// harmless (they're identifiers like "SLACK_TOKEN", not secrets) and the
// Mac client only ever displays the key list, but the values are real
// credentials that must never leave the server for a plain GET.
function redactEnvValues(env) {
  if (!env || typeof env !== 'object') return env;
  return Object.fromEntries(Object.keys(env).map((k) => [k, '••••']));
}

// A hosted MCP server's headers carry its bearer token, so they need exactly
// the same treatment as env: the plugin registry is shared across users and
// this endpoint is reachable by any authenticated one, so an unredacted
// passthrough would hand over another user's imported credentials. Key names
// are kept — the detail view lists them, never values.
const redactHeaderValues = redactEnvValues;

/**
 * `url` with credentials masked: userinfo and query VALUES (`?api_key=…`) are
 * where a hosted server's secret usually rides. Host and path stay readable;
 * a token embedded in the path itself cannot be told apart from a real path.
 */
function redactUrlSecrets(value) {
  if (typeof value !== 'string') return value;
  try {
    const u = new URL(value);
    if (u.username) u.username = '••••';
    if (u.password) u.password = '••••';
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '••••');
    return u.toString();
  } catch { return value; }
}

/** An MCP server record with env/header/URL secrets masked (names kept). */
function redactServerSecrets(server) {
  if (!server || typeof server !== 'object') return server;
  return {
    ...server,
    ...(server.url ? { url: redactUrlSecrets(server.url) } : {}),
    ...(server.env ? { env: redactEnvValues(server.env) } : {}),
    ...(server.headers ? { headers: redactHeaderValues(server.headers) } : {}),
  };
}

// Literal paths and prefixes this module owns. The query string is stripped
// before matching, so /auth/me/llm-sources/updates?force=1 still dispatches.
const EXACT_PATHS = new Set([
  '/auth/me/plugins',
  '/auth/me/plugins/toggle',
  '/auth/me/plugins/hook-trust',
  '/auth/me/plugins/reload',
  '/auth/me/plugins/install',
  '/auth/me/claude-plugins/installed',
  '/auth/me/claude-plugins/marketplace',
  '/auth/me/claude-plugins/import',
  '/auth/me/claude-plugins/refresh',
  '/auth/me/claude-plugins/updates',
  '/auth/me/claude-plugins/update',
  '/auth/me/codex-plugins/installed',
  '/auth/me/codex-plugins/marketplace',
  '/auth/me/codex-plugins/import',
  '/auth/me/codex-plugins/refresh',
  '/auth/me/codex-plugins/updates',
  '/auth/me/llm-sources',
  '/auth/me/llm-sources/toggle',
  '/auth/me/llm-sources/add',
  '/auth/me/llm-sources/update',
  '/auth/me/mcp-plugins',
  '/auth/me/mcp-plugins/catalog',
  '/auth/me/mcp-plugins/claude-sources',
  '/auth/me/mcp-plugins/codex-sources',
  '/auth/me/mcp-plugins/add',
  '/auth/me/mcp-plugins/consent',
  '/auth/me/mcp-plugins/toggle',
]);
const PREFIXES = [
  '/auth/me/plugins/uninstall/',
  '/auth/me/llm-sources/',
  '/auth/me/mcp-plugins/',
];

/** True when the request URL belongs to this module (see EXACT_PATHS / PREFIXES). */
export function isExtensionRoute(url) {
  const path = String(url || '').split('?')[0];
  return EXACT_PATHS.has(path) || isCatalogRoute(path) || PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Handle one extension route. Mirrors handleAuth's contract: writes the
 * response itself and returns; thrown errors are the caller's to map.
 */
export async function handleExtensionRoute(req, res, { db, logger, requestId }) {
  const url = req.url || '';
  const method = req.method;
  const bodyLimit = config.bodyLimitMB * 1024 * 1024;
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  // Same guard auth-routes applies below its public block. authenticate()
  // has already run, so this only fires for a request that reached us with
  // no valid token.
  if (!req.user) {
    send(res, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
    return;
  }

  if (isCatalogRoute(url)) { await handleCatalogRoute(req, res, { db, requestId }); return; }

  // ── Plugin management ───────────────────────────────────────────────
  // GET  /auth/me/plugins         → list installed + per-user enable state
  // POST /auth/me/plugins/toggle  → { name, enabled }
  // POST /auth/me/plugins/reload  → re-scan the plugin directory
  if (method === 'GET' && url.split('?')[0] === '/auth/me/plugins') {
    const { listInstalledPlugins } = await import('../llm_agent/skills/index.mjs');
    send(res, 200, listInstalledPlugins(req.user.id));
    return;
  }

  if (method === 'POST' && url === '/auth/me/plugins/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      if (!body || typeof body.name !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.name)) {
        throw errValidation('name must be a valid plugin slug');
      }
      if (typeof body.enabled !== 'boolean') {
        throw errValidation('enabled must be a boolean');
      }
      const { setEnabled } = await import('../plugins/state.mjs');
      const { listInstalledPlugins } = await import('../llm_agent/skills/index.mjs');
      // Refuse to enable something that isn't installed — prevents
      // stale enable entries for plugins the user uninstalled.
      const installed = listInstalledPlugins(req.user.id);
      const found = installed.plugins.find((p) => p.name === body.name);
      if (!found && body.enabled) {
        throw errValidation(`plugin '${body.name}' is not installed`);
      }
      setEnabled(req.user.id, body.name, body.enabled);
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: body.enabled ? 'plugin.enable' : 'plugin.disable',
        resource: body.name, outcome: 'success',
      });
      send(res, 200, { ok: true, enabled: body.enabled });
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  // POST /auth/me/plugins/hook-trust → { name, trusted }
  // Trusting a plugin's hooks authorizes shell commands from that plugin to
  // run during a turn, so it is a separate, audited grant — never implied by
  // enabling the plugin.
  if (method === 'POST' && url === '/auth/me/plugins/hook-trust') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const { setPluginHookTrust } = await import('../plugins/hook-trust.mjs');
    const { listInstalledPlugins } = await import('../llm_agent/skills/index.mjs');
    const result = setPluginHookTrust(req.user.id, body?.name, body?.trusted, {
      listPlugins: (userId) => listInstalledPlugins(userId).plugins,
      shownKinds: Array.isArray(body?.kinds) ? body.kinds : undefined,
    });
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'VALIDATION_FAILED', message: result.error } });
      return;
    }
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: result.hooksTrusted ? 'plugin.hooks.trust' : 'plugin.hooks.revoke',
      resource: body.name, outcome: 'success',
      // What the grant covered, so the audit trail can answer "what did they allow".
      ...(result.kinds ? { detail: { kinds: result.kinds } } : {}),
    });
    send(res, 200, { ok: result.ok, hooksTrusted: result.hooksTrusted });
    return;
  }

  if (method === 'POST' && url === '/auth/me/plugins/reload') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
    const result = reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'plugin.reload', outcome: 'success',
      detail: { count: result.count },
    });
    send(res, 200, result);
    return;
  }

  // POST /auth/me/plugins/install
  //
  // Body is the raw zip bytes (Content-Type: application/zip). Why
  // not multipart/form-data? Because we'd need a multipart parser as
  // a dep and the only field is the bytes themselves. raw bytes is
  // smaller surface. Body cap is 5 MB enforced by readRawBody — the
  // larger of bodyLimitMB or the installer's own internal cap.
  if (method === 'POST' && url.split('?')[0] === '/auth/me/plugins/install') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const u = new URL(url, 'http://127.0.0.1');
    const replace = u.searchParams.get('replace') === '1';
    // The plugin an update means to replace; the installer refuses a package
    // that names another one (NAME_MISMATCH) before touching anything.
    const expectName = u.searchParams.get('expect');
    let zipBytes;
    try {
      zipBytes = await readRawBody(req, 5 * 1024 * 1024);
    } catch (err) {
      send(res, err.status || 413, { error: { code: err.code || 'PAYLOAD_TOO_LARGE', message: err.message } });
      return;
    }
    // Header/query errors are reported only after the body is drained, so a 400
    // never leaves the client mid-upload.
    if (expectName !== null && !/^[a-z][a-z0-9-]{1,40}$/.test(expectName)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'expect must be a plugin name' } });
      return;
    }
    const { decodeSourceHeader, setSource, removeSource, getSource } = await import('../plugins/source-store.mjs');
    const sourceHeader = req.headers['x-llmide-plugin-source'];
    const decoded = decodeSourceHeader(Array.isArray(sourceHeader) ? sourceHeader[0] : sourceHeader);
    if (!decoded.ok) {
      send(res, 400, { error: { code: 'INVALID_SOURCE', message: decoded.error } });
      return;
    }
    const { installFromZip } = await import('../plugins/installer.mjs');
    const { clearHooksTrustForPlugin } = await import('../plugins/state.mjs');
    const { clearPluginMcpConsents } = await import('../mcp/state.mjs');
    const result = await installFromZip(zipBytes, {
      replace,
      expectName: expectName ?? undefined,
      trust: { clearTrust: clearHooksTrustForPlugin, clearMcpConsents: clearPluginMcpConsents },
    });
    if (result.error) {
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'plugin.install', outcome: 'failure',
        detail: { error: result.error.slice(0, 200) },
      });
      send(res, result.status || 400, { error: { code: result.code || 'INSTALL_FAILED', message: result.error } });
      return;
    }
    try {
      if (decoded.source) setSource(result.plugin.name, decoded.source);
      else if (!result.plugin.replaced) removeSource(result.plugin.name);
    } catch (err) {
      // The install already succeeded; a record write failure must not turn it into a 500.
      logger.warn('plugin source record write failed', { plugin: result.plugin.name, error: err.message });
    }
    // Re-scan so the runtime picks up the new plugin immediately.
    const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'plugin.install', resource: result.plugin.name, outcome: 'success',
      detail: {
        version: result.plugin.version, replaced: !!result.plugin.replaced,
        trustReset: !!result.plugin.trustReset, sourceKind: decoded.source?.kind ?? null,
      },
    });
    let installSource = null;
    try { installSource = getSource(result.plugin.name) ?? null; } catch { /* record unreadable */ }
    send(res, 200, { ...result, installSource });
    return;
  }

  // DELETE /auth/me/plugins/uninstall/<name>
  //
  // Removes the plugin folder + prunes orphaned enable-state entries
  // for users who had it enabled. Plugin removal is a server-wide
  // operation (plugins are global, enable state is per-user), so it goes
  // through requireAdmin below — which on this local-first install means
  // "authenticated" (see requireAdmin's doc comment in server/auth.mjs).
  // The gate stays here so a future multi-operator deployment tightens it
  // in one place.
  if (method === 'DELETE' && url.startsWith('/auth/me/plugins/uninstall/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const pluginName = decodeURIComponent(url.slice('/auth/me/plugins/uninstall/'.length).split('?')[0]);
    // Validate the plugin slug before passing to the uninstaller — an
    // attacker who can call this endpoint could otherwise attempt path
    // traversal via a crafted name like '../../etc/passwd'.
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(pluginName)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    const { uninstall } = await import('../plugins/installer.mjs');
    const result = await uninstall(pluginName);
    if (result.error) {
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'plugin.uninstall', resource: pluginName, outcome: 'failure',
        detail: { error: result.error.slice(0, 200) },
      });
      send(res, result.status || 400, { error: { code: 'UNINSTALL_FAILED', message: result.error } });
      return;
    }
    // Forget where it came from so a reinstall by the same name starts clean.
    try {
      (await import('../plugins/source-store.mjs')).removeSource(pluginName);
    } catch (err) {
      // The uninstall already succeeded; a stale record must not turn it into a 500.
      logger.warn('plugin source record removal failed', { plugin: pluginName, error: err.message });
    }
    // Reload to drop the registry entry + prune orphan state.
    const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'plugin.uninstall', resource: pluginName, outcome: 'success',
      detail: { removed: result.removed },
    });
    send(res, 200, result);
    return;
  }

  // ── Claude Plugin Bridge ───────────────────────────────────────────
  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/installed') {
    const { scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/claude-adapter.mjs');
    const plugins = scanInstalled();
    const imported = listImportedNames();
    for (const p of plugins) {
      const mnName = p.name.startsWith('claude-') ? p.name : `claude-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/marketplace') {
    const { scanMarketplace, scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/claude-adapter.mjs');
    const plugins = scanMarketplace();
    const installed = scanInstalled();
    const installedNames = new Set(installed.map(p => p.name));
    const imported = listImportedNames();
    for (const p of plugins) {
      p.installedInClaude = installedNames.has(p.name);
      const mnName = p.name.startsWith('claude-') ? p.name : `claude-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'POST' && url === '/auth/me/claude-plugins/import') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || !body.name || !body.source) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'name and source required' } });
      return;
    }
    if (!['installed', 'marketplace'].includes(body.source)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'source must be installed or marketplace' } });
      return;
    }
    // Validate plugin name to prevent path traversal
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(body.name)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    const { importPlugin, scanInstalled } = await import('../plugins/claude-adapter.mjs');
    // An installed import is stamped with the Claude install it copied, so the
    // update check can tell "Claude is ahead" from "same version". Without the
    // stamp every route import reads as Tier 1 forever. Marketplace imports
    // have no Claude install to stamp from.
    const installed = body.source === 'installed' ? scanInstalled().find((p) => p.name === body.name) : null;
    const { importWithTrustCheck } = await import('../plugins/import-trust.mjs');
    const { defaultPluginDir } = await import('../plugins/loader.mjs');
    const { clearHooksTrustForPlugin } = await import('../plugins/state.mjs');
    const { clearPluginMcpConsents } = await import('../mcp/state.mjs');
    // A re-import over an existing copy can swap in new hooks/MCP servers;
    // trust granted to the old executables must not carry over.
    const mnName = body.name.startsWith('claude-') ? body.name : `claude-${body.name}`;
    const result = importWithTrustCheck({
      dir: join(defaultPluginDir(), mnName),
      doImport: () => importPlugin({
        source: body.source, name: body.name,
        ...(installed ? { installPath: installed.installPath, sourceVersion: installed.version, scope: installed.scope ?? null } : {}),
      }),
      clearTrust: clearHooksTrustForPlugin,
      clearMcpConsents: clearPluginMcpConsents,
    });
    if (!result.ok) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: result.error } });
      return;
    }
    // An import that overwrote a same-named dir must not keep a git/marketplace record.
    try {
      (await import('../plugins/source-store.mjs')).removeSource(result.plugin.name);
    } catch (err) {
      logger.warn('plugin source record removal failed', { plugin: result.plugin.name, error: err.message });
    }
    const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'claude-plugin.import', resource: result.plugin.name, outcome: 'success',
      detail: { source: body.source, version: result.plugin.version },
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/claude-plugins/refresh') {
    const { scanInstalled, scanMarketplace } = await import('../plugins/claude-adapter.mjs');
    const installed = scanInstalled();
    const marketplace = scanMarketplace();
    send(res, 200, { installed: installed.length, marketplace: marketplace.length });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/updates') {
    const force = new URL(url, 'http://x').searchParams.get('force') === '1';
    try {
      const { checkClaudeUpdates, withLegacyFields } = await import('../plugins/claude-update.mjs');
      const result = await checkClaudeUpdates({ force });
      send(res, 200, { ...result, updates: result.updates.map(withLegacyFields) });
    } catch (err) {
      send(res, 500, { error: { code: 'CHECK_FAILED', message: publicMessageFor(err) } });
    }
    return;
  }

  // Update one Claude-imported plugin: Claude Code's own update first, then a
  // re-import. Admin-only. Statuses are the orchestrator's (see claude-update.mjs).
  if (method === 'POST' && url === '/auth/me/claude-plugins/update') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    const name = body?.name;
    const acceptCommand = body?.acceptCommand;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{1,48}$/.test(name)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    if (acceptCommand !== undefined && (typeof acceptCommand !== 'string' || !/^[0-9a-f]{8,128}$/i.test(acceptCommand))) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid acceptCommand' } });
      return;
    }
    const auditBase = { userId: req.user.id, requestId, ip, userAgent: ua, action: 'claude-plugin.update', resource: name };
    try {
      const { updateClaudePlugin } = await import('../plugins/claude-update.mjs');
      const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
      const { clearPluginMcpConsents } = await import('../mcp/state.mjs');
      const { activeTurnCount } = await import('../routes/agent-v2.mjs');
      const { status, body: out } = await updateClaudePlugin({
        name, acceptCommand,
        deps: { reload: reloadPlugins, isTurnActive: () => activeTurnCount() > 0, clearMcpConsents: clearPluginMcpConsents },
      });
      if (status === 200 && out.ok) {
        flushWarmCliPool('plugin_update');
        safeAudit(db, { ...auditBase, outcome: 'success', detail: { from: out.from, to: out.to, trustReset: out.trustReset, claudeUpdated: out.claudeUpdated } });
      } else {
        safeAudit(db, { ...auditBase, outcome: 'failure', detail: { code: out.code || String(status) } });
      }
      send(res, status, out);
    } catch (err) {
      safeAudit(db, { ...auditBase, outcome: 'failure', detail: { code: 'UPDATE_FAILED' } });
      send(res, 500, { error: { code: 'UPDATE_FAILED', message: publicMessageFor(err) } });
    }
    return;
  }

  // ── Codex Plugin Bridge ─────────────────────────────────────────────
  // Mirrors the Claude Plugin Bridge above — same shape, different vendor
  // (OpenAI Codex CLI's plugin system: ~/.codex/plugins/cache + config.toml,
  // see plugins/codex-adapter.mjs).
  if (method === 'GET' && url.split('?')[0] === '/auth/me/codex-plugins/installed') {
    const { scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/codex-adapter.mjs');
    const plugins = scanInstalled();
    const imported = listImportedNames();
    for (const p of plugins) {
      const mnName = p.name.startsWith('codex-') ? p.name : `codex-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/codex-plugins/marketplace') {
    const { scanMarketplace, scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/codex-adapter.mjs');
    const plugins = scanMarketplace();
    const installed = scanInstalled();
    const installedNames = new Set(installed.map((p) => p.name));
    const imported = listImportedNames();
    for (const p of plugins) {
      p.installedInCodex = installedNames.has(p.name);
      const mnName = p.name.startsWith('codex-') ? p.name : `codex-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'POST' && url === '/auth/me/codex-plugins/import') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || !body.name || !body.source) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'name and source required' } });
      return;
    }
    if (!['installed', 'marketplace'].includes(body.source)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'source must be installed or marketplace' } });
      return;
    }
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(body.name)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    const { importPlugin } = await import('../plugins/codex-adapter.mjs');
    const { importWithTrustCheck } = await import('../plugins/import-trust.mjs');
    const { defaultPluginDir } = await import('../plugins/loader.mjs');
    const { clearHooksTrustForPlugin } = await import('../plugins/state.mjs');
    const { clearPluginMcpConsents } = await import('../mcp/state.mjs');
    // Same rule as the Claude import: new executables lose the old grant.
    const mnName = body.name.startsWith('codex-') ? body.name : `codex-${body.name}`;
    const result = importWithTrustCheck({
      dir: join(defaultPluginDir(), mnName),
      doImport: () => importPlugin({ source: body.source, name: body.name }),
      clearTrust: clearHooksTrustForPlugin,
      clearMcpConsents: clearPluginMcpConsents,
    });
    if (!result.ok) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: result.error } });
      return;
    }
    // An import that overwrote a same-named dir must not keep a git/marketplace record.
    try {
      (await import('../plugins/source-store.mjs')).removeSource(result.plugin.name);
    } catch (err) {
      logger.warn('plugin source record removal failed', { plugin: result.plugin.name, error: err.message });
    }
    const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'codex-plugin.import', resource: result.plugin.name, outcome: 'success',
      detail: { source: body.source, version: result.plugin.version },
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/codex-plugins/refresh') {
    const { scanInstalled, scanMarketplace } = await import('../plugins/codex-adapter.mjs');
    const installed = scanInstalled();
    const marketplace = scanMarketplace();
    send(res, 200, { installed: installed.length, marketplace: marketplace.length });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/codex-plugins/updates') {
    const { checkForUpdates } = await import('../plugins/codex-adapter.mjs');
    // Same shape as the Claude check; Codex has no CLI path, so always upstream.
    const updates = checkForUpdates().map((u) => ({
      name: u.name,
      pluginId: null,
      importedVersion: u.importedVersion,
      claudeVersion: u.sourceVersion,
      latest: u.sourceVersion,
      tier: 'upstream',
      // Legacy fields: older Mac apps decode these as non-optional Strings.
      sourceVersion: u.sourceVersion,
      source: u.source ?? 'installed',
    }));
    send(res, 200, { cli: false, checkedAt: new Date().toISOString(), updates });
    return;
  }

  // ── LLM sources management ────────────────────────────────────────
  // A registered LLM source contributes any mix of skills (chat "/" menu
  // discovery), agents (subagent definitions), and hooks — the latter two
  // are catalogued for display only, never invoked/executed (see the
  // Safety note atop llm-sources/registry.mjs).
  // GET  /auth/me/llm-sources          → list sources + per-user enable
  // POST /auth/me/llm-sources/toggle   → { id, enabled }
  // POST /auth/me/llm-sources/items    → { sourceId, kind, names[], enabled }  (per-item checkboxes)
  // GET  /auth/me/llm-sources/updates[?force=1] → per-source upstream status
  // POST /auth/me/llm-sources/add      → { url|path, ref?, name? }  (admin)
  // POST /auth/me/llm-sources/update   → { id }                     (admin)
  // DELETE /auth/me/llm-sources/<id>                                (admin)
  // GET  /auth/me/llm-sources/<id>/discovery → agents/hooks/mcp listing (admin)
  if (method === 'GET' && url.split('?')[0] === '/auth/me/llm-sources') {
    const { listSourcesWithState, seedBuiltinOnce } = await import('../llm-sources/registry.mjs');
    seedBuiltinOnce();
    send(res, 200, listSourcesWithState(req.user.id));
    return;
  }

  // Upstream-change check for every source (Mac "Update available" badge).
  // Never an error response: a source whose check fails is status 'unknown'.
  // Cached 30 min per source; ?force=1 re-checks now.
  if (method === 'GET' && url.split('?')[0] === '/auth/me/llm-sources/updates') {
    const { checkAllUpdates, seedBuiltinOnce } = await import('../llm-sources/registry.mjs');
    seedBuiltinOnce();
    const force = /[?&]force=1(?:&|$)/.test(url);
    send(res, 200, { sources: await checkAllUpdates({ force }) });
    return;
  }

  if (method === 'POST' && url === '/auth/me/llm-sources/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id)) {
        throw errValidation('id must be a valid source slug');
      }
      if (typeof body.enabled !== 'boolean') throw errValidation('enabled must be a boolean');
      const { getSource } = await import('../llm-sources/registry.mjs');
      if (!getSource(body.id)) throw errValidation(`source '${body.id}' is not registered`);
      const { setEnabled } = await import('../llm-sources/state.mjs');
      setEnabled(req.user.id, body.id, body.enabled);
      const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
      _resetSkillLibraryCache();
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: body.enabled ? 'llm-source.enable' : 'llm-source.disable',
        resource: body.id, outcome: 'success',
      });
      send(res, 200, { ok: true, enabled: body.enabled });
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  // Per-item checkboxes inside a source (skills, agents, commands, templates).
  // Per user and not admin-gated, exactly like /toggle. Stored as the
  // UNCHECKED set — see llm-sources/state.mjs.
  if (method === 'POST' && url === '/auth/me/llm-sources/items') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      const { ITEM_KINDS, isValidItemName, setItemsEnabled } = await import('../llm-sources/state.mjs');
      if (!body || typeof body.sourceId !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.sourceId)) {
        throw errValidation('sourceId must be a valid source slug');
      }
      if (!ITEM_KINDS.includes(body.kind)) throw errValidation(`kind must be one of ${ITEM_KINDS.join(', ')}`);
      if (!Array.isArray(body.names) || body.names.length === 0 || body.names.length > 1000
          || !body.names.every(isValidItemName)) {
        throw errValidation('names must be a non-empty array of item names');
      }
      if (typeof body.enabled !== 'boolean') throw errValidation('enabled must be a boolean');
      const { getSource } = await import('../llm-sources/registry.mjs');
      if (!getSource(body.sourceId)) throw errValidation(`source '${body.sourceId}' is not registered`);
      const disabled = setItemsEnabled(req.user.id, body.sourceId, body.kind, body.names, body.enabled);
      const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
      _resetSkillLibraryCache();
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: body.enabled ? 'llm-source.items.enable' : 'llm-source.items.disable',
        resource: body.sourceId, outcome: 'success',
        detail: { kind: body.kind, count: body.names.length },
      });
      send(res, 200, { ok: true, disabled: [...disabled].sort() });
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/me/llm-sources/add') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    const { addSource } = await import('../llm-sources/registry.mjs');
    const result = await addSource({ url: body?.url, path: body?.path, ref: body?.ref, name: body?.name });
    if (result.error) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'llm-source.add', outcome: 'failure', detail: { error: result.error.slice(0, 200) } });
      send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
      return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'llm-source.add', resource: result.source.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/llm-sources/update') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { updateSource } = await import('../llm-sources/registry.mjs');
    const result = await updateSource(body.id);
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'UPDATE_FAILED', message: result.error } }); return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'llm-source.update', resource: body.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/llm-sources/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const id = decodeURIComponent(url.slice('/auth/me/llm-sources/'.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { removeSource } = await import('../llm-sources/registry.mjs');
    const result = removeSource(id);
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'REMOVE_FAILED', message: result.error } }); return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'llm-source.remove', resource: id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'GET' && url.split('?')[0].startsWith('/auth/me/llm-sources/') && url.split('?')[0].endsWith('/discovery')) {
    // Marked privileged like its add/update/remove siblings: this surfaces
    // absolute agent file paths and hook/MCP command strings, where the list
    // endpoint returns only counts. NOTE requireAdmin only asserts req.user
    // today — the 2026-08-20 decision made this a local-first, single-operator
    // install with no admin role (see its doc comment in server/auth.mjs), so
    // the call is the one place a real check returns if that ever changes, not
    // a restriction that exists now.
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const id = decodeURIComponent(url.split('?')[0].slice('/auth/me/llm-sources/'.length, -'/discovery'.length));
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { sourceDiscoveryDetail } = await import('../llm-sources/registry.mjs');
    const detail = sourceDiscoveryDetail(id, req.user.id);
    if (!detail) { send(res, 404, { error: { code: 'NOT_FOUND', message: 'source not found or not installed' } }); return; }
    send(res, 200, detail);
    return;
  }

  // MCP plugins (SP1): servers imported from ~/.claude.json or registered
  // manually, gated by per-user consent + enable before they reach the
  // Claude CLI's --mcp-config. Every authenticated user registers/scans/
  // removes (no admin concept — see requireAdmin's doc comment); any user
  // consents + enables their own dispatch.
  // GET    /auth/me/mcp-plugins                 → list + per-user consent/enable
  // GET    /auth/me/mcp-plugins/claude-sources   → scan ~/.claude.json
  // GET    /auth/me/mcp-plugins/codex-sources    → scan ~/.codex/config.toml
  // POST   /auth/me/mcp-plugins/add              → { command,args,env,name,source } | { claudeName } | { codexName }
  // POST   /auth/me/mcp-plugins/consent          → { id, consented }
  // POST   /auth/me/mcp-plugins/toggle           → { id, enabled }
  // GET    /auth/me/mcp-plugins/updates[?force=1] → registry version check
  // POST   /auth/me/mcp-plugins/<id>/update      → { to?, expectArgs? } re-pin
  // GET|POST /auth/me/mcp-plugins/<id>/resync    → drift / apply from Claude Code or Codex
  // DELETE /auth/me/mcp-plugins/<id>
  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins') {
    const { listMcpPluginsWithState, managedPackageOf } = await import('../mcp/state.mjs');
    const { plugins } = listMcpPluginsWithState(req.user.id);
    const packageInfoOf = (p) => {
      const parsed = managedPackageOf(p);
      if (!parsed) return null;
      const { argIndex: _argIndex, ...info } = parsed;
      return info;
    };
    // Redact env VALUES before this reaches a non-admin caller — every
    // plugin's env is userId-independent (stored once on the shared
    // registry record, not per-user), so an unredacted spread here would
    // hand any authenticated user another plugin's real credentials
    // (e.g. a Slack/Linear bearer token) merely by hitting this endpoint,
    // whether or not they've ever consented to or enabled that plugin.
    // Key NAMES are kept (mirrors vault's listSecretKeys) since the Mac
    // detail view only ever displays the key list, never a value.
    const { credentialMissing, effectiveMcpServers } = await import('../mcp/mcp-config.mjs');
    const { makeSecretReader } = await import('../server/vault.mjs');
    const readSecret = makeSecretReader(db, req.user.id);
    // Which servers a turn would really mount: enabled AND consented AND, for a
    // plugin-declared server, its plugin enabled for THIS user. The client
    // cannot derive the third gate, so it counts this instead of guessing.
    let effectiveIds = null;
    try {
      const { pluginEnabledFor } = await import('../llm_agent/skills/index.mjs');
      // No `readSecret`: membership never depends on a credential's value (an
      // empty one only drops the header/env), so decrypting every enabled
      // server's secret just to build a boolean would be pure exposure.
      effectiveIds = new Set(Object.keys(effectiveMcpServers(req.user.id, {
        pluginEnabled: pluginEnabledFor(req.user.id),
      })));
      // The engine refuses a server with this name (llm_agent/sdk/engine.mjs
      // buildUserMcpServers); the constant lives in the SDK-free constants.mjs.
      effectiveIds.delete(RESERVED_MCP_NAME);
    } catch (err) {
      logger?.warn?.(`mcp-plugins: could not compute effective flags: ${err?.message || err}`);
      // `effective` stays off; the client falls back to enabled && consented.
    }
    send(res, 200, {
      plugins: plugins.map((p) => ({
        ...p,
        package: packageInfoOf(p),
        env: redactEnvValues(p.env),
        headers: redactHeaderValues(p.headers),
        ...(p.url ? { url: redactUrlSecrets(p.url) } : {}),
        // Surfaced rather than silently dropping the server from the effective
        // config: a catalog entry whose vault key is empty still gets passed to
        // the CLI (which reports a real auth failure), and the client needs to
        // be able to say "add the token" instead of leaving the user guessing.
        credentialMissing: credentialMissing(p, readSecret),
        ...(effectiveIds ? { effective: effectiveIds.has(p.id) } : {}),
      })),
    });
    return;
  }

  // GET /auth/me/mcp-plugins/catalog → the curated one-click list. Static and
  // user-independent, but `registered` marks what this install already has so
  // the client can avoid offering a duplicate add.
  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/catalog') {
    const { MCP_CATALOG } = await import('../mcp/catalog.mjs');
    const { readMcpRegistry } = await import('../mcp/state.mjs');
    const existing = new Set(readMcpRegistry().map((p) => p.id));
    send(res, 200, {
      servers: MCP_CATALOG.map((e) => ({ ...e, registered: existing.has(e.id) })),
    });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/claude-sources') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const { scanClaudeMcpServers } = await import('../mcp/claude-source.mjs');
    send(res, 200, { servers: scanClaudeMcpServers().map(redactServerSecrets) });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/codex-sources') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const { scanCodexMcpServers } = await import('../mcp/codex-source.mjs');
    send(res, 200, { servers: scanCodexMcpServers().map(redactServerSecrets) });
    return;
  }

  if (method === 'POST' && url === '/auth/me/mcp-plugins/add') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    // A catalog add resolves entirely server-side from the id, so the client
    // never restates a command or URL (and cannot drift from the catalog).
    if (body?.catalogId) {
      const { addMcpPluginFromCatalog } = await import('../mcp/state.mjs');
      // Resolve the latest version BEFORE the (sync) state call; a registry
      // outage must never block the add — it just lands unpinned.
      const { catalogEntry } = await import('../mcp/catalog.mjs');
      const { parseRunnerSpec } = await import('../mcp/package-spec.mjs');
      const { latestVersion } = await import('../mcp/registry-versions.mjs');
      const catalogParsed = parseRunnerSpec(catalogEntry(body.catalogId) || {});
      let pin = null;
      if (catalogParsed) pin = await latestVersion(catalogParsed);
      const result = addMcpPluginFromCatalog(body.catalogId, { arg: body.arg, name: body.name, version: pin?.version });
      if (result.error) {
        safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
          action: 'mcp-plugin.add', outcome: 'failure', detail: { error: String(result.error).slice(0, 200) } });
        send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
        return;
      }
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.add', resource: result.plugin.id, outcome: 'success' });
      send(res, 200, {
        ...result,
        plugin: redactServerSecrets(result.plugin),
        ...(catalogParsed ? (pin?.version ? { pinned: true } : { pinned: false, reason: pin?.error || 'unknown' }) : {}),
      });
      return;
    }
    // Imports forward the scanned shape verbatim — including the hosted
    // (url/headers) one, which used to be dropped here because the scanners
    // never emitted it.
    if (body?.claudeName) {
      const { scanClaudeMcpServers } = await import('../mcp/claude-source.mjs');
      const found = scanClaudeMcpServers().find((s) => s.name === body.claudeName);
      if (!found) { send(res, 400, { error: { code: 'ADD_FAILED', message: `no Claude MCP server named '${body.claudeName}'` } }); return; }
      body = { ...found, name: body.name || found.name, source: 'claude', sourceName: found.name };
    } else if (body?.codexName) {
      const { scanCodexMcpServers } = await import('../mcp/codex-source.mjs');
      const found = scanCodexMcpServers().find((s) => s.name === body.codexName);
      if (!found) { send(res, 400, { error: { code: 'ADD_FAILED', message: `no Codex MCP server named '${body.codexName}'` } }); return; }
      body = { ...found, name: body.name || found.name, source: 'codex', sourceName: found.name };
    }
    else if (body && typeof body === 'object') {
      // Only the import paths above may set sourceName (it is what Re-sync
      // trusts to find the entry again); a plain body must not forge one.
      const { sourceName: _ignored, ...rest } = body;
      body = rest;
    }
    const { addMcpPlugin } = await import('../mcp/state.mjs');
    const result = addMcpPlugin(body || {});
    if (result.error) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'mcp-plugin.add', outcome: 'failure', detail: { error: String(result.error).slice(0, 200) } });
      send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
      return;
    }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.add', resource: result.plugin.id, outcome: 'success' });
    // Imports copy real env/header values into the shared registry; the Mac only
    // lists names, so the response must not echo the values back.
    send(res, 200, { ...result, plugin: redactServerSecrets(result.plugin) });
    return;
  }

  if (method === 'POST' && url === '/auth/me/mcp-plugins/consent') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id) || typeof body.consented !== 'boolean') {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id + consented required' } }); return;
    }
    const { setConsented } = await import('../mcp/state.mjs');
    setConsented(req.user.id, body.id, body.consented);
    if (!body.consented) flushWarmCliPool('mcp_consent');
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: body.consented ? 'mcp-plugin.consent' : 'mcp-plugin.revoke-consent', resource: body.id, outcome: 'success' });
    send(res, 200, { ok: true, consented: body.consented });
    return;
  }

  if (method === 'POST' && url === '/auth/me/mcp-plugins/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id) || typeof body.enabled !== 'boolean') {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id + enabled required' } }); return;
    }
    const { setEnabledMcp } = await import('../mcp/state.mjs');
    // Enabling without consent is refused by the state layer — report that
    // instead of echoing `body.enabled`, so the client never shows a switch
    // in a position the server did not store.
    const toggled = setEnabledMcp(req.user.id, body.id, body.enabled);
    if (toggled.error) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'mcp-plugin.enable', resource: body.id, outcome: 'failure', detail: { error: toggled.error } });
      send(res, 409, { error: { code: 'CONSENT_REQUIRED', message: toggled.error } });
      return;
    }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: toggled.enabled ? 'mcp-plugin.enable' : 'mcp-plugin.disable', resource: body.id, outcome: 'success' });
    send(res, 200, { ok: true, enabled: toggled.enabled });
    return;
  }

  // Version routes. Matched BEFORE the DELETE `<id>` prefix handler below so
  // `/updates` is never read as an id; every static path above is exact-match.
  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/updates') {
    let force = new URL(url, 'http://x').searchParams.get('force') === '1';
    // Forced checks are admin-only; for anyone else it quietly degrades to the cached check.
    if (force) { try { requireAdmin(req); } catch { force = false; } }
    const { readMcpRegistry, managedPackageOf } = await import('../mcp/state.mjs');
    const { latestVersion } = await import('../mcp/registry-versions.mjs');
    const servers = await Promise.all(readMcpRegistry().map(async (p) => {
      const parsed = managedPackageOf(p);
      if (!parsed) return null;
      const current = parsed.version ?? parsed.tag ?? null;
      const row = { id: p.id, runner: parsed.runner, name: parsed.name, current, latest: null };
      const found = await latestVersion(parsed, { force });
      if (found.error) return { ...row, status: 'unknown', reason: found.error };
      row.latest = found.version;
      if (!parsed.version) return { ...row, status: 'unpinned' };
      return { ...row, status: parsed.version === found.version ? 'up-to-date' : 'update-available' };
    }));
    send(res, 200, { checkedAt: new Date().toISOString(), servers: servers.filter(Boolean) });
    return;
  }

  const mcpVersionMatch = /^\/auth\/me\/mcp-plugins\/([a-z][a-z0-9-]{1,40})\/(update|resync)$/.exec(url.split('?')[0]);
  if (mcpVersionMatch && ((mcpVersionMatch[2] === 'update' && method === 'POST')
      || (mcpVersionMatch[2] === 'resync' && (method === 'GET' || method === 'POST')))) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const [, id, action] = mcpVersionMatch;
    const fail = (status, code, message) => send(res, status, { error: { code, message } });
    const state = await import('../mcp/state.mjs');
    const plugin = state.getMcpPlugin(id);
    if (!plugin) { fail(404, 'NOT_FOUND', 'not found'); return; }

    if (action === 'update') {
      let body;
      try { body = await readJson(req, bodyLimit); }
      catch { fail(400, 'VALIDATION_FAILED', 'Invalid JSON body'); return; }
      const parsed = state.managedPackageOf(plugin);
      if (!parsed) { fail(400, 'NOT_MANAGED', 'this server is not version-managed'); return; }
      const { isValidVersion } = await import('../mcp/package-spec.mjs');
      // Default the staleness guard to the args read at the start of this
      // route, so a concurrent edit during the registry lookup is a 409, not
      // a silent overwrite.
      const argsAtStart = Array.isArray(plugin.args) ? [...plugin.args] : [];
      if (body?.expectArgs !== undefined && !(Array.isArray(body.expectArgs) && body.expectArgs.every((a) => typeof a === 'string'))) {
        fail(400, 'VALIDATION_FAILED', 'expectArgs must be an array of strings'); return;
      }
      let version = body?.to;
      if (version === undefined || version === null) {
        const { latestVersion } = await import('../mcp/registry-versions.mjs');
        const found = await latestVersion(parsed, { force: true });
        if (found.error) { fail(502, 'REGISTRY_UNAVAILABLE', found.error); return; }
        version = found.version;
      } else if (!isValidVersion(parsed.runner, version)) {
        fail(400, 'VALIDATION_FAILED', 'invalid version'); return;
      }
      const result = state.setMcpPackageVersion(id, { expectArgs: body?.expectArgs ?? argsAtStart, version });
      if (result.error) {
        safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
          action: 'mcp-plugin.update', resource: id, outcome: 'failure', detail: { error: String(result.error).slice(0, 200) } });
        fail(result.status || 400, result.code || 'UPDATE_FAILED', result.error); return;
      }
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'mcp-plugin.update', resource: id, outcome: 'success', detail: { from: result.from, to: result.to } });
      send(res, 200, { ok: true, from: result.from, to: result.to });
      return;
    }

    // resync
    if (!(plugin.source === 'claude' || plugin.source === 'codex') || !plugin.sourceName) {
      fail(400, 'NOT_MANAGED', 'this server has no Claude Code / Codex source to re-sync from'); return;
    }
    const scanned = plugin.source === 'claude'
      ? (await import('../mcp/claude-source.mjs')).scanClaudeMcpServers()
      : (await import('../mcp/codex-source.mjs')).scanCodexMcpServers();
    const sourceDef = scanned.find((s) => s.name === plugin.sourceName);
    if (!sourceDef) { fail(404, 'SOURCE_NOT_FOUND', `'${plugin.sourceName}' is no longer in the ${plugin.source} config`); return; }
    if (method === 'GET') {
      const changes = state.diffMcpSource(plugin, sourceDef);
      send(res, 200, { drift: changes.length > 0, changes });
      return;
    }
    const result = state.applyMcpResync(id, sourceDef);
    if (result.error) { fail(result.status || 400, result.code || 'RESYNC_FAILED', result.error); return; }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'mcp-plugin.resync', resource: id, outcome: 'success', detail: { changes: result.changes } });
    send(res, 200, { ok: true, changes: result.changes });
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/mcp-plugins/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const id = decodeURIComponent(url.slice('/auth/me/mcp-plugins/'.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid id' } }); return;
    }
    const { removeMcpPlugin } = await import('../mcp/state.mjs');
    const result = removeMcpPlugin(id);
    if (result.error) { send(res, result.status || 400, { error: { code: 'REMOVE_FAILED', message: result.error } }); return; }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.remove', resource: id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: { code: 'NOT_FOUND', message: `No auth route for ${method} ${url}` } });
}
