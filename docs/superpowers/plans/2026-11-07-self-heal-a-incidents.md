# Self-Heal Incident Capture on the Desktop (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a debug desktop build, errors of the app (the spawned core's stderr, panic records, Chat and Loop failures) are captured, redacted, deduplicated by signature, stored per user in the core, and listed in Settings → Self-Heal with Ignore and Clear. Release builds record and show nothing.

**Architecture:** The Tauri host owns the switch. `self_heal::enabled()` is true only in a debug build (`cfg!(debug_assertions)`, opt out with `LLMIDE_SELF_HEAL=0`). In that case the host passes `LLMIDE_SELF_HEAL=1` to the core it spawns, groups the core's stderr into reports (plain error lines with their `at …` frames, JSON logger `error` lines, 5xx summaries) and imports each panic record once. The webview drains the host queue every 15 s (`self_heal_take`), adds the Chat and Loop errors it saw, and posts them with the JWT and the bus host proof to `POST /kb/self-heal/incidents`. The core redacts each report again, computes the signature and upserts it into `self_heal_incidents` (migration 0067). Without `LLMIDE_SELF_HEAL=1` the core never imports the route module, and every `/kb/self-heal/*` path answers `404 {"error":"feature_disabled","feature":"self_heal"}`. Plan B (later) drives the `fixing` / `proposed` / `needsHuman` / `fixed` statuses, `attempts` and the proposal columns that this plan creates and leaves null.

**Tech Stack:** Node 22 core (better-sqlite3, `node:crypto`), Rust (Tauri 2, serde, serde_json), React 18 + TypeScript (desktop shell, Settings). No new npm package or crate.

**Spec:** The brief that asked for this plan (restated in Global Constraints), and the retired Mac app's design, readable with `git show 94ae1103~1:mac/Sources/LlmIdeMac/Core/Incidents/<File>.swift`: `IncidentRecorder.swift`, `IncidentRedactor.swift`, `IncidentSignature.swift`, `IncidentStore.swift`, `IncidentClassifier.swift`, `ServerStderrIncidentParser.swift`, `CrashIncidentImporter.swift`, `Incident.swift`.

## Global Constraints

- **Scope = plan A:** capture, store, list, Ignore, Clear. No LLM call, no git worktree, no patch, no `make regression` run. Those belong to plan B.
- **Debug builds only.** `self_heal::gate(debug, env)` = `debug && env != Some("0")`. A release build never passes `LLMIDE_SELF_HEAL`, never queues a report, answers `self_heal_take` with `{ enabled: false, incidents: [] }`, and hides the Settings group. The core reads `LLMIDE_SELF_HEAL === '1' && !isProd` once into `config.selfHeal`.
- **Off = the feature-disabled shape, but not a feature-route group.** The route lives in its own lazily imported module (`extension/routes/self-heal.mjs`), dispatched from `server.mjs`. When off it answers `sendFeatureDisabled(res, 'self_heal')`, and `/health` does not advertise its paths. It is deliberately **not** in `FEATURE_ROUTE_GROUPS`. There, an unset `LLMIDE_FEATURES` means every feature is on, so a plain `npm run server` would record. This gate must default to off.
- **Desktop only.** No Host API v1 command, no web or iPhone surface, no sync snapshot.
- **Security first:**
  - Reports are redacted twice: line by line on the host (`crash_report::redact`) and by the core before storage (`core/incident.mjs`).
  - The core applies the shared `redactSecretsForStorage` patterns, then JWTs → `[REDACTED]`, `name=value` secrets → `name=[REDACTED]`, emails → `[EMAIL]`, the home folder → `~`.
  - Caps: message 2000, stack 8000, category 200 characters.
  - Every route needs the JWT AND the bus host proof (`403 HOST_PROOF_REQUIRED` first).
  - Incident text is data, never instructions: it is never logged (at any level), never sent anywhere but the trusted spawned core, never handed to a model, and rendered as text only.
- **Numbers:** migration **0067** (head is 0066). `SERVER_API_VERSION` 120 → **121**. If another plan has taken either number by the time Task 2 or Task 5 runs, use the next free one in every line those tasks touch.
- **API bump checklist** (Task 5):
  - `SERVER_API_VERSION` and a changelog line above `//   v120 — …` in `extension/server.mjs`
  - `ALL_ENDPOINTS`
  - `ui/screens/shell/core-api-floor.ts` `APP_API_VERSION`
  - `docs/spec/api-server.md` and `docs/spec/cross-cutting.md` version lines
  - `schema/http/self-heal.schema.json` + one fixture per declared status
  - `extension/tests/http-contract-live.test.mjs` skip row
  - `scripts/http-inventory.mjs` allowlist row
  - regenerate with `node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs`
  - `REQUIRED_ENDPOINTS` in `extension/src/sidepanel/App.tsx` is unchanged, because the Chrome extension never calls these routes.
- **Migration:** append-only. `deleteUserCascade` in `extension/kb/db.mjs` deletes `self_heal_incidents` (`tests/user-delete-cascade.test.mjs` enumerates every `user_id` table). Update the migration head in `docs/explanation/architecture.md`, `docs/spec/cross-cutting.md` and `docs/spec/knowledge-base.md`; `make docs-check` reads all three.
- **Tenancy:**
  - Every row carries `user_id`, and every kb helper takes `userId` first.
  - The one exception is `reopenOrphanedIncidents()`, an install-wide boot maintenance step like `purgeExpiredJti`.
  - An upsert (select, then insert or update, then evict) runs in one `db.transaction()`.
- **Module boundaries** (`extension/eslint.config.mjs`):
  - `core/incident.mjs` imports only `core/` and `node:`.
  - `kb/incidents.mjs` imports only `kb/` and `core/`.
  - `routes/self-heal.mjs` is imported only by a dynamic `import()` in `server.mjs`, and nothing imports a route.
  - Nothing new is on the boot path, and the Agent SDK and engine are never touched.
- **Desktop host command** `self_heal_take`: registered in `src/lib.rs`, listed in `build.rs` `COMMANDS`, granted in `capabilities/default.json` (`node scripts/check-capabilities.mjs --product` fails on a missing or stale grant). It is always registered, and it answers `enabled: false` in release.
- **Ported numbers (from the Mac app):**
  - 30 frames per trace, flushed after 2 s of quiet
  - 200 incidents per user, evicting the least recently seen that is not `fixing` / `proposed`
  - the last 50 crash ids remembered
  - signature = first 16 hex of sha256(`source␀category␀normalize(message)␀normalize(topOwnFrame)`)
  - Webview buffer: 100 reports, posted in batches of 50.
- Conventional Commits, on `main` (user rule: no branches), one concern per commit, **not pushed**. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Implementer subagents must not spawn subagents.

### Files this plan avoids (parallel work)

It does not touch `extension/routes/feature-routes.mjs`, `extension/routes/router.mjs`, `extension/llm_agent/**`, `extension/routes/agent-v2*.mjs`, `extension/plugins/**`, `extension/mcp/**`, `extension/routes/host-api/**` or `web/**`. In `ui/screens/chat/` only `controller.ts` gets one import and two lines.

Shared hot spots:

- **Rebase first:** `extension/server.mjs` (version line, changelog, `ALL_ENDPOINTS`, the rate-limit lines, one dispatch block, one boot line), `ui/screens/shell/core-api-floor.ts`, the version lines in `docs/spec/*.md`, and `docs/superpowers/MASTER-PLAN.md`.
- **Regenerate, never hand-merge:** `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md` and `extension/src/lib/api-types.ts`.

---

## A. The design in one page

| Piece | Where | What it does |
|---|---|---|
| Rules | `extension/core/incident.mjs` | Redactor, normalizer, top own frame, signature, environmental classifier, `cleanIncident`. Pure. |
| Store | `extension/kb/migrations/0067_self_heal_incidents.sql`, `extension/kb/incidents.mjs` | Upsert by (user, signature), reopen a recurring `fixed` incident, cap at 200, list, ignore, clear, reopen orphaned `fixing` rows. |
| Routes | `extension/routes/self-heal.mjs`, `extension/server.mjs` | `GET` / `POST` / `DELETE /kb/self-heal/incidents` and `POST /kb/self-heal/incidents/:id/ignore`. Proof first. When off: `404 feature_disabled`, the module is not loaded and the paths are not advertised. |
| Host capture | `desktop/src-tauri/src/self_heal.rs`, `core_host.rs`, `crash_report.rs` | Debug gate, stderr parser, per-line redaction, crash import once per id, the 100-report queue, `self_heal_take`. |
| Webview | `ui/screens/shell/self-heal.ts`, `Shell.tsx`, `ui/screens/chat/controller.ts`, `ui/screens/loop/native/NativeLoopScreen.tsx` | The 15 s pump (host take → POST), `reportUiIncident` for Chat and Loop failures, and the enabled flag for Settings. |
| Settings | `ui/screens/settings/self-heal-model.ts`, `sections/SelfHealSection.tsx`, `groups.ts`, `notices.ts`, `registry-default.ts`, `SettingsScreen.tsx` | The Self-Heal group: new status `dev-only`, shown only when the host said enabled. It shows an honest "planned" notice for plan B, then the list with Ignore, Refresh and Clear all. |

**Stderr → incident mapping (host).** The spawned core's stderr is not a TTY, so `core/logger.mjs` writes one JSON object per warn+ line.

| stderr line | source | category | message | stack |
|---|---|---|---|---|
| JSON `level:"error"`, `msg:"request_failed"` (logged by `sendError` with the request logger, so it carries `requestId`, `method`, `url`) | `server` | `<METHOD> <normalized url>` | `message` (else `code`) | `stack` |
| JSON `level:"error"`, `msg:"http_request"`, `status >= 500`, its `requestId` not already reported by a `request_failed` | `server` | `<METHOD> <normalized url>` | `HTTP <status>` | none |
| any other JSON `level:"error"` line (`uncaught_exception`, `unhandled_rejection`, …) | `log` | `msg` | `msg: <error \| message \| reason>` | `stack` |
| a non-JSON line starting an error (`ERROR:`, `Uncaught`, `…Error:`, `^\w*Error\b`), plus the `at …` lines after it (at most 30) | `server` | `server` | the line | the frames |

Warn and info lines, and anything whose `url` starts with `/kb/self-heal`, are ignored, so the store cannot feed itself. A core the app adopted (started in a terminal) is not captured: its stderr is not the host's. That is fine for a debug tool.

**Webview → incident.** A Chat turn that enters the `error` phase reports `{ source: "ui", category: "chat" }`. This is the Mac's `ChatEngine.error` didSet. A Loop run that throws (the runner or a host command failed, not a stage that merely failed its checks) reports `category: "loop"`. The classifier marks environmental ones on the core, and the list shows them as environmental. Plan B skips them.

---

## B. Tasks

### Task 1: Incident rules: redact, normalize, sign, classify (15 min)

**Files:**
- Create: `extension/core/incident.mjs`
- Test: `extension/tests/incident-rules.test.mjs`

**Interfaces:**
- Consumes: `redactSecretsForStorage` from `extension/core/redact-secrets.mjs`.
- Produces:
  - Constants: `INCIDENT_SOURCES` (`['ui','log','crash','server']`), `INCIDENT_STATUSES` (`['new','fixing','proposed','ignored','needsHuman','fixed']`), `MAX_MESSAGE = 2000`, `MAX_STACK = 8000`, `MAX_CATEGORY = 200`
  - `redactIncidentText(text, limit, home?) → string`
  - `normalizeIncidentText(text) → string`
  - `topOwnFrame(stack) → string | null`
  - `incidentSignature({ source, category, message, stack }) → string` (16 hex)
  - `environmentalReason(message) → string | null`
  - `cleanIncident(input, home?) → { id, source, category, message, stack, environmental } | null`

- [ ] **Step 1: Write the failing test** — `extension/tests/incident-rules.test.mjs`:

```js
// Self-Heal incident rules (core/incident.mjs), ported from the Mac app's IncidentRedactor, IncidentSignature and
// IncidentClassifier. Pure: no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactIncidentText, normalizeIncidentText, topOwnFrame, incidentSignature, environmentalReason, cleanIncident,
  MAX_MESSAGE, INCIDENT_STATUSES,
} from '../core/incident.mjs';

const GHP = `ghp_${'a'.repeat(36)}`;

test('redaction: shared secret shapes, JWTs, name=value secrets, emails and the home folder', () => {
  assert.equal(
    redactIncidentText(`token=abc boom 1 eyJa.b.c me@example.com /Users/dev/x ${GHP}`, 2000, '/Users/dev'),
    'token=[REDACTED] boom 1 [REDACTED] [EMAIL] ~/x [REDACTED]',
  );
  assert.equal(redactIncidentText('api_key: "s3cr3t", ok', 2000, ''), 'api_key: "[REDACTED]", ok');
  assert.equal(redactIncidentText('x'.repeat(10), 4, ''), 'xxxx…[truncated]');
  assert.equal(redactIncidentText(null, 10, ''), '');
});

test('normalization folds strings, uuids, paths, hex and numbers', () => {
  assert.equal(
    normalizeIncidentText('Failed "abc" for 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at /tmp/a.txt after 42 ms deadbeef00'),
    'Failed <str> for <uuid> at <path> after <n> ms <hex>',
  );
  assert.equal(normalizeIncidentText('  a \n\t b  '), 'a b');
});

test('the top own frame is the first stack line in extension/, desktop/ or ui/ outside node_modules', () => {
  const stack = 'Error: x\n    at a (node:internal/x:1:2)\n    at b (/r/node_modules/ui/x.js:1:1)\n    at c (~/llm-ide/extension/server.mjs:5:6)';
  assert.equal(topOwnFrame(stack), 'at c (~/llm-ide/extension/server.mjs:5:6)');
  assert.equal(topOwnFrame('Error: x\n    at a (node:internal/x:1:2)'), null);
  assert.equal(topOwnFrame(null), null);
});

test('the signature ignores numbers and line numbers but not the source, category or own frame', () => {
  const base = { source: 'server', category: 'server', message: 'timeout after 30 ms', stack: '    at c (~/x/extension/a.mjs:5:6)' };
  const sig = incidentSignature(base);
  assert.match(sig, /^[0-9a-f]{16}$/);
  assert.equal(incidentSignature({ ...base, message: 'timeout after 99 ms', stack: '    at c (~/x/extension/a.mjs:7:1)' }), sig);
  assert.notEqual(incidentSignature({ ...base, source: 'log' }), sig);
  assert.notEqual(incidentSignature({ ...base, category: 'GET /kb/x' }), sig);
  assert.notEqual(incidentSignature({ ...base, stack: '    at d (~/x/extension/a.mjs:5:6)' }), sig);
});

test('environmental reasons: offline, auth, permission, disk, configuration, cancelled, usage; app bugs are null', () => {
  assert.equal(environmentalReason('connect ECONNREFUSED 127.0.0.1:3456'), 'offline');
  assert.equal(environmentalReason('HTTP 403: forbidden'), 'auth');
  assert.equal(environmentalReason('EACCES: permission denied, open x'), 'permission');
  assert.equal(environmentalReason('ENOSPC: no space left on device'), 'disk');
  assert.equal(environmentalReason('Stage "build" has no runnable command'), 'configuration');
  assert.equal(environmentalReason('The operation was aborted'), 'cancelled');
  assert.equal(environmentalReason('usage: claude [options]'), 'usage');
  assert.equal(environmentalReason('TypeError: x is not a function'), null);
});

test('cleanIncident validates, redacts, caps, signs and classifies', () => {
  assert.equal(cleanIncident(null), null);
  assert.equal(cleanIncident({ source: 'evil', category: 'c', message: 'm' }), null);
  assert.equal(cleanIncident({ source: 'ui', category: 'chat', message: '   ' }), null);
  assert.equal(cleanIncident({ source: 'ui', category: 3, message: 'm' }), null);
  assert.equal(cleanIncident({ source: 'ui', category: 'chat', message: 'm', stack: 7 }), null);
  const c = cleanIncident({ source: 'ui', category: 'chat', message: `fetch failed for me@example.com ${'y'.repeat(3000)}` }, '');
  assert.equal(c.source, 'ui');
  assert.equal(c.category, 'chat');
  assert.ok(c.message.startsWith('fetch failed for [EMAIL] '));
  assert.equal(c.message.length, MAX_MESSAGE + '…[truncated]'.length);
  assert.equal(c.stack, null);
  assert.equal(c.environmental, 'offline');
  assert.match(c.id, /^[0-9a-f]{16}$/);
  assert.deepEqual([...INCIDENT_STATUSES], ['new', 'fixing', 'proposed', 'ignored', 'needsHuman', 'fixed']);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/incident-rules.test.mjs`
