# Hosted Issue Write Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /kb/issues/create`, `/kb/issues/comment` and `/kb/issues/close` real, advertised, contract-checked core routes: desktop only, vault token, fixed hosts, allowlisted repos, validated, deduped, rate-limited and audited.

**Architecture:** The three routes already run as an unadvertised inline block in `extension/routes/router.mjs` (commits `5b191612`, `74d82853`). That block has no host proof, no rate bucket, no repo allowlist, no dedupe, no audit and no test, and it cuts long text short without saying so. It is not in `ALL_ENDPOINTS`, which is why `scripts/http-inventory.mjs` lists the desktop calls as known gaps. This plan moves the block into its own module `extension/routes/issue-writes.mjs` in the `gantt_issues` feature group (reached through `issue-schedule.mjs`) and hardens it there: a pure layer (validation, the one provider call per operation, error mapping, idempotency) and a thin handler. Then it registers the routes (API 116, `dispatch` bucket, contract, fixtures, inventory, docs). The desktop sends one `idem` key per issue it creates.

**Tech Stack:** Node 20+ ESM (`node:test`), better-sqlite3 (`sources` table), the pinned fetch (`extension/server/pinned-fetch.mjs`), React 18 + TypeScript (`ui/screens/issues`), JSON Schema contract under `schema/http`.

**Spec:** `docs/superpowers/MASTER-PLAN.md` S6, item "Hosted issue write actions" (line 492). There is no separate design doc: the design constraints below come from the request that created this plan, and the decisions table at the end records the choices.

## Global Constraints

- The token never leaves the core. It is read from the vault (`github.token` / `gitlab.token`, `getSecret(db, userId, key)`) and is never returned, logged, audited or put in an error message.
- Only these operations: create issue, add comment, close issue. No edit, reopen, labels, assignees, PRs/MRs, and no arbitrary API path.
- Hosts are fixed: `https://api.github.com` and `https://gitlab.com/api/v4`. Nothing in a request picks or changes a host or base URL. A private or self-hosted GitLab is out of scope, as commit `04df99a7` already decided.
- A write reaches only an issue (comment, close) or repo (create) already on the caller's board: an imported `kind = 'ticket'` row of that user whose stored `ref` URL starts with `https://github.com/` or `https://gitlab.com/`.
- Limits: title 1–255 characters after trimming; body at most 20 000 characters; repo at most 200 characters, GitHub `owner/name`, GitLab 2–20 segments of `[A-Za-z0-9_.-]`, never a `.` or `..` segment; `number` a positive safe integer; `idem` 16–64 characters of `[A-Za-z0-9_-]`. A value over a limit is refused with `400 VALIDATION_FAILED` and `details.field`. It is never cut short.
- Create is deduped on `(user, idem)` for 10 minutes. A repeat with the same content replays the first answer (`deduped: true`), a repeat with other content gets `409 IDEM_CONFLICT`, and a failed attempt frees its key.
- The desktop's host proof comes first: `verifyBusHostProof(req)` or `403 HOST_PROOF_REQUIRED`, the same gate as `/kb/sync/*` and `/host-api/*`.
- The core never answers 401 for a provider refusal, because the desktop shell treats any 401 as its own expired session and signs out.
- Rate bucket `dispatch` (each request is one outbound provider call, like `/kb/repos/check-token`).
- Audit rows go through `safeAudit` with action `issues.create|issues.comment|issues.close`, resource `<provider>:<repo>[#<number>]`, outcome, and detail `{ status, code[, deduped] }` or `{ code }`. They never hold the title or body.
- `SERVER_API_VERSION` 115 → 116, `APP_API_VERSION` the same, plus contract, fixtures, the generated api-types/openapi, the regenerated INVENTORY and the spec lines.
- Tests use a fake provider (`_setPinnedFetchForTests`) and never touch the network.
- Do not touch `ui/screens/settings/**`, because another agent is working there. Reading `repo-config.ts` is fine, but this plan does not need it.
- Commit on `main`, one concern per commit, Conventional Commits, and end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `extension/kb/sources.mjs` | Modify (append after `listTicketSources`) | `findTicket` (the allowlist lookup) and `setTicketState` (the board row after a close) |
| `extension/kb/db.mjs:529` | Modify | Re-export the two helpers |
| `extension/routes/issue-writes.mjs` | Create | Pure layer (`parseIssueWrite`, `providerCall`, `mapProviderFailure`, `onceForIdem`) and `handleIssueWriteRoutes` |
| `extension/routes/issue-schedule.mjs` | Modify (top of handler) | Delegate the write paths, so the `gantt_issues` group serves them |
| `extension/routes/feature-routes.mjs:34-37` | Modify | Add the three paths to the `gantt_issues` prefixes |
| `extension/routes/router.mjs:375-442` | Delete | The old inline write block |
| `extension/server.mjs` | Modify | `ALL_ENDPOINTS`, `rateLimitProfile`, `SERVER_API_VERSION = 116` and its history line |
| `ui/screens/shell/core-api-floor.ts:5` | Modify | `APP_API_VERSION = 116` |
| `schema/http/kb-sources.schema.json` | Modify | `$defs.IssueWriteOk` and three endpoints |
| `schema/http/fixtures/kb-sources/post-kb-issues-*.json` | Create (16) | One exchange per declared status |
| `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md` | Regenerate | Generated outputs |
| `scripts/http-inventory.mjs:65-67` | Modify | Remove the three known-gap rows |
| `ui/screens/issues/IssuesScreen.tsx` | Modify (`createIssue`) | Send one `idem` key per issue |
| `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, `docs/explanation/invariants.md`, `docs/superpowers/MASTER-PLAN.md` | Modify | Section 7l, the rate table, version lines, invariant, plan tick |
| Tests: `extension/tests/kb-ticket-lookup.test.mjs`, `extension/tests/issue-writes.test.mjs` (new); `extension/tests/feature-routes.test.mjs`, `extension/tests/rate-limit-profile-query.test.mjs`, `ui/screens/issues/tests/screen-wiring.test.ts` (extend) | | |

Why `gantt_issues` and not always-on: `extension/routes/feature-routes.mjs` says a group belongs there only when every caller of its paths is the feature it names. The only callers of the three paths are `ui/screens/issues` (`IssuesScreen.tsx`, `IssueDetail.tsx`) and the Gantt row detail (`ui/screens/gantt/GanttScreen.tsx`, which reuses `IssueDetail`), and both are the `gantt_issues` feature ("Issues, Gantt and the issue schedule", `ui/screens/shell/features.ts:31`). With the feature off, the paths answer `404 feature_disabled` and the module, with its outbound write code, is never imported. The read `GET /kb/issues` stays always-on in `router.mjs` because its group does not change.

Why go through `issue-schedule.mjs` and not a new group module: `FEATURE_ROUTE_GROUPS` has one `load` per feature key, and `scripts/http-inventory.mjs` finds `/kb/issue-schedule`'s handler through that module's method lines (`group0.module`). If the group's module changed, the inventory would fail with "no handler found" for `/kb/issue-schedule`. One delegating line keeps both working.

---

### Task 1: Ticket lookup and state helpers (~20 min)

**Files:**
- Modify: `extension/kb/sources.mjs` (append after `listTicketSources`, end of file)
- Modify: `extension/kb/db.mjs:529`
- Test: `extension/tests/kb-ticket-lookup.test.mjs` (create)

Note: `file` reports `sources.mjs` as "data" because line 53 has a literal NUL separator inside a template string. Use `grep -a` to search it. The Edit tool works on it normally, but leave line 53 alone.

**Interfaces:**
- Consumes: `getDb`, `requireUser` (already imported in `sources.mjs`); `indexTicketsJson(userId, { tickets, provider })` from `extension/connectors/issues.mjs` (tests only).
- Produces:
  - `findTicket(userId: string, { provider: 'github'|'gitlab', repo: string, number: number|null, origin: string }) → { isPR: boolean } | null`. With `number: null` it matches any ticket row of that repo. `origin` has no trailing slash (`'https://github.com'`).
  - `setTicketState(userId: string, { provider, repo, number: number, state: string }) → number` (rows changed).
  - Both re-exported from `extension/kb/db.mjs` (`kb.findTicket`, `kb.setTicketState`).

- [ ] **Step 1: Write the failing test**

Create `extension/tests/kb-ticket-lookup.test.mjs`:

```js
// kb.findTicket / kb.setTicketState: the hosted issue writes' allowlist lookup and the board row after a close.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.NODE_ENV = "test";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_kb-ticket-lookup-test.db");
process.env.LLMIDE_DB_PATH = DB;

const db = await import("../kb/db.mjs");
const users = await import("../server/users.mjs");
const { indexTicketsJson } = await import("../connectors/issues.mjs");

