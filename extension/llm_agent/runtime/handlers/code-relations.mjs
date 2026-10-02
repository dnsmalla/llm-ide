// `code-relations` — the code graph's structural questions, answered exactly:
//   callers  who calls X (transitively, by hop)
//   callees  what X calls
//   impact   what is affected if X changes: callers, references, implementers
//            and subclasses, plus every file that imports X's file — the
//            blast radius a refactor has to check
// find-code answers "where is X and what is near it" in one mixed list; this
// is the follow-up once the agent knows the symbol. Read-only, side-effect
// free, and scoped/validated exactly like find-code (same repo scope, same
// path resolution, same stale-graph warning).

import {
  findSymbolsByTitle, graphNeighbors, hydrateSymbols, resolveRepoScope,
} from '../../../kb/db.mjs';
import { shapeSymbol, staleGraphs, STALE_HINT } from './find-code.mjs';
import { redactFence } from '../redaction.mjs';

const RELATIONS = {
  // `references` too: a SCIP graph has no `calls` edges at all, so without it
  // callers was always empty there.
  callers: { direction: 'in', edgeKinds: ['calls', 'references'] },
  callees: { direction: 'out', edgeKinds: ['calls'] },
  impact: { direction: 'in', edgeKinds: ['calls', 'references', 'implements', 'inherits', 'imports'] },
};
const LABELS = {
  in: { calls: 'called by', references: 'referenced by', implements: 'implemented by', inherits: 'inherited by', imports: 'imported by' },
  out: { calls: 'calls' },
};
const MAX_DEPTH = 3;
const MAX_RESULTS = 60;
const MAX_SEEDS = 8;
// Namesakes fetched before the `path` filter, so a common name (`render`,
// `init`) still finds the one asked for.
const MAX_CANDIDATES = 400;

// Does a graph row's file match the path the agent passed? Compared against
// the row's ABSOLUTE path (repo_id + source_file), so a workspace-relative
// path (`code/api/src/x.ts`) picks one repo while a repo-relative one
// (`src/x.ts`) still matches every repo that has it. Accepts `./x` and
// absolute paths too.
function pathMatches(row, wanted) {
  if (!wanted) return true;
  const abs = `${String(row.repo_id || '').replace(/[/\\]+$/, '')}/${String(row.source_file || '')}`;
  return abs === wanted || abs.endsWith(`/${wanted}`);
}
const repoName = (repoId) => String(repoId || '').split(/[/\\]/).filter(Boolean).pop() || '';

function clampDepth(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_DEPTH, n)) : 1;
}

/**
 * @param args.symbol    exact symbol name (a function/class/method title)
 * @param args.relation  'callers' | 'callees' | 'impact'
 * @param args.depth     hops to follow (1..3, default 1)
 * @param args.path      optional repo-relative file to disambiguate a shared name
 * @param ctx            same as find-code: { userId, roots, workspaceRoot, activeRepoRoot }
 */
