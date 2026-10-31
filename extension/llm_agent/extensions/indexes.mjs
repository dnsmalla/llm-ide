// Catalog indexes and search (plan section 6, P5).
//
// An index is a LIST of things a source offers; installing from it is a
// separate, user-initiated step (install.mjs). Four adapters, all read-only:
//
//   skills-repo    a GitHub repo holding <dir>/SKILL.md folders (anthropics/skills)
//   marketplace    a GitHub repo with .claude-plugin/marketplace.json
//   github-dirs    a GitHub repo whose `src/<dir>/package.json` folders are servers
//                  (modelcontextprotocol/servers); browse only
//   mcp-registry   the official MCP registry's server.json list (HTTPS JSON); browse only
//
// The sources are a fixed seed list the operator can extend by code only: a
// user cannot make the server fetch an arbitrary URL through here. Every fetch
// goes through the pinned fetch (no private addresses, no redirects), with size
// caps; one source failing never affects another and keeps its last good copy.
// Nothing is fetched by a GET: `refreshIndexes` is a user-initiated POST, cached
// for a TTL, and throttled per source. Index data is public metadata, so the
// cache is shared between users; installed BYTES stay per user.
//
// Entries are never executed, only parsed; every string is control-stripped
// and capped, and the number of entries per source is capped.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';
import { resolveCommit, downloadArchive, readCapped, parseRepoUrl } from './sources/github.mjs';
import { sourceAllowedFor } from './allowlist.mjs';
import { extractTarGz } from './sources/tar.mjs';
import { frontmatter } from './inspect.mjs';
import { itemId } from './model.mjs';
import { readInstalled, baseDir } from './installed.mjs';
import { catalogEnabled } from './flags.mjs';

export const REGISTRY_HOST = 'registry.modelcontextprotocol.io';
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
export const REFRESH_THROTTLE_MS = 60 * 1000;
// A shared fetch is server-owned: it never rides one user's request signal, and has its own deadline.
export const REFRESH_TIMEOUT_MS = 90 * 1000;
// A user's `force` is honoured at most this often per source; more often it is treated as a plain refresh.
export const FORCE_PER_USER_MS = 5 * 60 * 1000;
export const LIMITS = Object.freeze({ entriesPerSource: 1500, name: 120, description: 300, registryPages: 3, registryBytes: 2 * 1024 * 1024 });

/** @type {ReadonlyArray<{ id: string, title: string, kind: string, repo?: string, dir?: string }>} */
export const SEED_SOURCES = Object.freeze([
  { id: 'anthropics/skills', title: 'Anthropic skills', kind: 'skills-repo', repo: 'anthropics/skills' },
  { id: 'anthropics/claude-plugins-official', title: 'Claude plugins (official)', kind: 'marketplace', repo: 'anthropics/claude-plugins-official' },
  { id: 'modelcontextprotocol/servers', title: 'MCP reference servers', kind: 'github-dirs', repo: 'modelcontextprotocol/servers', dir: 'src' },
  { id: 'mcp-registry', title: 'MCP registry', kind: 'mcp-registry' },
]);

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const relPath = (p) => {
  const s = String(p ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s || s.length > 200 || s.startsWith('/') || /[\u0000-\u001f\\]/.test(s) || s.split('/').some((x) => x === '' || x === '.' || x === '..')) return null;
  return s;
};

export function indexFilePath() { return join(baseDir(), 'extensions', 'index-cache.json'); }

function readCache() {
  const p = indexFilePath();
  if (!existsSync(p)) return { corrupt: false, sources: Object.create(null) };
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d) || !d.sources || typeof d.sources !== 'object' || Array.isArray(d.sources)) return { corrupt: true, sources: Object.create(null) };
    const sources = Object.create(null);
    for (const s of SEED_SOURCES) if (d.sources[s.id] && typeof d.sources[s.id] === 'object') sources[s.id] = d.sources[s.id];
    return { corrupt: false, sources };
  } catch { return { corrupt: true, sources: Object.create(null) }; }
}

function writeCache(sources) {
  const p = indexFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, sources }), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, p);
}

// ---------- adapters: each returns { entries, commit? } ----------

