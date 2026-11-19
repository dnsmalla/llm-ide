// Health check for one installed extension: really tests it (starts an MCP server and lists its tools, looks
// at the files, the consents, the hook programs) with no model call, and names exactly one fix per problem.
// docs/spec/extensions-catalog.md "Health check". Rules that must hold (each has a test):
//   1 a server the user has not allowed is never started        4 no secret, env value or home path in any text
//   2 a stdio server is never started on a hub                  5 one check at a time per (user, kind, id), 30 s cache, force within 5 s = cached
//   3 whatever was started is closed, also on error or timeout  6 plain one-sentence messages
// Every external effect is a `deps` entry so tests need no process and no network.

import { existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, normalize, sep } from 'node:path';
import { config } from '../../core/config.mjs';
import { redactSecrets } from '../../core/redact-secrets.mjs';
import { getDb } from '../../kb/db.mjs';
import { recordIncident } from '../../kb/incidents.mjs';
import { makeSecretReader } from '../../server/vault.mjs';
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';
import { classifyIp } from '../../server/ip-classifier.mjs';
import { catalogEntry } from '../../mcp/catalog.mjs';
import { connectMcpServers, cleanServerText, MCP_LIMITS } from '../../providers/adapter/mcp-client.mjs';
import { listMcpPluginsWithState } from '../../mcp/state.mjs';
import { credentialMissing, effectiveMcpServers } from '../../mcp/mcp-config.mjs';
import { loadedPlugins, pluginEnabledFor } from '../skills/registry.mjs';
import { loadPluginAt } from '../../plugins/loader.mjs';
import { getSource as getPluginSource } from '../../plugins/source-store.mjs';
import { getSource as getLlmSource, isValidLlmSource, invalidDiscoverySkills } from '../../llm-sources/registry.mjs';
import { readInstalled } from './installed.mjs';
import { readOverlay } from './store.mjs';
import { makeGate } from './gate.mjs';
import { parseItemId } from './model.mjs';
import { verifiedOnLoad } from './integrity.mjs';
import { activeInstalled, missingConsents, safeDir } from './installed-runtime.mjs';

export const KINDS = Object.freeze(['mcp', 'plugin', 'skill-kit', 'catalog']);
export const FIXES = Object.freeze(['repair', 'consent', 'set-credential', 'install-program', 'switch-off', 'none']);
export const CACHE_MS = 30_000;
export const FORCE_MIN_MS = 5_000; // a forced re-check right after a completed one returns that result
const MAX_TOOLS = 48;
const MAX_PROBLEMS = 10;
const MAX_MESSAGE = 300;
const MAX_TOOL_TEXT = 300;

export class HealthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const problem = (code, message, fix, detail) => ({ code, message, fix, ...(detail ? { detail } : {}) });

