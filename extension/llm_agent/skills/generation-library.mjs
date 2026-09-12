// The `templates/` and `commands/` families of the enabled LLM sources, for
// the Mac app's Doc Gen and Visual menus.
//
// Separate from `skill-library.mjs` on purpose. That module answers "which
// SKILL.md can the chat attach?" and its families are directories
// (`<family>/<dir>/SKILL.md`). These two families are FLAT — one `.md` per
// entry — and they are not skills at all: a template is document structure, a
// command is a reusable instruction. Folding them into the skill catalog
// would have meant a second entry shape inside one list and a `kind` field on
// every row to tell them apart.
//
// Why this exists at all: the Mac app used to carry its default templates and
// commands as Swift constants, so adding one meant an app change and a
// release. They live in the kit now, and this is how they reach the app.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

import { listSources, snapshotSource, BUILTIN_ID, seedBuiltinOnce } from '../../llm-sources/registry.mjs';
import { listEnabled } from '../../llm-sources/state.mjs';

/** Flat `.md` families this module surfaces, and the wire key each lands under. */
const GENERATION_FAMILIES = { templates: 'templates', commands: 'commands' };

const MAX_DESC = 200;
/** A template/command body is prose, not a program — this is a sanity bound. */
const MAX_BODY = 20_000;

/**
 * Surfaces a file may declare. `doc` is the default and the meaning of every
 * entry written before the field existed; an UNRECOGNISED value degrades to
 * `doc` rather than hiding the file from every menu, because a typo should
 * not lose someone's template.
 */
const SURFACES = new Set(['doc', 'visual']);
export const DEFAULT_SURFACE = 'doc';

export function normalizeSurface(value) {
  return typeof value === 'string' && SURFACES.has(value.trim()) ? value.trim() : DEFAULT_SURFACE;
}

/**
 * Parse one entry file: frontmatter (name, description, surface) plus the
 * body below it, which is the template's sections or the command's
 * instruction.
 *
 * Same frontmatter regex as the skill loader — closing `---` on its own line —
 * so a `---` inside a value cannot end the block early, and the same js-yaml
 * parser so a folded (`>`) description reads identically in both catalogs.
 */
export function parseEntry(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const m = raw.match(/^---\n([\s\S]*?)\n^---\s*$/m);
  if (!m) return null;
  let fm;
  try { fm = yaml.load(m[1]); } catch { return null; }
  if (!fm || typeof fm !== 'object') return null;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) return null;
  return {
    name,
    description: typeof fm.description === 'string' ? fm.description.trim().slice(0, MAX_DESC) : '',
    surface: normalizeSurface(fm.surface),
    // Everything after the frontmatter block, verbatim. The app writes this
    // into the project as the template/command file, so its `##` sections and
    // instruction text must survive exactly.
    body: raw.slice(m.index + m[0].length).replace(/^\n+/, '').slice(0, MAX_BODY),
  };
}

/**
 * `{ repo, templates: [...], commands: [...] }` for one user's enabled
 * sources. Each entry: `{ id, family, name, description, surface, body,
 * sourceId, sourceName }`.
 *
 * `id` is `<family>/<file-stem>` — the same `<family>/<name>` shape skill ids
 * use, so one id format covers every kind of kit entry.
 *
 * First enabled source wins on an id collision, matching `listSkillLibrary`:
 * a user's own source can shadow a builtin entry, which is the point of
 * being able to register one.
 */
export function listGenerationLibrary(userId) {
  seedBuiltinOnce(userId);
  const enabled = new Set(listEnabled(userId));
  const sources = listSources(userId).filter((s) => enabled.has(s.id));
  const out = { repo: null, templates: [], commands: [] };
  const seen = new Set();

  for (const src of sources) {
    const snap = snapshotSource(src);
    if (!snap?.location) continue;
    if (src.id === BUILTIN_ID) out.repo = snap.location;
    for (const [family, key] of Object.entries(GENERATION_FAMILIES)) {
      let entries;
      try { entries = readdirSync(join(snap.location, family), { withFileTypes: true }); }
      catch { continue; }   // a source need not carry every family
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        // README.md documents the family for humans; it is not an entry.
        if (e.name.toLowerCase() === 'readme.md') continue;
        const id = `${family}/${e.name.slice(0, -3)}`;
        if (seen.has(id)) continue;
        const path = join(snap.location, family, e.name);
        let parsed = null;
        try { parsed = parseEntry(readFileSync(path, 'utf8')); } catch { /* unreadable → skip */ }
        if (!parsed) continue;   // no frontmatter name → not an entry
        seen.add(id);
        out[key].push({
          id, family, ...parsed, path,
          sourceId: src.id, sourceName: src.name ?? src.id,
        });
      }
    }
  }
  for (const key of Object.values(GENERATION_FAMILIES)) {
    out[key].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