async function githubTree(src, f, signal, known) {
  const [owner, repo] = src.repo.split('/');
  const commit = await resolveCommit({ owner, repo }, { fetch: f, signal });
  if (known?.commit === commit && Array.isArray(known.entries)) return { unchanged: true, commit };
  const tree = extractTarGz(await downloadArchive({ owner, repo, commit }, { fetch: f, signal }));
  return { files: tree.files, commit, owner, repo };
}

const base = (src, owner) => ({ indexId: src.id, publisher: owner.toLowerCase() });
const text = (b) => b.toString('utf8');

function skillsEntries(src, t) {
  const out = [];
  for (const [p, b] of t.files) {
    const m = /^((?:skills\/)?[^/]+)\/SKILL\.md$/.exec(p) ?? /^(skills\/[^/]+\/[^/]+)\/SKILL\.md$/.exec(p);
    if (!m || out.length >= LIMITS.entriesPerSource) continue;
    const fm = frontmatter(text(b));
    const name = clean(fm.name || m[1].split('/').pop(), LIMITS.name);
    if (!name) continue;
    out.push({ ...base(src, t.owner), kind: 'skill', name, description: clean(fm.description, LIMITS.description), source: { url: `https://github.com/${t.owner}/${t.repo}`, path: m[1] }, installable: true });
  }
  return out;
}

function marketplaceEntries(src, t) {
  let m;
  try { m = JSON.parse(text(t.files.get('.claude-plugin/marketplace.json') ?? Buffer.from('{}'))); } catch { m = null; }
  const out = [];
  for (const e of Array.isArray(m?.plugins) ? m.plugins : []) {
    if (out.length >= LIMITS.entriesPerSource || !e || typeof e !== 'object') continue;
    const name = clean(e.name, LIMITS.name);
    if (!name) continue;
    const entry = { ...base(src, t.owner), kind: 'plugin', name, description: clean(e.description, LIMITS.description), ...(typeof e.version === 'string' ? { version: clean(e.version, 64) } : {}) };
    const s = e.source;
    if (typeof s === 'string' && relPath(s)) out.push({ ...entry, source: { url: `https://github.com/${t.owner}/${t.repo}`, path: relPath(s) }, installable: true });
    else if (s && typeof s === 'object' && s.source === 'github' && typeof s.repo === 'string') {
      const r = parseRepoUrl(`https://github.com/${s.repo}`);
      out.push(r ? { ...entry, publisher: r.owner.toLowerCase(), source: { url: r.url }, installable: true } : { ...entry, source: {}, installable: false, reason: 'unsupported_source' });
    } else out.push({ ...entry, source: {}, installable: false, reason: 'unsupported_source' });
  }
  return out;
}

function dirEntries(src, t) {
  const out = [];
  for (const [p, b] of t.files) {
    const m = new RegExp(`^${src.dir}/([^/]+)/package\\.json$`).exec(p);
    if (!m || out.length >= LIMITS.entriesPerSource) continue;
    let pkg; try { pkg = JSON.parse(text(b)); } catch { pkg = {}; }
    out.push({ ...base(src, t.owner), kind: 'mcp', name: clean(m[1], LIMITS.name), description: clean(pkg?.description, LIMITS.description), source: { url: `https://github.com/${t.owner}/${t.repo}`, path: `${src.dir}/${m[1]}` }, installable: false, reason: 'package_launcher' });
  }
  return out;
}

