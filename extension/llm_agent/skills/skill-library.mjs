// The central skills repo (dnsmalla/skills) as a discovery catalog for the
// chat "/" menu. The agent only LOADS the agent-globals/agent-tools families
// (those have handlers it can invoke); but the repo is the center of all
// skills, and the IDE surfaces the rest — the `skills/` library family and the
// `runtime/` app-skill family — for discovery. Picking one in the UI attaches
// its SKILL.md as context so the agent can follow it.
//
// Repo is resolved the SAME way scripts/sync-skills.sh resolves it
// ($SKILLS_REPO → <repo>/.skills → ~/skills → ~/Desktop/skills → cache),
// but READ-ONLY and network-free: if no local clone exists we return an empty
// catalog rather than cloning. All I/O is best-effort and never throws.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
// Repo location resolution ($SKILLS_REPO → <repo>/.skills → ~/skills → …)
// lives in core/skills-repo.mjs — the LLM-sources registry and
// kb/install-project-skills.mjs need the same resolution, and importing it
// from here made registry.mjs ↔ skill-library.mjs a real import cycle.
import { listSources, snapshotSource, BUILTIN_ID, seedBuiltinOnce } from '../../llm-sources/registry.mjs';
import { listEnabled } from '../../llm-sources/state.mjs';

// Families NOT already surfaced via /kb/agent/catalog (which covers
// agent-globals + agent-tools). These are the "all the other skills".
const LIBRARY_FAMILIES = ['skills', 'runtime'];
const MAX_DESC = 200;

// Keyed by userId (each user's enabled-sources set differs) — a single
// shared slot here would leak one user's catalog (including which private
// sources they've registered) to every other user's next request. The
// no-user/test caller uses '' as its key.
const _cache = new Map();

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

// { repo: <builtin path|null>, skills: [{ id, family, name, description, path, sourceId, sourceName }] }.
// Iterates the user's ENABLED skills sources (per-user state). Backward-compatible:
// `repo` is the builtin source's resolved path (null if absent); skills gain
// sourceId/sourceName. Cached per process; call _resetSkillLibraryCache() after
// any add/update/remove/toggle.
export function listSkillLibrary(userId) {
  const cacheKey = userId || '';
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  seedBuiltinOnce();
  const enabled = userId
    ? listEnabled(userId)
    : new Set(listSources().map((s) => s.id)); // no user (tests/default) → all enabled

  const skills = [];
  const seenIds = new Set(); // skill ids are source-independent (`<family>/<dir>`) — first enabled source wins
  let builtinRepo = null;
  for (const src of listSources()) {
    if (!enabled.has(src.id)) continue;
    const snap = snapshotSource(src);
    if (src.id === BUILTIN_ID) builtinRepo = src.location || null;
    if (!snap.installed) continue;
    for (const family of LIBRARY_FAMILIES) {
      let entries;
      try { entries = readdirSync(join(src.location, family), { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillMd = join(src.location, family, e.name, 'SKILL.md');
        const id = `${family}/${e.name}`;
        if (seenIds.has(id)) continue; // duplicate across enabled sources (e.g. default-sources + builtin)
        const fm = readNameDesc(skillMd);
        if (!fm) continue;
        seenIds.add(id);
        skills.push({
          id,
          family,
          name: fm.name,
          description: fm.description,
          path: skillMd,
          sourceId: src.id,
          sourceName: src.name,
        });
      }
    }
  }
  skills.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
  const result = { repo: builtinRepo, skills };
  _cache.set(cacheKey, result);
  return result;
}

// Max SKILL.md chars sent as followable instructions. Generous — a skill is a
// workflow, not a data dump — but bounded so a pathological file can't blow the
// prompt budget.
const MAX_SKILL_CHARS = 24_000;

// Ceiling for a caller that asks for more (the planning pipeline does —
// subagent-driven-development is ~32 KB upstream, and the default cap would
// cut it off partway through the task loop, leaving the model with the
// dispatch instructions but not the review ones). Still bounded: this is a
// cap on a caller's request, not a licence for an unbounded read.
const MAX_PIPELINE_SKILL_CHARS = 48_000;

// Resolve a library skill id ("<family>/<dir>") to its followable instructions
// by reading the SKILL.md from the LOCAL central repo. Returns
// { id, name, content } or null for an unknown id.
//
// SECURITY: the id MUST be one listSkillLibrary() catalogs — we look the path
// up in the catalog and never read a client-supplied path. This is what lets
// the caller frame the content as TRUSTED, followable instructions: it comes
// from the user's own on-disk skills repo, not the wire, so a client can't
// smuggle arbitrary "follow me" text through this channel.
export function readSkillInstructions(id, userId, { maxChars = MAX_SKILL_CHARS } = {}) {
  if (typeof id !== 'string' || !id) return null;
  const { skills } = listSkillLibrary(userId);
  const entry = skills.find((s) => s.id === id);
  if (!entry) return null;
  try {
    const raw = readFileSync(entry.path, 'utf8');
    const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.min(maxChars, MAX_PIPELINE_SKILL_CHARS) : MAX_SKILL_CHARS;
    return { id: entry.id, name: entry.name, content: raw.slice(0, cap) };
  } catch {
    return null;
  }
}

// Test hook — drop the cache so a test can point at a different repo via env.
export function _resetSkillLibraryCache() { _cache.clear(); }
