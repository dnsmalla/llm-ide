---
title: Connector catalog, phase 1 — spec
status: draft
---

This page records the connector catalog as it is **shipped and readable in code** on 2026-10-31: the curated list, the per-user selection, the MCP-backed ingestion path (Miro today), the Mac Library section and the selection-gated Settings cards. It was written after the fact (the status audit found no spec file, `docs/superpowers/plans/2026-10-31-status-audit.md` section b), so every claim cites the code. Section 8 separates what is shipped from what is unverified or not built.

Not covered: Box, Slack, Email and Git ingestion internals (see [knowledge-base](knowledge-base.md) and the knowledge-kit map `docs/kits/knowledge-kit.md`); the user-added MCP servers of the extensions catalog (see [extensions-catalog](extensions-catalog.md)), which are a different mechanism.

---

## §1 Files

| Layer | Path | Role |
|---|---|---|
| Catalog | `extension/connectors/connector-catalog.mjs` | Frozen list of 5 entries and `catalogEntry(id)` |
| Selection | `extension/connectors/connector-state.mjs` | Per-user selected ids in a JSON file |
| MCP descriptors | `extension/connectors/mcp-connector-defs.mjs` | One descriptor (Miro), tolerant result shaping, `LLMIDE_MCP_<ID>_URL` override |
| MCP client | `extension/connectors/mcp-client.mjs` | Vault-backed OAuth provider, flow state map, sessions, generic fetch sweep |
| Catalog routes | `extension/server/auth-routes.mjs` | `/auth/me/connectors*` |
| MCP routes | `extension/server/auth-routes.mjs`, `extension/routes/router.mjs` | `/auth/mcp-connector/*` and `/kb/mcp-connector/*` |
| Dedup table | `extension/kb/migrations/0031_mcp_connector_state.sql` | `mcp_connector_seen` |
| Mac client | `mac/Sources/LlmIdeMac/Core/Networking/API/LlmIdeAPIClient+Connectors.swift`, `LlmIdeAPIClient+McpConnector.swift` | HTTP wrappers |
| Mac Library | `mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorAddSheet.swift`, `ConnectorDetailView.swift`, `ConnectorRow.swift` | "Add from catalog" list and detail |
| Mac Settings | `mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift` | Selection-gated cards (`ConnectionsSelection.visibleCardIds(selected:)`) |
| Mac adapter and manifests | `mac/Sources/LlmIdeMac/Features/Library/Services/McpConnectorAdapter.swift`, `mac/Sources/LlmIdeMac/Resources/source_connectors/miro.json`, `gdrive.json`, `gcal.json` | Fetch, classify, write to the inbox folder |

## §2 The catalog

`CONNECTOR_CATALOG` is a frozen array; adding a connector is a code change, not data entry. Each entry has `id`, `name`, `description`, `icon` (an SF Symbol name), `authKind`, `docsUrl`, `pipelineReady`.

| id | authKind | pipelineReady | Ingestion path |
|---|---|---|---|
| `gdrive` | `google-oauth` | false | none yet |
| `gcal` | `google-oauth` | false | none yet |
| `miro` | `miro-oauth` | true | MCP-backed (section 4) |
| `box` | `box-ccg` | true | Pattern A, `extension/connectors/box.mjs` |
| `slack` | `slack-oauth` | true | `extension/connectors/slack-source.mjs` |

Meeting and Email are fixed defaults and are deliberately not catalog entries (`ConnectionsSelection.fixedOrder` on the Mac).

## §3 Per-user selection