async function registryEntries(src, f, signal) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < LIMITS.registryPages && out.length < LIMITS.entriesPerSource; page += 1) {
    const q = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await f(`https://${REGISTRY_HOST}/v0.1/servers${q}`, { signal, redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'llm-ide-extensions' } });
    if (res.status >= 300 && res.status < 400) throw Object.assign(new Error('redirect'), { code: 'redirect_refused' });
    if (!res.ok) throw Object.assign(new Error(`registry answered ${res.status}`), { code: 'upstream' });
    let body;
    try { body = JSON.parse((await readCapped(res, LIMITS.registryBytes)).toString('utf8')); } catch (err) { throw Object.assign(new Error('bad registry answer'), { code: err?.code ?? 'upstream' }); }
    for (const item of Array.isArray(body?.servers) ? body.servers : []) {
      const s = item?.server ?? item;
      const name = clean(s?.name, LIMITS.name);
      if (!name || out.length >= LIMITS.entriesPerSource) continue;
      const repoUrl = typeof s?.repository?.url === 'string' ? clean(s.repository.url, 200) : undefined;
      const gh = repoUrl ? parseRepoUrl(repoUrl.replace(/\.git$/, '')) : null;
      out.push({
        indexId: src.id, kind: 'mcp', name, publisher: (gh?.owner ?? name.split('/')[0] ?? 'registry').toLowerCase().slice(0, 40),
        description: clean(s?.description, LIMITS.description), ...(typeof s?.version === 'string' ? { version: clean(s.version, 64) } : {}),
        source: gh ? { url: gh.url } : {}, remote: Array.isArray(s?.remotes) && s.remotes.length > 0,
        installable: false, reason: 'registry_install_not_supported',
      });
    }
    cursor = typeof body?.metadata?.nextCursor === 'string' ? body.metadata.nextCursor.slice(0, 200) : '';
    if (!cursor) break;
  }
  return out;
}

async function fetchSource(src, f, signal, known) {
  if (src.kind === 'mcp-registry') return { entries: await registryEntries(src, f, signal) };
  const t = await githubTree(src, f, signal, known);
  if (t.unchanged) return { unchanged: true, commit: t.commit };
  const entries = src.kind === 'skills-repo' ? skillsEntries(src, t) : src.kind === 'marketplace' ? marketplaceEntries(src, t) : dirEntries(src, t);
  return { entries, commit: t.commit };
}

// ---------- refresh ----------

const inflight = new Map();
const errorCode = (err) => {
  if (err?.code === 'SSRF_BLOCKED') return 'blocked';
  if (err?.name === 'AbortError') return 'timeout';
  return typeof err?.code === 'string' && /^[a-z_]{3,30}$/.test(err.code) ? err.code : 'upstream';
};

async function refreshOne(src, { force, fetch: f, signal, now }) {
  // `signal` here is the SERVER's (timeout) signal, never a requesting user's.
  const cache = readCache();
  if (cache.corrupt) return { id: src.id, status: 'error', error: 'state_unreadable' };
  const known = cache.sources[src.id];
  if (!force && known?.fetchedAt && now - Date.parse(known.fetchedAt) < INDEX_TTL_MS && !known.error) return { id: src.id, status: 'fresh', count: known.entries?.length ?? 0 };
  if (known?.attemptedAt && now - Date.parse(known.attemptedAt) < REFRESH_THROTTLE_MS) return { id: src.id, status: 'throttled', count: known.entries?.length ?? 0 };
  let record;
  try {
    const r = await fetchSource(src, f, signal, known && !known.error ? known : undefined);
    const at = new Date(now).toISOString();
    if (r.unchanged) { const { error: _e, ...rest } = known; record = { ...rest, fetchedAt: at, attemptedAt: at }; }
    else record = { entries: r.entries, commit: r.commit, fetchedAt: at, attemptedAt: at };
  } catch (err) {
    // Keep the last good copy; remember that and when it failed.
    record = { ...(known ?? { entries: [] }), attemptedAt: new Date(now).toISOString(), error: errorCode(err) };
  }
  const latest = readCache();
  if (!latest.corrupt) writeCache({ ...latest.sources, [src.id]: record });
  return record.error ? { id: src.id, status: 'error', error: record.error, count: record.entries?.length ?? 0 } : { id: src.id, status: 'refreshed', count: record.entries.length };
}

const forcedAt = new Map();