const GH = "https://github.com";
function reset() {
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
const user = (tag) => users.registerUser(db.getDb(), { email: `${tag}-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: tag }).id;
function seed(u) {
  indexTicketsJson(u, { provider: "github", tickets: [
    { url: "https://github.com/o/r/issues/7", title: "Seven", meta: { repo: "o/r", number: 7, state: "open", isPR: false } },
    { url: "https://github.com/o/r/pull/8", title: "Eight", meta: { repo: "o/r", number: 8, state: "open", isPR: true } },
    { url: "https://github.com.evil.example/o/far/issues/1", title: "Look-alike", meta: { repo: "o/far", number: 1, state: "open" } },
  ] });
}

test("findTicket matches provider, repo, number and the stored URL's origin, per user", () => {
  reset();
  const u = user("look");
  const other = user("other");
  seed(u);
  assert.deepEqual(db.findTicket(u, { provider: "github", repo: "o/r", number: 7, origin: GH }), { isPR: false });
  assert.deepEqual(db.findTicket(u, { provider: "github", repo: "o/r", number: 8, origin: GH }), { isPR: true });
  assert.ok(db.findTicket(u, { provider: "github", repo: "o/r", number: null, origin: GH }), "repo-level match");
  assert.equal(db.findTicket(u, { provider: "github", repo: "o/r", number: 9, origin: GH }), null);
  assert.equal(db.findTicket(u, { provider: "gitlab", repo: "o/r", number: 7, origin: "https://gitlab.com" }), null);
  assert.equal(db.findTicket(u, { provider: "github", repo: "o/far", number: null, origin: GH }), null, "a look-alike host is not github.com");
  assert.equal(db.findTicket(other, { provider: "github", repo: "o/r", number: 7, origin: GH }), null, "another user's board");
});

test("setTicketState changes only the matching row of that user", () => {
  reset();
  const u = user("state");
  const other = user("state2");
  seed(u);
  assert.equal(db.setTicketState(other, { provider: "github", repo: "o/r", number: 7, state: "closed" }), 0);
  assert.equal(db.setTicketState(u, { provider: "github", repo: "o/r", number: 7, state: "closed" }), 1);
  assert.equal(db.listTicketSources(u, { provider: "github", repo: "o/r", state: "closed" }).total, 1);
  assert.equal(db.listTicketSources(u, { provider: "github", repo: "o/r", state: "open" }).total, 1, "the PR row is untouched");
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/kb-ticket-lookup.test.mjs`
Expected: FAIL with `TypeError: db.findTicket is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `extension/kb/sources.mjs` (after the closing `}` of `listTicketSources`):

```js

// A ticket meta field, NULL for malformed meta (json_extract would raise; AND does not short-circuit in SQLite).
const ticketMeta = (field) => `CASE WHEN json_valid(meta) THEN json_extract(meta, '$.${field}') END`;

// The hosted issue writes' allowlist (routes/issue-writes.mjs): one of the user's imported ticket rows for this
// provider and repo (and number, unless number is null) whose stored URL is on `origin` (no trailing slash).
// null when there is none. Scoped by user_id.
export function findTicket(userId, { provider, repo, number = null, origin }) {
  requireUser(userId);
  const row = getDb().prepare(`SELECT meta FROM sources WHERE user_id = ? AND kind = 'ticket'
    AND ${ticketMeta('provider')} = ? AND ${ticketMeta('repo')} = ?
    AND (? IS NULL OR ${ticketMeta('number')} = ?)
    AND substr(ref, 1, ?) = ? LIMIT 1`)
    .get(userId, String(provider), String(repo), number, number, origin.length + 1, `${origin}/`);
  if (!row) return null;
  let meta = {};
  try { meta = JSON.parse(row.meta) || {}; } catch { meta = {}; }
  return { isPR: meta.isPR === true };
}

// After a hosted close: the stored row's state, so the board shows it before the next import. Rows changed.
export function setTicketState(userId, { provider, repo, number, state }) {
  requireUser(userId);
  return getDb().prepare(`UPDATE sources SET meta = json_set(meta, '$.state', ?)
    WHERE user_id = ? AND kind = 'ticket' AND json_valid(meta)
    AND ${ticketMeta('provider')} = ? AND ${ticketMeta('repo')} = ? AND ${ticketMeta('number')} = ?`)
    .run(String(state), userId, String(provider), String(repo), number).changes;
}
```

In `extension/kb/db.mjs` line 529, change the end of the re-export from `listTicketSources } from './sources.mjs';` to:

```js
listTicketSources, findTicket, setTicketState } from './sources.mjs';
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/kb-ticket-lookup.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/kb/sources.mjs extension/kb/db.mjs extension/tests/kb-ticket-lookup.test.mjs
git commit -m "feat(kb): ticket lookup and state helpers for hosted issue writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure write layer: validation, provider call, error map, idempotency (~30 min)

**Files:**
- Create: `extension/routes/issue-writes.mjs`
- Test: `extension/tests/issue-writes.test.mjs` (create; Task 3 appends to it)

**Interfaces:**
- Consumes: nothing from earlier tasks (the handler in Task 3 uses Task 1).
- Produces (all exported from `extension/routes/issue-writes.mjs`):
  - `ISSUE_LIMITS = { title: 255, body: 20000, repo: 200 }`, `IDEM_TTL_MS = 600000`
  - `parseIssueWrite(op: 'create'|'comment'|'close', body: unknown) → Write | { error: { code: 'VALIDATION_FAILED', message: string, details: { field: string } } }`, where `Write` is `{ op, provider, repo, title, body, idem }` (create), `{ op, provider, repo, number, body }` (comment) or `{ op, provider, repo, number }` (close)
  - `providerCall(w: Write) → { url: string, method: 'POST'|'PATCH'|'PUT', payload: object }`
  - `mapProviderFailure(provider, status: number, data: unknown) → { status: 400|403|502, code: 'TOKEN_UNAUTHORIZED'|'TOKEN_FORBIDDEN'|'PROVIDER_REJECTED'|'PROVIDER_ERROR', message: string }`
  - `onceForIdem(userId: string, w: Write(create), run: () => Promise<{ status, body }>, now?: number) → Promise<{ status, body }>`. On 200, `body.deduped` is `false` for the first answer and `true` for a replay.
  - `_resetIssueWriteIdemForTests() → void`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/issue-writes.test.mjs`:

```js
// Hosted issue writes (routes/issue-writes.mjs): the pure layer here; the route (host proof, allowlist, provider,
// audit) below in Task 3's tests. The provider is always faked (_setPinnedFetchForTests); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = "c".repeat(64);
process.env.NODE_ENV = "test";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_issue-writes-test.db");
process.env.LLMIDE_DB_PATH = DB;

const { parseIssueWrite, providerCall, mapProviderFailure, onceForIdem, IDEM_TTL_MS, _resetIssueWriteIdemForTests } = await import("../routes/issue-writes.mjs");

const IDEM = "A".repeat(20);

test("parseIssueWrite accepts the three shapes and refuses everything outside the limits", () => {
  assert.deepEqual(parseIssueWrite("comment", { provider: "github", repo: "o/r", number: 7, body: "hi" }), { op: "comment", provider: "github", repo: "o/r", number: 7, body: "hi" });
  assert.deepEqual(parseIssueWrite("close", { provider: "gitlab", repo: "g/sub/p", number: 3 }), { op: "close", provider: "gitlab", repo: "g/sub/p", number: 3 });
  assert.deepEqual(parseIssueWrite("create", { provider: "github", repo: "o/r", title: "  T  ", idem: IDEM }), { op: "create", provider: "github", repo: "o/r", title: "T", body: "", idem: IDEM });
  const field = (op, b) => parseIssueWrite(op, b).error?.details?.field;
  assert.equal(field("close", { repo: "o/r", number: 1 }), "provider", "provider is required, no github default");
  assert.equal(field("close", { provider: "github", repo: "o/r/x", number: 1 }), "repo");
  assert.equal(field("close", { provider: "github", repo: "o/..", number: 1 }), "repo");
  assert.equal(field("close", { provider: "gitlab", repo: "g/../p", number: 1 }), "repo");
  assert.equal(field("close", { provider: "gitlab", repo: `g/${"p".repeat(200)}`, number: 1 }), "repo");
  assert.equal(field("close", { provider: "github", repo: "o/r", number: "7" }), "number");
  assert.equal(field("close", { provider: "github", repo: "o/r", number: 0 }), "number");
  assert.equal(field("comment", { provider: "github", repo: "o/r", number: 1, body: "  " }), "body");
  assert.equal(field("comment", { provider: "github", repo: "o/r", number: 1, body: "x".repeat(20_001) }), "body", "refused, never cut short");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "x".repeat(256), idem: IDEM }), "title");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "   ", idem: IDEM }), "title");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T", body: 5, idem: IDEM }), "body");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T", body: "x".repeat(20_001), idem: IDEM }), "body");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T" }), "idem");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T", idem: "short" }), "idem");
  assert.equal(parseIssueWrite("close", null).error.code, "VALIDATION_FAILED");
});

test("providerCall builds one fixed-host call per operation", () => {
  assert.deepEqual(providerCall({ op: "create", provider: "github", repo: "o/r", title: "T", body: "B" }), { url: "https://api.github.com/repos/o/r/issues", method: "POST", payload: { title: "T", body: "B" } });
  assert.deepEqual(providerCall({ op: "comment", provider: "github", repo: "o/r", number: 7, body: "c" }), { url: "https://api.github.com/repos/o/r/issues/7/comments", method: "POST", payload: { body: "c" } });
  assert.deepEqual(providerCall({ op: "close", provider: "github", repo: "o/r", number: 7 }), { url: "https://api.github.com/repos/o/r/issues/7", method: "PATCH", payload: { state: "closed" } });
  assert.deepEqual(providerCall({ op: "create", provider: "gitlab", repo: "g/sub/p", title: "T", body: "B" }), { url: "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/issues", method: "POST", payload: { title: "T", description: "B" } });
  assert.deepEqual(providerCall({ op: "comment", provider: "gitlab", repo: "g/p", number: 3, body: "c" }), { url: "https://gitlab.com/api/v4/projects/g%2Fp/issues/3/notes", method: "POST", payload: { body: "c" } });
  assert.deepEqual(providerCall({ op: "close", provider: "gitlab", repo: "g/p", number: 3 }), { url: "https://gitlab.com/api/v4/projects/g%2Fp/issues/3", method: "PUT", payload: { state_event: "close" } });
});

