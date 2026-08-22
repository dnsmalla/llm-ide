# MCP-backed connectors (phases 2–3) — design

**Status:** design, not yet implemented
**Supersedes:** the transport half of `2026-08-22-connector-catalog-design.md` phases 2–3
**Keeps:** that spec's phase 1 (catalog, selection state, Library section, Settings gating) — shipped, unchanged

## Decision

Fetch Google Drive, Google Calendar and Miro content through their **official remote MCP
servers**, not through hand-written per-provider REST transports. LLM-IDE becomes an MCP
**client** for ingestion; one generic adapter replaces what would have been three bespoke
transports plus two OAuth helpers.

The connectors keep their existing product meaning: content lands in the KB as notes, is
indexed by FTS5, and grounds the planner. This is *ingestion over MCP*, not "the agent can
reach Drive at query time" — see Rejected alternatives.

## Why

All three targets now publish official remote MCP servers with OAuth:

| Connector | Server URL | Auth | Relevant tools |
|---|---|---|---|
| Google Drive | `https://drivemcp.googleapis.com/mcp/v1` | OAuth 2.0, **BYO client id/secret**, no DCR | `search_files`, `list_recent_files`, `read_file_content`, `download_file_content`, `get_file_metadata` |
| Google Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | OAuth 2.0, **BYO client id/secret**, no DCR | `list_calendars`, `list_events`, `get_event` |
| Miro | `https://mcp.miro.com` | OAuth 2.1 **with dynamic client registration** | board read: sticky notes, shapes, frames, text, cards, tables, comments |

Required scopes — Drive: `drive.readonly`, `drive.file`. Calendar:
`calendar.calendarlist.readonly`, `calendar.events.readonly`, `calendar.events.freebusy`.

Writing three REST transports means hand-maintaining pagination, backoff, export/extraction
and schema drift that Google and Miro now maintain for us. The bespoke route costs roughly
what Slack cost (~310 LOC transport + ~70 LOC OAuth + ~90 LOC routes + ~530 LOC Swift) **per
connector**; the MCP route pays a one-time client cost and then a small descriptor per
connector.

## What does not exist yet (the honest cost)

This repo has **no MCP client**. `extension/mcp/` is a registry plus a config emitter:
`buildMcpConfigForUser()` (`extension/mcp/mcp-config.mjs:71`) produces a `{ mcpServers }` blob
handed to the `claude` CLI via `--mcp-config` (`extension/providers/providers.mjs:467`). The
CLI is the MCP client; tool results land in the model's context inside that subprocess and
never reach the KB. `@modelcontextprotocol/sdk@1.30.0` is on disk only as a transitive
dependency of the Agent SDK and is imported only from tests.

So phase 2 builds protocol code that was explicitly deferred as "SP1b" in
`2026-08-12-mcp-plugin-runtime-design.md:52`. That is the real price of this decision, and it
is paid once.

## Architecture

```
Mac SourceConnector engine (manifest-driven, dormant since 2026-07-31 — finally used)
    │  test / fetch / seen / classify        ← the 4 endpoints a manifest declares
    ▼
extension/routes/  mcp-connector route block   (ONE block, all connectors)
    │
    ├── connectors/mcp-connector-defs.mjs   per-connector descriptor (URL, scopes, tools, mapping)
    └── connectors/mcp-client.mjs           Client + StreamableHTTPClientTransport
            │                                VaultOAuthProvider implements OAuthClientProvider
            ▼
      drivemcp.googleapis.com · calendarmcp.googleapis.com · mcp.miro.com
            │  tools/call → items
            ▼
      source/<id>/ raw files → InboxGenerationPipeline → llm-doc/<id>/ notes → FTS5
```

Pattern B (fetch-only → notes), matching Slack and the original connector-catalog spec.
Pattern A (`ingestSources` straight into the `sources` table, as Box does) stays available if
Drive later needs chunk-level search, but is out of scope here.

### `connectors/mcp-client.mjs`

Wraps `Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`. Exports
roughly `withMcpSession(userId, def, fn)` — connect, run, close — plus `callTool` and
`listTools` helpers. Connections are per-call, not pooled: ingestion runs on a timer, and a
pooled long-lived session buys nothing but lifecycle bugs.

**`VaultOAuthProvider`** implements the SDK's `OAuthClientProvider`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts:15`), backed by the
encrypted vault, per user, keyed by connector id:

| Hook | Storage |
|---|---|
| `clientInformation()` / `saveClientInformation()` | `mcp.<id>.clientInformation` — pre-seeded from the operator's BYO client for Google; written by DCR for Miro |
| `tokens()` / `saveTokens()` | `mcp.<id>.tokens` |
| `codeVerifier()` / `saveCodeVerifier()` | `mcp.<id>.codeVerifier` |
| `redirectToAuthorization(url)` | **does not redirect** — captures the URL for the start route to hand to the Mac app |
| `redirectUrl` | `http://127.0.0.1:3456/auth/mcp-connector/callback` |

