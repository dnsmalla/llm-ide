# Graph-Memory Freshness Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent aware of its repository-memory freshness — annotate each present repo's memory block with a relative age, and emit an explicit "not generated yet" marker for an indexed-but-empty repo, instead of silently injecting stale/absent memory.

**Architecture:** Entirely inside `extension/graphkit/memory.mjs`. Add a pure `relativeAge` helper and an internal best-effort `newestMtimeMs` helper, then fold an age clause into `repoMemoryBlock`'s header (present memory) and return an absence-marker block (allow-gated repo with no readable memory). No Mac changes, no artifact-format changes, no git, no "stale" verdict — facts only.

**Tech Stack:** Node.js (ESM `.mjs`), `node --test`, `node:fs` (`statSync`, `utimesSync` in tests).

**Source of truth:** `docs/superpowers/specs/2026-06-24-graph-memory-freshness-design.md`.

## Global Constraints

- **Extension-only.** Only `extension/graphkit/memory.mjs` and `extension/tests/graphify-memory-*.test.mjs` change. Pushes cleanly through the node gate (`cd extension && make test` / `node --test`). No migration, endpoint, rate-limit, or Mac change → `make docs-check` is unaffected.
- **Facts only — no "stale" verdict, no threshold, no git.** Report age and absence; let the agent judge.
- **`relativeAge(mtimeMs, nowMs = Date.now())`** is pure and **exported** (unit-tested directly). Buckets: `just now` (< 60 s, or any future/non-finite delta), `~N minute(s) ago` (< 60 min), `~N hour(s) ago` (< 24 h), `~N day(s) ago` otherwise.
- **`newestMtimeMs(paths)`** is internal, best-effort: returns the max `mtimeMs` across `paths`, or `null` if none stat successfully; never throws.
- **`repoMemoryBlock` behavior:** when `parts.length > 0`, fold `(updated <relativeAge>)` into the header (omit the clause if mtime is unavailable). When the allow-gate has passed but `parts.length === 0`, return the absence-marker block exactly: `## <name> — memory\n_No code-graph memory generated for this repo yet._`. **The pre-existing path/tenancy `return null` guards stay silent — do not touch them.**
- **`renderGraphifyMemory` `''` boundaries unchanged:** no `indexedRepos` / falsy `userId` / allow-list throw / empty `allowedRoots` → still `''`.
- **Best-effort posture:** age computation must never throw into the prompt build.
- **Commit message footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

---

## File Structure

**Modify:**
- `extension/graphkit/memory.mjs` — add `relativeAge` (exported) + `newestMtimeMs` (internal); edit the tail of `repoMemoryBlock` (header age clause + absence marker). `statSync` is already imported at the top of the file.

**Create (test):**
- `extension/tests/graphify-memory-freshness.test.mjs` — `relativeAge` unit cases + integration cases (age header, absence marker, silent boundaries), following the existing `graphify-memory-tilde.test.mjs` idiom.

---

## Task 1: `relativeAge` pure helper

**Files:**
- Modify: `extension/graphkit/memory.mjs` (add exported `relativeAge`)
- Create (test): `extension/tests/graphify-memory-freshness.test.mjs`

**Interfaces:**
- Produces: `export function relativeAge(mtimeMs, nowMs = Date.now())` → string. `mtimeMs`/`nowMs` are epoch milliseconds.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/graphify-memory-freshness.test.mjs`:

```js
// Freshness signal: relativeAge (pure) + the age header / absence marker that
// renderGraphifyMemory now surfaces so the agent can weigh repo memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-freshness-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory, relativeAge } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function freshUser(tag) {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('relativeAge buckets by elapsed time with an injected now', () => {
  const now = 1_000 * DAY; // arbitrary fixed clock
  assert.equal(relativeAge(now - 30_000, now), 'just now');        // < 60s
  assert.equal(relativeAge(now - 5 * MIN, now), '~5 minutes ago');
  assert.equal(relativeAge(now - 1 * MIN, now), '~1 minute ago');  // singular
  assert.equal(relativeAge(now - 3 * HOUR, now), '~3 hours ago');
  assert.equal(relativeAge(now - 1 * HOUR, now), '~1 hour ago');   // singular
  assert.equal(relativeAge(now - 3 * DAY, now), '~3 days ago');
  assert.equal(relativeAge(now - 1 * DAY, now), '~1 day ago');     // singular
});

