# find-code Ranking v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise find-code's top-3 hit rate on natural-language questions (measured 2/10 on the real llm-ide repo) without growing its payload, and make the result measurable with a committed benchmark.

**Architecture:** (1) A read-only benchmark script builds a throwaway DB from a graph JSON (produced by the graph-kit scanner) plus the FTS index, runs a committed question set through `handleFindCode`, and prints hit@3 / hit-anywhere / payload per question. (2) `searchCodeIndex` seeding is rewritten: question/filler words are dropped, words are lightly stemmed (`rotated`→`rotat`, `retries`→`retry`), every content term is probed with a larger limit, and candidates are ranked by a score — rarity-weighted term coverage over title and file path, a tier bonus for exact/prefix title matches, and penalties for tests and docs — instead of tier-then-title-length.

**Tech Stack:** Node 20+ ESM, better-sqlite3, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-29-graph-as-contract-design.md` (success measures: "Golden-query suite: repo-scoped recall ≥ the fixture's expected hits, payload under budget"). Baseline: `.superpowers/token-measurement-2026-09-29.md` (local scratch): top-3 hit 2/10, answer anywhere 8/10, ~7.1–10.5k chars per question.

## Global Constraints

- Extension module boundaries ESLint-enforced at zero violations; `cd extension && npm run lint` passes; full `npm test` passes (run unsandboxed).
- Never write to the live DB `kb/data.db`; the benchmark uses its own temp DB only (`LLMIDE_DB_PATH` set before any kb import) and deletes it.
- No wire change; `SERVER_API_VERSION` untouched; `searchCodeIndex`'s return shape unchanged.
- Probing stays bounded: at most `MAX_SEED_CANDIDATES` (6) LIKE probes per query.
- Existing tests keep passing (`find-code.test.mjs`, `code-graph-repo-scope.test.mjs`, `retrieval-golden.test.mjs`); change an existing assertion only if the ruling below necessarily changes it, and name it.
- Conventional Commits, one concern per commit, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/find-code-ranking` off `main`.

---

### Task R1: retrieval benchmark

**Files:**
- Create: `extension/scripts/retrieval-bench.mjs`
- Create: `extension/scripts/retrieval-bench.questions.json`
- Modify: `extension/package.json` (script `bench:retrieval`)

**Interfaces:** `node scripts/retrieval-bench.mjs --graph <graph.json> --repo <abs repo path> [--json]` → prints a per-question table and a summary `{ questions, hitAt3, hitAnywhere, medianChars, totalChars }`; `--json` prints only the summary JSON (for comparisons).

- [ ] **Step 1: Questions file** — `extension/scripts/retrieval-bench.questions.json`:

```json
[
  { "q": "where is the mobile pairing PIN rotated", "files": ["MobilePin.swift", "MobileControlManager.swift"], "symbols": ["rotateInMemory", "MobilePin"] },
  { "q": "how does the Loop runner retry a failed stage", "files": ["LoopEngineRunner.swift"], "symbols": ["LoopEngineRunner"] },
  { "q": "what calls findGraphContext", "files": ["planner.mjs", "graph.mjs"], "symbols": ["findGraphContext", "generatePlan"] },
  { "q": "where is the code graph uploaded to the server", "files": ["CodeGraphUploadService.swift", "LlmIdeAPIClient+CodeGraph.swift"], "symbols": ["CodeGraphUploadService", "ingestCodeGraph"] },
  { "q": "how does codegen decide which files it may modify", "files": ["codegen.mjs", "codegen-apply.mjs"], "symbols": ["validate", "repoRelative", "isWithinAllowlist"] },
  { "q": "where are v2 chat tool calls recorded for the retrieval report", "files": ["agent-v2.mjs", "tool-events.mjs", "tool-accounting.mjs"], "symbols": ["recordToolEvents", "createToolAccounting"] },
  { "q": "how does find-code scope results to the open workspace", "files": ["code-graph.mjs", "find-code.mjs"], "symbols": ["resolveRepoScope", "workspaceRepoIds"] },
  { "q": "where does the Mac app decide the workspace root", "files": ["WorkspaceRoot.swift"], "symbols": ["WorkspaceRoot", "resolve", "pick"] },
  { "q": "how is the scan cache invalidated when the extractor changes", "files": ["ScanCache.swift"], "symbols": ["ScanCache", "currentVersion"] },
  { "q": "where is SIGPIPE handled for child process stdin", "files": ["RepoManager.swift", "GlabAuthSync.swift"], "symbols": [] }
]
```

- [ ] **Step 2: The script** — `extension/scripts/retrieval-bench.mjs`:

