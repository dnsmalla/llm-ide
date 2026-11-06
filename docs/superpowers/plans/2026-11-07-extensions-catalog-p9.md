# Extensions catalog P9 rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the extensions catalog rollout: the core ties every enable to the commit the user consented to, the desktop screen says truthfully which chats honour its switches, the catalog switches become the default on Claude turns (P8, the user decides), and the desktop Extensions screen and Settings cards get their first real-window check.

**Architecture:** Two small, additive changes to the existing catalog routes (`extension/routes/extensions-catalog.mjs`, API 117 → 118): `POST /auth/me/extensions/toggle` takes `commit` and refuses a mismatch, and `GET /auth/me/extensions/active` reports `turns { claude, providers }`. The desktop screen (`ui/screens/library/extensions/`) sends the commit and shows a scope note. One flag default flips in `extension/llm_agent/extensions/flags.mjs`. No new route, no new dependency, no new network call, no new Tauri command.

**Tech Stack:** Node 20+ core (pure HTTP, `node:test`), React 19 + TypeScript screens tested with `node --test --experimental-strip-types`, JSON Schema contract in `schema/http/`.

**Spec:** [docs/superpowers/plans/2026-10-31-extensions-catalog.md](2026-10-31-extensions-catalog.md) (sections 11, 12, 14, 16, 16a) and [docs/spec/extensions-catalog.md](../../spec/extensions-catalog.md) (§5, §9, §9b). The MASTER-PLAN S8 row this plan closes: "Extensions catalog rollout (P9) and a real-window check of the desktop Extensions screen and cards (plan 2026-10-31)".

## Global Constraints

- No new dependency. (None is needed; if one becomes unavoidable: exact pin, released at least 2 weeks ago.)
- No new network call. Any network call goes through `extension/server/pinned-fetch.mjs` or `extension/server/fixed-host-fetch.mjs`; `extension/tests/provider-fetch-pinned-guard.test.mjs` forbids a bare `fetch`.
- Module boundaries: `extension/eslint.config.mjs` layer table at zero violations. Routes (`routes/`) may import `llm_agent/`; `llm_agent/`, `mcp/`, `plugins/` never import `routes/` or `server/*-routes.mjs`; `mcp/` never imports `server/`.
- API bump checklist for every wire change: `SERVER_API_VERSION` in `extension/server.mjs` + a `vNNN` comment line above it, `APP_API_VERSION` in `ui/screens/shell/core-api-floor.ts`, `docs/spec/api-server.md` and `docs/spec/cross-cutting.md` ("`SERVER_API_VERSION = NNN`"), `schema/http/extensions.schema.json` + fixtures in `schema/http/fixtures/extensions/`, then `node scripts/gen-api-types.mjs`, `node scripts/gen-openapi.mjs`, `node scripts/http-inventory.mjs --check`. This plan bumps once, 117 → 118, in Task 1; Task 2 extends 118 (both stay unpushed between them; if Task 1 was pushed first, Task 2 bumps to 119 with the same checklist).
- Desktop capability rules (`desktop/scripts/check-capabilities.mjs`): this plan adds no Tauri command and no capability; do not touch `desktop/src-tauri/capabilities/`.
- User decisions already made (plan 2026-10-31 §14): downloads are user-initiated only; scan findings warn, never block; one global extension format, each engine uses what it supports and skips the rest; the user's ACTIVE MCP servers mount automatically on tool-capable provider turns (`LLMIDE_EXT_ADAPTER` default on).
- The Swift Mac app was removed 2026-11-06. Everything the old plan aimed at the Mac now targets the Tauri desktop (`desktop/` + `ui/`) or is dropped (see "What of the old plan is done").
- Work on `main`, no branch, no push. Conventional Commits, one concern per commit, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stay out of the files a parallel agent owns: `extension/llm_agent/sdk/**` (incl. `engine.mjs`, `loop-agent.mjs`), chat engine, session-summary and chat-history code (plan 2026-11-07 ended-chat continuation); `desktop/src-tauri/src/**` notify/tray code, the web app service worker, `ios_app/**` (plan 2026-11-07 push notifications); `ui/screens/chat/**`.

## What of the old plan is done (read before starting)

| Old phase | State on `main` | Evidence |
|---|---|---|
| P0 baseline, P1 model + shadow, P2 consumers (flag), P3 adapter MCP | done | `a3897732`, `c25e1c46`, `ebf20127`, `c0b3067c` |
| P4 GitHub install at a pinned commit, P4b installed items in turns | done (GitHub only) | API 93, `55c93aff` |
| P5 updates, rollback, repair, indexes, search, active view | done | API 94, `f45111d6`, `464c94be` |
| Per-user allowlist + Workspace Trust | done | API 95, `39149259`, `80537643` |
| P6 Mac screen | done, then moot (Mac app removed) | `961e9462`, `a7613460` |
| P6 desktop screen (Installed, Browse, Install, consent and update sheets, badges, detail panes, legacy panes) and the Settings trust/allowlist card | done, never run in a real window | `8e00c2b0`, `35877de4`, `11299150`, `3b7bbd28`, `a9484f90`; parity checklist rows "Extensions: catalog view…" and "Extensions trust…" |
| M8 (consent bound to a commit) | client-side only: the screen re-reads the list before enabling (`2cefa174`); the core does not check | parity checklist row, "Security review M8" |
| P8 default flips | half: `LLMIDE_EXT_ADAPTER` is default on (user decision); `LLMIDE_EXT_ACTIVE_SET` is still default off, so on Claude turns the catalog switches are ignored and NO installed catalog item loads | `extension/llm_agent/extensions/flags.mjs` |
| P6 leftovers: token-estimate labels, family switches, required-item lock, N-1 fallback | not done; this plan defers or drops them (decision D6) | plan 16a "Not done" |
| P7 our skills diet | not started; deferred (D3) | |
| P9 per-tool MCP deny list, phone list | not started; deferred (D4, D5) | |

