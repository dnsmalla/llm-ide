# Connector Catalog — Phase 1 (Catalog + Library + Settings wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP-style connector catalog — browse/select connectors in the Library, per-user selection stored server-side, the Settings Connections section shows Meeting + Email (fixed defaults) plus only the selected connectors, with Box/Slack pre-selected so existing users see no change.

**Architecture:** A frozen catalog module + per-user selection state file on the server (mirroring `extension/mcp/catalog.mjs` + `extension/plugins/state.mjs`), four `/auth/me/connectors` routes in the MCP route pattern, a Library sidebar section built on the MCP Plugins UI pattern, and selection-conditional rendering in `ConnectionsSettingsSection`. No pipelines in this phase — `gdrive`/`gcal`/`miro` carry `pipelineReady: false` and render a placeholder card.

**Tech Stack:** Node 20+ ESM, node:test; Swift/SwiftUI.

**Spec:** `docs/superpowers/specs/2026-08-22-connector-catalog-design.md` (Phase 1 + Hard constraints sections apply to every task)

## Global Constraints

- Meeting and Email cards, pipelines, config, state: **zero changes** (spec constraint 1).
- Box and Slack behavior unchanged — only visibility becomes selection-driven, and both are pre-selected on first read (spec constraint 2).
- Removing a connector never deletes data (spec constraint 3) — the API is stateless about files in this phase anyway.
- ESLint module boundaries: `connectors/**/*.mjs` may import ONLY `core`, `kb`, `server`, `providers` + Node built-ins/3rd-party (`extension/eslint.config.mjs:99`). Do NOT import from `plugins/` or `mcp/` — duplicate the base-dir derivation instead (the established pattern, `extension/mcp/state.mjs:10-16`).
- State file shape: `<stateDir>/connector-state.json` = `{ [userId]: { selected: string[] } }`, atomic writes (tmp + rename), additive/lenient reads.
- `/auth/me/*` routes are excluded from `server.mjs`'s `ENDPOINTS` — no `SERVER_API_VERSION` bump for new auth routes.
- Every task ends green: `cd extension && node --test tests/<file> && npm run lint`; Mac tasks: `cd mac && swift build && swift test`.
- New state file + routes land only in this phase; no vault keys, no fetch endpoints (Phase 2/3).

---

### Task 1: Catalog module

**Files:**
- Create: `extension/connectors/connector-catalog.mjs`
- Test: `extension/tests/connector-catalog.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `CONNECTOR_CATALOG` (frozen array of `{ id, name, description, icon, authKind, docsUrl, pipelineReady }`) and `catalogEntry(id) -> entry | null`. Tasks 2–3 and the routes consume both; Task 4's Swift `ConnectorCatalogEntry` mirrors the entry shape.

- [ ] **Step 1: Write failing tests** — create `extension/tests/connector-catalog.test.mjs`:

```js
// Tests for extension/connectors/connector-catalog.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_CATALOG, catalogEntry } from '../connectors/connector-catalog.mjs';

test('catalog contains exactly the five shipped connectors', () => {
  assert.deepEqual(CONNECTOR_CATALOG.map((e) => e.id).sort(),
    ['box', 'gcal', 'gdrive', 'miro', 'slack']);
});