```js
#!/usr/bin/env node
// find-code retrieval benchmark (read-only; never touches the live DB).
//
//   npm run bench:retrieval -- --graph <graph.json> --repo <abs repo path> [--json]
//
// <graph.json> is a code graph in the Mac upload's wire shape
// ({ nodes:[{id,title,kind,metadata:{source_file,line,language,doc}}], edges:[{fromId,toId,kind,confidence}] })
// — produce it with the graph-kit scanner over <repo>. The script builds a
// throwaway DB in the temp dir (graph + FTS index), runs every question in
// retrieval-bench.questions.json through find-code, and reports:
//   hit@3        a top-3 symbol's title is an expected symbol, or its file is an expected file
//   hitAnywhere  an expected file/symbol appears anywhere in the result (symbols, related, files)
//   chars        the JSON payload the model would receive
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const graphPath = arg('--graph');
const repo = arg('--repo') && path.resolve(arg('--repo'));
const jsonOnly = process.argv.includes('--json');
if (!graphPath || !repo) {
  console.error('usage: retrieval-bench.mjs --graph <graph.json> --repo <abs repo path> [--json]');
  process.exit(2);
}

const tmpDb = path.join(os.tmpdir(), `llmide-bench-${process.pid}.db`);
process.env.LLMIDE_DB_PATH = tmpDb;
process.env.LLMIDE_JWT_SECRET ||= 'b'.repeat(48);
process.env.LLMIDE_VAULT_KEY ||= 'c'.repeat(48);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true }); };

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { ingestStructureGraph } = await import('../connectors/structure-graph.mjs');
const { indexLocalRepo } = await import('../connectors/git.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');

try {
  const U = users.registerUser(db.getDb(), { email: `bench-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'bench' }).id;
  db.addUserRepo(U, repo);
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  let head = null;
  try { head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git repo */ }
  // Upload in batches like the Mac does (the server caps one request): every
  // node first, so no edge batch references a node not yet written.
  for (let i = 0; i < Math.max(1, graph.nodes.length); i += 5000) {
    ingestStructureGraph(U, repo, { nodes: graph.nodes.slice(i, i + 5000), edges: [] },
      { replace: i === 0, commitSha: head });
  }
  for (let i = 0; i < graph.edges.length; i += 20000) {
    ingestStructureGraph(U, repo, { nodes: [], edges: graph.edges.slice(i, i + 20000) }, {});
  }
  await indexLocalRepo(U, repo);

  const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'retrieval-bench.questions.json'), 'utf8'));
  const endsWithAny = (p, files) => files.some((f) => String(p || '').endsWith(f));
  const rows = questions.map(({ q, files, symbols }) => {
    const out = handleFindCode({ query: q }, { userId: U, roots: [repo], workspaceRoot: repo, activeRepoRoot: repo, freshnessCacheMs: 0 });
    const top3 = (out.symbols || []).slice(0, 3);
    const hit3 = top3.some((s) => symbols.includes(s.name) || endsWithAny(s.path, files));
    const all = [...(out.symbols || []), ...(out.related || [])];
    const anywhere = hit3
      || all.some((s) => symbols.includes(s.name) || endsWithAny(s.path, files))
      || (out.files || []).some((f) => endsWithAny(f.path, files));
    return { q, hit3, anywhere, chars: JSON.stringify(out).length, top3: top3.map((s) => `${s.name} (${s.path})`) };
  });

  const sorted = rows.map((r) => r.chars).sort((a, b) => a - b);
  const summary = {
    questions: rows.length,
    hitAt3: rows.filter((r) => r.hit3).length,
    hitAnywhere: rows.filter((r) => r.anywhere).length,
    medianChars: sorted[Math.floor(sorted.length / 2)],
    totalChars: sorted.reduce((a, b) => a + b, 0),
  };
  if (jsonOnly) {
    console.log(JSON.stringify(summary));
  } else {
    for (const r of rows) {
      console.log(`${r.hit3 ? 'HIT3' : r.anywhere ? 'ANY ' : 'MISS'}  ${String(r.chars).padStart(6)}  ${r.q}`);
      console.log(`        top3: ${r.top3.join(' | ') || '(none)'}`);
    }
    console.log(`\nhit@3 ${summary.hitAt3}/${summary.questions} · anywhere ${summary.hitAnywhere}/${summary.questions} · median ${summary.medianChars} chars · total ${summary.totalChars} chars`);
  }
} finally {
  db.closeDb();
  cleanup();
}
```

(If `ingestStructureGraph` rejects an empty-nodes batch or the node/edge caps differ, adapt the batching to the real caps in `connectors/structure-graph.mjs` — keep one `replace: true` first batch.)

In `extension/package.json` `"scripts"` add `"bench:retrieval": "node scripts/retrieval-bench.mjs",`.

- [ ] **Step 3: Produce the graph and record the BASELINE** — build the graph JSON with the scratch probe (unsandboxed): `S=/private/tmp/claude-501/-Users-dinsmallade-llm-ide/8dd20535-657b-4b2b-9c13-1f00997d1a6e/scratchpad; rsync -a --delete --exclude .build /Users/dinsmallade/llm-ide/mac/LocalPackages/graph-kit/ $S/gk/ && (cd $S/probe && swift build -c release) && $S/probe/.build/release/probe /Users/dinsmallade/llm-ide "" $TMPDIR/llmide-graph.json` (usage: `probe <repo> [symbol] [out.json]`; if the JSON is not in the wire shape above, adapt the probe's writer and say so). Then `cd extension && node scripts/retrieval-bench.mjs --graph $TMPDIR/llmide-graph.json --repo /Users/dinsmallade/llm-ide` (unsandboxed) and save the full output in your report as the BASELINE. Expected roughly: hit@3 2/10, anywhere 8/10.

- [ ] **Step 4: Lint and commit**

```bash
cd extension && npm run lint && cd ..
git add extension/scripts/retrieval-bench.mjs extension/scripts/retrieval-bench.questions.json extension/package.json
git commit -m "feat(server): add a find-code retrieval benchmark over a real graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task R2: ranking v2

