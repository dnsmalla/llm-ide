# MCP-Backed Connectors — Phase 2a (MCP client + VaultOAuthProvider + OAuth routes + test endpoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM-IDE becomes an MCP *client*. A user can connect Miro through its official remote MCP server (`https://mcp.miro.com`) — OAuth 2.1 + PKCE + dynamic client registration, tokens in the per-user encrypted vault — and a `test` endpoint proves an authenticated round trip (connect + `tools/list`). No fetch pipeline, no Mac UI, no Google: those are phases 2b and 3.

**Architecture:** Two new `connectors/` modules — a declarative descriptor table (`mcp-connector-defs.mjs`) and a generic SDK wrapper (`mcp-client.mjs`) holding `VaultOAuthProvider`, the OAuth-flow state map, and per-call session helpers. Three `/auth/mcp-connector/*` routes mirroring the Slack shape, plus one `/kb/mcp-connector/test` route mirroring `/kb/slack/test`. Every test runs against an in-process `node:http` fixture on `127.0.0.1:0` that plays both the OAuth authorization server and the MCP resource server — no network, no real Miro.

**Tech Stack:** Node 20+ ESM, `node:test`, `@modelcontextprotocol/sdk@1.30.0`, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-22-mcp-backed-connectors-design.md` (Architecture + Risks + "Phase 2a" apply to every task)

---

## Verified ground truth (do not re-derive; do not contradict)

These were checked against the installed tree, and several of them **correct the design doc**. Read this section before Task 1.

**1 · SDK import specifiers.** `@modelcontextprotocol/sdk@1.30.0`'s `exports` map has `"."`, `"./client"`, `"./server"`, `"./validation"`, `"./experimental"` **and a `"./*"` wildcard → `./dist/esm/*`**. The bare `"./client"` subpath exports only `Client` and `getSupportedElicitationModes` — *not* the transport. Use the wildcard form, which is also what the repo's existing tests already use (`tests/agent-v2-tools.test.mjs:16`):

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
```

Never write `@modelcontextprotocol/sdk/dist/esm/...` — that bypasses the exports map.

**2 · The real `OAuthClientProvider`** (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts:15`). Required: `get redirectUrl()`, `get clientMetadata()`, `clientInformation()`, `tokens()`, `saveTokens(tokens)`, `redirectToAuthorization(authorizationUrl: URL)`, `saveCodeVerifier(v)`, `codeVerifier()`. Optional and used by this plan: `state?()`, `saveClientInformation?(ci)`, `invalidateCredentials?(scope: 'all'|'client'|'tokens'|'verifier'|'discovery')`, `saveDiscoveryState?(state)`, `discoveryState?()`. Note the design doc's table omits `state()` and `saveDiscoveryState()` — both are load-bearing here.

**3 · Hook call order inside `auth()`** (`client/auth.js:164-311`), which the whole issuer-scoping design depends on:

```
discoveryState?()  →  discovery  →  saveDiscoveryState?()  →  clientInformation()
  →  [registerClient → saveClientInformation()]  →  tokens()
  →  [refresh → saveTokens()]  →  state?()  →  saveCodeVerifier()  →  redirectToAuthorization()
```

`saveDiscoveryState()` always runs **before** `clientInformation()`. But `tokens()` is *also* called by the transport at header-construction time (`client/streamableHttp.js:62`), **before any discovery**, so the vault key namespace must be resolvable with zero network. That constraint drives the trust-on-first-use scheme in Task 4.

**We deliberately do NOT implement `discoveryState()`.** Returning cached discovery would require knowing the issuer before we know the issuer. Ingestion runs on a timer; two extra well-known GETs per re-auth are free, and only on the cold/expired path (verified: the warm path issues no discovery requests at all).

**4 · `finishAuth` takes a code string, not searchParams.** `finishAuth(authorizationCode: string): Promise<void>` (`client/streamableHttp.d.ts:139`). The design doc's `transport.finishAuth(searchParams)` is wrong. It works on a **never-started** transport (it only calls `auth()`), which is exactly what the callback route needs.

**5 · The fresh-transport rule is real.** Verified by running it: after `finishAuth`, calling `client.connect(sameTransport)` throws `StreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.` A fresh `StreamableHTTPClientTransport` connects fine.

**6 · Vault keys need NO change to `MCP_CREDENTIAL_KEY_RE`.** The pattern is `/^mcp\.[a-z][a-z0-9-]{1,40}\.[a-zA-Z]{1,32}$/` (`server/vault.mjs:176`). Verified accepted: `mcp.miro-eb640f905ca9.tokens`, `.clientInformation`, `.codeVerifier`, and `mcp.miro.issuer`. Do not touch `ALLOWED_KEYS` or the regex.

**7 · ESLint boundaries** (`eslint.config.mjs:99`): `connectors/**/*.mjs` → `allowOnly('core','kb','server','providers')`. Restrictions are anchored to **relative** specifiers only (`REL` at :21), so npm packages are unrestricted. `../server/vault.mjs` and `../core/config.mjs` are legal; `../mcp/`, `../plugins/`, `../agents/`, `../routes/` are not. `npm run lint` does **not** cover `tests/`.

**8 · `/auth/*` routes are excluded from `ENDPOINTS`** — no `SERVER_API_VERSION` bump for Tasks 5. But `/kb/mcp-connector/test` (Task 6) **does** follow the normal endpoint rules, all four of them:
- add to the `ENDPOINTS` array (`server.mjs:96`),
- bump `SERVER_API_VERSION` 37 → 38 with a comment in the running log (`server.mjs:33-95`) — "Bump version when wire format changes" (CLAUDE.md:183, invariants.md:188),
- add a rate-limit bucket line — every external-API `test` route uses `dispatch` (`server.mjs:254/260/265`); without a line it gets no bucket at all,
- do **not** add it to `REQUIRED_ENDPOINTS` (`src/sidepanel/App.tsx:61`) — that list is the Chrome side panel's staleness probe and contains no connector routes, and do **not** raise `minimumServerApiVersion` in `mac/.../BackendManager.swift:545`, whose own comment says it is "NOT for a merely added endpoint".

**9 · Route/test conventions to mirror:** `connectors/slack-oauth.mjs` (the ~70-LOC state-map + TTL-sweep + single-use `takeStatus` shape), `server/auth-routes.mjs` (slack callback :431 public, start :578, status :593; helpers `send`/`readJson`/`safeAudit`/`publicMessageFor`/`oauthCallbackHtml`; allow-list `isAuthRoute` :152-206), `server/auth.mjs:26` `PUBLIC_PATHS`, `tests/auth-routes.test.mjs:57-105` (`makeReq`/`makeRes`/`callAuth`/`registerAndLogin`), `tests/kb-router-slack.test.mjs:27-47` (router-level doubles).

**10 · No existing test binds a TCP port.** Task 3 introduces the first. It binds `127.0.0.1:0` only. (On this machine the agent sandbox denies `listen`; the normal test runner does not.)

---

## Global Constraints

- **Hermetic tests, always.** No test may resolve or contact `mcp.miro.com`, `accounts.google.com`, or anything else off-loopback. The fixture in Task 3 is the only server any test talks to.
- Connections are **per call, never pooled** (spec: "a pooled long-lived session buys nothing but lifecycle bugs"). Every helper opens, runs, and closes.
- **Credentials are scoped by connector id AND authorization-server issuer.** A client registered with one authorization server must never be presented to another. Task 4 enforces this structurally through the vault key, not by convention.
- `redirectToAuthorization` **cannot redirect** — there is no user agent on this side of the call. It captures the URL on the provider instance; the start route returns it to the Mac app, which opens it.
- After `finishAuth`, always build a **fresh transport**.
- Phase 2a adds **no** fetch/seen/classify endpoints, **no** Mac code, **no** `pipelineReady` flip, **no** Google descriptors.
- Every task ends green: `cd extension && node --test tests/<file> && npm run lint`.

---

### Task 1: Promote `@modelcontextprotocol/sdk` to a declared, exact-pinned runtime dependency (DONE — commit a49c93e)

> **Already committed.** The `package.json` + `package-lock.json` edit landed in commit `a49c93e`; only the guard test `extension/tests/dependency-pins.test.mjs` (Step 1) remains to be written. Step 3 is a no-op — confirm the file matches rather than editing it. For Step 2's "verify fail", the working tree is already correct, so prove the guard against the pre-`a49c93e` state instead: `git show a49c93e~1:extension/package.json | grep modelcontextprotocol` returns nothing.

**Files:**
- Modify: `extension/package.json` (`dependencies`, after `@anthropic-ai/claude-agent-sdk`), `extension/package-lock.json`
- Test: `extension/tests/dependency-pins.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a guaranteed-present `@modelcontextprotocol/sdk` at an exact version. Tasks 3–4 import it directly; without this it is only a transitive dep of `@anthropic-ai/claude-agent-sdk` and vanishes on an unrelated upgrade (spec Risks: "Transitive dependency").

- [ ] **Step 1: Write failing test** — create `extension/tests/dependency-pins.test.mjs`:

```js
// Guards the dependency-pinning invariants that are easy to lose in an
// unrelated `npm install`. Currently one entry: the MCP SDK, which
// connectors/mcp-client.mjs imports directly. Before this test it arrived
// only as a transitive dependency of @anthropic-ai/claude-agent-sdk — an
// upgrade there could have deleted it from node_modules and broken every
// MCP-backed connector with a MODULE_NOT_FOUND at request time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const SDK = '@modelcontextprotocol/sdk';

test('the MCP SDK is a declared RUNTIME dependency, not a dev or transitive one', () => {
  assert.ok(pkg.dependencies?.[SDK], `${SDK} must be in "dependencies"`);
  assert.equal(pkg.devDependencies?.[SDK], undefined,
    `${SDK} must not also be a devDependency`);
});

test('the MCP SDK is pinned exactly (no ^ or ~)', () => {
  assert.match(pkg.dependencies[SDK], /^\d+\.\d+\.\d+$/,
    'protocol code must not float across minor versions');
});

test('the pin matches what is installed on disk', () => {
  const installed = JSON.parse(
    readFileSync(path.join(root, 'node_modules', SDK, 'package.json'), 'utf8'),
  ).version;
  assert.equal(pkg.dependencies[SDK], installed);
});

test('the lockfile records it as a root dependency', () => {
  const rootEntry = lock.packages?.[''];
  assert.ok(rootEntry?.dependencies?.[SDK],
    'package-lock.json root entry must list the SDK — run `npm install` after editing package.json');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/dependency-pins.test.mjs`

Expected: PASS immediately, because the dependency edit is already committed (`a49c93e`). Prove the guard is real before trusting it:

```bash
git show a49c93e~1:extension/package.json | grep modelcontextprotocol   # must be EMPTY
```

- [ ] **Step 3: Implement** — no-op. Confirm `extension/package.json` `dependencies` contains, immediately after `"@anthropic-ai/claude-agent-sdk"`:

```json
    "@modelcontextprotocol/sdk": "1.30.0",
```

Exact, no caret: this is protocol code with storage hooks we implement against a specific interface. The lockfile already records it as a root dependency; its diff dropped `"peer": true` from `@modelcontextprotocol/sdk`, `@hono/node-server`, `ajv`, and `json-schema-traverse` — they are now direct/transitive-of-direct rather than peer-only. No version changes.

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/dependency-pins.test.mjs && npm run lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add extension/tests/dependency-pins.test.mjs
git commit -m "test(extension): guard the MCP SDK runtime dependency pin"
```

---

### Task 2: Connector descriptors

**Files:**
- Create: `extension/connectors/mcp-connector-defs.mjs`
- Test: `extension/tests/mcp-connector-defs.test.mjs` (create)

**Interfaces:**
- Consumes: nothing (deliberately — this file must stay a pure data module).
- Produces:
  - `MCP_CONNECTOR_DEFS` — frozen array of `{ id, name, serverUrl, scope, byoClient, clientName, byoClientIdKey, byoClientSecretKey, listTool, readTool, mapItem }`
  - `MCP_CONNECTOR_IDS` — frozen id array
  - `mcpConnectorDef(id) -> def | null`, applying the loopback/https server-URL override
  - Task 4 reads `serverUrl`/`scope`/`byoClient`/`clientName`; Tasks 5–6 resolve ids through `mcpConnectorDef`; Tasks 3–6 tests use the override to point `miro` at the fixture.

- [ ] **Step 1: Write failing tests** — create `extension/tests/mcp-connector-defs.test.mjs`:

```js
// Tests for extension/connectors/mcp-connector-defs.mjs — the declarative
// per-connector table. Phase 2a ships Miro only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_CONNECTOR_DEFS, MCP_CONNECTOR_IDS, mcpConnectorDef,
} from '../connectors/mcp-connector-defs.mjs';

test('phase 2a ships exactly one connector: Miro', () => {
  assert.deepEqual([...MCP_CONNECTOR_IDS], ['miro']);
  assert.equal(MCP_CONNECTOR_DEFS.length, 1);
});

test('every descriptor is complete and points at an https server', () => {
  for (const d of MCP_CONNECTOR_DEFS) {
    assert.match(d.id, /^[a-z][a-z0-9-]{1,20}$/, `bad id: ${d.id}`);
    assert.equal(typeof d.name, 'string');
    assert.ok(d.name.length > 0);
    assert.match(d.serverUrl, /^https:\/\//, `${d.id} must ship an https server URL`);
    assert.equal(typeof d.scope, 'string');
    assert.equal(typeof d.byoClient, 'boolean');
    assert.equal(typeof d.clientName, 'string');
    // Vault-key names must satisfy server/vault.mjs MCP_CREDENTIAL_KEY_RE.
    for (const k of [d.byoClientIdKey, d.byoClientSecretKey]) {
      assert.match(k, /^mcp\.[a-z][a-z0-9-]{1,40}\.[a-zA-Z]{1,32}$/, `bad vault key: ${k}`);
    }
    // Phase 2b fills these; they must exist as nulls so the shape is stable.
    assert.ok('listTool' in d && 'readTool' in d && 'mapItem' in d);
  }
});

test('Miro uses dynamic client registration — no operator setup', () => {
  const miro = mcpConnectorDef('miro');
  assert.equal(miro.byoClient, false);
  assert.equal(miro.serverUrl, 'https://mcp.miro.com');
});

test('unknown ids return null', () => {
  assert.equal(mcpConnectorDef('gdrive'), null);   // phase 3
  assert.equal(mcpConnectorDef('nope'), null);
  assert.equal(mcpConnectorDef(''), null);
  assert.equal(mcpConnectorDef(undefined), null);
});

test('the server-URL override is read per call, not at import time', () => {
  // Tests start an ephemeral fixture and only then know its port, so the
  // override MUST NOT be captured when this module was first imported.
  process.env.LLMIDE_MCP_MIRO_URL = 'http://127.0.0.1:59999/mcp';
  try {
    assert.equal(mcpConnectorDef('miro').serverUrl, 'http://127.0.0.1:59999/mcp');
  } finally {
    delete process.env.LLMIDE_MCP_MIRO_URL;
  }
  assert.equal(mcpConnectorDef('miro').serverUrl, 'https://mcp.miro.com');
});

test('the override accepts https anywhere and http only on loopback', () => {
  const cases = [
    ['https://staging.example.com/mcp', 'https://staging.example.com/mcp'],
    ['http://localhost:4000/mcp',       'http://localhost:4000/mcp'],
    ['http://[::1]:4000/mcp',           'http://[::1]:4000/mcp'],
    // Rejected → fall back to the shipped URL. A typo'd or hostile env var
    // must never turn a connector into an SSRF primitive against the LAN.
    ['http://192.168.1.10/mcp',         'https://mcp.miro.com'],
    ['http://evil.example.com/mcp',     'https://mcp.miro.com'],
    ['file:///etc/passwd',              'https://mcp.miro.com'],
    ['not a url',                       'https://mcp.miro.com'],
  ];
  for (const [raw, expected] of cases) {
    process.env.LLMIDE_MCP_MIRO_URL = raw;
    try {
      assert.equal(mcpConnectorDef('miro').serverUrl, expected, `override: ${raw}`);
    } finally {
      delete process.env.LLMIDE_MCP_MIRO_URL;
    }
  }
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/mcp-connector-defs.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `extension/connectors/mcp-connector-defs.mjs`:

```js
// Declarative descriptors for the MCP-backed ingestion connectors.
//
// Everything provider-specific lives here: where the server is, what scope to
// ask for, whether the operator must bring their own OAuth client, and (from
// phase 2b) which tool lists candidates, which tool reads one item, and how a
// tool result maps to { fields, body } for the inbox writer.
// connectors/mcp-client.mjs is entirely generic — it reads these fields and
// branches on nothing else. Adding a fourth MCP-backed connector should be an
// entry in this array plus a Mac manifest, and nothing else.
//
// Deliberately dependency-free: no vault, no config, no SDK. It is data.
//
// Phase 2a ships Miro alone. Miro supports RFC 7591 dynamic client
// registration, so there is zero operator setup — which is precisely why it
// goes first: it exercises discovery → DCR → PKCE → token → tools/list with
// nothing to configure. Phase 3 adds the Google pair, both byoClient: true
// because Google registers redirect URIs per client and offers no DCR:
//
//   Object.freeze({
//     id: 'gdrive', name: 'Google Drive',
//     serverUrl: 'https://drivemcp.googleapis.com/mcp/v1',
//     scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
//     byoClient: true, clientName: CLIENT_NAME,
//     byoClientIdKey: 'mcp.gdrive.byoClientId',
//     byoClientSecretKey: 'mcp.gdrive.byoClientSecret',
//     listTool: 'search_files', readTool: 'read_file_content', mapItem: mapDriveFile,
//   }),
//
// byoClientIdKey / byoClientSecretKey name vault entries, so they must satisfy
// server/vault.mjs's MCP_CREDENTIAL_KEY_RE (`mcp.<slug>.<field>`). They are
// NOT issuer-scoped like the runtime credentials in mcp-client.mjs: an
// operator-provisioned client belongs to the descriptor, not to a discovered
// authorization server.

const CLIENT_NAME = 'LLM-IDE';

export const MCP_CONNECTOR_DEFS = Object.freeze([
  Object.freeze({
    id: 'miro',
    name: 'Miro',
    serverUrl: 'https://mcp.miro.com',
    // Requested scope. When the server advertises `scopes_supported` in its
    // RFC 9728 protected-resource metadata the SDK prefers that (SEP-835);
    // this is the fallback for servers that advertise nothing.
    scope: 'boards:read',
    byoClient: false,               // dynamic client registration
    clientName: CLIENT_NAME,
    byoClientIdKey: 'mcp.miro.byoClientId',
    byoClientSecretKey: 'mcp.miro.byoClientSecret',
    // Phase 2b: the fetch pipeline.
    listTool: null,
    readTool: null,
    mapItem: null,
  }),
]);

export const MCP_CONNECTOR_IDS = Object.freeze(MCP_CONNECTOR_DEFS.map((d) => d.id));

// Test/staging seam: LLMIDE_MCP_<ID>_URL repoints one connector's server
// without a code change. Read on EVERY call, never memoised — tests start an
// ephemeral fixture on port 0 and can only set the variable afterwards.
//
// Only https (any host) or http on the loopback interface is honoured. An
// operator who can set our environment has already won, but this keeps a
// typo from aiming an authenticated connector at an arbitrary LAN host.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function overrideServerUrl(id) {
  const raw = process.env[`LLMIDE_MCP_${id.toUpperCase().replace(/-/g, '_')}_URL`];
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u.toString();
  return null;
}

/** The descriptor for `id` with any server-URL override applied, or null. */
export function mcpConnectorDef(id) {
  if (typeof id !== 'string' || !id) return null;
  const base = MCP_CONNECTOR_DEFS.find((d) => d.id === id);
  if (!base) return null;
  const override = overrideServerUrl(base.id);
  return override ? Object.freeze({ ...base, serverUrl: override }) : base;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/mcp-connector-defs.test.mjs && npm run lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add extension/connectors/mcp-connector-defs.mjs extension/tests/mcp-connector-defs.test.mjs
git commit -m "feat(connectors): declarative MCP connector descriptors (Miro)"
```

---

### Task 3: The hermetic remote-MCP + OAuth test fixture

This is the load-bearing task. Everything in Tasks 4–6 is tested against it, so it lands first and gets its own self-test — a failure here must be diagnosable without also suspecting `mcp-client.mjs`.

**Why an in-process HTTP server rather than a stubbed `fetch` or an injected transport.** The thing under test *is* the SDK's OAuth state machine: RFC 9728 discovery → RFC 8414 metadata → RFC 7591 registration → PKCE-S256 → the 401/`WWW-Authenticate` re-auth trigger. Stubbing `global.fetch` (the pattern `tests/slack-oauth-routes.test.mjs:71` uses for Slack's single token POST) would mean hand-writing responses for six endpoints in a strict order and would silently pass if we later got the *order* wrong. Injecting a fake transport would test nothing at all — the transport is where the 401 handling lives. A real socket on `127.0.0.1:0` costs ~10 ms and exercises the genuine code path. Hermeticity comes from the ephemeral loopback port, not from avoiding sockets.

**Why the MCP half is the SDK's own server.** `McpServer` + `StreamableHTTPServerTransport` means we do not re-derive session headers, `Accept` negotiation, SSE-vs-JSON response selection, or JSON-RPC framing. Only the OAuth half is hand-written, because that is the part under test. A fresh `McpServer` + transport is built **per request** in stateless mode — this is not stylistic: with one shared instance the second client's `notifications/initialized` POST returns 500 (observed).

**Files:**
- Create: `extension/tests/fixtures/fake-mcp-oauth-server.mjs`
- Test: `extension/tests/fake-mcp-oauth-server.test.mjs` (create)

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/server/mcp.js`, `.../server/streamableHttp.js` (Task 1's pin).
- Produces `startFakeMcpServer(opts) -> handle`, where `handle` is:
  - `url` (`http://127.0.0.1:<port>/mcp`), `origin`, `port`, `issuer`
  - `requests: string[]` — `"GET /token"`-style log; the only way to assert "the warm path made no OAuth calls"
  - `registrations: object[]` — client metadata bodies posted to `/register`
  - `tokenRequests: object[]` — decoded form bodies posted to `/token`
  - `authorize(url) -> { code, state, redirectUri }` — stands in for the user's browser
  - `revokeAccessTokens()`, `setIssuerPath(p)`, `clearLog()`, `close()`

- [ ] **Step 1: Write the failing self-test** — create `extension/tests/fake-mcp-oauth-server.test.mjs`:

```js
// Self-test for tests/fixtures/fake-mcp-oauth-server.mjs.
//
// Uses the raw SDK plus a throwaway in-memory OAuthClientProvider — NOT
// connectors/mcp-client.mjs. That separation is the point: when a test in
// mcp-client.test.mjs fails, this file tells you whether the fixture or the
// code under test broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { startFakeMcpServer } from './fixtures/fake-mcp-oauth-server.mjs';

const REDIRECT = 'http://127.0.0.1:3456/auth/mcp-connector/callback';

function memoryProvider() {
  const store = new Map();
  return {
    authorizationUrl: null,
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return {
        client_name: 'LLM-IDE', redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none',
        scope: 'boards:read',
      };
    },
    state() { return 'fixture-state'; },
    clientInformation() { return store.get('ci'); },
    saveClientInformation(ci) { store.set('ci', ci); },
    tokens() { return store.get('tok'); },
    saveTokens(t) { store.set('tok', t); },
    saveCodeVerifier(v) { store.set('cv', v); },
    codeVerifier() { return store.get('cv'); },
    redirectToAuthorization(u) { this.authorizationUrl = u.toString(); },
    saveDiscoveryState(ds) { store.set('issuer', ds.authorizationServerUrl); },
    _store: store,
  };
}

test('fixture: unauthenticated connect yields UnauthorizedError after DCR + PKCE', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const transport = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const client = new Client({ name: 'selftest', version: '1' });

  await assert.rejects(() => client.connect(transport), UnauthorizedError);
  await transport.close().catch(() => {});

  // The full discovery chain ran, in order.
  assert.ok(fake.requests.includes('GET /.well-known/oauth-protected-resource'));
  assert.ok(fake.requests.includes('GET /.well-known/oauth-authorization-server'));
  assert.equal(fake.registrations.length, 1, 'exactly one dynamic client registration');
  assert.deepEqual(fake.registrations[0].redirect_uris, [REDIRECT]);

  const authUrl = new URL(provider.authorizationUrl);
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('state'), 'fixture-state');
  assert.equal(authUrl.searchParams.get('redirect_uri'), REDIRECT);
  assert.match(authUrl.searchParams.get('client_id'), /^dcr-/);
  assert.equal(provider._store.get('issuer'), `${fake.origin}/`);
});

test('fixture: authorize() stands in for the browser and finishAuth mints tokens', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  await t1.close().catch(() => {});

  const { code, state } = await fake.authorize(provider.authorizationUrl);
  assert.match(code, /^code-/);
  assert.equal(state, 'fixture-state', 'the state parameter round-trips');

  // finishAuth works on a transport that was never started.
  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await t2.finishAuth(code);
  await t2.close().catch(() => {});

  assert.ok(provider.tokens()?.access_token, 'tokens persisted');
  const tokenReq = fake.tokenRequests.at(-1);
  assert.equal(tokenReq.grant_type, 'authorization_code');
  assert.ok(tokenReq.code_verifier, 'the fixture verifies PKCE, so a verifier was sent');
});

test('fixture: a started transport cannot be restarted — use a fresh one', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c1 = new Client({ name: 's', version: '1' });
  await assert.rejects(() => c1.connect(t1), UnauthorizedError);
  const { code } = await fake.authorize(provider.authorizationUrl);
  await t1.finishAuth(code);

  await assert.rejects(() => c1.connect(t1), /already started/);
  await t1.close().catch(() => {});

  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c2 = new Client({ name: 's', version: '1' });
  await c2.connect(t2);
  const { tools } = await c2.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['get_board_items', 'list_boards']);
  assert.deepEqual(c2.getServerVersion(), { name: 'fake-miro', version: '0.0.1' });
  await c2.close();
});

test('fixture: the warm path makes no OAuth requests at all', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  const { code } = await fake.authorize(provider.authorizationUrl);
  await t1.finishAuth(code);
  await t1.close().catch(() => {});

  fake.clearLog();
  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c2 = new Client({ name: 's', version: '1' });
  await c2.connect(t2);
  await c2.listTools();
  await c2.close();

  assert.ok(fake.requests.every((r) => r.endsWith(' /mcp')),
    `warm path must be /mcp only, saw: ${fake.requests.join(', ')}`);
});

test('fixture: revoked tokens trigger the SDK refresh-token path automatically', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  const { code } = await fake.authorize(provider.authorizationUrl);
  await t1.finishAuth(code);
  await t1.close().catch(() => {});

  fake.revokeAccessTokens();
  fake.clearLog();
  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c2 = new Client({ name: 's', version: '1' });
  await c2.connect(t2);          // 401 → discovery → refresh_token → retry
  await c2.close();
  assert.equal(fake.tokenRequests.at(-1).grant_type, 'refresh_token');
});

test('fixture: setIssuerPath moves the authorization server', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  fake.setIssuerPath('/as-b/');

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  await t1.close().catch(() => {});
  assert.equal(provider._store.get('issuer'), `${fake.origin}/as-b/`);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/fake-mcp-oauth-server.test.mjs`
Expected: FAIL — `tests/fixtures/fake-mcp-oauth-server.mjs` not found.

- [ ] **Step 3: Implement** — create `extension/tests/fixtures/fake-mcp-oauth-server.mjs`:

```js
// Hermetic remote-MCP fixture. One node:http server on 127.0.0.1:0 playing
// both roles a real remote MCP server plays:
//
//   * OAuth 2.1 authorization server — RFC 9728 protected-resource metadata,
//     RFC 8414 authorization-server metadata, RFC 7591 dynamic client
//     registration, an /authorize endpoint standing in for the browser
//     consent screen, and a /token endpoint that genuinely VERIFIES the
//     PKCE S256 challenge (so a code_verifier lost in the vault fails here,
//     loudly, instead of passing).
//
//   * MCP resource server — 401 + WWW-Authenticate until a Bearer token this
//     fixture minted arrives, then a real Streamable-HTTP MCP endpoint.
//
// The MCP half is the SDK's OWN server (McpServer + StreamableHTTPServerTransport)
// so protocol correctness is not something a fixture has to re-derive. Only
// the OAuth half is hand-written, because the OAuth half is what we test.
//
// A fresh McpServer + transport is built PER REQUEST (stateless mode). This is
// not a style choice: reusing one instance across connections makes the second
// client's notifications/initialized POST return 500.
//
// No test may reach the real mcp.miro.com. Everything here binds an ephemeral
// loopback port and speaks only to itself.

import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const DEFAULT_TOOLS = [
  { name: 'list_boards', description: 'List Miro boards', result: [{ id: 'b1', name: 'Board One' }] },
  { name: 'get_board_items', description: 'Read one board', result: [{ type: 'sticky_note', text: 'hello' }] },
];

const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

/**
 * Start the fixture. Always `await handle.close()` (use `t.after`).
 * @param {{ issuerPath?: string, tools?: Array<{name,description,result}> }} [opts]
 */
export async function startFakeMcpServer(opts = {}) {
  const tools = opts.tools || DEFAULT_TOOLS;
  let issuerPath = opts.issuerPath || '/';

  const codes = new Map();          // authorization code -> { challenge }
  const accessTokens = new Set();   // tokens this fixture minted
  const requests = [];
  const registrations = [];
  const tokenRequests = [];

  function buildMcpServer() {
    const mcp = new McpServer({ name: 'fake-miro', version: '0.0.1' });
    for (const t of tools) {
      mcp.registerTool(
        t.name,
        { description: t.description, inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: JSON.stringify(t.result) }] }),
      );
    }
    return mcp;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const origin = `http://${req.headers.host}`;
    const issuer = origin + issuerPath;
    requests.push(`${req.method} ${u.pathname}`);

    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const readBody = () => new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(b));
    });

    // RFC 9728 — which authorization server guards this resource? The SDK
    // probes both the path-aware and root forms, so match on the prefix.
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ['boards:read'],
      });
    }

    // RFC 8414 — authorization server metadata.
    if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(200, {
        issuer,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['boards:read'],
      });
    }

    // RFC 7591 — dynamic client registration (Miro's model: no BYO client).
    if (u.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse((await readBody()) || '{}');
      registrations.push(meta);
      return json(201, {
        ...meta,
        client_id: `dcr-${crypto.randomUUID()}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    }

    // The consent screen. Tests call handle.authorize() instead of a browser.
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      const code = `code-${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, { challenge: q.get('code_challenge') });
      const loc = new URL(q.get('redirect_uri'));
      loc.searchParams.set('code', code);
      if (q.get('state')) loc.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: loc.toString() });
      res.end();
      return;
    }

    // Token endpoint. PKCE is verified for real.
    if (u.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody());
      tokenRequests.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'authorization_code') {
        const rec = codes.get(p.get('code'));
        if (!rec) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
        if (s256(p.get('code_verifier') || '') !== rec.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        codes.delete(p.get('code'));       // single use
      } else if (p.get('grant_type') !== 'refresh_token') {
        return json(400, { error: 'unsupported_grant_type' });
      }
      const at = `at-${crypto.randomBytes(12).toString('hex')}`;
      accessTokens.add(at);
      return json(200, {
        access_token: at, token_type: 'Bearer', expires_in: 3600,
        refresh_token: 'rt-fixture', scope: 'boards:read',
      });
    }

    // The MCP endpoint, gated on a token this fixture minted. The 401 must
    // carry WWW-Authenticate with resource_metadata — that header is what
    // drives the SDK's re-auth path.
    if (u.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || !accessTokens.has(auth.slice(7))) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,   // stateless
        enableJsonResponse: true,
      });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      return transport.handleRequest(req, res);
    }

    return json(404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    url: `${origin}/mcp`,
    get issuer() { return origin + issuerPath; },
    requests,
    registrations,
    tokenRequests,

    /** Stand in for the user's browser: follow the authorization URL once. */
    async authorize(authorizationUrl) {
      const r = await fetch(String(authorizationUrl), { redirect: 'manual' });
      const location = r.headers.get('location');
      if (!location) throw new Error(`fixture /authorize did not redirect (status ${r.status})`);
      const loc = new URL(location);
      return {
        code: loc.searchParams.get('code'),
        state: loc.searchParams.get('state'),
        redirectUri: `${loc.origin}${loc.pathname}`,
      };
    },

    /** Invalidate every minted access token — the "session expired" case. */
    revokeAccessTokens() { accessTokens.clear(); },

    /** Move the authorization server; proves credentials are issuer-scoped. */
    setIssuerPath(p) { issuerPath = p; },

    clearLog() { requests.length = 0; },

    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/fake-mcp-oauth-server.test.mjs && npm run lint`
Expected: PASS (6 tests), lint clean. `npm run lint` does not cover `tests/`, so lint here only guards against a stray edit elsewhere.

- [ ] **Step 5: Commit**

```bash
git add extension/tests/fixtures/fake-mcp-oauth-server.mjs extension/tests/fake-mcp-oauth-server.test.mjs
git commit -m "test(connectors): hermetic remote-MCP + OAuth 2.1 fixture"
```

---

### Task 4: `mcp-client.mjs` — VaultOAuthProvider, flow state, session helpers

**Files:**
- Create: `extension/connectors/mcp-client.mjs`
- Test: `extension/tests/mcp-client.test.mjs` (create; DB/vault bootstrap modelled on `tests/kb-router-slack.test.mjs:10-26`)

**Interfaces:**
- Consumes: Task 2's descriptors (passed in, never imported — keeps this module generic), `server/vault.mjs` `getSecret`/`setSecret`, `core/config.mjs` `config.port`, Task 1's SDK.
- Produces (Tasks 5–6 consume):
  - `class VaultOAuthProvider` — exported for tests and for key-shape assertions
  - `mcpRedirectUri() -> string`
  - `startMcpAuthorization({ db, userId, def, stateToken }) -> { authorizationUrl, alreadyConnected }`
  - `finishMcpAuthorization({ db, userId, def, code }) -> { account }`
  - `isMcpConnected(db, userId, def) -> boolean`
  - `withMcpSession(db, userId, def, fn) -> any`
  - `testMcpConnection(db, userId, def) -> { server: { name, version }, tools: string[] }`
  - `putMcpState / getMcpState / completeMcpState / takeMcpStatus` (Slack-shaped state map)

**Vault key scheme — the one design decision worth stating plainly.**

The spec demands credentials be keyed by connector id **and issuer**, because a client registered with one authorization server must never be presented to another. But `tokens()` is called by the transport before any discovery has happened, so the key namespace has to be computable with zero network. The resolution is trust-on-first-use with automatic rebinding:

| Key | Scope | Written by |
|---|---|---|
| `mcp.<id>.issuer` | connector only | `saveDiscoveryState()` — the last discovered `authorizationServerUrl` |
| `mcp.<id>-<tag>.clientInformation` | connector **+ issuer** | DCR, or the BYO pair |
| `mcp.<id>-<tag>.tokens` | connector **+ issuer** | `saveTokens()` |
| `mcp.<id>-<tag>.codeVerifier` | connector **+ issuer** | `saveCodeVerifier()` |

`<tag>` is the first 12 hex of `sha256(boundIssuer)`. `boundIssuer` initialises from `mcp.<id>.issuer`, falling back to the MCP server's own origin on a cold start (always known, no network). `saveDiscoveryState()` rebinds it. Consequences, all verified by running them:

- Cold start: tag = server origin. Discovery rebinds before `clientInformation()`, so DCR lands under the *real* issuer's tag. Nothing was ever written under the provisional tag.
- Warm start: the recorded issuer gives the right tag immediately, so `tokens()` resolves with no network.
- **Issuer changes:** the tag changes, `clientInformation()` finds nothing, and the SDK re-registers against the new server. The old issuer's credentials stay in the vault, orphaned, and are never transmitted. Cross-issuer reuse becomes structurally impossible rather than a rule someone has to remember.

All four key shapes were checked against `MCP_CREDENTIAL_KEY_RE` — **no vault change is needed.**

- [ ] **Step 1: Write failing tests** — create `extension/tests/mcp-client.test.mjs`:

```js
// Tests for extension/connectors/mcp-client.mjs against the hermetic
// fixture. DB + vault bootstrap follows tests/kb-router-slack.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_mcp-client-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { getSecret, setSecret } = await import('../server/vault.mjs');
const {
  VaultOAuthProvider, mcpRedirectUri, startMcpAuthorization, finishMcpAuthorization,
  isMcpConnected, withMcpSession, testMcpConnection,
} = await import('../connectors/mcp-client.mjs');
const { startFakeMcpServer } = await import('./fixtures/fake-mcp-oauth-server.mjs');

let userCounter = 0;
function newUser() {
  return users.registerUser(kb.getDb(), {
    email: `mcp-client-${Date.now()}-${++userCounter}@example.com`,
    password: 'CorrectHorseBattery', displayName: 'T',
  });
}
const defFor = (fake, over = {}) => ({
  id: 'miro', name: 'Miro', serverUrl: fake.url, scope: 'boards:read',
  byoClient: false, clientName: 'LLM-IDE',
  byoClientIdKey: 'mcp.miro.byoClientId',
  byoClientSecretKey: 'mcp.miro.byoClientSecret',
  listTool: null, readTool: null, mapItem: null, ...over,
});

/** Drive the whole connect dance for `user` against `fake`. */
async function connectFully(db, user, def, fake) {
  const state = 'state-token-1';
  const started = await startMcpAuthorization({ db, userId: user.id, def, stateToken: state });
  const { code } = await fake.authorize(started.authorizationUrl);
  return finishMcpAuthorization({ db, userId: user.id, def, code });
}

test('redirect URI is the callback route on the configured port', () => {
  assert.equal(mcpRedirectUri(), 'http://127.0.0.1:3456/auth/mcp-connector/callback');
});

test('start captures an authorization URL instead of redirecting', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);

  const r = await startMcpAuthorization({ db, userId: user.id, def, stateToken: 'st-1' });
  assert.equal(r.alreadyConnected, false);

  const url = new URL(r.authorizationUrl);
  assert.equal(url.origin, fake.origin);
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('state'), 'st-1', 'our state token, so the callback can find the user');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), mcpRedirectUri());

  // Dynamic client registration happened, advertising OUR callback.
  assert.equal(fake.registrations.length, 1);
  assert.deepEqual(fake.registrations[0].redirect_uris, [mcpRedirectUri()]);
  assert.equal(fake.registrations[0].client_name, 'LLM-IDE');
});

