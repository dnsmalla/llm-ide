# Graph as Contract — Phase C (Output Control) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two retrieval gaps Phase B pinned as `todo` tests, and give plan mode an in-turn feedback loop: the model checks every file, line and symbol its plan cites against disk and the repo-scoped code graph, and fixes the misses before presenting.

**Architecture:** (1) `searchCodeIndex` stops counting doc-only (tier-3) seed rows toward its early break, so a later token's exact title match is still probed. (2) The Mac sends the active repo's local path as an optional `agentContext.activeRepoRoot`; the server's new `resolveRepoScope` prefers it over the workspace rule, so a parent workspace holding several repos scopes to the one the user works in. (3) A new read tool `check-citations` (llmide MCP tool on v2, fence tool on legacy) validates a document's backticked paths, `path:line` ranges and code symbols, returning misses. (4) The plan-mode binding tells the model to call it before presenting a plan. Everything is additive: no HTTP endpoint, no wire-format change.

**Tech Stack:** Node 20+ ESM, better-sqlite3, `node --test`; Swift 6 toolchain (Swift 5 mode), XCTest.

**Spec:** `docs/superpowers/specs/2026-09-29-graph-as-contract-design.md` (Phase C row: "Server-side citation validator against `code_graph_nodes` (symbol exists, line in range), misses fed back for one revision"). Ruling recorded in the ledger: Phase C proceeds before Phase B metrics exist, because its items are verified correctness/control fixes, not metric-dependent tuning; blocking Execute on unresolved citations is out of scope (the in-turn loop feeds misses back first; blocking needs B's data to justify).

## Global Constraints

- Extension module boundaries are ESLint-enforced at zero violations (`kb` → `core` only; `llm_agent` → L0–L2 + graphkit/plugins/llm-sources/mcp); never add per-file exemptions.
- Every `kb/` helper takes `userId` first and calls `requireUser(userId)`.
- No HTTP endpoint and no wire-format change: `SERVER_API_VERSION` (57) is NOT bumped. `agentContext.activeRepoRoot` is an optional, additive JSON field; absent = today's behaviour.
- `check-citations` is kind `read`, never writes, never returns file contents — only paths, line numbers, symbol names and counts.
- `cd extension && npm run lint` passes with `--max-warnings 0`; `make docs-check` passes.
- Mac tests ALWAYS run as `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test …`, unsandboxed; `bash mac/Scripts/feature-boundaries.sh` exits 0.
- Conventional Commits, one concern per commit, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/graph-contract-phase-c` off `main`.

## File map

| File | Change |
|---|---|
| `extension/graphkit/graph.mjs` | seed loop counts only title-tier rows toward the early break |
| `extension/kb/code-graph.mjs` | `resolveRepoScope(userId, { activeRepoRoot, workspaceRoot })`, `existingSymbolTitles(userId, titles, { repoIds })` |
| `extension/kb/db.mjs` | re-exports |
| `extension/llm_agent/runtime/handlers/find-code.mjs` | scope via `resolveRepoScope` |
| `extension/llm_agent/tools/registry.mjs` | pass `activeRepoRoot`; register `check-citations` |
| `extension/llm_agent/runtime/handlers/check-citations.mjs` | new handler + pure `extractCitations` |
| `extension/llm_agent/global/check-citations.md` | new tool doc |
| `extension/llm_agent/runtime/plan-pipeline.mjs` | `VERIFY_CLAUSE` in `buildPlanBinding` |
| `mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift` | `activeRepoRoot: String?` |
| `mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistantPanel+Agent.swift` | populate it |
| Tests | `extension/tests/retrieval-golden.test.mjs` (flip todos), `code-graph-repo-scope.test.mjs`, `check-citations.test.mjs` (new), `plan-pipeline.test.mjs`; `mac/Tests/LlmIdeMacTests/AgentContextEncodingTests.swift` (new) |

---

### Task 1: Doc-only seeds no longer crowd out title matches

**Files:**
- Modify: `extension/graphkit/graph.mjs` (`searchCodeIndex` stage-1 loop)
- Test: `extension/tests/retrieval-golden.test.mjs` (flip the crowding `todo` to a normal test)

**Interfaces:** none new.

- [ ] **Step 1: Make the existing `todo` a real test** — in `retrieval-golden.test.mjs`, find the test whose `todo` reason is `'doc-only seeds crowd out title matches (Phase C/D)'` and remove the `{ todo: … }` options object (keep the name and body). Run `cd extension && node --test tests/retrieval-golden.test.mjs` — Expected: that test now FAILS (top 3 are doc-only rows).

- [ ] **Step 2: Implement** — in `searchCodeIndex`, replace the early-break line inside the stage-1 `for (const cand of seedCandidates(q))` loop:

```js
    if (byId.size >= seedLimit) break;
```

with:

```js
    // Only TITLE matches (tier 0-2) may end probing early. `searchCodeSymbols`
    // also matches `doc LIKE`, and now that declarations are uploaded as `doc`
    // a common long token fills the cap with tier-3 rows, so a later token's
    // exact title match was never probed. Probing is still bounded by
    // MAX_SEED_CANDIDATES; the cross-candidate re-rank below puts titles first.
    const titleHits = [...byId.values()].filter((r) => r.tier < 3).length;
    if (titleHits >= seedLimit) break;
```

- [ ] **Step 3: Run tests** — `cd extension && node --test tests/retrieval-golden.test.mjs tests/find-code.test.mjs tests/code-graph-repo-scope.test.mjs` — Expected: all PASS (the flipped test included; the sibling-leak test is still `todo`). If the flipped test still fails, report the actual top 3 and the query's `seedCandidates` list — do not loosen the assertion.

- [ ] **Step 4: Lint and commit**

```bash
cd extension && npm run lint && cd ..
git add extension/graphkit/graph.mjs extension/tests/retrieval-golden.test.mjs
git commit -m "fix(server): stop doc-only seeds from crowding out exact title matches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Scope find-code by the active repo when the client sends it

**Files:**
- Modify: `extension/kb/code-graph.mjs` (add `resolveRepoScope` after `workspaceRepoIds`)
- Modify: `extension/kb/db.mjs` (re-export `resolveRepoScope` in the code-graph export block)
- Modify: `extension/llm_agent/runtime/handlers/find-code.mjs` (scope call; JSDoc `@param ctx.activeRepoRoot`)
- Modify: `extension/llm_agent/tools/registry.mjs` (`find-code` entry passes `activeRepoRoot`)
- Test: `extension/tests/code-graph-repo-scope.test.mjs` (append), `extension/tests/retrieval-golden.test.mjs` (sibling test)

**Interfaces:**
- Produces: `resolveRepoScope(userId: string, { activeRepoRoot?: string, workspaceRoot?: string }) → string[] | null` — `workspaceRepoIds(userId, activeRepoRoot)` when that is non-null, else `workspaceRepoIds(userId, workspaceRoot)`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/code-graph-repo-scope.test.mjs` (it already has `db`, `U`, `WORKSPACE`, `WS_REPO`, `graph(name)` in scope):

```js
test('resolveRepoScope prefers the active repo over a parent workspace', () => {
  const sib = path.join(WORKSPACE, 'code', 'sibling');
  db.writeCodeGraph(U, sib, graph('siblingOnly'), { source: 'structure' });
  // Parent workspace alone sees both children.
  const both = db.resolveRepoScope(U, { workspaceRoot: WORKSPACE });
  assert.ok(both.includes(WS_REPO) && both.includes(sib));
  // With the active repo, only that one.
  assert.deepEqual(db.resolveRepoScope(U, { activeRepoRoot: WS_REPO, workspaceRoot: WORKSPACE }), [WS_REPO]);
});

test('resolveRepoScope falls back to the workspace when the active repo is not graphed', () => {
  const scoped = db.resolveRepoScope(U, { activeRepoRoot: '/not/graphed/anywhere', workspaceRoot: WORKSPACE });
  assert.ok(scoped.includes(WS_REPO));
});
```

In `extension/tests/retrieval-golden.test.mjs`, find the test whose `todo` reason starts with `'needs the active project repo from the client'`. Remove its `{ todo: … }` options object and add `activeRepoRoot: <the alpha repo path that test creates>` to the `ctx` object it passes to `handleFindCode` (keep its assertion that the sibling repo's symbol does not leak). Then add, right after it, a second test with the same fixture WITHOUT `activeRepoRoot` that asserts the documented fallback: both siblings' symbols ARE returned (name it `'parent workspace without an active repo searches every child repo (documented fallback)'`).

- [ ] **Step 2: Run to verify failure** — `cd extension && node --test tests/code-graph-repo-scope.test.mjs tests/retrieval-golden.test.mjs` — Expected: FAIL (`db.resolveRepoScope is not a function`; sibling test leaks).

- [ ] **Step 3: Implement**

`kb/code-graph.mjs`, directly after `workspaceRepoIds`:

```js
/**
 * The repo scope for a code-graph read. The client's active repo (the one the
 * user works in — `agentContext.activeRepoRoot`) wins when it is graphed;
 * otherwise the workspace rule applies. This is what fixes a parent workspace
 * holding several graphed repos, where the workspace rule alone returns all
 * of them. Returns null (unscoped) when neither matches anything.
 */
export function resolveRepoScope(userId, { activeRepoRoot = '', workspaceRoot = '' } = {}) {
  requireUser(userId);
  if (activeRepoRoot) {
    const active = workspaceRepoIds(userId, activeRepoRoot);
    if (active) return active;
  }
  return workspaceRoot ? workspaceRepoIds(userId, workspaceRoot) : null;
}
```

`kb/db.mjs`: add `resolveRepoScope` to the `export { … } from './code-graph.mjs';` list.

`find-code.mjs`: change the import to `import { resolveRepoScope } from '../../../kb/db.mjs';` (replacing `workspaceRepoIds` if it is the only use), add `const activeRepoRoot = typeof ctx.activeRepoRoot === 'string' ? ctx.activeRepoRoot : '';` next to `workspaceRoot`, and replace the scope line with:

```js
    const repoIds = resolveRepoScope(ctx.userId, { activeRepoRoot, workspaceRoot });
```

Add to the handler's JSDoc: `@param ctx.activeRepoRoot  the repo the user works in (client agentContext.activeRepoRoot) — preferred scope`.

`tools/registry.mjs` `find-code` entry:

```js
    execute: (args, ctx) => handleFindCode(args, {
      userId: ctx.userId,
      roots: ctx.readableRoots,
      workspaceRoot: ctx.agentContext?.workspaceRoot,
      activeRepoRoot: ctx.agentContext?.activeRepoRoot,
    }),
```

- [ ] **Step 4: Run tests** — `cd extension && node --test tests/code-graph-repo-scope.test.mjs tests/retrieval-golden.test.mjs tests/find-code.test.mjs` — Expected: PASS, with 0 `todo` left in retrieval-golden.

- [ ] **Step 5: Lint and commit**

```bash
cd extension && npm run lint && cd ..
git add extension/kb/code-graph.mjs extension/kb/db.mjs extension/llm_agent/runtime/handlers/find-code.mjs \
  extension/llm_agent/tools/registry.mjs extension/tests/code-graph-repo-scope.test.mjs extension/tests/retrieval-golden.test.mjs
git commit -m "fix(server): scope find-code to the client's active repo when it is graphed

A parent workspace holding several graphed repos searched all of them;
agentContext.activeRepoRoot now selects the one the user works in.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Mac sends `activeRepoRoot`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift` (`AgentContext`)
- Modify: `mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistantPanel+Agent.swift` (`buildAgentContext`)
- Test: `mac/Tests/LlmIdeMacTests/AgentContextEncodingTests.swift` (create)

**Interfaces:**
- Produces: `AgentContext.activeRepoRoot: String?` — absolute local path of the active saved repo clone (`config.activeRepoLocalURL?.path`), JSON key `activeRepoRoot`, omitted when nil.

- [ ] **Step 1: Write the failing test** — `mac/Tests/LlmIdeMacTests/AgentContextEncodingTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// agentContext.activeRepoRoot is the server's preferred code-graph scope
/// (resolveRepoScope). It must encode under that exact key, and be absent
/// (not null) when unknown so older servers see an unchanged payload.
final class AgentContextEncodingTests: XCTestCase {
    private func json(_ ctx: AgentContext) throws -> [String: Any] {
        let data = try JSONEncoder().encode(ctx)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testActiveRepoRootEncodesUnderItsKey() throws {
        var ctx = AgentContext(activeProject: nil, indexedRepos: [])
        ctx.activeRepoRoot = "/Users/me/code/app"
        XCTAssertEqual(try json(ctx)["activeRepoRoot"] as? String, "/Users/me/code/app")
    }

    func testActiveRepoRootIsOmittedWhenNil() throws {
        let ctx = AgentContext(activeProject: nil, indexedRepos: [])
        XCTAssertNil(try json(ctx)["activeRepoRoot"])
    }
}
```

(If `AgentContext`'s memberwise initializer requires more arguments than `activeProject`/`indexedRepos`, pass `nil` for the others; every property after `indexedRepos` is optional.)

- [ ] **Step 2: Run to verify failure** (unsandboxed) — `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter AgentContextEncodingTests` — Expected: compile FAIL (`activeRepoRoot` has no member).

- [ ] **Step 3: Implement**

`AgentTypes.swift`, inside `struct AgentContext`, after `var gitStatus: GitStatus?`:

```swift
    /// Absolute local path of the repo the user works in (the active saved
    /// GitLab/GitHub clone). The server prefers it as the code-graph scope
    /// (`resolveRepoScope`), which is what keeps a project folder holding
    /// several repos from answering with all of them. Optional for back-compat.
    var activeRepoRoot: String?
```

`CodeAssistantPanel+Agent.swift`, in `buildAgentContext()`, add `activeRepoRoot: config.activeRepoLocalURL?.path` as the last argument of the returned `AgentContext(…)` (after `gitStatus: gitStatus`).

- [ ] **Step 4: Run tests** (unsandboxed) — `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter AgentContextEncodingTests`, then the full suite once: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > "$TMPDIR/c3-full.log" 2>&1; tail -5 "$TMPDIR/c3-full.log"` and `/usr/bin/grep -E "Executed [0-9]{3,} tests" "$TMPDIR/c3-full.log" | tail -1` — Expected: 0 failures. Then `bash mac/Scripts/feature-boundaries.sh` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift \
  mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistantPanel+Agent.swift \
  mac/Tests/LlmIdeMacTests/AgentContextEncodingTests.swift
git commit -m "feat(mac): send the active repo root in the agent context

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `check-citations` tool

**Files:**
- Modify: `extension/kb/code-graph.mjs` (add `existingSymbolTitles`), `extension/kb/db.mjs` (re-export)
- Create: `extension/llm_agent/runtime/handlers/check-citations.mjs`
- Create: `extension/llm_agent/global/check-citations.md`
- Modify: `extension/llm_agent/tools/registry.mjs` (import + entry after `find-code`)
- Test: `extension/tests/check-citations.test.mjs` (create)

**Interfaces:**
- Consumes: `resolveRepoScope` (Task 2), `resolveAgentPath(rawPath, roots, workspaceRoot)` (exported from `find-code.mjs`), `hasCodeGraph(userId)` (kb/db.mjs).
- Produces:
  - `existingSymbolTitles(userId, titles: string[], { repoIds } = {}) → Set<string>`
  - `extractCitations(text: string) → { paths: Array<{ path, line: number|null, endLine: number|null }>, symbols: string[] }` (pure)
  - `handleCheckCitations(args: { text }, ctx: { userId, roots, workspaceRoot, activeRepoRoot }) → { ok: boolean, checked: { paths: number, symbols: number }, missingPaths: string[], lineOutOfRange: Array<{ path, line, lines }>, unknownSymbols: string[], graphChecked: boolean } | { error }`

- [ ] **Step 1: Write the failing test** — `extension/tests/check-citations.test.mjs`:

```js
// check-citations: the in-turn output check for plans. It must flag cited
// files that do not exist, `path:line` past the end of the file, and symbols
// the repo-scoped graph does not know — and never return file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_check-citations-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleCheckCitations, extractCitations } = await import('../llm_agent/runtime/handlers/check-citations.mjs');

const U = users.registerUser(db.getDb(), {
  email: `cc-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
}).id;
const WS = fs.mkdtempSync(path.join(__dirname, '_cc-ws-'));
fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
fs.writeFileSync(path.join(WS, 'src', 'pin.ts'), 'export function rotatePin() {}\n// two\n// three\n');
db.writeCodeGraph(U, WS, {
  nodes: [
    { id: 'file:src/pin.ts', title: 'pin.ts', kind: 'file', metadata: { source_file: 'src/pin.ts', line: 'L0' } },
    { id: 'function:src/pin.ts:rotatePin', title: 'rotatePin', kind: 'function', metadata: { source_file: 'src/pin.ts', line: 'L1' } },
  ],
  edges: [],
}, { source: 'structure' });
const ctx = { userId: U, roots: [WS], workspaceRoot: WS };