> **Ruling (during execution):** the per-term probe below was replaced. `searchCodeSymbols` never matches `source_file`, and a short term ("pin") fills a 30-row probe with short incidental titles, so per-probe df and path scoring could not work. Shipped instead: `searchCodeSymbolsByTerms` in `kb/code-graph.mjs` (one df scan + one scored scan: per term, IDF weight × title 1 / path 0.6 / doc 0.3), a whole-query `searchCodeSymbols` probe whose exact (tier 0) match skips the term lookup, compound words (`find-code`) kept whole in `queryTerms`, and `seedRank` in `graphkit/graph.mjs` (coverage ×(1+0.25·(matched−1)), tests ×0.5, docs ×0.6). Benchmark: hit@3 4/10 → 7/10, anywhere 9/10 → 10/10, total payload 62,070 → 52,159 chars.

**Files:**
- Modify: `extension/graphkit/graph.mjs` (`SEED_STOP_WORDS`, `seedCandidates`, new `stemToken`/`queryTerms`/`scoreSeed`, the stage-1 loop of `searchCodeIndex`)
- Modify: `extension/graphkit/index.mjs` (export `queryTerms`, `stemToken` next to `seedCandidates`)
- Test: `extension/tests/find-code-ranking.test.mjs` (create)

**Interfaces:** `stemToken(word) → string` (case-preserving); `queryTerms(query) → string[]` (content terms, stemmed, deduped case-insensitively, original case); `seedCandidates(query)` keeps its contract (whole query first, ≤ 6, includes an identifier like `renderGutter` verbatim).