Retargeted or dropped Mac items: the Mac screen → the desktop screen (done); "Mac pref: use the Extensions catalog screens" kill switch → dropped (the desktop has only the catalog screen); Mac N-1 server fallback → dropped (the desktop bundles its own core; `core-api-floor.ts` warns on an older adopted core); Mac real-app check → Task 5 desktop real-window check; Mac Mobile Control phone list → dropped with the Mac, a phone list later goes through the iPhone app (D5).

## File structure

| File | Change | Responsibility |
|---|---|---|
| `extension/llm_agent/extensions/install.mjs` | modify `setInstalledEnabled` | refuse an enable whose commit is missing (item runs code) or differs from the pin |
| `extension/routes/extensions-catalog.mjs` | modify `STATUS`, toggle branch, `activeView` | pass `commit`, map `commit_changed` to 409, add `turns` |
| `extension/server.mjs` | modify | API 118 + `v118` comment |
| `schema/http/extensions.schema.json` | modify | toggle request `commit`; active response `turns` |
| `schema/http/fixtures/extensions/post-auth-me-extensions-toggle-409-commit.json` | create | the mismatch answer |
| `schema/http/fixtures/extensions/get-auth-me-extensions-active-200.json` | modify | carries `turns` |
| `extension/tests/extensions-catalog-routes.test.mjs` | modify | binding and `turns` tests |
| `ui/screens/library/extensions/{api,model,errors,decoders,presentation}.ts`, `ExtensionsScreen.tsx` | modify | send the commit, handle `COMMIT_CHANGED`, decode `turns`, show the scope note |
| `ui/screens/library/extensions/tests/{model,decoders,presentation}.test.ts` | modify | the client side of both |
| `ui/screens/shell/core-api-floor.ts`, `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, `docs/spec/extensions-catalog.md` | modify | version and contract text |
| `extension/llm_agent/extensions/flags.mjs` + four test files | modify (Task 4, only if D1 = a) | `LLMIDE_EXT_ACTIVE_SET` default on |
| `docs/superpowers/plans/2026-10-31-tauri-parity-checklist.md`, `docs/superpowers/plans/2026-10-31-extensions-catalog.md`, `docs/superpowers/MASTER-PLAN.md`, `desktop/parity/extensions-*.png` | modify / create (Task 5) | real-window results and status |

---

### Task 1: The core binds an enable to the consented commit (M8), API 118 (30 min)

**Files:**
- Modify: `extension/llm_agent/extensions/install.mjs` (`setInstalledEnabled`, about line 172)
- Modify: `extension/routes/extensions-catalog.mjs` (header comment line 7, `STATUS` about line 64, toggle branch about line 213)
- Modify: `extension/server.mjs` (`SERVER_API_VERSION` about line 332 and the comment block above it)
- Modify: `schema/http/extensions.schema.json` (`POST /auth/me/extensions/toggle` request, about line 565)
- Create: `schema/http/fixtures/extensions/post-auth-me-extensions-toggle-409-commit.json`
- Modify: `ui/screens/library/extensions/errors.ts` (`KNOWN_CODES` and `errorText`; the UI errors test requires every fixture code to be known)
- Modify: `ui/screens/shell/core-api-floor.ts`, `docs/spec/api-server.md:54`, `docs/spec/cross-cutting.md:184`, `docs/spec/extensions-catalog.md` (§9 toggle row)
- Test: `extension/tests/extensions-catalog-routes.test.mjs`

**Interfaces:**
- Consumes: `isCommitSha(v): boolean` from `extension/llm_agent/extensions/sources/github.mjs` (already imported by `install.mjs`); `InstallError(code, message, extra)`.
- Produces: `setInstalledEnabled(userId, id, enabled, { consents = [], commit } = {})`. With `enabled === true`: `commit` must be a 40-hex string equal to the item's `pinnedCommit`, else `InstallError('commit_changed', …, { pinnedCommit })` (HTTP 409 `COMMIT_CHANGED`, `details.pinnedCommit`); `commit` that is present but not 40-hex is `invalid_commit` (400 `INVALID_COMMIT`); `commit` omitted on an item that declares executable kinds is `invalid_commit` with message `commit is required to enable an item that runs code` (D2); `commit` omitted on an item with no executable kind is accepted (old clients). Disabling ignores `commit`. Wire: toggle body `{ id, enabled, consents?, members?, commit? }`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/extensions-catalog-routes.test.mjs`:

```js
test('M8: enabling is bound to the commit the user consented to', async () => {
  const u = { id: 'm8' };
  const ins = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/runner', commit: SHA }, u);
  assert.equal(ins.status, 200);
  const id = ins.body.item.id;

  const noCommit = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true, consents: ['hook'] }, u);
  assert.equal(noCommit.status, 400, 'an item that runs code needs the commit');
  assert.equal(noCommit.body.error.code, 'INVALID_COMMIT');

  const bad = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true, consents: ['hook'], commit: 'abc' }, u);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_COMMIT');

  const other = 'f'.repeat(40);
  const moved = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true, consents: ['hook'], commit: other }, u);
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error.code, 'COMMIT_CHANGED');
  assert.equal(moved.body.error.details.pinnedCommit, SHA);
  assert.equal((await call('GET', '/auth/me/extensions/installed', undefined, u)).body.items[0].state.enabled, false, 'nothing switched on');

  const yes = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true, consents: ['hook'], commit: SHA }, u);
  assert.equal(yes.status, 200);
  assert.equal(yes.body.item.state.enabled, true);

  const off = await call('POST', '/auth/me/extensions/toggle', { id, enabled: false, commit: other }, u);
  assert.equal(off.status, 200, 'switching off never needs the commit');
  assert.equal(off.body.item.state.enabled, false);
});

test('M8: an item with no executable part still enables without a commit (older clients)', async () => {
  const u = { id: 'm8b' };
  await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA }, u);
  const on = await call('POST', '/auth/me/extensions/toggle', { id: 'skill:acme/tidy', enabled: true }, u);
  assert.equal(on.status, 200);
  const moved = await call('POST', '/auth/me/extensions/toggle', { id: 'skill:acme/tidy', enabled: true, commit: 'f'.repeat(40) }, u);
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error.code, 'COMMIT_CHANGED');
});
```

