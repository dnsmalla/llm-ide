// Skills-source registry: a list of registered skills repos (builtin .skills +
// user-added git clones / local paths). Discovery-only, read in place — never
// copied into plugins/. The builtin source points at resolveCentralSkillsRepo().
//
// Registry file: <sourcesDir>/../skills-sources.json  (atomic writes)
// Cloned sources: <sourcesDir>/<id>/  (siblings to plugins/)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolveCentralSkillsRepo } from '../llm_agent/skills/skill-library.mjs';

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
