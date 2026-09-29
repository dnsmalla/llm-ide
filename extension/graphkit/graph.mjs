// Code-graph query API — the one place agents go to ask "which code is
// related to X". Wraps the KB's FTS-backed findContext and applies the
// graph-side hygiene (file-level rollup, traversal-safe refs) that every
// consumer previously re-implemented.

import path from 'node:path';
import {
  findContext, userRepoAllowlist, findCodeSymbolIds, expandSymbols, hydrateSymbols,
  searchCodeSymbols, searchCodeSymbolsByTerms, graphNeighbors, hasCodeGraph, CONTAINS_EDGE_KIND,
} from '../kb/db.mjs';

/** Repo allow-list for a user, never throwing — graph queries must not
 *  crash if the allow-list read fails; they just lose absolute refs. */
function safeAllowlist(userId) {
  try { return userRepoAllowlist(userId) || []; }
  catch { return []; }
}

/** True when an absolute ref lives under one of the user's allow-listed
 *  repo roots. `..` is rejected separately, so a prefix test is sound. */
function refUnderAllowedRoot(ref, roots) {
  for (const root of roots) {
    if (!root) continue;
    const base = root.endsWith(path.sep) ? root : root + path.sep;
    if (ref === root || ref.startsWith(base)) return true;
  }
  return false;
}

/**
 * Roll FTS chunk hits up to one entry per file, keeping the best
 * chunk's snippet, and drop refs that look like path-traversal attempts
 * — those could have been introduced by a malicious KB ingest and would
 * otherwise be forwarded to Claude and then to codegen-apply's file
 * reader.
 *
 * Absolute refs (how local-repo code is ingested — `connectors/git.mjs`
 * stores `ref: <absPath>`) are kept ONLY when they live under a repo the
 * user has explicitly added to their allow-list. That restores local-repo
 * code visibility to the agent while still refusing an arbitrary absolute
 * path a malicious KB row might smuggle to codegen's file reader.
 */
export function rollupCodeRefs(rows, allowedRoots = []) {
  const roots = (allowedRoots || []).filter(Boolean);
  const byRef = new Map();
  for (const r of rows || []) {
    const ref = r.ref || r.title?.split(':')[0] || '';
    if (!ref) continue;
    if (ref.includes('..')) continue; // path traversal — always reject
    if (ref.startsWith('/') && !refUnderAllowedRoot(ref, roots)) continue;
    if (!byRef.has(ref)) {
      byRef.set(ref, {
        ref,
        title: r.title,
        bodyExcerpt: (r.body || '').slice(0, 240),
        rank: r.rank,
      });
    }
  }
  return [...byRef.values()];
}

/**
 * Query the code graph for files related to a free-form query.
 * Returns up to `limit` rolled-up file references, best match first.
 */
export function findRelatedCode(userId, query, limit = 5) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return [];
  const ctx = findContext(userId, q, limit * 2);
  return rollupCodeRefs(ctx.code, safeAllowlist(userId)).slice(0, limit);
}

/**
 * Full grounding context (meetings, tasks, code, tickets, blockers)
 * for planners that want more than code refs. Thin passthrough so
 * graph consumers don't import kb/db directly.
 */
export function findGraphContext(userId, query, limit = 5, opts = {}) {
  return findContext(userId, query, limit, opts);
}

// Words with no retrieval signal in a question about code: articles, question
// words, auxiliaries, and generic verbs/nouns that match hundreds of symbols
// ("handle", "file", "code"). Probed first, they would fill the seed cap before
// a meaningful token (e.g. "Button") is tried; scored, they drown the question's
// distinctive words.
const SEED_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into',
  'fix', 'component', 'this', 'that', 'these', 'those', 'it', 'its', 'there', 'here',
  'where', 'what', 'which', 'who', 'when', 'why', 'how',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'may', 'might',
  'get', 'gets', 'set', 'sets', 'use', 'used', 'uses', 'using', 'make', 'makes',
  'call', 'calls', 'called', 'calling', 'handle', 'handles', 'handled', 'handling',
  'decide', 'decides', 'decided', 'happen', 'happens', 'work', 'works',
  'code', 'file', 'files', 'function', 'functions', 'method', 'methods', 'thing', 'way',
]);

// Inflection suffixes, longest first; a stem keeps at least 4 chars.
const STEM_SUFFIXES = [['ies', 'y'], ['ing', ''], ['ed', ''], ['es', ''], ['s', '']];

/** Light, case-preserving stemming: `rotated`→`rotat`, `retries`→`retry`, so a
 *  question's inflected word still substring-matches the identifier. */