test('relativeAge treats future / non-finite timestamps as just now', () => {
  const now = 1_000 * DAY;
  assert.equal(relativeAge(now + 5 * MIN, now), 'just now'); // clock skew
  assert.equal(relativeAge(NaN, now), 'just now');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/graphify-memory-freshness.test.mjs`
Expected: FAIL — `relativeAge` is not exported (`undefined is not a function`).

- [ ] **Step 3: Implement `relativeAge`**

In `extension/graphkit/memory.mjs`, add (near the top-level helpers, e.g. just above `safeRead`):

```js
// Relative-age phrase for a file mtime. Pure + exported for unit tests.
// Facts only: a future/non-finite delta (clock skew, bad input) clamps to
// "just now" rather than emitting a negative or NaN age.
export function relativeAge(mtimeMs, nowMs = Date.now()) {
  const delta = nowMs - mtimeMs;
  if (!Number.isFinite(delta) || delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `~${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `~${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `~${days} day${days === 1 ? '' : 's'} ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/graphify-memory-freshness.test.mjs`
Expected: PASS (both `relativeAge` tests; integration tests are added in Task 2).

- [ ] **Step 5: Commit**

```bash
git add extension/graphkit/memory.mjs extension/tests/graphify-memory-freshness.test.mjs
git commit -m "$(cat <<'EOF'
feat(graphkit): add relativeAge helper for memory freshness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Age header + absence marker in `repoMemoryBlock`

**Files:**
- Modify: `extension/graphkit/memory.mjs` (add `newestMtimeMs`; edit the tail of `repoMemoryBlock`)
- Modify (test): `extension/tests/graphify-memory-freshness.test.mjs`

**Interfaces:**
- Consumes: `relativeAge` (Task 1); `statSync` (already imported), `join` (already imported), the existing `parts`, `memDir`, `root`, `repo` locals inside `repoMemoryBlock`.
- Produces: `repoMemoryBlock` now returns either a header with `(updated <relativeAge>)` + the parts (present memory), or the absence-marker block `## <name> — memory\n_No code-graph memory generated for this repo yet._` (allow-gate passed, no readable memory). `newestMtimeMs(paths)` → number | null (internal).

**Context for the implementer:** In `extension/graphkit/memory.mjs`, `repoMemoryBlock(repo, budget, allowedRoots)` first runs a series of `return null` guards (path has `..`, not absolute, not in `allowedRoots`). **Leave those guards exactly as they are — they are the tenancy boundary and must stay silent.** Only the *tail* of the function changes. Today the tail reads:

```js
  if (parts.length === 0) return null;
  return `## ${repo.name || 'Repository'} — memory\n_(from \`${root}/graphify-out/memory/\`)_\n\n${parts.join('\n\n')}`;
```

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/graphify-memory-freshness.test.mjs`:

```js
test('renderGraphifyMemory annotates present memory with its age', () => {
  const U = freshUser('fresh');
  const repoAbs = path.join(__dirname, `_gm-fresh-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const repoMd = path.join(memDir, 'repo.md');
  fs.writeFileSync(repoMd, '# Repo summary\nHello memory.');
  // Backdate the file mtime to ~3 days ago so the age phrase is deterministic.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(repoMd, threeDaysAgo, threeDaysAgo);
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'fresh' }] }, U);
    assert.match(out, /Hello memory/);
    assert.match(out, /updated ~3 days ago/);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('renderGraphifyMemory emits an absence marker for an indexed repo with no memory', () => {
  const U = freshUser('empty');
  const repoAbs = path.join(__dirname, `_gm-empty-repo-${Date.now()}`);
  fs.mkdirSync(repoAbs, { recursive: true }); // repo dir exists, but NO graphify-out/memory/
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'empty' }] }, U);
    assert.match(out, /Repository memory \(Graphify\)/);
    assert.match(out, /No code-graph memory generated for this repo yet\./);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('renderGraphifyMemory stays silent (no marker) for a non-allow-listed repo', () => {
  const U = freshUser('notallowed');
  const repoAbs = path.join(__dirname, `_gm-notallowed-repo-${Date.now()}`);
  fs.mkdirSync(repoAbs, { recursive: true });
  try {
    // NOTE: deliberately NOT calling db.addUserRepo — repo is not allow-listed.
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'notallowed' }] }, U);
    assert.equal(out, ''); // tenancy gate → silent, no absence marker
    assert.doesNotMatch(out, /No code-graph memory/);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('renderGraphifyMemory returns empty string at the unchanged boundaries', () => {
  const U = freshUser('bounds');
  assert.equal(renderGraphifyMemory({ indexedRepos: [] }, U), '');           // no repos
  assert.equal(renderGraphifyMemory({ indexedRepos: [{ path: '/x', name: 'x' }] }, null), ''); // no userId
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/graphify-memory-freshness.test.mjs`
Expected: FAIL — the age test fails (no `updated ~… ago` in the header) and the absence-marker test fails (`renderGraphifyMemory` returns `''` for an empty repo, so no marker). The non-allow-listed and boundary tests already pass.

- [ ] **Step 3: Add `newestMtimeMs`**

In `extension/graphkit/memory.mjs`, add near `safeRead` (both use `statSync`, already imported):

```js
// Newest mtime (epoch ms) across the given paths, or null if none stat.
// Best-effort: a missing/unstattable file is skipped, never throws.
function newestMtimeMs(paths) {
  let newest = null;
  for (const p of paths) {
    try {
      const ms = statSync(p).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch { /* missing / unstattable — skip */ }
  }
  return newest;
}
```

- [ ] **Step 4: Edit the tail of `repoMemoryBlock`**

Replace the final two lines of `repoMemoryBlock`:

```js
  if (parts.length === 0) return null;
  return `## ${repo.name || 'Repository'} — memory\n_(from \`${root}/graphify-out/memory/\`)_\n\n${parts.join('\n\n')}`;
```

with:

```js
  const name = repo.name || 'Repository';
  if (parts.length === 0) {
    // Allow-gate passed but no readable memory: tell the agent explicitly
    // instead of contributing nothing. (The path/tenancy guards above still
    // return null and stay silent — this is NOT one of those cases.)
    return `## ${name} — memory\n_No code-graph memory generated for this repo yet._`;
  }
  const mtime = newestMtimeMs([
    join(memDir, 'repo.md'),
    join(memDir, 'graph-notes.md'),
    join(memDir, 'doc-notes.md'),
  ]);
  const ageClause = mtime != null ? ` (updated ${relativeAge(mtime)})` : '';
  return `## ${name} — memory${ageClause}\n_(from \`${root}/graphify-out/memory/\`)_\n\n${parts.join('\n\n')}`;
```

- [ ] **Step 5: Run the freshness tests to verify they pass**

Run: `cd extension && node --test tests/graphify-memory-freshness.test.mjs`
Expected: PASS (all `relativeAge` + integration cases).

- [ ] **Step 6: Run the full graphify-memory suite (regression guard)**

Run: `cd extension && node --test tests/graphify-memory-tilde.test.mjs tests/global-memory.test.mjs tests/graphify-memory-doc-notes.test.mjs`
Expected: PASS — the existing tests assert on the memory body (`Hello memory`, the `Repository memory (Graphify)` header), which the header-suffix change does not break. If any asserts the header line verbatim without the age clause, update that assertion to tolerate the optional ` (updated …)` suffix.

- [ ] **Step 7: Run the entire backend suite**

Run: `cd extension && node --test`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add extension/graphkit/memory.mjs extension/tests/graphify-memory-freshness.test.mjs
git commit -m "$(cat <<'EOF'
feat(graphkit): surface memory age + absence marker to the agent

repoMemoryBlock now folds "(updated ~N ago)" into a present repo's header and
returns an explicit "no code-graph memory generated yet" marker for an indexed,
allow-listed repo with no readable memory — instead of silently injecting stale
or absent memory. Tenancy/path guards stay silent; the '' boundaries are
unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (spec § → task):
- §3.1 age on present memory → Task 2 (header age clause via `newestMtimeMs` + `relativeAge`).
- §3.2 explicit absence marker (allow-gate passed, parts empty) + path/tenancy guards stay silent → Task 2 (tail rewrite keeps the guards untouched; test "stays silent for a non-allow-listed repo" proves it).
- §3.3 `''` boundaries unchanged → Task 2 boundary test.
- §4.1 `relativeAge` (exported, pure, future/non-finite → `just now`, `nowMs` injectable) → Task 1.
- §4.2 `newestMtimeMs` (best-effort, max, null) → Task 2 Step 3.
- §4.3/§4.4 `repoMemoryBlock` modified / `renderGraphifyMemory` logic unchanged → Task 2.
- §6 error handling (age best-effort, never throws) → `newestMtimeMs` try/catch + `mtime != null` guard (clause omitted on failure).
- §7 testing → Task 1 (relativeAge units) + Task 2 (age header, absence marker, non-allow-listed silence, boundaries).

**Placeholder scan:** none — every step has runnable code and exact commands. Step 6 names a contingency (update a verbatim-header assertion) only because the existing tests' exact assertions can't be seen from here; the primary expectation is PASS.

**Type consistency:** `relativeAge(mtimeMs, nowMs)` → string, defined in Task 1 and called in Task 2 with a single arg (default `now`). `newestMtimeMs(paths)` → number | null, defined and consumed in Task 2; the `mtime != null` guard matches the `null` sentinel. The absence-marker string is identical in the spec, the global constraints, the Task 2 code, and the Task 2 test assertion (`No code-graph memory generated for this repo yet.`).
