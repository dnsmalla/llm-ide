// `find-code` — the agent's index→graph code search, and the reason the Code
// Assistant no longer has to grep its way around a repo.
//
// WHY THIS EXISTS (cost):
// The agent had no access to the code graph at all. Its only code tools were
// list-files, whole-file read-file, and run-bash — so "why is the line number
// wrong in FileDetailView" became a dozen `grep -rn` / `sed -n` shell round
// trips, each one a full model turn with the previous output still in context.
// The graph and the FTS index already knew the answer (`file:line` for every
// symbol, plus who calls/imports it); nothing exposed them to the loop.
//
// This handler exposes them as ONE call:
//   1. symbol index  → where is it defined (file:line)
//   2. graph         → what is related, and HOW (calls / called by / imports /
//                      imported by / declares)
//   3. text index    → FTS hits for what the symbol graph can't hold
//                      (comments, strings, error text, ungraphed repos)
// The staged query itself lives in graphkit (searchCodeIndex) — the graph layer
// owns graph semantics. This module owns the AGENT-facing contract: argument
// validation, resolving graph paths to something `read-file` can actually open,
// fence redaction, and a hard cap on payload size so a hub symbol can't blow
// the context budget it exists to protect.
//
// Read-only and side-effect free: safe in the plan/review/document tool
// allowlist (mode-personas.mjs).

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { searchCodeIndex } from '../../../graphkit/index.mjs';
import { expandTilde } from '../../../graphkit/memory.mjs';
import { redactFence } from '../redaction.mjs';

const MAX_QUERY_CHARS = 256;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_HOPS = 2;
// Excerpt cap per FTS hit. The point of this tool is to spend a few hundred
// tokens instead of a few thousand on a whole-file read, so the excerpt has to
// stay a hint — enough to judge relevance, never a substitute for read-file.
const MAX_EXCERPT_CHARS = 200;

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function canonical(p) {
  if (typeof p !== 'string' || !p) return '';
  const expanded = expandTilde(p);
  try { return realpathSync(expanded); } catch { return expanded; }
}

function samePath(a, b) {
  if (!a || !b) return false;
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Readable roots, with the OPEN WORKSPACE first.
 *
 * Root order decides which checkout a relative path resolves to, and
 * buildReadableRoots puts the DB allow-list ahead of the workspace. Two things
 * went wrong with that order:
 *  - A path that exists in BOTH an allow-listed clone and the open workspace
 *    silently resolved to the clone — `exists: true`, no warning, stale code.
 *  - `run-bash` runs in the WORKSPACE root, so the `sed -n '<range>' <path>`
 *    follow-up this tool tells the agent to make would run against the wrong
 *    tree (or fail outright) whenever resolution landed elsewhere.
 * The workspace is where the user is actually working, so it wins. Exported for
 * unit tests.
 */
export function orderRoots(roots = [], workspaceRoot = '') {
  const ws = canonical(workspaceRoot);
  if (!ws) return [...roots];
  const inList = roots.filter((r) => samePath(canonical(r), ws));
  // Only honour a workspace root that already passed buildReadableRoots'
  // validation — never widen the readable set from here.
  if (inList.length === 0) return [...roots];
  return [...inList, ...roots.filter((r) => !samePath(canonical(r), ws))];
}

/**
 * Turn a graph/FTS path into one `read-file` can open, preferring the
 * repo-relative form.
 *
 * Two problems this solves:
 *  - Graph rows carry `repo_id` from whichever clone was INDEXED. That is
 *    routinely not the workspace the user has open (a second checkout, a moved
 *    directory), and read-file only reads within the current readable roots —
 *    so an absolute `repo_id + source_file` path would 404 even though the file
 *    is right there. The relative path resolves against every root, so it keeps
 *    working across clones.
 *  - FTS code refs are stored absolute (connectors/git.mjs), so those get
 *    stripped back to repo-relative when they fall inside a readable root.
 *
 * `exists` is reported rather than used to filter: a graph that is slightly
 * ahead of (or behind) disk should still tell the agent what it knows, but the
 * agent must be able to see that a path is unverified before quoting it.
 * `outsideWorkspace` marks a path that resolved in some OTHER readable root, so
 * neither the agent nor the user mistakes it for the code they have open.
 */
export function resolveAgentPath(rawPath, roots = [], workspaceRoot = '') {
  const p = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!p) return null;
  if (p.split(/[/\\]/).includes('..')) return null;   // never emit a traversal

  const ordered = orderRoots(roots, workspaceRoot);
  const ws = canonical(workspaceRoot);
  const flagFor = (root) => (ws && !samePath(canonical(root), ws) ? { outsideWorkspace: true } : {});

  if (isAbsolute(p)) {
    for (const root of ordered) {
      const withSep = root.endsWith(sep) ? root : root + sep;
      if (p === root || p.startsWith(withSep)) {
        return { path: relative(root, p) || p, exists: existsSync(p), ...flagFor(root) };
      }
    }
    // Absolute and outside every readable root: not something the agent may
    // read, so don't advertise it.
    return null;
  }

  for (const root of ordered) {
    if (existsSync(join(root, p))) return { path: p, exists: true, ...flagFor(root) };
  }
  return { path: p, exists: false };
}