export function stemToken(word) {
  const w = String(word);
  const lower = w.toLowerCase();
  for (const [suffix, replacement] of STEM_SUFFIXES) {
    if (lower.endsWith(suffix) && w.length - suffix.length + replacement.length >= 4) {
      return w.slice(0, w.length - suffix.length) + replacement;
    }
  }
  return w;
}

/** Content terms of a question: filler dropped, stemmed, deduped
 *  case-insensitively, original order and case kept. A compound word
 *  (`find-code`, `tool-events.mjs`) is also kept whole, unstemmed — it names a
 *  file or tool far more precisely than its parts, one of which may be filler. */
export function queryTerms(query) {
  const seen = new Set();
  const out = [];
  const add = (term) => {
    const key = term.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(term); }
  };
  for (const word of String(query).split(/\s+/)) {
    const trimmed = word.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '');
    if (/[-.]/.test(trimmed) && trimmed.length >= 3) add(trimmed);
    for (const raw of trimmed.split(/[^A-Za-z0-9_]+/)) {
      if (raw.length < 3 || SEED_STOP_WORDS.has(raw.toLowerCase())) continue;
      add(stemToken(raw));
    }
  }
  return out;
}

// Hard ceiling on how many probes one query may run. Each candidate is a
// separate leading-% LIKE over code_graph_nodes, which cannot use the
// (user_id, title) index and therefore scans — synchronously, on the server's
// only thread (better-sqlite3). An uncapped split of a 256-char question would
// fire ~30 of those before concluding "no match" and stall the event loop for
// every other request. Probes are ordered whole-query-then-longest-token, so
// the truncated tail is the least selective part of the query.
const MAX_SEED_CANDIDATES = 6;

/**
 * Query tokens for graph seeding: the whole query first (so an exact symbol
 * name wins), then its useful tokens longest-first, capped at
 * MAX_SEED_CANDIDATES. findRelatedSymbols probes these one by one;
 * searchCodeIndex scores queryTerms together instead. Exported for unit tests.
 */
export function seedCandidates(query) {
  const tokens = queryTerms(query).sort((a, b) => b.length - a.length);
  return [...new Set([String(query).trim(), ...tokens])]
    .filter(Boolean)
    .slice(0, MAX_SEED_CANDIDATES);
}

// Human-readable relationship labels, per edge kind and direction. The agent
// needs to know WHY a symbol came back — "called by handleCodeAssist" is
// actionable, a bare symbol id is not.
const RELATION_LABELS = {
  calls:      { out: 'calls',           in: 'called by' },
  imports:    { out: 'imports',         in: 'imported by' },
  contains:   { out: 'declares',        in: 'declared in' },
  references: { out: 'references',      in: 'referenced by' },
  implements: { out: 'implements',      in: 'implemented by' },
  inherits:   { out: 'inherits from',   in: 'inherited by' },
};

export function relationLabel(viaKind, direction) {
  return RELATION_LABELS[viaKind]?.[direction] || `${viaKind} (${direction})`;
}

/** A file node's id is `file:<relpath>` (StructureGraphBuilder) — file seeds
 *  want the file→symbol `contains` hop, symbol seeds do not (it would return
 *  every sibling symbol in the same file). */
function isFileNode(row) {
  return row?.kind === 'file' || row?.kind === 'docPage'
    || String(row?.symbol_id || '').startsWith('file:');
}

// Candidate rows fetched by the multi-term lookup before re-ranking: enough
// that demoting tests and docs still leaves real code to promote.
const TERM_PROBE_LIMIT = 60;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|[A-Za-z]*Tests)\/|\.(test|spec)\.[a-z0-9]+$|Tests?\.swift$/;

/**
 * One seed's rank. An exact title match of the whole query is decisive (the
 * caller typed a symbol name); otherwise the multi-term score, compounded when
 * several terms agree. Tests and docs are demoted so they never outrank the
 * code they describe — they still come back when nothing else matches.
 */
function seedRank(row) {
  if (row.tier === 0) return 1e6;
  let rank = (Number(row.score) || 0) * (1 + 0.25 * Math.max(0, (Number(row.matched) || 0) - 1));
  if (row.tier === 1) rank += 0.5;
  const file = String(row.source_file || '');
  if (TEST_PATH.test(file)) rank *= 0.5;
  if (row.kind === 'docPage' || row.kind === 'heading' || /\.md$/i.test(file)) rank *= 0.6;
  return rank;
}