- [ ] **Step 1: Write the failing tests** — `extension/tests/find-code-ranking.test.mjs` (DB-isolated like `code-graph-repo-scope.test.mjs`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_find-code-ranking-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { searchCodeIndex, queryTerms, stemToken, seedCandidates } = await import('../graphkit/index.mjs');

const U = users.registerUser(db.getDb(), { email: `rk-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'r' }).id;
const REPO = '/r/app';
const n = (file, title, kind = 'function', line = 1) =>
  ({ id: `${kind}:${file}:${title}`, title, kind, metadata: { source_file: file, line: `L${line}` } });

test.before(() => {
  db.writeCodeGraph(U, REPO, { nodes: [
    n('mac/Mobile/MobilePin.swift', 'MobilePin', 'classType', 5),
    n('mac/Mobile/MobilePin.swift', 'rotateInMemory', 'function', 111),
    n('mac/Mobile/PairingThrottle.swift', 'PairingThrottle', 'classType', 3),
    n('mac/Mobile/PairingInfo.swift', 'PairingInfo', 'classType', 3),
    n('mac/Mobile/PairingView.swift', 'PairingView', 'classType', 3),
    n('extension/server/report.mjs', 'serverReport', 'function', 9),
    n('extension/server/report.mjs', 'reportServer', 'function', 20),
    n('extension/tests/pin.test.mjs', 'rotatePinTest', 'function', 4),
    n('docs/mobile/pin.md', 'Rotating the PIN', 'docPage', 1),
    n('mac/Loop/LoopEngineRunner.swift', 'LoopEngineRunner', 'classType', 10),
    n('mac/Loop/LoopEngineRunner.swift', 'retryIteration', 'function', 629),
    n('mac/Loop/LoopRunService.swift', 'runner', 'function', 2),
  ], edges: [] }, { source: 'structure' });
});
test.after(() => { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true }); });

test('stemToken strips inflection but keeps case and a 4-char floor', () => {
  assert.equal(stemToken('rotated'), 'rotat');
  assert.equal(stemToken('retries'), 'retry');
  assert.equal(stemToken('Handling'), 'Handl');
  assert.equal(stemToken('renderGutter'), 'renderGutter');
  assert.equal(stemToken('bus'), 'bus');
});

test('queryTerms drops question and filler words', () => {
  assert.deepEqual(queryTerms('where is the mobile pairing PIN rotated'), ['mobile', 'pair', 'PIN', 'rotat']);
  assert.deepEqual(queryTerms('how does the Loop runner retry a failed stage'), ['Loop', 'runner', 'retry', 'fail', 'stage']);
});

test('seedCandidates keeps its contract', () => {
  assert.equal(seedCandidates('fix the renderGutter offset')[0], 'fix the renderGutter offset');
  assert.ok(seedCandidates('fix the renderGutter offset').includes('renderGutter'));
  assert.ok(seedCandidates('a b c d e f g h i j k l m n o p q r s t u v w x y z alpha beta gamma delta epsilon').length <= 6);
});

const top3 = (q) => searchCodeIndex(U, q, { repoIds: [REPO] }).symbols.slice(0, 3).map((s) => s.title);

test('a stemmed, multi-term question ranks the real answer first', () => {
  const t = top3('where is the mobile pairing PIN rotated');
  assert.ok(t.includes('rotateInMemory') || t[0] === 'MobilePin', JSON.stringify(t));
  assert.ok(!t.includes('rotatePinTest'), 'tests rank below code');
  assert.ok(!t.includes('Rotating the PIN'), 'docs rank below code');
});

test('multi-term coverage beats a generic single-term match', () => {
  const t = top3('how does the Loop runner retry a failed stage');
  assert.ok(t.includes('LoopEngineRunner') || t.includes('retryIteration'), JSON.stringify(t));
  assert.notEqual(t[0], 'runner');
});

test('an exact identifier query still puts the definition first', () => {
  assert.equal(top3('PairingThrottle')[0], 'PairingThrottle');
  assert.equal(top3('rotateInMemory')[0], 'rotateInMemory');
});
```

- [ ] **Step 2: Run to verify failure** — `cd extension && node --test tests/find-code-ranking.test.mjs` — Expected: FAIL (`stemToken`/`queryTerms` missing; ranking assertions).

- [ ] **Step 3: Implement** in `graphkit/graph.mjs`:

Replace `SEED_STOP_WORDS` with:

```js
// Words with no retrieval signal in a natural-language question about code:
// articles, question words, auxiliaries, and generic verbs/nouns that match
// hundreds of symbols ("handle", "file", "code"). Filtering them is what keeps
// "where is the mobile pairing PIN rotated" from being seeded on "where".
const SEED_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into',
  'fix', 'component', 'this', 'that', 'these', 'those', 'it', 'its', 'there', 'here',
  'where', 'what', 'which', 'who', 'when', 'why', 'how',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'may', 'might',
  'get', 'gets', 'set', 'sets', 'use', 'used', 'uses', 'using', 'make', 'makes',
  'call', 'calls', 'called', 'calling', 'handle', 'handles', 'handled', 'handling',
  'decide', 'decides', 'decided', 'happen', 'happens', 'work', 'works',
  'code', 'file', 'files', 'function', 'functions', 'method', 'methods', 'thing', 'way', 'when',
]);

// Inflection suffixes, longest first; the stem keeps >= 4 chars.
const STEM_SUFFIXES = [['ies', 'y'], ['ing', ''], ['ed', ''], ['es', ''], ['s', '']];

/** Light, case-preserving stemming: `rotated`→`rotat`, `retries`→`retry`. */
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

/** Content terms of a question: filler dropped, stemmed, deduped (case-insensitive). */
export function queryTerms(query) {
  const seen = new Set();
  const out = [];
  for (const raw of String(query).split(/[^A-Za-z0-9_]+/)) {
    if (raw.length < 3 || SEED_STOP_WORDS.has(raw.toLowerCase())) continue;
    const term = stemToken(raw);
    const key = term.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(term); }
  }
  return out;
}
```

Change `seedCandidates` to use it:

```js
export function seedCandidates(query) {
  const terms = queryTerms(query).sort((a, b) => b.length - a.length);
  return [...new Set([String(query).trim(), ...terms])]
    .filter(Boolean)
    .slice(0, MAX_SEED_CANDIDATES);
}
```

Add the scorer:

```js
// Rows fetched per probe: enough to rank a term's matches, bounded so the
// scan stays one LIMIT-ed query per candidate.
const PROBE_LIMIT = 30;

/**
 * Relevance of one candidate row to the question's terms. A term found in the
 * title counts fully, in the file path half; each term is weighted by rarity
 * (a term that matched PROBE_LIMIT rows is nearly worthless, one that matched
 * two is decisive); agreement of several terms compounds; an exact/prefix
 * title match of a probe adds a small bonus; tests and docs are demoted so
 * they never outrank the code they describe.
 */
function scoreSeed(row, terms, dfByTerm) {
  const title = String(row.title || '').toLowerCase();
  const file = String(row.source_file || '').toLowerCase();
  let score = 0;
  let covered = 0;
  for (const t of terms) {
    const key = t.toLowerCase();
    const weight = 1 / Math.log2(2 + (dfByTerm.get(key) ?? PROBE_LIMIT));
    if (title.includes(key)) { score += weight; covered += 1; } else if (file.includes(key)) { score += 0.5 * weight; covered += 1; }
  }
  if (covered > 1) score *= 1 + 0.25 * (covered - 1);
  score += (3 - Math.min(3, Number.isFinite(row.tier) ? row.tier : 3)) * 0.15;
  if (/(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\.[a-z0-9]+$/.test(file) || /(^|\/)[a-z]*tests\//.test(file)) score *= 0.5;
  if (row.kind === 'docPage' || row.kind === 'heading' || /\.md$/.test(file)) score *= 0.6;
  return score;
}
```

and replace the stage-1 block in `searchCodeIndex` (from `const byId = new Map();` through the `.slice(0, seedLimit);` that defines `seeds`) with:

```js
  // Every candidate is probed (bounded by MAX_SEED_CANDIDATES) and every row
  // is scored against the question's terms — ranking by match tier and title
  // length alone put an incidental substring hit of a generic word ahead of
  // the symbol that matched the question's distinctive words.
  const terms = queryTerms(q);
  const byId = new Map();
  const dfByTerm = new Map();
  for (const cand of seedCandidates(q)) {
    const rows = searchCodeSymbols(userId, cand, PROBE_LIMIT, { repoIds });
    const key = cand.toLowerCase();
    if (terms.some((t) => t.toLowerCase() === key)) dfByTerm.set(key, rows.length);
    for (const row of rows) {
      const prev = byId.get(row.symbol_id);
      if (!prev || row.tier < prev.tier) byId.set(row.symbol_id, row);
    }
  }
  const scoringTerms = terms.length > 0 ? terms : [q];
  const seeds = [...byId.values()]
    .map((row) => ({ row, score: scoreSeed(row, scoringTerms, dfByTerm) }))
    .sort((a, b) => (b.score - a.score)
      || (a.row.tier - b.row.tier)
      || ((a.row.title || '').length - (b.row.title || '').length)
      || String(a.row.title).localeCompare(String(b.row.title)))
    .slice(0, seedLimit)
    .map((x) => x.row);
```

(Remove the Phase C "title-tier early break" — every candidate is now probed and scored; the bound is `MAX_SEED_CANDIDATES`.)

Export `queryTerms` and `stemToken` from `graphkit/index.mjs` alongside `seedCandidates`.

- [ ] **Step 4: Run tests** — `node --test tests/find-code-ranking.test.mjs tests/find-code.test.mjs tests/code-graph-repo-scope.test.mjs tests/retrieval-golden.test.mjs`, then full `npm test` (unsandboxed) and `npm run lint`. If an existing assertion changes, name it and why.
- [ ] **Step 5: Measure** — re-run the benchmark exactly as in R1 Step 3 on the same graph JSON and put BEFORE/AFTER side by side in the report (hit@3, anywhere, median/total chars, and each question's top 3). Payload (median chars) must not grow by more than 10%.
- [ ] **Step 6: Commit**

```bash
git add extension/graphkit/graph.mjs extension/graphkit/index.mjs extension/tests/find-code-ranking.test.mjs
git commit -m "feat(server): rank find-code seeds by term coverage, rarity and file path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