/** Text for a person: secrets redacted, the home folder hidden, one line, capped. */
export function cleanText(value, max = MAX_MESSAGE) {
  let s = redactSecrets(cleanServerText(String(value ?? ''), 2000)).replace(/\s+/g, ' ').trim();
  const home = homedir();
  if (home && home.length > 1) s = s.split(home).join('~');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The program a stdio server names, found on PATH the way the runtime would find it; never executed. null = not found, undefined = cannot be told from here. */
export function resolveProgram(command, env, { pathEnv = process.env.PATH, platform = process.platform } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const ok = (p) => { try { accessSync(p, platform === 'win32' ? constants.F_OK : constants.X_OK); return existsSync(p); } catch { return false; } };
  if (isAbsolute(command)) return ok(command) ? command : null;
  // A relative path would resolve against the core's folder, not the one a chat starts it in: unknown (undefined).
  if (command.includes('/') || command.includes(sep)) return undefined;
  const dirs = String(env?.PATH ?? pathEnv ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const d of dirs) for (const x of exts) if (ok(join(d, command + x))) return join(d, command + x);
  return null;
}

const REASON = { timeout: 'took too long to answer', blocked: 'was blocked because its address is not allowed', error: 'could not be started or stopped with an error' };

/** Start one server config, list its tools, close it. Never throws; the connection is always closed. */
async function probeServer(id, cfg, d) {
  const stdio = !(cfg && (cfg.type === 'http' || cfg.type === 'sse'));
  if (stdio && d.hub) return { unknown: true, problems: [problem('HUB_NO_LOCAL_PROGRAMS', 'MCP servers that start a program are never run on a shared hub, so this one cannot be checked here.', 'none')] };
  if (stdio) {
    const found = d.resolveProgram(cfg.command, cfg.env);
    if (found === undefined) return { unknown: true, problems: [problem('RELATIVE_PROGRAM', 'This MCP server starts a program by a relative path, so it is checked when a chat uses it, not here.', 'none')] };
    if (!found) {
      const program = basename(String(cfg.command)).slice(0, 80);
      return { problems: [problem('PROGRAM_MISSING', `The program "${cleanText(program, 80)}" that this MCP server starts is not installed.`, 'install-program', { program: cleanText(program, 80) })] };
    }
  } else if (isLocalUrl(cfg.url)) {
    // Chats connect to local addresses themselves; this check never does, so it cannot judge them.
    return { unknown: true, problems: [problem('LOCAL_ADDRESS', 'This MCP server is on this computer or your local network, so it is checked when a chat uses it, not here.', 'none')] };
  }
  if (d.signal?.aborted) return { problems: [failure(stdio, 'error', 0)] };
  let sawAuth = 0;
  const makeFetch = (o) => {
    const inner = d.makeFetch(o);
    return async (...a) => { const r = await inner(...a); if (r?.status === 401 || r?.status === 403) sawAuth = r.status; return r; };
  };
  const ac = new AbortController();
  const hasCred = !!(cfg.headers && Object.keys(cfg.headers).length);
  let onAbort;
  const aborted = new Promise((_, rej) => {
    onAbort = () => { ac.abort(); rej(Object.assign(new Error('aborted'), { code: 'MCP_ABORT' })); };
    d.signal?.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  const outerMs = (d.limits?.connectMs ?? MCP_LIMITS.connectMs) + 5000;
  let timer;
  const attempt = Promise.resolve().then(() => d.connect({ [id]: cfg }, { signal: ac.signal, allowPrivate: false, deps: { makeFetch, ...(d.clientDeps || {}) } }));
  let conn;
  try {
    conn = await Promise.race([attempt, aborted, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'MCP_TIMEOUT' })), outerMs); })]);
  } catch (err) {
    ac.abort();
    // A connection that finishes after we gave up is still closed.
    attempt.then((c) => c?.close?.()).catch(() => {});
    return { problems: [failure(stdio, err?.code === 'MCP_TIMEOUT' ? 'timeout' : 'error', sawAuth, hasCred)] };
  } finally { clearTimeout(timer); d.signal?.removeEventListener('abort', onAbort); }
  try {
    const st = conn.statuses?.find((s) => s.name === id);
    if (!st || st.status !== 'connected') return { problems: [failure(stdio, st?.reason, sawAuth, hasCred)] };
    const tools = (conn.tools || []).filter((t) => t.server === id).slice(0, MAX_TOOLS)
      .map((t) => ({ name: cleanText(t.tool ?? t.name, 128), description: cleanText(t.description, MAX_TOOL_TEXT) }));
    return { problems: [], tools };
  } finally {
    try { await conn.close(); } catch { /* already gone */ }
  }
}

