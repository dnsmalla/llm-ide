// The `templates/` and `commands/` families of the enabled LLM sources, for
// the Mac app's Doc Gen and Visual menus.
//
// Separate from `skill-library.mjs` on purpose. That module answers "which
// SKILL.md can the chat attach?" and its families are directories
// (`<family>/<dir>/SKILL.md`). These two families are one `.md` per entry,
// grouped by surface (`<family>/<doc|vis>/<entry>.md`), and they are not
// skills at all: a template is document structure, a command is a reusable
// instruction. Folding them into the skill catalog would have meant a second
// entry shape inside one list and a `kind` field on every row to tell them
// apart.
//
// Why this exists at all: the Mac app used to carry its default templates and
// commands as Swift constants, so adding one meant an app change and a
// release. They live in the kit now, and this is how they reach the app.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

import { listSources, snapshotSource, BUILTIN_ID, seedBuiltinOnce } from '../../llm-sources/registry.mjs';
import { listEnabled } from '../../llm-sources/state.mjs';

/** The `.md` families this module surfaces, and the wire key each lands under. */
const GENERATION_FAMILIES = { templates: 'templates', commands: 'commands' };

/**
 * Surface folders inside a family, and the surface each names.
 *
 * The kit splits `templates/` and `commands/` into `doc/` and `vis/`, and the
 * FOLDER is the surface — there is no `surface:` frontmatter in a file that
 * lives in one. Two sources of truth is exactly what this replaces: a file
 * moved between folders without its frontmatter being updated used to keep
 * showing up in the menu it had left.
 *
 * `visual/` is accepted alongside `vis/` because a third-party source may
 * reasonably spell it the way the wire value is spelled.
 */
const SURFACE_DIRS = { doc: 'doc', vis: 'visual', visual: 'visual' };

const MAX_DESC = 200;
/** A template/command body is prose, not a program — this is a sanity bound. */
const MAX_BODY = 20_000;

/**
 * Surfaces an entry can land on. `doc` is the default and the meaning of
 * every entry written before surfaces existed; an UNRECOGNISED value degrades
 * to `doc` rather than hiding the file from every menu, because a typo should
 * not lose someone's template.
 */
const SURFACES = new Set(['doc', 'visual']);
export const DEFAULT_SURFACE = 'doc';

export function normalizeSurface(value) {
  return typeof value === 'string' && SURFACES.has(value.trim()) ? value.trim() : DEFAULT_SURFACE;
}

/**
 * Parse one entry file: frontmatter (name, description) plus the body below
 * it, which is the template's sections or the command's instruction.
 *
 * Same frontmatter regex as the skill loader — closing `---` on its own line —
 * so a `---` inside a value cannot end the block early, and the same js-yaml
 * parser so a folded (`>`) description reads identically in both catalogs.
 *
 * The `surface` it reports is the file's own claim, which only matters for a
 * file loose at the family root: inside a surface folder the caller overrides
 * it with the folder's, because the folder is the source of truth.
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
 * Every generation entry under one source directory, as
 * `{ templates: [...], commands: [...] }` with no source/dedup fields yet.
 *
 * Exported so the folder rules below can be asserted against a throwaway tree
 * — the failure mode they guard is silent (an entry read with the wrong
 * surface simply appears in the other menu), so it needs a direct test rather
 * than only the real kit's shape.
 */
export function readGenerationFamilies(location) {
  const out = { templates: [], commands: [] };

  /**
   * Read one candidate file, or skip it.
   *
   * `surface` is the folder's when the file came from one, and `null` for a
   * loose file, which falls back to what its own frontmatter claims.
   */
  const collectFile = (dir, fileName, family, key, surface) => {
    if (!fileName.endsWith('.md')) return;
    // README.md documents the family for humans; it is not an entry. Skipped
    // by NAME because both family READMEs show a worked example in a fenced
    // block, which the frontmatter reader would otherwise read as an entry.
    if (fileName.toLowerCase() === 'readme.md') return;
    const path = join(dir, fileName);
    let parsed = null;
    try { parsed = parseEntry(readFileSync(path, 'utf8')); } catch { return; }  // unreadable → skip
    if (!parsed) return;   // no frontmatter name → not an entry
    out[key].push({
      // `<family>/<stem>` — the surface folder is deliberately NOT in the id.
      // The Mac app derives a project folder name and a stable template id
      // from this, so putting the surface in would rename every seeded folder
      // in every existing project and orphan the user's edits.
      id: `${family}/${fileName.slice(0, -3)}`,
      family,
      ...parsed,
      surface: surface ?? parsed.surface,
      path,
    });
  };

  for (const [family, key] of Object.entries(GENERATION_FAMILIES)) {
    const famDir = join(location, family);
    let entries;
    try { entries = readdirSync(famDir, { withFileTypes: true }); }
    catch { continue; }   // a source need not carry every family
    for (const e of entries) {
      // A surface folder (`doc/`, `vis/`) — its files take its surface, and
      // the folder WINS over any frontmatter left behind by a move.
      if (e.isDirectory()) {
        const surface = SURFACE_DIRS[e.name.toLowerCase()];
        // An unrecognised folder is NOT swept into `doc`: unlike a typo'd
        // frontmatter value, a stray directory here is as likely to be
        // scratch or vendor content as a mis-spelled surface, and walking it
        // would put arbitrary markdown in a user's menu.
        if (!surface) continue;
        const subDir = join(famDir, e.name);
        let sub;
        try { sub = readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
        for (const f of sub) {
          // One level only. Nesting below a surface folder has no meaning.
          if (!f.isFile()) continue;
          collectFile(subDir, f.name, family, key, surface);
        }
        continue;
      }
      // A loose `.md` at the family root: pre-split kits and third-party
      // sources that never adopted the folders, read by frontmatter.
      if (!e.isFile()) continue;
      collectFile(famDir, e.name, family, key, null);
    }
  }
  return out;
}

/**
 * `{ repo, templates: [...], commands: [...] }` for one user's enabled
 * sources. Each entry: `{ id, family, name, description, surface, body,
 * sourceId, sourceName }`.
 *
 * `id` is `<family>/<file-stem>` — the same `<family>/<name>` shape skill ids
 * use, so one id format covers every kind of kit entry. The surface FOLDER is
 * not part of it: see `readGenerationFamilies`.
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
    const found = readGenerationFamilies(snap.location);
    for (const key of Object.values(GENERATION_FAMILIES)) {
      for (const e of found[key]) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out[key].push({ ...e, sourceId: src.id, sourceName: src.name ?? src.id });
      }
    }
  }
  for (const key of Object.values(GENERATION_FAMILIES)) {
    out[key].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
