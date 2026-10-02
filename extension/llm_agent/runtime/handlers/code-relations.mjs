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
  callers: { direction: 'in', edgeKinds: ['calls'] },
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
    seeds = findSymbolsByTitle(ctx.userId, name, { repoIds })
      .filter((r) => !pathFilter || r.source_file === pathFilter || r.source_file.endsWith(`/${pathFilter}`))
      .slice(0, MAX_SEEDS);
  } catch (err) {
    return { error: `code graph unavailable: ${redactFence(String(err?.message || err))}` };
  }
  const symbol = seeds.map((r) => shapeSymbol(r, roots, workspaceRoot)).filter(Boolean);
  if (seeds.length === 0) {
    return {
      symbol: [], relation, results: [],
      hint: 'No symbol with exactly that name is in the code graph. Use find-code to locate it first, then pass its exact name (and `path` if several share it).',
    };
  }

  // impact also walks from each seed's FILE node: importers depend on the
  // file, not on one function inside it.
  const seedIds = seeds.map((r) => r.symbol_id);
  if (relation === 'impact') {
    for (const r of seeds) if (r.source_file) seedIds.push(`file:${r.source_file}`);
  }
  const hits = graphNeighbors(ctx.userId, [...new Set(seedIds)], {
    hops: depth, edgeKinds: spec.edgeKinds, direction: spec.direction, limit: MAX_RESULTS, repoIds,
  });
  const rows = new Map(hydrateSymbols(ctx.userId, hits.map((h) => h.symbolId), { repoIds }).map((r) => [r.symbol_id, r]));
  const results = hits
    .map((h) => {
      const row = rows.get(h.symbolId);
      if (!row) return null;
      return shapeSymbol(row, roots, workspaceRoot, {
        relation: LABELS[h.direction]?.[h.viaKind] || h.viaKind,
        hop: h.hop,
        ...(h.confidence && h.confidence !== 'EXTRACTED' ? { confidence: redactFence(String(h.confidence)) } : {}),
      });
    })
    .filter(Boolean)
    .sort((a, b) => a.hop - b.hop || a.path.localeCompare(b.path) || a.line - b.line);

  const stale = (() => {
    try { return staleGraphs(ctx.userId, repoIds, Number.isFinite(ctx.freshnessCacheMs) ? ctx.freshnessCacheMs : 30_000); }
    catch { return []; }
  })();
  const seedPaths = new Set(symbol.map((s) => s.path));
  const out = {
    symbol,
    relation,
    depth,
    results,
    ...(seeds.length > 1 ? { ambiguous: true } : {}),
    ...(hits.length >= MAX_RESULTS ? { truncated: true } : {}),
    ...(relation === 'impact'
      ? { affectedFiles: [...new Set(results.map((r) => r.path))].filter((p) => !seedPaths.has(p)).sort() }
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
