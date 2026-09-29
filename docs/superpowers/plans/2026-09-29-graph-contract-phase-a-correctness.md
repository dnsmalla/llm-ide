# Graph as Contract — Phase A (Correctness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the graph pipeline feeding the LLM wrong, cross-repo or duplicated context, and enforce the cheap output checks (codegen modify targets, plan owners).

**Architecture:** Server-side (Node, `extension/`) read paths gain an optional repo scope derived from the open workspace; the Mac app's graph upload re-uploads on line changes and sends signatures as `doc`; prompt assembly drops a duplicate memory block and unifies "find-code first"; codegen and planner validate model output against what they were given. No graph-kit changes (those are Phase D).

**Tech Stack:** Node 20+ ESM, better-sqlite3, `node --test`; Swift 6 toolchain (Swift 5 language mode), XCTest.

**Spec:** `docs/superpowers/specs/2026-09-29-graph-as-contract-design.md`

## Global Constraints

- Extension module boundaries are ESLint-enforced at zero violations: `kb` → `core` only; `graphkit`/`agents`/`llm_agent` → L0–L2 (+ `graphkit` for agents/llm_agent); never add per-file exemptions (`extension/eslint.config.mjs`).
- Every `kb/` state-reading/mutating helper takes `userId` first and calls `requireUser(userId)`.
- All multi-step SQLite mutations use `db.transaction()`.
- `cd extension && npm run lint` must pass with `--max-warnings 0`.
- Mac tests ALWAYS run as `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test …`; SwiftPM commands fail inside the Claude sandbox — run them unsandboxed.
- No wire-format change to any HTTP endpoint in this phase, so `SERVER_API_VERSION` (57) is NOT bumped.
- Conventional Commits, one concern per commit, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/graph-contract-phase-a` off `main`.

## File map

| File | Change |
|---|---|
| `extension/kb/code-graph.mjs` | `repoScope()`, `workspaceRepoIds()`, optional `repoIds` on `graphNeighbors`/`searchCodeSymbols`/`hydrateSymbols` |
| `extension/kb/db.mjs` | re-export `workspaceRepoIds`; `findContext` gains `{ kinds }` |
| `extension/graphkit/graph.mjs` | `searchCodeIndex` threads `repoIds` |
| `extension/llm_agent/runtime/handlers/find-code.mjs` | resolve + pass `repoIds` |
| `extension/llm_agent/runtime/loop.mjs`, `handlers/ask-internal.mjs` | internal loop skips repo memory |
| `extension/llm_agent/runtime/execute-guidance.mjs` | find-code-first rule |
| `extension/agents/codegen.mjs` | modify-target contract, truncation labels, repo-relative paths, output cap |
| `extension/agents/planner.mjs` | skip code slice, validate owners, export `validatePlan` |
| `extension/connectors/git.mjs` | atomic replace, injectable walker |
| `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/CodeGraphUploadService.swift` | fingerprint covers file/line/declaration |
| `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/LlmIdeAPIClient+CodeGraph.swift` | declaration → `doc` |
| Tests | `extension/tests/code-graph-repo-scope.test.mjs` (new), `ask-internal-memory.test.mjs` (new), `execute-guidance.test.mjs` (new), `codegen-validate.test.mjs`, `planner-validate.test.mjs` (new), `find-context-kinds.test.mjs` (new), `git-connector-atomic.test.mjs` (new), `mac/Tests/LlmIdeMacTests/CodeGraphUploadServiceTests.swift` |

---

### Task 1: Repo-scoped code-graph reads

**Files:**
- Modify: `extension/kb/code-graph.mjs` (imports at top; `graphNeighbors` ~L150-208; `searchCodeSymbols` ~L251-273; `hydrateSymbols` ~L305-313)
- Modify: `extension/kb/db.mjs:499-503` (re-export list)
- Modify: `extension/graphkit/graph.mjs` (`searchCodeIndex` ~L165-306)
- Modify: `extension/llm_agent/runtime/handlers/find-code.mjs` (~L172-176 and imports)
- Test: `extension/tests/code-graph-repo-scope.test.mjs` (create)

**Interfaces:**
- Produces: `workspaceRepoIds(userId: string, workspaceRoot: string) → string[] | null` (from `kb/db.mjs`); `graphNeighbors(userId, seedIds, { …, repoIds?: string[] | null })`; `searchCodeSymbols(userId, query, limit, { repoIds? } = {})`; `hydrateSymbols(userId, ids, { repoIds? } = {})`; `searchCodeIndex(userId, query, { limit, hops, repoIds? })`. `null`/absent `repoIds` = unscoped (unchanged behaviour).

- [ ] **Step 1: Write the failing test**

Create `extension/tests/code-graph-repo-scope.test.mjs`:

```js
// Repo scoping for code-graph reads. Rows carry the INDEXED clone's path as
// repo_id; before this, every read filtered on user_id only, so an llm-ide
// question returned symbols from every repo the user ever graphed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_repo-scope-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { searchCodeIndex } = await import('../graphkit/index.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');

