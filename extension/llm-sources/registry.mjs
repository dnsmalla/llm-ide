// LLM-source registry: a list of registered LLM-resource repos (builtin
// .skills + user-added git clones / local paths). Discovery-only, read in
// place — never copied into plugins/. The builtin source points at
// resolveCentralSkillsRepo(). Each source may contribute any mix of four
// discoverable kinds: skills (skills/, runtime/ families — SKILL.md), agents
// (agents/*.md subagent definitions), hooks (.claude-plugin/hooks/hooks.json
// or hooks/hooks.json, the Claude Code plugin-hook manifest shape), and MCP
// servers (.mcp.json or .claude-plugin/.mcp.json, the Claude Code MCP-server
// manifest shape).
//
// SAFETY: every non-builtin source is discovery-only, for ALL FOUR kinds —
// skills surface as chat "/" menu attachable context (unchanged); agents,
// hooks, and MCP servers are catalogued/listable ONLY, never wired into the
// runtime. A registered third-party repo's hooks.json commands are never
// executed and its .mcp.json servers are never spawned/connected to — either
// would let anyone who can register a source run arbitrary code (a spawned
// MCP server is a live process with real capabilities, not just a one-shot
// command) inside or alongside this server. Only the `builtin` source's own
// hardcoded handlers (in route.mjs) are ever invoked; see the design doc's
// Safety section.
//
// Registry file: <sourcesDir>/../llm-sources.json  (atomic writes)
// Cloned sources: <sourcesDir>/<id>/  (siblings to plugins/)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yaml from 'js-yaml';
import { resolveCentralSkillsRepo } from '../llm_agent/skills/skill-library.mjs';
import { listEnabled, pruneOrphans } from './state.mjs';

// Git operations (clone/fetch/checkout/submodule-update) run async — the
// server is single-threaded Node, so a *Sync spawn here would freeze every
// other request (captions, chat, everything) for however long the network
// op takes, up to each call's own timeout below. Mirrors the async pattern
// `llm_agent/runtime/handlers/run-bash.mjs` already uses.
const execFileAsync = promisify(execFile);

export const BUILTIN_ID = 'builtin';
const LIBRARY_FAMILIES = ['skills', 'runtime'];
const AGENTS_FAMILY = 'agents';
const MAX_DESC = 200;

// MUST keep identical to Task 1 stub — state.mjs imports and depends on this.
function dirnameOf(p) { return p.split('/').slice(0, -1).join('/') || '/'; }

export function defaultSourcesDir() {
  const base = process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
  return join(dirnameOf(base), 'llm-sources');
}

function registryFilePath() {
  return join(dirname(defaultSourcesDir()), 'llm-sources.json');
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

// A directory is a valid LLM source if it has registry.yaml OR
// (.claude-plugin/plugin.json + a skills/ directory) OR an agents/, hooks,
// or MCP manifest of its own — i.e. it contributes at least one
// discoverable kind.
export function isValidLlmSource(dir) {
  try {
    if (!existsSync(dir)) return false;
    if (existsSync(join(dir, 'registry.yaml'))) return true;
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json')) && existsSync(join(dir, 'skills'))) return true;
    if (existsSync(join(dir, AGENTS_FAMILY))) return true;
    if (existsSync(join(dir, '.claude-plugin', 'hooks', 'hooks.json')) || existsSync(join(dir, 'hooks', 'hooks.json'))) return true;
    if (existsSync(join(dir, '.mcp.json')) || existsSync(join(dir, '.claude-plugin', '.mcp.json'))) return true;
    return false;
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

// Pull name + description from a markdown frontmatter block (SKILL.md or an
// agents/*.md subagent definition — same shape, both are just "name +
// description + body"). Uses js-yaml so a folded/quoted description parses
// the same way the skill-library reader and the agent-loader do.
function readFrontmatterNameDesc(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n^---\s*$/m);
    if (!m) return null;
    const fm = yaml.load(m[1]);
    if (!fm || typeof fm !== 'object') return null;
    const name = typeof fm.name === 'string' ? fm.name.trim() : '';
    if (!name) return null;
    const description = typeof fm.description === 'string'
      ? fm.description.trim().slice(0, MAX_DESC)
      : '';
    return { name, description };
  } catch {
    return null;
  }
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

// agents/*.md — one file per subagent, same frontmatter shape as SKILL.md
// (Claude Code's convention for standalone subagent definitions).
export function listDiscoveryAgents(dir) {
  const d = join(dir, AGENTS_FAMILY);
  if (!existsSync(d)) return [];
  let entries;
  try { entries = readdirSync(d, { withFileTypes: true }); } catch { return []; }
  const agents = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const fm = readFrontmatterNameDesc(join(d, e.name));
    if (!fm) continue;
    agents.push({ name: fm.name, description: fm.description, path: join(d, e.name) });
  }
  return agents;
}

export function countDiscoveryAgents(dir) {
  return listDiscoveryAgents(dir).length;
}

// .claude-plugin/hooks/hooks.json (Claude Code plugin-hook manifest) or a
// top-level hooks/hooks.json fallback — shape:
//   { "<EventName>": [ { "matcher"?: string, "hooks": [{ "type": "command", "command": string }] } ] }
// DISCOVERY ONLY — the commands inside are never executed by this server;
// see the Safety note at the top of this file.
function hooksManifestPath(dir) {
  const nested = join(dir, '.claude-plugin', 'hooks', 'hooks.json');
  if (existsSync(nested)) return nested;
  const flat = join(dir, 'hooks', 'hooks.json');
  if (existsSync(flat)) return flat;
  return null;
}

export function listDiscoveryHooks(dir) {
  const p = hooksManifestPath(dir);
  if (!p) return [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  if (!manifest || typeof manifest !== 'object') return [];
  const out = [];
  for (const [event, entries] of Object.entries(manifest)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = typeof entry?.matcher === 'string' ? entry.matcher : undefined;
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const h of hooks) {
        if (typeof h?.command !== 'string') continue;
        out.push({ event, matcher, command: h.command.slice(0, 200) });
      }
    }
  }
  return out;
}

