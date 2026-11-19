// Checks remembered facts against the code, with no model call (LLM usage review 2026-11-19). Project memory is
// never auto-pruned, so a fact about a file that has since been deleted or moved stays and keeps steering answers.
// Many facts cite files; when EVERY file a fact cites is gone, the fact is probably outdated. Such a fact is ranked
// last and labelled in the prompt (graphkit/memory.mjs) and flagged in the memory viewer, where the user decides.
// Conservative on purpose: a fact with no path, or with at least one path that still exists ("moved from old/a.ts
// to new/b.ts"), is never flagged. Paths are only ever checked inside the project; nothing is read or written.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { projectRootOf } from './paths.mjs';

const MAX_PATHS_PER_FACT = 8;
// A path as facts write it: at least one slash and a file extension (so "client/server" or "and/or" is not a path),
// optionally followed by :line. URLs are removed first.
const PATH_RE = /(?:^|[\s`'"([<])((?:\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\.[A-Za-z][\w]{0,7})(?::\d+(?:-\d+)?)?(?=$|[\s`'"),.;:\]>])/g;

/** The file paths a fact cites (relative, no `..`), in order, without duplicates. Pure. */
export function citedPaths(fact) {
  const text = String(fact ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const out = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (p.startsWith('/') || p.split('/').includes('..')) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_PATHS_PER_FACT) break;
  }
  return out;
}

/** Where a cited path may live: the root given, its project, and each repo under the project's code/ folder. */
function searchRoots(root) {
  const r = resolve(root);
  const project = projectRootOf(r);
  const roots = [r, project];
  try {
    for (const d of readdirSync(join(project, 'code'), { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) roots.push(join(project, 'code', d.name));
    }
  } catch { /* no code/ folder */ }
  return [...new Set(roots)];
}

/**
 * A checker for one root: `isStale(fact)` is true when the fact cites at least one path and none of them exists
 * under the project. Existence results are cached for the checker's life (one prompt render or one viewer load).
 */
export function staleFactChecker(root) {
  if (typeof root !== 'string' || !root) return () => false;
  const roots = searchRoots(root);
  const seen = new Map();
  const exists = (rel) => {
    if (seen.has(rel)) return seen.get(rel);
    const found = roots.some((base) => {
      const abs = resolve(base, rel);
      return (abs === base || abs.startsWith(base + sep)) && existsSync(abs);
    });
    seen.set(rel, found);
    return found;
  };
  return (fact) => {
    const paths = citedPaths(fact);
    return paths.length > 0 && !paths.some(exists);
  };
}

/** The label added to a stale fact where the model reads it. */
export const STALE_NOTE = ' (may be outdated: every file this cites is gone — check before relying on it)';