Google and Miro differ only in whether `clientInformation()` is pre-seeded. No per-provider
branching in the flow itself.

Credentials MUST be keyed by issuer as well as connector id — the SDK docs are explicit that a
client registered with one authorization server must never be reused against another.

### OAuth routes

Mirror the existing Slack shape (`auth-routes.mjs:578` start / `:431` callback / `:593`
status), which already stores a per-user token in the vault:

- `POST /auth/mcp-connector/start` `{ id }` → `{ authorizationUrl }` (Mac opens it)
- `GET  /auth/mcp-connector/callback` → `transport.finishAuth(searchParams)`, persist tokens
- `GET  /auth/mcp-connector/status?id=` → `{ connected, account? }`

`UnauthorizedError` on connect means re-auth: the SDK requires a **fresh transport** after
`finishAuth` — a started transport cannot be restarted.

### `connectors/mcp-connector-defs.mjs`

Per connector, purely declarative: server URL, scopes, whether a BYO client is required, which
tool lists candidates, which tool reads one item, and a mapper from tool result to
`{ fields, body }` for the inbox writer. Adding a fourth MCP-backed connector should be an
entry here plus a manifest — nothing else.

### Mac side

The manifest engine (`mac/Sources/LlmIdeMac/SourceConnectors/`, 449 LOC, tested, zero manifests)
gets its first real use:

1. Three manifest JSONs in a new `Resources/source_connectors/` bundle directory.
2. **One** `McpConnectorAdapter` implementing the 3-method `SourceConnectorAdapter` protocol,
   parameterised by connector id — not one adapter per connector.
3. Wiring in `SourceRegistry.all`, which is a hardcoded literal today
   (`Sources/SourceRegistry.swift:7`).
4. Real Settings cards replacing the phase-1 placeholders; flip `pipelineReady: true` in
   `connectors/connector-catalog.mjs`.

`noteType` must avoid the reserved `meetings|emails|documents`
(`SourceConnectorManifest.swift:96`).

## Rejected alternatives

**MCP catalog entries only** — add the three servers to `MCP_CATALOG` as `transport: 'http'`,
`oauth: true` entries (~30 lines, the same shape as the existing Notion and Sentry entries).
The agent gets live Drive/Calendar/Miro access in chat, but nothing lands in the Library: no
FTS index, no offline search, no planner grounding. That contradicts what the phase-1 cards
already promise ("Fetch files from Drive folders into llm-doc notes") and leaves two catalogs
both offering "Google Drive". Cheap and genuinely useful, but a different feature — worth
doing later as an agent-capability addition, not as the connector pipeline.

**Bespoke REST transports** (the original phases 2–3) — no new architectural risk and it uses
the dormant manifest engine either way, but it is roughly 3× the per-connector code and
hand-maintains what the providers now ship.

## Risks

- **Google BYO OAuth client.** Google registers redirect URIs per MCP host and offers no DCR,
  so the operator must create a Cloud Console client and register our callback. This is the
  same burden the Gmail connector already imposes, so it is not new UX territory — but it is
  the main setup friction, and it is per-install.
- **Protocol code is net-new.** OAuth 2.1 + PKCE, discovery, DCR, refresh, and the
  `UnauthorizedError` → `finishAuth` → fresh-transport dance. Mitigation: the SDK implements
  all of it; we implement storage hooks only.
- **Transitive dependency.** `@modelcontextprotocol/sdk` must be promoted to a declared,
  exact-pinned runtime dependency of `extension/package.json`. It currently arrives only via
  `@anthropic-ai/claude-agent-sdk` and could vanish on an unrelated upgrade.
- **Tool-result size.** MCP caps tool output (25k tokens by default in the agent context).
  Ingestion reads results programmatically rather than through a model, but large Drive files
  still need chunking before note generation.
- **Server-side capability drift.** Miro calls its tool surface "a purposeful abstraction"
  that will expand; Google's tool list may change. Descriptors isolate the blast radius to one
  file.
- **Enterprise gating.** Miro MCP is disabled by default on Enterprise plans until an admin
  enables it; surface that as a connection error, not a silent empty fetch.

## Phasing

- **Phase 2a** — MCP client + `VaultOAuthProvider` + OAuth routes + `test` endpoint. Ship with
  Miro first: DCR means no BYO client, so it proves the whole flow with the least setup.
- **Phase 2b** — generic `fetch`/`seen`/`classify` endpoints + descriptors + Mac manifests and
  the single adapter. Miro end-to-end into `llm-doc/miro/`.
- **Phase 3** — Google Drive and Calendar descriptors, BYO-client setup UI, scope handling.

Each phase ends green: `cd extension && npm run lint && npm test`; `cd mac && swift build && swift test`.
