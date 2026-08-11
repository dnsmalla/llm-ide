// Skills-source registry: a list of registered skills repos (builtin .skills +
// user-added git clones / local paths). Discovery-only, read in place — never
// copied into plugins/. The builtin source points at resolveCentralSkillsRepo().
//
// Registry file: <sourcesDir>/../skills-sources.json  (atomic writes)
// Cloned sources: <sourcesDir>/<id>/  (siblings to plugins/)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveCentralSkillsRepo } from '../llm_agent/skills/skill-library.mjs';
import { listEnabled } from './state.mjs';

export const BUILTIN_ID = 'builtin';
const LIBRARY_FAMILIES = ['skills', 'runtime'];

// MUST keep identical to Task 1 stub — state.mjs imports and depends on this.
function dirnameOf(p) { return p.split('/').slice(0, -1).join('/') || '/'; }

export function defaultSourcesDir() {
  const base = process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
  return join(dirnameOf(base), 'skills-sources');
}

function registryFilePath() {
  return join(dirname(defaultSourcesDir()), 'skills-sources.json');
}

export function readRegistry() {
  const p = registryFilePath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data?.sources) ? data.sources.filter((s) => s && typeof s === 'object') : [];
  } catch { return []; }
}

export function writeRegistry(list) {
  const p = registryFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sources: list }, null, 2), 'utf8');
  renameSync(tmp, p);
}

// A directory is a valid skills source if it has registry.yaml OR
// (.claude-plugin/plugin.json + a skills/ directory).
export function isValidSkillsSource(dir) {
  try {
    if (!existsSync(dir)) return false;
    if (existsSync(join(dir, 'registry.yaml'))) return true;
    return existsSync(join(dir, '.claude-plugin', 'plugin.json')) && existsSync(join(dir, 'skills'));
  } catch { return false; }
}

// Read version string from registry.yaml or .claude-plugin/plugin.json, if present.
function readVersion(dir) {
  try {
    if (existsSync(join(dir, 'registry.yaml'))) {
      const raw = readFileSync(join(dir, 'registry.yaml'), 'utf8');
      const m = raw.match(/^registryVersion:\s*"?([^"\n]+)"?/m);
      if (m) return m[1].trim();
    }
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      const j = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (typeof j.version === 'string') return j.version;
    }
  } catch { /* best-effort */ }
  return undefined;
}

export function countDiscoverySkills(dir) {
  let n = 0;
  for (const fam of LIBRARY_FAMILIES) {
    const d = join(dir, fam);
    if (!existsSync(d)) continue;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(d, e.name, 'SKILL.md'))) n += 1;
    }
  }
  return n;
}

// Ensure the builtin source exists, pointing at the resolved central repo.
// Idempotent. Does NOT throw if the repo isn't present locally — records the
// source with location = null so the UI can offer "Install".
export function seedBuiltinOnce() {
  const list = readRegistry();
  if (list.some((s) => s.id === BUILTIN_ID)) return;
  const repo = resolveCentralSkillsRepo();
  list.push({
    id: BUILTIN_ID,
    name: 'Central Skills',
    origin: 'builtin',
    location: repo || null,
    builtin: true,
    version: repo ? readVersion(repo) : undefined,
  });
  writeRegistry(list);
}

export function getSource(id) {
  return readRegistry().find((s) => s.id === id) || null;
}

export function listSources() {
  return readRegistry();
}

// Re-read live metadata (existence + skill count + version) for a snapshot.
export function snapshotSource(src) {
  const exists = !!src.location && existsSync(src.location);
  return {
    ...src,
    installed: exists,
    version: exists ? readVersion(src.location) : src.version,
    skillCount: exists ? countDiscoverySkills(src.location) : 0,
  };
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

// A git ref must be a simple branch/tag name, never an option. Rejects
// anything starting with '-' (arg-injection vector: a single argv element
// like '-cCore.fsMonitor=...' is parsed by git as an option, not a ref) and
// chars outside the standard ref charset. Required by the plan's Global
// Constraints.
const REF_RE = /^[a-zA-Z0-9._/-]{1,100}$/;
export function isValidRef(ref) {
  return typeof ref === 'string' && !ref.startsWith('-') && REF_RE.test(ref);
}

// Only public https git URLs are allowed. Mirrors
// mac/Sources/LlmIdeMac/Services/PluginGitInstaller.swift normalize().
export function normalizeGitUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url is required' };
  const u = raw.trim();
  // Reject non-https schemes and local hosts (mirror PluginGitInstaller.normalize).
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(u)) {
    if (/^(file|ssh|git|ftp|http):/i.test(u) || /\/\/(localhost|127\.0\.0\.1|\.local)\b/i.test(u)) {
      return { ok: false, error: 'only public https URLs are allowed' };
    }
    return { ok: false, error: 'url must be a public https git URL' };
  }
  if (/\/\/(localhost|127\.0\.0\.1|[^/]*\.local)\b/i.test(u)) {
    return { ok: false, error: 'localhost/.local hosts are not allowed' };
  }
  return { ok: true, url: u };
}