test('finish exchanges the code on a fresh transport and persists tokens', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);

  assert.equal(isMcpConnected(db, user.id, def), false);
  const { account } = await connectFully(db, user, def, fake);
  assert.equal(account, 'fake-miro', 'the server identity, read back over a verified session');
  assert.equal(isMcpConnected(db, user.id, def), true);

  // The PKCE verifier survived a round trip through the encrypted vault —
  // the fixture rejects the exchange otherwise.
  assert.equal(fake.tokenRequests.at(-1).grant_type, 'authorization_code');
  assert.ok(fake.tokenRequests.at(-1).code_verifier);
});

test('credentials are stored issuer-scoped under vault-legal keys', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  assert.equal(getSecret(db, user.id, 'mcp.miro.issuer'), `${fake.origin}/`);

  const p = new VaultOAuthProvider({ db, userId: user.id, def });
  for (const field of ['tokens', 'clientInformation', 'codeVerifier']) {
    const key = p.key(field);
    assert.match(key, /^mcp\.miro-[0-9a-f]{12}\.[a-zA-Z]+$/, key);
    // server/vault.mjs MCP_CREDENTIAL_KEY_RE must accept it — getSecret
    // throws "Unknown vault key" otherwise.
    assert.doesNotThrow(() => getSecret(db, user.id, key));
  }
  assert.ok(getSecret(db, user.id, p.key('tokens')));
});