export function handleCodeRelations(args, ctx) {
  if (!ctx?.userId) return { error: 'not signed in' };
  const name = typeof args?.symbol === 'string' ? args.symbol.trim().slice(0, 256) : '';
  if (!name) return { error: 'symbol is required' };
  const relation = typeof args?.relation === 'string' ? args.relation : '';
  const spec = RELATIONS[relation];
  if (!spec) return { error: 'relation must be one of: callers, callees, impact' };
  const depth = clampDepth(args?.depth);
  const pathFilter = typeof args?.path === 'string' ? args.path.trim().replace(/^\.\//, '') : '';
  const roots = Array.isArray(ctx.roots) ? ctx.roots : [];
  const workspaceRoot = typeof ctx.workspaceRoot === 'string' ? ctx.workspaceRoot : '';

  let repoIds;
  let seeds;
  try {
    repoIds = resolveRepoScope(ctx.userId, { activeRepoRoot: ctx.activeRepoRoot || '', workspaceRoot });
    seeds = findSymbolsByTitle(ctx.userId, name, { repoIds, limit: MAX_CANDIDATES })
      .filter((r) => pathMatches(r, pathFilter))
      .slice(0, MAX_SEEDS);
  } catch (err) {
    return { error: `code graph unavailable: ${redactFence(String(err?.message || err))}` };
  }
  const seedsMultiRepo = new Set(seeds.map((r) => r.repo_id)).size > 1;
  const symbol = seeds
    .map((r) => shapeSymbol(r, roots, workspaceRoot, seedsMultiRepo ? { repo: redactFence(repoName(r.repo_id)) } : {}))
    .filter(Boolean);
  if (seeds.length === 0) {
    return {
      symbol: [], relation, results: [],
      hint: 'No symbol with exactly that name is in the code graph. Use find-code to locate it first, then pass its exact name (and `path` if several share it).',
    };
  }

  // Walk each seed's OWN repo. Structure-graph ids carry no repo
  // (`file:src/index.ts`), so a traversal scoped to several repos at once
  // joined two repos' identically-named files and reported one repo's callers
  // as the other's. impact also starts from each seed's FILE node: importers
  // depend on the file, not on one function inside it.
  const byRepo = new Map();
  for (const r of seeds) {
    const ids = byRepo.get(r.repo_id) || [];
    ids.push(r.symbol_id);
    if (relation === 'impact' && r.source_file) ids.push(`file:${r.source_file}`);
    byRepo.set(r.repo_id, ids);
  }
  const found = [];
  for (const [repoId, ids] of byRepo) {
    const room = MAX_RESULTS - found.length;
    if (room <= 0) break;
    const hits = graphNeighbors(ctx.userId, [...new Set(ids)], {
      hops: depth, edgeKinds: spec.edgeKinds, direction: spec.direction, limit: room, repoIds: [repoId],
    });
    const rows = new Map(hydrateSymbols(ctx.userId, hits.map((h) => h.symbolId), { repoIds: [repoId] })
      .map((r) => [r.symbol_id, r]));
    for (const h of hits) if (rows.has(h.symbolId)) found.push({ hit: h, row: rows.get(h.symbolId), repoId });
  }
  const multiRepo = new Set([...seeds.map((r) => r.repo_id), ...found.map((f) => f.repoId)]).size > 1;
  const results = found
    .map(({ hit: h, row, repoId }) => shapeSymbol(row, roots, workspaceRoot, {
      relation: LABELS[h.direction]?.[h.viaKind] || h.viaKind,
      hop: h.hop,
      ...(multiRepo ? { repo: redactFence(repoName(repoId)) } : {}),
      ...(h.confidence && h.confidence !== 'EXTRACTED' ? { confidence: redactFence(String(h.confidence)) } : {}),
    }))
    .filter(Boolean)
    .sort((a, b) => a.hop - b.hop || a.path.localeCompare(b.path) || a.line - b.line);
  const hits = found;

  const stale = (() => {
    try { return staleGraphs(ctx.userId, repoIds, Number.isFinite(ctx.freshnessCacheMs) ? ctx.freshnessCacheMs : 30_000); }
    catch { return []; }
  })();
  const seedPaths = new Set(symbol.map((s) => (s.repo ? `${s.repo}/${s.path}` : s.path)));
  const out = {
    symbol,
    relation,
    depth,
    results,
    ...(seeds.length > 1 ? { ambiguous: true } : {}),
    ...(hits.length >= MAX_RESULTS ? { truncated: true } : {}),
    // Repo-qualified when several repos are involved: two repos' `src/index.ts`
    // are two files to check, and a seed's own path must not hide another
    // repo's file of the same name.
    ...(relation === 'impact'
      ? { affectedFiles: [...new Set(results.map((r) => (r.repo ? `${r.repo}/${r.path}` : r.path)))]
        .filter((p) => !seedPaths.has(p)).sort() }
      : {}),
    hint: [
      results.length === 0
        ? 'The graph has no such edges for this symbol. Call edges are inferred and can be missing — confirm with run-bash grep before concluding nothing depends on it.'
        : 'Edges marked `confidence: INFERRED` were resolved by name, not by the compiler — verify a surprising one with a narrow read.',
      seeds.length > 1 ? 'Several symbols share this name; pass `path` to pick one.' : '',
      stale.length ? STALE_HINT : '',
    ].filter(Boolean).join(' '),
    ...(stale.length ? { staleGraph: stale } : {}),
  };
  return out;
}