- Store: one JSON file, `connector-state.json`, beside the plugin directory (`dirname($LLMIDE_PLUGIN_DIR)`, default `~/Library/Application Support/llm-ide/` on macOS, `~/.local/share/llm-ide/` elsewhere). Shape `{ "<userId>": { "selected": ["box", ...] } }`. Writes go to a temp file then `rename` (atomic). A corrupt file reads as empty and the next write replaces it.
- First read for a user pre-selects `box` and `slack` and persists that, so an upgrading user's Settings does not change (the two shipped hardcoded before the catalog).
- `selectConnector(userId, id)` returns false for an id not in the catalog. `deselectConnector` only removes the id: **no fetched file, note or credential is deleted**. `pruneOrphanSelections()` drops ids that left the catalog.
- Selection is a visibility setting, not an authorisation: a deselected connector's `/kb/mcp-connector/*` routes still work for a user who holds tokens. Not enforced server-side by design today.

Routes (all authenticated; user from the bearer token):

| Method and path | Body | Response |
|---|---|---|
| `GET /auth/me/connectors` | none | `{ connectors: [{id,name,description,icon,authKind,docsUrl,pipelineReady}] }` for selected ids only |
| `GET /auth/me/connectors/catalog` | none | `{ catalog: [entry + selected:boolean] }` |
| `POST /auth/me/connectors/add` | `{ id }`, slug `^[a-z][a-z0-9-]{1,20}$` | `{ ok:true, id }`; 400 `VALIDATION_FAILED` for a bad or unknown id; audit action `connector.select` |
| `DELETE /auth/me/connectors/<id>` | none | `{ ok:true, id }`; audit action `connector.deselect` |

## §4 MCP-backed ingestion (Miro today)

### §4a Descriptor

An entry of `MCP_CONNECTOR_DEFS` carries `id`, `name`, `serverUrl`, `scope`, `byoClient`, `clientName`, `byoClientIdKey`, `byoClientSecretKey`, and for fetching `listTool` (`name`, `args`, `itemsPath`, `idField`, `nameField`), `readTool` (`name`, `parentArg`, `args`, `itemsPath`, `idField`, `typeField`, `textFields`, `dateField`, `linkField`) and `mapItem`. The client branches on none of these by connector id. Miro: `serverUrl` `https://mcp.miro.com`, scope `boards:read`, dynamic client registration (`byoClient: false`).

`LLMIDE_MCP_<ID>_URL` repoints one connector (test and staging seam). Only `https:` (any host) or `http:` on `127.0.0.1`, `localhost` or `[::1]` is honoured; anything else is ignored. It is read on every call.

### §4b OAuth flow

1. `POST /auth/mcp-connector/start { id }` mints a 24-byte base64url `state`, stores `{userId, connectorId}` in an in-memory map (TTL 10 minutes, single use), and runs the SDK `StreamableHTTPClientTransport` against `serverUrl`. The SDK discovers the protected-resource and authorization-server metadata, registers a client if needed, builds a PKCE authorization URL and calls `redirectToAuthorization`, which the provider captures. Response `{ authUrl, state }`, or `{ state, alreadyConnected:true }` when saved tokens still work. Failure is 502 `MCP_AUTH_START_FAILED`.
2. The Mac opens `authUrl` in the browser. The server redirect URI is `http://127.0.0.1:<port>/auth/mcp-connector/callback`.
3. `GET /auth/mcp-connector/callback?code&state` is public (listed in `PUBLIC_PATHS`, `extension/server/auth.mjs`) because a browser redirect carries no bearer token; `state` is the only link back to the user. It rejects an unknown or expired state, a state already used, a cancelled sign-in and an unknown connector, exchanges the code (`finishAuth`), verifies with a second session, writes audit `auth.secret_set` (resource `mcp.<id>.tokens`) and shows an HTML page with the message HTML-escaped.
4. `GET /auth/mcp-connector/status?id=<id>[&state=<flow>]` returns `{ id, connected, status, ... }`. `connected` reads the vault. A `state` of another user answers 403.

### §4c Credential storage

Everything lives in the per-user encrypted vault under keys matching `^mcp\.[a-z][a-z0-9-]{1,40}\.[a-zA-Z]{1,32}$` (`extension/server/vault.mjs`):