test('a session with saved tokens makes no OAuth requests', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  fake.clearLog();
  const result = await testMcpConnection(db, user.id, def);
  assert.deepEqual(result.server, { name: 'fake-miro', version: '0.0.1' });
  assert.deepEqual(result.tools.sort(), ['get_board_items', 'list_boards']);
  assert.ok(fake.requests.every((r) => r.endsWith(' /mcp')),
    `expected /mcp only, saw ${fake.requests.join(', ')}`);
});

test('an unconnected user gets MCP_UNAUTHORIZED without touching the network', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);

  await assert.rejects(
    () => withMcpSession(db, user.id, def, async () => 'never'),
    (e) => {
      assert.equal(e.code, 'MCP_UNAUTHORIZED');
      assert.match(e.message, /Miro/);
      return true;
    },
  );
  // No speculative DCR: an ingestion sweep for an unconnected user must be
  // free, not a fresh client registration every tick.
  assert.deepEqual(fake.requests, []);
});

test('selections are per user — one user connecting does not connect another', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const def = defFor(fake);
  const a = newUser();
  const b = newUser();
  await connectFully(db, a, def, fake);
  assert.equal(isMcpConnected(db, a.id, def), true);
  assert.equal(isMcpConnected(db, b.id, def), false);
});

test('start returns alreadyConnected when tokens are still good', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  const again = await startMcpAuthorization({ db, userId: user.id, def, stateToken: 'st-2' });
  assert.equal(again.alreadyConnected, true);
  assert.equal(again.authorizationUrl, null);
});

