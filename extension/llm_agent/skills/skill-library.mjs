// The central skills repo (dnsmalla/skills) as a discovery catalog for the
// chat "/" menu. The agent only LOADS the agent-globals/agent-tools families
// (those have handlers it can invoke); but the repo is the center of all
// skills, and the IDE surfaces the rest — the `skills/` library family and the
// `runtime/` app-skill family — for discovery. Picking one in the UI attaches
// its SKILL.md as context so the agent can follow it.
//
// Repo is resolved the SAME way scripts/sync-skills.sh resolves it
// ($SKILLS_REPO → ~/skills → ~/Desktop/skills → cache), but READ-ONLY and
// network-free: if no local clone exists we return an empty catalog rather than
// cloning. All I/O is best-effort and never throws.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

// Families NOT already surfaced via /kb/agent/catalog (which covers
// agent-globals + agent-tools). These are the "all the other skills".
const LIBRARY_FAMILIES = ['skills', 'runtime'];
const MAX_DESC = 200;

let _cache = null;

// Locate the central skills checkout on disk. Marker: registry.yaml or an
// agent-tools/ dir (mirrors sync-skills.sh). No network clone.
export function resolveCentralSkillsRepo() {
  const candidates = [];
  if (process.env.SKILLS_REPO) candidates.push(process.env.SKILLS_REPO);
  candidates.push(join(homedir(), 'skills'));
  candidates.push(join(homedir(), 'Desktop', 'skills'));
  candidates.push(join(homedir(), '.cache', 'dnsmalla-skills'));
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'registry.yaml')) || existsSync(join(c, 'agent-tools'))) return c;
    } catch { /* skip */ }
  }
  return null;
}

// Pull name + description from a SKILL.md frontmatter block. Parses the YAML
// with js-yaml — the SAME parser the skill loader uses — so a quoted or folded
// (block-scalar) description reads identically in this catalog and in the
// loader's Library view, instead of the old hand-rolled regex that captured
// just ">" for a folded value. Uses the loader's closing-`---`-on-its-own-line
// regex too, so a `---` inside a value can't prematurely end the block.
function readNameDesc(file) {
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

// { repo: <path|null>, skills: [{ id, family, name, description, path }] }.
// Cached for the process — the central repo doesn't change under a running
// server; a server restart (or sync) picks up changes.
export function listSkillLibrary() {
  if (_cache) return _cache;
  const repo = resolveCentralSkillsRepo();
  if (!repo) { _cache = { repo: null, skills: [] }; return _cache; }

  const skills = [];
  for (const family of LIBRARY_FAMILIES) {
    let entries;
    try { entries = readdirSync(join(repo, family), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = join(repo, family, e.name, 'SKILL.md');
      const fm = readNameDesc(skillMd);
      if (!fm) continue;
      skills.push({
        id: `${family}/${e.name}`,
        family,
        name: fm.name,
        description: fm.description,
        path: skillMd,
      });
    }
  }
  skills.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
  _cache = { repo, skills };
  return _cache;
}

// Max SKILL.md chars sent as followable instructions. Generous — a skill is a
// workflow, not a data dump — but bounded so a pathological file can't blow the
// prompt budget.
const MAX_SKILL_CHARS = 24_000;

// Resolve a library skill id ("<family>/<dir>") to its followable instructions
// by reading the SKILL.md from the LOCAL central repo. Returns
// { id, name, content } or null for an unknown id.
//
// SECURITY: the id MUST be one listSkillLibrary() catalogs — we look the path
// up in the catalog and never read a client-supplied path. This is what lets
// the caller frame the content as TRUSTED, followable instructions: it comes
// from the user's own on-disk skills repo, not the wire, so a client can't
// smuggle arbitrary "follow me" text through this channel.
export function readSkillInstructions(id) {
  if (typeof id !== 'string' || !id) return null;
  const { skills } = listSkillLibrary();
  const entry = skills.find((s) => s.id === id);
  if (!entry) return null;
  try {
    const raw = readFileSync(entry.path, 'utf8');
    return { id: entry.id, name: entry.name, content: raw.slice(0, MAX_SKILL_CHARS) };
  } catch {
    return null;
  }
}

// Test hook — drop the cache so a test can point at a different repo via env.
export function _resetSkillLibraryCache() { _cache = null; }