| Key | Content |
|---|---|
| `mcp.<id>.issuer` | last discovered authorization server |
| `mcp.<id>-<tag>.clientInformation` | the dynamic registration result |
| `mcp.<id>-<tag>.tokens` | access and refresh token (JSON) |
| `mcp.<id>-<tag>.codeVerifier` | PKCE verifier, in flight only |

`<tag>` is the first 12 hex characters of `sha256(issuer)`, so a changed issuer makes the old credentials unreachable (orphaned, not deleted) and forces re-registration. For connectors with `byoClient: true` the operator-provisioned client id and secret live at `byoClientIdKey` and `byoClientSecretKey`, which are not issuer-scoped. `invalidateCredentials` blanks fields the server rejects. Tokens never reach the Mac app or the log: errors go through `redactSecrets` and are cut to a public message.

### §4d Fetch sweep

`POST /kb/mcp-connector/test { id }` returns `{ ok, server, tools, toolSchemas }` (the only mechanical way to read the real tool names). `POST /kb/mcp-connector/fetch { id, limit? }` (limit clamped 1 to 200, default 50) returns `{ items, drained, skipped:{overCap}, failures }`. A sweep is per call, never pooled: connect (20 s timeout), call `listTool` (60 s per tool), take at most 25 parents, call `readTool` per parent, map, drop ids already in `mcp_connector_seen`, chunk bodies over 12 000 characters (id suffix `#k`), stop at `limit`. One unreadable parent is collected in `failures` and skipped; partial success stays HTTP 200. `POST /kb/mcp-connector/seen { id, itemIds }` marks ids imported (`{ ok, marked }`). `POST /kb/mcp-connector/classify { body:{ connectorId, title, date, text } }` runs the one-note classifier (400 without `body.text`, 502 `CONNECTOR_CLASSIFY_FAILED`). A user who has not connected gets a tagged `MCP_UNAUTHORIZED` instead of an automatic registration attempt.

Result shaping is deliberately tolerant (`toItemArray` four fallbacks, `pickText` then a metadata-stripped JSON dump, `stripHtml`): a wrong tool-name guess should degrade to a rawer note, not to an empty fetch. The default mapper emits id `<connector>:<parent>:<item>` and fields `Title`, `Board`, `ItemType`, `Date`, `Link`.

### §4e Data model

One table, `mcp_connector_seen(user_id, connector_id, item_id, seen_at)`, primary key `(user_id, connector_id, item_id)`. There is no high-water mark (MCP results have no cursor), so the seen set is the whole incrementality mechanism. No other kb table exists for connectors; selection is a file, credentials are vault rows.

## §5 Mac side

- **Library** lists the catalog through `ConnectorAddSheet` and `ConnectorRow`; an entry with `pipelineReady == false` shows "Pipeline coming soon". Adding calls `POST /auth/me/connectors/add`.
- **Settings, Connections** shows fixed cards (Meetings, Email) plus the catalog cards for selected ids (`visibleCardIds(selected:)`). Bespoke cards exist for `meetings`, `email`, `box`, `slack`; any other selected id gets the placeholder "Coming soon" card whose text says nothing fetches yet. Until the list loads every card shows.
- **Fetch** for MCP connectors runs through the manifest engine: `source_connectors/<id>.json` names the four `/kb/mcp-connector/*` endpoints and `McpConnectorAdapter`, which maps server fields to the inbox note headers (`Subject`, `Board`, `ItemType`, `ItemId`, `Date`, `Link`, `Part`).

## §6 Security