test("mapProviderFailure never answers 401 and keeps token refusals apart from provider faults", () => {
  assert.deepEqual(mapProviderFailure("github", 401, { message: "Bad credentials" }), { status: 403, code: "TOKEN_UNAUTHORIZED", message: "Bad credentials" });
  assert.equal(mapProviderFailure("github", 403, {}).code, "TOKEN_FORBIDDEN");
  assert.equal(mapProviderFailure("github", 404, {}).code, "TOKEN_FORBIDDEN", "GitHub hides a repo the token cannot see behind 404");
  assert.deepEqual(mapProviderFailure("gitlab", 422, { message: { title: ["is too long"] } }), { status: 400, code: "PROVIDER_REJECTED", message: "GitLab answered 422." });
  assert.deepEqual(mapProviderFailure("github", 500, null), { status: 502, code: "PROVIDER_ERROR", message: "GitHub answered 500." });
  assert.equal(mapProviderFailure("github", 500, { message: "x".repeat(400) }).message.length, 300);
});

test("onceForIdem runs a create once per key, replays it, refuses other content and frees a failed key", async () => {
  _resetIssueWriteIdemForTests();
  const W = { op: "create", provider: "github", repo: "o/r", title: "T", body: "", idem: IDEM };
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = async () => { calls += 1; await gate; return { status: 200, body: { ok: true, id: 1, url: "https://github.com/o/r/issues/9", state: "open" } }; };
  const a = onceForIdem("u1", W, run, 1000);
  const b = onceForIdem("u1", W, run, 1001);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1, "a double click reaches the provider once");
  assert.equal(ra.body.deduped, false);
  assert.equal(rb.body.deduped, true);
  assert.equal(rb.body.url, ra.body.url);
  const conflict = await onceForIdem("u1", { ...W, title: "Other" }, run, 2000);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEM_CONFLICT");
  assert.equal((await onceForIdem("u2", W, run, 2000)).body.deduped, false, "keys are per user");
  assert.equal(calls, 2);
  assert.equal((await onceForIdem("u1", W, run, 1000 + IDEM_TTL_MS + 1)).body.deduped, false, "the key expires");
  assert.equal(calls, 3);
  const failing = async () => { calls += 1; return { status: 502, body: { error: { code: "PROVIDER_ERROR", message: "x" } } }; };
  const W2 = { ...W, idem: "B".repeat(20) };
  assert.equal((await onceForIdem("u1", W2, failing, 5000)).status, 502);
  assert.equal((await onceForIdem("u1", W2, run, 5001)).body.deduped, false, "a failed attempt frees its key");
  assert.equal(calls, 5);
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/issue-writes.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../routes/issue-writes.mjs`.

- [ ] **Step 3: Write the minimal implementation**

Create `extension/routes/issue-writes.mjs` (Task 3 adds the handler to this file):

```js
// Hosted issue writes for the desktop Issues board and the Gantt row detail (feature gantt_issues, reached through
// issue-schedule.mjs): POST /kb/issues/create, /kb/issues/comment and /kb/issues/close. Nothing else is written: no
// edit, reopen, labels or arbitrary API path. Desktop only (bus host proof). The token comes from the vault
// (github.token / gitlab.token) and is never returned, logged or audited. Hosts are fixed (api.github.com, gitlab.com).
// A write reaches only an issue or repo already on the caller's board: an imported ticket row whose stored URL is on
// that provider's web host (kb.findTicket). Audit rows carry the action, repo/number and outcome, never the text.
import { createHash } from 'node:crypto';

export const ISSUE_LIMITS = Object.freeze({ title: 255, body: 20_000, repo: 200 });
export const IDEM_TTL_MS = 10 * 60_000;
const IDEM_MAX = 500;
const API_BASE = Object.freeze({ github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' });
const NAME = Object.freeze({ github: 'GitHub', gitlab: 'GitLab' });
const REPO_SHAPE = Object.freeze({
  github: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  gitlab: /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19}$/,
});
const IDEM_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

const invalid = (field, message) => ({ error: { code: 'VALIDATION_FAILED', message, details: { field } } });

/** The checked write for `op`, or a 400 envelope naming the field. Pure; a value over a limit is refused, not cut. */
export function parseIssueWrite(op, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const provider = b.provider;
  if (provider !== 'github' && provider !== 'gitlab') return invalid('provider', 'provider must be github or gitlab');
  const repo = typeof b.repo === 'string' ? b.repo : '';
  if (repo.length > ISSUE_LIMITS.repo || !REPO_SHAPE[provider].test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) {
    return invalid('repo', provider === 'github' ? 'repo must be owner/name' : 'repo must be a GitLab project path');
  }
  if (op === 'create') {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) return invalid('title', 'title is required');
    if (title.length > ISSUE_LIMITS.title) return invalid('title', `title is longer than ${ISSUE_LIMITS.title} characters`);
    const text = b.body === undefined ? '' : b.body;
    if (typeof text !== 'string' || text.length > ISSUE_LIMITS.body) return invalid('body', `body must be text of at most ${ISSUE_LIMITS.body} characters`);
    if (typeof b.idem !== 'string' || !IDEM_SHAPE.test(b.idem)) return invalid('idem', 'idem must be 16 to 64 letters, digits, _ or -');
    return { op, provider, repo, title, body: text, idem: b.idem };
  }
  const number = b.number;
  if (!Number.isSafeInteger(number) || number <= 0) return invalid('number', 'number must be a positive integer');
  if (op === 'comment') {
    const text = typeof b.body === 'string' ? b.body : '';
    if (!text.trim()) return invalid('body', 'body is required');
    if (text.length > ISSUE_LIMITS.body) return invalid('body', `body must be text of at most ${ISSUE_LIMITS.body} characters`);
    return { op, provider, repo, number, body: text };
  }
  return { op, provider, repo, number };
}

/** The one provider call for a checked write. Pure; the host never comes from the request. */
export function providerCall(w) {
  const gl = w.provider === 'gitlab';
  const issues = gl ? `${API_BASE.gitlab}/projects/${encodeURIComponent(w.repo)}/issues` : `${API_BASE.github}/repos/${w.repo}/issues`;
  if (w.op === 'create') return { url: issues, method: 'POST', payload: gl ? { title: w.title, description: w.body } : { title: w.title, body: w.body } };
  if (w.op === 'comment') return { url: `${issues}/${w.number}/${gl ? 'notes' : 'comments'}`, method: 'POST', payload: { body: w.body } };
  return { url: `${issues}/${w.number}`, method: gl ? 'PUT' : 'PATCH', payload: gl ? { state_event: 'close' } : { state: 'closed' } };
}

/** A provider refusal as the client sees it. Never 401: the desktop treats any 401 as its own expired session. */
export function mapProviderFailure(provider, status, data) {
  const said = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : '';
  const message = (said || `${NAME[provider]} answered ${status}.`).slice(0, 300);
  if (status === 401) return { status: 403, code: 'TOKEN_UNAUTHORIZED', message };
  if (status === 403 || status === 404) return { status: 403, code: 'TOKEN_FORBIDDEN', message };
  if (status === 400 || status === 422) return { status: 400, code: 'PROVIDER_REJECTED', message };
  return { status: 502, code: 'PROVIDER_ERROR', message };
}

const creates = new Map(); // `${userId}\0${idem}` -> { at, fp, result: Promise<{ status, body }> }

/** Runs `run` once per (user, idem) for IDEM_TTL_MS: the same content waits for and replays the first answer
 *  (deduped: true), other content is 409 IDEM_CONFLICT, and a failed attempt frees the key. `run` must not reject. */
export async function onceForIdem(userId, w, run, now = Date.now()) {
  for (const [k, v] of creates) if (now - v.at > IDEM_TTL_MS) creates.delete(k);
  const key = `${userId}\0${w.idem}`;
  const fp = createHash('sha256').update(JSON.stringify([w.provider, w.repo, w.title, w.body])).digest('hex');
  const prev = creates.get(key);
  if (prev) {
    if (prev.fp !== fp) return { status: 409, body: { error: { code: 'IDEM_CONFLICT', message: 'This request key was already used for a different issue.' } } };
    const r = await prev.result;
    return r.status === 200 ? { status: 200, body: { ...r.body, deduped: true } } : r;
  }
  // shortcut: in memory and capped at IDEM_MAX, so a core restart or a flood forgets keys (one duplicate at worst); persist if that matters.
  if (creates.size >= IDEM_MAX) creates.delete(creates.keys().next().value);
  const result = run();
  creates.set(key, { at: now, fp, result });
  const r = await result;
  if (r.status !== 200) {
    if (creates.get(key)?.result === result) creates.delete(key);
    return r;
  }
  return { status: 200, body: { ...r.body, deduped: false } };
}

/** Test seam. */
export function _resetIssueWriteIdemForTests() { creates.clear(); }
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/issue-writes.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/issue-writes.mjs extension/tests/issue-writes.test.mjs
git commit -m "feat(issues): pure validation, provider call and idempotency for hosted writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The guarded route, moved into the gantt_issues group (~35 min)

**Files:**
- Modify: `extension/routes/issue-writes.mjs` (imports + handler)
- Modify: `extension/routes/issue-schedule.mjs` (import + first line of `handleIssueScheduleRoutes`)
- Modify: `extension/routes/feature-routes.mjs:34-37`
- Delete: `extension/routes/router.mjs:375-442` (the block from `// Issue writes: GitHub and GitLab comments, close and create.` through the closing `}` of its `if`, just above `// List GitHub issues (and other tickets) from the KB.`)
- Test: `extension/tests/issue-writes.test.mjs` (append), `extension/tests/feature-routes.test.mjs` (extend)

**Interfaces:**
- Consumes: Task 1 `kb.findTicket`, `kb.setTicketState`; Task 2 `parseIssueWrite`, `providerCall`, `mapProviderFailure`, `onceForIdem`. Also `verifyBusHostProof(req)` (`core/host-approval.mjs`), `getSecret(db, userId, key)` (`server/vault.mjs`), `makePinnedFetch()` (`server/pinned-fetch.mjs`), `safeAudit(db, fields)` / `clientIp(req)` (`server/route-http.mjs`), `sendJSON`, `readBody`, `parseJSON` (`core/utils.mjs`).
- Produces: `handleIssueWriteRoutes(req, res, { userId, url }) → Promise<boolean>` (false when the request is not one of the three POSTs). Wire answers:
  - 200 `{ ok: true, id: number|null, url: string|null, state: string|null }`, plus `deduped: boolean` on create
  - 400 `VALIDATION_FAILED` (with `details.field`), `NOT_AN_ISSUE`, `GITHUB_TOKEN_MISSING` / `GITLAB_TOKEN_MISSING`, `PROVIDER_REJECTED`
  - 403 `HOST_PROOF_REQUIRED`, `REPO_NOT_ALLOWED`, `TOKEN_UNAUTHORIZED`, `TOKEN_FORBIDDEN`
  - 409 `IDEM_CONFLICT`
  - 502 `PROVIDER_ERROR`, `PROVIDER_UNREACHABLE`
  - audit actions `issues.create|comment|close`

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/issue-writes.test.mjs`:

```js
// ---- the route (handleKB → gantt_issues → issue-schedule.mjs → issue-writes.mjs) ----
const db = await import("../kb/db.mjs");
const { handleKB } = await import("../routes/router.mjs");
const { setSecret } = await import("../server/vault.mjs");
const { _setPinnedFetchForTests } = await import("../server/pinned-fetch.mjs");
const users = await import("../server/users.mjs");
const { busHostProof } = await import("../core/host-approval.mjs");
const { indexTicketsJson } = await import("../connectors/issues.mjs");
const PROOF = busHostProof();

function reset() {
  _resetIssueWriteIdemForTests();
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
const user = (tag) => users.registerUser(db.getDb(), { email: `${tag}-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: tag }).id;
function seed(u) {
  indexTicketsJson(u, { provider: "github", tickets: [
    { url: "https://github.com/o/r/issues/7", title: "Seven", meta: { repo: "o/r", number: 7, state: "open", isPR: false } },
    { url: "https://github.com/o/r/pull/8", title: "Eight", meta: { repo: "o/r", number: 8, state: "open", isPR: true } },
    { url: "https://github.com.evil.example/o/far/issues/1", title: "Look-alike", meta: { repo: "o/far", number: 1, state: "open" } },
  ] });
  indexTicketsJson(u, { provider: "gitlab", tickets: [
    { url: "https://gitlab.com/g/sub/p/-/issues/3", title: "Three", meta: { repo: "g/sub/p", number: 3, state: "opened" } },
    { url: "https://gitlab.internal.example/g/self/-/issues/1", title: "Self-hosted", meta: { repo: "g/self", number: 1, state: "opened" } },
  ] });
  setSecret(db.getDb(), u, "github.token", "ghp_secret_value_123456");
  setSecret(db.getDb(), u, "gitlab.token", "glpat_secret_value_12345");
}
function post(userId, url, body, { proof = PROOF } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const headers = { "user-agent": "issue-writes-test", ...(proof ? { "x-llmide-host-nonce": proof } : {}) };
  const r = { method: "POST", url, user: { id: userId }, headers, socket: { remoteAddress: "127.0.0.1" }, on(ev, cb) { if (ev === "data") chunks.forEach(cb); else if (ev === "end") cb(); return r; } };
  return r;
}
function res() {
  return { statusCode: 200, headers: {}, body: "", writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader(k, v) { this.headers[k] = v; }, write(c) { this.body += c; }, end(c) { if (c) this.body += c; } };
}
async function call(userId, url, body, opts) {
  const out = res();
  await handleKB(post(userId, url, body, opts), out);
  return { status: out.statusCode, body: JSON.parse(out.body), raw: out.body };
}
const auditRows = (u) => db.getDb().prepare("SELECT action, resource, outcome, detail FROM audit_log WHERE user_id = ? ORDER BY id").all(u);
function fakeProvider(answer) {
  const seen = [];
  _setPinnedFetchForTests(async (url, init) => { seen.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) }); return answer(url, init); });
  return seen;
}
const json = (status, data) => new Response(JSON.stringify(data), { status });

test("without the host proof every write is 403 HOST_PROOF_REQUIRED, the provider is never called, and the refusal is audited", async () => {
  reset();
  const u = user("proof");
  seed(u);
  const seen = fakeProvider(() => json(201, {}));
  try {
    for (const [p, body] of [["/kb/issues/create", { provider: "github", repo: "o/r", title: "T", idem: IDEM }], ["/kb/issues/comment", { provider: "github", repo: "o/r", number: 7, body: "c" }], ["/kb/issues/close", { provider: "github", repo: "o/r", number: 7 }]]) {
      const r = await call(u, p, body, { proof: null });
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error.code, "HOST_PROOF_REQUIRED");
      assert.equal((await call(u, p, body, { proof: "0".repeat(64) })).body.error.code, "HOST_PROOF_REQUIRED", "a wrong proof too");
    }
    assert.equal(seen.length, 0);
    assert.deepEqual(auditRows(u).map((a) => [a.action, a.outcome]).slice(0, 2), [["issues.create", "denied"], ["issues.create", "denied"]]);
  } finally { _setPinnedFetchForTests(null); }
});

test("a GitHub comment reaches the fixed comments endpoint with the vault token, answers without it, and audits no text", async () => {
  reset();
  const u = user("comment");
  seed(u);
  const seen = fakeProvider(() => json(201, { id: 2002, html_url: "https://github.com/o/r/issues/7#issuecomment-2002" }));
  try {
    const r = await call(u, "/kb/issues/comment", { provider: "github", repo: "o/r", number: 7, body: "secret-free comment text" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { ok: true, id: 2002, url: "https://github.com/o/r/issues/7#issuecomment-2002", state: null });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.github.com/repos/o/r/issues/7/comments");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers.Authorization, "Bearer ghp_secret_value_123456");
    assert.equal(r.raw.includes("ghp_secret"), false);
    const [row] = auditRows(u);
    assert.deepEqual([row.action, row.resource, row.outcome], ["issues.comment", "github:o/r#7", "success"]);
    assert.equal(row.detail.includes("comment text"), false, "the audit never holds the text");
    assert.equal(row.detail.includes("ghp_"), false);
  } finally { _setPinnedFetchForTests(null); }
});

test("a GitLab close goes to gitlab.com with the encoded project path and marks the board row closed", async () => {
  reset();
  const u = user("close");
  seed(u);
  const seen = fakeProvider(() => json(200, { id: 3003, web_url: "https://gitlab.com/g/sub/p/-/issues/3", state: "closed" }));
  try {
    const r = await call(u, "/kb/issues/close", { provider: "gitlab", repo: "g/sub/p", number: 3 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.state, "closed");
    assert.deepEqual([seen[0].url, seen[0].method, seen[0].headers["PRIVATE-TOKEN"]], ["https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/issues/3", "PUT", "glpat_secret_value_12345"]);
    assert.deepEqual(seen[0].body, { state_event: "close" });
    assert.equal(db.listTicketSources(u, { provider: "gitlab", repo: "g/sub/p", state: "closed" }).total, 1);
  } finally { _setPinnedFetchForTests(null); }
});

test("only issues and repos on the caller's board, on the pinned host, are written; PRs never", async () => {
  reset();
  const u = user("allow");
  const other = user("allow2");
  seed(u);
  setSecret(db.getDb(), other, "github.token", "ghp_other_value_123456");
  const seen = fakeProvider(() => json(201, { id: 1 }));
  try {
    const code = async (who, p, body) => (await call(who, p, body)).body.error?.code;
    assert.equal(await code(u, "/kb/issues/comment", { provider: "github", repo: "o/r", number: 99, body: "c" }), "REPO_NOT_ALLOWED");
    assert.equal(await code(u, "/kb/issues/create", { provider: "github", repo: "x/y", title: "T", idem: IDEM }), "REPO_NOT_ALLOWED");
    assert.equal(await code(u, "/kb/issues/create", { provider: "github", repo: "o/far", title: "T", idem: IDEM }), "REPO_NOT_ALLOWED", "look-alike host");
    assert.equal(await code(u, "/kb/issues/close", { provider: "gitlab", repo: "g/self", number: 1 }), "REPO_NOT_ALLOWED", "a self-hosted GitLab row never sends the token to gitlab.com");
    assert.equal(await code(u, "/kb/issues/close", { provider: "github", repo: "o/r", number: 8 }), "NOT_AN_ISSUE");
    assert.equal(await code(other, "/kb/issues/close", { provider: "github", repo: "o/r", number: 7 }), "REPO_NOT_ALLOWED", "another user's board");
    assert.equal(seen.length, 0);
    assert.equal((await call(u, "/kb/issues/create", { provider: "github", repo: "o/r", title: "T", idem: IDEM })).status, 200, "a repo whose only other row is a PR still takes a create");
  } finally { _setPinnedFetchForTests(null); }
});

test("create dedupes a double click on its idem key", async () => {
  reset();
  const u = user("idem");
  seed(u);
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = fakeProvider(async () => { await gate; return json(201, { id: 1001, html_url: "https://github.com/o/r/issues/42", state: "open" }); });
  try {
    const body = { provider: "github", repo: "o/r", title: "Crash on save", body: "Steps", idem: IDEM };
    const a = call(u, "/kb/issues/create", body);
    const b = call(u, "/kb/issues/create", body);
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(seen.length, 1);
    assert.deepEqual([ra.status, ra.body.deduped, rb.status, rb.body.deduped], [200, false, 200, true]);
    assert.deepEqual(seen[0].body, { title: "Crash on save", body: "Steps" });
    assert.equal((await call(u, "/kb/issues/create", { ...body, title: "Other" })).status, 409);
  } finally { _setPinnedFetchForTests(null); }
});

test("provider refusals map to stable codes and a missing token is 400", async () => {
  reset();
  const u = user("errors");
  seed(u);
  const comment = { provider: "github", repo: "o/r", number: 7, body: "c" };
  try {
    for (const [status, want, code] of [[401, 403, "TOKEN_UNAUTHORIZED"], [404, 403, "TOKEN_FORBIDDEN"], [422, 400, "PROVIDER_REJECTED"], [500, 502, "PROVIDER_ERROR"]]) {
      fakeProvider(() => json(status, { message: "provider said no" }));
      const r = await call(u, "/kb/issues/comment", comment);
      assert.deepEqual([r.status, r.body.error.code], [want, code], String(status));
    }
    _setPinnedFetchForTests(async () => { throw new Error("ECONNRESET"); });
    assert.deepEqual((await call(u, "/kb/issues/comment", comment)).body.error.code, "PROVIDER_UNREACHABLE");
  } finally { _setPinnedFetchForTests(null); }
  setSecret(db.getDb(), u, "github.token", "");
  assert.equal((await call(u, "/kb/issues/comment", comment)).body.error.code, "GITHUB_TOKEN_MISSING");
  assert.equal((await call(u, "/kb/issues/comment", { ...comment, body: "x".repeat(20_001) })).body.error.details.field, "body");
});
```

In `extension/tests/feature-routes.test.mjs`, add inside the test `featureDisabledFor maps a disabled group's paths to its feature key` (after the `/kb/issue-schedule` assertion):

```js
  for (const p of ['/kb/issues/create', '/kb/issues/comment', '/kb/issues/close']) assert.equal(featureDisabledFor(p, CHAT_ONLY), 'gantt_issues', p);
  assert.equal(featureDisabledFor('/kb/issues?provider=github', CHAT_ONLY), null, 'the board read stays always-on');
```

and inside `with only agent_chat, feature routes answer 404 feature_disabled` (after the `sched` assertions):

```js
  const write = await call('POST', '/kb/issues/comment', { provider: 'github', repo: 'o/r', number: 1, body: 'x' }, userId);
  assert.equal(write.status, 404);
  assert.deepEqual(write.body, { error: 'feature_disabled', feature: 'gantt_issues' });
```

and inside `with only agent_chat, the disabled route modules were never imported` (after the `issue-schedule.mjs` line):

```js
  assert.equal(wasLoaded('/routes/issue-writes.mjs'), false);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/issue-writes.test.mjs tests/feature-routes.test.mjs`
Expected: FAIL. The route tests get 200/400 from the old inline block in `router.mjs` instead of `HOST_PROOF_REQUIRED` / `REPO_NOT_ALLOWED`, and the feature-routes assertions get `null` instead of `'gantt_issues'`.

- [ ] **Step 3: Write the implementation**

(a) In `extension/routes/issue-writes.mjs`, replace the single import line `import { createHash } from 'node:crypto';` with:

```js
import { createHash } from 'node:crypto';
import * as kb from '../kb/db.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { getSecret } from '../server/vault.mjs';
import { makePinnedFetch } from '../server/pinned-fetch.mjs';
import { safeAudit, clientIp } from '../server/route-http.mjs';
```

Add `const WEB_ORIGIN = Object.freeze({ github: 'https://github.com', gitlab: 'https://gitlab.com' });` under the `API_BASE` line. Then append to the end of the file:

```js
const fail = (res, status, code, message) => { sendJSON(res, status, { error: { code, message } }); return true; };

async function callProvider(w, token) {
  const call = providerCall(w);
  const headers = w.provider === 'gitlab'
    ? { 'User-Agent': 'llm-ide-desktop', 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' }
    : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'llm-ide-desktop', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const r = await makePinnedFetch()(call.url, { method: call.method, headers, body: JSON.stringify(call.payload), signal: AbortSignal.timeout(15_000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const f = mapProviderFailure(w.provider, r.status, data);
      return { status: f.status, body: { error: { code: f.code, message: f.message } } };
    }
    const url = typeof data?.web_url === 'string' ? data.web_url : typeof data?.html_url === 'string' ? data.html_url : null;
    return { status: 200, body: { ok: true, id: Number.isSafeInteger(data?.id) ? data.id : null, url, state: typeof data?.state === 'string' ? data.state : null } };
  } catch {
    return { status: 502, body: { error: { code: 'PROVIDER_UNREACHABLE', message: `${NAME[w.provider]} could not be reached. Check the connection and try again.` } } };
  }
}

/** POST /kb/issues/{create,comment,close}. false for anything else (the caller keeps dispatching). */
export async function handleIssueWriteRoutes(req, res, { userId, url }) {
  const path = String(url || '').split('?')[0];
  const op = req.method === 'POST' && path === '/kb/issues/create' ? 'create'
    : req.method === 'POST' && path === '/kb/issues/comment' ? 'comment'
      : req.method === 'POST' && path === '/kb/issues/close' ? 'close' : null;
  if (!op) return false;
  const audit = (outcome, resource, detail) => safeAudit(kb.getDb(), {
    userId, ip: clientIp(req), userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 200) || null,
    action: `issues.${op}`, resource, outcome, detail,
  });
  if (!verifyBusHostProof(req)) {
    audit('denied', null, { code: 'HOST_PROOF_REQUIRED' });
    return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  }
  let raw;
  try { raw = parseJSON(await readBody(req, 128 * 1024)); } catch { return fail(res, 400, 'VALIDATION_FAILED', 'Invalid JSON body'); }
  const w = parseIssueWrite(op, raw);
  if (w.error) { sendJSON(res, 400, w); return true; }
  const resource = `${w.provider}:${w.repo}${w.number ? `#${w.number}` : ''}`;
  const known = kb.findTicket(userId, { provider: w.provider, repo: w.repo, number: w.number ?? null, origin: WEB_ORIGIN[w.provider] });
  if (!known) {
    audit('denied', resource, { code: 'REPO_NOT_ALLOWED' });
    return fail(res, 403, 'REPO_NOT_ALLOWED', w.number
      ? 'This issue is not on your Issues board. Import its repository first.'
      : 'Only repositories on your Issues board can get new issues. Import this repository first.');
  }
  if (w.number && known.isPR) return fail(res, 400, 'NOT_AN_ISSUE', 'Pull requests and merge requests are not written from the Issues board.');
  const token = getSecret(kb.getDb(), userId, `${w.provider}.token`);
  if (!token) return fail(res, 400, `${w.provider.toUpperCase()}_TOKEN_MISSING`, `Add a ${NAME[w.provider]} token in Settings → Built-in keys first.`);
  const out = op === 'create' ? await onceForIdem(userId, w, () => callProvider(w, token)) : await callProvider(w, token);
  if (op === 'close' && out.status === 200) kb.setTicketState(userId, { provider: w.provider, repo: w.repo, number: w.number, state: 'closed' });
  audit(out.status === 200 ? 'success' : 'failure', resource, {
    status: out.status, code: out.body?.error?.code ?? null, ...(op === 'create' && out.status === 200 ? { deduped: out.body.deduped } : {}),
  });
  sendJSON(res, out.status, out.body);
  return true;
}
```

(b) In `extension/routes/issue-schedule.mjs`, add under the existing imports:

```js
import { handleIssueWriteRoutes } from './issue-writes.mjs';
```

and make the first line of `handleIssueScheduleRoutes` (before `const { userId, url } = ctx;`):

```js
  // The hosted issue writes share this feature group (gantt_issues); see issue-writes.mjs.
  if (await handleIssueWriteRoutes(req, res, ctx)) return true;
```

Also update the group comment in `extension/routes/feature-routes.mjs` and its prefixes (lines 33-37):

```js
  // Issues board + Gantt (Features/Issues, incl. Issues/Gantt, only): the schedule overlay and the hosted issue
  // writes (issue-writes.mjs, dispatched from issue-schedule.mjs). GET /kb/issues stays always-on in router.mjs.
  gantt_issues: Object.freeze({
    prefixes: Object.freeze(['/kb/issue-schedule', '/kb/issues/create', '/kb/issues/comment', '/kb/issues/close']),
    load: async () => (await import('./issue-schedule.mjs')).handleIssueScheduleRoutes,
  }),
```

Keep the `load:` line exactly as it is: `scripts/http-inventory.mjs` parses it.

(c) Delete the old inline block in `extension/routes/router.mjs` (lines 375-442: from the comment `// Issue writes: GitHub and GitLab comments, close and create. The token comes from the vault (the desktop never` through the closing `}` of `if (req.method === 'POST' && ['/kb/issues/comment', '/kb/issues/close', '/kb/issues/create'].includes(...)) { ... }`). Leave the blank line before `// List GitHub issues (and other tickets) from the KB.` in place. Then check:

Run: `cd /Users/dinsmallade/llm-ide && grep -n "kb/issues/comment\|kb/issues/close\|kb/issues/create" extension/routes/router.mjs`
Expected: no output. `makePinnedFetch` and `getSecret` stay imported, because `/kb/repos/check-token` still uses them.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/issue-writes.test.mjs tests/feature-routes.test.mjs tests/kb-repo-token.test.mjs tests/kb-ticket-lookup.test.mjs`
Expected: PASS, all tests in the four files.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/issue-writes.mjs extension/routes/issue-schedule.mjs extension/routes/feature-routes.mjs extension/routes/router.mjs extension/tests/issue-writes.test.mjs extension/tests/feature-routes.test.mjs
git commit -m "feat(issues): guard hosted issue writes and move them into the gantt_issues group

Host proof, board allowlist on the pinned hosts, vault token, limits without
silent truncation, create dedupe and content-free audit rows.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Register the routes: endpoints, rate bucket, API 116 (~20 min)

**Files:**
- Modify: `extension/server.mjs` (`SERVER_API_VERSION` line 330, its history comment block lines ~285-327, `ALL_ENDPOINTS` after `'/kb/issues',` line 361, `rateLimitProfile` after the `/kb/repos/check-token` line 628)
- Modify: `ui/screens/shell/core-api-floor.ts:5`
- Test: `extension/tests/rate-limit-profile-query.test.mjs` (append)

**Interfaces:**
- Consumes: the three paths from Task 3.
- Produces: `/health` `endpoints` lists the three paths when `gantt_issues` is on (`enabledEndpoints` drops them when it is off); `rateLimitProfile(path, 'POST') === 'dispatch'`; `SERVER_API_VERSION === 116 === APP_API_VERSION`.

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/rate-limit-profile-query.test.mjs`:

```js
test('hosted issue writes ride the dispatch bucket (each is one outbound GitHub or GitLab call)', () => {
  for (const p of ['/kb/issues/create', '/kb/issues/comment', '/kb/issues/close']) {
    assert.equal(rateLimitProfile(p, 'POST'), 'dispatch', p);
    assert.equal(rateLimitProfile(`${p}?x=1`, 'POST'), 'dispatch', `${p}?x=1`);
  }
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/rate-limit-profile-query.test.mjs`
Expected: FAIL with `null !== 'dispatch'` for `/kb/issues/create`.

- [ ] **Step 3: Write the minimal implementation**

In `extension/server.mjs`:

1. Directly under `  if (url === '/kb/repos/check-token')   return 'dispatch';   // one outbound provider /user call`, add:

```js
  if (url === '/kb/issues/create' || url === '/kb/issues/comment' || url === '/kb/issues/close') return 'dispatch';   // one outbound GitHub/GitLab write
```

2. In `ALL_ENDPOINTS`, directly under `  '/kb/issues',`, add:

```js
  '/kb/issues/create',
  '/kb/issues/comment',
  '/kb/issues/close',
```

3. Change `const SERVER_API_VERSION = 115;` to `const SERVER_API_VERSION = 116;`, and add this history line directly above the line that starts with `//   v115 — Box sync store (SP6)`:

```js
//   v116 — hosted issue writes (gantt_issues group), now advertised and guarded: POST /kb/issues/create { provider, repo, title, body?, idem } -> { ok, id, url, state, deduped }; POST /kb/issues/comment { provider, repo, number, body } and POST /kb/issues/close { provider, repo, number } -> { ok, id, url, state }. JWT + bus host proof (403 HOST_PROOF_REQUIRED first); only an issue or repo already on the caller's board whose stored URL is on github.com / gitlab.com (403 REPO_NOT_ALLOWED; a PR or MR is 400 NOT_AN_ISSUE); vault token only, fixed hosts api.github.com and gitlab.com; provider is required; title 1-255, body at most 20 000 characters (400 VALIDATION_FAILED details.field, never cut short); create dedupes on idem for 10 minutes (409 IDEM_CONFLICT for other content); provider 401 -> 403 TOKEN_UNAUTHORIZED, 403/404 -> 403 TOKEN_FORBIDDEN, 400/422 -> 400 PROVIDER_REJECTED, else 502 PROVIDER_ERROR / PROVIDER_UNREACHABLE (the old GITHUB_/GITLAB_WRITE_FAILED codes are gone). A close also marks the board row closed. 'dispatch' rate bucket; audit rows issues.<op> carry no title or body. Spec docs/spec/api-server.md section 7l.
```

In `ui/screens/shell/core-api-floor.ts`, change `export const APP_API_VERSION = 115;` to `export const APP_API_VERSION = 116;`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/rate-limit-profile-query.test.mjs tests/feature-routes.test.mjs && cd ../desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/core-api-floor.test.mjs`
Expected: PASS (the floor test pins `APP_API_VERSION === SERVER_API_VERSION`).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/server.mjs ui/screens/shell/core-api-floor.ts extension/tests/rate-limit-profile-query.test.mjs
git commit -m "feat(server): advertise the hosted issue writes on the dispatch bucket, API 116

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HTTP contract, fixtures, generated outputs and inventory (~30 min)

**Files:**
- Modify: `schema/http/kb-sources.schema.json` (insert a `$defs` entry before line 216 `    "Issue": {`, and three endpoints before line 1130 `    "POST /kb/connect-git": {`)
- Create: `schema/http/fixtures/kb-sources/post-kb-issues-{create,comment,close}-<status>.json` (16 files)
- Modify: `scripts/http-inventory.mjs:65-67` (delete three `clientNotInRoster` rows)
- Regenerate: `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md`

**Interfaces:**
- Consumes: the wire answers listed in Task 3's Produces.
- Produces: `$defs.IssueWriteOk` and endpoints `POST /kb/issues/create|comment|close` in the `kb-sources` group; the generated types.

- [ ] **Step 1: Write the failing check**

Delete these three lines from `ALLOWLIST.clientNotInRoster` in `scripts/http-inventory.mjs`:

```js
    '/kb/issues/create': 'desktop Issues write actions with no core route yet (MASTER-PLAN: hosted issue actions need a core route plan); found when the inventory started scanning the desktop client',
    '/kb/issues/comment': 'same as /kb/issues/create',
    '/kb/issues/close': 'same as /kb/issues/create',
```

Run: `cd /Users/dinsmallade/llm-ide && node scripts/http-inventory.mjs --check; node docs/_scripts/check_api_coverage.py 2>/dev/null || python3 docs/_scripts/check_api_coverage.py`
Expected: FAIL. The inventory is stale (the roster now has three new rows), and the OpenAPI coverage check lists `/kb/issues/create`, `/kb/issues/comment`, `/kb/issues/close` as undocumented.

- [ ] **Step 2: Add the schema**

Insert before the line `    "Issue": {` in `schema/http/kb-sources.schema.json`:

```json
    "IssueWriteOk": {
      "type": "object",
      "description": "A hosted issue write the provider accepted (extension/routes/issue-writes.mjs). Never carries the token.",
      "required": ["ok", "id", "url", "state"],
      "properties": {
        "ok": { "const": true },
        "id": { "type": ["integer", "null"], "description": "The provider's id of the issue, comment or note" },
        "url": { "type": ["string", "null"], "description": "The provider's web URL for it" },
        "state": { "type": ["string", "null"], "description": "The issue state after the write; null for a comment" },
        "deduped": { "type": "boolean", "x-optional": true, "description": "create only: true when this answer replays an earlier create with the same idem" }
      }
    },
```

Insert before the line `    "POST /kb/connect-git": {`:

```json
    "POST /kb/issues/create": {
      "description": "Desktop only: JWT + bus host proof (403 HOST_PROOF_REQUIRED first); feature gantt_issues. Creates an issue in a repo already on the caller's board (an imported ticket row whose URL is on github.com / gitlab.com, else 403 REPO_NOT_ALLOWED) with the vault token on the fixed host. A repeat with the same idem within 10 minutes replays the first answer (deduped: true); other content under that idem is 409 IDEM_CONFLICT. Provider refusals: 403 TOKEN_UNAUTHORIZED | TOKEN_FORBIDDEN, 400 PROVIDER_REJECTED, 502 PROVIDER_ERROR | PROVIDER_UNREACHABLE. 'dispatch' bucket.",
      "request": {
        "body": {
          "type": "object",
          "required": ["provider", "repo", "title", "idem"],
          "properties": {
            "provider": { "type": "string", "enum": ["github", "gitlab"] },
            "repo": { "type": "string", "description": "GitHub owner/name, or a GitLab project path of 2 to 20 segments; at most 200 characters; no . or .. segment" },
            "title": { "type": "string", "description": "1 to 255 characters after trimming" },
            "body": { "type": "string", "x-optional": true, "description": "At most 20 000 characters; default empty" },
            "idem": { "type": "string", "description": "16 to 64 of [A-Za-z0-9_-]; one key per issue the user means to create" }
          }
        }
      },
      "responses": {
        "200": { "$ref": "#/$defs/IssueWriteOk" },
        "400": { "$ref": "_common#/$defs/Error" },
        "401": { "$ref": "_common#/$defs/Error" },
        "403": { "$ref": "_common#/$defs/Error" },
        "409": { "$ref": "_common#/$defs/Error" },
        "502": { "$ref": "_common#/$defs/Error" }
      }
    },
    "POST /kb/issues/comment": {
      "description": "Desktop only, as POST /kb/issues/create. Adds a comment (GitLab: a note) to an issue on the caller's board; a PR or MR is 400 NOT_AN_ISSUE.",
      "request": {
        "body": {
          "type": "object",
          "required": ["provider", "repo", "number", "body"],
          "properties": {
            "provider": { "type": "string", "enum": ["github", "gitlab"] },
            "repo": { "type": "string", "description": "As in POST /kb/issues/create" },
            "number": { "type": "integer", "description": "The issue number (GitLab iid), a positive integer" },
            "body": { "type": "string", "description": "1 to 20 000 characters, not only whitespace" }
          }
        }
      },
      "responses": {
        "200": { "$ref": "#/$defs/IssueWriteOk" },
        "400": { "$ref": "_common#/$defs/Error" },
        "401": { "$ref": "_common#/$defs/Error" },
        "403": { "$ref": "_common#/$defs/Error" },
        "502": { "$ref": "_common#/$defs/Error" }
      }
    },
    "POST /kb/issues/close": {
      "description": "Desktop only, as POST /kb/issues/create. Closes an issue on the caller's board and marks its board row closed; a PR or MR is 400 NOT_AN_ISSUE.",
      "request": {
        "body": {
          "type": "object",
          "required": ["provider", "repo", "number"],
          "properties": {
            "provider": { "type": "string", "enum": ["github", "gitlab"] },
            "repo": { "type": "string", "description": "As in POST /kb/issues/create" },
            "number": { "type": "integer", "description": "The issue number (GitLab iid), a positive integer" }
          }
        }
      },
      "responses": {
        "200": { "$ref": "#/$defs/IssueWriteOk" },
        "400": { "$ref": "_common#/$defs/Error" },
        "401": { "$ref": "_common#/$defs/Error" },
        "403": { "$ref": "_common#/$defs/Error" },
        "502": { "$ref": "_common#/$defs/Error" }
      }
    },
```

- [ ] **Step 3: Write the fixtures**

Run once from the repo root. It writes the 16 fixture files and nothing else:

```bash
cd /Users/dinsmallade/llm-ide && node --input-type=module <<'EOF'
import { writeFileSync } from 'node:fs';
const dir = 'schema/http/fixtures/kb-sources';
const err = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });
const create = { provider: 'github', repo: 'octo/repo', title: 'Crash on save', body: 'Steps: open, save.', idem: 'f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' };
const comment = { provider: 'github', repo: 'octo/repo', number: 42, body: 'Fixed on main.' };
const close = { provider: 'gitlab', repo: 'group/sub/project', number: 3 };
const signIn = err('UNAUTHENTICATED', 'Sign in first');
const rows = [
  ['create', 200, create, { ok: true, id: 1001, url: 'https://github.com/octo/repo/issues/42', state: 'open', deduped: false }],
  ['create', 400, { ...create, title: '' }, err('VALIDATION_FAILED', 'title is required', { field: 'title' })],
  ['create', 401, create, signIn],
  ['create', 403, create, err('REPO_NOT_ALLOWED', 'Only repositories on your Issues board can get new issues. Import this repository first.')],
  ['create', 409, { ...create, title: 'Another title' }, err('IDEM_CONFLICT', 'This request key was already used for a different issue.')],
  ['create', 502, create, err('PROVIDER_UNREACHABLE', 'GitHub could not be reached. Check the connection and try again.')],
  ['comment', 200, comment, { ok: true, id: 2002, url: 'https://github.com/octo/repo/issues/42#issuecomment-2002', state: null }],
  ['comment', 400, { ...comment, body: ' ' }, err('VALIDATION_FAILED', 'body is required', { field: 'body' })],
  ['comment', 401, comment, signIn],
  ['comment', 403, comment, err('HOST_PROOF_REQUIRED', 'This route is for the desktop app only')],
  ['comment', 502, comment, err('PROVIDER_ERROR', 'GitHub answered 500.')],
  ['close', 200, close, { ok: true, id: 3003, url: 'https://gitlab.com/group/sub/project/-/issues/3', state: 'closed' }],
  ['close', 400, { ...close, number: 0 }, err('VALIDATION_FAILED', 'number must be a positive integer', { field: 'number' })],
  ['close', 401, close, signIn],
  ['close', 403, close, err('TOKEN_UNAUTHORIZED', '401 Unauthorized')],
  ['close', 502, close, err('PROVIDER_ERROR', 'GitLab answered 503.')],
];
for (const [op, status, body, response] of rows) {
  writeFileSync(`${dir}/post-kb-issues-${op}-${status}.json`, JSON.stringify({ endpoint: `POST /kb/issues/${op}`, status, request: { body }, response }, null, 2) + '\n');
}
console.log(`${rows.length} fixtures written`);
EOF
```

Expected: `16 fixtures written`.

- [ ] **Step 4: Regenerate and run the contract gates**

Run: `cd /Users/dinsmallade/llm-ide && make api-types openapi && node scripts/http-inventory.mjs && make contract-gates && python3 docs/_scripts/check_api_coverage.py`
Expected: every check passes. `git diff --stat` shows `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml` (including `x-api-version: 116`) and `schema/http/INVENTORY.md`. In INVENTORY, the three paths now appear as roster rows owned by `gantt_issues`, with handler `extension/routes/issue-writes.mjs` and method POST, and they are gone from the known-gap list.

If `gen-openapi` does not pick up `x-api-version` from `server.mjs` by itself, edit `x-api-version: 115` to `116` in `docs/reference/api/openapi.overlay.json` (or wherever `grep -rn "x-api-version" docs/reference/api scripts/gen-openapi.mjs` shows it is set) and run `make openapi` again.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add schema/http/kb-sources.schema.json schema/http/fixtures/kb-sources/post-kb-issues-*.json scripts/http-inventory.mjs schema/http/INVENTORY.md extension/src/lib/api-types.ts docs/reference/api/
git commit -m "feat(schema): contract and fixtures for the hosted issue writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Desktop sends one idempotency key per new issue (~15 min)

**Files:**
- Modify: `ui/screens/issues/IssuesScreen.tsx` (a ref next to `createBody` at line 46; `createIssue` at lines 124-140)
- Test: `ui/screens/issues/tests/screen-wiring.test.ts` (append)

**Interfaces:**
- Consumes: `POST /kb/issues/create` with `idem` (Task 3), answers 200 / 409 `IDEM_CONFLICT`.
- Produces: none (UI only). `IssueDetail.tsx` already sends `{ provider, repo, number, body }` / `{ provider, repo, number }` and shows `error.message`, so it does not change.

- [ ] **Step 1: Write the failing test**

Append to `ui/screens/issues/tests/screen-wiring.test.ts`:

```ts
test("New issue sends one idempotency key per issue and drops it after a success or a key conflict", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /const createIdem = useRef<string \| null>\(null\);/);
  assert.match(issues, /createIdem\.current \?\?= crypto\.randomUUID\(\);/);
  assert.match(issues, /"\/kb\/issues\/create", \{ provider: filters\.provider, repo, title: createTitle\.trim\(\), body: createBody, idem: createIdem\.current \}/);
  assert.match(issues, /if \(r\.status === 409\) createIdem\.current = null;/, "an edited retry after a lost answer gets a new key");
  assert.match(issues, /createIdem\.current = null;\s*setNotice\("Issue created\."\);/);
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test --experimental-strip-types ../ui/screens/issues/tests/screen-wiring.test.ts`
Expected: FAIL on the first `assert.match` (no `createIdem`).

- [ ] **Step 3: Write the minimal implementation**

In `ui/screens/issues/IssuesScreen.tsx`, directly under `  const [createBody, setCreateBody] = useState("");` add:

```tsx
  // One key per issue the user means to create: a double click or a retry after a lost answer replays, never duplicates.
  const createIdem = useRef<string | null>(null);
```

In `createIssue`, replace:

```tsx
      const r = await deps.request("POST", "/kb/issues/create", { provider: filters.provider, repo, title: createTitle.trim(), body: createBody });
      if (r.status !== 200) {
```

with:

```tsx
      createIdem.current ??= crypto.randomUUID();
      const r = await deps.request("POST", "/kb/issues/create", { provider: filters.provider, repo, title: createTitle.trim(), body: createBody, idem: createIdem.current });
      if (r.status !== 200) {
        if (r.status === 409) createIdem.current = null;
```

and replace `      setNotice("Issue created.");` (inside `createIssue`) with:

```tsx
      createIdem.current = null;
      setNotice("Issue created.");
```

(`useRef` is already imported on line 5. `crypto.randomUUID()` returns 36 characters of `[0-9a-f-]`, which fits the core's `[A-Za-z0-9_-]{16,64}`.)

- [ ] **Step 4: Run the tests and the type check**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test --experimental-strip-types ../ui/screens/issues/tests/*.test.* && npx tsc --noEmit -p .`
Expected: PASS, and tsc reports no errors. If `desktop` has no `tsconfig` covering `ui/screens`, run `cd ../web && npx tsc --noEmit -p .` instead, as `make test-desktop-node` does.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add ui/screens/issues/IssuesScreen.tsx ui/screens/issues/tests/screen-wiring.test.ts
git commit -m "feat(issues): send one idempotency key per new issue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Spec, invariant and plan docs, then the full gates (~20 min)

**Files:**
- Modify: `docs/spec/api-server.md` (line 54 version; §6 `dispatch` row line 239; new §7l before `## 8. See also`)
- Modify: `docs/spec/cross-cutting.md` (the `SERVER_API_VERSION = 115` line, ~185)
- Modify: `docs/explanation/invariants.md` (new bullet after the "fixed package-registry hosts" bullet, line 480)
- Modify: `docs/superpowers/MASTER-PLAN.md:492`

**Interfaces:**
- Consumes: everything above.
- Produces: docs only. `make docs-check` (`check_rate_limit_mapping.py`, `check_api_coverage.py`, `check_spec_citations.py`) pins them to the code.

- [ ] **Step 1: Run the failing doc check**

Run: `cd /Users/dinsmallade/llm-ide && make docs-check`
Expected: FAIL in `check_rate_limit_mapping.py`: `/kb/issues/create` (and comment, close) map to `dispatch` in `rateLimitProfile` but are not in the §6 `dispatch` row.

- [ ] **Step 2: Edit the docs**

`docs/spec/api-server.md`:
- Line 54: `SERVER_API_VERSION = 115` → `SERVER_API_VERSION = 116`.
- §6 `dispatch` row: after `` `/kb/repos/check-token` (reaches GitHub or GitLab), `` insert `` `/kb/issues/create`, `/kb/issues/comment`, `/kb/issues/close` (each one GitHub or GitLab write), ``.
- Insert before `## 8. See also`:

```markdown
## 7l. Hosted issue writes (API 116)

`POST /kb/issues/create { provider, repo, title, body?, idem }`, `POST /kb/issues/comment { provider, repo, number, body }` and `POST /kb/issues/close { provider, repo, number }` (`extension/routes/issue-writes.mjs`, feature `gantt_issues`, dispatched from `issue-schedule.mjs`) are the only writes the core makes to GitHub or GitLab for the Issues board. Order of checks: the bus host proof (`403 HOST_PROOF_REQUIRED`, desktop only), the body (`400 VALIDATION_FAILED` with `details.field`: provider `github|gitlab` required; repo GitHub `owner/name` or GitLab 2 to 20 segments, at most 200 characters, no `.`/`..` segment; title 1 to 255 characters after trimming; body at most 20 000 characters, never cut short; number a positive integer; `idem` 16 to 64 of `[A-Za-z0-9_-]`), the board allowlist (`kb.findTicket`: an imported ticket row of the caller for that provider, repo and, for comment and close, number, whose stored URL starts with `https://github.com/` or `https://gitlab.com/`, else `403 REPO_NOT_ALLOWED`; a PR or MR row is `400 NOT_AN_ISSUE`), then the vault token (`github.token` / `gitlab.token`, else `400 GITHUB_TOKEN_MISSING` / `GITLAB_TOKEN_MISSING`). The one provider call goes through the pinned fetch to the fixed host `api.github.com` or `gitlab.com/api/v4` (GitLab project paths URL-encoded as one segment), with a 15 s timeout. Answers: `200 { ok, id, url, state }` (`deduped` on create); the provider's 401 → `403 TOKEN_UNAUTHORIZED`, 403 or 404 → `403 TOKEN_FORBIDDEN`, 400 or 422 → `400 PROVIDER_REJECTED`, anything else → `502 PROVIDER_ERROR`, no answer → `502 PROVIDER_UNREACHABLE`. The core never answers 401 here. Create runs once per `(user, idem)` for 10 minutes, in memory with at most 500 keys: the same content replays the first answer with `deduped: true`, other content is `409 IDEM_CONFLICT`, and a failed attempt frees the key. A successful close sets the board row's `state` to `closed`. Each request writes one `audit_log` row (`issues.create|comment|close`, resource `<provider>:<repo>[#<number>]`, outcome, detail `{ status, code[, deduped] }`) with no title, body or token. Rides the `dispatch` bucket. A self-hosted GitLab and the operation toggles in Settings → Repositories are not enforced here (see the plan `docs/superpowers/plans/2026-11-07-hosted-issue-writes.md`).
```

`docs/spec/cross-cutting.md`: `SERVER_API_VERSION = 115` → `SERVER_API_VERSION = 116`.

`docs/explanation/invariants.md`: add directly after the bullet that starts `- **The server may GET fixed package-registry hosts only for MCP version checks.**`:

```markdown
- **Issue writes to GitHub/GitLab go only through `routes/issue-writes.mjs`, to fixed hosts, for the board's own issues.** `POST /kb/issues/{create,comment,close}` need the bus host proof, read the token from the vault only, call `api.github.com` or `gitlab.com/api/v4` (never a host or base URL from the request), and write only to an issue or repo already on the caller's board whose stored URL is on `github.com` / `gitlab.com` (`kb.findTicket`). A self-hosted GitLab token must never be sent to gitlab.com. A value over a limit is refused, never cut short. Audit rows never hold the text or token. No other operation (edit, reopen, labels, PRs, a passthrough path) is added without a plan. Pinned by `extension/tests/issue-writes.test.mjs`.
```

`docs/superpowers/MASTER-PLAN.md` line 492: replace the item with:

```markdown
- [x] Hosted issue write actions: `/kb/issues/{create,comment,close}` are guarded core routes in the `gantt_issues` group (host proof, board allowlist on github.com / gitlab.com, vault token, limits, create dedupe, audit, `dispatch` bucket; API 116; plan [hosted-issue-writes](plans/2026-11-07-hosted-issue-writes.md)) (me)
```

- [ ] **Step 3: Run every gate this change touches**

Run: `cd /Users/dinsmallade/llm-ide && make docs-check && make contract-gates && cd extension && node --test tests/issue-writes.test.mjs tests/kb-ticket-lookup.test.mjs tests/feature-routes.test.mjs tests/rate-limit-profile-query.test.mjs tests/kb-repo-token.test.mjs tests/feature-matrix.test.mjs && cd ../desktop && npm test`
Expected: every command passes. If `check_spec_citations.py` flags the `server.mjs:324` citation on line 54 because the line moved, update the cited line number to the `SERVER_API_VERSION` line that `grep -n "const SERVER_API_VERSION" extension/server.mjs` prints.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add docs/spec/api-server.md docs/spec/cross-cutting.md docs/explanation/invariants.md docs/superpowers/MASTER-PLAN.md
git commit -m "docs(spec): hosted issue writes, API 116

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage.** Vault-only token, never logged: Task 3 handler, tests assert the token is absent from the answer and the audit. Allowlisted operations: Task 2 `providerCall` and the explicit three-way `op`. Repo allowlist: Task 1 `findTicket` and the Task 3 checks. Pinned hosts / SSRF: Task 2 constants, Task 3 look-alike and self-hosted rows. Validation caps: Task 2. Create dedupe: Tasks 2, 3 and 6. Content-free audit: Task 3. Rate limit: Task 4. Host proof: Task 3. API bump, contract, fixtures, inventory, floor, spec: Tasks 4, 5 and 7. Fake-provider tests: Tasks 2 and 3. Feature group with its reason: the file-structure notes and Task 3. Labels have no task: no client sends them, so they are a decision row, not a gap. Reopen is the same.
- **Placeholders.** None. Every code step has the code, and every run step has the command and the expected result.
- **Type consistency.** `findTicket(userId, { provider, repo, number, origin })` and `setTicketState(userId, { provider, repo, number, state })` match across Tasks 1 and 3. `parseIssueWrite`, `providerCall`, `mapProviderFailure`, `onceForIdem`, `IDEM_TTL_MS` and `_resetIssueWriteIdemForTests` match across Tasks 2 and 3. `handleIssueWriteRoutes(req, res, { userId, url })` matches the ctx that `featureHandlers.gantt_issues` passes (`router.mjs:1412`).

## Decisions for the user (secure default first)

| # | Decision | Default in this plan (secure) | Alternative |
|---|---|---|---|
| 1 | Route group | `gantt_issues` feature group: off means 404 `feature_disabled` and no write code loaded | Always-on in `router.mjs` |
| 2 | Repo allowlist source | Repos and issues already on the caller's board (imported ticket rows on github.com / gitlab.com) | A dedicated server-side allowlist written by Settings → Repositories (needs a Settings change) |
| 3 | Settings "Issues" operation toggles (create / comment / close) | Not enforced by the core yet: they live in desktop localStorage. The core enforces the host proof and the board allowlist. | Store them in `user_flags` from Settings and refuse a disabled op in the core, as the Mac's `AllowlistedRepoBackend` did |
| 4 | GitLab host | gitlab.com only; a self-hosted row is refused, so its token never goes to gitlab.com | Allow the configured self-hosted HTTPS base after an SSRF review and with a server-side base |
| 5 | Create dedupe | Required `idem`, in memory for 10 minutes, at most 500 keys | Persist the keys in a table (survives a core restart) and dedupe comments too |
| 6 | Scope of operations | Create, comment, close only; no reopen, labels, assignees, edit or PRs | Add `/kb/issues/reopen` and `labels` (at most 10 × 50 characters) when the UI asks for them |
| 7 | Rate bucket | `dispatch` (burst 4, 1 per 10 s), like `/kb/repos/check-token` | `kbWrite` (burst 30, 5/s) |
| 8 | Host proof | Required: a core started without the desktop host cannot write issues | Allow writes when `LLMIDE_HOST_APPROVAL_KEY` is unset |
