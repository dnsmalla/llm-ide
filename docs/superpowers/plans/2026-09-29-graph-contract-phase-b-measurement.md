# Graph as Contract — Phase B (Measurement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "does the graph save tokens?" answerable from data: durable per-turn tool accounting linked to the usage ledger, a golden-query retrieval test, and a read-only report.

**Architecture:** A new `turn_tool_events` table (migration 0035) records, per turn, every tool the model called (native `Read`/`Grep`/… and `mcp__llmide__*`) with its result size, keyed by a `turn_id` that is also written as `usage_ledger.request_id`. The v2 route observes tool calls from the event stream it already forwards (one place covers native and llmide tools); the legacy route records its always-on memory push. A pure summary function powers a CLI report and is unit-tested.

**Tech Stack:** Node 20+ ESM, better-sqlite3, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-29-graph-as-contract-design.md`

**Depends on:** Phase A Task 1 (repo scoping) for Task 4 below. Tasks 1–3 and 5 are independent of Phase A.

## Global Constraints

- Extension module boundaries are ESLint-enforced at zero violations; `kb/` imports `core/` only; `routes/` may import any Node layer; nothing imports a route module.
- Every `kb/` helper takes `userId` first and calls `requireUser(userId)`; best-effort telemetry writes must never throw into a model call (wrap in try/catch, return null).
- Append-only numbered migrations under `extension/kb/migrations/`; update the range in `CLAUDE.md` ("0001–0034" → "0001–0035").
- NEVER store tool arguments or result text — only names, sizes and flags (tool results carry file contents, commands and user prose).
- No HTTP wire-format change: `SERVER_API_VERSION` (57) is NOT bumped; no new endpoint.
- Only ONE Node process writes the DB; the report script opens it `readonly`.
- `cd extension && npm run lint` passes with `--max-warnings 0`; `make docs-check` passes.
- Conventional Commits, one concern per commit, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/graph-contract-phase-b` off `main` (after Phase A merges, for Task 4).

## File map

| File | Responsibility |
|---|---|
| `extension/kb/migrations/0035_turn_tool_events.sql` | table + indexes |
| `extension/kb/tool-events.mjs` | `recordToolEvents`, `summarizeToolEvents` |
| `extension/kb/db.mjs` | re-exports |
| `extension/llm_agent/sdk/tool-accounting.mjs` | pure stream observer: tool_use_start/tool_result → events |
| `extension/routes/agent-v2.mjs` | turn id, observe, persist, ledger `requestId` |
| `extension/llm_agent/runtime/route.mjs` | legacy `memory_push` event |
| `extension/scripts/retrieval-report.mjs` | read-only CLI report |
| `extension/tests/tool-events.test.mjs`, `tool-accounting.test.mjs`, `retrieval-golden.test.mjs` | tests |

---

### Task 1: `turn_tool_events` table and store

**Files:**
- Create: `extension/kb/migrations/0035_turn_tool_events.sql`
- Create: `extension/kb/tool-events.mjs`
- Modify: `extension/kb/db.mjs` (add a re-export line next to the code-graph re-exports ~L499)
- Modify: `CLAUDE.md` (the "Append-only migrations" bullet)
- Test: `extension/tests/tool-events.test.mjs`

**Interfaces:**
- Produces:
  - `recordToolEvents(userId: string, { turnId: string, engine: 'v2'|'legacy', mode?: string|null, events: Array<{ tool: string, resultChars: number, truncated?: boolean, isError?: boolean }> }) → number` (rows written; 0 on any failure)
  - `summarizeToolEvents(userId: string|null, { days = 7 } = {}) → { turns: number, turnsWithFindCode: number, findCodeFirstTurns: number, byTool: Array<{ tool, calls, avgChars }>, tokensWithFindCode: TokenAvg|null, tokensWithoutFindCode: TokenAvg|null }` where `TokenAvg = { turns, input, cacheRead, cacheCreation, output }` (per-turn averages over ledger rows joined on `request_id = turn_id`). `userId = null` = all users (report only).