- **Per-user isolation.** Selection is keyed by `userId`; vault rows and the seen table are per user; the status route refuses another user's flow state.
- **OAuth.** Authorization code with PKCE; redirect URI fixed to the loopback server; `state` random, single use, 10-minute TTL, in memory (a server restart invalidates a flow). The callback is the only unauthenticated connector route and releases nothing but an escaped message.
- **Audit.** `connector.select`, `connector.deselect`, `auth.secret_set` for the token write.
- **Outbound fetch pinning** (closed 2026-10-31; tests `extension/tests/mcp-client-ssrf.test.mjs`, `box-fetch-pinning.test.mjs`):
  - `extension/connectors/mcp-client.mjs` passes `pinnedFetchFor(def)` (from `server/pinned-fetch.mjs`) as the `fetch` option of every `StreamableHTTPClientTransport`, so the MCP request AND the SDK's OAuth discovery, registration and token calls are pinned: DNS resolved once, every address classified, the checked address dialled. Metadata URLs aimed at `169.254.169.254`, loopback, private ranges or a rebinding hostname fail with `SSRF_BLOCKED`. Private targets are allowed only when the descriptor's own `serverUrl` is the loopback `LLMIDE_MCP_<ID>_URL` test override (and the operator gate is on); link-local and metadata ranges are refused in every posture. The SDK follows redirects same-origin only, one hop at a time through this fetch.
  - `extension/connectors/box.mjs` sends every request (token exchange included) through the pinned fetch. API-returned content and info URLs are untrusted: https, no userinfo, port 443, host `box.com` / `boxcloud.com` or a subdomain only. Redirects are followed by hand (3 hops max), each hop re-validated and re-pinned; the bearer token is dropped as soon as a hop changes origin. Bodies are capped (8 MiB JSON, 10 MiB extracted text) by `content-length` and while streaming.
  - Google and Slack OAuth helpers call fixed literal hosts (low).
- **Prompt injection.** Fetched board text becomes a note body and goes to the classifier. Notes are data, but a board author controls that text; the classify call must not be given tools (recommendation; not verified in code here).

## §7 Tests

Server: `extension/tests/connector-catalog.test.mjs`, `connector-state.test.mjs`, `connector-routes.test.mjs`, `mcp-connector-defs.test.mjs`, `mcp-connector-oauth-routes.test.mjs`, `kb-router-mcp-connector.test.mjs`, `mcp-connector-seen.test.mjs`. Mac: `ConnectorCatalogDecodingTests`, `McpConnectorAdapterTests`, `McpConnectorDecodingTests`. The status audit listed these by name and did not run them; nothing here changes that. No test may contact `mcp.miro.com`.

## §8 Shipped, unverified, not built

| Item | State |
|---|---|
| Catalog, per-user selection, routes, Library add sheet, selection-gated Settings | Shipped, with tests |
| Miro OAuth and fetch plumbing | Shipped, with tests against fixtures |
| Miro tool names `list_boards`, `get_board_items`, argument `board_id`, `itemsPath`, `textFields` | **Unverified guesses** (`extension/connectors/mcp-connector-defs.mjs`). Never run against the real server. Confirm with a connected `POST /kb/mcp-connector/test` and edit the string literals |
| gdrive, gcal MCP ingestion | **Not built.** No server descriptor (only the commented example in `mcp-connector-defs.mjs`); catalog `pipelineReady: false`; Mac placeholder card. The Mac already ships `gdrive.json` and `gcal.json` manifests, so a `/kb/mcp-connector/*` call for those ids answers 400 "Unknown MCP connector id" until descriptors exist. Whether the Mac loads those manifests when the pipeline is not ready was not checked |
| Google OAuth bring-your-own client | Planned: Google registers redirect URIs per client and has no dynamic registration, hence `byoClient: true`; the vault keys are defined, no UI collects them |
| Google MCP endpoint and tool names in the commented example | Unverified, copied from a comment |
| Server-side enforcement that a deselected connector cannot fetch | Not built (selection is visibility only) |
| Pinned fetch for the MCP client and Box | Shipped (section 6) |
| Activity feed entry for connector fetches | Not built (`connector_fetched` is not in the activity kinds, comment in `extension/routes/router.mjs`) |

## Regeneration checklist

- [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
- [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