Also update the existing consent test (line ~92) so it still passes once the commit is required:

```js
  const yes = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true, consents: ['hook'], commit: SHA });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && node --test tests/extensions-catalog-routes.test.mjs`
Expected: FAIL — `M8: enabling is bound…` gets 200 instead of 400 for `noCommit`; `M8: an item with no executable part…` gets 200 instead of 409.

- [ ] **Step 3: Implement in `install.mjs`**

Replace the head of `setInstalledEnabled` (signature and the `if (enabled === true) {` block start) so it reads:

```js
export function setInstalledEnabled(userId, id, enabled, { consents = [], commit } = {}) {
  const installed = readInstalled(userId);
  const rec = installed.items.get(id);
  if (!rec) throw new InstallError('not_found', 'not installed');
  if (installed.corrupt || readOverlay(userId).corrupt) throw new InstallError('state_unreadable', 'extensions state cannot be read');
  if (enabled === true) {
    const need = Array.isArray(rec.declared?.executableKinds) ? rec.declared.executableKinds : [];
    if (commit !== undefined && !isCommitSha(commit)) throw new InstallError('invalid_commit', 'commit must be 40 hex characters');
    const given = new Set((Array.isArray(consents) ? consents : []).filter((c) => typeof c === 'string'));
    const missing = need.filter((k) => !given.has(k));
    if (missing.length) throw new InstallError('consent_required', 'this item can run code; consent to each kind first', { kinds: missing });
    // The consent names the code at one commit; an enable for any other commit (a stale client list) is refused.
    if (commit === undefined && need.length) throw new InstallError('invalid_commit', 'commit is required to enable an item that runs code');
    if (commit !== undefined && commit !== rec.pinnedCommit) throw new InstallError('commit_changed', 'the item is pinned to another commit; review it again', { pinnedCommit: rec.pinnedCommit });
```

Delete the two old lines that computed `missing` and threw `consent_required` (they moved up). The rest of the function — the consent write under `if (need.length)`, `setItemEnabled`, `return view(userId, id)` — is unchanged. `isCommitSha` is already imported from `./sources/github.mjs` at line 22. The consent check stays first on purpose: an enable without consents must still answer 409 `CONSENT_REQUIRED` with the kinds, because the screen opens its consent sheet from that answer (existing tests at `extensions-catalog-routes.test.mjs:88` and `extensions-install.test.mjs:158` pin it).

- [ ] **Step 4: Implement in the route**

In `extension/routes/extensions-catalog.mjs`:

Header comment line 7 becomes:

```js
//   POST /auth/me/extensions/toggle     { id, enabled, consents?: string[], members?: string[], commit? }   enable is bound to commit (API 118)
```

In `STATUS`, add `commit_changed: 409` to the line that holds `already_current`:

```js
  already_current: 409, update_changed: 409, commit_changed: 409, bytes_missing: 409, integrity_mismatch: 409, no_previous: 404, previous_unavailable: 409, identity_changed: 422,
```

In the toggle branch replace the `setInstalledEnabled` call:

```js
        : setInstalledEnabled(userId, body.id, body.enabled, { consents: body.consents ?? [], commit: body.commit });
```

(`setInstalledEnabled` validates `commit`; a non-string reaches `isCommitSha` and is `INVALID_COMMIT`.)

- [ ] **Step 5: Run the tests to verify they pass**

Existing tests that enable an item WITH consents now need the commit. Find them:

```bash
grep -n "setInstalledEnabled(.*consents\|toggle.*consents" extension/tests/*.mjs
```

There are 10 such sites today, in `extensions-adapter.test.mjs`, `extensions-catalog-routes.test.mjs` (the line ~92 edit above), `extensions-installed-runtime.test.mjs`, `extensions-install.test.mjs` and `extensions-update.test.mjs`. In each, add `commit: <the item's current pin>` to the options object: the test's `SHA` constant for a freshly installed item, or the record's `pinnedCommit` (for example `inst.listInstalled(u).items.find((i) => i.id === id).pinnedCommit`) after an update or rollback moved it. Example (`extensions-install.test.mjs:164`):

```js
  const on = inst.setInstalledEnabled('ua', item.id, true, { consents: ['bin', 'hook', 'mcp'], commit: item.pinnedCommit });
```

Sites that expect `consent_required` (no or partial consents) stay as they are.

Run: `cd extension && node --test tests/extensions-catalog-routes.test.mjs tests/extensions-install.test.mjs tests/extensions-installed-runtime.test.mjs tests/extensions-adapter.test.mjs tests/extensions-update.test.mjs`
Expected: PASS.

- [ ] **Step 6: Contract, fixture, UI error text, version**

Schema — in `"POST /auth/me/extensions/toggle"` → `request.body.properties`, after `"members"`, add:

```json
            "commit": {
              "type": "string",
              "x-optional": true
            }
```

Create `schema/http/fixtures/extensions/post-auth-me-extensions-toggle-409-commit.json`:

```json
{
  "endpoint": "POST /auth/me/extensions/toggle",
  "status": 409,
  "request": {
    "body": {
      "id": "plugin:acme/runner",
      "enabled": true,
      "consents": [
        "hook"
      ],
      "commit": "ffffffffffffffffffffffffffffffffffffffff"
    }
  },
  "response": {
    "error": {
      "code": "COMMIT_CHANGED",
      "message": "the item is pinned to another commit; review it again",
      "details": {
        "pinnedCommit": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      }
    }
  }
}
```

`ui/screens/library/extensions/errors.ts`: add `"COMMIT_CHANGED",` to `KNOWN_CODES` directly after `"UPDATE_CHANGED",`, and in `errorText` after the `UPDATE_CHANGED` case:

```ts
    case "COMMIT_CHANGED":
      return "That item changed while you were deciding, so it was not switched on. Switch it on again to review it.";
```