Expected: FAIL with `Cannot find module '…/core/incident.mjs'`.

- [ ] **Step 3: Write the rules** — `extension/core/incident.mjs`:

```js
// Self-Heal incident rules (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md), ported from the retired Mac
// app (IncidentRedactor, IncidentSignature, IncidentClassifier). Pure: no I/O, no DB. Incident text is data, never
// instructions: nothing in plan A hands it to a model, logs it or sends it anywhere.
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { redactSecretsForStorage } from './redact-secrets.mjs';

export const INCIDENT_SOURCES = Object.freeze(['ui', 'log', 'crash', 'server']);
export const INCIDENT_STATUSES = Object.freeze(['new', 'fixing', 'proposed', 'ignored', 'needsHuman', 'fixed']);
export const MAX_MESSAGE = 2000;
export const MAX_STACK = 8000;
export const MAX_CATEGORY = 200;
// Raw input is cut before the regexes run, so a huge field cannot make redaction slow.
const RAW_MAX = 50_000;

const KEY_VALUE = /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|passwd))(["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The Mac redactor: shared secret shapes, JWTs, `name=value` secrets, emails, the home folder; then the cap. */
export function redactIncidentText(text, limit, home = homedir()) {
  let out = redactSecretsForStorage(String(text ?? '').slice(0, RAW_MAX));
  out = out.replace(JWT, '[REDACTED]').replace(KEY_VALUE, '$1$2[REDACTED]').replace(EMAIL, '[EMAIL]');
  if (home && home.length > 1) out = out.split(home).join('~');
  return out.length > limit ? `${out.slice(0, limit)}…[truncated]` : out;
}

// Order matters: quoted strings and UUIDs before the hex and number rules eat their parts.
const RULES = [
  [/"[^"\n]*"|'[^'\n]*'/g, '<str>'],
  [/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, '<uuid>'],
  [/(?<![A-Za-z0-9])(?:~\/|\/)[^\s"':,()]+/g, '<path>'],
  [/\b[0-9A-Fa-f]{8,}\b/g, '<hex>'],
  [/\b\d+(?:\.\d+)?\b/g, '<n>'],
  [/\s+/g, ' '],
];

export function normalizeIncidentText(text) {
  let out = String(text ?? '');
  for (const [re, template] of RULES) out = out.replace(re, template);
  return out.trim();
}

const OWN = ['extension/', 'desktop/', 'ui/'];

/** The first stack line that is our code (the extension core, the desktop host or the desktop UI). */
export function topOwnFrame(stack) {
  if (!stack) return null;
  return String(stack).split('\n').map((l) => l.trim())
    .find((l) => !l.includes('node_modules') && OWN.some((o) => l.includes(o))) ?? null;
}

/** Two reports with the same signature are the same incident. */
export function incidentSignature({ source, category, message, stack }) {
  const frame = topOwnFrame(stack);
  const material = [source, category, normalizeIncidentText(message), frame ? normalizeIncidentText(frame) : ''].join('\0');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

// Environment problems, not app bugs (plan B never sends them to the fix agent). The Mac's NSURLErrorDomain needles
// are replaced by the Node error codes; the Loop verdict and configuration phrases are kept verbatim.
const ENV_RULES = [
  ['offline', ['appears to be offline', 'could not connect to the server', 'network connection was lost', 'the request timed out',
    'fetch failed', 'econnrefused', 'enotfound', 'etimedout', 'econnreset']],
  ['auth', ['http 401', 'http 403', 'status 401', 'status 403', 'unauthorized', 'forbidden', 'not signed in']],
  ['permission', ['operation not permitted', 'permission denied', 'eperm', 'eacces']],
  ['disk', ['no space left on device', 'enospc']],
  ['refactor loop', ['failed and does not allow repair', 'to fall; it did not', 'structure regressed:', 'graph not regenerated (']],
  ['configuration', ['has no runnable command', 'has no skill chosen', 'has no checks configured', 'needs a newer version of llm-ide']],
  ['cancelled', ['request was cancelled', 'operation was cancelled', 'cancellationerror', 'cancelled by user', 'user cancelled',
    'the operation was aborted', 'aborterror']],
];

export function environmentalReason(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.startsWith('usage:') || text.includes('no model matching')) return 'usage';
  return ENV_RULES.find(([, needles]) => needles.some((n) => text.includes(n)))?.[0] ?? null;
}

/** A report as stored: validated, redacted, capped, signed, classified. `null` for anything unusable. */
export function cleanIncident(input, home = homedir()) {
  if (!input || typeof input !== 'object') return null;
  const { source, category, message, stack } = input;
  if (!INCIDENT_SOURCES.includes(source)) return null;
  if (typeof category !== 'string' || typeof message !== 'string') return null;
  if (stack != null && typeof stack !== 'string') return null;
  const cat = redactIncidentText(category.trim(), MAX_CATEGORY, home);
  const msg = redactIncidentText(message.trim(), MAX_MESSAGE, home);
  if (!cat || !msg.trim()) return null;
  const stk = stack ? redactIncidentText(stack, MAX_STACK, home) : null;
  const clean = { source, category: cat, message: msg, stack: stk || null };
  return { id: incidentSignature(clean), ...clean, environmental: environmentalReason(msg) };
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `cd extension && node --test tests/incident-rules.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/core/incident.mjs extension/tests/incident-rules.test.mjs
git commit -m "feat(core): Self-Heal incident rules ported from the Mac app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The incident store (migration 0067) (20 min)

**Files:**
- Create: `extension/kb/migrations/0067_self_heal_incidents.sql`
- Create: `extension/kb/incidents.mjs`
- Modify: `extension/kb/db.mjs` (`deleteUserCascade` table list, after `'bus_schedules',`)
- Test: `extension/tests/self-heal-store.test.mjs`

**Interfaces:**
- Consumes: `cleanIncident` (Task 1); `getDb`, `requireUser` from `kb/db.mjs`.
- Produces:
  - `INCIDENT_CAP = 200`
  - `recordIncident(userId, report, now?) → Incident | null`
  - `listIncidents(userId) → Incident[]` (newest `lastSeen` first)
  - `ignoreIncident(userId, id) → boolean`
  - `clearIncidents(userId) → number`
  - `reopenOrphanedIncidents() → number`
  - `Incident = { id, source, category, message, stack, environmental, firstSeen, lastSeen, count, attempts, status, note, proposal }`, where `proposal` is `{ mainRepo, worktreePath, branch, baseCommit }` or `null`

- [ ] **Step 1: Write the failing test** — `extension/tests/self-heal-store.test.mjs`:

```js
// The Self-Heal incident store (kb/incidents.mjs, table self_heal_incidents): upsert by signature, reopen, cap, tenancy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_self-heal-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const store = await import('../kb/incidents.mjs');
after(() => { kb.closeDb(); wipe(); });

let n = 0;
const mkUser = () => users.registerUser(kb.getDb(), { email: `shs-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;
const sql = (q, ...a) => kb.getDb().prepare(q).run(...a);

test('a repeat bumps count and lastSeen, keeps the first stack when the repeat has none, and stays per user', () => {
  const u = mkUser();
  const other = mkUser();
  const first = store.recordIncident(u, { source: 'server', category: 'server', message: 'Error: boom 1', stack: 'S' }, 10);
  assert.equal(first.status, 'new');
  const again = store.recordIncident(u, { source: 'server', category: 'server', message: 'Error: boom 2' }, 5);
  assert.equal(again.id, first.id, 'numbers do not change the signature');
  assert.deepEqual([again.count, again.firstSeen, again.lastSeen, again.stack, again.message], [2, 10, 10, 'S', 'Error: boom 2']);
  assert.equal(store.recordIncident(u, { source: 'nope', category: 'c', message: 'm' }), null);
  assert.deepEqual(store.listIncidents(other), []);
  assert.equal(store.listIncidents(u).length, 1);
});

test('a fixed incident that recurs reopens as new with attempts + 1 and no proposal', () => {
  const u = mkUser();
  const inc = store.recordIncident(u, { source: 'log', category: 'uncaught_exception', message: 'uncaught_exception: x' }, 1);
  sql(`UPDATE self_heal_incidents SET status = 'fixed', proposal_main_repo = '/r', proposal_worktree = '/w', proposal_branch = 'b',
    proposal_base_commit = 'c' WHERE user_id = ? AND id = ?`, u, inc.id);
  assert.deepEqual(store.listIncidents(u)[0].proposal, { mainRepo: '/r', worktreePath: '/w', branch: 'b', baseCommit: 'c' });
  const back = store.recordIncident(u, { source: 'log', category: 'uncaught_exception', message: 'uncaught_exception: x' }, 2);
  assert.deepEqual([back.status, back.attempts, back.count, back.proposal], ['new', 1, 2, null]);
});

test('200 per user: the least recently seen that is not fixing or proposed is evicted', () => {
  const u = mkUser();
  for (let i = 0; i < 200; i++) store.recordIncident(u, { source: 'log', category: `c-${i}`, message: 'boom' }, 1000 + i);
  sql("UPDATE self_heal_incidents SET status = 'fixing' WHERE user_id = ? AND category = 'c-0'", u);
  store.recordIncident(u, { source: 'log', category: 'c-200', message: 'boom' }, 5000);
  const cats = new Set(store.listIncidents(u).map((i) => i.category));
  assert.equal(cats.size, store.INCIDENT_CAP);
  assert.ok(cats.has('c-0'), 'a fixing incident is never evicted');
  assert.ok(!cats.has('c-1'), 'the oldest other one is');
  assert.ok(cats.has('c-200'));
});

test('ignore and clear spare fixing and proposed incidents; orphaned fixing rows go back to new', () => {
  const u = mkUser();
  const a = store.recordIncident(u, { source: 'ui', category: 'chat', message: 'a failed' }, 1);
  const b = store.recordIncident(u, { source: 'ui', category: 'loop', message: 'b failed' }, 2);
  assert.equal(store.ignoreIncident(u, a.id), true);
  assert.equal(store.ignoreIncident(mkUser(), a.id), false, 'another user cannot');
  assert.equal(store.ignoreIncident(u, '0000000000000000'), false);
  sql("UPDATE self_heal_incidents SET status = 'fixing' WHERE user_id = ? AND id = ?", u, b.id);
  assert.equal(store.ignoreIncident(u, b.id), false);
  assert.equal(store.clearIncidents(u), 1);
  assert.deepEqual(store.listIncidents(u).map((i) => [i.id, i.status]), [[b.id, 'fixing']]);
  assert.ok(store.reopenOrphanedIncidents() >= 1);
  assert.equal(store.listIncidents(u)[0].status, 'new');
});

test('the incidents go with the account', () => {
  const u = mkUser();
  store.recordIncident(u, { source: 'crash', category: 'crash', message: 'index out of bounds' }, 1);
  const counts = kb.deleteUserCascade(u);
  assert.equal(counts.self_heal_incidents, 1);
  assert.equal(kb.getDb().prepare('SELECT COUNT(*) AS n FROM self_heal_incidents WHERE user_id = ?').get(u).n, 0);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/self-heal-store.test.mjs`
Expected: FAIL with `Cannot find module '…/kb/incidents.mjs'`.

- [ ] **Step 3: Write the migration** — `extension/kb/migrations/0067_self_heal_incidents.sql`:

```sql
-- Self-Heal incidents (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md). Debug desktop builds only: written
-- only while the core runs with LLMIDE_SELF_HEAL=1. One row per user and signature (id = 16 hex). Text is redacted
-- before it is stored (core/incident.mjs). Plan A writes new and ignored; plan B drives fixing, proposed, needsHuman,
-- fixed, attempts and the proposal columns (all nullable until then).
CREATE TABLE IF NOT EXISTS self_heal_incidents (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('ui', 'log', 'crash', 'server')),
  category             TEXT NOT NULL,
  message              TEXT NOT NULL,
  stack                TEXT,
  environmental        TEXT,
  first_seen           INTEGER NOT NULL,
  last_seen            INTEGER NOT NULL,
  count                INTEGER NOT NULL DEFAULT 1,
  attempts             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'fixing', 'proposed', 'ignored', 'needsHuman', 'fixed')),
  note                 TEXT,
  proposal_main_repo   TEXT,
  proposal_worktree    TEXT,
  proposal_branch      TEXT,
  proposal_base_commit TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_self_heal_incidents_seen ON self_heal_incidents (user_id, last_seen);
```

- [ ] **Step 4: Write the store** — `extension/kb/incidents.mjs`:

```js
// Self-Heal incident store (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md; table self_heal_incidents,
// migration 0067), the Mac's IncidentStore. One row per user and signature:
//   - a repeat bumps count and lastSeen;
//   - a fixed incident that recurs reopens as new with attempts + 1;
//   - at most INCIDENT_CAP rows are kept per user (the least recently seen that is not fixing or proposed goes first).
// cleanIncident redacts the text before anything is stored. Plan A writes only new and ignored. Plan B drives the
// other statuses and the proposal columns. Nothing here logs incident text.
import { getDb, requireUser } from './db.mjs';
import { cleanIncident } from '../core/incident.mjs';

export const INCIDENT_CAP = 200;
const BUSY = "('fixing', 'proposed')";

const toIncident = (r) => ({
  id: r.id,
  source: r.source,
  category: r.category,
  message: r.message,
  stack: r.stack,
  environmental: r.environmental,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  count: r.count,
  attempts: r.attempts,
  status: r.status,
  note: r.note,
  proposal: r.proposal_worktree
    ? { mainRepo: r.proposal_main_repo, worktreePath: r.proposal_worktree, branch: r.proposal_branch, baseCommit: r.proposal_base_commit }
    : null,
});

