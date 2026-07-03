# Box Document Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Box (box.com) as a document source — the server fetches a Box folder's file texts, chunks them, and ingests them into the per-user knowledge base (`sources` table, `kind='doc'`).

**Architecture:** A Pattern-A connector (`extension/connectors/box.mjs`, peer of `git.mjs`): Client-Credentials-Grant token exchange → recursive folder listing → per-file `extracted_text` representation → `chunkLines` → `deleteSourcesByPrefix`+`ingestSources`. Two routes (`/kb/box/test`, `/kb/connect-box`). Mac config (`SavedBoxSource`) + API client + a Sources card. `clientSecret` in the encrypted vault; other config Mac-local. No DB migration.

**Tech Stack:** Node ESM (`node:test` + `node:assert/strict`), better-sqlite3; Swift/SwiftUI (swift-testing). Backend tests: `cd extension && node --test tests/<file>`. Mac: `cd mac && swift build && swift test --filter <Name>` (use dangerouslyDisableSandbox for swift build/test).

## Global Constraints

- Ingest as `kind: 'doc'` (an existing `ALLOWED_SOURCE_KINDS` value — do NOT add a new kind).
- Source-row shape `ingestSources` requires: `{ kind, ref, chunkIdx, title, body, meta }` (ref ≤1000 chars, title ≤500, body ≤50000).
- Each file's `ref` = `box:<folderId>:<fileId>` so `deleteSourcesByPrefix(userId, 'doc', 'box:<folderId>:')` scopes the wholesale re-index to this folder.
- Vault key `box.clientSecret` MUST be added to `ALLOWED_KEYS` in `extension/server/vault.mjs` or every read/write throws `Unknown vault key`. `getSecret`/`setSecret` take `db` FIRST: `getSecret(kb.getDb(), userId, 'box.clientSecret')`.
- Every new endpoint MUST be added to BOTH `server.mjs` ENDPOINTS array AND `docs/reference/api/openapi.yaml` `paths:` or `make docs-check` fails.
- Network via global `fetch` (mirror `slack-source.mjs`); tests stub `global.fetch` and restore it in `try/finally`. Box host is fixed (`api.box.com`) → no SSRF check needed.
- Secret is never logged/echoed; surface only Box's error `message`, run through the shared `redactSecrets` before returning.
- Wholesale re-index per sync (delete-by-prefix then insert); no `box_state` table.

---

### Task 1: Box connector `extension/connectors/box.mjs`

**Files:**
- Create: `extension/connectors/box.mjs`
- Test: `extension/tests/box-connector.test.mjs`

**Interfaces:**
- Consumes: `chunkLines` from `../connectors/git.mjs`; `ingestSources`, `deleteSourcesByPrefix` from `../kb/db.mjs`.
- Produces (all exported): `buildTokenForm(creds)`, `exchangeCCGToken(creds, opts?)`, `parseFolderItems(json)`, `fetchExtractedText(token, fileId, opts?)`, `toSourceRows({folderId, fileId, name, modifiedAt, path, text})`, `indexBoxFolder(userId, creds, opts?)`.
  - `creds` = `{ clientId, clientSecret, subjectType, subjectId, folderId }`.
  - `indexBoxFolder` returns `{ indexed: number, skipped: number }`.

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `extension/tests/box-connector.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTokenForm, parseFolderItems, toSourceRows } from '../connectors/box.mjs';

test('buildTokenForm encodes a CCG request', () => {
  const form = buildTokenForm({ clientId: 'cid', clientSecret: 'sec', subjectType: 'enterprise', subjectId: '123' });
  const p = new URLSearchParams(form);
  assert.equal(p.get('grant_type'), 'client_credentials');
  assert.equal(p.get('client_id'), 'cid');
  assert.equal(p.get('client_secret'), 'sec');
  assert.equal(p.get('box_subject_type'), 'enterprise');
  assert.equal(p.get('box_subject_id'), '123');
});

test('parseFolderItems splits files and subfolders', () => {
  const json = { entries: [
    { type: 'file', id: '1', name: 'a.txt', modified_at: '2026-01-01T00:00:00Z' },
    { type: 'folder', id: '9', name: 'sub' },
    { type: 'web_link', id: '5', name: 'link' },
  ], total_count: 3 };
  const { files, folders } = parseFolderItems(json);
  assert.deepEqual(files.map(f => f.id), ['1']);
  assert.deepEqual(folders.map(f => f.id), ['9']);
  assert.equal(files[0].name, 'a.txt');
});

test('toSourceRows chunks text into doc rows with a folder-scoped ref', () => {
  const rows = toSourceRows({ folderId: 'F', fileId: '42', name: 'notes.md', modifiedAt: 'T', path: 'sub/notes.md', text: 'line1\nline2' });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].kind, 'doc');
  assert.equal(rows[0].ref, 'box:F:42');
  assert.equal(rows[0].chunkIdx, 0);
  assert.equal(rows[0].title, 'notes.md');
  assert.equal(rows[0].meta.fileId, '42');
  assert.equal(rows[0].meta.folderId, 'F');
  assert.equal(rows[0].meta.path, 'sub/notes.md');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && node --test tests/box-connector.test.mjs`