/** Compact one symbol/graph row into the agent-facing shape. */
function shapeSymbol(row, roots, workspaceRoot, extra = {}) {
  const resolved = resolveAgentPath(row.source_file, roots, workspaceRoot);
  if (!resolved) return null;
  const out = {
    name: redactFence(row.title || ''),
    kind: redactFence(row.kind || 'symbol'),
    path: resolved.path,
    line: Number(row.line) || 0,
    ...extra,
  };
  // Only ever mention the negative cases — an `exists: true` on every row is
  // pure token overhead.
  if (!resolved.exists) out.unverifiedPath = true;
  if (resolved.outsideWorkspace) out.outsideWorkspace = true;
  return out;
}

/**
 * find-code handler.
 *
 * @param args.query  free text: a symbol name, a feature, an error string
 * @param args.limit  results per section (1..20, default 8)
 * @param args.hops   graph hops from each seed (0..2, default 1)
 * @param ctx.userId         tenancy — required
 * @param ctx.roots          readable roots from buildReadableRoots (same gate read-file uses)
 * @param ctx.workspaceRoot  the open workspace, preferred when a relative path
 *                           exists in more than one root — also the cwd run-bash
 *                           will use for the follow-up read
 */
export function handleFindCode(args, ctx) {
  const query = typeof args?.query === 'string' ? args.query.trim().slice(0, MAX_QUERY_CHARS) : '';
  if (!query) return { error: 'query is required' };
  if (!ctx?.userId) return { error: 'not signed in' };

  const limit = clampInt(args?.limit, { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
  const hops = clampInt(args?.hops, { min: 0, max: MAX_HOPS, fallback: 1 });
  const roots = Array.isArray(ctx.roots) ? ctx.roots : [];
  const workspaceRoot = typeof ctx.workspaceRoot === 'string' ? ctx.workspaceRoot : '';

  let result;
  try {
    result = searchCodeIndex(ctx.userId, query, { limit, hops });
  } catch (err) {
    // A missing/locked graph table must degrade to "no index", never break the
    // turn — the agent still has list-files/read-file/run-bash.
    return { error: `code index unavailable: ${redactFence(String(err?.message || err))}` };
  }

  const symbols = result.symbols.map((r) => shapeSymbol(r, roots, workspaceRoot)).filter(Boolean);
  const related = result.related
    .map((r) => shapeSymbol(r, roots, workspaceRoot, { relation: redactFence(r.relation || '') }))
    .filter(Boolean);
  const files = result.files
    .map((f) => {
      const resolved = resolveAgentPath(f.ref, roots, workspaceRoot);
      if (!resolved) return null;
      const out = {
        path: resolved.path,
        excerpt: redactFence((f.bodyExcerpt || '').slice(0, MAX_EXCERPT_CHARS)),
      };
      if (resolved.outsideWorkspace) out.outsideWorkspace = true;
      return out;
    })
    .filter(Boolean);

  return {
    query,
    symbols,
    related,
    files,
    // The agent's decision hint, stated once here instead of trusting it to
    // re-derive the policy from the skill doc every turn. Three distinct empty
    // cases, because they need three different responses — conflating them is
    // how a user with a perfectly good index gets told to go generate one.
    hint: buildHint({ result, symbols, related, files }),
  };
}

function buildHint({ result, symbols, related, files }) {
  const found = symbols.length > 0 || related.length > 0 || files.length > 0;
  if (found) {
    return 'Read only the ranges you need: read-file on a listed path, or run-bash sed -n on the given line (paths are relative to the workspace root, which is run-bash\'s cwd).';
  }
  // Matched in the index, but every hit fell outside what the agent may read —
  // an unopened workspace or an unregistered repo, NOT a bad query.
  //
  // Judged on the GRAPH hits only. FTS file refs are stored absolute, so a repo
  // that isn't currently a readable root drops them routinely — including for
  // loose keyword matches on a query that genuinely found nothing. Counting
  // those made "no such symbol" report itself as a workspace problem.
  const filteredOut = result.symbols.length > 0 || result.related.length > 0;
  if (filteredOut) {
    return 'The index matched, but those files are outside the readable workspace — ask the user to open the project folder or add the repo, or search a path they have open.';
  }
  if (!result.indexPresent) {
    return 'This project has no code index yet (generate the graph in the Mac app). Fall back to run-bash grep.';
  }
  return 'No match in the index. Refine the query to a single symbol or filename, or fall back to run-bash grep.';
}