/** Records one report (redacted, signed). Returns the stored incident, or null when the report is unusable. */
export function recordIncident(userId, report, now = Date.now()) {
  requireUser(userId);
  const c = cleanIncident(report);
  if (!c) return null;
  const db = getDb();
  return db.transaction(() => {
    const prev = db.prepare('SELECT status FROM self_heal_incidents WHERE user_id = ? AND id = ?').get(userId, c.id);
    if (prev) {
      db.prepare(`UPDATE self_heal_incidents SET count = count + 1, last_seen = MAX(last_seen, ?), message = ?,
          stack = COALESCE(?, stack), environmental = ? WHERE user_id = ? AND id = ?`)
        .run(now, c.message, c.stack, c.environmental, userId, c.id);
      if (prev.status === 'fixed') {
        db.prepare(`UPDATE self_heal_incidents SET status = 'new', attempts = attempts + 1, proposal_main_repo = NULL,
            proposal_worktree = NULL, proposal_branch = NULL, proposal_base_commit = NULL WHERE user_id = ? AND id = ?`)
          .run(userId, c.id);
      }
    } else {
      db.prepare(`INSERT INTO self_heal_incidents (user_id, id, source, category, message, stack, environmental, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, c.id, c.source, c.category, c.message, c.stack, c.environmental, now, now);
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM self_heal_incidents WHERE user_id = ?').get(userId);
      if (n > INCIDENT_CAP) {
        db.prepare(`DELETE FROM self_heal_incidents WHERE user_id = ? AND id IN (
            SELECT id FROM self_heal_incidents WHERE user_id = ? AND id != ? AND status NOT IN ${BUSY}
            ORDER BY last_seen ASC, first_seen ASC LIMIT ?)`)
          .run(userId, userId, c.id, n - INCIDENT_CAP);
      }
    }
    return toIncident(db.prepare('SELECT * FROM self_heal_incidents WHERE user_id = ? AND id = ?').get(userId, c.id));
  })();
}

/** The user's incidents, most recently seen first. */
export function listIncidents(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM self_heal_incidents WHERE user_id = ? ORDER BY last_seen DESC, id')
    .all(userId).map(toIncident);
}

/** Marks one incident ignored. False when it is not the user's, unknown, or held by a fix run (fixing / proposed). */
export function ignoreIncident(userId, id) {
  requireUser(userId);
  return getDb().prepare(`UPDATE self_heal_incidents SET status = 'ignored' WHERE user_id = ? AND id = ? AND status NOT IN ${BUSY}`)
    .run(userId, String(id)).changes > 0;
}

/** Deletes the user's incidents except the ones a fix run holds. Returns how many were deleted. */
export function clearIncidents(userId) {
  requireUser(userId);
  return getDb().prepare(`DELETE FROM self_heal_incidents WHERE user_id = ? AND status NOT IN ${BUSY}`).run(userId).changes;
}

/**
 * Boot maintenance, install-wide like purgeExpiredJti. A `fixing` incident with no run holding it was left by a core
 * that quit or crashed mid-run. Nothing will ever answer it, so it goes back to `new` (the Mac's IncidentStore.load).
 */
export function reopenOrphanedIncidents() {
  return getDb().prepare("UPDATE self_heal_incidents SET status = 'new' WHERE status = 'fixing'").run().changes;
}
```

- [ ] **Step 5: Delete the table with the account** — `extension/kb/db.mjs`, in the `deleteUserCascade` table list, replace:

```js
      // migration 0063 — desktop schedules for bus kinds (standing approvals)
      'bus_schedules',
    ]) {
```

with:

```js
      // migration 0063 — desktop schedules for bus kinds (standing approvals)
      'bus_schedules',
      // migration 0067 — Self-Heal incidents (debug desktop builds)
      'self_heal_incidents',
    ]) {
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd extension && node --test tests/self-heal-store.test.mjs tests/user-delete-cascade.test.mjs`
Expected: PASS (both files; the cascade file seeds `self_heal_incidents` through its `source IN (…)` CHECK and finds no row left).

- [ ] **Step 7: Commit**

```bash
git add extension/kb/migrations/0067_self_heal_incidents.sql extension/kb/incidents.mjs extension/kb/db.mjs extension/tests/self-heal-store.test.mjs
git commit -m "feat(kb): Self-Heal incident store (migration 0067)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Self-Heal routes (15 min)

**Files:**
- Create: `extension/routes/self-heal.mjs`
- Test: `extension/tests/self-heal-routes.test.mjs`

**Interfaces:**
- Consumes: Task 2 store functions; `verifyBusHostProof(req, env)` from `core/host-approval.mjs`; `send`, `readJson` from `server/route-http.mjs`.
- Produces:
  - `MAX_BATCH = 50`
  - `handleSelfHealRoute(req, res, { env? }) → Promise<true>` (it always answers)
  - HTTP:
    - `GET /kb/self-heal/incidents → { incidents }`
    - `POST /kb/self-heal/incidents { incidents: [{ source, category, message, stack? }] } → { recorded, skipped }`
    - `POST /kb/self-heal/incidents/:id/ignore → { ignored }`
    - `DELETE /kb/self-heal/incidents → { deleted }`
    - Errors: `403 HOST_PROOF_REQUIRED`, `400 VALIDATION_FAILED`, `404 NOT_FOUND` (unknown sub-path)

- [ ] **Step 1: Write the failing test** — `extension/tests/self-heal-routes.test.mjs`:

```js
// The Self-Heal routes (routes/self-heal.mjs): JWT user + bus host proof, then the store (real DB).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_self-heal-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const KEY_HEX = 'd4'.repeat(32);
const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX };
const PROOF = crypto.createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update('bus-host-proof/v1').digest('hex');

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleSelfHealRoute } = await import('../routes/self-heal.mjs');

const mk = (tag) => users.registerUser(kb.getDb(), { email: `shr-${tag}-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: tag }).id;
const owner = mk('a');
const other = mk('b');
const state = { userId: owner };
const server = http.createServer((req, res) => {
  req.user = { id: state.userId };
  void handleSelfHealRoute(req, res, { env });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); kb.closeDb(); wipe(); });
async function call(method, p, body, { proof = PROOF } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(proof ? { 'x-llmide-host-nonce': proof } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const R = '/kb/self-heal/incidents';
const report = (o = {}) => ({ source: 'server', category: 'POST /kb/notes/:id', message: 'db is locked for me@example.com', stack: 'Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)', ...o });

test('without the host proof every route answers 403 HOST_PROOF_REQUIRED and records nothing', async () => {
  for (const [m, p, b] of [['GET', R], ['POST', R, { incidents: [report()] }], ['POST', `${R}/0123456789abcdef/ignore`], ['DELETE', R]]) {
    const r = await call(m, p, b, { proof: null });
    assert.deepEqual([r.status, r.body.error.code], [403, 'HOST_PROOF_REQUIRED'], `${m} ${p}`);
  }
  assert.deepEqual((await call('GET', R)).body, { incidents: [] });
});

test('POST records redacted, deduped incidents; unusable reports are skipped; the batch is bounded', async () => {
  for (const b of [{}, { incidents: [] }, { incidents: 'x' }, { incidents: Array.from({ length: 51 }, () => report()) }]) {
    const r = await call('POST', R, b);
    assert.deepEqual([r.status, r.body.error.code], [400, 'VALIDATION_FAILED'], JSON.stringify(b).slice(0, 60));
  }
  const r = await call('POST', R, { incidents: [report(), report({ message: 'db is locked for you@example.com' }), report({ source: 'evil' }), report({ message: '  ' }), 7] });
  assert.deepEqual(r, { status: 200, body: { recorded: 2, skipped: 3 } });
  const { incidents } = (await call('GET', R)).body;
  assert.equal(incidents.length, 1, 'both emails redact to [EMAIL], so one signature');
  assert.equal(incidents[0].count, 2);
  assert.equal(incidents[0].message, 'db is locked for [EMAIL]');
  assert.match(incidents[0].id, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(incidents[0]).sort(), ['attempts', 'category', 'count', 'environmental', 'firstSeen', 'id', 'lastSeen', 'message', 'note', 'proposal', 'source', 'stack', 'status']);
});

test('ignore is per user, an unknown path is 404, and DELETE clears', async () => {
  const [inc] = (await call('GET', R)).body.incidents;
  state.userId = other;
  assert.deepEqual((await call('GET', R)).body, { incidents: [] });
  assert.deepEqual((await call('POST', `${R}/${inc.id}/ignore`)).body, { ignored: false });
  state.userId = owner;
  assert.deepEqual((await call('POST', `${R}/${inc.id}/ignore`)).body, { ignored: true });
  assert.equal((await call('GET', R)).body.incidents[0].status, 'ignored');
  const bad = await call('POST', `${R}/NOT-HEX/ignore`);
  assert.deepEqual([bad.status, bad.body.error.code], [404, 'NOT_FOUND']);
  assert.deepEqual((await call('DELETE', R)).body, { deleted: 1 });
  assert.deepEqual((await call('GET', R)).body, { incidents: [] });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/self-heal-routes.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/self-heal.mjs'`.

- [ ] **Step 3: Write the routes** — `extension/routes/self-heal.mjs`:

```js
// Self-Heal incident routes (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md; contract
// schema/http/self-heal.schema.json). server.mjs imports this module only while config.selfHeal is on
// (LLMIDE_SELF_HEAL=1, which the Tauri host passes only in a debug build). Otherwise every path answers
// 404 feature_disabled before this module loads. Every route needs the JWT AND the bus host proof, so only the desktop
// UI of the core the host spawned reaches the store. Nothing here logs incident text.
//
//   GET    /kb/self-heal/incidents              { incidents }          the user's incidents, newest first
//   POST   /kb/self-heal/incidents              { recorded, skipped }  record 1-50 reports (an unusable one is skipped)
//   POST   /kb/self-heal/incidents/:id/ignore   { ignored }            mark one ignored (not while fixing or proposed)
//   DELETE /kb/self-heal/incidents              { deleted }            remove all but fixing / proposed
import { send, readJson } from '../server/route-http.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { clearIncidents, ignoreIncident, listIncidents, recordIncident } from '../kb/incidents.mjs';

export const MAX_BATCH = 50;
const BODY_MAX = 4 * 1024 * 1024;
const IGNORE_RE = /^\/kb\/self-heal\/incidents\/([0-9a-f]{16})\/ignore$/;
const fail = (res, status, code, message) => { send(res, status, { error: { code, message } }); return true; };

export async function handleSelfHealRoute(req, res, { env = process.env } = {}) {
  const path = String(req.url || '').split('?')[0];
  if (!verifyBusHostProof(req, env)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const userId = req.user?.id;
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');

  if (req.method === 'GET' && path === '/kb/self-heal/incidents') {
    send(res, 200, { incidents: listIncidents(userId) });
    return true;
  }
  if (req.method === 'POST' && path === '/kb/self-heal/incidents') {
    let body;
    try { body = await readJson(req, BODY_MAX); } catch { return fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); }
    const list = body?.incidents;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) {
      return fail(res, 400, 'VALIDATION_FAILED', `incidents must be an array of 1 to ${MAX_BATCH} reports`);
    }
    let recorded = 0;
    for (const item of list) if (recordIncident(userId, item)) recorded += 1;
    send(res, 200, { recorded, skipped: list.length - recorded });
    return true;
  }
  const ignore = req.method === 'POST' ? IGNORE_RE.exec(path) : null;
  if (ignore) {
    send(res, 200, { ignored: ignoreIncident(userId, ignore[1]) });
    return true;
  }
  if (req.method === 'DELETE' && path === '/kb/self-heal/incidents') {
    send(res, 200, { deleted: clearIncidents(userId) });
    return true;
  }
  return fail(res, 404, 'NOT_FOUND', 'Unknown Self-Heal route');
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `cd extension && node --test tests/self-heal-routes.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/routes/self-heal.mjs extension/tests/self-heal-routes.test.mjs
git commit -m "feat(server): Self-Heal incident routes behind the bus host proof

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the switch into the core (20 min)

**Files:**
- Modify: `extension/core/config.mjs` (one key after `hostApiMode`)
- Modify: `extension/server.mjs`:
  - `isSelfHealRoute` next to `isSyncRoute` (~line 333)
  - `ENDPOINTS` (~line 540)
  - three rate-limit lines in `rateLimitProfile`
  - the dispatch block before the Host API block (~line 848)
  - the boot reopen before `logger.info('server_started'` (~line 1513)
- Test: `extension/tests/self-heal-server.test.mjs`

**Interfaces:**
- Consumes: `handleSelfHealRoute` (Task 3), `reopenOrphanedIncidents` (Task 2), `sendFeatureDisabled` (already imported in `server.mjs`).
- Produces: `config.selfHeal: boolean`. With it off, `/kb/self-heal/*` answers `404 { error: 'feature_disabled', feature: 'self_heal' }`, and `/health` `endpoints` has no `/kb/self-heal` path.

- [ ] **Step 1: Write the failing test** — `extension/tests/self-heal-server.test.mjs`:

```js
// End-to-end: a real `node server.mjs` serves Self-Heal only with LLMIDE_SELF_HEAL=1. Off (the default and every
// release build): every path is 404 feature_disabled and /health does not advertise them. Spawns the server on a free
// loopback port, so it needs local listen permission (run the suite with the sandbox disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = [['GET', '/kb/self-heal/incidents'], ['POST', '/kb/self-heal/incidents'], ['DELETE', '/kb/self-heal/incidents'], ['POST', '/kb/self-heal/incidents/0123456789abcdef/ignore']];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function withServer(selfHeal, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-self-heal-'));
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_LOG_FILE: 'none',
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_ENV;
  delete env.LLMIDE_HOST_APPROVAL_KEY;
  if (selfHeal == null) delete env.LLMIDE_SELF_HEAL; else env.LLMIDE_SELF_HEAL = selfHeal;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode == null) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, `server answered /health (output: ${output.slice(-2000)})`);
    await fn(health, base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function bearer(base) {
  const email = `shs-${Date.now()}@example.com`;
  const post = (p, o) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
  assert.equal((await post('/auth/register', { email, password: 'CorrectHorseBattery', displayName: 'S' })).status, 201);
  const { accessToken } = await (await post('/auth/login', { email, password: 'CorrectHorseBattery' })).json();
  return { authorization: `Bearer ${accessToken}` };
}

test('off by default: not advertised, every path 404 feature_disabled', async () => {
  await withServer(null, async (health, base) => {
    assert.ok(!health.endpoints.some((e) => e.startsWith('/kb/self-heal')));
    const auth = await bearer(base);
    for (const [m, p] of PATHS) {
      const r = await fetch(base + p, { method: m, headers: auth });
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.deepEqual(await r.json(), { error: 'feature_disabled', feature: 'self_heal' });
    }
  });
});

test('LLMIDE_SELF_HEAL=1: advertised, and every route asks for the host proof first', async () => {
  await withServer('1', async (health, base) => {
    assert.ok(health.endpoints.includes('/kb/self-heal/incidents'));
    assert.ok(health.endpoints.includes('/kb/self-heal/incidents/:id/ignore'));
    const auth = await bearer(base);
    for (const [m, p] of PATHS) {
      const r = await fetch(base + p, { method: m, headers: auth });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal((await r.json()).error.code, 'HOST_PROOF_REQUIRED');
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run (unsandboxed: it listens on loopback): `cd extension && node --test tests/self-heal-server.test.mjs`
Expected: FAIL. The off test gets `401` or `404 NOT_FOUND` instead of `feature_disabled`, and the on test finds no `/kb/self-heal/incidents` in `endpoints`.

- [ ] **Step 3: The config key** — `extension/core/config.mjs`, replace:

```js
  hostApiMode:          HOST_API_TLS ? 'tls' : HOST_API_DEV ? 'dev' : 'off',
```

with:

```js
  hostApiMode:          HOST_API_TLS ? 'tls' : HOST_API_DEV ? 'dev' : 'off',

  // Self-Heal incident capture (routes/self-heal.mjs): the Tauri host passes LLMIDE_SELF_HEAL=1 only in a debug build.
  // Off: /kb/self-heal/* answers 404 feature_disabled and nothing is recorded. Never in production.
  selfHeal:             process.env.LLMIDE_SELF_HEAL === '1' && !isProd,
```

- [ ] **Step 4: Server wiring** — `extension/server.mjs`:

After the line `const isSyncRoute = (url) => { const p = String(url || '').split('?')[0]; return p === '/kb/sync' || p.startsWith('/kb/sync/'); };` add:

```js
const isSelfHealRoute = (url) => { const p = String(url || '').split('?')[0]; return p === '/kb/self-heal' || p.startsWith('/kb/self-heal/'); };
```

Replace `const ENDPOINTS = enabledEndpoints(ALL_ENDPOINTS, config.features);` with:

```js
// Self-Heal paths are advertised only while config.selfHeal is on (debug desktop builds).
const ENDPOINTS = enabledEndpoints(ALL_ENDPOINTS, config.features).filter((e) => config.selfHeal || !isSelfHealRoute(e));
```

In `rateLimitProfile`:

  - In the `GET` block, after `    if (path.startsWith('/kb/sync/')) return 'kbWrite';` add `    if (path.startsWith('/kb/self-heal/')) return 'kbWrite';`.
  - In the `PUT || DELETE` block, after `    if (path.startsWith('/kb/index/notes/')) return 'kbWrite';` add `    if (path.startsWith('/kb/self-heal/')) return 'kbWrite';`.
  - In the POST part, after `  if (url.startsWith('/kb/sync/'))       return 'kbWrite';` add `  if (url.startsWith('/kb/self-heal/'))  return 'kbWrite';`.

Before the line `  // Host API v1 pairing PIN and devices (/host-api/*): JWT + bus host proof; 404 HOST_API_DISABLED unless LLMIDE_HOST_API_TLS=1 or LLMIDE_HOST_API_DEV=1.` add:

```js
  // Self-Heal incidents (/kb/self-heal/*): debug desktop builds only (config.selfHeal). Off: the feature-disabled 404
  // and the module is never loaded. On: JWT + bus host proof inside the route.
  if (isSelfHealRoute(req.url || '')) {
    if (!config.selfHeal) { sendFeatureDisabled(res, 'self_heal'); return; }
    try { const { handleSelfHealRoute } = await import('./routes/self-heal.mjs'); await handleSelfHealRoute(req, res); } catch (err) { sendError(res, err, { logger: reqLog }); }
    return;
  }
```

Before the line `  logger.info('server_started', {` add:

```js
  // Self-Heal (debug builds): a 'fixing' incident whose run died with the last core goes back to 'new' (plan B runs).
  if (config.selfHeal) {
    void import('./kb/incidents.mjs').then((m) => m.reopenOrphanedIncidents())
      .catch((err) => logger.warn('self_heal_reopen_failed', { error: err.message }));
  }
```

The `ALL_ENDPOINTS` entries come in Task 5. Until then the "on" test still fails its two `endpoints` asserts.

- [ ] **Step 5: Add the two roster entries now** (the test needs them; Task 5 does the rest of the API bump). In `ALL_ENDPOINTS`, after `  '/kb/sync/rotate',` add:

```js
  '/kb/self-heal/incidents',
  '/kb/self-heal/incidents/:id/ignore',
```

- [ ] **Step 6: Run the tests and see them pass**

Run (unsandboxed): `cd extension && node --test tests/self-heal-server.test.mjs tests/server-features-health.test.mjs tests/lazy-engine.test.mjs tests/feature-routes.test.mjs`
Expected: PASS. `lazy-engine` confirms that nothing new is on the boot path.

- [ ] **Step 7: Commit**

```bash
git add extension/core/config.mjs extension/server.mjs extension/tests/self-heal-server.test.mjs
git commit -m "feat(server): serve Self-Heal only with LLMIDE_SELF_HEAL=1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API v121, the HTTP contract and the spec lines (25 min)

**Files:**
- Modify: `extension/server.mjs` (`SERVER_API_VERSION`, one changelog line)
- Modify: `ui/screens/shell/core-api-floor.ts` (`APP_API_VERSION`)
- Modify: `docs/spec/api-server.md` (version line, `kbWrite` row, new section 7m), `docs/spec/cross-cutting.md` (version and migration head), `docs/spec/knowledge-base.md` (migration line), `docs/explanation/architecture.md` (migration head)
- Create: `schema/http/self-heal.schema.json`, and 13 fixtures in `schema/http/fixtures/self-heal/`
- Modify: `extension/tests/http-contract-live.test.mjs` (one skip row after the sync row), `scripts/http-inventory.mjs` (one `noHandler` row)
- Regenerate: `docs/reference/api/openapi.yaml`, `extension/src/lib/api-types.ts`, `schema/http/INVENTORY.md`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: API 121, and the contract group `self-heal` with `$defs` `Incident` and `FeatureDisabled`.

- [ ] **Step 1: Version and changelog** — `extension/server.mjs`: change `const SERVER_API_VERSION = 120;` to `const SERVER_API_VERSION = 121;`. Directly above the line that starts with `//   v120 — push notifications sent by the desktop`, add:

```js
//   v121 — Self-Heal incidents (plan A), additive, debug desktop builds only (LLMIDE_SELF_HEAL=1, which the Tauri host passes only in a debug build; never with NODE_ENV=production; contract schema/http/self-heal.schema.json): GET /kb/self-heal/incidents → { incidents: Incident[] } (most recently seen first; Incident = { id (16 hex signature), source ui|log|crash|server, category, message, stack, environmental, firstSeen, lastSeen, count, attempts, status new|fixing|proposed|ignored|needsHuman|fixed, note, proposal }); POST /kb/self-heal/incidents { incidents: [{ source, category, message, stack? }] (1-50) } → { recorded, skipped } (redacted, deduped by signature, 200 per user; an unusable report is skipped); POST /kb/self-heal/incidents/:id/ignore → { ignored }; DELETE /kb/self-heal/incidents → { deleted } (keeps fixing and proposed). JWT + bus host proof (403 HOST_PROOF_REQUIRED first); without the switch every path answers 404 { error: 'feature_disabled', feature: 'self_heal' } and /health does not advertise them; 'kbWrite' bucket. Migration 0067 self_heal_incidents.
```

`ui/screens/shell/core-api-floor.ts`: `export const APP_API_VERSION = 121;`.

- [ ] **Step 2: The spec lines**

  - `docs/spec/api-server.md`:
    - Change `SERVER_API_VERSION = 120` to `SERVER_API_VERSION = 121`. Also replace the `(server.mjs:330)` beside it with the line that `grep -n "^const SERVER_API_VERSION" extension/server.mjs` prints.
    - In the `| \`kbWrite\` |` row of the rate-limit table, after `` `/kb/sync/` (status, MEGA setup and the enable toggle)`` add `` , `/kb/self-heal/` (Self-Heal incidents, debug desktop builds)``.
    - Before `## 8. See also`, add:

```markdown
## 7m. Self-Heal incidents (API 121)

`GET /kb/self-heal/incidents`, `POST /kb/self-heal/incidents { incidents: [{ source, category, message, stack? }] }` (1-50), `POST /kb/self-heal/incidents/:id/ignore` and `DELETE /kb/self-heal/incidents` (`extension/routes/self-heal.mjs`, contract `schema/http/self-heal.schema.json`) exist only while the core runs with `LLMIDE_SELF_HEAL=1`. The Tauri host passes it only in a debug build (`self_heal.rs`). Without it, every path answers `404 { error: 'feature_disabled', feature: 'self_heal' }`, the module is never imported and `/health` does not advertise the paths.

With the switch on:
- **Guard:** JWT + bus host proof (`403 HOST_PROOF_REQUIRED` first), `kbWrite` bucket.
- **Redaction** (`extension/core/incident.mjs`): the shared secret patterns, JWTs, `name=value` secrets, emails and the home folder; message 2000, stack 8000 characters.
- **Signature:** the first 16 hex of sha256 over the source, category, normalized message and top own stack frame.
- **Store** (`self_heal_incidents`, `extension/kb/incidents.mjs`, migration 0067):
  - A repeat bumps `count` / `lastSeen`.
  - A `fixed` incident reopens as `new` with `attempts + 1`.
  - At most 200 per user; the least recently seen goes first, never `fixing` / `proposed`.
- **Invalid reports:** an unusable report is skipped (`skipped`), not refused.

Incident text is data. It is never logged, never sent anywhere, and never given to a model in plan A.
```

  - `docs/spec/cross-cutting.md`:
    - `SERVER_API_VERSION = 120` → `SERVER_API_VERSION = 121`, with the same `server.mjs:` line fix.
    - `The head migration is \`0066\` (\`0066_host_api_push.sql\`).` → `The head migration is \`0067\` (\`0067_self_heal_incidents.sql\`).`
  - `docs/spec/knowledge-base.md`: replace `` through `0066_host_api_push.sql` | DDL deltas (66 files as of this writing). Recent: `` with `` through `0067_self_heal_incidents.sql` | DDL deltas (67 files as of this writing). Recent: `0067_self_heal_incidents.sql` adds `self_heal_incidents` (Self-Heal incidents per user and signature, debug desktop builds only, at most 200 per user; the plan B status and proposal fields stay null in plan A; see [api-server](api-server.md) section 7m); ``.
  - `docs/explanation/architecture.md`: `` (currently `0001`–`0066`) `` → `` (currently `0001`–`0067`) ``.

- [ ] **Step 3: The contract** — `schema/http/self-heal.schema.json`:

```json
{
  "description": "Self-Heal incidents (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md): the desktop Settings Self-Heal group's routes, debug desktop builds only. Served by extension/routes/self-heal.mjs, dispatched from extension/server.mjs after authenticate and the rate limiter. Without LLMIDE_SELF_HEAL=1 every path answers 404 feature_disabled (feature self_heal) and the module is never loaded. With it, every route needs the JWT AND the bus host proof header x-llmide-host-nonce, checked first: without it 403 HOST_PROOF_REQUIRED. Per user. Incident text is redacted before it is stored, is data and never instructions, and is never logged or sent anywhere.",
  "$defs": {
    "Incident": {
      "type": "object",
      "required": ["id", "source", "category", "message", "stack", "environmental", "firstSeen", "lastSeen", "count", "attempts", "status", "note", "proposal"],
      "properties": {
        "id": { "type": "string", "description": "the signature: first 16 hex of sha256(source, category, normalized message, top own stack frame)" },
        "source": { "type": "string", "enum": ["ui", "log", "crash", "server"] },
        "category": { "type": "string", "description": "chat | loop | crash | server | <logger msg> | <METHOD> <normalized endpoint>" },
        "message": { "type": "string", "description": "redacted, at most 2000 characters" },
        "stack": { "type": ["string", "null"], "description": "redacted, at most 8000 characters" },
        "environmental": { "type": ["string", "null"], "description": "offline | auth | permission | disk | refactor loop | configuration | cancelled | usage (not an app bug), else null" },
        "firstSeen": { "type": "integer", "description": "ms since epoch" },
        "lastSeen": { "type": "integer", "description": "ms since epoch" },
        "count": { "type": "integer" },
        "attempts": { "type": "integer", "description": "how often a fixed incident came back (plan B)" },
        "status": { "type": "string", "enum": ["new", "fixing", "proposed", "ignored", "needsHuman", "fixed"] },
        "note": { "type": ["string", "null"] },
        "proposal": { "type": ["object", "null"], "additionalProperties": true, "description": "plan B: { mainRepo, worktreePath, branch, baseCommit }; always null in plan A" }
      }
    },
    "FeatureDisabled": {
      "type": "object",
      "required": ["error", "feature"],
      "properties": {
        "error": { "const": "feature_disabled" },
        "feature": { "type": "string" }
      },
      "description": "404 body while the core runs without LLMIDE_SELF_HEAL=1 (feature self_heal). Deliberately not the Error envelope, the same shape as a disabled feature route group."
    }
  },
  "endpoints": {
    "GET /kb/self-heal/incidents": {
      "responses": {
        "200": {
          "type": "object",
          "properties": { "incidents": { "type": "array", "items": { "$ref": "#/$defs/Incident" } } }
        },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "#/$defs/FeatureDisabled" }
      }
    },
    "POST /kb/self-heal/incidents": {
      "request": {
        "body": {
          "type": "object",
          "required": ["incidents"],
          "properties": {
            "incidents": {
              "type": "array",
              "description": "1-50 reports; an unusable one is skipped, not refused",
              "items": {
                "type": "object",
                "required": ["source", "category", "message"],
                "properties": {
                  "source": { "type": "string", "enum": ["ui", "log", "crash", "server"] },
                  "category": { "type": "string" },
                  "message": { "type": "string" },
                  "stack": { "type": ["string", "null"] }
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "type": "object",
          "properties": {
            "recorded": { "type": "integer" },
            "skipped": { "type": "integer" }
          }
        },
        "400": { "$ref": "_common#/$defs/Error" },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "#/$defs/FeatureDisabled" }
      }
    },
    "POST /kb/self-heal/incidents/:id/ignore": {
      "request": {
        "params": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string", "description": "16 hex" } } }
      },
      "responses": {
        "200": {
          "type": "object",
          "properties": { "ignored": { "type": "boolean", "description": "false when unknown, another user's, or held by a fix run" } }
        },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "#/$defs/FeatureDisabled" }
      }
    },
    "DELETE /kb/self-heal/incidents": {
      "responses": {
        "200": {
          "type": "object",
          "properties": { "deleted": { "type": "integer" } }
        },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "#/$defs/FeatureDisabled" }
      }
    }
  }
}
```

The fixtures go in `schema/http/fixtures/self-heal/`, one object per file, written without the `//` name line. The 200 and 400 rows were transcribed from `tests/self-heal-routes.test.mjs`, and the 404 rows from `tests/self-heal-server.test.mjs`. Ids and times are example values.

```json
// get-kb-self-heal-incidents-200.json
{ "endpoint": "GET /kb/self-heal/incidents", "status": 200, "response": { "incidents": [{ "id": "3f9a1c0b7d2e4a65", "source": "server", "category": "POST /kb/notes/:id", "message": "db is locked for [EMAIL]", "stack": "Error: db is locked\n    at x (~/llm-ide/extension/kb/db.mjs:9:1)", "environmental": null, "firstSeen": 1793750000000, "lastSeen": 1793750100000, "count": 2, "attempts": 0, "status": "new", "note": null, "proposal": null }] } }
// get-kb-self-heal-incidents-403-no-proof.json
{ "endpoint": "GET /kb/self-heal/incidents", "status": 403, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// get-kb-self-heal-incidents-404-disabled.json
{ "endpoint": "GET /kb/self-heal/incidents", "status": 404, "description": "The core runs without LLMIDE_SELF_HEAL=1 (every release build).", "response": { "error": "feature_disabled", "feature": "self_heal" } }
// post-kb-self-heal-incidents-200.json
{ "endpoint": "POST /kb/self-heal/incidents", "status": 200, "request": { "body": { "incidents": [{ "source": "server", "category": "POST /kb/notes/:id", "message": "db is locked for me@example.com", "stack": "Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)" }, { "source": "evil", "category": "c", "message": "m", "stack": null }] } }, "response": { "recorded": 1, "skipped": 1 } }
// post-kb-self-heal-incidents-400-empty.json
{ "endpoint": "POST /kb/self-heal/incidents", "status": 400, "request": { "body": { "incidents": [] } }, "response": { "error": { "code": "VALIDATION_FAILED", "message": "incidents must be an array of 1 to 50 reports" } } }
// post-kb-self-heal-incidents-403-no-proof.json
{ "endpoint": "POST /kb/self-heal/incidents", "status": 403, "request": { "body": { "incidents": [{ "source": "ui", "category": "chat", "message": "x" }] } }, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// post-kb-self-heal-incidents-404-disabled.json
{ "endpoint": "POST /kb/self-heal/incidents", "status": 404, "request": { "body": { "incidents": [{ "source": "ui", "category": "chat", "message": "x" }] } }, "response": { "error": "feature_disabled", "feature": "self_heal" } }
// post-kb-self-heal-incidents--id-ignore-200.json
{ "endpoint": "POST /kb/self-heal/incidents/:id/ignore", "status": 200, "request": { "params": { "id": "3f9a1c0b7d2e4a65" } }, "response": { "ignored": true } }
// post-kb-self-heal-incidents--id-ignore-403-no-proof.json
{ "endpoint": "POST /kb/self-heal/incidents/:id/ignore", "status": 403, "request": { "params": { "id": "3f9a1c0b7d2e4a65" } }, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// post-kb-self-heal-incidents--id-ignore-404-disabled.json
{ "endpoint": "POST /kb/self-heal/incidents/:id/ignore", "status": 404, "request": { "params": { "id": "3f9a1c0b7d2e4a65" } }, "response": { "error": "feature_disabled", "feature": "self_heal" } }
// delete-kb-self-heal-incidents-200.json
{ "endpoint": "DELETE /kb/self-heal/incidents", "status": 200, "response": { "deleted": 1 } }
// delete-kb-self-heal-incidents-403-no-proof.json
{ "endpoint": "DELETE /kb/self-heal/incidents", "status": 403, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// delete-kb-self-heal-incidents-404-disabled.json
{ "endpoint": "DELETE /kb/self-heal/incidents", "status": 404, "response": { "error": "feature_disabled", "feature": "self_heal" } }
```

- [ ] **Step 4: The live replay and the inventory**

`extension/tests/http-contract-live.test.mjs`: after the sync row (the entry ending `when: (fx) => /^(GET|POST) \/kb\/sync\//.test(fx.endpoint) && fx.status !== 403,` followed by `  },`), add:

```js
  {
    // Self-Heal routes exist only with LLMIDE_SELF_HEAL=1 (debug desktop builds) and then need the bus host proof; the
    // replay server has neither and answers 404 feature_disabled. The rows were recorded from the handler
    // (tests/self-heal-routes.test.mjs) and the real server (tests/self-heal-server.test.mjs).
    why: 'Self-Heal: needs LLMIDE_SELF_HEAL=1 and the bus host proof; covered by tests/self-heal-routes.test.mjs and tests/self-heal-server.test.mjs',
    when: (fx) => /\/kb\/self-heal\//.test(fx.endpoint),
  },
```

`scripts/http-inventory.mjs`, in `ALLOWLIST.noHandler`, after the `'/kb/sync/devices/:id': …` line add:

```js
    '/kb/self-heal/incidents/:id/ignore': 'dispatched by IGNORE_RE in extension/routes/self-heal.mjs (/^\\/kb\\/self-heal\\/incidents\\/([0-9a-f]{16})\\/ignore$/)',
```

- [ ] **Step 5: Regenerate and run the gates**

Run:

```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs
make contract-gates
make docs-check
cd extension && node --test tests/http-contract-live.test.mjs tests/self-heal-routes.test.mjs && cd ..
cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/core-api-floor.test.mjs && cd ..
```

Expected:
- The generators rewrite `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml` (with `x-api-version: 121`) and `schema/http/INVENTORY.md` (ALL_ENDPOINTS + 2).
- `make contract-gates` PASSES: every declared status of the four endpoints has a fixture, and the roster has both paths.
- `make docs-check` PASSES: the spec values (API 121, migration head 0067), the rate-limit mapping and the API coverage all match.
- The live replay skips the `self-heal` rows and PASSES.
- If `http-inventory.mjs` reports `/kb/self-heal/incidents` under `noHandler` as well, add the same kind of allowlist line for it, naming `handleSelfHealRoute` in `extension/routes/self-heal.mjs` (dispatched from `server.mjs` by `isSelfHealRoute`), then run it again.

- [ ] **Step 6: Commit**

```bash
git add extension/server.mjs ui/screens/shell/core-api-floor.ts docs/spec/api-server.md docs/spec/cross-cutting.md docs/spec/knowledge-base.md docs/explanation/architecture.md schema/http extension/tests/http-contract-live.test.mjs scripts/http-inventory.mjs extension/src/lib/api-types.ts docs/reference/api/openapi.yaml
git commit -m "feat(server): Self-Heal incident contract (API v121)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Host capture: gate, stderr parser, crash import, the take command (30 min)

**Files:**
- Create: `desktop/src-tauri/src/self_heal.rs`
- Modify: `desktop/src-tauri/src/crash_report.rs` (`records_dir` → `pub(crate)`; new `pending_records_in` after `latest_in`)
- Modify: `desktop/src-tauri/src/lib.rs` (`mod self_heal;` after `mod secrets;`), so the module compiles and its tests run. The command is registered in Task 7.
- Test: the `#[cfg(test)]` module in `self_heal.rs`

**Interfaces:**
- Consumes: `crash_report::{redact, build_record, write_record_at, PanicFacts, CrashRecord}` (all `pub`), `fsutil::{desktop_data_dir, write_private_atomic}`.
- Produces:
  - `gate(debug, value) → bool`, `enabled() → bool`
  - `normalize_endpoint(&str) → String`
  - `HostIncident { source: &'static str, category, message, stack: Option<String> }` (serialized `{ source, category, message, stack }`)
  - `StderrParser { feed(line, now), flush_if_quiet(now), flush() }`
  - `redact_incident(i, home) → HostIncident`
  - `crash_incidents(dir, seen_path) → Vec<HostIncident>`
  - `on_core_stderr_line(&str)`, `on_core_stderr_end()`
  - `#[tauri::command] self_heal_take() → Take { enabled, incidents }`
  - `crash_report::pending_records_in(dir) → Vec<(String, CrashRecord)>`, `crash_report::records_dir()`

- [ ] **Step 1: The crash-record helper** — `desktop/src-tauri/src/crash_report.rs`: change `fn records_dir() -> Result<PathBuf, String> {` to `pub(crate) fn records_dir() -> Result<PathBuf, String> {`. Then, right after the closing `}` of `pub fn latest_in`, add:

```rust
/// Every readable pending record with its file name (the crash id Self-Heal imports once), re-redacted on read like
/// `latest_in`.
pub fn pending_records_in(dir: &Path) -> Vec<(String, CrashRecord)> {
    let home = home_dir();
    pending_files(dir)
        .into_iter()
        .filter_map(|(_, p)| {
            let id = p.file_name()?.to_str()?.to_string();
            let mut rec = read_record(&p)?;
            rec.message = redact(&rec.message, home.as_deref(), MESSAGE_CAP);
            rec.location = redact(&rec.location, home.as_deref(), LOCATION_CAP);
            Some((id, rec))
        })
        .collect()
}
```

- [ ] **Step 2: Write the module with its failing tests first.** Create `desktop/src-tauri/src/self_heal.rs` with only the `#[cfg(test)] mod tests { … }` block from Step 4 below. Add `mod self_heal;` after `mod secrets;` in `src/lib.rs`.

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" cargo test --lib self_heal`
Expected: FAIL to compile (`cannot find function gate`, `StderrParser`, …).

- [ ] **Step 3: Write the module** — `desktop/src-tauri/src/self_heal.rs` (above the tests):

```rust
//! Self-Heal capture, host side (plan A of docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md).
//!
//! Debug builds only:
//! - `enabled()` is false in a release build whatever the environment. A release build therefore records nothing,
//!   passes no `LLMIDE_SELF_HEAL` to the core and answers `self_heal_take` with `enabled: false`.
//! - A debug build records unless `LLMIDE_SELF_HEAL=0`.
//!
//! Two host sources:
//! - the spawned core's stderr: one report per error line plus its `at …` frames, or per JSON logger `error` line;
//! - `crash_report`'s panic records: once per record file, the last 50 ids remembered.
//!
//! Every report is redacted line by line here (`crash_report::redact`) and again by the core before it is stored.
//! The webview drains the queue (`self_heal_take`) and posts it to `POST /kb/self-heal/incidents`; the host never
//! calls the core for this. Incident text is never logged.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Reports held for the webview; past this the oldest go first.
pub const QUEUE_MAX: usize = 100;
const MAX_FRAMES: usize = 30;
const QUIET: Duration = Duration::from_secs(2);
const CATEGORY_CAP: usize = 200;
const MESSAGE_CAP: usize = 2_000;
const STACK_LINE_CAP: usize = 500;
const SEEN_CRASHES_MAX: usize = 50;
const SEEN_FILE: &str = "self-heal-crashes.json";
/// Request ids of recent `request_failed` lines: their `http_request` 5xx summary is the same failure.
const RECENT_FAILED_MAX: usize = 64;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HostIncident {
    pub source: &'static str,
    pub category: String,
    pub message: String,
    pub stack: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Take {
    pub enabled: bool,
    pub incidents: Vec<HostIncident>,
}

/// The switch: a debug build, unless the developer set `LLMIDE_SELF_HEAL=0`.
pub fn gate(debug: bool, value: Option<&str>) -> bool {
    debug && value != Some("0")
}

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| gate(cfg!(debug_assertions), std::env::var("LLMIDE_SELF_HEAL").ok().as_deref()))
}

/// The Mac's `normalizeEndpoint`: no query, and a segment with a digit or of 20+ characters becomes `:id`.
pub fn normalize_endpoint(path: &str) -> String {
    let bare = path.split('?').next().unwrap_or(path);
    bare.split('/')
        .map(|s| if s.chars().any(|c| c.is_ascii_digit()) || s.chars().count() >= 20 { ":id" } else { s })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_error_start(line: &str) -> bool {
    let word: String = line.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    line.starts_with("ERROR:") || line.starts_with("Uncaught") || line.contains("Error:") || word.ends_with("Error")
}

/// Groups the core's stderr into reports (the Mac's `ServerStderrIncidentParser`, plus the core logger's JSON lines).
#[derive(Default)]
pub struct StderrParser {
    pending: Option<HostIncident>,
    frames: usize,
    last_line: Option<Instant>,
    failed_requests: VecDeque<String>,
}

impl StderrParser {
    pub fn feed(&mut self, line: &str, now: Instant) -> Vec<HostIncident> {
        self.last_line = Some(now);
        let trimmed = line.trim();
        if trimmed.starts_with("at ") {
            if let Some(p) = self.pending.as_mut() {
                let stack = p.stack.get_or_insert_with(String::new);
                if !stack.is_empty() {
                    stack.push('\n');
                }
                stack.push_str(line);
                self.frames += 1;
                return if self.frames >= MAX_FRAMES { self.flush() } else { Vec::new() };
            }
        }
        let mut done = self.flush();
        if trimmed.starts_with('{') {
            done.extend(self.json_line(trimmed));
        } else if is_error_start(trimmed) {
            self.pending = Some(HostIncident { source: "server", category: "server".into(), message: trimmed.into(), stack: None });
        }
        done
    }

    /// A trace's last frame has no following line to close it: it settles after 2 s of quiet.
    pub fn flush_if_quiet(&mut self, now: Instant) -> Vec<HostIncident> {
        match self.last_line {
            Some(t) if now.duration_since(t) >= QUIET => self.flush(),
            _ => Vec::new(),
        }
    }

    pub fn flush(&mut self) -> Vec<HostIncident> {
        self.frames = 0;
        self.pending.take().into_iter().collect()
    }

    fn json_line(&mut self, line: &str) -> Option<HostIncident> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v.get("level")?.as_str()? != "error" {
            return None;
        }
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let msg = s("msg").unwrap_or_else(|| "error".into());
        let url = s("url").unwrap_or_default();
        // The Self-Heal routes' own failures would feed back into the store.
        if url.starts_with("/kb/self-heal") {
            return None;
        }
        let endpoint = || format!("{} {}", s("method").unwrap_or_else(|| "?".into()), normalize_endpoint(&url));
        let rid = s("requestId");
        match msg.clone().as_str() {
            "http_request" => {
                let status = v.get("status").and_then(|x| x.as_u64()).unwrap_or(0);
                if status < 500 || rid.as_ref().is_some_and(|r| self.failed_requests.contains(r)) {
                    return None;
                }
                Some(HostIncident { source: "server", category: endpoint(), message: format!("HTTP {status}"), stack: None })
            }
            "request_failed" => {
                if let Some(r) = rid {
                    self.failed_requests.push_back(r);
                    if self.failed_requests.len() > RECENT_FAILED_MAX {
                        self.failed_requests.pop_front();
                    }
                }
                let message = s("message").or_else(|| s("code")).unwrap_or_else(|| msg.clone());
                Some(HostIncident { source: "server", category: endpoint(), message, stack: s("stack") })
            }
            _ => {
                let message = ["error", "message", "reason"]
                    .into_iter()
                    .find_map(&s)
                    .map(|m| format!("{msg}: {m}"))
                    .unwrap_or_else(|| msg.clone());
                Some(HostIncident { source: "log", category: msg, message, stack: s("stack") })
            }
        }
    }
}

/// Line-by-line redaction with the crash notice's redactor (home folder, user names, secret pairs, opaque tokens).
pub fn redact_incident(i: HostIncident, home: Option<&str>) -> HostIncident {
    use crate::crash_report::redact;
    HostIncident {
        source: i.source,
        category: redact(&i.category, home, CATEGORY_CAP),
        message: redact(&i.message, home, MESSAGE_CAP),
        stack: i.stack.map(|s| {
            s.lines().take(MAX_FRAMES + 1).map(|l| redact(l, home, STACK_LINE_CAP)).collect::<Vec<_>>().join("\n")
        }),
    }
}

/// Each pending panic record becomes one report, once: the ids already reported live in `seen_path` (the last 50,
/// in order; the Mac's `CrashIncidentImporter`). The banner's Dismiss still deletes the records themselves.
pub fn crash_incidents(dir: &Path, seen_path: &Path) -> Vec<HostIncident> {
    let mut seen: Vec<String> = std::fs::read(seen_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut out = Vec::new();
    for (id, rec) in crate::crash_report::pending_records_in(dir) {
        if seen.contains(&id) {
            continue;
        }
        out.push(HostIncident { source: "crash", category: "crash".into(), message: rec.message, stack: Some(format!("at {}", rec.location)) });
        seen.push(id);
    }
    if !out.is_empty() {
        let keep = seen.len().saturating_sub(SEEN_CRASHES_MAX);
        let body = serde_json::to_vec(&seen[keep..]).unwrap_or_default();
        let _ = crate::fsutil::write_private_atomic(seen_path, &body, 16 * 1024);
    }
    out
}

static QUEUE: Mutex<VecDeque<HostIncident>> = Mutex::new(VecDeque::new());
static PARSER: Mutex<Option<StderrParser>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_parser<R>(f: impl FnOnce(&mut StderrParser) -> R) -> R {
    f(lock(&PARSER).get_or_insert_with(StderrParser::default))
}

fn home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).filter(|h| !h.trim().is_empty())
}

fn enqueue(items: Vec<HostIncident>) {
    if items.is_empty() {
        return;
    }
    let home = home();
    let mut q = lock(&QUEUE);
    for i in items {
        q.push_back(redact_incident(i, home.as_deref()));
        if q.len() > QUEUE_MAX {
            q.pop_front();
        }
    }
}

/// One line of the spawned core's stderr (`core_host::drain`). A no-op in a release build.
pub fn on_core_stderr_line(line: &str) {
    if enabled() {
        enqueue(with_parser(|p| p.feed(line, Instant::now())));
    }
}

/// The core's stderr closed (it exited): the open trace is complete.
pub fn on_core_stderr_end() {
    if enabled() {
        enqueue(with_parser(StderrParser::flush));
    }
}

/// The webview's pump: everything queued since the last call, or `enabled: false` in a release build.
#[tauri::command]
pub fn self_heal_take() -> Take {
    if !enabled() {
        return Take { enabled: false, incidents: Vec::new() };
    }
    enqueue(with_parser(|p| p.flush_if_quiet(Instant::now())));
    if let (Ok(dir), Ok(data)) = (crate::crash_report::records_dir(), crate::fsutil::desktop_data_dir()) {
        enqueue(crash_incidents(&dir, &data.join(SEEN_FILE)));
    }
    Take { enabled: true, incidents: lock(&QUEUE).drain(..).collect() }
}
```

- [ ] **Step 4: The tests** (the `#[cfg(test)]` block at the end of `self_heal.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(p: &mut StderrParser, lines: &[&str], t: Instant) -> Vec<HostIncident> {
        lines.iter().flat_map(|l| p.feed(l, t)).collect()
    }

    #[test]
    fn the_gate_is_debug_only_and_honours_an_explicit_off() {
        assert!(gate(true, None));
        assert!(gate(true, Some("1")));
        assert!(!gate(true, Some("0")), "LLMIDE_SELF_HEAL=0 opts a debug build out");
        assert!(!gate(false, None), "a release build never records");
        assert!(!gate(false, Some("1")), "not even when asked");
    }

    #[test]
    fn endpoints_lose_their_ids_and_query() {
        assert_eq!(normalize_endpoint("/kb/notes/42/edit?x=1"), "/kb/notes/:id/edit");
        assert_eq!(normalize_endpoint("/kb/sync/devices/AAAAAAAAAAAAAAAAAAAAAA"), "/kb/sync/devices/:id");
        assert_eq!(normalize_endpoint("/health"), "/health");
    }

    #[test]
    fn a_plain_error_line_takes_its_frames_and_closes_on_the_next_line() {
        let t = Instant::now();
        let mut p = StderrParser::default();
        let out = feed_all(&mut p, &["TypeError: x is not a function", "    at a (/r/extension/server.mjs:1:2)", "    at b (node:internal/x:3:4)", "plain line"], t);
        assert_eq!(out, vec![HostIncident {
            source: "server",
            category: "server".into(),
            message: "TypeError: x is not a function".into(),
            stack: Some("    at a (/r/extension/server.mjs:1:2)\n    at b (node:internal/x:3:4)".into()),
        }]);
        assert!(p.flush().is_empty());
        assert!(feed_all(&mut p, &["all good", "    at nothing"], t).is_empty(), "a frame without an error is noise");
    }

    #[test]
    fn a_trace_settles_after_two_quiet_seconds_and_caps_at_thirty_frames() {
        let t = Instant::now();
        let mut p = StderrParser::default();
        p.feed("Error: boom", t);
        assert!(p.flush_if_quiet(t + Duration::from_millis(1_999)).is_empty());
        assert_eq!(p.flush_if_quiet(t + Duration::from_secs(2)).len(), 1);
        p.feed("Error: deep", t);
        let mut out = Vec::new();
        for i in 0..30 {
            out.extend(p.feed(&format!("    at f{i} (x.js:1:1)"), t));
        }
        assert_eq!(out.len(), 1, "the 30th frame closes the trace");
        assert_eq!(out[0].stack.as_ref().unwrap().lines().count(), 30);
    }

    #[test]
    fn json_logger_lines_become_reports_and_a_failed_request_is_reported_once() {
        let t = Instant::now();
        let mut p = StderrParser::default();
        let failed = r#"{"ts":"x","level":"error","msg":"request_failed","requestId":"ab12","method":"POST","url":"/kb/notes/42","code":"INTERNAL_ERROR","message":"db is locked","stack":"Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)"}"#;
        let summary = r#"{"ts":"x","level":"error","msg":"http_request","requestId":"ab12","method":"POST","url":"/kb/notes/42","status":500}"#;
        let bare = r#"{"ts":"x","level":"error","msg":"http_request","requestId":"cd34","method":"GET","url":"/kb/sync/status","status":503}"#;
        let uncaught = r#"{"ts":"x","level":"error","msg":"uncaught_exception","error":"boom","stack":"Error: boom"}"#;
        let warn = r#"{"ts":"x","level":"warn","msg":"request_rejected","code":"X"}"#;
        let own = r#"{"ts":"x","level":"error","msg":"http_request","requestId":"ef56","method":"POST","url":"/kb/self-heal/incidents","status":500}"#;
        let out = feed_all(&mut p, &[failed, summary, bare, uncaught, warn, own, "{not json"], t);
        assert_eq!(out, vec![
            HostIncident { source: "server", category: "POST /kb/notes/:id".into(), message: "db is locked".into(), stack: Some("Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)".into()) },
            HostIncident { source: "server", category: "GET /kb/sync/status".into(), message: "HTTP 503".into(), stack: None },
            HostIncident { source: "log", category: "uncaught_exception".into(), message: "uncaught_exception: boom".into(), stack: Some("Error: boom".into()) },
        ]);
    }

    #[test]
    fn redaction_masks_the_home_folder_user_names_and_secrets_per_line() {
        let i = HostIncident {
            source: "server",
            category: "server".into(),
            message: "Error: token=abcdef123456 at /Users/alice/x".into(),
            stack: Some("    at a (/Users/alice/llm-ide/extension/server.mjs:1:2)\n    at b (/home/bob/y.js:1:1)".into()),
        };
        let r = redact_incident(i, Some("/Users/alice"));
        assert!(!r.message.contains("abcdef123456") && !r.message.contains("alice"), "{}", r.message);
        let stack = r.stack.unwrap();
        assert_eq!(stack.lines().count(), 2);
        assert!(stack.contains("~/llm-ide/extension/server.mjs:1:2"), "{stack}");
        assert!(!stack.contains("bob"), "{stack}");
    }

    #[test]
    fn each_crash_record_becomes_one_report_once() {
        let root = std::env::temp_dir().join(format!("llmide-selfheal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let crashes = root.join("crashes");
        let seen = root.join(SEEN_FILE);
        let facts = crate::crash_report::PanicFacts {
            message: "index out of bounds".into(),
            location: "/Users/dev/llm-ide/desktop/src-tauri/src/git_scm.rs:123".into(),
        };
        let rec = crate::crash_report::build_record(&facts, "2026-11-07T10:00:00Z", Some("/Users/dev"));
        crate::crash_report::write_record_at(&crashes, &rec, 100, 7).unwrap();
        let first = crash_incidents(&crashes, &seen);
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].source, first[0].category.as_str(), first[0].message.as_str()), ("crash", "crash", "index out of bounds"));
        assert!(first[0].stack.as_deref().unwrap().contains("desktop/src-tauri/src/git_scm.rs:123"));
        assert!(crash_incidents(&crashes, &seen).is_empty(), "the same record is never reported twice");
        crate::crash_report::write_record_at(&crashes, &rec, 200, 7).unwrap();
        assert_eq!(crash_incidents(&crashes, &seen).len(), 1, "a new record is");
        let _ = std::fs::remove_dir_all(&root);
    }
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" cargo test --lib self_heal crash_report`
Expected: PASS (7 `self_heal` tests and the existing `crash_report` tests). A `dead_code` warning for `self_heal_take`, `on_core_stderr_line` or `on_core_stderr_end` is expected until Task 7 wires them. No error.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/self_heal.rs desktop/src-tauri/src/crash_report.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Self-Heal host capture of core stderr and panic records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Host wiring: the core env, the stderr drain, the command grant (15 min)

**Files:**
- Modify: `desktop/src-tauri/src/core_host.rs`:
  - `real_launch`, after the `LLMIDE_HOST_API_DEV` block (~line 1229)
  - `drain` (~line 1011) and its three callers (~lines 849, 852, 1553)
- Modify: `desktop/src-tauri/src/lib.rs` (handler list), `desktop/src-tauri/build.rs` (`COMMANDS`), `desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `self_heal::{enabled, on_core_stderr_line, on_core_stderr_end, self_heal_take}` (Task 6).
- Produces: the spawned core gets `LLMIDE_SELF_HEAL=1` exactly when `self_heal::enabled()`. The webview can `invoke("self_heal_take")` → `{ enabled: boolean, incidents: { source, category, message, stack }[] }`.

- [ ] **Step 1: Pass the switch** — `core_host.rs` `real_launch`, replace:

```rust
    if host_api_dev_env(cfg!(debug_assertions), std::env::var("LLMIDE_HOST_API_DEV").ok().as_deref()) {
        cmd.env("LLMIDE_HOST_API_DEV", "1");
    }
```

with:

```rust
    if host_api_dev_env(cfg!(debug_assertions), std::env::var("LLMIDE_HOST_API_DEV").ok().as_deref()) {
        cmd.env("LLMIDE_HOST_API_DEV", "1");
    }
    // Self-Heal incident capture: debug builds only (self_heal::enabled), an explicit `.env` like the dev flag, never
    // a widened core_env ALLOWED.
    if crate::self_heal::enabled() {
        cmd.env("LLMIDE_SELF_HEAL", "1");
    }
```

- [ ] **Step 2: Feed stderr to the parser** — replace the whole `drain` function:

```rust
/// Keep the pipe drained so the child never blocks on a full buffer.
/// Only the last `LOG_TAIL_LINES` lines are retained. Stderr lines also feed Self-Heal (a no-op in release builds).
fn drain<R: Read + Send + 'static>(pipe: R, log: Arc<Mutex<VecDeque<String>>>, stderr: bool) {
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        loop {
            let line = match read_log_line(&mut reader) {
                Ok(Some(line)) => line,
                Ok(None) => break,
                // Only a transient error keeps the pipe; anything else (EBADF, EIO) ends it.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            if stderr {
                crate::self_heal::on_core_stderr_line(&line);
            }
            let mut buf = lock(&log);
            if buf.len() == LOG_TAIL_LINES {
                buf.pop_front();
            }
            buf.push_back(line);
        }
        if stderr {
            crate::self_heal::on_core_stderr_end();
        }
    });
}
```

Callers:
- `drain(out, Arc::clone(&self.inner.log));` → `drain(out, Arc::clone(&self.inner.log), false);`
- `drain(err, Arc::clone(&self.inner.log));` → `drain(err, Arc::clone(&self.inner.log), true);`
- In the test `drain_keeps_reading_past_bad_utf8_and_an_overlong_line`: `drain(std::io::Cursor::new(bytes), log.clone());` → `drain(std::io::Cursor::new(bytes), log.clone(), false);`

- [ ] **Step 3: Register and grant the command**

  - `src/lib.rs`: after `                crash_report::crash_report_dismiss,` add `                self_heal::self_heal_take,`.
  - `build.rs`: after `    "crash_report_dismiss",` add `    "self_heal_take",`.
  - `capabilities/default.json`: after `    "allow-crash-report-dismiss",` add `    "allow-self-heal-take",`.

- [ ] **Step 4: Run the host gates**

Run:

```bash
cd desktop && node scripts/check-capabilities.mjs --product && cd ..
cd desktop/src-tauri && CARGO_INCREMENTAL=0 PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" cargo test --lib && cd ../..
```

Expected: `check-capabilities` reports no problem, and every Rust test PASSES with no `dead_code` warning left from Task 6.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/core_host.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/build.rs desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): pass the Self-Heal switch in debug builds and grant self_heal_take

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Webview pump, Chat and Loop reports (20 min)

**Files:**
- Create: `ui/screens/shell/self-heal.ts`
- Modify: `ui/screens/shell/Shell.tsx` (an import, and one effect after the notify-bridge effect that ends `return () => { setPushSender(null); off(); };` / `}, []);`)
- Modify: `ui/screens/chat/controller.ts` (`dispatch`, one import)
- Modify: `ui/screens/loop/native/NativeLoopScreen.tsx` (the run's `catch (e)`, one import)
- Test: `ui/screens/shell/tests/self-heal.test.mjs`

**Interfaces:**
- Consumes: the `self_heal_take` host command (Task 7); `POST /kb/self-heal/incidents` (Task 3).
- Produces:
  - `IncidentReport = { source: "ui"|"log"|"crash"|"server"; category: string; message: string; stack: string | null }`
  - `PENDING_MAX = 100`, `BATCH_MAX = 50`, `PUMP_MS = 15000`
  - `decodeTake(raw) → { enabled, incidents }`
  - `reportUiIncident(category: "chat" | "loop", message: unknown): void`
  - `pumpOnce(deps)`, `startSelfHealPump(deps, intervalMs?) → () => void`
  - `selfHealEnabled() → boolean`, `subscribeSelfHeal(l) → () => void`
  - `pendingCount()`, `resetSelfHealForTests()`

- [ ] **Step 1: Write the failing test** — `ui/screens/shell/tests/self-heal.test.mjs`:

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const sh = await load("self-heal.ts");
beforeEach(() => sh.resetSelfHealForTests());
const take = (enabled, incidents = []) => async () => ({ enabled, incidents });
const ok = { source: "server", category: "server", message: "Error: x", stack: null };

test("decodeTake keeps only well-formed host reports and reads anything else as off", () => {
  assert.deepEqual(sh.decodeTake(null), { enabled: false, incidents: [] });
  assert.deepEqual(sh.decodeTake({ enabled: "yes", incidents: [ok] }), { enabled: false, incidents: [] });
  assert.deepEqual(sh.decodeTake({ enabled: true, incidents: [ok, { source: "ui", category: "chat", message: 3 }, { source: "evil", category: "c", message: "m" }, { source: "log", category: " ", message: "m" }, null] }), { enabled: true, incidents: [ok] });
});

test("a release build (enabled false) posts nothing, keeps no UI error and is not shown", async () => {
  const posted = [];
  await sh.pumpOnce({ take: take(false), post: async (b) => { posted.push(b); } });
  sh.reportUiIncident("chat", "boom");
  assert.equal(sh.selfHealEnabled(), false);
  assert.equal(sh.pendingCount(), 0);
  assert.deepEqual(posted, []);
});

test("a debug build posts host and UI reports in batches of 50 and keeps them while the post fails", async () => {
  const posted = [];
  const host = Array.from({ length: 60 }, (_, i) => ({ ...ok, message: `Error: ${i}` }));
  let fail = true;
  const post = async (b) => { if (fail) throw new Error("core restarting"); posted.push(b); };
  await sh.pumpOnce({ take: take(true, host), post });
  assert.equal(sh.selfHealEnabled(), true);
  sh.reportUiIncident("chat", "The stream ended before the turn finished.");
  assert.equal(sh.pendingCount(), 61, "kept for the next tick");
  fail = false;
  await sh.pumpOnce({ take: take(true), post });
  assert.deepEqual(posted.map((b) => b.length), [50, 11]);
  assert.equal(posted[0][0].message, "Error: 0", "order is kept across a failed post");
  assert.deepEqual(posted[1].at(-1), { source: "ui", category: "chat", message: "The stream ended before the turn finished.", stack: null });
  assert.equal(sh.pendingCount(), 0);
});

test("the buffer keeps the newest 100; an empty or non-text UI error is dropped; a failing take changes nothing", async () => {
  await sh.pumpOnce({ take: take(true), post: async () => {} });
  for (let i = 0; i < 120; i++) sh.reportUiIncident("loop", `fail ${i}`);
  sh.reportUiIncident("chat", "   ");
  sh.reportUiIncident("chat", null);
  assert.equal(sh.pendingCount(), 100);
  await sh.pumpOnce({ take: async () => { throw new Error("no host"); }, post: async () => {} });
  assert.equal(sh.pendingCount(), 100);
  const posted = [];
  await sh.pumpOnce({ take: take(true), post: async (b) => { posted.push(...b); } });
  assert.equal(posted[0].message, "fail 20");
});

test("subscribers hear the switch once", async () => {
  let n = 0;
  const off = sh.subscribeSelfHeal(() => { n += 1; });
  await sh.pumpOnce({ take: take(true), post: async () => {} });
  await sh.pumpOnce({ take: take(true), post: async () => {} });
  off();
  assert.equal(n, 1);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/self-heal.test.mjs`
Expected: FAIL (esbuild cannot resolve `self-heal.ts`).

- [ ] **Step 3: Write the pump** — `ui/screens/shell/self-heal.ts`:

```ts
// Self-Heal capture, webview side (plan A of docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md).
// Debug desktop builds only: the host's `self_heal_take` answers `enabled: false` in a release build, and then
// nothing is kept, posted or shown. In a debug build, every 15 s the pump:
//   1. drains the host's reports (core stderr, panic records);
//   2. adds the Chat and Loop errors this webview reported;
//   3. posts them to the core, which redacts and stores them.
// Incident text is data: it goes only to the core this app trusts and is never handed to a model. Pure apart from the
// injected `take` and `post`, so it is tested with node.

export type IncidentSource = "ui" | "log" | "crash" | "server";
export interface IncidentReport {
  source: IncidentSource;
  category: string;
  message: string;
  stack: string | null;
}
export interface PumpDeps {
  take: () => Promise<unknown>;
  post: (incidents: IncidentReport[]) => Promise<unknown>;
}

export const PENDING_MAX = 100;
export const BATCH_MAX = 50;
export const PUMP_MS = 15_000;
const TEXT_MAX = 20_000;
const SOURCES: ReadonlySet<string> = new Set(["ui", "log", "crash", "server"]);

let enabled = false;
let pending: IncidentReport[] = [];
const listeners = new Set<() => void>();

/** True once the host said this is a debug build that records (Settings shows the Self-Heal group then). */
export const selfHealEnabled = (): boolean => enabled;
export const pendingCount = (): number => pending.length;

export function subscribeSelfHeal(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (!on) pending = [];
  for (const l of [...listeners]) l();
}

/** Adds reports (at the front for a batch whose post failed); the newest PENDING_MAX survive. */
function keep(items: readonly IncidentReport[], atFront = false): void {
  pending = atFront ? [...items, ...pending] : [...pending, ...items];
  if (pending.length > PENDING_MAX) pending = pending.slice(pending.length - PENDING_MAX);
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.slice(0, TEXT_MAX) : null);

/** Defensive decode of the host's answer: anything malformed reads as off, a malformed report is dropped. */
export function decodeTake(raw: unknown): { enabled: boolean; incidents: IncidentReport[] } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || o.enabled !== true) return { enabled: false, incidents: [] };
  const incidents: IncidentReport[] = [];
  for (const it of Array.isArray(o.incidents) ? o.incidents : []) {
    const r = it && typeof it === "object" ? (it as Record<string, unknown>) : null;
    const category = text(r?.category);
    const message = text(r?.message);
    if (!r || typeof r.source !== "string" || !SOURCES.has(r.source) || category === null || message === null) continue;
    incidents.push({ source: r.source as IncidentSource, category, message, stack: typeof r.stack === "string" ? r.stack.slice(0, TEXT_MAX) : null });
  }
  return { enabled: true, incidents };
}

/** A Chat turn failed or a Loop run threw (the Mac's `.ui` "chat" / "loop" incidents). A no-op unless enabled. */
export function reportUiIncident(category: "chat" | "loop", message: unknown): void {
  const m = text(message);
  if (!enabled || m === null) return;
  keep([{ source: "ui", category, message: m, stack: null }]);
}

/** One tick: take from the host, then post everything pending in batches; a failed post keeps the rest for later. */
export async function pumpOnce(deps: PumpDeps): Promise<void> {
  let take: ReturnType<typeof decodeTake>;
  try {
    take = decodeTake(await deps.take());
  } catch {
    return;
  }
  setEnabled(take.enabled);
  if (!take.enabled) return;
  keep(take.incidents);
  while (pending.length > 0) {
    const batch = pending.slice(0, BATCH_MAX);
    pending = pending.slice(batch.length);
    try {
      await deps.post(batch);
    } catch {
      keep(batch, true); // signed out, core restarting or an adopted core without the switch: try again next tick
      return;
    }
  }
}

/** Starts the pump; it stops by itself after a release build's first answer. Returns the stop function. */
export function startSelfHealPump(deps: PumpDeps, intervalMs = PUMP_MS): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    await pumpOnce(deps);
    if (!stopped && enabled) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

export function resetSelfHealForTests(): void {
  enabled = false;
  pending = [];
  listeners.clear();
}
```

- [ ] **Step 4: Start it in the shell** — `ui/screens/shell/Shell.tsx`: after `import { coreApiWarning } from "./core-api-floor";` add `import { startSelfHealPump } from "./self-heal";`. Directly after the notify-bridge effect (the one that ends with `    return () => { setPushSender(null); off(); };` and `  }, []);`), add:

```tsx
  useEffect(() => {
    if (!shellHost.isAvailable()) return undefined;
    // Self-Heal (debug builds only): the host answers enabled: false in a release build and the pump stops.
    return startSelfHealPump({
      take: () => invokeHost<unknown>("self_heal_take"),
      post: (incidents) => core.request("/kb/self-heal/incidents", { method: "POST", body: { incidents } }),
    });
  }, []);
```

- [ ] **Step 5: Report Chat and Loop failures**

`ui/screens/chat/controller.ts`: after `import { HISTORY_PAGE } from "./virtual";` add `import { reportUiIncident } from "../shell/self-heal";`. In `dispatch`, replace:

```ts
    const next = reduce(r.state, action);
    if (next !== r.state) {
      r.state = next;
```

with:

```ts
    const next = reduce(r.state, action);
    if (next !== r.state) {
      // Self-Heal (debug builds): a turn that just failed is one incident (the Mac's ChatEngine.error didSet).
      if (next.phase === "error" && r.state.phase !== "error" && next.error) reportUiIncident("chat", next.error.message);
      r.state = next;
```

`ui/screens/loop/native/NativeLoopScreen.tsx`: after `import { notifyTask } from "../../shell/notify/notify";` add `import { reportUiIncident } from "../../shell/self-heal";`. In the run's catch, replace:

```tsx
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The loop could not run.");
      void notifyTask("loop", false);
```

with:

```tsx
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The loop could not run.");
      // The runner itself failed (not a stage verdict): a Self-Heal incident in debug builds.
      reportUiIncident("loop", e instanceof Error ? e.message : String(e));
      void notifyTask("loop", false);
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/self-heal.test.mjs ../ui/screens/chat/tests/controller.test.mjs ../ui/screens/loop/tests/*.test.* && npx tsc --noEmit`
Expected: PASS (5 new tests; the chat and loop suites unchanged), and `tsc` reports no error.

- [ ] **Step 7: Commit**

```bash
git add ui/screens/shell/self-heal.ts ui/screens/shell/Shell.tsx ui/screens/chat/controller.ts ui/screens/loop/native/NativeLoopScreen.tsx ui/screens/shell/tests/self-heal.test.mjs
git commit -m "feat(ui): pump Self-Heal reports from the host, Chat and Loop to the core

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings → Self-Heal: the incident list (25 min)

**Files:**
- Create: `ui/screens/settings/self-heal-model.ts`, `ui/screens/settings/sections/SelfHealSection.tsx`
- Modify: `ui/screens/settings/groups.ts` (`GroupStatus`, the `self-heal` row), `ui/screens/settings/notices.ts` (`self-heal` notice), `ui/screens/settings/registry-default.ts` (`self-heal` body), `ui/screens/settings/SettingsScreen.tsx` (`dead` set)
- Modify: `ui/screens/settings/tests/groups.test.ts:10`, `ui/screens/settings/tests/components.test.mjs:137,144`
- Modify: `docs/superpowers/plans/2026-10-31-settings-mirror-map.md` (Self-Heal row, line 78)
- Test: `ui/screens/settings/tests/self-heal.test.ts`

**Interfaces:**
- Consumes: `selfHealEnabled`, `subscribeSelfHeal` (Task 8); `call(client, method, path)` from `settings/core-api.ts`; `safeText` from `shell/safe-text.ts`; `ManagedNotice` via `SelfHealGroup` in `sections/NoticeSections.tsx`.
- Produces:
  - `GroupStatus` gains `"dev-only"`
  - `decodeIncidents(raw) → IncidentView[]`, `incidentSummary(list) → string`, `STATUS_TEXT`, `SOURCE_TEXT`
  - `IncidentView = { id, source, category, message, stack: string[], environmental: string | null, firstSeen, lastSeen, count, attempts, status }`

- [ ] **Step 1: Write the failing test** — `ui/screens/settings/tests/self-heal.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeIncidents, incidentSummary, STATUS_TEXT } from "../self-heal-model.ts";