const U = users.registerUser(db.getDb(), {
  email: `rs-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'r',
}).id;

// The live layout: the workspace is a project folder, the graphed repo is a
// child of it. The other repo is unrelated.
const WORKSPACE = fs.mkdtempSync(path.join(__dirname, '_rs-ws-'));
const WS_REPO = path.join(WORKSPACE, 'code', 'app');
const OTHER_REPO = '/Users/someone/affiliate';

const graph = (name) => ({
  nodes: [
    { id: 'file:src/runner.ts', title: 'runner.ts', kind: 'file', metadata: { source_file: 'src/runner.ts', line: 'L0' } },
    { id: `function:src/runner.ts:${name}`, title: name, kind: 'function', metadata: { source_file: 'src/runner.ts', line: 'L3' } },
  ],
  edges: [{ fromId: 'file:src/runner.ts', toId: `function:src/runner.ts:${name}`, kind: 'contains' }],
});

test.before(() => {
  db.writeCodeGraph(U, WS_REPO, graph('runStage'), { source: 'structure' });
  db.writeCodeGraph(U, OTHER_REPO, graph('runStageAffiliate'), { source: 'structure' });
});

test.after(() => {
  db.closeDb();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('workspaceRepoIds matches a repo under the workspace, not an unrelated one', () => {
  assert.deepEqual(db.workspaceRepoIds(U, WORKSPACE), [WS_REPO]);
});

test('workspaceRepoIds matches when the workspace is inside the repo', () => {
  assert.deepEqual(db.workspaceRepoIds(U, path.join(WS_REPO, 'src')), [WS_REPO]);
});

test('workspaceRepoIds returns null when nothing matches (fallback = unscoped)', () => {
  assert.equal(db.workspaceRepoIds(U, '/nowhere/else'), null);
  assert.equal(db.workspaceRepoIds(U, ''), null);
});

test('searchCodeIndex with repoIds returns only that repo', () => {
  const scoped = searchCodeIndex(U, 'runStage', { repoIds: [WS_REPO] });
  assert.deepEqual(scoped.symbols.map((s) => s.title).filter((t) => t.startsWith('runStage')), ['runStage']);
  assert.ok(scoped.symbols.every((s) => s.repo_id === WS_REPO));
});

test('searchCodeIndex without repoIds is unchanged (both repos)', () => {
  const all = searchCodeIndex(U, 'runStage', {});
  const titles = all.symbols.map((s) => s.title);
  assert.ok(titles.includes('runStage') && titles.includes('runStageAffiliate'));
});

test('hydrateSymbols with repoIds drops the other repo\'s row for a shared id', () => {
  const rows = db.hydrateSymbols(U, ['file:src/runner.ts'], { repoIds: [WS_REPO] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo_id, WS_REPO);
});

test('find-code scopes to the open workspace', () => {
  const out = handleFindCode({ query: 'runStage' }, { userId: U, roots: [WORKSPACE], workspaceRoot: WORKSPACE });
  const names = out.symbols.map((s) => s.name);
  assert.ok(names.includes('runStage'));
  assert.ok(!names.includes('runStageAffiliate'), 'affiliate repo must not leak into this workspace');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/code-graph-repo-scope.test.mjs`
Expected: FAIL — `db.workspaceRepoIds is not a function`.

- [ ] **Step 3: Implement scoping in `kb/code-graph.mjs`**

Add below the existing imports (`path` is already imported):

```js
import os from 'node:os';

// `AND repo_id IN (…)` for an optional repo scope. null/[] = unscoped, so every
// existing caller (code-sync, tests) keeps today's behaviour.
function repoScope(repoIds) {
  if (!Array.isArray(repoIds) || repoIds.length === 0) return { sql: '', params: [] };
  return { sql: ` AND repo_id IN (${repoIds.map(() => '?').join(',')})`, params: repoIds };
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The graphed repos that belong to the open workspace: repo_id equal to, under,
 * or containing `workspaceRoot`. Graph rows carry the INDEXED clone's path, and
 * the Mac graphs a project's `code/<child>` repo while the workspace is the
 * project folder — so equality alone would match nothing on the live layout.
 * Returns null when nothing matches: a different clone must still get answers
 * (find-code already flags such paths `outsideWorkspace`).
 */
export function workspaceRepoIds(userId, workspaceRoot) {
  requireUser(userId);
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return null;
  const ws = path.resolve(expandHome(workspaceRoot.trim()));
  const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  const hits = getDb().prepare('SELECT DISTINCT repo_id FROM code_graph_nodes WHERE user_id=?')
    .all(userId)
    .map((r) => r.repo_id)
    .filter((r) => {
      const repo = path.resolve(expandHome(String(r)));
      return within(repo, ws) || within(ws, repo);
    });
  return hits.length > 0 ? hits : null;
}
```

In `graphNeighbors`, add `repoIds = null,` to the options destructure (after `limit = 60,`), add `const scope = repoScope(repoIds);` after `const kindPlace = …`, and change both queries:

```js
      rows.push(...db.prepare(
        `SELECT from_id, to_id AS neighbor_id, kind, 'out' AS dir FROM code_graph_edges
         WHERE user_id=?${scope.sql} AND from_id IN (${place}) AND kind IN (${kindPlace})`,
      ).all(userId, ...scope.params, ...frontier, ...edgeKinds));
```

```js
      rows.push(...db.prepare(
        `SELECT to_id AS from_id, from_id AS neighbor_id, kind, 'in' AS dir FROM code_graph_edges
         WHERE user_id=?${scope.sql} AND to_id IN (${place}) AND kind IN (${kindPlace})`,
      ).all(userId, ...scope.params, ...frontier, ...edgeKinds));
```

Replace `searchCodeSymbols`'s signature and query:

```js
export function searchCodeSymbols(userId, query, limit = 10, { repoIds = null } = {}) {
  requireUser(userId);
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return [];
  const escaped = q
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const contains = `%${escaped}%`;
  const prefix = `${escaped}%`;
  const lower = q.toLowerCase();
  const scope = repoScope(repoIds);
  return getDb().prepare(
    `SELECT symbol_id, title, kind, repo_id, source_file, line, language, doc,
            CASE
              WHEN lower(title) = ?                     THEN 0
              WHEN title LIKE ? ESCAPE '\\'             THEN 1
              WHEN title LIKE ? ESCAPE '\\'             THEN 2
              ELSE 3
            END AS tier
     FROM code_graph_nodes
     WHERE user_id=?${scope.sql} AND (title LIKE ? ESCAPE '\\' OR doc LIKE ? ESCAPE '\\')
     ORDER BY tier, length(title), title
     LIMIT ?`,
    // Bind order is SQL-text order: the three CASE tiers, then user_id, the
    // optional repo scope, the LIKE pair, and LIMIT.
  ).all(lower, prefix, contains, userId, ...scope.params, contains, contains, limit);
}
```

Replace `hydrateSymbols`:

```js
export function hydrateSymbols(userId, symbolIds, { repoIds = null } = {}) {
  requireUser(userId);
  if (!Array.isArray(symbolIds) || symbolIds.length === 0) return [];
  const place = symbolIds.map(() => '?').join(',');
  const scope = repoScope(repoIds);
  return getDb().prepare(
    `SELECT symbol_id, title, kind, repo_id, source_file, line FROM code_graph_nodes
     WHERE user_id=?${scope.sql} AND symbol_id IN (${place})`,
  ).all(userId, ...scope.params, ...symbolIds);
}
```

In `extension/kb/db.mjs`, add `workspaceRepoIds` to the `export { … } from './code-graph.mjs';` list.

- [ ] **Step 4: Thread `repoIds` through `searchCodeIndex`** (`extension/graphkit/graph.mjs`)

Change the signature to `export function searchCodeIndex(userId, query, { limit = 8, hops = 1, repoIds = null } = {}) {` and pass the scope at every read inside it:

- `searchCodeSymbols(userId, cand, seedLimit)` → `searchCodeSymbols(userId, cand, seedLimit, { repoIds })`
- `graphNeighbors(userId, symbolSeeds, { hops, limit: fetchLimit })` → `graphNeighbors(userId, symbolSeeds, { hops, limit: fetchLimit, repoIds })`
- the file-seed `graphNeighbors(userId, fileSeeds, { hops, limit: fetchLimit, edgeKinds: [CONTAINS_EDGE_KIND, 'imports'] })` → add `repoIds,`
- the importers `graphNeighbors(userId, fileIds, { hops: 1, direction: 'in', edgeKinds: ['imports'], limit: … })` → add `repoIds,`
- both `hydrateSymbols(userId, […])` calls → `hydrateSymbols(userId, […], { repoIds })`

Leave `hasCodeGraph(userId)` unscoped (it answers "is there any index", not "any match here") and Stage 3 `findRelatedCode` unchanged (FTS is out of scope for this task).

- [ ] **Step 5: Scope find-code to the workspace** (`extension/llm_agent/runtime/handlers/find-code.mjs`)

Add the import next to the existing `searchCodeIndex` import:

```js
import { workspaceRepoIds } from '../../../kb/db.mjs';
```

Replace the `try` block around the search:

```js
  let result;
  try {
    // Scope to the repos graphed for the open workspace; null (no match, or
    // no workspace) keeps the unscoped search so another clone still answers.
    const repoIds = workspaceRoot ? workspaceRepoIds(ctx.userId, workspaceRoot) : null;
    result = searchCodeIndex(ctx.userId, query, { limit, hops, repoIds });
  } catch (err) {
```

- [ ] **Step 6: Run the tests**

Run: `cd extension && node --test tests/code-graph-repo-scope.test.mjs tests/find-code.test.mjs tests/code-graph-store.test.mjs`
Expected: all PASS (the existing find-code suite indexes a clone unrelated to its workspace, so it exercises the null fallback).

- [ ] **Step 7: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/kb/code-graph.mjs extension/kb/db.mjs extension/graphkit/graph.mjs \
  extension/llm_agent/runtime/handlers/find-code.mjs extension/tests/code-graph-repo-scope.test.mjs
git commit -m "fix(server): scope find-code graph reads to the open workspace's repos

Every code-graph read filtered on user_id only, so answers mixed every repo
the user ever graphed. Reads take an optional repoIds scope; find-code
derives it from the workspace (repo under/containing it) and falls back to
unscoped when no graphed repo matches.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Mac upload re-uploads on line changes and sends signatures

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/CodeGraphUploadService.swift:92-101`
- Modify: `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/LlmIdeAPIClient+CodeGraph.swift:20-30`
- Test: `mac/Tests/LlmIdeMacTests/CodeGraphUploadServiceTests.swift`

**Interfaces:**
- Produces: `CodeGraphUploadService.fingerprint(_:)` (same signature, wider input); `LlmIdeAPIClient.CodeGraphNodePayload.metadata["doc"]` falls back to `declaration` (≤ 500 chars).

- [ ] **Step 1: Write the failing tests**

Append inside `final class CodeGraphUploadServiceTests` (before its closing brace):

```swift
    // MARK: - fingerprint covers what the server stores

    /// An edit that only shifts lines keeps every id/title/kind, so the old
    /// fingerprint never changed and the server kept stale line numbers.
    func testLineShiftChangesTheFingerprint() {
        func graph(_ line: String) -> CGData {
            CGData(nodes: [CGNode(id: "function:a.swift:f", title: "f", kind: .function,
                                  metadata: ["source_file": "a.swift", "line": line])], edges: [])
        }
        XCTAssertNotEqual(CodeGraphUploadService.fingerprint(graph("L3")),
                          CodeGraphUploadService.fingerprint(graph("L9")))
    }

    func testDeclarationChangeChangesTheFingerprint() {
        func graph(_ decl: String) -> CGData {
            CGData(nodes: [CGNode(id: "function:a.swift:f", title: "f", kind: .function,
                                  metadata: ["declaration": decl])], edges: [])
        }
        XCTAssertNotEqual(CodeGraphUploadService.fingerprint(graph("func f()")),
                          CodeGraphUploadService.fingerprint(graph("func f(x: Int)")))
    }

    // MARK: - payload

    func testPayloadSendsDeclarationAsDocWhenNoDoc() {
        let node = CGNode(id: "function:a.py:f", title: "f", kind: .function,
                          metadata: ["source_file": "a.py", "declaration": "def f(x):"])
        XCTAssertEqual(LlmIdeAPIClient.CodeGraphNodePayload(node).metadata["doc"], "def f(x):")
    }

    func testPayloadKeepsAnExistingDoc() {
        let node = CGNode(id: "function:a.py:f", title: "f", kind: .function,
                          metadata: ["doc": "Documented.", "declaration": "def f(x):"])
        XCTAssertEqual(LlmIdeAPIClient.CodeGraphNodePayload(node).metadata["doc"], "Documented.")
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run (unsandboxed): `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter CodeGraphUploadServiceTests`
Expected: the 4 new tests FAIL (fingerprints equal; `doc` nil).

- [ ] **Step 3: Implement**

In `CodeGraphUploadService.swift`, replace the node loop inside `fingerprint(_:)` and update its doc comment's first line:

```swift
    /// Content fingerprint of a graph: node ids + the metadata the server
    /// stores (file, line, signature) + edge triples, hashed. Pure +
```

```swift
        for n in graph.nodes {
            // file/line/declaration included: the server persists them, and an
            // edit that only shifts lines must still re-upload or the server's
            // line numbers go stale silently. Layout positions stay excluded.
            let m = n.metadata
            let row = "\(n.id)|\(n.title)|\(n.kind.rawValue)|\(m["source_file"] ?? "")|\(m["line"] ?? "")|\(m["declaration"] ?? "")\n"
            hasher.update(data: Data(row.utf8))
        }
```

In `LlmIdeAPIClient+CodeGraph.swift`, after the `for key in […]` loop in `CodeGraphNodePayload.init`:

```swift
            // The graph's `doc` is empty for structure nodes, so without this
            // the server knows a symbol's name but never its signature and the
            // model must open the file anyway. Capped: a declaration is a line
            // or two, not a body.
            if meta["doc"] == nil, let decl = node.metadata["declaration"], !decl.isEmpty {
                meta["doc"] = String(decl.prefix(500))
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run (unsandboxed): `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter CodeGraphUploadServiceTests`
Expected: PASS, including the existing `testLayoutPositionsDoNotAffectTheFingerprint`.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/CodeGraph/Services/CodeGraphUploadService.swift \
  mac/Sources/LlmIdeMac/Features/CodeGraph/Services/LlmIdeAPIClient+CodeGraph.swift \
  mac/Tests/LlmIdeMacTests/CodeGraphUploadServiceTests.swift
git commit -m "fix(mac): re-upload the code graph on line changes and send signatures

The upload fingerprint hashed only id/title/kind, so a line-shifting edit
never re-uploaded and server line numbers went stale. It now covers
source_file, line and declaration. The payload sends declaration as doc
when a node has none.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ask-internal stops re-sending repo memory

**Files:**
- Modify: `extension/llm_agent/runtime/loop.mjs` (the `contextBlock` assignment, ~L489-491)
- Modify: `extension/llm_agent/runtime/handlers/ask-internal.mjs` (~L48, the `agentContext:` line)
- Test: `extension/tests/ask-internal-memory.test.mjs` (create)

**Interfaces:**
- Produces: `agentContext.includeRepoMemory === false` makes the loop's system context omit repo memory (default: included).

- [ ] **Step 1: Write the failing test**

Create `extension/tests/ask-internal-memory.test.mjs`:

```js
// The legacy global agent already carries the repo-memory block; ask-internal
// re-rendered all of it (up to 40k chars) into a fresh, uncached sub-loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_ask-internal-memory-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { runAgentLoop } = await import('../llm_agent/runtime/loop.mjs');
const { loadSkills } = await import('../llm_agent/skills/loader.mjs');

const U = users.registerUser(db.getDb(), {
  email: `aim-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a',
}).id;
const REPO = fs.mkdtempSync(path.join(__dirname, '_aim-repo-'));
fs.mkdirSync(path.join(REPO, 'system'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'system', 'repo.md'), '# Facts\n\nMARKER_REPO_MEMORY\n');
db.addUserRepo(U, REPO);

test.after(() => {
  db.closeDb();
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

async function firstPrompt(agentContext) {
  const prompts = [];
  const { skills } = loadSkills(path.join(__dirname, '..', 'llm_agent', 'global'));
  await runAgentLoop({
    skills, userMessage: 'what is open?', history: [], kb: null, userId: U, handlers: {},
    agentContext: { base: '', indexedRepos: [{ path: REPO, name: 'r' }], ...agentContext },
    runClaude: async (p) => { prompts.push(p); return 'Done.'; },
  });
  return prompts[0];
}

test('system context includes repo memory by default', async () => {
  assert.match(await firstPrompt({ includeSystemContext: true }), /MARKER_REPO_MEMORY/);
});

test('includeRepoMemory:false omits it', async () => {
  assert.doesNotMatch(
    await firstPrompt({ includeSystemContext: true, includeRepoMemory: false }),
    /MARKER_REPO_MEMORY/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/ask-internal-memory.test.mjs`
Expected: test 1 PASS, test 2 FAIL (marker present).

- [ ] **Step 3: Implement**

In `loop.mjs` replace the `contextBlock` assignment:

```js
  const contextBlock = agentContext && agentContext.includeSystemContext === true
    ? composeSystemContext(agentContext, userId, userMessage,
      // ask-internal sets includeRepoMemory:false — the global agent that
      // delegated already carries the repo-memory block, and re-rendering it
      // here doubled it inside an uncached sub-loop.
      { memory: agentContext.includeRepoMemory !== false })
    : '';
```

In `ask-internal.mjs` change the `agentContext:` line to:

```js
    agentContext: { ...(ctx.agentContext || {}), base: internalBase, includeSystemContext: true, includeRepoMemory: false },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/ask-internal-memory.test.mjs tests/agent-context-renderers.test.mjs tests/agent-loop.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/llm_agent/runtime/loop.mjs extension/llm_agent/runtime/handlers/ask-internal.mjs extension/tests/ask-internal-memory.test.mjs
git commit -m "fix(server): stop ask-internal re-sending the repo-memory block

The global agent already carries it; the internal sub-loop re-rendered up to
40k chars into an uncached prompt on every delegation.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Execute mode says "find-code first"

**Files:**
- Modify: `extension/llm_agent/runtime/execute-guidance.mjs` (the `# Changing files (Agent engine)` paragraph)
- Test: `extension/tests/execute-guidance.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2_EXECUTE_GUIDANCE } from '../llm_agent/runtime/execute-guidance.mjs';

// Plan modes and the legacy engine already say this; execute mode listed
// find-code as one option among Read/Grep/Glob, so the model read whole files.
test('execute guidance makes find-code the first step for locating code', () => {
  assert.match(V2_EXECUTE_GUIDANCE, /call `find-code` first/);
  assert.match(V2_EXECUTE_GUIDANCE, /only the lines it points at/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/execute-guidance.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** — replace the line
`Use **Bash** for installs, builds, and tests. Locate code with **Read**, **Grep**, **Glob**, or \`find-code\`.`
with:

```js
Use **Bash** for installs, builds, and tests. To locate code, call \`find-code\` first (symbol index + code graph: definition, callers, importers with file:line) and **Read** only the lines it points at; fall back to **Grep**/**Glob** when it finds nothing or the text you need is a string, comment or config value.
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/execute-guidance.test.mjs tests/plan-pipeline.test.mjs tests/agent-v2-engine.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/runtime/execute-guidance.mjs extension/tests/execute-guidance.test.mjs
git commit -m "fix(server): tell v2 execute mode to locate code with find-code first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Codegen output contract

**Files:**
- Modify: `extension/agents/codegen.mjs` (imports; `readFileSafely` L26-38; `buildPrompt` refs block ~L66-69; `validate` L113-155; `generateCodeForTask` L157-205)
- Test: `extension/tests/codegen-validate.test.mjs`

**Interfaces:**
- Produces: `validate(raw, { modifiable?: Set<string> } = {}) → { summary, files, tests, notes, rejected: string[] } | null`; `repoRelative(absRef: string, roots: string[]) → string | null`; `MAX_OUTPUT_TOKENS = 16_000`.

- [ ] **Step 1: Write the failing tests** — append to `extension/tests/codegen-validate.test.mjs` and extend its import to `import { validate, selectRelevantFiles, MAX_FILE_BYTES, repoRelative } from '../agents/codegen.mjs';`:

```js
test('validate drops a modify whose path was not provided, and says so', () => {
  const out = validate({
    summary: 's',
    files: [
      { path: 'src/given.ts', kind: 'modify', content: 'a' },
      { path: 'src/invented.ts', kind: 'modify', content: 'b' },
      { path: 'src/new.ts', kind: 'create', content: 'c' },
    ],
    tests: [],
  }, { modifiable: new Set(['src/given.ts']) });
  assert.deepEqual(out.files.map((f) => f.path), ['src/given.ts', 'src/new.ts']);
  assert.deepEqual(out.rejected, ['src/invented.ts']);
  assert.match(out.notes, /src\/invented\.ts/);
});

test('validate keeps a result whose only files were rejected (no blind retry)', () => {
  const out = validate({ summary: 's', files: [{ path: 'x.ts', kind: 'modify', content: 'a' }], tests: [] },
    { modifiable: new Set() });
  assert.ok(out, 'a rejected-only result is an answer, not a parse failure');
  assert.deepEqual(out.files, []);
  assert.deepEqual(out.rejected, ['x.ts']);
});

test('validate without a modifiable set keeps the old behaviour', () => {
  const out = validate({ summary: 's', files: [{ path: 'x.ts', kind: 'modify', content: 'a' }], tests: [] });
  assert.equal(out.files.length, 1);
  assert.deepEqual(out.rejected, []);
});

test('repoRelative strips an allowed root and never escapes it', () => {
  assert.equal(repoRelative('/r/app/server/src/a.ts', ['/r/app']), 'server/src/a.ts');
  assert.equal(repoRelative('/elsewhere/a.ts', ['/r/app']), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/codegen-validate.test.mjs`
Expected: FAIL (`repoRelative` not exported; `rejected` undefined).

- [ ] **Step 3: Implement**

Imports — change the kb import line and add constants:

```js
import { getTaskById, getPlan, mergeTaskMeta, userRepoAllowlist } from '../kb/db.mjs';

const MAX_FILES = 8;
export const MAX_FILE_BYTES = 25 * 1024;
// Full-file JSON for up to MAX_FILES × MAX_FILE_BYTES does not fit 4096 output
// tokens; the old cap produced truncated JSON and a same-cost retry.
export const MAX_OUTPUT_TOKENS = 16_000;
```

Replace `readFileSafely` with a version that reports truncation:

```js
function readFileSafely(absPath, maxBytes = MAX_FILE_BYTES) {
  try {
    // lstatSync does NOT follow symlinks — isFile() returns false for
    // a symlink-to-file so we reject any symlink outright rather than
    // silently reading through it to a path outside the repo.
    const lst = fs.lstatSync(absPath);
    if (!lst.isFile()) return null;
    if (lst.size > maxBytes * 4) return null;
    const full = fs.readFileSync(absPath, 'utf8');
    return { content: full.slice(0, maxBytes), truncated: full.length > maxBytes };
  } catch {
    return null;
  }
}

/** `absRef` relative to the first allowed root containing it, POSIX separators. */
export function repoRelative(absRef, roots) {
  for (const root of Array.isArray(roots) ? roots : []) {
    const rel = path.relative(root, absRef);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return null;
}
```

In `buildPrompt`, replace the `refsBlock` assignment:

```js
  const refsBlock = filesCtx.length === 0
    ? '(no related files were retrieved from the KB code index)'
    : filesCtx.map((f) => (f.truncated
      ? `\n--- ${f.relPath} (TRUNCATED at ${Math.floor(MAX_FILE_BYTES / 1024)} KB — read-only, do not "modify" it) ---\n${f.content}\n`
      : `\n--- ${f.relPath} ---\n${f.content}\n`)).join('\n');
```

and add this rule after `- Only emit code for THIS task.  Do not touch unrelated files.`:

```
- "modify" is ONLY allowed for a path listed under "Related files" below that is not marked TRUNCATED. Any other existing file you need changed goes in "notes".
```

Replace `validate`:

```js
export function validate(raw, { modifiable = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  // Collect any file whose body exceeds the per-file cap. We must NEVER
  // silently truncate a generated file — the auto-PR flow writes these to
  // disk and commits them, so a partial body would be committed as if it
  // were the complete file. Fail loud instead (see throw below).
  const oversize = [];
  // A `modify` must target a file the model was actually shown in full:
  // anything else is a full-body rewrite of a file it never read (or read
  // truncated) and would clobber it on approval.
  const rejected = [];
  const cleanArr = (arr) => (Array.isArray(arr) ? arr : [])
    .map((f) => {
      const p = sanitizePath(f?.path);
      if (!p) return null;
      const content = typeof f?.content === 'string' ? f.content : '';
      if (!content) return null;
      // Measure real UTF-8 bytes — `.length`/`.slice` count UTF-16 code
      // units, which undercounts multi-byte characters.
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        oversize.push(`${p} (${Buffer.byteLength(content, 'utf8')} bytes)`);
        return null;
      }
      const kind = f?.kind === 'modify' ? 'modify' : 'create';
      if (modifiable && kind === 'modify' && !modifiable.has(p)) {
        rejected.push(p);
        return null;
      }
      return {
        path: p,
        kind,
        language: typeof f?.language === 'string' ? f.language.slice(0, 30) : '',
        content,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_FILES);

  const files = cleanArr(raw.files);
  const tests = cleanArr(raw.tests);
  if (oversize.length > 0) {
    throw new Error(
      `Code generation produced file(s) over the ${Math.floor(MAX_FILE_BYTES / 1024)} KB per-file limit: ` +
      `${oversize.join(', ')}. Split the task into smaller files — refusing to write a truncated file.`,
    );
  }
  if (files.length + tests.length === 0 && !raw.notes && rejected.length === 0) return null;
  const baseNotes = typeof raw.notes === 'string' ? raw.notes.slice(0, 5000) : '';
  const rejectNote = rejected.length > 0
    ? `Dropped "modify" for file(s) not provided in full as context: ${rejected.join(', ')}.`
    : '';
  return {
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 2000) : '',
    files,
    tests,
    notes: [baseNotes, rejectNote].filter(Boolean).join('\n\n'),
    rejected,
  };
}
```

In `generateCodeForTask`, replace the file-context loop and the two model calls:

```js
  const filesCtx = [];
  if (includeFileContext) {
    const roots = (() => { try { return userRepoAllowlist(userId); } catch { return []; } })();
    const candidateFiles = selectRelevantFiles(task.files, task.symbols);
    for (const f of candidateFiles.slice(0, 5)) {
      if (!f?.ref) continue;
      const read = readFileSafely(f.ref);
      if (!read) continue;
      // Repo-relative via the user's allowed roots; the old regex fallback
      // only for a ref outside every root.
      const rel = repoRelative(f.ref, roots)
        || f.ref.replace(/^.*?\/(src|app|lib|server)\//, (m, dir) => `${dir}/`);
      filesCtx.push({ relPath: rel || path.basename(f.ref), content: read.content, truncated: read.truncated });
    }
  }
  const modifiable = new Set(filesCtx.filter((f) => !f.truncated).map((f) => f.relPath));

  const lang = languageDirective(language || plan.language);
  const prompt = buildPrompt({ task, plan, lang, filesCtx });

  let parsed = tryParseJSON(await runClaude(prompt, { userId, maxTokens: MAX_OUTPUT_TOKENS }));
  let validated = validate(parsed, { modifiable });
  if (!validated) {
    // Stricter retry — most failures are the model wrapping JSON in prose.
    const stricter = `${prompt}\n\nYour previous response was not valid JSON. Output ONLY the JSON object — start with { and end with }.`;
    parsed = tryParseJSON(await runClaude(stricter, { userId, maxTokens: MAX_OUTPUT_TOKENS }));
    validated = validate(parsed, { modifiable });
  }
```

(Delete the old `// Cap output tokens …` comment and the two `maxTokens: 4096` calls it described.)

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/codegen-validate.test.mjs && npm test 2>&1 | tail -5`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/agents/codegen.mjs extension/tests/codegen-validate.test.mjs
git commit -m "fix(server): codegen may only modify files it was shown in full

A modify of a path that was not provided (or was truncated at 25 KB) is a
full-body rewrite of a file the model never read; it is now dropped and
reported. File labels are repo-relative via the allow-list, and the output
cap is raised from 4096 to 16000 tokens so full-file JSON fits.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Planner skips the unused code slice and validates owners

**Files:**
- Modify: `extension/kb/db.mjs` (`findContext` ~L625-718)
- Modify: `extension/graphkit/graph.mjs` (`findGraphContext` ~L79-81)
- Modify: `extension/agents/planner.mjs` (`validatePlan` export + owner check ~L110; call site L138)
- Test: `extension/tests/find-context-kinds.test.mjs`, `extension/tests/planner-validate.test.mjs` (create both)

**Interfaces:**
- Produces: `findContext(userId, query, limit = 5, { kinds } = {})` where `kinds` ⊆ `['meetings','tasks','code','tickets','blockers']` (absent = all); `findGraphContext(userId, query, limit = 5, opts = {})`; `export function validatePlan(parsed, meeting, goal)`.

- [ ] **Step 1: Write the failing tests**

`extension/tests/find-context-kinds.test.mjs`:

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
const tmpDb = path.join(__dirname, '_find-context-kinds-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const U = users.registerUser(db.getDb(), {
  email: `fck-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'f',
}).id;
db.ingestSources(U, [{
  kind: 'code', ref: '/r/app/src/zebra.ts', chunkIdx: 0, title: 'src/zebra.ts:1-3',
  body: 'export function zebraStripes() {}', meta: { repo: '/r/app', relPath: 'src/zebra.ts' },
}]);

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('findContext returns the code slice by default', () => {
  assert.ok(db.findContext(U, 'zebraStripes', 5).code.length > 0);
});

test('findContext skips slices not in kinds', () => {
  const ctx = db.findContext(U, 'zebraStripes', 5, { kinds: ['meetings', 'tasks'] });
  assert.deepEqual(ctx.code, []);
  assert.deepEqual(ctx.tickets, []);
});
```

`extension/tests/planner-validate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// planner.mjs imports the kb + provider layers; give them the test env first.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '_planner-validate-test.db');

const { validatePlan } = await import('../agents/planner.mjs');

const meeting = { title: 'Sync', participants: ['Aiko Tanaka', 'Ben'] };
const plan = (owner) => ({
  title: 'P', goal: 'G',
  milestones: [{ name: 'M1', tasks: [{ title: 'Do it', owner }] }],
});

test('an owner from the participant list is kept (case-insensitive)', () => {
  assert.equal(validatePlan(plan('aiko tanaka'), meeting, 'G').tasks[0].owner, 'aiko tanaka');
});

test('an invented owner becomes null', () => {
  assert.equal(validatePlan(plan('Someone Else'), meeting, 'G').tasks[0].owner, null);
});

test('with no participants recorded, owners are left as given', () => {
  assert.equal(validatePlan(plan('Ben'), { title: 'Sync', participants: [] }, 'G').tasks[0].owner, 'Ben');
});
```

(`validatePlan(raw, meeting, goal)` reads `raw.milestones[].name` and `raw.milestones[].tasks[]` — `planner.mjs:82-95` — which is the fixture's shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/find-context-kinds.test.mjs tests/planner-validate.test.mjs`
Expected: FAIL (`kinds` ignored; `validatePlan` not exported).

- [ ] **Step 3: Implement**

`kb/db.mjs` — change the signature and the return block of `findContext`:

```js
export function findContext(userId, query, limit = 5, { kinds = null } = {}) {
```

```js
  // `kinds` lets a caller skip slices it never renders — each is up to two
  // FTS queries plus a hydration query. Absent = every slice (unchanged).
  const want = (k) => !Array.isArray(kinds) || kinds.includes(k);
  return {
    meetings: want('meetings') ? sliceMeetings('meeting') : [],
    tasks:    want('tasks') ? sliceTasks() : [],
    code:     want('code') ? sliceCode() : [],
    tickets:  want('tickets') ? sliceTickets() : [],
    blockers: want('blockers') ? sliceEntities('blocker') : [],
  };
```

`graphkit/graph.mjs`:

```js
export function findGraphContext(userId, query, limit = 5, opts = {}) {
  return findContext(userId, query, limit, opts);
}
```

`agents/planner.mjs` — at L138:

```js
  // buildPrompt renders meetings/tasks/blockers/tickets only; the code slice
  // was fetched and discarded on every plan.
  const context = findGraphContext(userId, buildContextQuery(meeting, goal), 5,
    { kinds: ['meetings', 'tasks', 'tickets', 'blockers'] });
```

Change `function validatePlan(` to `export function validatePlan(`, and inside it, before the task-building loop, add:

```js
  // The prompt tells the model to pick owners from the participant list; an
  // owner outside it is invented, and would be dispatched as an assignee.
  const participants = new Set((meeting?.participants || []).map((p) => String(p).trim().toLowerCase()));
  const checkOwner = (o) => (o && participants.size > 0 && !participants.has(o.trim().toLowerCase()) ? null : o);
```

and change the owner line in the task object to:

```js
        owner: typeof t?.owner === 'string' ? checkOwner(sanitizeStr(t.owner, 80) || null) : null,
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/find-context-kinds.test.mjs tests/planner-validate.test.mjs && npm test 2>&1 | tail -5`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint and commit** (two commits — one concern each)

```bash
cd extension && npm run lint && cd ..
git add extension/kb/db.mjs extension/graphkit/graph.mjs extension/tests/find-context-kinds.test.mjs
git commit -m "perf(server): let findContext callers skip slices they never render

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add extension/agents/planner.mjs extension/tests/planner-validate.test.mjs
git commit -m "fix(server): planner skips the unused code slice and nulls invented owners

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Atomic FTS code reindex

**Files:**
- Modify: `extension/connectors/git.mjs` (imports; `indexLocalRepo` ~L94-152)
- Test: `extension/tests/git-connector-atomic.test.mjs` (create)

**Interfaces:**
- Produces: `indexLocalRepo(userId, repoPath, { replace?, walk? })` — `walk` (async generator of absolute file paths) is injectable for tests; default is the module's `walkAsync`.

- [ ] **Step 1: Write the failing test**

```js
// indexLocalRepo deleted a repo's rows BEFORE an async walk, outside any
// transaction — a crash or error mid-walk left the repo with no code index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_git-atomic-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { indexLocalRepo } = await import('../connectors/git.mjs');
const U = users.registerUser(db.getDb(), {
  email: `ga-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'g',
}).id;
const REPO = fs.mkdtempSync(path.join(__dirname, '_ga-repo-'));
fs.writeFileSync(path.join(REPO, 'a.ts'), 'export const alphaMarker = 1;\n');

const codeRows = () => db.getDb()
  .prepare("SELECT COUNT(*) AS n FROM sources WHERE user_id=? AND kind='code' AND ref LIKE ?")
  .get(U, `${REPO}%`).n;

test.after(() => {
  db.closeDb();
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('a failed reindex keeps the previous rows', async () => {
  await indexLocalRepo(U, REPO);
  const before = codeRows();
  assert.ok(before > 0);
  async function* failingWalk() { yield path.join(REPO, 'a.ts'); throw new Error('disk vanished'); }
  await assert.rejects(indexLocalRepo(U, REPO, { walk: failingWalk }), /disk vanished/);
  assert.equal(codeRows(), before, 'the old index must survive a failed walk');
});

test('a successful reindex still replaces stale rows', async () => {
  fs.rmSync(path.join(REPO, 'a.ts'));
  fs.writeFileSync(path.join(REPO, 'b.ts'), 'export const bravo = 2;\n');
  await indexLocalRepo(U, REPO);
  const refs = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND kind='code'").all(U).map((r) => r.ref);
  assert.ok(refs.every((r) => !r.endsWith('a.ts')));
  assert.ok(refs.some((r) => r.endsWith('b.ts')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/git-connector-atomic.test.mjs`
Expected: test 1 FAIL (row count 0 after the failed walk, or `walk` ignored).

- [ ] **Step 3: Implement** in `connectors/git.mjs`

Change the kb import:

```js
import { ingestSources, deleteSourcesByPrefix, getDb } from '../kb/db.mjs';
```

In `indexLocalRepo`: delete the early `if (replace) { … deleteSourcesByPrefix(…) }` block, change the loop header to use the injectable walker, and replace the final write:

```js
  const replace = opts.replace !== false;
  const walk = typeof opts.walk === 'function' ? opts.walk : walkAsync;
```

```js
  for await (const filePath of walk(absRoot)) {
```

```js
  // Wipe-then-insert in ONE transaction, after the walk has finished: the old
  // order deleted first and walked asynchronously, so an error or crash
  // mid-walk left the repo with no code index at all. Ref prefix is the abs
  // path so two different roots don't clobber each other.
  const written = getDb().transaction(() => {
    if (replace) deleteSourcesByPrefix(userId, 'code', `${absRoot}${path.sep}`);
    return ingestSources(userId, items);
  })();
  return { repo: absRoot, filesScanned, filesIndexed, chunks: written };
```

(If `ingestSources` opens its own `db.transaction`, better-sqlite3 nests it as a savepoint — no change needed there.)

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/git-connector-atomic.test.mjs tests/git-connector-chunking.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/connectors/git.mjs extension/tests/git-connector-atomic.test.mjs
git commit -m "fix(server): make the FTS code reindex atomic

Rows were deleted before an async walk outside any transaction, so a failed
walk left the repo with no code index. Delete + insert now run in one
transaction after the walk.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd extension && npm test` — all green (baseline ~900+ tests).
- [ ] `cd extension && npm run lint` — 0 problems.
- [ ] Unsandboxed: `cd mac && swift build && LLMIDE_KEYCHAIN_BACKEND=memory swift test` — 0 failures.
- [ ] `bash mac/Scripts/feature-boundaries.sh` — exit 0.
- [ ] Manual smoke (optional, needs the running app + backend): in v2 chat on this repo, ask "where is the mobile PIN rotated"; the `find-code` result must contain no `affiliate` paths.