test('every entry is fully described and ids are unique', () => {
  const ids = new Set();
  for (const e of CONNECTOR_CATALOG) {
    assert.match(e.id, /^[a-z][a-z0-9-]{1,20}$/, `bad id: ${e.id}`);
    assert.ok(!ids.has(e.id), `duplicate id: ${e.id}`);
    ids.add(e.id);
    assert.equal(typeof e.name, 'string');
    assert.ok(e.name.length > 0);
    assert.equal(typeof e.description, 'string');
    assert.equal(typeof e.icon, 'string');           // SF Symbol name
    assert.ok(['google-oauth', 'slack-oauth', 'box-ccg', 'miro-oauth'].includes(e.authKind));
    assert.match(e.docsUrl, /^https:\/\//);
    assert.equal(typeof e.pipelineReady, 'boolean');
  }
});

test('box and slack are pipeline-ready; the new three are not (phase 1)', () => {
  assert.equal(catalogEntry('box').pipelineReady, true);
  assert.equal(catalogEntry('slack').pipelineReady, true);
  for (const id of ['gdrive', 'gcal', 'miro']) {
    assert.equal(catalogEntry(id).pipelineReady, false);
  }
});

test('catalogEntry returns null for unknown ids', () => {
  assert.equal(catalogEntry('nope'), null);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/connector-catalog.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `extension/connectors/connector-catalog.mjs`:

```js
// Curated connector catalog — the Library's "Add from catalog…" list.
// Mirror of extension/mcp/catalog.mjs: a frozen, code-reviewed list; adding
// a connector is a deliberate product decision, not data entry.
//
// pipelineReady marks whether the fetch→folder→llm-doc pipeline exists:
// true only for connectors that already work today. The new three (gdrive,
// gcal, miro) flip to true in phases 2–3 of the connector-catalog spec.
//
// icon is an SF Symbol name; the Mac app renders it directly.
export const CONNECTOR_CATALOG = Object.freeze([
  Object.freeze({
    id: 'gdrive', name: 'Google Drive',
    description: 'Fetch files from Drive folders into llm-doc notes.',
    icon: 'externaldrive.fill.badge.icloud', authKind: 'google-oauth',
    docsUrl: 'https://developers.google.com/drive/api/guides/enable-sdk',
    pipelineReady: false,
  }),
  Object.freeze({
    id: 'gcal', name: 'Google Calendar',
    description: 'Fetch recent and upcoming calendar events into llm-doc notes.',
    icon: 'calendar', authKind: 'google-oauth',
    docsUrl: 'https://developers.google.com/calendar/api/quickstart/js',
    pipelineReady: false,
  }),
  Object.freeze({
    id: 'miro', name: 'Miro',
    description: 'Fetch board text content (stickies, text items) into llm-doc notes.',
    icon: 'square.grid.3x3', authKind: 'miro-oauth',
    docsUrl: 'https://developers.miro.com/docs',
    pipelineReady: false,
  }),
  Object.freeze({
    id: 'box', name: 'Box',
    description: 'Index a Box folder into the searchable knowledge base.',
    icon: 'externaldrive.fill', authKind: 'box-ccg',
    docsUrl: 'https://developer.box.com/guides/',
    pipelineReady: true,
  }),
  Object.freeze({
    id: 'slack', name: 'Slack',
    description: 'Fetch channel history into llm-doc notes.',
    icon: 'message.fill', authKind: 'slack-oauth',
    docsUrl: 'https://api.slack.com/authentication',
    pipelineReady: true,
  }),
]);

/** The catalog entry with `id`, or null. */
export function catalogEntry(id) {
  return CONNECTOR_CATALOG.find((e) => e.id === id) || null;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/connector-catalog.test.mjs && npm run lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add extension/connectors/connector-catalog.mjs extension/tests/connector-catalog.test.mjs
git commit -m "feat(connectors): curated connector catalog module"
```

---

### Task 2: Selection state

**Files:**
- Create: `extension/connectors/connector-state.mjs`
- Test: `extension/tests/connector-state.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1's `CONNECTOR_CATALOG`, `catalogEntry`.
- Produces:
  - `selectedConnectors(userId) -> Set<string>` (box + slack pre-selected on a user's first read)
  - `selectConnector(userId, id) -> boolean` (false when not in catalog)
  - `deselectConnector(userId, id) -> void`
  - `pruneOrphanSelections() -> void` (drops ids no longer in the catalog)

- [ ] **Step 1: Write failing tests** — create `extension/tests/connector-state.test.mjs`:

```js
// Tests for extension/connectors/connector-state.mjs — per-user selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_FILE = join('connector-state.json');

function freshEnv() {
  // The state module reads LLMIDE_PLUGIN_DIR's parent dir (same override
  // convention as plugins/state.mjs and mcp/state.mjs).
  const dir = mkdtempSync(join(tmpdir(), 'connector-state-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  process.env.LLMIDE_PLUGIN_DIR = join(dir, 'plugins');
  return dir;
}

async function loadModule() {
  // Fresh import per test so module-level caching cannot leak state.
  const mod = await import(`../connectors/connector-state.mjs?${Date.now()}`);
  return mod;
}

test('first read pre-selects box and slack (existing users see no change)', async () => {
  const dir = freshEnv();
  try {
    const { selectedConnectors } = await loadModule();
    const selected = selectedConnectors('user-1');
    assert.deepEqual([...selected].sort(), ['box', 'slack']);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('select/deselect round-trips and persists across module reloads', async () => {
  const dir = freshEnv();
  try {
    const m1 = await loadModule();
    assert.equal(m1.selectConnector('user-1', 'miro'), true);
    assert.equal(m1.selectedConnectors('user-1').has('miro'), true);
    const m2 = await loadModule();
    assert.equal(m2.selectedConnectors('user-1').has('miro'), true);
    m2.deselectConnector('user-1', 'miro');
    assert.equal(m2.selectedConnectors('user-1').has('miro'), false);
    assert.equal((await loadModule()).selectedConnectors('user-1').has('miro'), false);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown catalog ids are refused', async () => {
  const dir = freshEnv();
  try {
    const { selectConnector } = await loadModule();
    assert.equal(selectConnector('user-1', 'not-a-connector'), false);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selections are per-user', async () => {
  const dir = freshEnv();
  try {
    const m = await loadModule();
    m.selectConnector('user-1', 'miro');
    assert.equal(m.selectedConnectors('user-2').has('miro'), false);
    assert.deepEqual([...m.selectedConnectors('user-2')].sort(), ['box', 'slack']);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneOrphanSelections drops ids removed from the catalog', async () => {
  const dir = freshEnv();
  try {
    const m = await loadModule();
    m.selectConnector('user-1', 'miro');
    // Hand-write an orphan id behind the module's back.
    writeFileSync(join(dir, 'connector-state.json'),
      JSON.stringify({ 'user-1': { selected: ['miro', 'retired-one'] } }), 'utf8');
    m.pruneOrphanSelections();
    assert.equal(m.selectedConnectors('user-1').has('retired-one'), false);
    assert.equal(m.selectedConnectors('user-1').has('miro'), true);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/connector-state.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `extension/connectors/connector-state.mjs`:

```js
// Per-user connector selection state — which catalog connectors the user
// has added (and therefore sees in Settings → Connections).
//
// Mirror of plugins/state.mjs: a single JSON file beside the plugin dir so
// it is trivial to back up by hand, keyed by userId, atomic writes.
//
// File: <pluginDir>/../connector-state.json
// Shape: { [userId]: { selected: string[] } }
//
// First read for a user pre-selects box and slack: those connectors shipped
// hardcoded in Settings before this catalog existed, so an upgrading user's
// look must not change until they choose (spec constraint 2).
//
// The base-dir derivation is deliberately duplicated from
// mcp/state.mjs — connectors may not import plugins/ or mcp/ (ESLint
// layer rules), and the duplication is three lines.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { catalogEntry } from './connector-catalog.mjs';

const PRESELECTED = ['box', 'slack'];

function baseDir() {
  return process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
}

function statePath() {
  return join(dirname(baseDir()), 'connector-state.json');
}

function readAll() {
  const p = statePath();
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {}; // corrupt — next write overwrites cleanly
  }
}

function writeAll(data) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, p);
}

function selectedArray(userId) {
  const all = readAll();
  const entry = all[userId];
  if (!entry || !Array.isArray(entry.selected)) return null;
  return entry.selected.filter((id) => typeof id === 'string');
}

/** The user's selected connector ids. First read pre-selects box+slack. */
export function selectedConnectors(userId) {
  const existing = selectedArray(userId);
  if (existing === null) {
    const all = readAll();
    all[userId] = { selected: [...PRESELECTED] };
    writeAll(all);
    return new Set(PRESELECTED);
  }
  return new Set(existing);
}

/** Select a catalog connector. Returns false for unknown ids. */
export function selectConnector(userId, id) {
  if (!catalogEntry(id)) return false;
  const all = readAll();
  const current = selectedArray(userId) ?? [...PRESELECTED];
  if (!current.includes(id)) current.push(id);
  all[userId] = { selected: current };
  writeAll(all);
  return true;
}

/** Deselect a connector. Removing never deletes data (spec constraint 3). */
export function deselectConnector(userId, id) {
  const all = readAll();
  const current = selectedArray(userId) ?? [...PRESELECTED];
  all[userId] = { selected: current.filter((x) => x !== id) };
  writeAll(all);
}

/** Drop selections whose ids no longer exist in the catalog. */
export function pruneOrphanSelections() {
  const all = readAll();
  let changed = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (!entry || !Array.isArray(entry.selected)) continue;
    const kept = entry.selected.filter((id) => catalogEntry(id));
    if (kept.length !== entry.selected.length) {
      all[userId] = { selected: kept };
      changed = true;
    }
  }
  if (changed) writeAll(all);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/connector-state.test.mjs && npm run lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add extension/connectors/connector-state.mjs extension/tests/connector-state.test.mjs
git commit -m "feat(connectors): per-user selection state with box/slack pre-selection"
```

---

### Task 3: `/auth/me/connectors` routes

**Files:**
- Modify: `extension/server/auth-routes.mjs` (route block after the mcp-plugins block ending ~line 1420; allow-list at lines 183–196)
- Test: `extension/tests/connector-routes.test.mjs` (create; model on the plugin lifecycle tests in `auth-routes.test.mjs:471-488` — read that file's setup first and reuse its server-bootstrap helper if exported; otherwise bootstrap with the same pattern)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (Task 4's Swift client consumes):
  - `GET /auth/me/connectors` → `{ connectors: [ { id, name, description, icon, authKind, docsUrl, pipelineReady } ] }` (selected only)
  - `GET /auth/me/connectors/catalog` → same shape, all entries, each plus `selected: boolean`
  - `POST /auth/me/connectors/add` `{ id }` → `{ ok: true, id }` (400 for unknown id)
  - `DELETE /auth/me/connectors/<id>` → `{ ok: true, id }`
  - Audit actions `connector.select` / `connector.deselect`.

- [ ] **Step 1: Write failing tests** — create `extension/tests/connector-routes.test.mjs`, bootstrapped like `extension/tests/auth-routes.test.mjs` (copy its header verbatim: env vars at :13-48 — including a FRESH temp dir for `LLMIDE_PLUGIN_DIR` so connector-state writes never touch the shared fixtures — then `makeReq`/`makeRes`/`callAuth` at :57-93 and `registerAndLogin` at :97-105):

```js
// HTTP-level tests for the /auth/me/connectors route family.
// Same req/res double pattern as auth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_connector-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

// Fresh plugin dir per run → connector-state.json lands in its parent
// temp dir, keeping pre-selection state clean for every execution.
const stateRoot = fs.mkdtempSync(path.join(tmpdir(), 'connector-routes-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(stateRoot, 'plugins');
fs.mkdirSync(process.env.LLMIDE_PLUGIN_DIR, { recursive: true });
const repoRootFixture = path.join(__dirname, '_connector-routes-repo-root-fixture');
process.env.LLMIDE_REPO_ROOT = repoRootFixture;
fs.rmSync(repoRootFixture, { recursive: true, force: true });
fs.mkdirSync(repoRootFixture, { recursive: true });

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');

// … then copy makeReq / makeRes / callAuth / registerAndLogin verbatim
// from auth-routes.test.mjs:57-105 (adjusting only the fixture path vars)…

test('connector routes: pre-selection, list, catalog, add, remove', async () => {
  const { user } = await registerAndLogin();

  // Pre-selection: box + slack on first read.
  const list0 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user });
  assert.equal(list0.statusCode, 200, list0._body);
  assert.deepEqual(list0.json().connectors.map((c) => c.id).sort(), ['box', 'slack']);

  // Catalog: all five, with the selected flag computed per user.
  const cat = await callAuth({ method: 'GET', url: '/auth/me/connectors/catalog', user });
  assert.equal(cat.statusCode, 200, cat._body);
  const entries = cat.json().catalog;
  assert.equal(entries.length, 5);
  assert.equal(entries.find((e) => e.id === 'slack').selected, true);
  assert.equal(entries.find((e) => e.id === 'gdrive').selected, false);
  for (const e of entries) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.pipelineReady, 'boolean');
  }

  // Add + duplicate add is idempotent.
  const add = await callAuth({ method: 'POST', url: '/auth/me/connectors/add', body: { id: 'miro' }, user });
  assert.equal(add.statusCode, 200, add._body);
  const list1 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user });
  assert.deepEqual(list1.json().connectors.map((c) => c.id).sort(), ['box', 'miro', 'slack']);

  // Unknown id → 400.
  const bad = await callAuth({ method: 'POST', url: '/auth/me/connectors/add', body: { id: 'nope' }, user });
  assert.equal(bad.statusCode, 400);

  // Remove slack → disappears from the list.
  const del = await callAuth({ method: 'DELETE', url: '/auth/me/connectors/slack', user });
  assert.equal(del.statusCode, 200, del._body);
  const list2 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user });
  assert.deepEqual(list2.json().connectors.map((c) => c.id).sort(), ['box', 'miro']);

  // Selections are per-user: a second user still sees only the pre-selection.
  const { user: user2 } = await registerAndLogin();
  const list3 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user: user2 });
  assert.deepEqual(list3.json().connectors.map((c) => c.id).sort(), ['box', 'slack']);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/connector-routes.test.mjs`
Expected: FAIL — 404s on all four routes.

- [ ] **Step 3: Implement** — in `extension/server/auth-routes.mjs`, add the paths to the allow-list (lines 183–196, same array the mcp paths are in), then add a block after the mcp-plugins block (~line 1420):

```js
  // ── Connector catalog (Library → Add from catalog…; Settings visibility) ──

  if (method === 'GET' && url.split('?')[0] === '/auth/me/connectors') {
    const { selectedConnectors } = await import('../connectors/connector-state.mjs');
    const { CONNECTOR_CATALOG } = await import('../connectors/connector-catalog.mjs');
    const selected = selectedConnectors(req.user.id);
    send(res, 200, {
      connectors: CONNECTOR_CATALOG
        .filter((e) => selected.has(e.id))
        .map(({ id, name, description, icon, authKind, docsUrl, pipelineReady }) =>
          ({ id, name, description, icon, authKind, docsUrl, pipelineReady })),
    });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/connectors/catalog') {
    const { selectedConnectors } = await import('../connectors/connector-state.mjs');
    const { CONNECTOR_CATALOG } = await import('../connectors/connector-catalog.mjs');
    const selected = selectedConnectors(req.user.id);
    send(res, 200, {
      catalog: CONNECTOR_CATALOG.map((e) => ({ ...e, selected: selected.has(e.id) })),
    });
    return;
  }

  if (method === 'POST' && url === '/auth/me/connectors/add') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,20}$/.test(body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id must be a connector slug' } });
      return;
    }
    const { selectConnector } = await import('../connectors/connector-state.mjs');
    if (!selectConnector(req.user.id, body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: `unknown connector '${body.id}'` } });
      return;
    }
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'connector.select', resource: body.id, outcome: 'success',
    });
    send(res, 200, { ok: true, id: body.id });
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/connectors/')) {
    const id = url.split('/').pop();
    if (!/^[a-z][a-z0-9-]{1,20}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id must be a connector slug' } });
      return;
    }
    const { deselectConnector } = await import('../connectors/connector-state.mjs');
    deselectConnector(req.user.id, id);
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'connector.deselect', resource: id, outcome: 'success',
    });
    send(res, 200, { ok: true, id });
    return;
  }
```

(Match the surrounding file's exact `send`/`readJson`/`safeAudit`/`db`/`ua`/`requestId` variable names — they are the ones the neighboring mcp-plugins block uses; if any helper name differs, follow the neighbor, not this snippet.)

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/connector-routes.test.mjs tests/auth-routes.test.mjs && npm run lint`
Expected: PASS (both files — no regression in the auth suite).

- [ ] **Step 5: Commit**

```bash
git add extension/server/auth-routes.mjs extension/tests/connector-routes.test.mjs
git commit -m "feat(connectors): /auth/me/connectors catalog and selection routes"
```

---

### Task 4: Mac API client + models

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Connectors.swift`
- Test: `mac/Tests/LlmIdeMacTests/ConnectorCatalogDecodingTests.swift` (create)

**Interfaces:**
- Consumes: Task 3's response shapes.
- Produces (Tasks 5–6 consume):
  - `struct ConnectorCatalogEntry: Decodable, Identifiable, Equatable` with `id, name, description, icon, authKind, docsUrl, pipelineReady, selected`
  - `api.listConnectors() async throws -> [ConnectorCatalogEntry]` (selected only)
  - `api.fetchConnectorCatalog() async throws -> [ConnectorCatalogEntry]` (all)
  - `api.addConnector(id: String) async throws` / `api.removeConnector(id: String) async throws`

- [ ] **Step 1: Write failing test** — create `mac/Tests/LlmIdeMacTests/ConnectorCatalogDecodingTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

final class ConnectorCatalogDecodingTests: XCTestCase {
    func testCatalogEntryDecodesWithSelectedFlag() throws {
        let json = """
        {"id":"miro","name":"Miro","description":"Fetch boards.",
         "icon":"square.grid.3x3","authKind":"miro-oauth",
         "docsUrl":"https://developers.miro.com/docs","pipelineReady":false,
         "selected":true}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ConnectorCatalogEntry.self, from: json)
        XCTAssertEqual(entry.id, "miro")
        XCTAssertEqual(entry.authKind, "miro-oauth")
        XCTAssertFalse(entry.pipelineReady)
        XCTAssertTrue(entry.selected)
    }

    func testSelectedListEntryToleratesMissingSelectedFlag() throws {
        // GET /auth/me/connectors omits `selected` (implied true) — decode
        // must not fail on the leaner shape.
        let json = """
        {"id":"box","name":"Box","description":"Index.",
         "icon":"externaldrive.fill","authKind":"box-ccg",
         "docsUrl":"https://developer.box.com/","pipelineReady":true}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ConnectorCatalogEntry.self, from: json)
        XCTAssertEqual(entry.id, "box")
        XCTAssertEqual(entry.selected, false) // lenient default
    }
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cd mac && swift test --filter ConnectorCatalogDecodingTests`
Expected: FAIL — type not found.

- [ ] **Step 3: Implement** — create `LlmIdeAPIClient+Connectors.swift`, following the structure of `LlmIdeAPIClient+McpPlugins.swift` (same request/decode/error helpers — read its top 60 lines first and reuse the identical patterns, including its `struct`-in-extension house style):

```swift
import Foundation

/// One connector-catalog entry — the Library's "Add from catalog…" list and
/// the Settings → Connections selection both read this shape.
struct ConnectorCatalogEntry: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String
    let icon: String          // SF Symbol name
    let authKind: String      // google-oauth | slack-oauth | box-ccg | miro-oauth
    let docsUrl: String
    let pipelineReady: Bool
    /// Only the /catalog endpoint sets it; the selected-list omits it.
    var selected: Bool = false

    enum CodingKeys: String, CodingKey {
        case id, name, description, icon, authKind, docsUrl, pipelineReady, selected
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decode(String.self, forKey: .description)
        self.icon = try c.decode(String.self, forKey: .icon)
        self.authKind = try c.decode(String.self, forKey: .authKind)
        self.docsUrl = try c.decode(String.self, forKey: .docsUrl)
        self.pipelineReady = try c.decode(Bool.self, forKey: .pipelineReady)
        self.selected = (try? c.decode(Bool.self, forKey: .selected)) ?? false
    }
}
```

Plus the four client methods (`listConnectors` GET `/auth/me/connectors` decoding `{ connectors: […] }`; `fetchConnectorCatalog` GET `/auth/me/connectors/catalog` decoding `{ catalog: […] }`; `addConnector(id:)` POST `/auth/me/connectors/add`; `removeConnector(id:)` DELETE `/auth/me/connectors/<id>`) — written with the same helper calls `LlmIdeAPIClient+McpPlugins.swift` uses for `listMcpPlugins` (:172), `fetchMcpCatalog` (:179), `addMcpPlugin` (:222), and the delete (:253); copy those bodies and change path/payload/decode type.

- [ ] **Step 4: Run — verify pass**

Run: `cd mac && swift build && swift test --filter ConnectorCatalogDecodingTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Connectors.swift mac/Tests/LlmIdeMacTests/ConnectorCatalogDecodingTests.swift
git commit -m "feat(mac): connector catalog API client and models"
```

---

### Task 5: Library Connectors section

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` (state vars :66-75, `.task` :100, `refreshAll()` :680-687, section list in `mainList` :210-283 after `mcpPluginsSection` :279, collapsed default :80)
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift:80-88` (`LibrarySelection`)
- Create: `mac/Sources/LlmIdeMac/Views/Library/ConnectorAddSheet.swift`, `mac/Sources/LlmIdeMac/Views/Library/ConnectorRow.swift`, `mac/Sources/LlmIdeMac/Views/Library/ConnectorDetailView.swift`

**Interfaces:**
- Consumes: Task 4's `ConnectorCatalogEntry` + client methods; the `unifiedSectionHeader(id:title:icon:tint:count:)` helper (:500-545).
- Produces: a "Connectors" sidebar section; `ShellState.LibrarySelection.connector(String)` selection case; in-memory `@State var selectedConnectors: [ConnectorCatalogEntry]` refreshed by `refreshAll()` (Task 6 reads the same source of truth — refactor the load into a shared `loadConnectors()` method on LibraryView that Task 6's section re-uses via the existing environment/notification pattern used for mcp refresh; simplest concrete choice: post the existing `.scrollSettingsToCard`-style notification only if one already exists for mcp — otherwise Task 6 loads independently from the API, which is idempotent).

- [ ] **Step 1: Implement the selection case + row/sheet/detail views**

`ShellState.swift` — inside `enum LibrarySelection` (line 80, beside `case mcpPlugin(String)` at :88) add:

```swift
        case connector(String)
```

Create `ConnectorRow.swift` (model on `McpPluginRow` — icon from `Image(systemName: entry.icon)`, name, a "Selected" badge or checkmark, context-menu Remove calling the passed closure):

```swift
import SwiftUI

/// One selected connector row in the Library sidebar's Connectors section.
struct ConnectorRow: View {
    @EnvironmentObject private var theme: ThemeStore
    let entry: ConnectorCatalogEntry
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: entry.icon)
                .foregroundStyle(theme.current.tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name).lineLimit(1)
                if !entry.pipelineReady {
                    Text("Pipeline coming soon")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .contentShape(Rectangle())
        .contextMenu { Button("Remove", role: .destructive, action: onRemove) }
    }
}
```

Create `ConnectorAddSheet.swift` (model on `McpAddSheet`'s catalog mode — list catalog entries, disable already-selected, note that removal keeps data):

```swift
import SwiftUI

/// "Add from catalog…" sheet — lists the connector catalog; already-selected
/// entries are disabled. Removing a connector later never deletes its data.
struct ConnectorAddSheet: View {
    @EnvironmentObject private var theme: ThemeStore
    let catalog: [ConnectorCatalogEntry]
    let onAdd: (ConnectorCatalogEntry) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add Connector").font(.headline)
            ForEach(catalog) { entry in
                Button { onAdd(entry); dismiss() }
                label: {
                    HStack {
                        Image(systemName: entry.icon).frame(width: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.name).foregroundStyle(.primary)
                            Text(entry.description).font(.caption)
                                .foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer()
                        if entry.selected {
                            Image(systemName: "checkmark").foregroundStyle(.secondary)
                        } else if !entry.pipelineReady {
                            Text("soon").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(entry.selected)
            }
            Text("Removing a connector later keeps its fetched data and notes.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(width: 380)
    }
}
```

Create `ConnectorDetailView.swift` (model on `McpPluginDetailView`'s structure — description, auth kind, docs link, pipeline status, Remove button with the data-kept note).

- [ ] **Step 2: Wire the section into LibraryView**

Add state beside the mcp state vars (:66-75):

```swift
    @State private var connectorCatalog: [ConnectorCatalogEntry] = []
    @State private var selectedConnectors: [ConnectorCatalogEntry] = []
    @State private var connectorsError: String?
    @State private var showConnectorAddSheet = false
```

Add `"connectors"` to the collapsed-sections seed string (:80). Add a loader `.task` beside the mcp one (:100) and add `await loadConnectors()` to `refreshAll()` (:680-687):

```swift
    private func loadConnectors() async {
        do {
            async let catalog = api.fetchConnectorCatalog()
            async let selected = api.listConnectors()
            connectorCatalog = try await catalog
            selectedConnectors = try await selected
            connectorsError = nil
        } catch {
            connectorsError = error.localizedDescription
        }
    }
```

Add to `mainList` after `mcpPluginsSection` (:279):

```swift
                connectorsSection
```

and the section builder (model on `mcpPluginsSection` :997-1029 + header :1031-1037):

```swift
    @ViewBuilder
    private var connectorsSection: some View {
        Section {
            if sectionExpanded("connectors") {
                if let err = connectorsError {
                    errorRow(err) { Task { await loadConnectors() } }   // same error-row pattern as mcp
                } else if selectedConnectors.isEmpty {
                    emptyRow("No connectors selected — add one from the catalog.")
                } else {
                    ForEach(selectedConnectors) { entry in
                        NavigationLink(value: ShellState.LibrarySelection.connector(entry.id)) {
                            ConnectorRow(entry: entry) {
                                Task {
                                    try? await api.removeConnector(id: entry.id)
                                    await loadConnectors()
                                }
                            }
                        }
                    }
                }
            }
        } header: {
            unifiedSectionHeader(id: "connectors", title: "Connectors",
                                 icon: "point.3.connected.trianglepath.dotted",
                                 tint: .blue, count: selectedConnectors.count) {
                Menu {
                    Button("Add from catalog…") { showConnectorAddSheet = true }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
    }
```

(Adjust `errorRow`/`emptyRow` to whatever the mcp section actually calls them — follow the neighbor's exact helpers.) Add the sheet beside the mcp sheet (:1110-1118) and the navigation destination for `.connector(id)` beside the mcpPlugin destination (find where `LibrarySelection.mcpPlugin` is switched/rendered and add a parallel case rendering `ConnectorDetailView` fed from `selectedConnectors.first(where: { $0.id == id })` plus the catalog entry).

- [ ] **Step 3: Build + full mac tests**

Run: `cd mac && swift build && swift test`
Expected: build clean, all tests green.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/ mac/Sources/LlmIdeMac/Services/ShellState.swift
git commit -m "feat(mac): Library Connectors section with catalog add sheet"
```

---

### Task 6: Settings — selection-driven Connections section

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` (body cards :60-75, slackCard :220, boxCard :242)
- Test: `mac/Tests/LlmIdeMacTests/ConnectionsSectionSelectionTests.swift` (create — pure logic test)

**Interfaces:**
- Consumes: Task 4's client + `ConnectorCatalogEntry`.
- Produces: rendering rule used by the section body — `ConnectionsSelection.visibleCardIds(selected:) -> [String]` (tested); the section keeps Meeting/Email hardcoded and gates slack/box/gdrive/gcal/miro cards on selection.

- [ ] **Step 1: Write failing test** — create `mac/Tests/LlmIdeMacTests/ConnectionsSectionSelectionTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The Settings Connections section's card visibility rule: Meeting and
/// Email are fixed defaults; everything else appears only when selected.
final class ConnectionsSectionSelectionTests: XCTestCase {
    func testDefaultsAreAlwaysPresentAndUnselectable() {
        // No selection at all (e.g. catalog request failed): defaults stay.
        let ids = ConnectionsSelection.visibleCardIds(selected: [])
        XCTAssertEqual(ids.first, "meetings")
        XCTAssertTrue(ids.contains("email"))
        XCTAssertFalse(ids.contains("slack"))
        XCTAssertFalse(ids.contains("box"))
    }

    func testSelectedConnectorsAppearInCatalogOrder() {
        let ids = ConnectionsSelection.visibleCardIds(selected: ["slack", "miro", "box"])
        XCTAssertEqual(ids, ["meetings", "email", "miro", "box", "slack"])
    }
}

/// Pure visibility rule for ConnectionsSettingsSection (unit-testable
/// without a view): fixed defaults first, then selected connectors in
/// catalog order.
enum ConnectionsSelection {
    static let fixedOrder = ["meetings", "email"]
    static let catalogOrder = ["gdrive", "gcal", "miro", "box", "slack"]

    static func visibleCardIds(selected: Set<String>) -> [String] {
        fixedOrder + catalogOrder.filter { selected.contains($0) }
    }
}
```

(The `enum ConnectionsSelection` goes in `ConnectionsSettingsSection.swift` above the view struct; the test imports it.)

- [ ] **Step 2: Run — verify fail**

Run: `cd mac && swift test --filter ConnectionsSectionSelectionTests`
Expected: FAIL — `ConnectionsSelection` not found.

- [ ] **Step 3: Implement.** Add the `ConnectionsSelection` enum to `ConnectionsSettingsSection.swift`. Then in the section:

1. Add state + loader (beside the existing `sourceLinks.refresh(api:)` call at :99):

```swift
    @State private var selectedConnectorIds: Set<String> = []
    @State private var connectorsLoaded = false
```

```swift
    private func loadConnectorSelection() async {
        if let list = try? await api.listConnectors() {
            selectedConnectorIds = Set(list.map(\.id))
        }
        connectorsLoaded = true
    }
```

(While `!connectorsLoaded`, render the section exactly as today — box/slack visible — so a failed catalog call can never hide a configured connector from the user.)

2. Wrap the existing cards: keep `meetingsCard` (:142) and `emailCard` (:196) unconditional. Wrap `slackCard` (:220) in `if selectedConnectorIds.contains("slack") || !connectorsLoaded` and `boxCard` (:242) in `if selectedConnectorIds.contains("box") || !connectorsLoaded` (with a comment: "pre-selected server-side; the `!connectorsLoaded` guard keeps configured connectors visible even if the catalog request fails").

3. Append, after `boxCard`, one placeholder card per selected new connector (box and slack have their bespoke cards above, so exclude them):

```swift
                ForEach(selectedConnectorIds.subtracting(["box", "slack"]).sorted(), id: \.self) { id in
                    if let entry = connectorEntry(id) {
                        pendingPipelineCard(entry)
                    }
                }
```

with helpers on the section:

```swift
    private func connectorEntry(_ id: String) -> ConnectorCatalogEntry? {
        catalogEntries.first { $0.id == id }
    }

    /// Placeholder card for a selected connector whose fetch pipeline lands
    /// in a later phase — visible so the selection is real, honest that
    /// nothing fetches yet.
    @ViewBuilder
    private func pendingPipelineCard(_ entry: ConnectorCatalogEntry) -> some View {
        InputSourceCard(icon: entry.icon, title: entry.name,
                        subtitle: entry.description, badge: nil) {
            Text("Pipeline lands in an upcoming update — selection is saved.")
                .font(.caption).foregroundStyle(.secondary)
        } primaryAction: nil
    }
```

(This requires `@State private var catalogEntries: [ConnectorCatalogEntry] = []` loaded by `fetchConnectorCatalog()` in the same `loadConnectorSelection()` task, and the `InputSourceCard` initializer signature read from `Views/Sources/InputSourceCard.swift` — follow its real parameter list; if its API differs, wrap in a simple custom `VStack` card matching the section's visual rhythm.)

- [ ] **Step 4: Run — verify pass + full gate**

Run: `cd mac && swift build && swift test`
Expected: PASS, full suite green.

- [ ] **Step 5: Full verification + commit**

Run: `cd extension && npm run lint && npm test` (server untouched since Task 3 — confirm still green).

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift mac/Tests/LlmIdeMacTests/ConnectionsSectionSelectionTests.swift
git commit -m "feat(mac): selection-driven Settings connections section"
```

---

## Final verification (after all tasks)

- [ ] `cd extension && npm run lint && npm test` — green.
- [ ] `cd mac && swift build && swift test` — green (sandbox off on this machine).
- [ ] Manual smoke: Library shows Connectors with Box + Slack pre-selected; add Miro from the catalog; Settings shows Meeting, Email, Box, Slack, Miro(placeholder); remove Slack — card disappears from Settings, Library row disappears; data untouched.
- [ ] Regression Loop stage green.

## Deferred (do NOT do in Phase 1)

- Phase 2: gdrive + gcal transports, manifests, adapters, generic configField cards, classify agents, `google.connector.*` vault keys.
- Phase 3: Miro OAuth helper + transport + manifest.
- Wiring the placeholder cards to real pipelines; joining `SourceRegistry.fetchSources`.