const row = (o: Record<string, unknown> = {}) => ({
  id: "3f9a1c0b7d2e4a65", source: "server", category: "POST /kb/notes/:id", message: "db is locked",
  stack: "Error: db is locked\n    at x (~/llm-ide/extension/kb/db.mjs:9:1)", environmental: null, firstSeen: 1, lastSeen: 2,
  count: 3, attempts: 0, status: "new", note: null, proposal: null, ...o,
});

test("decodeIncidents keeps well-formed rows, cleans the text and drops the rest", () => {
  const out = decodeIncidents({ incidents: [row(), row({ id: "nothex" }), row({ status: "done" }), row({ source: "x" }), row({ count: -1 }), null,
    row({ id: "0000000000000001", message: "a‮b\nc", stack: null, environmental: "offline" })] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].stack, ["Error: db is locked", "at x (~/llm-ide/extension/kb/db.mjs:9:1)"]);
  assert.equal(out[1].message, "ab c", "bidi controls and newlines cannot disguise the text");
  assert.deepEqual(out[1].stack, []);
  assert.equal(out[1].environmental, "offline");
  assert.deepEqual(decodeIncidents(null), []);
  assert.deepEqual(decodeIncidents({ incidents: "x" }), []);
});

test("the summary counts incidents and the environmental ones; every status has words", () => {
  assert.equal(incidentSummary([]), "No incidents recorded.");
  const list = decodeIncidents({ incidents: [row(), row({ id: "0000000000000001", environmental: "auth" })] });
  assert.equal(incidentSummary(list), "2 incidents, 1 environmental (not app bugs).");
  assert.equal(incidentSummary(list.slice(0, 1)), "1 incident.");
  assert.deepEqual(Object.keys(STATUS_TEXT).sort(), ["fixed", "fixing", "ignored", "needsHuman", "new", "proposed"]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/self-heal.test.ts`
Expected: FAIL with `Cannot find module '…/self-heal-model.ts'`.

- [ ] **Step 3: The model** — `ui/screens/settings/self-heal-model.ts`:

```ts
// The Self-Heal group's data (plan A: list, Ignore, Clear). Pure: decodes GET /kb/self-heal/incidents defensively and
// builds the display text. Incident text is untrusted data: it is cleaned (safeText) and rendered as text only.
import { safeText } from "../shell/safe-text.ts";

export type IncidentStatus = "new" | "fixing" | "proposed" | "ignored" | "needsHuman" | "fixed";
export type IncidentSource = "ui" | "log" | "crash" | "server";

export interface IncidentView {
  id: string;
  source: IncidentSource;
  category: string;
  message: string;
  stack: string[];
  environmental: string | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  attempts: number;
  status: IncidentStatus;
}

export const STATUS_TEXT: Readonly<Record<IncidentStatus, string>> = {
  new: "New",
  fixing: "Fixing",
  proposed: "Fix proposed",
  ignored: "Ignored",
  needsHuman: "Needs you",
  fixed: "Fixed",
};

export const SOURCE_TEXT: Readonly<Record<IncidentSource, string>> = { ui: "App", log: "Core log", crash: "Crash", server: "Core" };

const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_TEXT));
const SOURCES: ReadonlySet<string> = new Set(Object.keys(SOURCE_TEXT));
const ID = /^[0-9a-f]{16}$/;
const nat = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function decodeIncidents(raw: unknown): IncidentView[] {
  const list = raw && typeof raw === "object" ? (raw as { incidents?: unknown }).incidents : undefined;
  if (!Array.isArray(list)) return [];
  const out: IncidentView[] = [];
  for (const it of list.slice(0, 200)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const firstSeen = nat(o.firstSeen);
    const lastSeen = nat(o.lastSeen);
    const count = nat(o.count);
    const attempts = nat(o.attempts);
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.source !== "string" || !SOURCES.has(o.source)) continue;
    if (typeof o.status !== "string" || !STATUSES.has(o.status)) continue;
    if (firstSeen === null || lastSeen === null || count === null || attempts === null) continue;
    out.push({
      id: o.id,
      source: o.source as IncidentSource,
      status: o.status as IncidentStatus,
      category: safeText(o.category, 200),
      message: safeText(o.message, 2100),
      stack: typeof o.stack === "string" ? o.stack.split("\n").slice(0, 40).map((l) => safeText(l, 500)) : [],
      environmental: typeof o.environmental === "string" ? safeText(o.environmental, 40) : null,
      firstSeen,
      lastSeen,
      count,
      attempts,
    });
  }
  return out;
}