function isLocalUrl(url) {
  let h;
  try { h = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || (() => { const c = classifyIp(h); return c.ip && c.class === 'private'; })();
}

function failure(stdio, reason, sawAuth, hasCred) {
  if (sawAuth === 403 || (sawAuth && hasCred)) return problem('CREDENTIAL_REJECTED', 'This MCP server rejected its credential. Enter it again.', 'set-credential');
  if (sawAuth) return problem('CREDENTIAL_MISSING', 'This MCP server needs a credential that has not been set yet.', 'set-credential');
  const why = REASON[reason] || REASON.error;
  return stdio
    ? problem('START_FAILED', `This MCP server did not start: it ${why}.`, 'switch-off')
    : problem('UNREACHABLE', `This MCP server could not be reached: it ${why}.`, 'switch-off');
}

const verdict = (problems, extra = {}) => ({
  status: extra.unknown ? 'unknown' : (problems.length ? 'problem' : 'ok'),
  problems: problems.slice(0, MAX_PROBLEMS),
  ...(extra.tools ? { tools: extra.tools } : {}),
});

async function checkMcp(userId, id, d) {
  const rec = d.mcpRecords(userId).find((p) => p.id === id);
  if (!rec) throw new HealthError('not_found', 'not installed');
  // Rule 1: nothing a user has not allowed is ever started.
  if (!rec.consented) return verdict([problem('NOT_ALLOWED', 'You have not allowed this MCP server to run yet.', 'consent')]);
  const off = problem('SWITCHED_OFF', 'This extension is switched off, so it was not checked.', 'none');
  // The check never starts what a chat would not start.
  if (!rec.enabled || (rec.source === 'plugin' && !d.pluginEnabled(userId)(rec.pluginName))) return verdict([off], { unknown: true });
  if (rec.catalogId && catalogEntry(rec.catalogId)?.oauth) return verdict([problem('SIGNS_IN_IN_CHAT', 'This MCP server signs in when a chat first uses it, so it cannot be checked here.', 'none')], { unknown: true });
  const readSecret = d.readSecret(userId);
  if (credentialMissing(rec, readSecret)) return verdict([problem('CREDENTIAL_MISSING', 'This MCP server needs a credential that has not been set yet.', 'set-credential')]);
  const cfg = d.effectiveServers(userId, { readSecret, only: id })[id];
  if (!cfg) return { status: 'unknown', problems: [] };
  const r = await probeServer(id, cfg, d);
  return verdict(r.problems, r);
}

// Fixed sentences only: loader and runtime text (paths, regexes, parser output) never reaches a message.
function mapWarning(text, repairFix = 'repair') {
  if (/already installed|unusable or taken/.test(text)) return problem('NAME_CLASH', 'Another extension already uses a name this one needs, so it was not loaded.', 'switch-off');
  if (/read failed|ENOENT|EACCES|EISDIR|EPERM|missing|unreadable|changed since/i.test(text)) return problem('FILES_CHANGED', 'Some files of this extension are missing or unreadable.', repairFix);
  return problem('LOAD_WARNING', 'Part of this extension is not valid, so it was not loaded.', 'none');
}
const pushUnique = (list, p) => { if (!list.some((x) => x.code === p.code && x.message === p.message)) list.push(p); };
const UNKNOWN_CODES = new Set(['HUB_NO_LOCAL_PROGRAMS', 'LOCAL_ADDRESS', 'SIGNS_IN_IN_CHAT', 'RELATIVE_PROGRAM']);

async function checkCatalog(userId, id, d) {
  const parsed = parseItemId(id);
  const installed = d.catalogInstalled(userId);
  const rec = parsed && !installed.corrupt ? installed.items.get(id) : null;
  if (!rec) throw new HealthError('not_found', 'not installed');
  // Rule 1: an item without a consent for its pinned commit is neither loaded nor started.
  if (missingConsents(rec).length) return verdict([problem('NOT_ALLOWED', 'This extension needs your permission before it can run.', 'consent')]);
  const dir = safeDir(userId, id, rec);
  if (!dir || !verifiedOnLoad(dir, rec.integrity)) return verdict([problem('FILES_CHANGED', 'The stored files of this extension are missing or have changed since it was installed.', 'repair')]);
  if (d.catalogOverlay(userId).items.get(id)?.enabled !== true) return verdict([problem('SWITCHED_OFF', 'This extension is switched off, so it was not checked.', 'none')], { unknown: true });
  const active = d.catalogActive(userId, { legacyPluginNames: new Set(loadedPlugins().map((p) => p.name)) });
  const problems = [];
  for (const w of active.warnings.filter((x) => x.startsWith(`${id}: `))) {
    pushUnique(problems, mapWarning(w.slice(id.length + 2)));
  }
  const tools = [];
  let unknown = false;
  for (const s of active.mcp.filter((x) => x.itemId === id)) {
    const r = await probeServer(s.id, s.config, d);
    problems.push(...r.problems);
    tools.push(...(r.tools || []));
    unknown ||= r.unknown === true;
  }
  return verdict(problems, { unknown: unknown && problems.length > 0 && problems.every((p) => UNKNOWN_CODES.has(p.code)), tools: tools.length ? tools.slice(0, MAX_TOOLS) : undefined });
}

/** Absolute paths inside the plugin folder that a hook command names, as plugin-relative paths. */
function hookFiles(plugin) {
  const root = plugin.dir.endsWith(sep) ? plugin.dir : plugin.dir + sep;
  const out = new Set();
  for (const h of plugin.hooks ?? []) {
    for (const tok of String(h.command || '').split(/\s+/)) {
      const t = normalize(tok.replace(/^["']|["']$/g, ''));
      if (t.startsWith(root) && t.length > root.length) out.add(t.slice(root.length));
    }
  }
  return [...out];
}

async function checkPlugin(userId, id, d) {
  const plugin = d.legacyPlugins().find((p) => p.name === id);
  if (!plugin) throw new HealthError('not_found', 'not installed');
  const problems = [];
  const fresh = d.loadPlugin(plugin.dir);
  const src = d.pluginSource(id);
  const canRepair = src?.kind === 'git' || src?.kind === 'marketplace';
  for (const w of [fresh.error, ...(fresh.warnings ?? [])].filter(Boolean)) {
    const m = mapWarning(String(w), canRepair ? 'repair' : 'none');
    pushUnique(problems, m.code === 'FILES_CHANGED' ? { ...m, message: 'Some files of this plugin are missing or unreadable.' } : { ...m, message: m.message.replace('extension', 'plugin') });
  }
  // A hook that was never trusted is a choice, not a problem: only a missing program file is reported.
  for (const rel of hookFiles(plugin)) {
    if (!d.exists(join(plugin.dir, rel))) problems.push(problem('HOOK_FILE_MISSING', 'A hook of this plugin runs a file that is missing.', canRepair ? 'repair' : 'none', { file: cleanText(rel, 200) }));
  }
  return verdict(problems);
}

async function checkSkillKit(userId, id, d) {
  const src = d.llmSource(id);
  if (!src) throw new HealthError('not_found', 'not installed');
  // Only the built-in kit can be restored by "update" when its folder is gone.
  const fix = src.origin === 'builtin' ? 'repair' : 'none';
  if (!src.location || !d.exists(src.location) || !d.validSource(src.location)) return verdict([problem('FILES_MISSING', 'The folder of this skill kit is missing or cannot be read.', fix)]);
  return verdict(d.invalidSkills(src.location).slice(0, MAX_PROBLEMS)
    .map((rel) => problem('SKILL_INVALID', 'A skill in this kit cannot be read.', 'none', { file: cleanText(rel, 200) })));
}

const defaults = () => ({
  now: Date.now,
  hub: config.hub,
  selfHeal: config.selfHeal,
  connect: connectMcpServers,
  makeFetch: makePinnedFetch,
  resolveProgram,
  readSecret: (userId) => makeSecretReader(getDb(), userId),
  pluginEnabled: (userId) => pluginEnabledFor(userId),
  effectiveServers: (userId, o) => effectiveMcpServers(userId, { ...o, pluginEnabled: pluginEnabledFor(userId), ignoreEnabled: true }),
  mcpRecords: (userId) => listMcpPluginsWithState(userId).plugins,
  catalogInstalled: readInstalled,
  catalogOverlay: readOverlay,
  catalogActive: (userId, o) => activeInstalled(userId, makeGate(userId), o),
  legacyPlugins: loadedPlugins,
  loadPlugin: loadPluginAt,
  pluginSource: getPluginSource,
  llmSource: getLlmSource,
  validSource: isValidLlmSource,
  invalidSkills: invalidDiscoverySkills,
  exists: existsSync,
  recordIncident,
});

const RUN = { mcp: checkMcp, catalog: checkCatalog, plugin: checkPlugin, 'skill-kit': checkSkillKit };
const inflight = new Map();
const cache = new Map();
const seen = new Map(); // key -> problem codes of the last completed check
const FAULT_CODES = new Set(['FILES_CHANGED', 'FILES_MISSING', 'LOAD_WARNING', 'HOOK_FILE_MISSING', 'SKILL_INVALID', 'START_FAILED', 'UNREACHABLE']);
export function _resetHealthForTests() { inflight.clear(); cache.clear(); seen.clear(); }

/**
 * @param {string} userId
 * @param {{ kind: 'mcp'|'plugin'|'skill-kit'|'catalog', id: string, force?: boolean }} q
 * @param {object} [deps] overrides for the defaults above (tests)
 * @returns {Promise<{ status: 'ok'|'problem'|'unknown', checkedAt: number, problems: object[], tools?: object[] }>}
 */
export async function checkExtension(userId, { kind, id, force = false, signal }, deps = {}) {
  if (!RUN[kind] || typeof id !== 'string' || !id || id.length > 200) throw new HealthError('invalid', 'kind or id is not valid');
  const ac = new AbortController(); // the shared run's own controller: it aborts only when no waiter is left
  const d = { ...defaults(), ...deps, signal: ac.signal };
  const key = `${userId}\u0000${kind}\u0000${id}`;
  const hit = cache.get(key);
  if (hit && d.now() - hit.at < (force ? FORCE_MIN_MS : CACHE_MS)) return hit.result;
  // A second request for the same item shares the check that is already running.
  if (inflight.has(key)) return wait(inflight.get(key), signal, d);
  const run = (async () => {
    const out = await RUN[kind](userId, id, d);
    const result = { ...out, checkedAt: d.now() };
    if (cache.size > 500) for (const [k, v] of cache) if (d.now() - v.at >= CACHE_MS) cache.delete(k);
    // An abandoned request (client gone) leaves no cache entry and no incident.
    if (ac.signal.aborted) return result;
    cache.set(key, { at: result.checkedAt, result });
    const now = new Set(result.problems.map((p) => p.code));
    const before = seen.get(key) ?? new Set();
    if (seen.size > 500) seen.clear();
    seen.set(key, now);
    if (d.selfHeal) {
      // Only a fault in LLM-IDE or the install, and only when it is new for this item (not on every re-check).
      // Best effort and fixed text only: nothing a server or plugin said goes into the incident.
      for (const code of now) {
        if (!FAULT_CODES.has(code) || before.has(code)) continue;
        try { d.recordIncident(userId, { source: 'server', category: 'extension', message: `${kind} ${id.slice(0, 80)}: ${code}` }); } catch { /* never fails the check */ }
      }
    }
    return result;
  })().finally(() => inflight.delete(key));
  const entry = { run, ac, waiters: new Set(), unsignalled: false };
  inflight.set(key, entry);
  return wait(entry, signal, d);
}

/** One caller waits for the shared run; its own abort ends only its wait, the run stops when the last waiter is gone. */
function wait(entry, signal, d) {
  if (!signal) { entry.unsignalled = true; return entry.run; } // a caller without a signal never aborts: the run is never cancelled
  const token = {};
  entry.waiters.add(token);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      entry.waiters.delete(token);
      if (entry.waiters.size === 0 && !entry.unsignalled) { entry.ac.abort(); entry.run.then(resolve, reject); return; }
      resolve({ status: 'unknown', problems: [], checkedAt: d.now() });
    };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    entry.run.then((r) => { signal.removeEventListener('abort', onAbort); entry.waiters.delete(token); resolve(r); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