test('a changed issuer re-keys credentials instead of reusing them', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  const oldKey = new VaultOAuthProvider({ db, userId: user.id, def }).key('tokens');

  // The resource now points at a different authorization server.
  fake.setIssuerPath('/as-b/');
  fake.revokeAccessTokens();

  const r = await startMcpAuthorization({ db, userId: user.id, def, stateToken: 'st-3' });
  assert.equal(r.alreadyConnected, false, 'must not replay the old issuer’s tokens');
  assert.equal(getSecret(db, user.id, 'mcp.miro.issuer'), `${fake.origin}/as-b/`);

  const newKey = new VaultOAuthProvider({ db, userId: user.id, def }).key('tokens');
  assert.notEqual(newKey, oldKey, 'a new issuer means a new key namespace');
  assert.equal(getSecret(db, user.id, newKey), null, 'no tokens carried over');
  assert.ok(getSecret(db, user.id, oldKey), 'the old issuer’s credentials are orphaned, not deleted');
  assert.equal(fake.registrations.length, 2, 're-registered with the new authorization server');
});

test('a byoClient descriptor uses the operator pair instead of registering', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake, { byoClient: true });

  // Phase 3 (Google) shape: no DCR, an operator-provisioned client.
  setSecret(db, user.id, def.byoClientIdKey, 'operator-client-id');
  setSecret(db, user.id, def.byoClientSecretKey, 'operator-client-secret');

  const p = new VaultOAuthProvider({ db, userId: user.id, def });
  assert.deepEqual(p.clientInformation(), {
    client_id: 'operator-client-id', client_secret: 'operator-client-secret',
  });

  // Not configured → undefined, so the SDK reports a real error rather than
  // registering a client Google would reject anyway.
  const other = newUser();
  assert.equal(new VaultOAuthProvider({ db, userId: other.id, def }).clientInformation(), undefined);
});