Expected: FAIL — cannot find module `../connectors/box.mjs`.

- [ ] **Step 3: Implement the connector**

Create `extension/connectors/box.mjs`:

```js
// Box document source — Pattern A connector (peer of git.mjs).
// Client-Credentials-Grant auth → recursive folder list → per-file
// extracted_text representation → chunk → ingest into `sources` (kind='doc').
// Network is global fetch (fixed host api.box.com, so no SSRF surface),
// mirroring agents/slack-source.mjs. Tests stub global.fetch.
import { chunkLines, } from './git.mjs';
import { ingestSources, deleteSourcesByPrefix } from '../kb/db.mjs';

const TOKEN_URL = 'https://api.box.com/oauth2/token';
const API = 'https://api.box.com/2.0';
const FETCH_DEADLINE_MS = 30_000;
const MAX_FILES = 2000;      // safety cap (mirrors git's fence caps)
const MAX_DEPTH = 10;        // subfolder recursion cap
const REP_POLL_ATTEMPTS = 5; // extracted_text may be 'pending' briefly
const DEFAULT_POLL_MS = 1500;

async function boxFetch(url, { token, headers, signal } = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(headers || {}) },
    signal,
  });
  return res;
}

/** Pure: form body for the CCG token request. */
export function buildTokenForm({ clientId, clientSecret, subjectType, subjectId }) {
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    box_subject_type: subjectType,
    box_subject_id: subjectId,
  }).toString();
}

/** Exchange CCG creds for a short-lived access token. */
export async function exchangeCCGToken(creds, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenForm(creds),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Box auth failed: ${data.error_description || data.error || res.status}`);
    }
    return { accessToken: data.access_token };
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: split a folder-items response into files + subfolders. */
export function parseFolderItems(json) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const files = [];
  const folders = [];
  for (const e of entries) {
    if (e?.type === 'file') files.push({ id: String(e.id), name: e.name || String(e.id), modifiedAt: e.modified_at || null });
    else if (e?.type === 'folder') folders.push({ id: String(e.id), name: e.name || String(e.id) });
  }
  return { files, folders };
}