/**
 * The index→graph code search behind the agent's `find-code` tool: ONE call
 * that replaces a grep-and-read-whole-files loop.
 *
 * Three stages, cheapest and most precise first:
 *
 *   1. SYMBOL INDEX — ranked title lookup over `code_graph_nodes`
 *      (searchCodeSymbols). Answers "where is X defined" with file:line.
 *   2. GRAPH — bidirectional, edge-labelled traversal from those seeds
 *      (graphNeighbors), so the caller also gets callers/callees/importers and
 *      WHY each one is related. File seeds additionally follow `contains`, which
 *      turns "what's in FileDetailView.swift" into a symbol outline.
 *   3. TEXT INDEX — the FTS-backed per-file rollup (findRelatedCode) for hits
 *      the symbol graph can't have: matches in comments, strings, error
 *      messages, and files in repos whose graph hasn't been generated.
 *
 * Stage 3 always runs rather than only-on-empty: the symbol graph and the text
 * index fail in different ways (a symbol whose name doesn't contain the query
 * text; a repo with no graph), and the whole point is for the agent to need one
 * round-trip, not two. Every stage is independently bounded, so a miss in one
 * costs nothing.
 *
 * Returns plain data; path resolution against the agent's readable roots is the
 * caller's job (see llm_agent/runtime/handlers/find-code.mjs).
 */