Version: in `extension/server.mjs` set `const SERVER_API_VERSION = 118;` and add above the `v117` comment line:

```js
//   v118 — additive: POST /auth/me/extensions/toggle takes commit (40 hex). Enabling is bound to it: a commit other than the item's pinnedCommit answers 409 COMMIT_CHANGED { details.pinnedCommit } and changes nothing; an item that declares executable kinds needs it (400 INVALID_COMMIT without it); disabling ignores it. Spec docs/spec/extensions-catalog.md §9.
```

Set `export const APP_API_VERSION = 118;` in `ui/screens/shell/core-api-floor.ts`; change `SERVER_API_VERSION = 117` to `118` in `docs/spec/api-server.md:54` and `docs/spec/cross-cutting.md:184`. In `docs/spec/extensions-catalog.md` §9 replace the toggle row with:

```markdown
| `POST /auth/me/extensions/toggle` | `{ id, enabled, consents?, members?, commit? }` | `{ ok, item }`. With `members` (member ids of the item) it checks or unchecks those members instead of the item. Enabling is bound to `commit` (API 118): another commit than `pinnedCommit` is 409 `COMMIT_CHANGED` (`details.pinnedCommit`), nothing changes; an item with executable kinds needs it (400 `INVALID_COMMIT`); disabling ignores it |
```

Regenerate and check:

```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs --check && node scripts/conformance-http.mjs
cd desktop && node --test --experimental-strip-types ../ui/screens/library/extensions/tests/errors.test.ts ../ui/screens/library/extensions/tests/decoders.test.ts ../ui/screens/shell/tests/core-api-floor.test.mjs
cd ../extension && npx eslint routes/extensions-catalog.mjs llm_agent/extensions/install.mjs
```

Expected: all exit 0; `extension/src/lib/api-types.ts` and `docs/reference/api/openapi.yaml` (`x-api-version: 118`) change, `schema/http/INVENTORY.md` does not.

- [ ] **Step 7: Commit**

```bash
git add extension/llm_agent/extensions/install.mjs extension/routes/extensions-catalog.mjs extension/server.mjs extension/tests/extensions-catalog-routes.test.mjs extension/tests/extensions-install.test.mjs extension/tests/extensions-installed-runtime.test.mjs extension/tests/extensions-adapter.test.mjs extension/tests/extensions-update.test.mjs extension/src/lib/api-types.ts schema/http/extensions.schema.json schema/http/fixtures/extensions/post-auth-me-extensions-toggle-409-commit.json ui/screens/library/extensions/errors.ts ui/screens/shell/core-api-floor.ts docs/spec/api-server.md docs/spec/cross-cutting.md docs/spec/extensions-catalog.md docs/reference/api/openapi.yaml
git commit -m "feat(extensions): bind an enable to the consented commit, API 118" -m "Closes security review M8 on the server side." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: GET active says which turns honour the switches (15 min)

**Files:**
- Modify: `extension/routes/extensions-catalog.mjs` (imports, `activeView`)
- Modify: `extension/server.mjs` (the `v118` comment line from Task 1)
- Modify: `schema/http/extensions.schema.json` (`GET /auth/me/extensions/active` 200, about line 787)
- Modify: `schema/http/fixtures/extensions/get-auth-me-extensions-active-200.json`
- Modify: `docs/spec/extensions-catalog.md` (§9b `GET /auth/me/extensions/active` row, about line 201)
- Test: `extension/tests/extensions-catalog-routes.test.mjs`

**Interfaces:**
- Consumes: `activeSetEnabled(): boolean`, `adapterEnabled(): boolean` from `extension/llm_agent/extensions/flags.mjs`.
- Produces: `GET /auth/me/extensions/active` 200 gains `turns: { claude: boolean, providers: boolean }` — `claude` true when Claude (Agent SDK) turns follow the catalog switches and load installed items (`LLMIDE_EXT_ACTIVE_SET`), `providers` true when provider-adapter turns do (`LLMIDE_EXT_ADAPTER`). Read at request time.

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/extensions-catalog-routes.test.mjs`:

```js
test('active: turns says which chats follow the switches, read at request time', async () => {
  const u = { id: 'turns' };
  try {
    process.env.LLMIDE_EXT_ACTIVE_SET = '1';
    delete process.env.LLMIDE_EXT_ADAPTER;
    assert.deepEqual((await call('GET', '/auth/me/extensions/active', undefined, u)).body.turns, { claude: true, providers: true });
    process.env.LLMIDE_EXT_ACTIVE_SET = '0';
    process.env.LLMIDE_EXT_ADAPTER = 'off';
    assert.deepEqual((await call('GET', '/auth/me/extensions/active', undefined, u)).body.turns, { claude: false, providers: false });
  } finally {
    delete process.env.LLMIDE_EXT_ACTIVE_SET;
    delete process.env.LLMIDE_EXT_ADAPTER;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --test-name-pattern="turns says" tests/extensions-catalog-routes.test.mjs`
Expected: FAIL — `actual: undefined`.

- [ ] **Step 3: Implement**

In `extension/routes/extensions-catalog.mjs` add to the imports:

```js
import { activeSetEnabled, adapterEnabled } from '../llm_agent/extensions/flags.mjs';
```

In `activeView`, after `warnings: …,` add:

```js
    // Which chats follow these switches right now (operator flags), so a screen never claims more than is true.
    turns: { claude: activeSetEnabled(), providers: adapterEnabled() },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd extension && node --test tests/extensions-catalog-routes.test.mjs && npx eslint routes/extensions-catalog.mjs`
Expected: PASS, no lint error.

- [ ] **Step 5: Contract, fixture, docs**

Schema — in `"GET /auth/me/extensions/active"` → `responses.200.properties`, after `"warnings"`, add:

```json
            "turns": {
              "type": "object",
              "properties": {
                "claude": {
                  "type": "boolean"
                },
                "providers": {
                  "type": "boolean"
                }
              },
              "required": [
                "claude",
                "providers"
              ]
            }
```