test.after(() => {
  db.closeDb();
  fs.rmSync(WS, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('extractCitations finds backticked paths with lines and code symbols', () => {
  const c = extractCitations('Edit `src/pin.ts:2`, `src/a/b.swift` and `README.md`, then call `rotatePin()` and `Store.save`. Not `the plan`.');
  assert.deepEqual(c.paths, [
    { path: 'src/pin.ts', line: 2, endLine: null },
    { path: 'src/a/b.swift', line: null, endLine: null },
    { path: 'README.md', line: null, endLine: null },
  ]);
  assert.deepEqual(c.symbols.sort(), ['rotatePin', 'save'].sort());
});

test('a clean plan is ok', () => {
  const out = handleCheckCitations({ text: 'Change `src/pin.ts:1` in `rotatePin()`.' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.graphChecked, true);
  assert.deepEqual([out.missingPaths, out.lineOutOfRange, out.unknownSymbols], [[], [], []]);
});

test('missing file, out-of-range line and unknown symbol are all reported', () => {
  const out = handleCheckCitations({ text: 'See `src/gone.ts`, `src/pin.ts:99` and `inventedHelper()`.' }, ctx);
  assert.equal(out.ok, false);
  assert.deepEqual(out.missingPaths, ['src/gone.ts']);
  assert.deepEqual(out.lineOutOfRange, [{ path: 'src/pin.ts', line: 99, lines: 3 }]);
  assert.deepEqual(out.unknownSymbols, ['inventedHelper']);
});

test('never returns file contents', () => {
  const out = handleCheckCitations({ text: '`src/pin.ts:1`' }, ctx);
  assert.ok(!JSON.stringify(out).includes('export function'));
});

test('without a scoped graph, symbols are not judged', () => {
  const out = handleCheckCitations({ text: '`inventedHelper()`' }, { userId: U, roots: [], workspaceRoot: '/nowhere' });
  assert.equal(out.graphChecked, false);
  assert.deepEqual(out.unknownSymbols, []);
});

test('rejects empty text', () => {
  assert.ok(handleCheckCitations({ text: '' }, ctx).error);
});
```

- [ ] **Step 2: Run to verify failure** — `cd extension && node --test tests/check-citations.test.mjs` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`kb/code-graph.mjs` (after `hydrateSymbols`):

```js
/** Which of `titles` exist as node titles in scope. Capped at 100 names. */
export function existingSymbolTitles(userId, titles, { repoIds = null } = {}) {
  requireUser(userId);
  const list = [...new Set((Array.isArray(titles) ? titles : []).filter((t) => typeof t === 'string' && t))].slice(0, 100);
  if (list.length === 0) return new Set();
  const scope = repoScope(repoIds);
  const rows = getDb().prepare(
    `SELECT DISTINCT title FROM code_graph_nodes
     WHERE user_id=?${scope.sql} AND title IN (${list.map(() => '?').join(',')})`,
  ).all(userId, ...scope.params, ...list);
  return new Set(rows.map((r) => r.title));
}
```

`kb/db.mjs`: add `existingSymbolTitles` to the code-graph re-export list.

`extension/llm_agent/runtime/handlers/check-citations.mjs`:

```js
// check-citations: the plan-mode output check. The model passes the document
// it is about to present; this reports every cited file that does not exist,
// every `path:line` past the end of its file, and every code symbol the
// repo-scoped graph does not know — so the model fixes them in the same turn.
// Read-only; returns names and numbers only, never file contents.
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentPath } from './find-code.mjs';
import { resolveRepoScope, existingSymbolTitles, hasCodeGraph } from '../../../kb/db.mjs';

const MAX_TEXT = 200_000;
const MAX_ITEMS = 100;
const MAX_LINECOUNT_BYTES = 2 * 1024 * 1024;

const SPAN = /`([^`\n]{2,200})`/g;
const PATH_RE = /^(?<p>(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.[A-Za-z0-9]{1,8})(?::(?<a>\d+)(?:-(?<b>\d+))?)?$/;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
// A bare `name.ext` (no slash) is a path only for real source/doc extensions;
// otherwise `Store.save` or `config.value` would be judged as missing files.
const KNOWN_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'swift', 'py', 'md', 'json',
  'yml', 'yaml', 'toml', 'sql', 'sh', 'go', 'rs', 'kt', 'java', 'c', 'h', 'cpp', 'm', 'mm',
  'html', 'css', 'txt', 'plist', 'xml']);

// A backticked word only counts as a code symbol when it LOOKS like one —
// camelCase, snake_case, a dotted member or a call — so `the plan` or `npm`
// are never judged against the graph.
function looksLikeSymbol(s) {
  return /\(\)$/.test(s) || s.includes('.') || s.includes('_') || /[a-z][A-Z]/.test(s);
}

export function extractCitations(text) {
  const paths = [];
  const symbols = new Set();
  const seenPaths = new Set();
  for (const m of String(text || '').matchAll(SPAN)) {
    const span = m[1].trim();
    const pm = PATH_RE.exec(span);
    const bareExt = pm && !pm.groups.p.includes('/') ? pm.groups.p.split('.').pop().toLowerCase() : null;
    if (pm && (pm.groups.p.includes('/') || KNOWN_EXT.has(bareExt))) {
      const key = `${pm.groups.p}:${pm.groups.a || ''}`;
      if (!seenPaths.has(key) && paths.length < MAX_ITEMS) {
        seenPaths.add(key);
        paths.push({
          path: pm.groups.p,
          line: pm.groups.a ? Number(pm.groups.a) : null,
          endLine: pm.groups.b ? Number(pm.groups.b) : null,
        });
      }
      continue;
    }
    if (SYMBOL_RE.test(span) && span.length >= 3 && span.length <= 80 && looksLikeSymbol(span)) {
      const last = span.replace(/\(\)$/, '').split('.').pop();
      if (last && symbols.size < MAX_ITEMS) symbols.add(last);
    }
  }
  return { paths, symbols: [...symbols] };
}

function lineCount(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_LINECOUNT_BYTES) return null;
    const body = fs.readFileSync(absPath, 'utf8');
    if (body.length === 0) return 0;
    return body.endsWith('\n') ? body.split('\n').length - 1 : body.split('\n').length;
  } catch {
    return null;
  }
}

function absoluteFor(relPath, roots, workspaceRoot) {
  const ordered = [workspaceRoot, ...roots].filter(Boolean);
  for (const root of ordered) {
    const abs = path.join(root, relPath);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

export function handleCheckCitations(args, ctx) {
  const text = typeof args?.text === 'string' ? args.text.slice(0, MAX_TEXT) : '';
  if (!text.trim()) return { error: 'text is required' };
  if (!ctx?.userId) return { error: 'not signed in' };
  const roots = Array.isArray(ctx.roots) ? ctx.roots : [];
  const workspaceRoot = typeof ctx.workspaceRoot === 'string' ? ctx.workspaceRoot : '';
  const activeRepoRoot = typeof ctx.activeRepoRoot === 'string' ? ctx.activeRepoRoot : '';

  const { paths, symbols } = extractCitations(text);
  const missingPaths = [];
  const lineOutOfRange = [];
  for (const c of paths) {
    const resolved = resolveAgentPath(c.path, roots, workspaceRoot);
    if (!resolved || !resolved.exists) { missingPaths.push(c.path); continue; }
    const want = c.endLine || c.line;
    if (!want) continue;
    const abs = absoluteFor(resolved.path, roots, workspaceRoot);
    const lines = abs ? lineCount(abs) : null;
    if (lines !== null && want > lines) lineOutOfRange.push({ path: c.path, line: want, lines });
  }

  let unknownSymbols = [];
  let graphChecked = false;
  try {
    const repoIds = resolveRepoScope(ctx.userId, { activeRepoRoot, workspaceRoot });
    // Only judge symbols against a graph that is scoped to THIS repo: an
    // unscoped or absent graph would call every real symbol "unknown".
    if (repoIds && hasCodeGraph(ctx.userId) && symbols.length > 0) {
      const known = existingSymbolTitles(ctx.userId, symbols, { repoIds });
      unknownSymbols = symbols.filter((s) => !known.has(s));
      graphChecked = true;
    } else if (repoIds && hasCodeGraph(ctx.userId)) {
      graphChecked = true;
    }
  } catch {
    graphChecked = false;
    unknownSymbols = [];
  }

  return {
    ok: missingPaths.length === 0 && lineOutOfRange.length === 0 && unknownSymbols.length === 0,
    checked: { paths: paths.length, symbols: symbols.length },
    missingPaths,
    lineOutOfRange,
    unknownSymbols,
    graphChecked,
  };
}
```

`extension/llm_agent/global/check-citations.md`:

```md
---
name: check-citations
kind: read
description: Check a plan or answer you are about to present — reports every cited file that does not exist, every `path:line` past the end of its file, and every code symbol the project's code graph does not know. Call it on the full document before presenting a plan.
schema:
  text:
    type: string
    required: true
    maxLength: 200000
    description: The full document to check, exactly as you will present it (markdown; citations are the backticked paths, `path:line` references and code symbols in it).
---

# check-citations

Validates the citations in a document against the project on disk and its code
graph, so a plan never sends Execute to a file, line or function that does not
exist.

## What it checks

- Backticked **paths** (`src/app/view.ts`) — the file must exist in the open
  workspace or an indexed repo.
- Backticked **`path:line`** or **`path:start-end`** — the line must be inside the file.
- Backticked **code symbols** (`rotatePin()`, `Store.save`, `snake_case`) — the
  name must exist in the code graph for the repo you are working in. Skipped
  (`graphChecked: false`) when no repo-scoped graph exists.

## How to use it

Call it once with the whole document before you present it. Fix or remove every
entry in `missingPaths`, `lineOutOfRange` and `unknownSymbols` — look the right
name or line up with `find-code` — then present the corrected document. `ok:
true` means nothing it could check was wrong. It returns only names and
numbers, never file contents.
```

`tools/registry.mjs`: import `import { handleCheckCitations } from '../runtime/handlers/check-citations.mjs';` next to the find-code import, and add after the `find-code` entry:

```js
  {
    name: 'check-citations',
    kind: 'read',
    execute: (args, ctx) => handleCheckCitations(args, {
      userId: ctx.userId,
      roots: ctx.readableRoots,
      workspaceRoot: ctx.agentContext?.workspaceRoot,
      activeRepoRoot: ctx.agentContext?.activeRepoRoot,
    }),
  },
```

- [ ] **Step 4: Run tests** — `cd extension && node --test tests/check-citations.test.mjs`, then `npm test` once (unsandboxed). If any existing test pins the tool roster or the global tool-doc list (e.g. a test enumerating `llm_agent/global/*.md` or the registry names), update it to include `check-citations` and say so in your report. Then `npm run lint` and `cd .. && make docs-check` (unsandboxed).

- [ ] **Step 5: Commit** (two commits)

```bash
git add extension/kb/code-graph.mjs extension/kb/db.mjs
git commit -m "feat(server): look up which symbol names exist in a repo-scoped graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add extension/llm_agent/runtime/handlers/check-citations.mjs extension/llm_agent/global/check-citations.md \
  extension/llm_agent/tools/registry.mjs extension/tests/check-citations.test.mjs
# plus any roster test you had to update
git commit -m "feat(server): add a check-citations read tool for plan output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Plan mode verifies its citations before presenting

**Files:**
- Modify: `extension/llm_agent/runtime/plan-pipeline.mjs` (new `VERIFY_CLAUSE`; used in `buildPlanBinding`)
- Test: `extension/tests/plan-pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: the `check-citations` tool (Task 4).

- [ ] **Step 1: Write the failing test** — append to `extension/tests/plan-pipeline.test.mjs` (import `buildPlanBinding` if the file does not already):

```js
test('plan bindings tell the model to check citations before presenting', () => {
  for (const engine of ['agent', 'legacy']) {
    for (const mode of ['plan', 'assist_plan']) {
      const text = buildPlanBinding(mode, { skillName: 'brainstorming', engine });
      assert.match(text, /`check-citations`/, `${mode}/${engine}`);
      assert.match(text, /before you present/i, `${mode}/${engine}`);
    }
  }
});
```

- [ ] **Step 2: Run to verify failure** — `cd extension && node --test tests/plan-pipeline.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** — in `plan-pipeline.mjs`, directly after the `FACTS_CLAUSE` constant, add:

```js
// The output half of the graph contract: a plan that cites a file, line or
// function that does not exist sends Execute to the wrong place, and the Mac's
// disk-only check runs after the turn, when the model can no longer fix it.
const VERIFY_CLAUSE =
  '- **Verify before you present.** Before you present a finished plan, call '
  + '`check-citations` with its full text. Fix or remove every entry it reports '
  + 'in `missingPaths`, `lineOutOfRange` and `unknownSymbols` (look the right '
  + 'name or line up with `find-code`), then present the corrected plan. One '
  + 'call per plan; skip it only for a reply that cites no code.';
```

and in `buildPlanBinding`, change

```js
    + `${FACTS_CLAUSE}\n`
    + '- **No other write tool.** …
```

to insert the verify clause between them:

```js
    + `${FACTS_CLAUSE}\n`
    + `${VERIFY_CLAUSE}\n`
```

(leave the `- **No other write tool.**` line that follows unchanged).

- [ ] **Step 4: Run tests** — `cd extension && node --test tests/plan-pipeline.test.mjs` then `npm test` once (unsandboxed); if a snapshot/length test on the plan binding fails, update it and say so. `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/runtime/plan-pipeline.mjs extension/tests/plan-pipeline.test.mjs
git commit -m "feat(server): plan mode checks its citations before presenting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd extension && npm test` — green, and `retrieval-golden.test.mjs` has 0 `todo`.
- [ ] `cd extension && npm run lint` — 0 problems; `make docs-check` — passes.
- [ ] Unsandboxed: `cd mac && swift build && LLMIDE_KEYCHAIN_BACKEND=memory swift test` — 0 failures; `bash mac/Scripts/feature-boundaries.sh` — exit 0.