- [ ] **Step 1: Write the failing test** — `extension/tests/tool-events.test.mjs`:

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
const tmpDb = path.join(__dirname, '_tool-events-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { recordUsage } = await import('../kb/usage.mjs');
const U = users.registerUser(db.getDb(), {
  email: `te-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 't',
}).id;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('recordToolEvents writes one row per event and never stores text', () => {
  const n = db.recordToolEvents(U, {
    turnId: 't1', engine: 'v2', mode: 'execute',
    events: [{ tool: 'find-code', resultChars: 900 }, { tool: 'Read', resultChars: 4000, truncated: false }],
  });
  assert.equal(n, 2);
  const cols = db.getDb().prepare('PRAGMA table_info(turn_tool_events)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /arg|text|content|body/.test(c)), 'no column may hold tool text');
});

test('recordToolEvents is best-effort: bad input returns 0, never throws', () => {
  assert.equal(db.recordToolEvents(U, { turnId: '', engine: 'v2', events: [{ tool: 'x', resultChars: 1 }] }), 0);
  assert.equal(db.recordToolEvents(U, { turnId: 't9', engine: 'v2', events: 'nope' }), 0);
});

test('summarizeToolEvents: find-code share, order, and token split via the ledger', () => {
  // t1 (above): find-code THEN Read. t2: Read only.
  db.recordToolEvents(U, { turnId: 't2', engine: 'v2', events: [{ tool: 'Read', resultChars: 20000, truncated: true }] });
  recordUsage(db.getDb(), { userId: U, provider: 'anthropic', model: 'm', endpoint: '/agent/v2/stream',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 1000, requestId: 't1' });
  recordUsage(db.getDb(), { userId: U, provider: 'anthropic', model: 'm', endpoint: '/agent/v2/stream',
    inputTokens: 20, outputTokens: 7, cacheReadTokens: 200, cacheCreationTokens: 9000, requestId: 't2' });

  const s = db.summarizeToolEvents(U, { days: 7 });
  assert.equal(s.turns, 2);
  assert.equal(s.turnsWithFindCode, 1);
  assert.equal(s.findCodeFirstTurns, 1);
  const read = s.byTool.find((r) => r.tool === 'Read');
  assert.equal(read.calls, 2);
  assert.equal(read.avgChars, 12000);
  assert.equal(s.tokensWithFindCode.cacheCreation, 1000);
  assert.equal(s.tokensWithoutFindCode.cacheCreation, 9000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/tool-events.test.mjs`
Expected: FAIL — `db.recordToolEvents is not a function`.

- [ ] **Step 3: Create the migration** — `extension/kb/migrations/0035_turn_tool_events.sql`:

```sql
-- Per-turn tool accounting. The usage ledger records a turn's tokens but not
-- what the model DID, so "does the code graph save tokens?" was unanswerable:
-- skill_invoked audit lines live only in kb/server.log, rotated every start.
--
-- One row per tool call the model made in a turn — native (Read, Grep, Bash…)
-- and llmide MCP tools (normalized to their bare name, e.g. find-code) — plus
-- the legacy engine's always-on repo-memory push (tool = 'memory_push').
-- turn_id is also written as usage_ledger.request_id, which is the join.
--
-- Names and sizes only. Tool arguments and results carry file contents, shell
-- commands and user prose; none of it belongs here.
CREATE TABLE IF NOT EXISTS turn_tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  mode TEXT,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  result_chars INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_tool_events_user_time ON turn_tool_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_tool_events_turn ON turn_tool_events(turn_id);
```

- [ ] **Step 4: Create the store** — `extension/kb/tool-events.mjs`:

```js
// Per-turn tool accounting (migration 0035). Best-effort by contract: a
// telemetry write must never break a model turn.
import { getDb, requireUser } from './db.mjs';

const MAX_EVENTS_PER_TURN = 200;
const clampInt = (v) => Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(v) || 0)));
const clampStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

export function recordToolEvents(userId, { turnId, engine, mode = null, events } = {}) {
  try {
    requireUser(userId);
    if (typeof turnId !== 'string' || !turnId) return 0;
    if (engine !== 'v2' && engine !== 'legacy') return 0;
    if (!Array.isArray(events) || events.length === 0) return 0;
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO turn_tool_events
         (user_id, turn_id, engine, mode, seq, tool, result_chars, truncated, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    db.transaction(() => {
      events.slice(0, MAX_EVENTS_PER_TURN).forEach((e, seq) => {
        const tool = clampStr(e?.tool, 128);
        if (!tool) return;
        insert.run(userId, clampStr(turnId, 128), engine, clampStr(mode, 32), seq, tool,
          clampInt(e.resultChars), e.truncated ? 1 : 0, e.isError ? 1 : 0);
        written += 1;
      });
    })();
    return written;
  } catch {
    return 0;
  }
}

/** Aggregate for the report. userId null = every user (operator report only). */
export function summarizeToolEvents(userId, { days = 7 } = {}) {
  if (userId !== null) requireUser(userId);
  const db = getDb();
  const since = `-${Math.max(1, Math.min(365, Math.trunc(Number(days) || 7)))} days`;
  const userSql = userId === null ? '' : ' AND user_id = ?';
  const binds = userId === null ? [since] : [since, userId];
  const window = `created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)${userSql}`;

  const turnIds = db.prepare(
    `SELECT DISTINCT turn_id FROM turn_tool_events WHERE ${window}`,
  ).all(...binds).map((r) => r.turn_id);

  const byTool = db.prepare(
    `SELECT tool, COUNT(*) AS calls, CAST(ROUND(AVG(result_chars)) AS INTEGER) AS avgChars
     FROM turn_tool_events WHERE ${window} GROUP BY tool ORDER BY calls DESC`,
  ).all(...binds);

  // Per turn: did find-code run, and did it run before the first Read/Grep/Glob?
  const perTurn = db.prepare(
    `SELECT turn_id,
            MIN(CASE WHEN tool = 'find-code' THEN seq END) AS fc,
            MIN(CASE WHEN tool IN ('Read','Grep','Glob') THEN seq END) AS native
     FROM turn_tool_events WHERE ${window} GROUP BY turn_id`,
  ).all(...binds);
  const withFc = perTurn.filter((t) => t.fc !== null).map((t) => t.turn_id);
  const withoutFc = perTurn.filter((t) => t.fc === null).map((t) => t.turn_id);
  const fcFirst = perTurn.filter((t) => t.fc !== null && (t.native === null || t.fc < t.native)).length;

  const tokenAvg = (ids) => {
    if (ids.length === 0) return null;
    const place = ids.map(() => '?').join(',');
    // Sum a turn's ledger rows first (a turn can meter several models), then
    // average across turns.
    const row = db.prepare(
      `SELECT COUNT(*) AS turns, AVG(i) AS input, AVG(cr) AS cacheRead,
              AVG(cc) AS cacheCreation, AVG(o) AS output
       FROM (SELECT request_id,
                    SUM(COALESCE(input_tokens,0)) AS i, SUM(COALESCE(cache_read_tokens,0)) AS cr,
                    SUM(COALESCE(cache_creation_tokens,0)) AS cc, SUM(COALESCE(output_tokens,0)) AS o
             FROM usage_ledger WHERE request_id IN (${place}) GROUP BY request_id)`,
    ).get(...ids);
    if (!row || !row.turns) return null;
    const r = (v) => Math.round(v || 0);
    return { turns: row.turns, input: r(row.input), cacheRead: r(row.cacheRead),
      cacheCreation: r(row.cacheCreation), output: r(row.output) };
  };

  return {
    turns: turnIds.length,
    turnsWithFindCode: withFc.length,
    findCodeFirstTurns: fcFirst,
    byTool,
    tokensWithFindCode: tokenAvg(withFc),
    tokensWithoutFindCode: tokenAvg(withoutFc),
  };
}
```

In `extension/kb/db.mjs`, next to the code-graph re-export block, add:

```js
// Per-turn tool accounting (migration 0035).
export { recordToolEvents, summarizeToolEvents } from './tool-events.mjs';
```

In `CLAUDE.md`, change `(0001–0034)` to `(0001–0035)`.

- [ ] **Step 5: Run tests**

Run: `cd extension && node --test tests/tool-events.test.mjs tests/code-graph-migration.test.mjs`
Expected: PASS.

- [ ] **Step 6: Lint, docs check, commit**

```bash
cd extension && npm run lint && cd .. && make docs-check
git add extension/kb/migrations/0035_turn_tool_events.sql extension/kb/tool-events.mjs extension/kb/db.mjs \
  extension/tests/tool-events.test.mjs CLAUDE.md
git commit -m "feat(server): add per-turn tool accounting table and summary

Records which tools a turn called and how large their results were (names
and sizes only), keyed by a turn id that joins usage_ledger.request_id, so
retrieval's effect on tokens becomes measurable.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Observe v2 turns and link them to the ledger

**Files:**
- Create: `extension/llm_agent/sdk/tool-accounting.mjs`
- Modify: `extension/routes/agent-v2.mjs` (imports; `onEvent` ~L335; ledger loop ~L423-425; end of handler before `if (!res.writableEnded) res.end();`)
- Test: `extension/tests/tool-accounting.test.mjs`

**Interfaces:**
- Consumes: `recordToolEvents` (Task 1).
- Produces: `createToolAccounting() → { observe(ev): void, events(): Array<{ tool, resultChars, truncated, isError }> }`; `normalizeToolName(name: string) → string` (`mcp__llmide__find-code` → `find-code`; other names unchanged).

- [ ] **Step 1: Write the failing test** — `extension/tests/tool-accounting.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolAccounting, normalizeToolName } from '../llm_agent/sdk/tool-accounting.mjs';

test('normalizeToolName strips the llmide MCP prefix only', () => {
  assert.equal(normalizeToolName('mcp__llmide__find-code'), 'find-code');
  assert.equal(normalizeToolName('Read'), 'Read');
  assert.equal(normalizeToolName('mcp__other__x'), 'mcp__other__x');
});

test('pairs tool_result with its tool_use_start by id, in result order', () => {
  const acc = createToolAccounting();
  acc.observe({ type: 'tool_use_start', index: 0, id: 'a', name: 'mcp__llmide__find-code' });
  acc.observe({ type: 'tool_use_start', index: 1, id: 'b', name: 'Read' });
  acc.observe({ type: 'delta', text: 'ignored' });
  acc.observe({ type: 'tool_result', toolUseId: 'b', isError: false, text: 'x'.repeat(40), truncated: false });
  acc.observe({ type: 'tool_result', toolUseId: 'a', isError: true, text: 'err', truncated: false });
  assert.deepEqual(acc.events(), [
    { tool: 'Read', resultChars: 40, truncated: false, isError: false },
    { tool: 'find-code', resultChars: 3, truncated: false, isError: true },
  ]);
});

test('a result with no known start is recorded as unknown, never dropped silently', () => {
  const acc = createToolAccounting();
  acc.observe({ type: 'tool_result', toolUseId: 'zz', text: 'abc', truncated: true });
  assert.deepEqual(acc.events(), [{ tool: 'unknown', resultChars: 3, truncated: true, isError: false }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/tool-accounting.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `extension/llm_agent/sdk/tool-accounting.mjs`:

```js
// Per-turn tool accounting from the v2 event stream the route already
// forwards: `tool_use_start` names a call, `tool_result` carries its (capped)
// output. One observer covers native SDK tools (Read, Grep, Bash…) and the
// llmide MCP tools alike. Names and sizes only — never the text.

const LLMIDE_PREFIX = 'mcp__llmide__';

export function normalizeToolName(name) {
  const n = typeof name === 'string' ? name : '';
  return n.startsWith(LLMIDE_PREFIX) ? n.slice(LLMIDE_PREFIX.length) : n;
}

export function createToolAccounting() {
  const nameById = new Map();
  const out = [];
  return {
    observe(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'tool_use_start' && typeof ev.id === 'string') {
        nameById.set(ev.id, normalizeToolName(ev.name));
        return;
      }
      if (ev.type === 'tool_result') {
        out.push({
          tool: nameById.get(ev.toolUseId) || 'unknown',
          // events.mjs caps text at 20k chars and sets `truncated` — so a
          // truncated result means "at least" this many.
          resultChars: typeof ev.text === 'string' ? ev.text.length : 0,
          truncated: ev.truncated === true,
          isError: ev.isError === true,
        });
      }
    },
    events() { return out.slice(); },
  };
}
```

In `extension/routes/agent-v2.mjs`:

Add imports:

```js
import { randomUUID } from 'node:crypto';
import { createToolAccounting } from '../llm_agent/sdk/tool-accounting.mjs';
import { recordToolEvents } from '../kb/tool-events.mjs';
```

Just before `const onEvent = (ev) => {`, add:

```js
  // Joins this turn's tool accounting (turn_tool_events) to its ledger rows
  // (usage_ledger.request_id), which were written with no request id before.
  const turnId = randomUUID();
  const toolAccounting = createToolAccounting();
```

Inside `onEvent`, directly after `send(ev);`, add:

```js
    toolAccounting.observe(ev);
```

Change the ledger loop to:

```js
    for (const row of ledgerRowsForTurn(meteredModel, usageTotals)) {
      recordUsage(db, { userId, provider, requestId: turnId, ...row });
    }
```

Immediately before the handler's final `if (!res.writableEnded) res.end();`, add:

```js
  // Every exit path — success, Stop, failure: a stopped turn's tool calls
  // still cost tokens and are exactly the data the report needs.
  recordToolEvents(userId, { turnId, engine: 'v2', mode, events: toolAccounting.events() });
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/tool-accounting.test.mjs && node --test tests/agent-v2*.test.mjs`
Expected: PASS (route tests stub `runTurn`, so the new calls run against the test DB).

- [ ] **Step 5: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/llm_agent/sdk/tool-accounting.mjs extension/routes/agent-v2.mjs extension/tests/tool-accounting.test.mjs
git commit -m "feat(server): record each v2 turn's tool calls and link them to the ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Record the legacy engine's memory push

**Files:**
- Modify: `extension/llm_agent/runtime/route.mjs` (imports; after the memory block is appended ~L309-325)
- Test: `extension/tests/tool-events.test.mjs` (append)

**Interfaces:**
- Consumes: `recordToolEvents` (Task 1).
- Produces: `memoryPushEvent(memoryChars: number) → Array<{ tool: 'memory_push', resultChars: number }>` in `extension/llm_agent/runtime/memory-push-event.mjs` — tiny pure helper so the route change is testable without a model.

- [ ] **Step 1: Write the failing test** — append to `extension/tests/tool-events.test.mjs`:

```js
test('legacy memory push becomes one memory_push event, none when empty', async () => {
  const { memoryPushEvent } = await import('../llm_agent/runtime/memory-push-event.mjs');
  assert.deepEqual(memoryPushEvent(0), []);
  assert.deepEqual(memoryPushEvent(1234), [{ tool: 'memory_push', resultChars: 1234 }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/tool-events.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `extension/llm_agent/runtime/memory-push-event.mjs`:

```js
// The legacy engine pushes repo memory into every turn's system prompt; this
// records its size as a turn_tool_events row so the report can weigh it
// against v2's pull-based find-code/project_memory.
export function memoryPushEvent(memoryChars) {
  const n = Math.trunc(Number(memoryChars) || 0);
  return n > 0 ? [{ tool: 'memory_push', resultChars: n }] : [];
}
```

In `route.mjs`, add imports:

```js
import { randomUUID } from 'node:crypto';
import { recordToolEvents } from '../../kb/tool-events.mjs';
import { memoryPushEvent } from './memory-push-event.mjs';
```

Find the line `const memoryUsage = { chars: memoryChars, approxTokens: Math.round(memoryChars / 4), hasChatMemory: memoryHasChat };` (~L644) and add directly after it:

```js
  // Best-effort; never breaks code-assist (recordToolEvents swallows errors).
  recordToolEvents(userId, { turnId: randomUUID(), engine: 'legacy', events: memoryPushEvent(memoryChars) });
```

(If `route.mjs` already imports `randomUUID`, reuse that import instead of adding a second one.)

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/tool-events.test.mjs && npm test 2>&1 | tail -5`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/llm_agent/runtime/route.mjs extension/llm_agent/runtime/memory-push-event.mjs extension/tests/tool-events.test.mjs
git commit -m "feat(server): record the legacy engine's repo-memory push per turn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Golden-query retrieval test (quality + payload budget)

**Files:**
- Test: `extension/tests/retrieval-golden.test.mjs` (create)

**Interfaces:**
- Consumes: `handleFindCode(args, ctx)` and Phase A's workspace scoping.

- [ ] **Step 1: Write the test**

```js
// Golden queries for find-code: the right symbol must rank in the top 3, the
// open workspace's repo must not be polluted by another repo, and the payload
// the model receives must stay within budget. Fixture mirrors the live shapes
// (repo-relative ids, INDEXED clone path under the project folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_retrieval-golden-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');
const U = users.registerUser(db.getDb(), {
  email: `rg-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'g',
}).id;

const WORKSPACE = fs.mkdtempSync(path.join(__dirname, '_rg-ws-'));
const REPO = path.join(WORKSPACE, 'code', 'llm-ide');
const OTHER = '/Users/someone/affiliate';

// ~1k tokens: a find-code answer must stay well under a whole-file read.
const PAYLOAD_BUDGET_CHARS = 4000;

const sym = (file, name, kind, line) => ({
  id: `${kind}:${file}:${name}`, title: name, kind,
  metadata: { source_file: file, line: `L${line}` },
});
const file = (f) => ({ id: `file:${f}`, title: path.basename(f), kind: 'file', metadata: { source_file: f, line: 'L0' } });

// expectAny: any of these in the top 3 passes. The natural-language query can
// only reach `MobilePin` today — seeding is a token LIKE, and "rotated" does
// not match `rotateInMemory`. That gap is the Phase C/D baseline; widen this
// entry to require `rotateInMemory` alone once seeding handles stems.
const GOLDEN = [
  { query: 'rotateInMemory', expectAny: ['rotateInMemory'] },
  { query: 'where is the mobile PIN rotated', expectAny: ['rotateInMemory', 'MobilePin'] },
  { query: 'LoopEngineRunner retry stage', expectAny: ['LoopEngineRunner'] },
  { query: 'findGraphContext', expectAny: ['findGraphContext'] },
];

test.before(() => {
  const files = ['mac/MobilePin.swift', 'mac/LoopEngineRunner.swift', 'extension/graphkit/graph.mjs'];
  db.writeCodeGraph(U, REPO, {
    nodes: [
      ...files.map(file),
      sym('mac/MobilePin.swift', 'MobilePin', 'classType', 10),
      sym('mac/MobilePin.swift', 'rotateInMemory', 'function', 42),
      sym('mac/LoopEngineRunner.swift', 'LoopEngineRunner', 'classType', 20),
      sym('mac/LoopEngineRunner.swift', 'retryStage', 'function', 300),
      sym('extension/graphkit/graph.mjs', 'findGraphContext', 'function', 79),
    ],
    edges: [
      { fromId: 'file:mac/MobilePin.swift', toId: 'function:mac/MobilePin.swift:rotateInMemory', kind: 'contains' },
      { fromId: 'file:mac/LoopEngineRunner.swift', toId: 'classType:mac/LoopEngineRunner.swift:LoopEngineRunner', kind: 'contains' },
    ],
  }, { source: 'structure' });
  // The affiliate repo shares generic names — the live pollution case.
  db.writeCodeGraph(U, OTHER, {
    nodes: [file('src/jobs/runner.ts'), sym('src/jobs/runner.ts', 'retryStage', 'function', 5),
      sym('src/jobs/runner.ts', 'LoopRunner', 'classType', 1)],
    edges: [],
  }, { source: 'structure' });
});

test.after(() => {
  db.closeDb();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

for (const g of GOLDEN) {
  test(`golden: "${g.query}"`, () => {
    const out = handleFindCode({ query: g.query }, { userId: U, roots: [WORKSPACE], workspaceRoot: WORKSPACE });
    const top3 = out.symbols.slice(0, 3).map((s) => s.name);
    assert.ok(g.expectAny.some((n) => top3.includes(n)),
      `expected one of ${JSON.stringify(g.expectAny)} in top 3, got ${JSON.stringify(top3)}`);
    const all = [...out.symbols, ...out.related].map((s) => s.path);
    assert.ok(!all.some((p) => p.startsWith('src/jobs/')), 'affiliate repo leaked into this workspace');
    const size = JSON.stringify(out).length;
    assert.ok(size <= PAYLOAD_BUDGET_CHARS, `payload ${size} chars > budget ${PAYLOAD_BUDGET_CHARS}`);
  });
}
```

- [ ] **Step 2: Run it**

Run: `cd extension && node --test tests/retrieval-golden.test.mjs`
Expected: PASS once Phase A Task 1 is merged (before it, the affiliate-leak assertion fails on the `retry stage` query — which is the point). If a case fails for any other reason, that is a real retrieval-quality finding: record the actual ranking in the commit message and fix the retrieval, never the assertion.

- [ ] **Step 3: Commit**

```bash
git add extension/tests/retrieval-golden.test.mjs
git commit -m "test(server): golden-query retrieval test for find-code quality and payload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Read-only retrieval report

**Files:**
- Create: `extension/scripts/retrieval-report.mjs`
- Modify: `extension/package.json` (add a `report:retrieval` script)

**Interfaces:**
- Consumes: `summarizeToolEvents(null, { days })` (Task 1, already unit-tested).

- [ ] **Step 1: Implement**

```js
#!/usr/bin/env node
// Retrieval report: does the code graph actually save tokens?
//
//   npm run report:retrieval -- [--days 7]
//
// Read-only. Points LLMIDE_DB_PATH at the live DB unless already set, and
// opens it through the normal kb layer (which only reads here). Safe to run
// while the server is up: WAL readers never block the writer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LLMIDE_DB_PATH ||= path.resolve(__dirname, '..', '..', 'kb', 'data.db');

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;

const { summarizeToolEvents, closeDb } = await import('../kb/db.mjs');
const s = summarizeToolEvents(null, { days });

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const tok = (t) => (t
  ? `${t.turns} turns · input ${t.input} · cache-read ${t.cacheRead} · cache-write ${t.cacheCreation} · output ${t.output}`
  : 'no data');

console.log(`Retrieval report — last ${days} day(s) — ${process.env.LLMIDE_DB_PATH}\n`);
console.log(`Turns with tool calls:        ${s.turns}`);
console.log(`Turns using find-code:        ${s.turnsWithFindCode} (${pct(s.turnsWithFindCode, s.turns)})`);
console.log(`find-code before Read/Grep:   ${s.findCodeFirstTurns} (${pct(s.findCodeFirstTurns, s.turnsWithFindCode)} of find-code turns)\n`);
console.log('Calls by tool (avg result chars):');
for (const r of s.byTool) console.log(`  ${r.tool.padEnd(24)} ${String(r.calls).padStart(6)}   ~${r.avgChars} chars`);
console.log(`\nAvg tokens/turn WITH find-code:    ${tok(s.tokensWithFindCode)}`);
console.log(`Avg tokens/turn WITHOUT find-code: ${tok(s.tokensWithoutFindCode)}`);
console.log('\nCorrelation, not causation: turns differ in task size. Compare like-for-like modes before concluding.');
closeDb();
```

In `extension/package.json` `"scripts"`, add:

```json
    "report:retrieval": "node scripts/retrieval-report.mjs",
```

- [ ] **Step 2: Verify against a COPY of the live DB**

```bash
cp ../kb/data.db "$TMPDIR/report-copy.db"
cd extension && LLMIDE_DB_PATH="$TMPDIR/report-copy.db" npm run report:retrieval -- --days 30
```

Expected: the report prints (zero turns until Tasks 2–3 have been live for a while — that is correct, not a failure). The copy gets migration 0035 applied; the live DB is untouched.

- [ ] **Step 3: Lint and commit**

```bash
cd extension && npm run lint
cd .. && git add extension/scripts/retrieval-report.mjs extension/package.json
git commit -m "feat(server): add a read-only retrieval report script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd extension && npm test` — all green.
- [ ] `cd extension && npm run lint` — 0 problems.
- [ ] `make docs-check` — passes (CLAUDE.md migration range updated).
- [ ] After a few real v2 turns with the rebuilt backend: `cd extension && npm run report:retrieval` shows non-zero turns and a `find-code` row, and `usage_ledger.request_id` is populated for new `/agent/v2/stream` rows.

## What Phase B enables (for the Phase C/D plans)

Decide from the report, not by assumption: (1) whether "find-code first" guidance actually changes behaviour (share of find-code-first turns before/after Phase A Task 4); (2) whether the legacy `memory_push` is large enough to justify removing per-message ranking; (3) the payload/recall baseline Phase C's citation validator and Phase D's richer graph must beat.
