// extension/mcp/state.mjs
// MCP-plugin registry + per-user consent/enable. Atomic JSON writes; per-user
// state keyed by userId. Mirrors llm-sources/registry.mjs + state.mjs.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { catalogEntry } from './catalog.mjs';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

function baseDir() {
  return process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
}
function registryPath() { return join(dirname(baseDir()), 'mcp-plugins.json'); }
function statePath() { return join(dirname(baseDir()), 'mcp-plugins-state.json'); }

export function readMcpRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data?.plugins) ? data.plugins.filter((s) => s && typeof s === 'object') : [];
  } catch { return []; }
}
export function writeMcpRegistry(list) {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ plugins: list }, null, 2), 'utf8');
  renameSync(tmp, p);
}
export function getMcpPlugin(id) { return readMcpRegistry().find((s) => s.id === id) || null; }

export function slugifyMcp(name, existing) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  // Truncate BEFORE testing SLUG_RE (mirrors llm-sources/registry.mjs's
  // slugify) — testing the untruncated base first meant any name whose
  // sanitized form exceeded 41 chars fell straight to an opaque
  // `mcp-<timestamp>` id, discarding the name entirely.
  base = base.slice(0, 40);
  if (!SLUG_RE.test(base)) base = `mcp-${Date.now().toString(36)}`;
  let id = base, i = 2;
  // On collision, truncate base to leave room for '-{suffix}' so id always fits SLUG_RE (max 40).
  while (existing.has(id)) {
    const suffix = `-${i}`;
    const maxBaseLen = 40 - suffix.length;
    const truncated = base.slice(0, maxBaseLen);
    id = `${truncated}${suffix}`;
    i++;
  }
  // Final guard: if we somehow produced an invalid id, fall back to timestamp.
  if (!SLUG_RE.test(id)) {
    id = `mcp-${Date.now().toString(36)}`;
  }
  return id;
}

// A registry record's transport. Records written before transports existed
// carry no field and are always stdio (they required `command`), so absence
// reads as 'stdio' rather than needing a migration.
export function transportOf(plugin) {
  if (plugin?.transport === 'http' || plugin?.transport === 'sse') return plugin.transport;
  return 'stdio';
}

// http(s) only. A stdio server is named by `command`; a URL with any other
// scheme (file:, ws:, something invented) is not a transport this can express,
// and passing it through would only fail later inside the CLI.
function normalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

/**
 * Register an MCP server. Two transports:
 *
 *   stdio — { command, args?, env? }   a local subprocess
 *   http  — { url, headers? }          a hosted server, `transport: 'http'|'sse'`
 *
 * HTTP is not a nicety: most vendor servers (GitHub, Sentry, Notion, …) are
 * hosted now, and while this accepted only `command` none of them could be
 * registered at all — nor could an imported `type: "http"` entry from the
 * user's own Claude config, which the importer had to drop on the floor.
 *
 * `credential` is a DESCRIPTOR, never a value: { vaultKey, target, name,
 * template? }. The secret itself lives in the encrypted vault and is injected
 * when the config is built (see mcp-config.mjs), keeping tokens out of this
 * registry file — which is shared by every user and only redacted on read.
 */
export function addMcpPlugin({ name, command, args, env, url, headers, transport, credential, source }) {
  const wantsHttp = transport === 'http' || transport === 'sse' || (!command && url);
  const resolved = { source: (source === 'claude' || source === 'codex' || source === 'catalog') ? source : 'manual' };

  if (wantsHttp) {
    const normalized = normalizeUrl(url);
    if (!normalized) return { error: 'a http(s) url is required for an http/sse server', status: 400 };
    resolved.transport = transport === 'sse' ? 'sse' : 'http';
    resolved.url = normalized;
    if (headers && typeof headers === 'object') resolved.headers = headers;
  } else {
    if (typeof command !== 'string' || !command.trim()) return { error: 'command is required', status: 400 };
    resolved.transport = 'stdio';
    resolved.command = command;
    resolved.args = Array.isArray(args) ? args.filter((a) => typeof a === 'string') : [];
    if (env && typeof env === 'object') resolved.env = env;
  }

  const list = readMcpRegistry();
  const id = slugifyMcp(name || resolved.command || resolved.url, new Set(list.map((s) => s.id)));
  const plugin = {
    id,
    name: name || id,
    ...resolved,
    ...(credential && typeof credential === 'object' ? { credential } : {}),
    builtin: false,
  };
  list.push(plugin);
  writeMcpRegistry(list);
  return { plugin };
}

/**
 * Register a curated catalog entry by id. `arg` supplies the trailing argv an
 * entry declares via `requiresArg` (filesystem's directory, DBHub's DSN) —
 * refused when the entry needs one and none is given, because registering a
 * filesystem server with no allowed root produces a server that silently
 * exposes nothing.
 */
export function addMcpPluginFromCatalog(catalogId, { arg, name } = {}) {
  const entry = catalogEntry(catalogId);
  if (!entry) return { error: `no catalog entry '${catalogId}'`, status: 400 };
  if (entry.requiresArg && (typeof arg !== 'string' || !arg.trim())) {
    return { error: `${entry.name} needs ${entry.requiresArg.label.toLowerCase()}`, status: 400 };
  }
  const args = entry.requiresArg ? [...(entry.args || []), arg.trim()] : entry.args;
  return addMcpPlugin({
    name: name || entry.name,
    transport: entry.transport,
    command: entry.command,
    args,
    url: entry.url,
    credential: entry.credential,
    source: 'catalog',
  });
}

export function removeMcpPlugin(id) {
  if (!SLUG_RE.test(id)) return { error: 'invalid id', status: 400 };
  const list = readMcpRegistry();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { error: 'not found', status: 404 };
  writeMcpRegistry(next);
  // Drop removed id from every user's enable/consent state — prevents resurrection on re-add.
  pruneMcpState(new Set(next.map((p) => p.id)));
  return { ok: true };
}

// ---- per-user state ----
function readState() {
  const p = statePath();
  if (!existsSync(p)) return {};
  try { const d = JSON.parse(readFileSync(p, 'utf8')); return d && typeof d === 'object' ? d : {}; }
  catch { return {}; }
}
function writeState(st) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  renameSync(tmp, p);
}
function ensurePluginEntry(st, userId, id) {
  if (!st[userId]) st[userId] = {};
  if (!st[userId][id]) st[userId][id] = {};
  return st[userId][id];
}

export function pruneMcpState(validIds) {
  const all = readState();
  let touched = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (!entry || typeof entry !== 'object') continue;
    const pruned = {};
    for (const [pluginId, state] of Object.entries(entry)) {
      if (validIds.has(pluginId)) {
        pruned[pluginId] = state;
      } else {
        touched = true;
      }
    }
    if (Object.keys(pruned).length === 0) {
      delete all[userId];
      touched = true;
    } else {
      all[userId] = pruned;
    }
  }
  if (touched) writeState(all);
}

export function setConsented(userId, id, consented) {
  if (!SLUG_RE.test(id)) return;
  const st = readState();
  ensurePluginEntry(st, userId, id).consented = !!consented;
  writeState(st);
}
export function setEnabledMcp(userId, id, enabled) {
  if (!SLUG_RE.test(id)) return;
  const st = readState();
  ensurePluginEntry(st, userId, id).enabled = !!enabled;
  writeState(st);
}

export function listMcpPluginsWithState(userId) {
  const st = readState()[userId] || {};
  return {
    plugins: readMcpRegistry().map((p) => ({
      ...p,
      enabled: !!(st[p.id]?.enabled),
      consented: !!(st[p.id]?.consented),
    })),
  };
}