export function incidentSummary(list: readonly IncidentView[]): string {
  if (list.length === 0) return "No incidents recorded.";
  const env = list.filter((i) => i.environmental !== null).length;
  const n = `${list.length} incident${list.length === 1 ? "" : "s"}`;
  return env > 0 ? `${n}, ${env} environmental (not app bugs).` : `${n}.`;
}
```

- [ ] **Step 4: The section** — `ui/screens/settings/sections/SelfHealSection.tsx`:

```tsx
// Settings → Self-Heal (debug desktop builds only): the incidents the app recorded, most recent first, with Ignore,
// Refresh and Clear all. Proposing fixes is plan B (the notice says so). Text is shown as text, never run or sent.
import { useCallback, useEffect, useState } from "react";
import { useEnv } from "../context.tsx";
import { call } from "../core-api.ts";
import { Button, ErrorText } from "../ui.tsx";
import { SelfHealGroup } from "./NoticeSections.tsx";
import { SOURCE_TEXT, STATUS_TEXT, decodeIncidents, incidentSummary, type IncidentView } from "../self-heal-model.ts";

const BASE = "/kb/self-heal/incidents";

export default function SelfHealSection() {
  const { client } = useEnv();
  const [items, setItems] = useState<IncidentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems(decodeIncidents(await call(client, "GET", BASE)));
      setError(null);
    } catch {
      setError("Could not read the incidents. Check that the backend is running and you are signed in.");
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (method: "POST" | "DELETE", path: string) => {
    setBusy(true);
    try {
      await call(client, method, path);
      await load();
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  const busyRow = (i: IncidentView) => i.status === "fixing" || i.status === "proposed";

  return (
    <div className="st-stack">
      <SelfHealGroup />
      <div className="st-row">
        <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
        {armed ? (
          <Button tone="danger" disabled={busy} onClick={() => void act("DELETE", BASE)}>Confirm: clear all</Button>
        ) : (
          <Button tone="danger" disabled={busy || !items || items.length === 0} onClick={() => setArmed(true)}>Clear all...</Button>
        )}
      </div>
      <ErrorText text={error} />
      <p className="st-hint" role="status">{items === null ? "Loading incidents..." : incidentSummary(items)}</p>
      {items && items.length > 0 ? (
        <ul className="st-stack" aria-label="Incidents">
          {items.map((i) => (
            <li key={i.id}>
              <p className="st-label">
                {SOURCE_TEXT[i.source]} · {i.category} · {STATUS_TEXT[i.status]}
                {i.environmental ? ` · environmental (${i.environmental})` : ""}
              </p>
              <p>{i.message}</p>
              <p className="st-hint">Seen {i.count} time{i.count === 1 ? "" : "s"}, last {new Date(i.lastSeen).toLocaleString()}</p>
              {i.stack.length > 0 ? (
                <details>
                  <summary>Stack</summary>
                  <pre>{i.stack.join("\n")}</pre>
                </details>
              ) : null}
              {i.status !== "ignored" && !busyRow(i) ? (
                <Button disabled={busy} onClick={() => void act("POST", `${BASE}/${i.id}/ignore`)}>Ignore</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: The group, the notice, the registry, the screen**

`ui/screens/settings/groups.ts`, replace:

```ts
  | "core-route" //     needs a core route that does not exist yet
  | "mac-only"; //      a Swift-app feature with no desktop counterpart
```

with:

```ts
  | "core-route" //     needs a core route that does not exist yet
  | "mac-only" //       a Swift-app feature with no desktop counterpart
  | "dev-only"; //      shown only when the host reports a debug build that records (Self-Heal)
```

and in `APP_GROUPS` change the Self-Heal row's `status: "mac-only"` to `status: "dev-only"`.

`ui/screens/settings/notices.ts`, replace the `"self-heal"` entry with:

```ts
  "self-heal": {
    mac: "Records app errors, proposes fixes in an isolated worktree, and lets you review and apply a proposal. Only appears on a source checkout.",
    status: "Planned",
    meanwhile: "Debug builds record the app's errors and list them below (Ignore and Clear work). Release builds record nothing and hide this group.",
    blockedBy: "Proposing and applying fixes (git worktree, agent, make regression, review) is plan B and not built yet.",
  },
```

`ui/screens/settings/registry-default.ts`: change `  "self-heal": named(notices, "SelfHealGroup"),` to `  "self-heal": dflt(() => import("./sections/SelfHealSection.tsx")),`.

`ui/screens/settings/SettingsScreen.tsx`: after `import { SettingsGroup } from "./SettingsGroup.tsx";` add `import { selfHealEnabled, subscribeSelfHeal } from "../shell/self-heal.ts";`. Replace:

```tsx
  const dead = new Set(APP_GROUPS.filter((g) => g.status === "mac-only").map((g) => g.id));
```

with:

```tsx
  // Self-Heal shows only after the host said this debug build records (shell/self-heal.ts); never in a release build.
  const devOn = useSyncExternalStore(subscribeSelfHeal, selfHealEnabled, () => false);
  const dead = new Set(APP_GROUPS.filter((g) => g.status === "mac-only" || (g.status === "dev-only" && !devOn)).map((g) => g.id));
```

The tests:
- `ui/screens/settings/tests/groups.test.ts` line 10: `if (g.status === "host" || g.status === "mac-only")` → `if (g.status === "host" || g.status === "mac-only" || g.status === "dev-only")`.
- `ui/screens/settings/tests/components.test.mjs` line 137: `m.groups.APP_GROUPS.filter((g) => g.status !== "mac-only")` → `m.groups.APP_GROUPS.filter((g) => g.status !== "mac-only" && g.status !== "dev-only")`. The count stays 18.
- `ui/screens/settings/tests/components.test.mjs` line 144: `[["SelfHealGroup", "Managed in the Mac app"]]` → `[["SelfHealGroup", "Status: planned"]]`.

`docs/superpowers/plans/2026-10-31-settings-mirror-map.md`, replace the Self-Heal row with:

```markdown
| Self-Heal | stethoscope / stethoscope | Record errors and propose fixes, incidents per run, proposals review (source checkouts only). | DEBUG-ONLY | Debug builds: the recorded incidents with Ignore, Refresh and Clear all; release builds hide the group. | ui/screens/settings/sections/SelfHealSection.tsx | Proposing and applying fixes (git worktree, agent, make regression, review) is plan B and not built yet. |
```

and replace `4. Swift-only, no desktop equivalent planned: Build, Self-Heal, Mobile Control hosting.` with `4. Swift-only, no desktop equivalent planned: Build, Mobile Control hosting. Self-Heal records and lists incidents in debug builds (plan 2026-11-07-self-heal-a-incidents.md); its fix loop is plan B.`

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/*.test.* && npx tsc --noEmit`
Expected: PASS: the 2 new tests, and `groups.test.ts` (notice present for `dev-only`; mirror map has the new blocked-by sentence verbatim). `components.test.mjs` still has 18 live App groups, and the notice says "Status: planned" with no control. `tsc` reports no error.

- [ ] **Step 7: Commit**

```bash
git add ui/screens/settings/self-heal-model.ts ui/screens/settings/sections/SelfHealSection.tsx ui/screens/settings/groups.ts ui/screens/settings/notices.ts ui/screens/settings/registry-default.ts ui/screens/settings/SettingsScreen.tsx ui/screens/settings/tests/self-heal.test.ts ui/screens/settings/tests/groups.test.ts ui/screens/settings/tests/components.test.mjs docs/superpowers/plans/2026-10-31-settings-mirror-map.md
git commit -m "feat(ui): Settings Self-Heal lists incidents in debug builds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, plan rows and the final gates (15 min)

**Files:**
- Modify: `extension/CLAUDE.md` (a new section after "Sync (desktop producer)")
- Modify: `docs/superpowers/MASTER-PLAN.md` (a new S2 row, a correction in the Settings row, the dashboard via `--fix`)

- [ ] **Step 1: The developer note** — append to `extension/CLAUDE.md`:

```markdown
## Self-Heal (debug desktop builds)

- **Switch**:
  - `config.selfHeal` = `LLMIDE_SELF_HEAL=1` and not production. The Tauri host passes it only in a debug build (`desktop/src-tauri/src/self_heal.rs` `enabled()`; opt out with `LLMIDE_SELF_HEAL=0` in the host's env).
  - Off: `/kb/self-heal/*` answers `404 {"error":"feature_disabled","feature":"self_heal"}`, `routes/self-heal.mjs` is never imported, and `/health` does not list the paths.
  - It is not a `FEATURE_ROUTE_GROUPS` entry, because an unset `LLMIDE_FEATURES` means all on.
- **Flow**:
  - The host turns the spawned core's stderr (JSON `error` lines, plain error lines with their frames, 5xx summaries) and panic records into reports.
  - The webview's pump (`ui/screens/shell/self-heal.ts`, `self_heal_take` every 15 s) adds Chat and Loop failures and posts them to `POST /kb/self-heal/incidents` (JWT + bus host proof).
  - `kb/incidents.mjs` stores them in `self_heal_incidents` (migration 0067) after `core/incident.mjs` redacted and signed them.
- **Never** log incident text, send it anywhere or give it to a model. Plan B (the fix loop) drives `fixing`, `proposed`, `needsHuman`, `fixed`, `attempts` and the proposal columns.
- Tests: `tests/incident-rules.test.mjs`, `tests/self-heal-store.test.mjs`, `tests/self-heal-routes.test.mjs`, `tests/self-heal-server.test.mjs` (spawns `server.mjs`; needs local listen).
```

- [ ] **Step 2: The plan rows** — `docs/superpowers/MASTER-PLAN.md`:

  - Directly after the line that starts `- [ ] Desktop gaps still open after the audit`, add:

```markdown
- [~] Self-Heal on the desktop, plan A (capture, store, list): debug builds only (the host passes `LLMIDE_SELF_HEAL=1` to the core it spawns only in a debug build; release builds record and show nothing). The spawned core's stderr (error lines with frames, logger error lines, 5xx), panic records and Chat/Loop failures become redacted, signature-deduplicated incidents in `self_heal_incidents` (migration 0067, API 121), listed in Settings → Self-Heal with Ignore and Clear ([plan](plans/2026-11-07-self-heal-a-incidents.md)) (me). Open: plan B, the fix loop (git worktree, agent, make regression, review and apply) (me)
```

  - In the Settings row (the line starting `- [~] Settings is one App page`), replace `Swift-only: Mobile Control, Self-Heal;` with `Swift-only: Mobile Control; Self-Heal lists incidents in debug builds (fix loop = plan B);`.

Run: `node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check && node scripts/user-needs.mjs --check`
Expected: `--fix` raises the "Desktop multi-OS (Tauri)" Partial count and Total by one; both checks PASS.

- [ ] **Step 3: Run the whole regression**

Run (unsandboxed, because several suites listen on loopback):

```bash
make test
cd extension && npm run lint && cd ..
make contract-gates
make docs-check
cd desktop && npm test && npx tsc --noEmit && cd ..
cd desktop/src-tauri && CARGO_INCREMENTAL=0 PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" cargo test --lib && cd ../..
node scripts/plan-status.mjs --check
node scripts/user-needs.mjs --check
make regression
```

Expected: all PASS. ESLint reports zero boundary violations (`core/incident.mjs` → core, `kb/incidents.mjs` → kb + core; `routes/self-heal.mjs` is imported only by `server.mjs`).

- [ ] **Step 4: Commit**

```bash
git add extension/CLAUDE.md docs/superpowers/MASTER-PLAN.md
git commit -m "docs(plan): Self-Heal plan A row and developer note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## C. Manual check (debug build, `cd desktop && npm run tauri dev`)

1. Sign in and open Settings. The **Self-Heal** group is listed, with the "Status: planned" notice and "No incidents recorded."
2. Stop the network and send a Chat message. Within about 15 s, Refresh shows an `App · chat` incident marked environmental (offline).
3. Make the core fail a request (for example `curl` a route with a forced 500 in a scratch edit you revert after). Refresh shows `Core · <METHOD> /kb/… · New`, with the stack under "Stack" and no home folder or secret visible. Repeat it: the count goes up and no second row appears.
4. Ignore it: the status shows "Ignored" and the Ignore button disappears. Clear all → Confirm: the list is empty.
5. Build a release bundle (`npm run tauri build`) and open it: Settings has no Self-Heal group. `GET /kb/self-heal/incidents` on its core answers `404 feature_disabled`.

## D. Decisions for the user (secure default first)

1. **On by default in debug builds** (opt out with `LLMIDE_SELF_HEAL=0`), not opt-in. Self-Heal exists to catch errors while developing, and the Host API dev flag's opt-in pattern would leave it off almost always. A release build can never turn it on.
2. **Not a feature-route group.** `LLMIDE_FEATURES` unset means "all on", which would make a plain `npm run server` record. The route keeps the same `404 feature_disabled` body, so clients see one shape.
3. **Capture is in the host, not in the core.** The core logger's error lines already reach the host's stderr pipe as JSON, and an `uncaught_exception` exits the core before any in-process recorder could store it. The core therefore records nothing by itself, and only the signed-in desktop user's webview posts reports, which also settles which user owns them. Cost: a core started in a terminal and adopted by the app is not captured.
4. **The Loop report is taken at the UI catch,** not inside `loop_runner.rs`. Every host Loop command's error reaches that catch, and a stage that merely failed its checks is a result, not an incident (the Mac did the same).
5. **Ignore has no un-ignore, and Clear keeps `fixing` / `proposed` rows.** Plan B can add "Reopen" if it is wanted.

## E. Self-review

- **Spec coverage:**
  - Every capture source is covered: stderr grouping (30 frames, 2 s quiet), 5xx with `<METHOD> <normalized endpoint>`, `.ui` chat and loop, `.crash` once per id (last 50), and logger lines in place of OSLog.
  - The rest of the brief, by task: redactor (T1), signature with own frames `extension/`, `desktop/`, `ui/` (T1), store with count, reopen, attempts, cap 200, eviction and the orphan reopen (T2), classifier shown as environmental (T1, T9), debug-only gate (T4, T6, T7), desktop-only surface (no Host API change), and the honest Self-Heal notice (T9).
  - The suppression windows are left out: a plan B run can scope its own reports at the pump (`reportUiIncident` and `keep` are the hook point).
- **Placeholder scan:** none. The two line-number edits in the spec docs name the exact `grep` that gives the number.
- **Type consistency:**
  - `HostIncident` serializes `{ source, category, message, stack }`; that is what `decodeTake` reads, and what the route and `cleanIncident` take.
  - `Incident` keys are the same in `kb/incidents.mjs` `toIncident`, the schema `$defs.Incident`, the route test and `decodeIncidents`.
  - `reportUiIncident("chat" | "loop", …)` is the same in Task 8's three call sites.
  - `selfHealEnabled` / `subscribeSelfHeal` are the same in Tasks 8 and 9.