/** Resolve with `p`, or reject with an AbortError for THIS caller only when `signal` aborts. The shared work goes on. */
function raceAbort(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * Refresh one or all index sources (user-initiated). Per-source isolation:
 * every source gets a result, a failure keeps the previous entries.
 * The fetch is shared and SERVER-owned (own timeout): a caller's `signal` only stops that caller waiting, so one
 * client disconnecting never fails, poisons or throttles the result other users get. `force` from a user
 * (`userId` given) is honoured at most once per FORCE_PER_USER_MS per source.
 */
export async function refreshIndexes({ sourceId, force = false, userId, fetch: fetchImpl, signal, now = Date.now() } = {}) {
  if (!catalogEnabled()) { const e = new Error('the extensions catalog is switched off'); e.code = 'catalog_disabled'; throw e; }
  const list = sourceId ? SEED_SOURCES.filter((s) => s.id === sourceId) : SEED_SOURCES;
  if (sourceId && !list.length) { const e = new Error('unknown index source'); e.code = 'not_found'; throw e; }
  const f = fetchImpl ?? makePinnedFetch({ allowPrivate: false });
  const results = [];
  for (const src of list) {
    let doForce = force === true;
    if (doForce && userId) {
      const k = `${userId}\u0000${src.id}`;
      if (now - (forcedAt.get(k) ?? -Infinity) < FORCE_PER_USER_MS) doForce = false;
      else { forcedAt.set(k, now); if (forcedAt.size > 5000) forcedAt.delete(forcedAt.keys().next().value); }
    }
    if (!inflight.has(src.id)) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
      timer.unref?.();
      inflight.set(src.id, refreshOne(src, { force: doForce, fetch: f, signal: ac.signal, now }).finally(() => { clearTimeout(timer); inflight.delete(src.id); }));
    }
    results.push(await raceAbort(inflight.get(src.id), signal));
  }
  return { results };
}

// ---------- search ----------

export function sourceStatuses(now = Date.now()) {
  const cache = readCache();
  return SEED_SOURCES.map((s) => {
    const k = cache.sources[s.id];
    const age = k?.fetchedAt ? now - Date.parse(k.fetchedAt) : Infinity;
    return {
      id: s.id, title: s.title, kind: s.kind,
      status: cache.corrupt ? 'error' : !k ? 'empty' : age > INDEX_TTL_MS ? 'stale' : 'fresh',
      count: Array.isArray(k?.entries) ? k.entries.length : 0, fetchedAt: k?.fetchedAt ?? null,
      ...(k?.error ? { error: k.error } : {}), ...(cache.corrupt ? { error: 'state_unreadable' } : {}),
    };
  });
}

function score(e, tokens) {
  const name = e.name.toLowerCase(); const desc = (e.description ?? '').toLowerCase(); const pub = e.publisher.toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let s = 0;
    if (name === t) s = 100; else if (name.startsWith(t)) s = 50; else if (name.includes(t)) s = 30;
    else if (pub.includes(t)) s = 10; else if (desc.includes(t)) s = 5;
    if (!s) return 0;
    total += s;
  }
  return tokens.length ? total : 1;
}

/**
 * Browse the cached indexes. No network. `installed` marks what this user has.
 * `installable` is the entry's own flag AND the operator's install allowlist.
 */
export function searchCatalog(userId, { q = '', kind, limit = 25, offset = 0, now = Date.now() } = {}) {
  const cache = readCache();
  const installed = new Set(readInstalled(userId).items.keys());
  const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map((t) => t.slice(0, 60));
  const lim = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 25));
  const off = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
  const hits = [];
  for (const src of SEED_SOURCES) {
    for (const e of cache.sources[src.id]?.entries ?? []) {
      if (!e || typeof e.name !== 'string' || typeof e.publisher !== 'string') continue;
      if (kind && e.kind !== kind) continue;
      const s = score(e, tokens);
      if (!s) continue;
      let id = null;
      try { id = itemId(e.kind, e.publisher, e.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')); } catch { /* not addressable as an item */ }
      const repo = e.source?.url ? parseRepoUrl(e.source.url) : null;
      const allowed = e.installable === true && !!repo && sourceAllowedFor(userId, repo.owner, repo.repo);
      hits.push({ s, entry: {
        indexId: e.indexId, kind: e.kind, name: e.name, description: e.description ?? '', publisher: e.publisher,
        ...(e.version ? { version: e.version } : {}), source: e.source ?? {}, ...(e.remote ? { remote: true } : {}),
        installable: allowed,
        ...(!allowed ? { reason: e.installable === true ? 'source_not_allowed' : (e.reason ?? 'not_installable') } : {}),
        installed: id ? installed.has(id) : false,
      } });
    }
  }
  hits.sort((a, b) => b.s - a.s || (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0));
  return { query: String(q).slice(0, 200), total: hits.length, offset: off, results: hits.slice(off, off + lim).map((h) => h.entry), sources: sourceStatuses(now) };
}