export function searchCodeIndex(userId, query, { limit = 8, hops = 1, repoIds = null } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  const empty = { query: q, symbols: [], related: [], files: [], indexPresent: false };
  if (!q) return empty;

  const seedLimit = Math.max(1, Math.min(20, limit));
  const relatedLimit = Math.max(1, Math.min(24, seedLimit * 3));

  // ── Stage 1: symbol index ────────────────────────────────────────────────
  // Two lookups. The whole query as one string, so an exact symbol name
  // ("graphNeighbors") puts its definition first. Then the question's content
  // terms scored together — rarity-weighted coverage over title, file path and
  // doc — so "where is the mobile pairing PIN rotated" finds `rotateInMemory`
  // in MobilePin.swift. Probing each word alone (the previous scheme) ranked by
  // match tier and title length, and a short incidental substring hit of a
  // generic word ("server", "report", "runner") beat the symbol that matched
  // the question's distinctive words.
  const byId = new Map();
  for (const row of searchCodeSymbols(userId, q, seedLimit, { repoIds })) {
    byId.set(row.symbol_id, { ...row, score: 0, matched: 0 });
  }
  // An exact title match means the caller typed a name: answer that name and
  // leave its neighbourhood to stage 2, rather than seeding every symbol that
  // shares a word with it (`gutter.ts` would pull in `renderGutter` as a seed
  // instead of listing it as what the file declares).
  const exactName = [...byId.values()].some((r) => r.tier === 0);
  const terms = exactName ? [] : queryTerms(q);
  const termRows = exactName ? []
    : searchCodeSymbolsByTerms(userId, terms.length ? terms : [q], TERM_PROBE_LIMIT, { repoIds });
  for (const row of termRows) {
    const prev = byId.get(row.symbol_id);
    byId.set(row.symbol_id, prev ? { ...prev, score: row.score, matched: row.matched } : { ...row, tier: 3 });
  }
  const seeds = [...byId.values()]
    .map((row) => ({ row, rank: seedRank(row) }))
    .sort((a, b) => (b.rank - a.rank)
      || ((a.row.title || '').length - (b.row.title || '').length)
      || String(a.row.title).localeCompare(String(b.row.title)))
    .slice(0, seedLimit)
    .map((x) => x.row);

  // ── Stage 2: graph expansion ─────────────────────────────────────────────
  // File seeds and symbol seeds need different edge sets, so they're traversed
  // as two groups rather than one flat call.
  const related = [];
  const relatedSeen = new Set(seeds.map((s) => s.symbol_id));
  if (seeds.length > 0 && hops > 0) {
    const fileSeeds = seeds.filter(isFileNode).map((s) => s.symbol_id);
    const symbolSeeds = seeds.filter((s) => !isFileNode(s)).map((s) => s.symbol_id);
    // Over-fetch, then cap AFTER hydration. graphNeighbors' limit counts EDGES,
    // and an edge is not necessarily a usable result: a SCIP index can carry
    // edges to symbols it never emitted a node for, and a node can have a blank
    // source_file (nothing to show the agent). Capping at the edge layer let
    // those consume the entire budget and hand back an empty `related` while
    // real neighbours sat one row further down.
    const fetchLimit = Math.min(relatedLimit * 4, 200);
    const hits = [];
    if (symbolSeeds.length > 0) {
      hits.push(...graphNeighbors(userId, symbolSeeds, { hops, limit: fetchLimit, repoIds }));
    }
    if (fileSeeds.length > 0) {
      hits.push(...graphNeighbors(userId, fileSeeds, {
        hops,
        limit: fetchLimit,
        repoIds,
        edgeKinds: [CONTAINS_EDGE_KIND, 'imports'],
      }));
    }
    // Hydrate in one query, then re-attach each neighbour's relationship.
    const rows = new Map(
      hydrateSymbols(userId, [...new Set(hits.map((h) => h.symbolId))], { repoIds }).map((r) => [r.symbol_id, r]),
    );
    for (const hit of hits) {
      if (relatedSeen.has(hit.symbolId)) continue;
      const row = rows.get(hit.symbolId);
      if (!row) continue;                       // dangling edge — skip silently
      if (!row.source_file) continue;           // nowhere to point the agent
      relatedSeen.add(hit.symbolId);
      related.push({
        ...row,
        relation: relationLabel(hit.viaKind, hit.direction)
          + (hit.confidence === 'INFERRED' ? ' (inferred)' : ''),
        viaKind: hit.viaKind,
        direction: hit.direction,
        hop: hit.hop,
        fromId: hit.fromId,
      });
      if (related.length >= relatedLimit) break;
    }

    // Fallback: FILE-level relatedness for symbol seeds that got nothing.
    //
    // Symbol→symbol `calls` edges may be absent: the regex extractor that
    // handles Swift/JS/TS only emits them as INFERRED guesses (graph-kit's
    // inferred edges), and older graphs have none at all, so a function seed's
    // neighbour set can still come back empty and the graph looks dead even
    // though it isn't: the file→file `imports` edges are there.
    //
    // Use them. The seed's containing file, plus the files that IMPORT that
    // file, is the blast radius of changing that symbol at file granularity —
    // coarser than a call graph, but the honest answer today and far better
    // than nothing. Labelled distinctly (`declared in`, `file imported by`) so
    // the agent never mistakes it for a real call edge, and only used when the
    // symbol-level pass found nothing, so a repo WITH call edges is never
    // diluted by it.
    if (related.length === 0 && symbolSeeds.length > 0) {
      const fileIds = [...new Set(
        seeds.filter((s) => !isFileNode(s) && s.source_file).map((s) => `file:${s.source_file}`),
      )];
      if (fileIds.length > 0) {
        const importers = graphNeighbors(userId, fileIds, {
          hops: 1,
          direction: 'in',
          repoIds,
          edgeKinds: ['imports'],
          limit: Math.min(relatedLimit * 4, 200),   // same over-fetch as above
        });
        const ids = [...new Set([...fileIds, ...importers.map((h) => h.symbolId)])];
        const rows = new Map(hydrateSymbols(userId, ids, { repoIds }).map((r) => [r.symbol_id, r]));
        for (const id of fileIds) {
          const row = rows.get(id);
          if (row && !relatedSeen.has(id)) {
            relatedSeen.add(id);
            related.push({ ...row, relation: 'declared in', viaKind: CONTAINS_EDGE_KIND, direction: 'in', hop: 1 });
          }
        }
        for (const hit of importers) {
          const row = rows.get(hit.symbolId);
          if (!row || !row.source_file || relatedSeen.has(hit.symbolId)) continue;
          relatedSeen.add(hit.symbolId);
          related.push({ ...row, relation: 'file imported by', viaKind: 'imports', direction: 'in', hop: hit.hop });
          if (related.length >= relatedLimit) break;
        }
      }
    }
  }

  // ── Stage 3: text index ──────────────────────────────────────────────────
  const files = findRelatedCode(userId, q, seedLimit);

  return {
    query: q,
    symbols: seeds,
    related,
    files,
    // Whether a graph EXISTS for this user, independent of whether this query
    // matched anything in it. The agent should fall back to grep-everything only
    // when there is genuinely no index; on a miss against a real index the right
    // move is a narrower query. Deriving this from the result set would collapse
    // those two cases into one wrong answer (see hasCodeGraph).
    indexPresent: hasCodeGraph(userId),
  };
}

export function findRelatedSymbols(userId, query, { hops = 1, limit = 10 } = {}) {
  if (!query) return [];
  const candidates = seedCandidates(query);
  const seedSet = new Set();
  for (const q of candidates) {
    for (const id of findCodeSymbolIds(userId, q, limit)) seedSet.add(id);
    if (seedSet.size >= limit) break;
  }
  const seeds = [...seedSet].slice(0, limit);
  if (seeds.length === 0) return [];
  const expanded = expandSymbols(userId, seeds, { hops });
  const ids = [...new Set([...seeds, ...expanded])];
  // Cap the hydrated result so a hub seed (one symbol referenced by many) can't
  // blow past `limit` after expand.
  return hydrateSymbols(userId, ids).slice(0, limit);
}