function slugify(name, existing) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  base = base.slice(0, 40);
  if (!SLUG_RE.test(base)) base = `source-${Date.now().toString(36)}`;
  let id = base, i = 2;
  while (existing.has(id)) { id = `${base}-${i++}`; }
  return id;
}

// Shallow clone into <sourcesDir>/<id>. Hardened: -- guard, no prompts, detached stdin.
function cloneShallow(url, ref, dest) {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (ref) args.push('--branch', ref);
  args.push('--', url, dest);
  const r = spawnSync('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  if (!r.stdout) r.stdout = Buffer.alloc(0);
  if (r.status !== 0) {
    const err = (r.stderr ? r.stderr.toString() : '').slice(0, 200) || 'git clone failed';
    return { error: err };
  }
  return { ok: true };
}

export function addSource({ url, path, ref, name } = {}) {
  const list = readRegistry();
  const existing = new Set(list.map((s) => s.id));

  if (path) {
    if (!existsSync(path)) return { error: 'path does not exist', status: 400 };
    if (!isValidSkillsSource(path)) return { error: 'not a valid skills source (needs registry.yaml or .claude-plugin/plugin.json + skills/)', status: 400 };
    const id = slugify(name || path.split('/').pop(), existing);
    const src = { id, name: name || id, origin: 'local', location: path, builtin: false, version: readVersion(path) };
    list.push(src); writeRegistry(list);
    return { source: src };
  }

  if (url) {
    const n = normalizeGitUrl(url);
    if (!n.ok) return { error: n.error, status: 400 };
    if (ref && !isValidRef(ref)) return { error: 'invalid ref', status: 400 };
    const id = slugify(name || n.url.replace(/\.git$/, '').split('/').pop(), existing);
    const dest = join(defaultSourcesDir(), id);
    mkdirSync(defaultSourcesDir(), { recursive: true });
    const cl = cloneShallow(n.url, ref, dest);
    if (cl.error) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* */ } return { error: cl.error, status: 400 }; }
    if (!isValidSkillsSource(dest)) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ } return { error: 'cloned repo is not a valid skills source', status: 400 }; }
    const src = { id, name: name || id, origin: 'git', location: dest, ref: ref || 'main', builtin: false, version: readVersion(dest) };
    list.push(src); writeRegistry(list);
    return { source: src };
  }

  return { error: 'provide either url or path', status: 400 };
}

export function updateSource(id) {
  const list = readRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return { error: 'source not found', status: 404 };
  const src = list[idx];
  if (src.origin === 'builtin') return syncBuiltin();
  if (!src.location || !existsSync(src.location)) return { error: 'source directory missing', status: 400 };
  if (src.origin === 'local') {
    // Read in place — just refresh version.
    list[idx].version = readVersion(src.location);
    writeRegistry(list);
    return { ok: true };
  }
  // git: fetch + checkout tracked ref.
  const ref = src.ref || 'main';
  if (!isValidRef(ref)) return { error: 'invalid ref', status: 400 };
  let r = spawnSync('git', ['fetch', '--depth', '1', 'origin', ref], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: src.location,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  if (r.status !== 0) return { error: 'git fetch failed', status: 400 };
  r = spawnSync('git', ['checkout', ref], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: src.location,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  if (r.status !== 0) return { error: 'git checkout failed', status: 400 };
  list[idx].version = readVersion(src.location);
  writeRegistry(list);
  return { ok: true };
}

export function removeSource(id) {
  if (id === BUILTIN_ID) return { error: 'builtin source cannot be removed', status: 400 };
  const list = readRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return { error: 'source not found', status: 404 };
  const src = list[idx];
  if (src.origin === 'git' && src.location && existsSync(src.location)) {
    try { rmSync(src.location, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  list.splice(idx, 1);
  writeRegistry(list);
  return { ok: true };
}

// Builtin update = ensure the .skills submodule is checked out at its pin.
export function syncBuiltin() {
  const repoRoot = join(dirname(defaultSourcesDir()), '..', '..'); // best-effort; server may override
  const r = spawnSync('git', ['submodule', 'update', '--init', '.skills'], {
    cwd: process.env.LLMIDE_REPO_ROOT || repoRoot,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  });
  const installed = r.status === 0;
  // Refresh the builtin location/version regardless.
  const list = readRegistry();
  const idx = list.findIndex((s) => s.id === BUILTIN_ID);
  const resolved = resolveCentralSkillsRepo();
  if (idx >= 0) {
    list[idx].location = resolved || list[idx].location;
    if (resolved) list[idx].version = readVersion(resolved);
    writeRegistry(list);
  }
  return { ok: true, installed };
}

export function listSourcesWithState(userId) {
  const enabled = listEnabled(userId);
  return {
    sources: listSources().map((s) => {
      const snap = snapshotSource(s);
      return { ...snap, enabled: enabled.has(s.id) };
    }),
  };
}