export function countDiscoveryHooks(dir) {
  return listDiscoveryHooks(dir).length;
}

// .mcp.json (Claude Code's MCP-server manifest — same file the CLI itself
// reads from a project root) or a nested .claude-plugin/.mcp.json fallback
// (mirrors how plugin.json-based sources nest other manifests) — shape:
//   { "mcpServers": { "<name>": { "command": string, "args"?: string[], "env"?: object } } }
// DISCOVERY ONLY — this server never spawns/connects to a listed MCP
// server. An MCP server is a long-lived process with real capabilities
// (filesystem, network, whatever its tools expose); auto-connecting to one
// from a third-party-registered source would be strictly worse than the
// hooks risk this file already guards against, not just equivalent to it.
// See the Safety note at the top of this file.
function mcpManifestPath(dir) {
  const flat = join(dir, '.mcp.json');
  if (existsSync(flat)) return flat;
  const nested = join(dir, '.claude-plugin', '.mcp.json');
  if (existsSync(nested)) return nested;
  return null;
}

export function listDiscoveryMcpServers(dir) {
  const p = mcpManifestPath(dir);
  if (!p) return [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  const servers = manifest?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (typeof cfg?.command !== 'string') continue;
    const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string').slice(0, 20) : [];
    out.push({ name, command: cfg.command.slice(0, 200), args });
  }
  return out;
}

export function countDiscoveryMcpServers(dir) {
  return listDiscoveryMcpServers(dir).length;
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

// Re-read live metadata (existence + skill/agent/hook/mcp counts + version) for a snapshot.
export function snapshotSource(src) {
  const exists = !!src.location && existsSync(src.location);
  return {
    ...src,
    installed: exists,
    version: exists ? readVersion(src.location) : src.version,
    skillCount: exists ? countDiscoverySkills(src.location) : 0,
    agentCount: exists ? countDiscoveryAgents(src.location) : 0,
    hookCount: exists ? countDiscoveryHooks(src.location) : 0,
    mcpCount: exists ? countDiscoveryMcpServers(src.location) : 0,
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
async function cloneShallow(url, ref, dest) {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (ref) args.push('--branch', ref);
  args.push('--', url, dest);
  try {
    await execFileAsync('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000,
    });
    return { ok: true };
  } catch (err) {
    const msg = (err.stderr ? String(err.stderr) : err.message || '').slice(0, 200) || 'git clone failed';
    return { error: msg };
  }
}

export async function addSource({ url, path, ref, name } = {}) {
  const list = readRegistry();
  const existing = new Set(list.map((s) => s.id));

  if (path) {
    if (!existsSync(path)) return { error: 'path does not exist', status: 400 };
    if (!isValidLlmSource(path)) return { error: 'not a valid LLM source (needs registry.yaml, .claude-plugin/plugin.json + skills/, agents/, a hooks manifest, or an .mcp.json manifest)', status: 400 };
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
    const cl = await cloneShallow(n.url, ref, dest);
    if (cl.error) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* */ } return { error: cl.error, status: 400 }; }
    if (!isValidLlmSource(dest)) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ } return { error: 'cloned repo is not a valid LLM source', status: 400 }; }
    const src = { id, name: name || id, origin: 'git', location: dest, ref: ref || 'main', builtin: false, version: readVersion(dest) };
    list.push(src); writeRegistry(list);
    return { source: src };
  }

  return { error: 'provide either url or path', status: 400 };
}

export async function updateSource(id) {
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
  try {
    await execFileAsync('git', ['fetch', '--depth', '1', 'origin', ref], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: src.location, timeout: 60_000,
    });
  } catch { return { error: 'git fetch failed', status: 400 }; }
  try {
    await execFileAsync('git', ['checkout', ref], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: src.location, timeout: 30_000,
    });
  } catch { return { error: 'git checkout failed', status: 400 }; }
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
  // Drop this id from every user's enable set — otherwise a re-added source
  // that reuses the same slug would inherit a stale "enabled" from before
  // its removal.
  pruneOrphans(new Set(list.map((s) => s.id)));
  return { ok: true };
}

// Builtin update = ensure the .skills submodule is checked out at its pin.
export async function syncBuiltin() {
  const repoRoot = join(dirname(defaultSourcesDir()), '..', '..'); // best-effort; server may override
  let installed;
  try {
    await execFileAsync('git', ['submodule', 'update', '--init', '.skills'], {
      cwd: process.env.LLMIDE_REPO_ROOT || repoRoot,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 120_000,
    });
    installed = true;
  } catch {
    installed = false;
  }
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

// Full discovery detail for one source — used by the Mac detail view to
// actually list what a source contributes, not just show counts. Discovery
// only: agents/hooks are informational, never invoked/executed from here.
export function sourceDiscoveryDetail(id) {
  const src = getSource(id);
  if (!src || !src.location || !existsSync(src.location)) return null;
  return {
    agents: listDiscoveryAgents(src.location),
    hooks: listDiscoveryHooks(src.location),
    mcpServers: listDiscoveryMcpServers(src.location),
  };
}