test('invalidateCredentials clears only the requested scope', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  const p = new VaultOAuthProvider({ db, userId: user.id, def });
  p.invalidateCredentials('tokens');
  assert.equal(getSecret(db, user.id, p.key('tokens')), null);
  assert.ok(getSecret(db, user.id, p.key('clientInformation')), 'the registration survives');

  p.invalidateCredentials('all');
  assert.equal(getSecret(db, user.id, p.key('clientInformation')), null);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/mcp-client.test.mjs`
Expected: FAIL — `../connectors/mcp-client.mjs` not found.

- [ ] **Step 3: Implement** — create `extension/connectors/mcp-client.mjs`:

```js
// MCP client for ingestion connectors — one generic adapter for every remote
// MCP server we fetch content from (Miro today; Google Drive and Calendar in
// phase 3). Nothing here branches on a connector: it reads a descriptor from
// connectors/mcp-connector-defs.mjs and does the same thing for all of them.
//
// Three responsibilities live in this file because they are one flow, the way
// connectors/slack-oauth.mjs keeps its helper and its state map together:
//
//   1. VaultOAuthProvider — the SDK's OAuthClientProvider backed by the
//      per-user encrypted vault.
//   2. The OAuth-flow state map — an in-memory, TTL-swept, single-use store
//      linking the `state` parameter back to (userId, connectorId).
//   3. Session helpers — connect, run, close. Never pooled: ingestion runs on
//      a timer and a long-lived session buys nothing but lifecycle bugs.
//
// ── Import specifiers ───────────────────────────────────────────────────────
// The package's exports map publishes "./client" (Client only) plus a "./*"
// wildcard onto dist/esm. The transport and UnauthorizedError are reachable
// only through the wildcard, which is also what the existing tests use. Never
// write a dist/esm path — that bypasses the exports map.
//
// ── Vault key scheme ────────────────────────────────────────────────────────
// The SDK is explicit that a client registered with one authorization server
// must never be presented to another, so credentials are keyed by connector id
// AND issuer. The catch: the transport calls tokens() to build the Authorization
// header BEFORE any discovery, so the namespace must be computable offline.
//
//   mcp.<id>.issuer                    last discovered authorization server
//   mcp.<id>-<tag>.clientInformation   DCR result, or the operator's BYO client
//   mcp.<id>-<tag>.tokens              access + refresh token
//   mcp.<id>-<tag>.codeVerifier        PKCE verifier, in flight only
//
// <tag> = sha256(boundIssuer)[0..12). boundIssuer starts from the recorded
// issuer and falls back to the MCP server's own origin on a cold start;
// saveDiscoveryState() rebinds it, and the SDK always calls that before
// clientInformation(). When the issuer changes the tag changes, the old
// credentials become unreachable (orphaned, not deleted), and the SDK
// re-registers. Cross-issuer reuse is impossible by construction.
//
// All four shapes satisfy server/vault.mjs's MCP_CREDENTIAL_KEY_RE — adding an
// MCP connector never requires a vault change.
//
// discoveryState() is deliberately NOT implemented: caching discovery would
// require knowing the issuer before we know the issuer. Two extra well-known
// GETs, only on the cold or expired path, is the right trade.

import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../core/config.mjs';
import { getSecret, setSecret } from '../server/vault.mjs';

const CLIENT_INFO = { name: 'llm-ide', version: '1.0.0' };
const CONNECT_TIMEOUT_MS = 20_000;
const STATE_TTL_MS = 10 * 60 * 1000;

/** Where every MCP connector's authorization redirect lands. */
export function mcpRedirectUri() {
  return `http://127.0.0.1:${config.port}/auth/mcp-connector/callback`;
}

function issuerTag(issuer) {
  return crypto.createHash('sha256').update(String(issuer)).digest('hex').slice(0, 12);
}

/** Tagged "connect this connector first" error, distinct from a transport fault. */
function mcpUnauthorized(def) {
  const e = new Error(`Not connected to ${def.name}. Connect it in Settings first.`);
  e.code = 'MCP_UNAUTHORIZED';
  return e;
}

// ─── OAuthClientProvider, backed by the vault ───────────────────────────────

export class VaultOAuthProvider {
  /**
   * @param {{ db: object, userId: string, def: object,
   *           stateToken?: string, onAuthorizationUrl?: (url: string) => void }} o
   */
  constructor({ db, userId, def, stateToken, onAuthorizationUrl }) {
    this.db = db;
    this.userId = userId;
    this.def = def;
    this.stateToken = stateToken;
    this.onAuthorizationUrl = onAuthorizationUrl;
    /** Captured by redirectToAuthorization — there is no user agent here. */
    this.authorizationUrl = null;
    this.issuerKey = `mcp.${def.id}.issuer`;
    this.boundIssuer = getSecret(db, userId, this.issuerKey)
      || new URL('/', def.serverUrl).toString();
  }

  /** Vault key for one credential field, in the current issuer namespace. */
  key(field) {
    return `mcp.${this.def.id}-${issuerTag(this.boundIssuer)}.${field}`;
  }

  _read(field) { return getSecret(this.db, this.userId, this.key(field)) || null; }
  _readJson(field) {
    const raw = this._read(field);
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  _write(field, value) { setSecret(this.db, this.userId, this.key(field), value); }

  // --- required hooks ---

  get redirectUrl() { return mcpRedirectUri(); }

  get clientMetadata() {
    return {
      client_name: this.def.clientName,
      redirect_uris: [mcpRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.def.byoClient ? 'client_secret_post' : 'none',
      scope: this.def.scope,
    };
  }

  clientInformation() {
    const stored = this._readJson('clientInformation');
    if (stored) return stored;
    if (!this.def.byoClient) return undefined;   // DCR will register one
    // Operator-provisioned client (Google, phase 3): not issuer-scoped —
    // it belongs to the descriptor, not to a discovered server.
    const id = getSecret(this.db, this.userId, this.def.byoClientIdKey);
    const secret = getSecret(this.db, this.userId, this.def.byoClientSecretKey);
    if (!id) return undefined;
    return secret ? { client_id: id, client_secret: secret } : { client_id: id };
  }

  saveClientInformation(ci) { this._write('clientInformation', JSON.stringify(ci)); }

  tokens() { return this._readJson('tokens'); }
  saveTokens(t) { this._write('tokens', JSON.stringify(t)); }

  saveCodeVerifier(v) { this._write('codeVerifier', v); }
  codeVerifier() {
    const v = this._read('codeVerifier');
    if (!v) throw new Error('No PKCE code verifier saved — start the connection again.');
    return v;
  }

  /**
   * The SDK's name for this hook is aspirational on a server: there is no
   * user agent to redirect. Capture the URL so the start route can hand it
   * to the Mac app, which opens the user's browser.
   */
  redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = authorizationUrl.toString();
    this.onAuthorizationUrl?.(this.authorizationUrl);
  }

  // --- optional hooks we do implement ---

  /** Our own state token, so /auth/mcp-connector/callback can find the user. */
  state() { return this.stateToken; }

  /**
   * Called immediately after discovery and always before clientInformation(),
   * which is what makes issuer rebinding safe.
   */
  saveDiscoveryState(ds) {
    const discovered = String(ds?.authorizationServerUrl || '');
    if (!discovered) return;
    if (discovered !== getSecret(this.db, this.userId, this.issuerKey)) {
      setSecret(this.db, this.userId, this.issuerKey, discovered);
    }
    this.boundIssuer = discovered;
  }

  /** Let the SDK clear credentials the server has rejected. */
  invalidateCredentials(scope) {
    const fields = scope === 'all' ? ['clientInformation', 'tokens', 'codeVerifier']
      : scope === 'client' ? ['clientInformation']
      : scope === 'tokens' ? ['tokens']
      : scope === 'verifier' ? ['codeVerifier']
      : [];                                  // 'discovery' — nothing cached
    for (const f of fields) this._write(f, '');   // '' deletes (vault.mjs)
  }
}

// ─── OAuth-flow state map ───────────────────────────────────────────────────
//
// Mirrors connectors/slack-oauth.mjs: single-node, in-memory, TTL-swept.
// It carries only { userId, connectorId } — the credentials themselves live in
// the vault, so the callback rebuilds a provider from scratch instead of
// holding a live object across a browser round trip.

const _states = new Map();
function sweep() {
  const now = Date.now();
  for (const [k, v] of _states) if (now - v.createdAt > STATE_TTL_MS) _states.delete(k);
}
export function putMcpState(state, data) {
  sweep();
  _states.set(state, { ...data, status: 'pending', createdAt: Date.now() });
}
export function getMcpState(state) {
  const v = _states.get(state);
  if (!v) return undefined;
  if (Date.now() - v.createdAt > STATE_TTL_MS) { _states.delete(state); return undefined; }
  return v;
}
export function completeMcpState(state, patch) {
  const v = _states.get(state);
  if (v) _states.set(state, { ...v, ...patch });
}
/** Read the terminal status once, then drop it (single use). */
export function takeMcpStatus(state) {
  const v = _states.get(state);
  if (!v) return { status: 'unknown' };
  if (v.status !== 'pending') _states.delete(state);
  const out = { status: v.status };
  if (v.account !== undefined) out.account = v.account;
  if (v.message !== undefined) out.message = v.message;
  return out;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** True when this user holds tokens for this connector's current issuer. */
export function isMcpConnected(db, userId, def) {
  return Boolean(new VaultOAuthProvider({ db, userId, def }).tokens());
}

/**
 * Open a session, run `fn(client)`, close. Per call, never pooled.
 * Throws MCP_UNAUTHORIZED when the user has not connected — checked up front
 * so a sweep over unconnected users costs nothing and cannot trigger a
 * speculative dynamic client registration on every tick.
 */
export async function withMcpSession(db, userId, def, fn) {
  const provider = new VaultOAuthProvider({ db, userId, def });
  if (!provider.tokens()) throw mcpUnauthorized(def);

  const transport = new StreamableHTTPClientTransport(new URL(def.serverUrl), { authProvider: provider });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    await transport.close().catch(() => {});
    // The SDK already tried a refresh; reaching here means re-consent.
    if (err instanceof UnauthorizedError) throw mcpUnauthorized(def);
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Prove an authenticated round trip: connect + tools/list. */
export async function testMcpConnection(db, userId, def) {
  return withMcpSession(db, userId, def, async (client) => {
    const { tools } = await client.listTools();
    return {
      server: client.getServerVersion() || { name: def.name, version: '' },
      tools: tools.map((t) => t.name),
    };
  });
}

/**
 * Begin authorization. Returns the URL for the Mac app to open, or
 * { alreadyConnected: true } when the saved tokens still work.
 */
export async function startMcpAuthorization({ db, userId, def, stateToken }) {
  const provider = new VaultOAuthProvider({ db, userId, def, stateToken });
  const transport = new StreamableHTTPClientTransport(new URL(def.serverUrl), { authProvider: provider });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return { authorizationUrl: null, alreadyConnected: true };
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    if (!provider.authorizationUrl) {
      // Unauthorized with nothing to open: discovery found no interactive
      // flow. Miro Enterprise disables MCP until an admin enables it, and
      // this is where that surfaces — as an error, not a silent empty fetch.
      throw new Error(`${def.name} did not offer an authorization URL — the server may have MCP access disabled for your plan.`);
    }
    return { authorizationUrl: provider.authorizationUrl, alreadyConnected: false };
  } finally {
    await transport.close().catch(() => {});
  }
}

/**
 * Exchange the authorization code and verify the result.
 *
 * finishAuth() needs a transport but never starts one, and a started transport
 * cannot be restarted — so the verification below uses a SECOND, fresh
 * transport. That is the SDK's documented sequence, not defensiveness.
 */
export async function finishMcpAuthorization({ db, userId, def, code }) {
  if (!code) throw new Error('Authorization code missing from the callback.');
  const provider = new VaultOAuthProvider({ db, userId, def });
  const authTransport = new StreamableHTTPClientTransport(new URL(def.serverUrl), { authProvider: provider });
  try {
    await authTransport.finishAuth(code);
  } finally {
    await authTransport.close().catch(() => {});
  }
  const info = await withMcpSession(db, userId, def, async (client) => client.getServerVersion());
  return { account: info?.name || def.name };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/mcp-client.test.mjs && npm run lint`
Expected: PASS (11 tests), lint clean. Lint is the layer check here: an accidental `../mcp/` or `../routes/` import fails `connectors/**` → `allowOnly('core','kb','server','providers')`.

- [ ] **Step 5: Commit**

```bash
git add extension/connectors/mcp-client.mjs extension/tests/mcp-client.test.mjs
git commit -m "feat(connectors): MCP client with vault-backed OAuth 2.1 provider"
```

---

### Task 5: `/auth/mcp-connector/*` OAuth routes

**Files:**
- Modify: `extension/server/auth-routes.mjs` — imports (top, beside the slack-oauth import at :21-25); allow-list `isAuthRoute` (:152-206, after the `/auth/me/connectors/` group); the **public** callback block (beside the Slack callback, which ends at :464 — must stay ABOVE the `---- Authenticated ----` guard); the authed start + status blocks (after the Slack status block ending :600)
- Modify: `extension/server/auth.mjs` (`PUBLIC_PATHS`, :26-38)
- Test: `extension/tests/mcp-connector-oauth-routes.test.mjs` (create; header + doubles copied from `tests/slack-oauth-routes.test.mjs:1-70`)

**Interfaces:**
- Consumes: Tasks 2 and 4.
- Produces (phase 2b's Mac `McpConnectorAdapter` consumes):
  - `POST /auth/mcp-connector/start` `{ id }` → `{ authUrl, state }` or `{ state, alreadyConnected: true }`; 400 unknown id; 502 on failure
  - `GET /auth/mcp-connector/callback?code=&state=` → HTML (public)
  - `GET /auth/mcp-connector/status?id=[&state=]` → `{ id, connected, status, account?, message? }`; 403 on someone else's flow

Two notes on shape. The field is **`authUrl`**, matching `/auth/google/start` and `/auth/slack/start`, not the design doc's `authorizationUrl` — one name for one concept across the Mac client's three OAuth flows. And `status` answers both questions: `connected` reads the vault so the Mac can ask at any time with just `?id=`, while `?state=` additionally returns the single-use poll status while the browser tab is open, exactly as Slack does.

**No `SERVER_API_VERSION` bump** — `/auth/*` is excluded from `ENDPOINTS` by convention (`server.mjs:49`).

- [ ] **Step 1: Write failing tests** — create `extension/tests/mcp-connector-oauth-routes.test.mjs`. Copy the header and the `makeReq`/`makeRes`/`callAuth`/`registerAndLogin` block verbatim from `tests/slack-oauth-routes.test.mjs:1-70`, changing only the db filename (`_mcp-connector-oauth-routes-test.db`), the ip prefix (`10.31.0.`), and the email prefix; drop the Slack env vars. Then:

```js
// HTTP-level tests for /auth/mcp-connector/{start,callback,status}.
// The connector is pointed at the hermetic fixture via LLMIDE_MCP_MIRO_URL,
// which mcpConnectorDef() re-reads on every call.
//
// … header + makeReq/makeRes/callAuth/registerAndLogin copied from
// tests/slack-oauth-routes.test.mjs:1-70 …

const { startFakeMcpServer } = await import('./fixtures/fake-mcp-oauth-server.mjs');
const { isAuthRoute } = await import('../server/auth-routes.mjs');
const { isPublicPath } = await import('../server/auth.mjs');

test('the three routes are allow-listed and only the callback is public', () => {
  for (const p of ['/auth/mcp-connector/start', '/auth/mcp-connector/callback', '/auth/mcp-connector/status']) {
    assert.ok(isAuthRoute(p), `${p} must dispatch to handleAuth`);
  }
  assert.ok(isAuthRoute('/auth/mcp-connector/status?id=miro'), 'query strings must not break dispatch');
  // The OAuth redirect arrives from a browser with no bearer token.
  assert.ok(isPublicPath('GET', '/auth/mcp-connector/callback?code=x&state=y'));
  assert.ok(!isPublicPath('POST', '/auth/mcp-connector/start'));
  assert.ok(!isPublicPath('GET', '/auth/mcp-connector/status?id=miro'));
});

test('start rejects an unknown connector id', async () => {
  const { user } = await registerAndLogin();
  for (const body of [{ id: 'nope' }, { id: 'gdrive' }, {}]) {
    const r = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body, user });
    assert.equal(r.statusCode, 400, r._body);
    assert.equal(r.json().error.code, 'VALIDATION_FAILED');
  }
});

test('full connect loop: start → callback → status', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user } = await registerAndLogin();

  // Not connected yet.
  const s0 = await callAuth({ method: 'GET', url: '/auth/mcp-connector/status?id=miro', user });
  assert.equal(s0.statusCode, 200, s0._body);
  assert.equal(s0.json().connected, false);

  // Start — the URL comes back to us because we cannot redirect server-side.
  const start = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  assert.equal(start.statusCode, 200, start._body);
  const { authUrl, state } = start.json();
  assert.ok(state);
  assert.equal(new URL(authUrl).origin, fake.origin);
  assert.equal(new URL(authUrl).searchParams.get('state'), state);

  // Poll while the tab is open.
  const pending = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user });
  assert.equal(pending.json().status, 'pending');
  assert.equal(pending.json().connected, false);

  // The browser consents and is redirected to our public callback.
  const { code, state: echoed } = await fake.authorize(authUrl);
  assert.equal(echoed, state);
  const cb = await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });
  assert.equal(cb.statusCode, 200, cb._body);
  assert.match(cb._body, /Connected to Miro/);
  assert.doesNotMatch(cb._body, new RegExp(code), 'the callback must not echo the authorization code');

  // Terminal status, single use.
  const done = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user });
  assert.equal(done.json().status, 'complete');
  assert.equal(done.json().connected, true);
  assert.equal(done.json().account, 'fake-miro');
  const reread = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user });
  assert.equal(reread.json().status, 'unknown', 'terminal status is consumed once');
  assert.equal(reread.json().connected, true, 'but connectedness still reads the vault');
});

test('start reports alreadyConnected for a live connection', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user } = await registerAndLogin();
  const s1 = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  const { code, state } = await fake.authorize(s1.json().authUrl);
  await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });

  const s2 = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  assert.equal(s2.statusCode, 200, s2._body);
  assert.equal(s2.json().alreadyConnected, true);
  assert.equal(s2.json().authUrl, undefined);
});

test('the callback refuses replayed, unknown and cancelled states', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  const { authUrl, state } = start.json();
  const { code } = await fake.authorize(authUrl);

  const first = await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });
  assert.match(first._body, /Connected to Miro/);

  const replay = await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });
  assert.match(replay._body, /already been used/);

  const unknown = await callAuth({ method: 'GET', url: '/auth/mcp-connector/callback?code=x&state=not-a-state' });
  assert.match(unknown._body, /expired/);

  const s2 = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  const cancelled = await callAuth({
    method: 'GET', url: `/auth/mcp-connector/callback?error=access_denied&state=${s2.json().state}`,
  });
  assert.match(cancelled._body, /cancelled/);
});

test('status refuses to leak another user’s flow', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user: owner } = await registerAndLogin();
  const { user: other } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user: owner });
  const { state } = start.json();

  const r = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user: other });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error.code, 'FORBIDDEN');
});

test('status rejects an unknown connector id', async () => {
  const { user } = await registerAndLogin();
  const r = await callAuth({ method: 'GET', url: '/auth/mcp-connector/status?id=nope', user });
  assert.equal(r.statusCode, 400);
});

test('start surfaces an unreachable server as 502, not a crash', async (t) => {
  const fake = await startFakeMcpServer();
  const deadUrl = fake.url;
  await fake.close();                       // port is now closed
  process.env.LLMIDE_MCP_MIRO_URL = deadUrl;
  t.after(() => { delete process.env.LLMIDE_MCP_MIRO_URL; });

  const { user } = await registerAndLogin();
  const r = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  assert.equal(r.statusCode, 502, r._body);
  assert.equal(r.json().error.code, 'MCP_AUTH_START_FAILED');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/mcp-connector-oauth-routes.test.mjs`
Expected: FAIL — `isAuthRoute` returns false, every route 404s.

- [ ] **Step 3: Implement**

**3a — `extension/server/auth.mjs`**, in `PUBLIC_PATHS` (:26-38), after the Slack line:

```js
  '/auth/mcp-connector/callback',      // MCP connector OAuth redirect carries no bearer token
```

**3b — `extension/server/auth-routes.mjs`**, imports, after the slack-oauth import block (:21-25):

```js
import {
  startMcpAuthorization, finishMcpAuthorization, isMcpConnected,
  putMcpState, getMcpState, completeMcpState, takeMcpStatus,
} from '../connectors/mcp-client.mjs';
import { mcpConnectorDef } from '../connectors/mcp-connector-defs.mjs';
```

**3c — allow-list**, inside `isAuthRoute` (after the `/auth/me/connectors/` group at :199, before the `/auth/google/start` line):

```js
      || path === '/auth/mcp-connector/start'
      || path === '/auth/mcp-connector/callback'
      || path === '/auth/mcp-connector/status'
```

**3d — the public callback.** Insert immediately after the Slack callback block ends (:464) and **before** the `// ---- Authenticated ----` guard. Placement is the security control: anything below that comment is authenticated by construction, and this route must not be.

```js
  // ---- MCP connector callback (public) --------------------------------
  //
  // GET /auth/mcp-connector/callback?code=...&state=...
  //   The authorization server redirects the user's browser here — no bearer
  //   token, so it stays public (allow-listed in server/auth.mjs
  //   PUBLIC_PATHS). `state` is the only link back to the user: it was minted
  //   by the start route below and handed to the SDK through the provider's
  //   state() hook. The credentials themselves live in the vault, so we
  //   rebuild the provider from (userId, connectorId) rather than holding a
  //   live object across the browser round trip.
  if (method === 'GET' && url.split('?')[0] === '/auth/mcp-connector/callback') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const state = q.get('state') || '';
    const st = getMcpState(state);
    if (q.get('error')) {
      if (st) completeMcpState(state, { status: 'error', message: 'Sign-in cancelled.' });
      oauthCallbackHtml(res, 'Sign-in cancelled.');
      return;
    }
    if (!st) { oauthCallbackHtml(res, 'This sign-in link has expired — start again from the app.'); return; }
    if (st.status !== 'pending') { oauthCallbackHtml(res, 'This sign-in link has already been used — start again from the app.'); return; }
    const def = mcpConnectorDef(st.connectorId);
    if (!def) {
      completeMcpState(state, { status: 'error', message: 'Unknown connector.' });
      oauthCallbackHtml(res, 'Connection failed: unknown connector.');
      return;
    }
    try {
      const { account } = await finishMcpAuthorization({
        db, userId: st.userId, def, code: q.get('code') || '',
      });
      safeAudit(db, {
        userId: st.userId, requestId, ip, userAgent: ua,
        action: 'auth.secret_set', resource: `mcp.${def.id}.tokens`,
        outcome: 'success', detail: {},
      });
      completeMcpState(state, { status: 'complete', account });
      oauthCallbackHtml(res, `Connected to ${def.name}.`);
    } catch (e) {
      const msg = publicMessageFor(e);
      completeMcpState(state, { status: 'error', message: msg });
      oauthCallbackHtml(res, 'Connection failed: ' + msg);
    }
    return;
  }
```

**3e — start + status (authed).** Insert after the Slack status block (ends :600):

```js
  // ---- MCP connectors: start + status (authed) -------------------------
  //
  // POST /auth/mcp-connector/start { id } -> { authUrl, state }
  //   There is no way to redirect from here — no user agent is on this
  //   request — so the SDK's redirectToAuthorization hook captures the URL
  //   and we hand it back for the Mac app to open. Miro uses dynamic client
  //   registration, so nothing is configured: the first call registers a
  //   client and stores it in the vault.
  if (method === 'POST' && url === '/auth/mcp-connector/start') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const def = mcpConnectorDef(typeof body?.id === 'string' ? body.id : '');
    if (!def) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: `Unknown MCP connector '${body?.id ?? ''}'` } });
      return;
    }
    const state = crypto.randomBytes(24).toString('base64url');
    putMcpState(state, { userId: req.user.id, connectorId: def.id });
    try {
      const r = await startMcpAuthorization({ db, userId: req.user.id, def, stateToken: state });
      if (r.alreadyConnected) {
        completeMcpState(state, { status: 'complete', account: def.name });
        send(res, 200, { state, alreadyConnected: true });
        return;
      }
      send(res, 200, { authUrl: r.authorizationUrl, state });
    } catch (e) {
      const msg = publicMessageFor(e);
      completeMcpState(state, { status: 'error', message: msg });
      send(res, 502, { error: { code: 'MCP_AUTH_START_FAILED', message: msg } });
    }
    return;
  }

  // GET /auth/mcp-connector/status?id=<connector>[&state=<flow>]
  //   `connected` reads the vault, so the Mac can ask at any time with just
  //   an id. Adding `state` also returns the single-use flow status while
  //   the browser tab is open (same contract as /auth/slack/status), with
  //   the same ownership check: only the initiator may read their flow.
  if (method === 'GET' && url.split('?')[0] === '/auth/mcp-connector/status') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const def = mcpConnectorDef(q.get('id') || '');
    if (!def) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Unknown MCP connector' } });
      return;
    }
    const state = q.get('state') || '';
    if (state) {
      const s = getMcpState(state);
      if (s && s.userId !== req.user.id) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'not your sign-in' } }); return; }
    }
    const flow = state ? takeMcpStatus(state) : { status: 'unknown' };
    send(res, 200, { id: def.id, connected: isMcpConnected(db, req.user.id, def), ...flow });
    return;
  }
```

(`send`, `readJson`, `safeAudit`, `publicMessageFor`, `oauthCallbackHtml`, `db`, `ip`, `ua`, `requestId`, `bodyLimit` and `crypto` all already exist in this file — these are the same names the Slack blocks use. If any differs, follow the neighbour, not this snippet.)

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/mcp-connector-oauth-routes.test.mjs tests/auth-routes.test.mjs tests/slack-oauth-routes.test.mjs && npm run lint`
Expected: PASS all three — the existing auth suites must show no regression from the allow-list and `PUBLIC_PATHS` edits.

- [ ] **Step 5: Commit**

```bash
git add extension/server/auth-routes.mjs extension/server/auth.mjs extension/tests/mcp-connector-oauth-routes.test.mjs
git commit -m "feat(server): /auth/mcp-connector OAuth start, callback and status routes"
```

---

### Task 6: `POST /kb/mcp-connector/test`

**Files:**
- Modify: `extension/routes/router.mjs` — import (beside the slack-source import at :36); route block after the Box block (ends ~:700)
- Modify: `extension/server.mjs` — `SERVER_API_VERSION` 37→38 + comment (:33-95), `ENDPOINTS` (:96), rate-limit bucket (beside `/kb/box/test`, :265)
- Modify: `docs/reference/api/openapi.yaml` (beside `/kb/slack/test`, :494), `docs/spec/api-server.md` (dispatch bucket row, :238)
- Test: `extension/tests/kb-router-mcp-connector.test.mjs` (create; doubles from `tests/kb-router-slack.test.mjs:27-47`)

**Interfaces:**
- Consumes: Tasks 2 and 4.
- Produces: `POST /kb/mcp-connector/test` `{ id }` → `{ ok: true, server: { name, version }, tools: string[] }`; 400 `VALIDATION_FAILED` for an unknown id; 400 `MCP_UNAUTHORIZED` when not connected; 502 `MCP_CONNECT_FAILED` otherwise. This is the `test` endpoint the Mac `SourceConnectorManifest` declares; phase 2b adds `fetch`/`seen`/`classify` beside it.

**Why here, and what that costs.** The manifest engine expects its four endpoints under one `/kb/<id>/` family, and phase 2b will add three more siblings — so putting `test` under `/auth/*` to dodge the version bump would be a short-term dodge that splits the family. Under `/kb/*` it follows the full endpoint contract: `ENDPOINTS` entry, `SERVER_API_VERSION` bump with a log comment, and a rate-limit bucket. It does **not** go in `REQUIRED_ENDPOINTS` (`src/sidepanel/App.tsx:61`) — that is the Chrome side panel's staleness probe and lists no connector routes — and it does **not** raise `minimumServerApiVersion` (`mac/.../BackendManager.swift:545`), whose comment reserves that for wire-breaking changes, "NOT for a merely added endpoint".

- [ ] **Step 1: Write failing tests** — create `extension/tests/kb-router-mcp-connector.test.mjs`:

```js
// HTTP-layer tests for POST /kb/mcp-connector/test. Setup mirrors
// tests/kb-router-slack.test.mjs; the connector is pointed at the hermetic
// fixture via LLMIDE_MCP_MIRO_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-mcp-connector-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { mcpConnectorDef } = await import('../connectors/mcp-connector-defs.mjs');
const { startMcpAuthorization, finishMcpAuthorization } = await import('../connectors/mcp-client.mjs');
const { startFakeMcpServer } = await import('./fixtures/fake-mcp-oauth-server.mjs');

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
let n = 0;
const newUser = () => users.registerUser(db.getDb(), {
  email: `kb-mcp-${Date.now()}-${++n}@example.com`,
  password: 'CorrectHorseBattery', displayName: 'T',
});
async function post(url, body, userId) {
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url, body, userId }), res);
  return res;
}

test('unknown connector id → 400', async () => {
  const u = newUser();
  for (const body of [{ id: 'nope' }, { id: 'gdrive' }, {}]) {
    const r = await post('/kb/mcp-connector/test', body, u.id);
    assert.equal(r.statusCode, 400, r._body);
    assert.equal(r.json().error.code, 'VALIDATION_FAILED');
  }
});

test('not connected → 400 MCP_UNAUTHORIZED, not a 502', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const u = newUser();
  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 400, r._body);
  assert.equal(r.json().error.code, 'MCP_UNAUTHORIZED');
  assert.deepEqual(fake.requests, [], 'an unconnected probe must not hit the server');
});

test('connected → 200 with the server identity and its tool list', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const u = newUser();
  const def = mcpConnectorDef('miro');
  const started = await startMcpAuthorization({ db: db.getDb(), userId: u.id, def, stateToken: 's' });
  const { code } = await fake.authorize(started.authorizationUrl);
  await finishMcpAuthorization({ db: db.getDb(), userId: u.id, def, code });

  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 200, r._body);
  const out = r.json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.server, { name: 'fake-miro', version: '0.0.1' });
  assert.deepEqual(out.tools.sort(), ['get_board_items', 'list_boards']);
});

test('an unreachable server → 502 MCP_CONNECT_FAILED', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  const u = newUser();
  const def = mcpConnectorDef('miro');
  const started = await startMcpAuthorization({ db: db.getDb(), userId: u.id, def, stateToken: 's' });
  const { code } = await fake.authorize(started.authorizationUrl);
  await finishMcpAuthorization({ db: db.getDb(), userId: u.id, def, code });
  await fake.close();                 // tokens are saved, the server is gone
  t.after(() => { delete process.env.LLMIDE_MCP_MIRO_URL; });

  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 502, r._body);
  assert.equal(r.json().error.code, 'MCP_CONNECT_FAILED');
});

test('the endpoint is advertised and rate-limited like its siblings', async () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.mjs'), 'utf8');
  assert.match(server, /'\/kb\/mcp-connector\/test',/, 'must be in the ENDPOINTS array');
  assert.match(server, /url === '\/kb\/mcp-connector\/test'\) return 'dispatch'/,
    'external-API test routes belong on the dispatch bucket');
  assert.match(server, /const SERVER_API_VERSION = 38;/, 'adding an endpoint bumps the version');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/kb-router-mcp-connector.test.mjs`
Expected: FAIL — the route 404s and the `server.mjs` assertions fail.

- [ ] **Step 3: Implement**

**3a — `extension/routes/router.mjs`**, imports, after the slack-source import (:36):

```js
import { testMcpConnection } from '../connectors/mcp-client.mjs';
import { mcpConnectorDef } from '../connectors/mcp-connector-defs.mjs';
```

Then, after the Box block (~:700):

```js
    // MCP-backed connectors (Miro today; gdrive/gcal in phase 3) ---
    //
    // One route block serves every MCP connector — the descriptor in
    // connectors/mcp-connector-defs.mjs carries everything provider-specific.
    // This is the `test` endpoint of the Mac manifest's four; fetch/seen/
    // classify join it in phase 2b.
    if (req.method === 'POST' && url === '/kb/mcp-connector/test') {
      const body = parseJSON(await readBody(req)) || {};
      const def = mcpConnectorDef(typeof body.id === 'string' ? body.id : '');
      if (!def) {
        sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Unknown MCP connector id' } });
        return true;
      }
      try {
        const r = await testMcpConnection(kb.getDb(), userId, def);
        logger.info('mcp_connector_test', { userId, connector: def.id, tools: r.tools.length });
        sendJSON(res, 200, { ok: true, ...r });
      } catch (e) {
        // "Connect it first" is a user action, not a server fault — 400, so
        // the Mac card offers Connect instead of a retry.
        if (e?.code === 'MCP_UNAUTHORIZED') {
          sendJSON(res, 400, { error: { code: 'MCP_UNAUTHORIZED', message: e.message } });
          return true;
        }
        logger.error('mcp_connector_test_failed', { userId, connector: def.id, reason: redactSecrets(e.message) });
        sendJSON(res, 502, { error: { code: 'MCP_CONNECT_FAILED', message: redactSecrets(e.message) } });
      }
      return true;
    }
```

**3b — `extension/server.mjs`.** Append to the version log, immediately above `const SERVER_API_VERSION`:

```js
// 37→38: MCP-backed connectors, phase 2a. New POST /kb/mcp-connector/test
//     ({ id } -> { ok, server, tools }) proves an authenticated round trip
//     against a remote MCP server. The /auth/mcp-connector/{start,callback,
//     status} routes land in the same change but are /auth/* paths — not
//     tracked in ENDPOINTS by convention.
const SERVER_API_VERSION = 38;
```

In `ENDPOINTS`, after `'/kb/box/test'`:

```js
  '/kb/mcp-connector/test',
```

And the bucket, immediately after the `/kb/box/test` line (:265):

```js
  // MCP connector test opens a real session to a remote MCP server (discovery
  // + token refresh + initialize + tools/list) — same externally-directed cost
  // profile as slack/box/email test, so the same dispatch bucket.
  if (url === '/kb/mcp-connector/test') return 'dispatch';
```

**3c — docs.** In `docs/reference/api/openapi.yaml`, beside `/kb/slack/test` (:494):

```yaml
  /kb/mcp-connector/test:
    post:
      summary: Verify a remote MCP connector's saved OAuth tokens (connect + tools/list)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [id]
              properties:
                id: { type: string, enum: [miro] }
      responses:
        '200':
          description: Connected — server identity and available tools
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok:     { type: boolean }
                  server: { type: object, properties: { name: { type: string }, version: { type: string } } }
                  tools:  { type: array, items: { type: string } }
        '400': { description: Unknown connector id, or not connected (MCP_UNAUTHORIZED), content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
        '502': { description: MCP connection failed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
```

In `docs/spec/api-server.md:238`, add `` `/kb/mcp-connector/test` `` to the `dispatch` bucket's path list.

- [ ] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/kb-router-mcp-connector.test.mjs tests/kb-router.test.mjs tests/kb-router-slack.test.mjs tests/server-control-plane.test.mjs && npm run lint`
Expected: PASS all four — the router and control-plane suites must show no regression from the `server.mjs` edits.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/router.mjs extension/server.mjs extension/tests/kb-router-mcp-connector.test.mjs docs/reference/api/openapi.yaml docs/spec/api-server.md
git commit -m "feat(routes): POST /kb/mcp-connector/test authenticated round trip"
```

---

## Final verification (after all tasks)

- [ ] `cd extension && npm run lint && npm test` — green. Watch for two things specifically: the new suites bind loopback ports (nothing else in `tests/` does), and `tests/fixtures/fake-mcp-oauth-server.mjs` must not be picked up as a test file (the glob is `tests/**/*.test.{ts,mjs}`).
- [ ] `cd mac && swift build && swift test` — green. Phase 2a touches no Swift; this only confirms nothing drifted.
- [ ] `grep -rn "mcp.miro.com" extension/tests/` returns nothing — no test may reference the real server.
- [ ] Manual smoke against real Miro (optional, needs a Miro account and a running server):
  `curl -s -X POST localhost:3456/auth/mcp-connector/start -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"id":"miro"}'` → open the returned `authUrl`, consent, then
  `curl -s -X POST localhost:3456/kb/mcp-connector/test -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"id":"miro"}'` → `{ ok: true, server: { name: "…" }, tools: [ … ] }`.
  If the discovered issuer is not `https://miro.com/`, nothing breaks — `mcp.miro.issuer` records whatever discovery reports and the key namespace follows it.
  On an Enterprise plan with MCP disabled by an admin, expect the start route's actionable 502, not a silent empty result (spec Risks: "Enterprise gating").
- [ ] Regression Loop stage green.

## Deferred (do NOT do in Phase 2a)

- **Phase 2b:** generic `fetch`/`seen`/`classify` endpoints, `listTool`/`readTool`/`mapItem` in the descriptors, the three Mac manifest JSONs, the single `McpConnectorAdapter`, `SourceRegistry.all` wiring, Miro end-to-end into `llm-doc/miro/`, chunking large tool results.
- **Phase 3:** Google Drive and Calendar descriptors, the BYO-client setup UI, scope handling. The `byoClient` / `byoClientIdKey` / `byoClientSecretKey` plumbing exists and is unit-tested, but no Google descriptor ships and no BYO OAuth round trip has been exercised end to end.
- Flipping `pipelineReady: true` in `connectors/connector-catalog.mjs`; any Settings or Library UI; the `SourceRegistry.fetchSources` sweep.
- Connection pooling, `discoveryState()` caching, and token pre-emptive refresh — all deliberately absent; revisit only if a real profile says they matter.

---

### Critical Files for Implementation

- `/Users/dinsmallade/llm-ide/extension/connectors/mcp-client.mjs` (create — Task 4, the core of the phase)
- `/Users/dinsmallade/llm-ide/extension/tests/fixtures/fake-mcp-oauth-server.mjs` (create — Task 3, everything else is tested through it)
- `/Users/dinsmallade/llm-ide/extension/connectors/mcp-connector-defs.mjs` (create — Task 2)
- `/Users/dinsmallade/llm-ide/extension/server/auth-routes.mjs` (modify — Task 5; slack callback ends :464, slack status ends :600, `isAuthRoute` :152-206)
- `/Users/dinsmallade/llm-ide/extension/routes/router.mjs` (modify — Task 6; Box block ends ~:700) and `/Users/dinsmallade/llm-ide/extension/server.mjs` (`SERVER_API_VERSION` :95, `ENDPOINTS` :96, buckets :265)