and add `"turns"` to that response's `required` list (after `"warnings"`). In `get-auth-me-extensions-active-200.json` add after `"warnings": []`:

```json
    ,"turns": {
      "claude": false,
      "providers": true
    }
```

(Keep the file valid JSON: the comma goes after `"warnings": []`.) Check `get-auth-me-extensions-active-401.json` needs nothing. Append to the `v118` comment line in `extension/server.mjs`: ` GET /auth/me/extensions/active answers turns { claude, providers } (whether Claude turns and provider-adapter turns follow the catalog switches).` In `docs/spec/extensions-catalog.md` §9b, the `GET /auth/me/extensions/active` row's result becomes `the view above, plus turns { claude, providers } (API 118): which chats follow the switches (LLMIDE_EXT_ACTIVE_SET, LLMIDE_EXT_ADAPTER)`.

Run:

```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/conformance-http.mjs && node scripts/http-inventory.mjs --check
cd desktop && node --test --experimental-strip-types ../ui/screens/library/extensions/tests/decoders.test.ts
```

Expected: exit 0 (the desktop decoder ignores the new field until Task 3).

- [ ] **Step 6: Commit**

```bash
git add extension/routes/extensions-catalog.mjs extension/server.mjs extension/tests/extensions-catalog-routes.test.mjs extension/src/lib/api-types.ts schema/http/extensions.schema.json schema/http/fixtures/extensions/get-auth-me-extensions-active-200.json docs/spec/extensions-catalog.md docs/reference/api/openapi.yaml
git commit -m "feat(extensions): the active view says which chats follow the switches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Desktop screen sends the commit and says where switches apply (30 min)

**Files:**
- Modify: `ui/screens/library/extensions/api.ts` (`ExtensionsApi.toggle`, `createExtensionsApi` toggle)
- Modify: `ui/screens/library/extensions/model.ts` (`toggle`, about line 300)
- Modify: `ui/screens/library/extensions/decoders.ts` (`ActiveSummary`, `decodeActive`, about line 432)
- Modify: `ui/screens/library/extensions/presentation.ts` (new `activeScopeNote`)
- Modify: `ui/screens/library/extensions/ExtensionsScreen.tsx` (the "In chats now" block, about line 81)
- Test: `ui/screens/library/extensions/tests/model.test.ts`, `decoders.test.ts`, `presentation.test.ts`

**Interfaces:**
- Consumes: Task 1 wire field `commit` and code `COMMIT_CHANGED` (already in `KNOWN_CODES`); Task 2 field `turns`.
- Produces: `ExtensionsApi.toggle(req: { id: string; enabled: boolean; consents?: readonly string[]; commit?: string }, signal?)`; `ActiveSummary.turns: { claude: boolean; providers: boolean } | null` (null for a core before API 118); `activeScopeNote(a: ActiveSummary): string | null`.

- [ ] **Step 1: Write the failing tests**

`model.test.ts` — change the two exact-body asserts:

```ts
  assert.deepEqual(posts(core, "toggle")[0]!.body, { id: "skill:acme/tidy", enabled: true, commit: E });
```

```ts
  assert.deepEqual(posts(core, "toggle")[0]!.body, { id: "plugin:acme/runner", enabled: true, consents: ["hook"], commit: E });
```

and append:

```ts
test("M8: COMMIT_CHANGED from the core re-reads the list and switches nothing on", async () => {
  const { core, model, setItems } = setup({ [`POST ${P}/toggle`]: () => err(409, "COMMIT_CHANGED", { pinnedCommit: F }) });
  await model.init();
  setItems([runnerBody({ pinnedCommit: F }), ...baseItems().filter((i) => i.id !== "plugin:acme/runner")]);
  const reads = () => core.calls.filter((c) => c.method === "GET" && c.path === `${P}/installed`).length;
  const r0 = reads();
  await model.requestEnable(model.item("skill:acme/tidy")!);
  assert.ok(reads() > r0, "re-read the installed list");
  assert.equal(model.getSnapshot().notice!.error, true);
  assert.match(model.getSnapshot().notice!.text, /changed while you were deciding/);
});

test("disabling sends no commit", async () => {
  const { core, model } = setup({ [`POST ${P}/toggle`]: () => reply("post-auth-me-extensions-toggle-200") });
  await model.init();
  await model.disable(model.item("skill:acme/tidy")!);
  assert.deepEqual(posts(core, "toggle")[0]!.body, { id: "skill:acme/tidy", enabled: false });
});
```

`decoders.test.ts` — extend "the active summary exposes counts, never configs":

```ts
  assert.deepEqual(a.turns, { claude: false, providers: true });
  const { turns: _drop, ...older } = fx("get-auth-me-extensions-active-200").response as Record<string, unknown>;
  assert.equal(decodeActive(older).turns, null, "a core before API 118 has no turns");
  assert.throws(() => decodeActive({ ...older, turns: { claude: "yes", providers: true } }), DecodeError);