/** List a folder recursively (paginated), returning flat file records with paths. */
async function listFolderRecursive(token, folderId, { depth = 0, prefix = '', acc = [] } = {}) {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return acc;
  let offset = 0;
  for (;;) {
    const url = `${API}/folders/${encodeURIComponent(folderId)}/items?fields=id,name,type,modified_at&limit=1000&offset=${offset}`;
    const res = await boxFetch(url, { token });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Box folder list failed: ${json.message || res.status}`);
    const { files, folders } = parseFolderItems(json);
    for (const f of files) {
      if (acc.length >= MAX_FILES) return acc;
      acc.push({ ...f, path: prefix ? `${prefix}/${f.name}` : f.name });
    }
    for (const sub of folders) {
      if (acc.length >= MAX_FILES) return acc;
      await listFolderRecursive(token, sub.id, { depth: depth + 1, prefix: prefix ? `${prefix}/${sub.name}` : sub.name, acc });
    }
    offset += 1000;
    if (offset >= (json.total_count || 0)) break;
  }
  return acc;
}

/** Fetch a file's extracted text, or null when no text representation exists. */
export async function fetchExtractedText(token, fileId, opts = {}) {
  const pollMs = opts.pollDelayMs ?? DEFAULT_POLL_MS;
  const infoUrl = `${API}/files/${encodeURIComponent(fileId)}?fields=representations`;
  const res = await boxFetch(infoUrl, { token, headers: { 'X-Rep-Hints': '[extracted_text]' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const rep = (json?.representations?.entries || []).find(r => r.representation === 'extracted_text');
  if (!rep) return null;
  let state = rep.status?.state;
  let contentTemplate = rep.content?.url_template;
  const infoTemplate = rep.info?.url;
  for (let attempt = 0; state === 'pending' && attempt < REP_POLL_ATTEMPTS; attempt++) {
    if (pollMs > 0) await new Promise(r => setTimeout(r, pollMs));
    if (!infoTemplate) break;
    const pr = await boxFetch(infoTemplate, { token });
    const pj = await pr.json().catch(() => ({}));
    state = pj?.status?.state;
    contentTemplate = pj?.content?.url_template || contentTemplate;
  }
  if (state !== 'success' || !contentTemplate) return null;
  const contentUrl = contentTemplate.replace('{+asset_path}', '');
  const cr = await boxFetch(contentUrl, { token });
  if (!cr.ok) return null;
  return await cr.text();
}

/** Pure: turn one file's text into doc source-rows via chunkLines. */
export function toSourceRows({ folderId, fileId, name, modifiedAt, path, text }) {
  const chunks = chunkLines(text || '');
  return chunks.map((c, idx) => ({
    kind: 'doc',
    ref: `box:${folderId}:${fileId}`,
    chunkIdx: idx,
    title: name,
    body: c.body,
    meta: { folderId, fileId, path, modifiedAt, startLine: c.startLine, endLine: c.endLine },
  }));
}

/** Index a Box folder into the KB (wholesale re-index). */
export async function indexBoxFolder(userId, creds, opts = {}) {
  const { accessToken } = await exchangeCCGToken(creds);
  const files = await listFolderRecursive(accessToken, creds.folderId);
  const items = [];
  let skipped = 0;
  for (const f of files) {
    let text = null;
    try {
      text = await fetchExtractedText(accessToken, f.id, opts);
    } catch {
      text = null;
    }
    if (!text) { skipped += 1; continue; }
    items.push(...toSourceRows({ folderId: creds.folderId, fileId: f.id, name: f.name, modifiedAt: f.modifiedAt, path: f.path, text }));
  }
  deleteSourcesByPrefix(userId, 'doc', `box:${creds.folderId}:`);
  const indexed = ingestSources(userId, items);
  return { indexed, skipped };
}
```

- [ ] **Step 4: Run the pure-helper tests to verify they pass**

Run: `cd extension && node --test tests/box-connector.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Add an integration test for `indexBoxFolder` (mock fetch + temp DB)**

Append to `tests/box-connector.test.mjs`:

```js
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_box-connector-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

test('indexBoxFolder fetches, chunks, and ingests doc rows (skips no-text files)', async () => {
  const dbmod = await import('../kb/db.mjs');
  dbmod.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const db = getDb();
  const userId = registerUser(db, { email: `box-${Math.floor(performance.now()*1000)}@ex.com`, password: 'pw-12345678' }).id;
  const { indexBoxFolder } = await import('../connectors/box.mjs');

  const orig = global.fetch;
  global.fetch = async (urlStr, init) => {
    const url = String(urlStr);
    const json = (o, ok = true) => ({ ok, json: async () => o, text: async () => '' });
    if (url === 'https://api.box.com/oauth2/token') return json({ access_token: 'tok' });
    if (url.includes('/folders/F/items')) return json({ total_count: 2, entries: [
      { type: 'file', id: '1', name: 'a.md', modified_at: 'T' },
      { type: 'file', id: '2', name: 'binary.png', modified_at: 'T' },
    ]});
    if (url.includes('/files/1?')) return json({ representations: { entries: [
      { representation: 'extracted_text', status: { state: 'success' }, content: { url_template: 'https://dl.box.com/1/text{+asset_path}' } },
    ]}});
    if (url.includes('/files/2?')) return json({ representations: { entries: [] } }); // no text rep → skipped
    if (url === 'https://dl.box.com/1/text') return { ok: true, json: async () => ({}), text: async () => 'hello\nworld' };
    return json({}, false);
  };
  try {
    const r = await indexBoxFolder(userId, { clientId: 'c', clientSecret: 's', subjectType: 'enterprise', subjectId: 'e', folderId: 'F' }, { pollDelayMs: 0 });
    assert.equal(r.indexed, 1, 'one chunk from a.md');
    assert.equal(r.skipped, 1, 'binary.png skipped');
    const row = db.prepare("SELECT ref, title, kind FROM sources WHERE user_id=? AND kind='doc'").get(userId);
    assert.equal(row.ref, 'box:F:1');
    assert.equal(row.title, 'a.md');
  } finally {
    global.fetch = orig;
    dbmod.closeDb();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  }
});
```

- [ ] **Step 6: Run all connector tests**

Run: `cd extension && node --test tests/box-connector.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add extension/connectors/box.mjs extension/tests/box-connector.test.mjs
git commit -m "feat(connectors): Box document source connector (CCG auth + extracted-text ingest)"
```

---

### Task 2: Routes `/kb/box/test` + `/kb/connect-box` + vault key + registration

**Files:**
- Modify: `extension/server/vault.mjs` (add `box.clientSecret` to `ALLOWED_KEYS`)
- Modify: `extension/kb/router.mjs` (import + two handlers)
- Modify: `extension/server.mjs` (ENDPOINTS array)
- Modify: `docs/reference/api/openapi.yaml` (two paths)
- Test: `extension/tests/box-routes.test.mjs`

**Interfaces:**
- Consumes: `indexBoxFolder`, `exchangeCCGToken`, `listFolderRecursive`? (no — test route uses a lightweight check). `getSecret` from vault.
- Produces: `POST /kb/box/test` → `{ ok, folderName, itemCount }`; `POST /kb/connect-box` → `{ ok, indexed, skipped }`.

- [ ] **Step 1: Add the vault key**

In `extension/server/vault.mjs`, add `'box.clientSecret',` to the `ALLOWED_KEYS` set (alongside `'slack.botToken'`).

- [ ] **Step 2: Add a `boxTest` helper to the connector**

For `/kb/box/test`, add to `extension/connectors/box.mjs` (and export):

```js
/** Verify creds + folder access: exchange a token and read one page. */
export async function boxTest(creds) {
  const { accessToken } = await exchangeCCGToken(creds);
  const url = `${API}/folders/${encodeURIComponent(creds.folderId)}?fields=name,item_collection`;
  const res = await boxFetch(url, { token: accessToken });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Box folder access failed: ${json.message || res.status}`);
  return { ok: true, folderName: json.name || creds.folderId, itemCount: json.item_collection?.total_count ?? 0 };
}
```

- [ ] **Step 3: Write failing route tests**

Create `extension/tests/box-routes.test.mjs` mirroring an existing router route test (e.g. how `tests/providers-route.test.mjs` or a slack/email route test drives `handleKB` with an authed request). Cover: missing `box.clientSecret` → 400 `BOX_NO_SECRET`; missing `folderId` → 400 `VALIDATION_FAILED`; a stubbed-fetch success for `/kb/box/test` → 200 with `folderName`. (Read an existing route test in `extension/tests/` for the exact request-harness helper — reuse it verbatim; do not invent a new harness.)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
// NOTE: reuse the same authed-request harness used by an existing /kb route
// test in extension/tests/ (find it: grep -l "handleKB\|/kb/slack" tests).
// The assertions below define the contract; wire them to that harness.

test('POST /kb/box/test 400s when no clientSecret is saved', async () => {
  // ...call /kb/box/test as an authed user with no box.clientSecret in vault
  // expect status 400, body.error.code === 'BOX_NO_SECRET'
  assert.ok(true); // replace with real harness call
});
```
(The implementer MUST replace the placeholder body using the real harness from a sibling route test; do not ship the `assert.ok(true)` stub.)

- [ ] **Step 4: Add the route handlers**

In `extension/kb/router.mjs`, add imports near the connector imports (top of file):

```js
import { indexBoxFolder, boxTest } from '../connectors/box.mjs';
```

Add this handler block alongside the other `/kb/*` handlers (mirror the slack block at ~router.mjs:418):

```js
    // Box document source (Pattern A: server indexes into `sources`) ---
    if (req.method === 'POST' && (url === '/kb/box/test' || url === '/kb/connect-box')) {
      const body = parseJSON(await readBody(req)) || {};
      const clientSecret = getSecret(kb.getDb(), userId, 'box.clientSecret');
      if (!clientSecret) {
        sendJSON(res, 400, { error: { code: 'BOX_NO_SECRET', message: 'No Box client secret saved. Save one first.' } });
        return true;
      }
      const clientId    = typeof body.clientId === 'string' ? body.clientId.trim() : '';
      const subjectType = body.subjectType === 'user' ? 'user' : 'enterprise';
      const subjectId   = typeof body.subjectId === 'string' ? body.subjectId.trim() : '';
      const folderId    = typeof body.folderId === 'string' ? body.folderId.trim() : '';
      if (!clientId || !subjectId || !folderId) {
        sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'clientId, subjectId and folderId are required' } });
        return true;
      }
      const creds = { clientId, clientSecret, subjectType, subjectId, folderId };
      if (url === '/kb/box/test') {
        try {
          const r = await boxTest(creds);
          logger.info('box_test', { userId, folderId });
          sendJSON(res, 200, r);
        } catch (e) {
          logger.error('box_test_failed', { userId, folderId, reason: e.message });
          sendJSON(res, 502, { error: { code: 'BOX_CONNECT_FAILED', message: redactSecrets(e.message) } });
        }
        return true;
      }
      // url === '/kb/connect-box'
      const started = Date.now();
      try {
        const { indexed, skipped } = await indexBoxFolder(userId, creds);
        logger.info('box_index', { userId, folderId, indexed, skipped, durationMs: Date.now() - started });
        sendJSON(res, 200, { ok: true, indexed, skipped });
      } catch (e) {
        logger.error('box_index_failed', { userId, folderId, reason: e.message });
        sendJSON(res, 502, { error: { code: 'BOX_INDEX_FAILED', message: redactSecrets(e.message) } });
      }
      return true;
    }
```
Confirm `redactSecrets` is imported in router.mjs (grep; if absent, add `import { redactSecrets } from '../core/redact-secrets.mjs';`).

- [ ] **Step 5: Register the endpoints**

In `extension/server.mjs`, add to the ENDPOINTS array (near the slack entries):
```js
  '/kb/box/test',
  '/kb/connect-box',
```
`/kb/connect-box` auto-buckets to `kbWrite`; add `/kb/box/test` to the `dispatch` rate-limit line (mirror the slack `url === '/kb/slack/test'` clause at ~server.mjs:165):
```js
  if (url === '/kb/box/test') return 'dispatch';
```

- [ ] **Step 6: Document the endpoints in openapi**

In `docs/reference/api/openapi.yaml`, add two `paths:` entries mirroring `/kb/connect-git` (:1196):
```yaml
  /kb/box/test:
    post:
      summary: Verify Box credentials and folder access
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [clientId, subjectId, folderId]
              properties:
                clientId:    { type: string }
                subjectType: { type: string, enum: [enterprise, user], default: enterprise }
                subjectId:   { type: string }
                folderId:    { type: string }
      responses:
        '200': { description: Folder info, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, folderName: { type: string }, itemCount: { type: integer } } } } } }
        '400': { description: Missing secret or fields, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
        '502': { description: Box connect failed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
  /kb/connect-box:
    post:
      summary: Index a Box folder's documents into the KB
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [clientId, subjectId, folderId]
              properties:
                clientId:    { type: string }
                subjectType: { type: string, enum: [enterprise, user], default: enterprise }
                subjectId:   { type: string }
                folderId:    { type: string }
      responses:
        '200': { description: Indexing summary, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, indexed: { type: integer }, skipped: { type: integer } } } } } }
        '400': { description: Missing secret or fields, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
        '502': { description: Box index failed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
```

- [ ] **Step 7: Run route tests + docs-check + full suite**

Run: `cd extension && node --test tests/box-routes.test.mjs` → pass.
Run: `cd /Users/dinsmallade/llm-ide && make docs-check` → OK (api-coverage passes with the new endpoints documented).
Run: `cd extension && npm test` → full suite green.

- [ ] **Step 8: Commit**

```bash
git add extension/server/vault.mjs extension/kb/router.mjs extension/server.mjs extension/connectors/box.mjs docs/reference/api/openapi.yaml extension/tests/box-routes.test.mjs
git commit -m "feat(server): /kb/box/test + /kb/connect-box routes + box.clientSecret vault key"
```

---

### Task 3: Mac `SavedBoxSource` model + persistence

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift`
- Test: `mac/Tests/LlmIdeMacTests/SavedBoxSourceTests.swift`

**Interfaces:**
- Produces: `struct SavedBoxSource: Codable, Equatable` + `AppConfig.boxSource: SavedBoxSource?` (persisted to UserDefaults key `"boxSource"`).

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SavedBoxSourceTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("SavedBoxSource persistence")
struct SavedBoxSourceTests {
    @Test func boxSourceRoundTripsThroughUserDefaults() {
        let name = "box-src-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let cfg = AppConfig(userDefaults: d)
        var s = SavedBoxSource()
        s.displayName = "Docs"; s.clientId = "cid"; s.subjectType = "enterprise"
        s.subjectId = "42"; s.folderId = "F1"; s.enabled = true
        cfg.boxSource = s
        let reloaded = AppConfig(userDefaults: d)
        #expect(reloaded.boxSource?.clientId == "cid")
        #expect(reloaded.boxSource?.folderId == "F1")
        #expect(reloaded.boxSource?.subjectType == "enterprise")
    }

    @Test func absentBoxSourceIsNil() {
        let name = "box-src-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        #expect(AppConfig(userDefaults: d).boxSource == nil)
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mac && swift test --filter SavedBoxSourceTests`
Expected: FAIL — `SavedBoxSource` / `boxSource` don't exist.

- [ ] **Step 3: Add the struct** (`Config.swift`, near `SavedSlackSource` ~line 100)

```swift
struct SavedBoxSource: Codable, Equatable {
    var displayName: String = ""
    var clientId: String = ""
    var subjectType: String = "enterprise"   // "enterprise" | "user"
    var subjectId: String = ""
    var folderId: String = ""
    var folderName: String = ""
    var enabled: Bool = true

    init() {}

    /// Tolerant decoder — every field falls back to its default when absent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        clientId    = try c.decodeIfPresent(String.self, forKey: .clientId) ?? ""
        subjectType = try c.decodeIfPresent(String.self, forKey: .subjectType) ?? "enterprise"
        subjectId   = try c.decodeIfPresent(String.self, forKey: .subjectId) ?? ""
        folderId    = try c.decodeIfPresent(String.self, forKey: .folderId) ?? ""
        folderName  = try c.decodeIfPresent(String.self, forKey: .folderName) ?? ""
        enabled     = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}
```

- [ ] **Step 4: Add the published property** (`Config.swift`, near `slackSource` ~line 280)

```swift
    @Published var boxSource: SavedBoxSource? {
        didSet {
            if let s = boxSource, let data = try? AppJSON.encoder.encode(s) {
                defaults.set(data, forKey: "boxSource")
            } else {
                defaults.removeObject(forKey: "boxSource")
            }
        }
    }
```

- [ ] **Step 5: Add the init decode** (`Config.swift`, near the `slackSource` decode ~line 572)

```swift
        if let data = defaults.data(forKey: "boxSource"),
           let decoded = decodeConfigOrStash(SavedBoxSource.self, key: "boxSource", data: data, defaults: defaults) {
            self.boxSource = decoded
        } else {
            self.boxSource = nil
        }
```

- [ ] **Step 6: Run tests + build**

Run: `cd mac && swift test --filter SavedBoxSourceTests` → pass.
Run: `cd mac && swift build` → clean.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Config.swift mac/Tests/LlmIdeMacTests/SavedBoxSourceTests.swift
git commit -m "feat(mac): SavedBoxSource model + persistence"
```

---

### Task 4: Mac API client + Box source sheet + Sources card

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Box.swift`
- Create: `mac/Sources/LlmIdeMac/Views/Sources/BoxSourceSheet.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` (add `boxCard` + `.sheet`)
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/InputSourceRegistry.swift` (remove the `documents` stub)

**Interfaces:**
- Consumes: `AppConfig.boxSource`, the shared `setSecret(key:value:)` (in `+Email.swift`), the generic `post(_:body:authenticated:)`.
- Produces: `LlmIdeAPIClient.testBox()`, `LlmIdeAPIClient.connectBox()`.

- [ ] **Step 1: Add the API client extension**

Create `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Box.swift`:

```swift
import Foundation

extension LlmIdeAPIClient {
    struct BoxTestResult: Decodable { let ok: Bool; let folderName: String; let itemCount: Int }
    struct BoxIndexResult: Decodable { let ok: Bool; let indexed: Int; let skipped: Int }

    private struct BoxReq: Encodable {
        let clientId: String; let subjectType: String; let subjectId: String; let folderId: String
    }

    func testBox(clientId: String, subjectType: String, subjectId: String, folderId: String) async throws -> BoxTestResult {
        try await post("/kb/box/test",
                       body: BoxReq(clientId: clientId, subjectType: subjectType, subjectId: subjectId, folderId: folderId),
                       authenticated: true)
    }

    func connectBox(clientId: String, subjectType: String, subjectId: String, folderId: String) async throws -> BoxIndexResult {
        try await post("/kb/connect-box",
                       body: BoxReq(clientId: clientId, subjectType: subjectType, subjectId: subjectId, folderId: folderId),
                       authenticated: true)
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build` → clean.

- [ ] **Step 3: Create the config sheet**

Create `mac/Sources/LlmIdeMac/Views/Sources/BoxSourceSheet.swift`, mirroring `SlackSourceSheet.swift`'s structure and save flow: a `@State var draft: SavedBoxSource` seeded from `config.boxSource`; a `@State var clientSecret` field; text fields for displayName, clientId, subjectId, folderId; a `subjectType` picker (`enterprise`/`user`); a "Save & verify" button whose action:
```swift
    private func save() async {
        if !clientSecret.isEmpty {
            do { try await api.setSecret(key: "box.clientSecret", value: clientSecret) }
            catch { testWasError = true; testStatus = "Couldn't save secret: \(error.localizedDescription)"; return }
        }
        do {
            let r = try await api.testBox(clientId: draft.clientId, subjectType: draft.subjectType, subjectId: draft.subjectId, folderId: draft.folderId)
            draft.folderName = r.folderName
        } catch { testWasError = true; testStatus = "Verify failed: \(error.localizedDescription)"; return }
        config.boxSource = draft
        dismiss()
    }

    private func disconnect() async {
        do { try await api.setSecret(key: "box.clientSecret", value: "") }
        catch { testWasError = true; testStatus = "Couldn't remove the secret: \(error.localizedDescription)"; return }
        config.boxSource = nil
        dismiss()
    }
```
Match `SlackSourceSheet`'s `init(api:)`, `@EnvironmentObject` (theme, config), and layout idioms. (Read `SlackSourceSheet.swift` and follow it closely.)

- [ ] **Step 4: Add the `boxCard` + sheet to the Sources view**

In `ConnectionsSettingsSection.swift`: add a `@State private var showBoxSheet = false`; add a `boxCard` computed property mirroring `slackCard` (icon `"doc.text"`, title "Box", subtitle "Index documents from a Box folder"; badge from `config.boxSource` configured/enabled; a "Configure…/Edit…" button setting `showBoxSheet = true`, and when configured a "Re-sync" button running `Task { try? await api.connectBox(clientId:…, subjectType:…, subjectId:…, folderId:…) }` from `config.boxSource`). Render `boxCard` next to `slackCard` (~line 54). Attach the sheet next to the slack `.sheet` (~line 69):
```swift
                .sheet(isPresented: $showBoxSheet) {
                    BoxSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                }
```

- [ ] **Step 5: Remove the `documents` planned stub**

In `InputSourceRegistry.swift`, delete the `.init(id: "documents", …)` entry from `planned` (Box now supersedes it). Leave `calendar`.

- [ ] **Step 6: Build + full suite**

Run: `cd mac && swift build` → clean.
Run: `cd mac && swift test` → all pass.

- [ ] **Step 7: Manual verification (controller/human)**

Not automatable here: in Settings → Sources, the Box card appears (not "Documents — coming soon"); "Configure…" opens the sheet; entering CCG creds + folder id + "Save & verify" stores the secret and verifies; "Re-sync" calls `/kb/connect-box`.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Box.swift mac/Sources/LlmIdeMac/Views/Sources/BoxSourceSheet.swift mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift mac/Sources/LlmIdeMac/Views/Sources/InputSourceRegistry.swift
git commit -m "feat(mac): Box source sheet, API client, and Sources card"
```

---

## Self-Review

**Spec coverage:**
- §Auth CCG → Task 1 (`buildTokenForm`/`exchangeCCGToken`). ✓
- §Connector (list → extracted_text → chunk → delete+ingest, ref `box:<folderId>:<fileId>`, caps) → Task 1. ✓
- §Routes `/kb/box/test` + `/kb/connect-box` + vault key + registration + openapi → Task 2. ✓
- §Storage (`sources` kind='doc', no migration) → Task 1 (ingestSources) + Task 2 (no schema change). ✓
- §Mac model/API/UI + promote documents stub → Tasks 3, 4. ✓
- §Skip-and-log unsupported files → Task 1 (`fetchExtractedText` returns null → skipped++). ✓
- §Wholesale re-index → Task 1 (`deleteSourcesByPrefix` before `ingestSources`). ✓
- §Testing (pure helpers + mock-fetch integration + routes + Mac persistence) → Tasks 1–4. ✓

**Placeholder scan:** Task 2 Step 3 ships a deliberately-stubbed test skeleton BUT explicitly instructs the implementer to replace it using the real route-test harness from a sibling file (named via grep) and forbids shipping the `assert.ok(true)` stub — this is a "wire to the existing harness" instruction, not a vague placeholder, because the exact request-harness helper varies and must be reused verbatim rather than reinvented. Task 4 Steps 3–4 reference `SlackSourceSheet.swift`/`slackCard` as the pattern to mirror with the concrete save/disconnect code given inline. No "add error handling"-style placeholders.

**Type consistency:** connector exports (`buildTokenForm`, `exchangeCCGToken`, `parseFolderItems`, `fetchExtractedText`, `toSourceRows`, `indexBoxFolder`, `boxTest`), the `creds` shape `{clientId, clientSecret, subjectType, subjectId, folderId}`, the `ref` format `box:<folderId>:<fileId>`, vault key `box.clientSecret`, and the route response shapes (`{folderName,itemCount}` / `{indexed,skipped}`) are consistent across tasks, tests, and the Mac client (`BoxTestResult`/`BoxIndexResult`).