```

`presentation.test.ts` — add `activeScopeNote` to the import from `../presentation.ts` and `decodeActive` to the import from `../decoders.ts`, then append:

```ts
test("activeScopeNote says which chats ignore the switches, and nothing when all follow them", () => {
  const base = decodeActive(fx("get-auth-me-extensions-active-200").response);
  assert.equal(activeScopeNote({ ...base, turns: { claude: true, providers: true } }), null);
  assert.equal(activeScopeNote({ ...base, turns: null }), null);
  assert.match(activeScopeNote({ ...base, turns: { claude: false, providers: true } })!, /^Claude chats do not use these switches yet/);
  assert.match(activeScopeNote({ ...base, turns: { claude: true, providers: false } })!, /^Provider-model chats do not load/);
  const both = activeScopeNote({ ...base, turns: { claude: false, providers: false } })!;
  assert.match(both, /Claude chats/);
  assert.match(both, /Provider-model chats/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/library/extensions/tests/model.test.ts ../ui/screens/library/extensions/tests/decoders.test.ts ../ui/screens/library/extensions/tests/presentation.test.ts`
Expected: FAIL — bodies lack `commit`; `a.turns` is `undefined`; `activeScopeNote` is not exported.

- [ ] **Step 3: Implement `api.ts`**

Interface line:

```ts
  toggle(req: { id: string; enabled: boolean; consents?: readonly string[]; commit?: string }, signal?: AbortSignal): Promise<ItemResult>;
```

Implementation line:

```ts
    toggle: (req, signal) => post(`${BASE}/toggle`, { id: req.id, enabled: req.enabled, ...(req.consents && req.consents.length > 0 ? { consents: [...req.consents] } : {}), ...(req.enabled && req.commit ? { commit: req.commit } : {}) }, decodeItemResult, signal),
```

- [ ] **Step 4: Implement `model.ts`**

In `private async toggle(...)` send the pin on enable, and treat `COMMIT_CHANGED` like a moved item:

```ts
        const r = await this.api.toggle({ id: item.id, enabled, consents: consents ?? undefined, commit: enabled ? item.pinnedCommit : undefined }, this.signal);
```

and, as the first statement of the `catch (e)` block:

```ts
        if (enabled && e instanceof ExtApiError && e.code === "COMMIT_CHANGED") {
          // The core holds another pin than the list we showed: show the fresh list, switch nothing on.
          await this.loadInstalled();
          this.info(`${item.name} changed while you were deciding. Switch it on again to review it.`);
          return;
        }
```

Keep the existing re-read in `confirmConsent` (D7: belt and braces for an adopted older core).

- [ ] **Step 5: Implement `decoders.ts`**

In `ActiveSummary` add `turns: { claude: boolean; providers: boolean } | null;`. In `decodeActive`'s returned object add:

```ts
    turns: o.turns == null ? null : (() => {
      const t = rec(o.turns, "active.turns");
      return { claude: bool(t.claude, "active.turns.claude"), providers: bool(t.providers, "active.turns.providers") };
    })(),
```

- [ ] **Step 6: Implement `presentation.ts` and the screen**

Add `ActiveSummary` to the type import from `./decoders.ts`, then append:

```ts
/** Which chats ignore the Extensions switches right now (operator flags), or null when every chat follows them or the core is too old to say. */
export function activeScopeNote(a: ActiveSummary): string | null {
  if (!a.turns) return null;
  const parts: string[] = [];
  if (!a.turns.claude) parts.push("Claude chats do not use these switches yet: they load what the Plugins, MCP and Skill bundle panes turned on, and no item installed here.");
  if (!a.turns.providers) parts.push("Provider-model chats do not load MCP servers from here (turned off on this computer).");
  return parts.length ? parts.join(" ") : null;
}
```

In `ExtensionsScreen.tsx` import `activeScopeNote` from `./presentation.ts` and replace the "In chats now" block with:

```tsx
      {state.tab === "installed" && state.active && (
        <>
          <p className="lib-muted ext-active" role="status">
            In chats now: {state.active.skills.toLocaleString()} skills, {state.active.mcpServers.toLocaleString()} MCP servers, {state.active.sdkPlugins.toLocaleString()} plugins.
          </p>
          {activeScopeNote(state.active) && <p className="lib-muted ext-active" role="note">{activeScopeNote(state.active)}</p>}
        </>
      )}
```

- [ ] **Step 7: Run the screen tests and the type check**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/library/extensions/tests/*.test.* && npx tsc --noEmit`
Expected: PASS, no type error. (`components.test.mjs` renders the screen with the fixture; the fixture says `claude: false`, so the note renders — if a component test asserts the exact status text set, add the note text to it.)

- [ ] **Step 8: Commit**

```bash
git add ui/screens/library/extensions/api.ts ui/screens/library/extensions/model.ts ui/screens/library/extensions/decoders.ts ui/screens/library/extensions/presentation.ts ui/screens/library/extensions/ExtensionsScreen.tsx ui/screens/library/extensions/tests/model.test.ts ui/screens/library/extensions/tests/decoders.test.ts ui/screens/library/extensions/tests/presentation.test.ts ui/screens/library/extensions/tests/components.test.mjs
git commit -m "feat(ui): Extensions screen sends the consented commit and says which chats follow its switches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: P8 — catalog switches on by default on Claude turns (25 min; only if the user picks D1 = a)

**Precondition:** decision D1 answered (a). If the answer is (b), skip this task and record "P8 waits for Y1" in Task 5.

**Files:**
- Modify: `extension/llm_agent/extensions/flags.mjs` (`activeSetEnabled` and its header comment)
- Modify: `extension/tests/extensions-active-set.test.mjs` (flags test, about line 138)
- Modify: `extension/tests/helpers/extensions-world.mjs:40`, `extension/tests/extensions-consumers.test.mjs:32`, `extension/tests/extensions-installed-runtime.test.mjs:65`, `extension/tests/extensions-adapter.test.mjs:89`
- Modify: `docs/spec/extensions-catalog.md` (§5 heading and text), `docs/superpowers/plans/2026-10-31-extensions-catalog.md` (§12 table row)

**Interfaces:**
- Consumes: nothing new.
- Produces: `activeSetEnabled()` true unless `LLMIDE_EXT_ACTIVE_SET` is `0|off|false|no` (same parsing as `adapterEnabled`). `gateFor`, `installed-runtime` and the shadow log read it unchanged. Task 2's `turns.claude` becomes true by default, so the Task 3 note disappears for a default install.

- [ ] **Step 1: Write the failing test**

Replace the flags test in `extension/tests/extensions-active-set.test.mjs`:

```js
test('flags: active set and adapter default on, each with =off as the kill switch', () => {
  assert.equal(flags.activeSetEnabled(), true);
  assert.equal(flags.adapterEnabled(), true);
  for (const [name, fn] of [['LLMIDE_EXT_ACTIVE_SET', flags.activeSetEnabled], ['LLMIDE_EXT_ADAPTER', flags.adapterEnabled]]) {
    for (const v of ['', '1', 'on', 'garbage']) { process.env[name] = v; assert.equal(fn(), true, `${name}=${v}`); }
    for (const v of ['off', 'OFF', '0', 'false', 'no']) { process.env[name] = v; assert.equal(fn(), false, `${name}=${v}`); }
    delete process.env[name];
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --test-name-pattern="flags:" tests/extensions-active-set.test.mjs`
Expected: FAIL — `activeSetEnabled()` is `false`.

- [ ] **Step 3: Implement**

In `flags.mjs`:

```js
export function activeSetEnabled() { return !OFF.has(read('LLMIDE_EXT_ACTIVE_SET')); }
```

and the header comment for it becomes:

```js
//   LLMIDE_EXT_ACTIVE_SET   default ON (P8, plan 2026-11-07 extensions-catalog-p9). The SDK plugin delivery, the skill
//                           set, the skill library ('/' menu, load-skill) and the user MCP builder honour the catalog's
//                           per-item and per-member switches, and installed, enabled, consented items load. `off` is
//                           the operator's kill switch: exact legacy behaviour.
```

- [ ] **Step 4: Make "off" explicit where tests meant it**

The old tests turned the flag off by deleting it; deletion now means on. Replace each of these lines with `process.env.LLMIDE_EXT_ACTIVE_SET = '0';`:

- `extension/tests/helpers/extensions-world.mjs:40` (`delete process.env.LLMIDE_EXT_ACTIVE_SET;`)
- `extension/tests/extensions-consumers.test.mjs:32` (`const flagOff = () => { delete process.env.LLMIDE_EXT_ACTIVE_SET; };` → `const flagOff = () => { process.env.LLMIDE_EXT_ACTIVE_SET = '0'; };`)
- `extension/tests/extensions-installed-runtime.test.mjs:65` (inside `afterEach`)
- `extension/tests/extensions-adapter.test.mjs:89` (inside `afterEach`)

Then: `grep -rn "delete process.env.LLMIDE_EXT_ACTIVE_SET" extension/tests` — the only hits left must be in `finally` blocks that restore a test's own change (e.g. Task 2's test, where on-by-default is fine).

- [ ] **Step 5: Run the whole core suite**

Run: `cd extension && npm test > "$TMPDIR/ext-p8.log" 2>&1; tail -40 "$TMPDIR/ext-p8.log"`
Expected: PASS. The golden `extensions-baseline` and `extensions-consumers` tests prove flag on equals legacy for unchanged data. **If any other test fails, stop:** that is a real difference between the catalog path and the legacy path for that test's data. Do not edit its assertion; report the test name and the diff to the user, and leave the default off (revert Step 3).

- [ ] **Step 6: Pipeline check and docs**

Run: `make token-bench-fake` — expected: exits 0 (the bench pipeline still runs; no model is called, so this measures nothing — the real paired bench is Y1, the user's item).

`docs/spec/extensions-catalog.md`: heading `## §5 Consumers behind `LLMIDE_EXT_ACTIVE_SET` (default off)` → `(default on since API 118; off = legacy)`, and the sentence "With the flag off nothing reads the overlay." → "With `LLMIDE_EXT_ACTIVE_SET=off` nothing reads the overlay." Plan 2026-10-31 §12 row: `| `LLMIDE_EXT_ACTIVE_SET` | 1 since 2026-11-07 (P8) | off = legacy builders; on = `computeActiveSet` drives every consumer |`.

- [ ] **Step 7: Commit**

```bash
git add extension/llm_agent/extensions/flags.mjs extension/tests/extensions-active-set.test.mjs extension/tests/helpers/extensions-world.mjs extension/tests/extensions-consumers.test.mjs extension/tests/extensions-installed-runtime.test.mjs extension/tests/extensions-adapter.test.mjs docs/spec/extensions-catalog.md docs/superpowers/plans/2026-10-31-extensions-catalog.md
git commit -m "feat(extensions): catalog switches on by default on Claude turns (P8)" -m "LLMIDE_EXT_ACTIVE_SET=off restores the legacy builders. The real paired token bench (Y1) has not run." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Real-window check of the desktop Extensions screen and cards, and status (25 min)

**Files:**
- Modify: `docs/superpowers/plans/2026-10-31-tauri-parity-checklist.md` (rows "Extensions: catalog view, installed, active set, toggle" and "Extensions trust: …")
- Modify: `docs/superpowers/plans/2026-10-31-extensions-catalog.md` (Status line, §16 table, new §16b)
- Modify: `docs/superpowers/MASTER-PLAN.md` (S8 rows)
- Create: `desktop/parity/extensions-installed-dark.png`, `desktop/parity/extensions-consent-dark.png`, `desktop/parity/settings-extension-sources-dark.png` (only if a window could be opened)

**Interfaces:**
- Consumes: Tasks 1-4 built into the app.
- Produces: recorded results; no code.

This task needs a real window. If this session cannot open one (no computer use, sandbox blocks `open`), do Steps 4-6 only, write "real window: not run" in each row, and leave the MASTER-PLAN row open for the user.

- [ ] **Step 1: Build and open the app**

```bash
cd ~/llm-ide && scripts/build-desktop-mac.sh
```

Then open the `.app` the script prints (see `desktop/RUN-ON-MAC.md`). Sign in.

- [ ] **Step 2: Walk the Extensions screen (Library > Extensions)**

Check each and note pass/fail with one sentence:
1. Installed tab lists groups by kind; arrow keys move through rows; the "In chats now" line shows; with Task 4 done there is no scope note, without it the "Claude chats do not use these switches yet…" note shows.
2. Browse tab shows the cached catalog without a network call; Refresh says it contacts the network.
3. Install tab: install `https://github.com/anthropics/skills` with a folder from that repository's `skills/` directory (pick one you see on GitHub). The result card names owner/repo and the full commit; the item is off.
4. Switch it on: a skill with no executable part switches on with no sheet; the "In chats now" skills count goes up by one.
5. A plugin that declares a hook (if one is installed): the consent sheet names each kind, Apply stays disabled until every kind is ticked.
6. Light, dark and midnight themes: text readable, focus ring visible.

- [ ] **Step 3: Walk Settings > Extension sources and Folder trust**

The operator list, ceiling, additions, effective and ignored lists render; adding `obra/superpowers` works; an invalid entry shows the plain sentence; the folder trust switch asks before trusting. Save the three screenshots named in Files.

- [ ] **Step 4: Record in the parity checklist**

Append to each of the two rows' Evidence cell: `Real window 2026-11-DD: <pass list>; <fail list, one sentence each>` (or `Real window: not run (no window in this session)`). Append to the catalog row: `M8 closed server side (API 118, COMMIT_CHANGED); the screen sends the commit.`

- [ ] **Step 5: Record in the old plan and the master plan**

Old plan Status line: `**P0 to P6 implemented; P8 <done 2026-11-07 | waits for Y1>; P7 and P9 deferred** (plan 2026-11-07 extensions-catalog-p9)`. Add §16b:

```markdown
### 16b. Rollout status (2026-11-07, plan 2026-11-07-extensions-catalog-p9)

- M8 closed on the server: toggle takes `commit`, API 118 (`COMMIT_CHANGED`); the desktop sends it.
- `GET active` reports `turns { claude, providers }`; the desktop screen says which chats ignore the switches.
- P8: `LLMIDE_EXT_ACTIVE_SET` <default on, kill switch `off` | still default off, waits for the Y1 bench>.
- Mac targets: the Mac screen became the desktop screen; the Mac N-1 fallback, the Mac screen preference and Mac Mobile Control are dropped.
- Deferred: P7 skills diet (own plan), P9 per-tool MCP deny list (after the ended-chat work in `llm_agent/sdk/engine.mjs` lands), phone list (with the iPhone app), token-estimate labels (measured figures after X2). Dropped: family switches, required-item lock.
- Real window: <result line from Step 4>.
```

MASTER-PLAN S8: mark `- [x] Extensions catalog rollout (P9) and a real-window check…` only if Step 2 and Step 3 ran; otherwise leave `[ ]` and change the owner to `(you)`. Mark `- [-] Extensions catalog P6 real-app check of the Extensions screen (you)` with `(retired 2026-11-07: Mac app removed; desktop check is the row below)`. Add `- [ ] Extensions catalog P7 skills diet (own plan) (me)` and `- [ ] Extensions catalog P9 per-tool MCP deny list, after the ended-chat engine work (me)`.

- [ ] **Step 6: Gate and commit**

Run: `make regression > "$TMPDIR/reg.log" 2>&1; tail -30 "$TMPDIR/reg.log"` — expected: exit 0.

```bash
git add docs/superpowers/plans/2026-10-31-tauri-parity-checklist.md docs/superpowers/plans/2026-10-31-extensions-catalog.md docs/superpowers/MASTER-PLAN.md desktop/parity/extensions-installed-dark.png desktop/parity/extensions-consent-dark.png desktop/parity/settings-extension-sources-dark.png
git commit -m "docs(plan): extensions catalog rollout status and real-window results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Leave the PNGs out of `git add` if Step 3 did not run.)

---

## Decisions for the user (secure default first)

| # | Decision | Secure default (recommended) | Alternative | Why |
|---|---|---|---|---|
| D1 | P8: turn the catalog switches on for Claude turns now (Task 4) | (a) Flip now, kill switch `LLMIDE_EXT_ACTIVE_SET=off`; proven equal to legacy for unchanged data by the golden tests; the real token bench is not run | (b) Wait for the Y1 paired bench before flipping | Today a switch the user turns off in the catalog is ignored on Claude chats, and nothing installed from GitHub ever loads there; on is the more restrictive and the more truthful behaviour |
| D2 | Commit on enable | Required for an item that declares executable kinds; optional (but checked when sent) for other items | Optional everywhere | The commit is what the consent covers; the only client that enables (the desktop) is updated in the same plan |
| D3 | P7 our skills diet | Defer to its own plan (needs commits in the `.skills` repo and one real task per candidate) | Do it now | Does not fit 2 h and touches another repository |
| D4 | P9 per-tool MCP deny list | Defer until the ended-chat continuation work in `extension/llm_agent/sdk/engine.mjs` lands, then do both engines at once | Adapter turns only now | One global format: the SDK path needs `disallowedTools` in `engine.mjs`, which a parallel agent is editing; the old plan marked P9 "only if asked" |
| D5 | Phone list (Q-E7 b: phone may toggle non-executable items) | None until the iPhone app's Host API path carries it; read-only first | Build now | Mac Mobile Control is gone and `ios_app/` belongs to the push-notifications work |
| D6 | P6 leftovers | Drop family switches and the required-item lock (no feature requires an item today); drop the N-1 fallback (the desktop bundles its core); defer token-estimate labels to measured figures after X2 | Build estimates now | An unmeasured "~N tokens" label would be guesswork shown as fact |
| D7 | Client re-read before enabling | Keep it beside the server check | Delete it now | Covers an adopted older core without API 118 at the cost of one GET |

## Self-review

- Spec coverage: M8 server gap → Task 1; honest active line → Tasks 2-3; P8 → Task 4 (gated on D1); real-window check of the screen and cards → Task 5; P6 leftovers, P7, P9, phone → D3-D6 and Task 5's status rows. Each old Mac target is listed as retargeted or dropped.
- Placeholders: the only fill-ins are observed results in Task 5 (dates, pass/fail lines), which cannot be known before the check.
- Types: `setInstalledEnabled(userId, id, enabled, { consents, commit })`, `COMMIT_CHANGED` / `commit_changed`, `turns: { claude, providers }`, `ActiveSummary.turns`, `activeScopeNote(a)` and `ExtensionsApi.toggle({ …, commit? })` are spelled the same in every task.
- Files avoided (parallel work): `extension/llm_agent/sdk/**`, chat engine and summary code, `ui/screens/chat/**`, `desktop/src-tauri/src/**` notify/tray, the web service worker, `ios_app/**`.
