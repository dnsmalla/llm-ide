---
title: API & server — spec
status: draft
---

# API & server — spec

This page is the rebuild-grade specification for the HTTP server and its entire request surface. Every contract is stated exactly, every magic number is present, and structured facts link to their extractor-generated reference pages. A reader who has never seen this codebase should be able to reconstruct a compatible server from this document alone.

---

## 1. Scope

The following source files together constitute the server and its API:

| Layer | Files |
|---|---|
| Entry point | `extension/server.mjs` |
| Auth middleware | `extension/server/auth.mjs`, `extension/server/jwt.mjs` |
| Route handlers | `extension/server/auth-routes.mjs`, `extension/routes/extension-routes.mjs` (plugin, LLM-source and MCP-plugin routes, still under `/auth/me/*`), `extension/server/ai-routes.mjs`, `extension/server/export-routes.mjs` |
| KB router | `extension/routes/router.mjs` (mounted under `/kb`) |
| Rate limiting | `extension/server/rate-limit.mjs` |
| Observability | `extension/server/audit.mjs`, `extension/server/metrics.mjs` |
| User / token store | `extension/server/users.mjs`, `extension/server/vault.mjs` |
| Control-plane helpers | `extension/server/control-plane.mjs` |
| Shared core | `extension/core/config.mjs`, `extension/core/errors.mjs`, `extension/core/logger.mjs`, `extension/core/utils.mjs` |

`extension/core/env-compat.mjs` aliases legacy `MEETNOTES_*` env vars to `LLMIDE_*` before any config is read (`server.mjs:2`).

---

## 2. Request pipeline

Every inbound HTTP request passes through these stages **in order** (`extension/server.mjs:185–529`):

1. **CORS headers set** (`server.mjs:186`) — `setCORS()` runs unconditionally before any other logic. Never echoes `*`; see [§7 Limits and guards](#7-limits-and-guards).
2. **Request-ID & per-request logger** (`server.mjs:194–200`) — `X-Request-ID` is read from the client header (validated: max 128 chars, CR/LF/NUL stripped) or generated fresh. A child logger carrying `{ requestId, method, url }` is attached as `req.log`.
3. **Response-finish instrumentation** (`server.mjs:203–217`) — a `res.on('finish')` listener records duration + status, calls `recordHttpRequest()`.
4. **OPTIONS short-circuit** (`server.mjs:219–223`) — preflight requests return `200` immediately.
5. **Authentication** (`server.mjs:227–232`) — `authenticate(req)` verifies the bearer JWT (or allows public paths). Throws `AppError` → `sendError` on failure; attaches `req.user` on success.
6. **Auth-route dispatcher** (`server.mjs:237–244`) — `isAuthRoute(url)` matches; if true, `handleAuth()` runs and returns. Auth routes apply their own per-IP rate limits internally (not through the main `profile` lookup below).
7. **Rate limiting** (`server.mjs:248–258`) — `rateLimitProfile(url, method)` maps the URL to a profile. If a profile is found, `tryConsume(profile, scope)` is called. Scope is `req.user.id` for authenticated requests or `req.socket.remoteAddress` for unauthenticated ones (`server.mjs:250`). On deny: `Retry-After: <N>` header set, `429 RATE_LIMITED` returned.
8. **KB router** (`server.mjs:265–267`) — any URL starting with `/kb` is dispatched to `handleKB(req, res)`. Returns `true` when handled, `false` to fall through.
9. **Control-plane endpoints** (`server.mjs:275–297`) — `GET /` and `GET /health` are served here (unauthenticated). Response includes `apiVersion`, `endpoints` array, DB/migration status, Claude-CLI probe result.
10. **Deep-link redirect** (`server.mjs:313–385`) — `GET /launch-app` returns `302` to a `llmide://` URL. Public path.
11. **Admin endpoints** (`server.mjs:394–489`) — `POST /admin/backup` and `DELETE /admin/users/:id` require admin role (`requireAdmin(req)`).
12. **Prometheus metrics** (`server.mjs:493–510`) — `GET /metrics` requires admin role.
13. **AI and export routes** (`server.mjs:513–514`) — `handleAIRoutes`, then `handleExportRoutes`. Each returns `true` when handled.
14. **404 fallback** (`server.mjs:516–519`) — `AppError('NOT_FOUND', …)` with the full `ENDPOINTS` array in details.
15. **Unhandled exception guard** (`server.mjs:520–529`) — non-`AppError` exceptions become `INTERNAL_ERROR 500`; stack is logged but never sent to client.

### API version and stale-server detection

`SERVER_API_VERSION = 129` (`server.mjs:392`). Clients compare this value against the `apiVersion` field returned in `GET /` and `GET /health`. If the client's expected version exceeds the server's, the client surfaces "restart the server to pick up new endpoints." The `ENDPOINTS` array (`server.mjs:270–392`) is also returned in both responses so clients can detect missing capabilities by name.

### Server timeouts

| Parameter | Value | Source |
|---|---|---|
| `server.requestTimeout` | **0 (disabled)** | `server.mjs` |
| `server.headersTimeout` | 65 000 ms | `server.mjs` |
| `server.keepAliveTimeout` | 60 000 ms | `server.mjs` |

`requestTimeout` is disabled because an agent turn has no deadline (see [agent-runtime](agent-runtime.md)); a socket cut out from under work that is still running yields a dead connection instead of an answer. `headersTimeout` (slowloris) and `keepAliveTimeout` (idle sockets between requests) remain — neither can interrupt an in-flight request. Known trade-off: `requestTimeout` also bounded request-*body* reception and nothing replaces it, so a local client that dribbles a body can hold a socket; bounded by loopback-only binding and the 8 MB body cap.

### Per-route handler budgets (`server/route-timeout.mjs`)

Opt-in only; a route absent from the map has no budget, and a budget returns a 504 JSON envelope. Only **short, externally-bounded** routes carry one: `/kb/dispatch` (60 s, outbound provider REST), `/kb/providers/verify`, `/kb/providers/models`, `/kb/providers/catalog/test` and `/kb/providers/catalog/models` (30 s, liveness probes), `/kb/delete` (30 s).

Budgets were **removed** from every LLM route (`/kb/generate-plan`, `/kb/analyze-risks`, `/kb/summarize`, `/kb/conflict-questions`, `/kb/generate-code` — previously 180–240 s) and from the routes that scale with the user's data (`/kb/ingest`, `/kb/connect-box`, `/kb/ingest-scip`). Once `requestTimeout` and the agent-loop deadline were gone these were the last clock over that work, and they cut it off in the cases needing time most: `/kb/summarize` 504'd at 240 s on a long transcript, so the Mac summarizer discarded the real AI summary and wrote its local fallback. Streaming routes (`/code-assist`, SSE, agent dispatch) must never be listed.

---

## 3. Endpoint contracts

The authoritative per-endpoint request/response schema is [`../reference/api/openapi.yaml`](../reference/api/openapi.yaml).

Coverage is verified by `docs/_scripts/check_api_coverage.py`: every URL in the server's `ENDPOINTS` array must have a matching path in the OpenAPI document. The script prints `OK: all N live endpoints documented.` when passing.

**Schema fidelity:** Endpoint *presence* is checked automatically by `check_api_coverage.py`. Per-endpoint request/response *schemas* were handler-verified in a full sweep (2026-06) that corrected ~33 endpoints (missing request bodies, wrong response field names, missing error codes). The OpenAPI document is the authoritative contract; `check_api_coverage` keeps the endpoint set in sync, but schema bodies are hand-maintained — re-verify against the handler when you change one.

### Global conventions

| Convention | Value |
|---|---|
| Base URL | `http://127.0.0.1:3456` (default; `LLMIDE_HOST`/`LLMIDE_PORT` configurable) |
| Auth header | `Authorization: Bearer <jwt>` |
| Content-Type | `application/json` for all requests and non-streaming responses |
| Error envelope | `{ error: { code: string, message: string, details?: unknown } }` |

The error envelope shape is defined in `extension/core/errors.mjs:17–91` and serialized by `sendError()` (`errors.mjs:67`). `details` is only present when `err.details !== undefined` (`errors.mjs:73`).

See [§4 Auth and token lifecycle](#4-auth-and-token-lifecycle-rebuild-grade) for auth endpoint contracts and [§5 Error codes](#5-error-codes) for the full error-code table.

---

## 4. Auth and token lifecycle (rebuild-grade)

### JWT algorithm and claims

Source: `extension/server/jwt.mjs`.

- Algorithm: **HS256 only** (`jwt.mjs:12`). The header is hard-coded as `{ alg: 'HS256', typ: 'JWT' }`.
- On verification, the decoded header is checked: `header.alg !== 'HS256' || header.typ !== 'JWT'` → reject (`jwt.mjs:63`). This guards against `alg: none` and key-confusion attacks.
- Two keys are tried in order: `config.jwtSecret`, then `config.jwtSecretPrevious` if set (`jwt.mjs:52–55`). This enables zero-downtime rotation.
- Signature comparison uses a constant-time byte-by-byte XOR accumulator (`jwt.mjs:28–33`).

**Access token claims** (`jwt.mjs:91–99`):

| Claim | Type | Value |
|---|---|---|
| `iss` | string | `config.jwtIssuer` (default `"llmide"`, env `LLMIDE_JWT_ISSUER`) |
| `sub` | string | `String(userId)` |
| `role` | string | `"user"` or `"admin"` |
| `typ` | string | `"access"` |
| `jti` | string | `crypto.randomUUID()` — used for per-token revocation |
| `iat` | number | Unix seconds at issue time |
| `exp` | number | `iat + config.accessTokenTTLSec` |

**Access token TTL:** `config.accessTokenTTLSec` = `envInt('LLMIDE_ACCESS_TTL_SEC', 15 * 60)` = **900 s (15 min)** default (`config.mjs:130`).

**Clock-skew tolerance:** `JWT_CLOCK_SKEW_SEC = 2` seconds (`jwt.mjs:14`). Applied as: exp must be `>= now - 2`; iat must be `<= now + 2` (`jwt.mjs:84–85`).

**Issuer verification:** `payload.iss !== config.jwtIssuer` → return null (`jwt.mjs:73`).

**JTI revocation:** After signature and claims verification, `isJtiRevoked(claims.jti)` is called in `auth.mjs:56`. Any revoked JTI causes a 401 `AUTH_REQUIRED`.

**Access-token epoch (bulk revocation):** Immediately after the JTI check, `auth.mjs:61` rejects any token whose `claims.iat < tokensValidAfter(userId)` (`extension/kb/user.mjs:168`, reading `users.tokens_valid_after`). This is a per-user cutoff that invalidates *every* outstanding access token at once without enumerating their JTIs — used for "log out everywhere". The epoch is bumped to the current second by `logoutAll` (`users.mjs:229`) and by consuming a password-reset token (`users.mjs:368`). The comparison is strict `<`, so a token minted in the same wall-clock second as the bump survives (a ≤1 s window); switch to `<=` if absolute revocation is required. The column was added by migration `0016_token_epoch.sql`.

`verifyAccessToken()` returns `{ userId, role, jti, iat, exp }` (`jwt.mjs:105`); `iat` is load-bearing — the epoch check above depends on it. The server attaches `{ id, role, jti, tokenExp }` to `req.user` (`auth.mjs:64`).

**Disabled account:** after the epoch check, `authenticate()` reads `users.status` (one primary-key read) and answers `401 { error: { code: 'ACCOUNT_DISABLED', message } }` when it is not `active` (API 125). Disabling an account therefore takes effect on the next request, not when its access token expires (up to 900 s later); `/auth/refresh` already refused a disabled account. The JWT carries no `status` claim, so the check is never satisfiable from the token alone.

### Refresh token format and storage

- **Format:** 48 random bytes encoded as base64url (`jwt.mjs:111–112`). Opaque to the client.
- **Hashed at rest:** SHA-256 hex digest (`jwt.mjs:115–116`). DB stores the hash only; plaintext never persisted.
- **TTL:** `config.refreshTokenTTLSec` = `envInt('LLMIDE_REFRESH_TTL_SEC', 30 * 24 * 60 * 60)` = **2 592 000 s (30 days)** default (`config.mjs:131`).
- **Rotation on use:** Each `/auth/refresh` call issues a new refresh token and revokes the old one (rotation logic in `extension/server/users.mjs`).

### Password hashing

- **Library:** `bcryptjs` (`users.mjs:5`).
- **Cost factor:** `config.bcryptCost` = `envInt('LLMIDE_BCRYPT_COST', 12)` (`config.mjs:103`). Enforced range: **10–14** (validated at config load and at `users.mjs` module load, `users.mjs:19–28`).
- **Sentinel hash for unknown emails:** A real bcrypt hash of a random 32-byte secret is computed once at module load (`users.mjs:37–40`) using `config.bcryptCost`. When a login attempt names an email that does not exist, `bcrypt.compareSync` runs against this dummy hash rather than short-circuiting. This prevents timing-based account enumeration.

### Config keys

| Key | Default | Purpose |
|---|---|---|
| `LLMIDE_JWT_SECRET` | auto-generated in dev | HMAC signing key; must be ≥ 32 chars |
| `LLMIDE_JWT_SECRET_PREVIOUS` | unset | Previous key for zero-downtime rotation |
| `LLMIDE_JWT_ISSUER` | `"llmide"` | `iss` claim |
| `LLMIDE_ACCESS_TTL_SEC` | `900` | Access token lifetime |
| `LLMIDE_REFRESH_TTL_SEC` | `2592000` | Refresh token lifetime |
| `LLMIDE_BCRYPT_COST` | `12` | bcrypt work factor (range 10–14) |
| `LLMIDE_VAULT_KEY` | auto-generated in dev | Per-user credential vault key; must be ≥ 32 chars |

### Public paths (no auth required)

Defined in `extension/server/auth.mjs` (the `PUBLIC_PATHS` set):

```text
GET  /
GET  /health
GET  /launch-app   (and /launch-app?…)
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/reset-request
POST /auth/reset-confirm
GET  /auth/well-known
GET  /auth/google/callback   (Google's OAuth redirect; carries no bearer token)
```

`OPTIONS` requests are also unconditionally public (`auth.mjs:35`).

---

## 5. Error codes

The full table with descriptions is in [`../reference/error-codes.md`](../reference/error-codes.md).

**Architectural rule:** `AppError` is the only exception type that route handlers may throw. Any non-`AppError` that escapes becomes `INTERNAL_ERROR 500`; the stack is logged but never sent to the client (`server.mjs:520–529`, `errors.mjs:68–71`). Factory functions in `errors.mjs`:

| Factory | Code | HTTP status |
|---|---|---|
| `errAuth()` | `AUTH_REQUIRED` | 401 |
| `errForbidden()` | `FORBIDDEN` | 403 |
| `errNotFound()` | `NOT_FOUND` | 404 |
| `errValidation()` | `VALIDATION_FAILED` | 400 |
| `errConflict()` | `CONFLICT` | 409 |
| `errRateLimit()` | `RATE_LIMITED` | 429 |
| `errInternal()` | `INTERNAL_ERROR` | 500 |

### Reconciliation: `GUARDRAIL_FAILED` and `UPSTREAM_ERROR`

`docs/reference/api/overview.md` lists both `GUARDRAIL_FAILED` and `UPSTREAM_ERROR` in its error-code table.

**Verified finding:**

- `GUARDRAIL_FAILED`: No `AppError` factory and no `throw` of this code exists anywhere in the server source (grepped all `.mjs` and `.ts` files excluding `dist/` and `node_modules/`). It appears only in comment lines in `extension/core/errors.mjs:7,10`. **This code is never actually emitted by the server.** The `overview.md` entry is aspirational/stale for this code.

- `UPSTREAM_ERROR`: No factory in `errors.mjs`. The code is emitted in **three places** via raw `sendJSON` (bypassing `AppError`/`sendError`):
  - `extension/routes/router.mjs:571` — catch-all for unexpected errors in the `/kb/summarize` handler
  - `extension/routes/router.mjs:771` — catch-all for unexpected errors in the `/kb/email/classify` handler
  - `extension/routes/router.mjs:828` — catch-all for unexpected errors in the `/kb/conflict-questions` handler

  In all three cases the response is written directly via `sendJSON(res, 500, { error: { code: 'UPSTREAM_ERROR', … } })`, not through `sendError`. This means the `overview.md` description ("Claude CLI, GitHub, or another upstream failed") is partially accurate — these handlers use it as a generic upstream-failure fallback — but it is not a first-class `AppError` code and has no factory.

  Additionally, `extension/src/lib/config.ts:439` constructs a client-side `ServerError` with code `'UPSTREAM_ERROR'` for non-OK HTTP responses from the server, but this is client-side only and not emitted by the server.

**Conclusion for implementers:** Clients that switch on error codes will only ever receive `UPSTREAM_ERROR` from `/kb/summarize`, `/kb/email/classify`, and `/kb/conflict-questions` (HTTP 500). `GUARDRAIL_FAILED` is never returned by the current server.

---

## 6. Rate-limit profiles

The full profile table is in [`../reference/rate-limit-profiles.md`](../reference/rate-limit-profiles.md).

### Scope rule

Rate limits are keyed by `(profileName, scope)` (`rate-limit.mjs:96`, `rate-limit.mjs:109`):

- **Authenticated routes:** scope = `req.user?.id || (req.socket?.remoteAddress || 'anon')` (`server.mjs:250`) — the user id when authenticated, otherwise the remote IP, finally the literal `'anon'` when no socket address is available
- **Unauthenticated routes (auth-routes):** scope = remote IP — e.g. `login:<ip>`, `reset-request:<ip>` (`auth-routes.mjs:191, 250`)

This means user A exhausting the `llm` profile does not affect user B.

### 429 `Retry-After` contract

When a bucket is exhausted, `tryConsume()` returns `{ ok: false, retryAfterSec: N }` where N = `ceil(need / refillRate)` (`rate-limit.mjs:116–117`). The server sets `Retry-After: N` as a string header and returns `429 RATE_LIMITED` with `details: { retryAfterSec: N }` (`server.mjs:254–255`, `errors.mjs:55–59`).

### Profile summary

| Profile | Capacity | Refill rate | Applied to |
|---|---|---|---|
| `agentTurn` | 12 | 1/5 s | `/agent/v2/stream`, `/kb/providers/turn`, `/kb/loop/agent-run` (chat turns and the Loop's headless agent step — the Mac engine starts auto-continue and follow-up turns on its own; one in-flight turn per chat is enforced separately) |
| `llm` | 3 | 1/30 s | `/kb/generate-plan`, `/kb/analyze-risks`, `/kb/generate-code`, `/kb/summarize`, `/kb/email/classify`, `/kb/mcp-connector/classify`, `/kb/conflict-questions` |
| `llmFast` | 6 | 1/5 s | `/generate-notes`, `/chat`, `/code-assist` (removed, 410), `/kb/agent/ask`, `/kb/complete`, `/generate-questions`, `/extract-entities`, `/generate-docx`, `/generate-doc`, `/kb/providers/verify`, `/kb/providers/models`, `/kb/providers/catalog/test`, `/kb/providers/catalog/models` |
| `dispatch` | 4 | 1/10 s | `/kb/dispatch`, `/kb/notify/slack`, `/kb/email/test`, `/kb/email/fetch`, `/kb/slack/test`, `/kb/slack/fetch`, `/kb/box/test`, `/kb/mcp-connector/test`, `/kb/mcp-connector/fetch`, `/kb/slack/conversations`, `/kb/google/gmail/fetch`, `/kb/google/sync`, `/kb/google/calendars`, `/kb/google/drive/folders`, `/kb/calendar-ical/sync` (reaches the feed host), `/kb/sync/test`, `/kb/sync/publish` (MEGA calls), `/kb/repos/check-token` (reaches GitHub or GitLab), `/kb/issues/create`, `/kb/issues/comment`, `/kb/issues/close` (each one GitHub or GitLab write), `/auth/me/extensions/install`, `/auth/me/extensions/catalog/refresh`, `/auth/me/extensions/updates/check`, `/auth/me/extensions/update/preview`, `/auth/me/extensions/update`, `/auth/me/extensions/repair` (each reaches GitHub or the MCP registry), `/kb/connect-box` (full external crawl — special-cased before the generic connect prefix) |
| `outcomePoll` | 6 | 1/30 s | `/kb/outcomes/refresh` |
| `kbWrite` | 30 | 5/s | `/bus/` (every command bus route), `/kb/ingest`, `/kb/connect-*`, `/kb/review/*`, `/kb/plan-task/*`, `/kb/issue-schedule*`, `/kb/usage/limits`, `/kb/agent-history/clear`, `/kb/agent-history/compact`, `PUT /kb/agent-history/settings`, `PUT /kb/providers/settings`, `PUT /agent/v2/session/route`, `GET /agent/v2/turns`, `GET /agent/v2/turns/stream`, `GET /kb/index/search`, `GET /kb/providers/custom`, `/kb/providers/catalog/connect`, `/kb/providers/catalog/disconnect`, `/kb/usage/record`, `/kb/email/seen`, `/kb/slack/seen`, `/kb/mcp-connector/seen`, `/kb/google/start`, `/kb/google/options`, `/kb/google/disconnect`, `/kb/google/gmail/seen`, `/kb/calendar-ical/sources` (POST and GET), `/kb/calendar-ical/options`, `DELETE /kb/calendar-ical/` (prefix), `POST /kb/activity`, `POST /kb/activity/seen`, `/kb/project/install-skills`, `/kb/docs/*` (PUT and DELETE; `POST /kb/docs/seed`), `POST /kb/projects/register`, `POST /kb/index/notes`, `POST /kb/index/reconcile`, `POST /kb/index/scan`, `DELETE /kb/index/notes/*`, `POST /kb/session-purges`, `POST /kb/archive-receipts`, `POST /agent/v2/sessions/purge`, `POST /kb/chat/sessions/*/archive/begin`, `POST /kb/chat/sessions/*/archive/commit`, `POST /kb/live/*/ack`, `/host-api/` (the pairing PIN `/host-api/pin`, devices), `/kb/sync/` (status, MEGA setup and the enable toggle), `/kb/self-heal/` (Self-Heal incidents, debug desktop builds), `/admin/members` (PATCH), `/admin/invites` (POST, DELETE), `POST /projects`, `/projects/` (PATCH, DELETE) |
| `liveAppend` | 30 | 5/s | `/kb/live/:id/append` (applied inside `routes/live.mjs:62`) |
| `kbExport` | 5 | 1/10 s | `GET /kb/export-all` |
| `authPublic` | 10 | 1/s | `/auth/login`, `/auth/refresh`, password-reset confirm/request |
| `authRegister` | 3 | 1/60 s | `/auth/register` |

Profile **definitions** (capacity + refill) are in `rate-limit.mjs:59–129`. The **URL→profile mapping** above is authoritative in `rateLimitProfile()` (`server.mjs:116–180`) — `rateLimitProfile()` returns the *first* match, so each URL has exactly one profile. The three `auth*`/`liveAppend` profiles are **not** dispatched by `rateLimitProfile()`; they are applied inside their own handlers (`server/auth-routes.mjs` for `authPublic`/`authRegister`, `routes/live.mjs` for `liveAppend`). This mapping is drift-guarded by `docs/_scripts/check_rate_limit_mapping.py`.

### Bucket persistence

Bucket state is saved to `rate_limit_buckets` in SQLite on auth-GC intervals and graceful shutdown (`saveBuckets`, `rate-limit.mjs:151`). On startup it is restored (`loadBuckets`, `rate-limit.mjs:179`), with tokens refilled for elapsed time since save. Rows older than `STALE_MS = 24 h` are pruned (`rate-limit.mjs:143`, `:184`). In memory, the live bucket Map is capped at `MAX_BUCKETS = 50_000` (`rate-limit.mjs:20`); when full, the oldest bucket is evicted before inserting a new one (`rate-limit.mjs:31`) so an attacker spraying distinct scopes cannot grow the map without bound.

---

## 7. Limits and guards

### JSON body limit

`config.bodyLimitMB` = `envInt('LLMIDE_BODY_LIMIT_MB', 8)` → **8 MB default** (`config.mjs:121`). Applied as bytes in `readBody()` via `DEFAULT_BODY_LIMIT = config.bodyLimitMB * 1024 * 1024` (`utils.mjs:8`). Exceeding the limit returns `413 VALIDATION_FAILED` (`utils.mjs:42`). A body that stalls mid-read is also bounded by time: `readBody()` arms a `READ_TIMEOUT_MS = 60_000` ms timer (`utils.mjs:12`) and rejects with `408 VALIDATION_FAILED` ("Request body read timed out", `utils.mjs:31`) if the full body has not arrived.

**Note:** The task description says the default is 2 MB. The verified source value at `config.mjs:121` is **8 MB**. The `.env.example` at `extension/.env.example:55` also shows `LLMIDE_BODY_LIMIT_MB=8`.

**Plugin install cap:** `MAX_ZIP_BYTES = 5 * 1024 * 1024` = **5 MB** (`extension/plugins/installer.mjs:43`). This is a separate hard limit on plugin zip file size, independent of the body limit.

### Prompt cap

`sanitizeForPrompt()` hard-caps output at **500 000 characters** (`utils.mjs:76`). It also strips `<<<[A-Z_]+>>>` fence markers to prevent prompt injection (`utils.mjs:70–76`). The agent runtime separately caps user message bytes at `MAX_USER_MESSAGE_BYTES = 500_000` bytes (`extension/llm_agent/runtime/loop.mjs:134`).

### CORS

`setCORS()` (`server.mjs:157–183`) never echoes `Access-Control-Allow-Origin: *`. The origin header is only echoed back when it matches one of:

- `chrome-extension://` prefix
- `http://localhost:<port>` or `https://localhost:<port>`
- `http://127.0.0.1:<port>` or `https://127.0.0.1:<port>`
- `http://[::1]:<port>` or `https://[::1]:<port>`
- an entry in `config.extraCorsOrigins` (env `LLMIDE_CORS_ORIGINS`, comma-separated)

If the origin is not allowed, no `Access-Control-Allow-Origin` header is set at all (`server.mjs:171–175`).

Security headers always set: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (`server.mjs:180–182`).

### Bind address

Default: `127.0.0.1:3456` (`config.mjs:113–114`). Binding a non-loopback address requires **both** a non-loopback `LLMIDE_HOST` value **and** `LLMIDE_ALLOW_REMOTE=1`. If `LLMIDE_HOST` is non-loopback and `LLMIDE_ALLOW_REMOTE` is not set, the server calls `process.exit(1)` before listening (`server.mjs:726–736`). When remote binding is active, a startup `warn` log `server_network_exposed` is emitted (`server.mjs:741–749`).

---

## 7b. Chat turn re-attach (API 96)

A webview reload drops the `POST /agent/v2/stream` connection. Two additive routes let a client find its running turns and re-attach (`extension/routes/agent-v2.mjs`, buffer in `extension/routes/turn-replay.mjs`):

| Route | Answers |
|---|---|
| `GET /agent/v2/turns` | `{ turns: [{ sessionId, startedAt, mode }] }`: the caller's running turns, oldest first. Another user's turns are never listed (the owner is compared, not parsed from a key). |
| `GET /agent/v2/turns/stream?sessionId=&after=` | SSE: every buffered event after the `after`-th (a count of events the client already holds, default 0), then live events, `id: <seq>` on each frame; ends when the turn ends. A first `replay_info` event `{ gap, dropped, ended }` appears when the ring dropped events the client asked for; an event over 256 KB is replaced by `replay_truncated`. 400 `VALIDATION_FAILED` (empty or over-200-character `sessionId`, `after` not an integer 0..1e9); 404 `NO_TURN` (no such turn, or another user's); 429 `TOO_MANY_READERS`. |

- **Memory only.** Each turn's events live in a per-turn ring: at most 2000 events and 4 MB, at most 64 turns, at most 4 attached readers per turn, dropped 60 s after the turn ends (a late reader replays and closes). Nothing is written to disk, so a core restart loses the buffer by design.
- **`detach: true`** on `POST /agent/v2/stream` (default false) keeps the turn running when its own stream drops; only `POST /agent/v2/cancel` (or the turn ending) stops it. Without the flag a dropped stream aborts the turn exactly as before, so the Mac app is unchanged.
- Both GETs use the `kbWrite` rate bucket; routes require the signed-in user like every `/agent/v2/*` route.
- Tests: `extension/tests/turn-replay-routes.test.mjs`. Contract: `schema/http/agent.schema.json`.

## 7c. Chat history paging (API 97)

`GET /kb/chat/sessions/:id?beforeSeq=&limit=` (`extension/routes/chat.mjs`, `getChatSession` in `extension/kb/chat-sessions.mjs`): `limit` defaults to 200 and is capped at 2000; `beforeSeq` (integer >= 1, otherwise 400 `VALIDATION_FAILED`) returns the newest `limit` messages with `seq` below it, oldest first, so a client pages backwards with `beforeSeq = messages[0].seq`. Without `beforeSeq` the answer is the newest page as before. The session object gains `hasMore` (older messages remain). Scoped to the caller's own sessions (another user's id is 404). Contract: `schema/http/agent.schema.json`; test: `extension/tests/chat-sessions.test.mjs`.

`DELETE /kb/chat/sessions/:id/messages/:seq` (API 128, the retry repair for U#F5): drops the **newest** assistant row, only when its stored meta says the stream cut it off (`interrupted: true` or `status: "interrupted"`), scoped to the caller's own session. Matching the desktop store, an older interrupted partial the user kept is refused (`409 MESSAGE_NOT_LATEST`), not `already_gone`. Answers `200 { deleted, seq, status }`; a repeat of the row that was just dropped is `deleted: false, status: "already_gone"`, so the call is idempotent. A complete reply (or any non-interrupted row) is `409 MESSAGE_NOT_INTERRUPTED`; a missing or another user's session is 404; a `seq` that is not an integer >= 1 is 400 `VALIDATION_FAILED`. The row is hard deleted rather than tombstoned: `chat_messages` has no soft-delete column and every reader (paging, the archive hash, the pre-archive count) would have to filter a marker, while this row is the partial the retry replaces, not history the user keeps. Contract: `schema/http/agent.schema.json`; test: `extension/tests/chat-message-drop.test.mjs`.

## 7d. Note index search and note kinds (API 98)

`GET /kb/index/search?q=&limit=&projectId=` (`extension/routes/index-routes.mjs`, `searchNotes` in `extension/kb/note-index.mjs`) answers `{ results: [{ noteKey, title, snippet, date, kind, projectId }] }` over the derived index's FTS rows (kind `note` in the shared `search` table; the public `/kb/search` still never returns them). The owner filter runs in SQL before the limit (`noteIndexHits`). `q` is 1 to 200 characters (400 otherwise; a query with no word of 2 or more characters answers an empty list), `limit` an integer 1 to 50 (default 20), `projectId` at most 200 characters (omitted: every project of the caller). The snippet is built from the already redacted `body_text`, redacted again, stripped of control, bidi and zero-width characters, whitespace-collapsed and cut to about 200 characters around the first matched word; it is plain text and no markup is interpreted. Rides the `kbWrite` bucket.

`POST /kb/index/notes` accepts `kind` in `meeting` (default), `note`, `email`, `slack`, `document`, `repo`, `plan`, `other`; any other value is a 400. `note_index.kind` is a free-text column, so no migration was needed (head stays 0057) and an N-1 server simply stores the same rows. The Mac app's meeting indexing and shadow compare are unchanged: the shadow compare filters hits to known meeting ids.

## 7e. Tool results beyond the stream's cap (not retained)

The core caps a streamed `tool_result` at `MAX_TOOL_RESULT_CHARS` in `extension/llm_agent/sdk/events.mjs` and marks it `truncated: true`; the full text is not kept by any core store (the usage and tool-accounting tables record sizes only). There is therefore **no route to fetch the full result**, and none is planned: adding one would mean retaining unbounded, possibly secret tool output in memory or on disk. Clients keep the truncated text and show the `truncated` flag; the Tauri chat does the same (parity row "Tool activity list").

## 7f. Command bus job API (API 100)

Nine additive routes under `/bus/` (`extension/routes/bus/bus-routes.mjs`, executor `extension/routes/bus/executor.mjs`, store `extension/kb/bus-store.mjs`): `POST /bus/commands`, `GET /bus/commands`, `GET /bus/commands/:id`, `GET /bus/commands/:id/events` (SSE), `POST /bus/commands/:id/cancel|approve|deny`, `GET /bus/approvals`, `GET /bus/kinds`, `PUT /bus/kinds/:kind`. All ride the `kbWrite` rate bucket and are per user. `LLMIDE_BUS=off` answers every one 503 `BUS_DISABLED` and never starts the job runner. Full contract, tiers, error codes and the engine rules: [command-bus](command-bus.md). Contract: `schema/http/bus.schema.json` (fixtures `schema/http/fixtures/bus/`) and `schema/bus/`. Tests: `extension/tests/command-bus.test.mjs`.

## 7g. Host-approved Bypass (API 101)

Only when the core was started by the Tauri host (`LLMIDE_HOST_APPROVAL_KEY` set: 64 hex characters, passed only to the spawned core). With it unset (the Mac app, the extension, a dev server) nothing changes: `permissionMode: "bypass"` is honoured as before and the header is ignored.

With it set, `POST /agent/v2/stream` with `permissionMode: "bypass"` (the only route that reads a permission mode; the session route, decision, cancel and bus routes ignore one, the bus never inherits Bypass) needs, all three: (1) `x-llmide-client: desktop-ui` (an ABSENT header is no longer enough), (2) the bus host proof `x-llmide-host-nonce` (`docs/spec/command-bus.md` section 1.4: `HMAC-SHA256(key, "bus-host-proof/v1")`, never the `/health` nonce), and (3) the header `x-llmide-host-approval: v2.<expiry_ms>.<nonce_hex32>.<mac_hex64>`, `mac = HMAC-SHA256(key, "llmide-host-approval/v2|bypass:<chatId>|<expiry_ms>|<nonce>")` (**format v2**: the token is bound to the chat in `agentContext.chatSessionId`, which must match `[A-Za-z0-9_.:-]{1,128}`; format owned by the host, `desktop/PACKAGING.md`). The legacy v1 token (`...v1|bypass|...`, not chat-bound) is accepted ONLY when `LLMIDE_HOST_APPROVAL_COMPAT=1` (default off). A request missing (1) or (2) is capped at Ask like a phone or extension origin, whatever token it carries. The core (`extension/core/host-approval.mjs`) checks the shape, compares the MAC in constant time, requires `now < expiry <= now + 60 s + 5 s skew`, and remembers the nonce until expiry (single use; in-memory, 4096 entries, a full set refuses). The token carries no user id or core nonce: the key is per launch and per core, and the token lives 60 s. A valid token opens a Bypass grant for that user and chat for 30 minutes (1024 entries, a full table refuses), so later turns of the chat need no new token; any turn of that chat asking for another mode ends the grant, and a grant is never used by another user, another chat or a capped origin. Missing, expired, replayed, wrong-key or tampered: `403 { error: { code: "HOST_APPROVAL_REQUIRED" } }` before any model call. A malformed key value fails closed (every Bypass refused).

Phone, extension and remote origins never get Bypass: a declared `x-llmide-client` other than `desktop-ui`, `agentContext.surface` of `extension`/`phone`/`mobile`/`ios`/`web`, or a non-loopback peer runs the turn as `ask`, token or not (the token is not spent). Audit rows (`audit_log`): `agent.bypass_turn` (success, `{ approvedBy: "host", via: "token"|"chat_grant" }`), `agent.bypass_refused`, `agent.bypass_capped`. The header, the key and token-shaped text are redacted (`core/redact-object.mjs`, `core/redact-secrets.mjs`); nothing logs them.

## 7h. Google connectors (API 103)

Ten additive routes under `/kb/google/` (`extension/routes/google-connectors.mjs`): `POST /kb/google/start`, `GET /kb/google/status`, `GET /kb/google/accounts`, `POST /kb/google/disconnect`, `POST /kb/google/options`, `GET /kb/google/calendars`, `GET /kb/google/drive/folders`, `POST /kb/google/gmail/fetch`, `POST /kb/google/gmail/seen`, `POST /kb/google/sync`. Fetch and sync ride the `dispatch` rate-limit bucket, start, options, disconnect and seen the `kbWrite` bucket. Migration 0059. Full contract: [google-connectors](google-connectors.md) and `schema/http/google.schema.json`. No existing route or field changed.

## 7i. iCal feed connector (API 104)

Five additive routes under `/kb/calendar-ical/` (`extension/routes/calendar-ical.mjs`): `POST` and `GET /kb/calendar-ical/sources`, `DELETE /kb/calendar-ical/sources/:id`, `POST /kb/calendar-ical/sync`, `POST /kb/calendar-ical/options`. Sync rides the `dispatch` rate-limit bucket, the others `kbWrite`. Migration 0060. The feed URL is a bearer secret: write-only, vault only. Full contract: [calendar-ical](calendar-ical.md) and `schema/http/calendar-ical.schema.json`. No existing route or field changed.

## 7j. Issues paging and fields (API 105)

Additive; no new route. `GET /kb/issues` pages in SQL over the caller's own ticket rows (`kb.listTicketSources`, `extension/kb/sources.mjs`). Query: `repo`, `state` (default `open`, `all` disables), `provider` (default `github`), `limit` (default 20, capped at 100; zero, negative, NaN or a fraction below 1 gives 20), `offset` (default 0; negative, NaN or empty is 0; past the total is an empty page). Order: `updatedAt` descending, then row id descending. The answer is `{ issues, total, hasMore, nextOffset }`, where `total` counts all filtered rows and `nextOffset` is null on the last page. Each issue adds `milestone` (`{ title, dueOn }` or null) and `assignees` (logins), and `url` now carries the stored issue URL. Filters, ordering and paging are index-backed on `(user_id, kind)` only (the JSON filters and the `updatedAt` sort scan that user's ticket rows); measured at about 20 ms a page for a user with 20 000 tickets, so no migration was added. Each GitHub import is capped at 2 000 rows a repo, but many repos or the JSON importer can grow the set further.

The GitHub importer (`POST /kb/connect-github-issues`, `extension/connectors/issues.mjs`) follows pages until a short page, at most 20 pages of 100 per run (the Mac app's limit), 2 000 rows, or 60 s. A run that stops early answers `truncated: true` with `pages`. Re-running replaces the repo's rows, keyed by the issue URL (provider, repo and number), so nothing is stored twice. Host pinning, the vault token and the redirect and size rules are unchanged. GitHub's issue object has no due date of its own; the milestone's due date is returned as `milestone.dueOn`.

Not built in this step: the per-issue comments read (`GET /kb/repo/issues/:key/comments`). It needs the repo allowlist, the provider adapters and the GitHub key format, which are part of the issues core slices IC1 to IC3 (`docs/superpowers/plans/2026-10-31-issues-gantt-core-plan.md`).

## 7k. Repo keys, create-only docs, import truncation, SDK busy summary (API 106)

Additive; no new route. Four changes, each with its contract in `schema/http`:

- **Nested GitLab repo keys.** The issue schedule overlay (`/kb/issue-schedule`, `extension/kb/issue-schedule.mjs`) accepts a GitLab repo of 2 to 20 `/`-separated segments (group/sub/project), 255 characters at most. Each segment is `[A-Za-z0-9._-]+` and never `.` or `..`. GitHub stays exactly `owner/name`. Ownership and the list scope are unchanged (per user).
- **Create-only template and command writes.** `PUT /kb/docs/templates/:folder` and `PUT /kb/docs/commands/:folder` take `createOnly: true`. An existing folder (any case, or one whose `template.md` is oversize or unreadable, which the list skips) answers `409 TEMPLATE_EXISTS` (`COMMAND_EXISTS` for a command) and writes nothing. Creation is an exclusive `mkdir`, so two concurrent creates cannot both succeed. Without the flag the write-or-rewrite behaviour is unchanged. Contract: `schema/http/docs.schema.json`.
- **GitHub import under truncation.** `POST /kb/connect-github-issues` (`extension/connectors/issues.mjs`) replaces a repo's rows only when the run finished (no cap, budget or limit stopped it). A run that stopped early upserts what it fetched and deletes nothing, and a run that errors midway keeps every stored row. A GitHub secondary limit (429, or 403 with `Retry-After`) stops the run cleanly: the result carries `retryAfter` (seconds, or `null`). A 403 without `Retry-After` is still the primary limit or an auth failure and throws as before.
- **Busy summary for the SDK updater.** `GET /kb/agent-sdk` adds `busy: { chatTurns, loopRuns, total }`, counts across all users with no ids. `chatTurns` is the turn lock (`activeTurnCount`), `loopRuns` the Loop agent runs in flight (`extension/core/agent-busy.mjs`, counted by `POST /kb/loop/agent-run`). The update (`POST /kb/agent-sdk/update`) is refused while either count is above zero (`updateSdk` in `extension/llm_agent/sdk/updater.mjs`; the refusal log names the running chat turns or Loop runs), so the SDK is never swapped under a running Loop agent. A Loop run that starts while an update is already in progress is not refused (open item).

## 7l. Hosted issue writes (API 116)

`POST /kb/issues/create { provider, repo, title, body?, idem }`, `POST /kb/issues/comment { provider, repo, number, body }` and `POST /kb/issues/close { provider, repo, number }` (`extension/routes/issue-writes.mjs`, feature `gantt_issues`, dispatched from `issue-schedule.mjs`) are the only writes the core makes to GitHub or GitLab for the Issues board. Order of checks: the bus host proof (`403 HOST_PROOF_REQUIRED`, desktop only), the body (`400 VALIDATION_FAILED` with `details.field`: provider `github|gitlab` required; repo GitHub `owner/name` or GitLab 2 to 20 segments, at most 200 characters, no `.`/`..` segment; title 1 to 255 characters after trimming; body at most 20 000 characters, never cut short; number a positive integer; `idem` 16 to 64 of `[A-Za-z0-9_-]`), the board allowlist (`kb.findTicket`: an imported ticket row of the caller for that provider, repo and, for comment and close, number, whose stored URL starts with `https://github.com/` or `https://gitlab.com/`, else `403 REPO_NOT_ALLOWED`; a PR or MR row is `400 NOT_AN_ISSUE`), then the vault token (`github.token` / `gitlab.token`, else `400 GITHUB_TOKEN_MISSING` / `GITLAB_TOKEN_MISSING`). The one provider call goes through the pinned fetch to the fixed host `api.github.com` or `gitlab.com/api/v4` (GitLab project paths URL-encoded as one segment), with a 15 s timeout. Answers: `200 { ok, id, url, state }` (`deduped` on create); the provider's 401 → `403 TOKEN_UNAUTHORIZED`, 403 or 404 → `403 TOKEN_FORBIDDEN`, 400 or 422 → `400 PROVIDER_REJECTED`, anything else → `502 PROVIDER_ERROR`, no answer → `502 PROVIDER_UNREACHABLE`. The core never answers 401 here. Create runs once per `(user, idem)` for 10 minutes, in memory with at most 500 keys: the same content replays the first answer with `deduped: true`, other content is `409 IDEM_CONFLICT`, and a failed attempt frees the key. A successful close sets the board row's `state` to `closed`. Each request writes one `audit_log` row (`issues.create|comment|close`, resource `<provider>:<repo>[#<number>]`, outcome, detail `{ status, code[, deduped] }`) with no title, body or token. Rides the `dispatch` bucket. A self-hosted GitLab and the operation toggles in Settings → Repositories are not enforced here (see the plan `docs/superpowers/plans/2026-11-07-hosted-issue-writes.md`).

## 7m. Self-Heal incidents (API 121) and fix runs (API 122)

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

**Fix runs (API 122, plan B):**

- **`POST /kb/self-heal/runs { repoRoot, max? }`** starts the user's one run (in memory, 4 h lease).
  - Answers: `409 RUN_ACTIVE` with `details.runId`, and `409 REPO_NOT_ALLOWED` unless `repoRoot` is exactly an allow-listed root.
  - It picks up to `max` (default 5, at most 20) `new`, non-environmental incidents, most frequent first, and moves them to `fixing`. Environmental ones it meets become `ignored`.
  - It returns `{ runId, incidentIds, batch }`, where `batch` is the `.self-heal/BATCH.md` text (`extension/core/self-heal-batch.mjs`), or `{ runId: null, … }` when there is nothing to fix.
- **`POST /kb/self-heal/runs/:id/outcome`** ends the run (`409 RUN_NOT_ACTIVE` otherwise).
  - Only the lines under the last `## Results` are read.
  - `fixed` with `verifyPassed`, `hasChanges` and a `proposal` on branch `self-heal/<id>` → `proposed`. `environmental` → `ignored`. `agentDown` / `aborted` → `new`. Anything else → `attempts + 1`, `needsHuman` at 3.
- **`POST /kb/self-heal/runs/:id/resolve { result: applied | discarded }`** turns the run's `proposed` incidents into `fixed` / `ignored` and clears the proposal.
- **Suppression:** while a run is open, `POST /kb/self-heal/incidents` skips `log` and `server` reports.
- **Who does what:** the desktop host owns the worktree, `make regression` and the patch (`desktop/src-tauri/src/self_heal_fix.rs`). The fix itself is one `POST /kb/loop/agent-run` on the worktree.

Incident text is data. It is never logged, and it reaches a model only fenced inside `BATCH.md`, in a run the user started.

## 7n. Team Hub H1: members and invites (API 123)

The core enforces team authority (ADR 0021, `docs/decisions/0021-team-hub.md`). Authority lives in `members`
(`extension/kb/members.mjs`, migration 0068): `teamRole` (`owner > admin > member > viewer`), `maxMode`
(`none | read_only | execute`) and `usdCapMonth` (0 = no cap). `users.role` stays the legacy flag and is never read
at a route. A solo install does not change: migration 0068 makes the earliest active non-legacy user `owner` with
`execute`, every other existing user `member` with `execute`, and a registration with no invite keeps
`member`/`execute` unless `LLMIDE_HUB=1` (then `member`/`read_only`/20 USD).

`GET /auth/me` gains `member: { teamRole, maxMode, usdCapMonth, permissions }` (null for the `legacy` data-owner row; `permissions` was added by API 124).

The admin routes (`extension/routes/team-routes.mjs`, contract `schema/http/team.schema.json`, always on, no feature
group) need the JWT and the admin team role (`403 ROLE_DENIED`); writes ride `kbWrite`:

- `GET /admin/members` → `{ members: [{ userId, email, displayName, status, teamRole, maxMode, usdCapMonth, updatedAt }] }`, role first then email.
- `PATCH /admin/members/:userId { teamRole?, maxMode?, usdCapMonth? }` → `{ member }`. Closed body (`400 VALIDATION_FAILED`). Rules: an actor may only touch a member at or below their own role (`403 ROLE_DENIED` for an admin touching an owner, or granting above their own role), nobody edits their own role or grants (`403 SELF_GRANT`), and the last owner cannot be demoted (`409 LAST_OWNER`). `usdCapMonth` 0-100000.
- `POST /admin/invites { email?, teamRole?, maxMode?, usdCapMonth?, ttlHours? }` → `{ id, token, expiresAt }`. The token is 32 random bytes (base64url) shown once; only its SHA-256 is stored; single use, 24 h by default, 1-168 allowed. An invite cannot make an owner (`403 ROLE_DENIED` as `teamRole` has no `owner` value), and an `admin` invite needs an owner actor. `email` ≤ 254 characters, compared case-insensitively.
- `GET /admin/invites` → `{ invites: [...] }`, newest first, never the token or its hash.
- `DELETE /admin/invites/:id` → `{ revoked }` (`false` when no invite had that id).

`POST /auth/register` accepts an optional `invite` token. While registration is closed (`LLMIDE_DISABLE_REGISTRATION=1`,
hub mode, or a remote bind without `LLMIDE_ALLOW_REMOTE_REGISTRATION=1`) a valid invite registers the account with the
invite's grants and burns it in one transaction; unknown, used, expired or wrong-email tokens all answer
`403 REGISTRATION_CLOSED` (never revealing whether the token existed). `LLMIDE_HUB=1` (`config.hub`) closes
registration, switches a no-invite registration's defaults to `read_only` / 20 USD, and logs `server_hub_mode` at boot.

A turn above the member's `maxMode` is refused `403 { error: { code: 'ROLE_DENIED', message: 'Your team role cannot run turns' } }`
(`max_mode` `none`, audited `team.deny` with `{ reason }` and no message text) or clamped to a read-only mode. Host API
pairing grants a viewer `host`, `read`, `push`, `chat` and `approvals` (Ask only, API 124), and a `max_mode` none member
only `host`, `read`, `push`.

`usd_cap_month` is a MONTHLY cap, enforced in two places, never per turn. `usage_ledger.cost_usd` (migration 0069)
carries each turn's USD cost (null when the engine or a CLI turn reports none), and `usedUsdMonth` sums it for the
user's current month: a turn is refused `429 { error: { code: 'USD_CAP', message: 'Monthly USD cap reached' } }` once
that sum reaches the cap (audited `team.deny` `{ reason: 'usd_cap' }`), and `usdCapForModel` hands the engine the
REMAINING budget (`min(model cap, cap - used)`) so one turn cannot cross the month line. `PUT /kb/usage/limits` stays
self-service but may not write a usd row above the member's cap.

Every finished turn (success, Stop or failure) writes one `audit_log` row: `action: 'turn.end'`, outcome `success`
or `failure`, detail `{ chatId, mode, model, provider, toolNames, costUsd, stopReason }` — unique tool names, the
ledger cost, and never the prompt, the reply, a file path or tool input/output text.

The owner rules hold on both delete routes, not only on `PATCH /admin/members/:id`: `DELETE /admin/users/:id` answers
`403 ROLE_DENIED` when the target is an owner the actor may not touch and `409 LAST_OWNER` for the last owner;
`POST /auth/me/delete` answers `409 LAST_OWNER` for the sole owner (a second owner makes either deletable).

## 7o. Team Hub H1.2: every route within its role (API 124)

Every method + path the core serves has exactly ONE action class (`extension/kb/members.mjs` `CLASS_GRANTS`,
table in ADR 0021): `public`, `self.read`, `self.write`, `model.ask`, `model.read`, `model.exec`, `fs.read`,
`fs.write`, `external.read`, `external.write`, `install`, `admin`, `host`. `extension/server/route-authority.mjs`
`ROUTE_POLICY` assigns each route one class and `server.mjs` applies it after authentication and rate limiting.

- **Deny by default:** an authenticated request that matches no rule answers `404 { error: { code: 'NOT_FOUND',
  message: 'Not found' } }` and logs `route_policy_unlisted` with the method and path only.
- **Refusals:** `403 { error: { code: 'ROLE_DENIED', message } }` (role or `max_mode`) and `429 { error: { code:
  'USD_CAP', message } }`; exactly one `team.deny` audit row with `{ reason }` only. A disabled feature keeps its
  own `404 feature_disabled`.
- **Turn concurrency (API 125):** at most `LLMIDE_MAX_TURNS` (`config.maxConcurrentTurns`, default 8, clamped
  1-64) chat turns run at once, process-wide, HTTP and Host API alike; the per-chat 409 `TURN_IN_PROGRESS` is
  unchanged. A turn that waits 30 s for a slot answers `429 { error: { code: 'BUSY', message } }` before the engine
  starts, so it writes no usage row.
- **Roles (user decision 2026-11-08):** owners, admins and engineers (role `member`) do all work; `install` is
  member + execute; `admin` is team management only. A viewer may only Ask: `model.ask` on `/agent/v2/stream`,
  `/agent/v2/decision` and `/kb/agent/ask`, and `runV2Turn` forces the turn to the read-only `ask` mode with no
  permission mode (HTTP and Host API alike).
- **`GET /auth/me`** adds `member.permissions: string[]` — the classes the caller may use, in table order, cap not
  applied. Additive; older clients ignore it.
- **Host API `COMMAND_CLASS`** re-checks the class on every frame (`chat.send` / `approvals.answer` = `model.ask`,
  `toolApprovals.answer` = `model.exec`), so a demotion applies on the next frame.
- **Hub pairing (API 125):** in hub mode (`LLMIDE_HUB=1`) a VPS hub has no desktop-spawned host proof, so
  `POST /host-api/pin`, `GET/DELETE /host-api/devices*` and `/host-api/push/*` take the caller's JWT + the `member`
  team role instead (`403 ROLE_DENIED` for a viewer). Outside hub mode the bus host proof stays mandatory and
  nothing else changes.
- **Background jobs** re-check when they act: the bus executor (`KIND_CLASS`), the meeting agent (`tickRun`) and the
  outcome poller (`usersAllowedToPoll`).

## 7p. Team Hub H1.3: project-scoped roles (API 126)

ADR 0022 adds a per-project grant beside the team grant. Migration 0070 creates `projects(id, name, root,
created_by, created_at, updated_at)`, `project_members(user_id, project_id, role, max_mode, usd_cap_month,
granted_by, updated_at)` and the nullable `usage_ledger.project_id` (with `(user_id, project_id, ts)`). The
role order is `viewer < member < admin < owner`. **No project row is a viewer** on that project.

The effective project grant is computed in ONE place (`extension/kb/projects.mjs` `computeProjectGrant`): a
global team owner/admin overrides every project (team grant); a global team viewer stays a viewer even if a
project row names them higher (H1.2); a global member/engineer gets the project row or the implicit viewer
default; `max_mode` is the tighter of the global/project values; the USD cap is the tighter positive cap.
`project.admin` (project membership management) is a class of its own, never the team `admin` class.

Routes (`extension/routes/project-routes.mjs`, always on, contract `schema/http/projects.schema.json`; writes
ride `kbWrite`):

- `GET /projects` → `{ projects: [{ id, name, role, maxMode, usdCapMonth, permissions }] }`; every registered
  project with the caller's effective role (unassigned = viewer). Self read only.
- `GET /projects/:id/members` → `{ project: { id, name }, members: [{ userId, email, displayName, status, role,
  maxMode, usdCapMonth, updatedAt }] }`; explicit rows only.
- `POST /projects/:id/members { email, role?, maxMode?, usdCapMonth? }` → `{ member }`; adds an existing account
  by email (defaults viewer/read_only/20).
- `PATCH /projects/:id/members/:userId { role?, maxMode?, usdCapMonth? }` → `{ member }`.
- `DELETE /projects/:id/members/:userId` → `{ removed }`; the member falls back to the implicit viewer.

The membership routes need project admin/owner (or a global team admin/owner), answer `403 ROLE_DENIED`, and
reject an unknown body key, an unknown project/account (404) or an invalid role/mode/cap (400). An actor may
not change their own project role (`403 SELF_GRANT`), cannot touch a role above their own, and cannot grant
above their own. Every write is audited (`project.member.grant` / `project.member.revoke` with the project,
user and grant only) and written through to `team.yaml` atomically; a failed file write rolls the row back
(500). `GET /auth/me` adds `projects` with the same rows (additive).

`POST /kb/projects/register { id, root, name? }` also creates/updates the canonical registry row; a NEW
project's registrar becomes its project owner (`owner`/`execute`/no cap). A caller who is not a project manager
may still register their own Doc Gen folder mapping but never rewrites the project's name/root. The whole
`doc_gen` feature gate still applies to this route.

`route-authority.mjs` resolves a project id from `?project=` / `?projectId=` (Doc Gen, index search) or
`/projects/:id/...`, and checks the effective project grant for the route's class. A body-carried project id is
checked by its handler. A chat turn resolves `body.projectId`, `agentContext.projectId`, or the registered
`agentContext.workspaceRoot` (`projects.root`), then uses the project role/mode and the project cap
(`usedUsdMonthForProject`); its ledger rows carry `project_id`. No project id keeps today's team clamp.

Host API v1 (additive): `projects.list` (capability `host`) returns the device's projects with the effective
role. `chat.send`, `chat.new`, `chat.snapshot`, `chat.history.clear`, `chat.cancel`, `chat.options`,
`approvals.answer` and `toolApprovals.answer` accept an optional `projectId`; the gateway re-checks the fresh
project grant on EVERY frame (unassigned = viewer; refusal `denied`, unknown project `not_found`, cap `denied`
with the USD message) and forwards `projectId` to `startHostTurn`. A frame without `projectId` keeps the v1
team behavior, so existing pairings keep working.

`team.yaml` gains an optional `projects:` section (project id → lower-cased email → the same three keys as
`members:`). A file without the section leaves the DB project rows alone (upgrade-safe); once present it is
authoritative: a missing account row is deleted (implicit viewer). Generation writes the DB rows; each API
membership change writes through atomically. Invalid YAML/role/mode/cap/project id fails the boot closed;
unknown project ids and emails are ignored and audited.

## 7r. Hub pairing (API 129)

On a hub (`LLMIDE_HUB=1`) the Host API listener binds loopback behind nginx. `POST /host-api/pin`
answers `port: 443`, `url` (`wss://<hub>/host-api/v1`), the **front certificate's leaf SPKI**
`fingerprint`, and the hub hostname in `addresses`; a missing `LLMIDE_HOST_API_FINGERPRINT_FILE` or
`LLMIDE_HUB_PUBLIC_URL` is `503 HUB_PIN_UNAVAILABLE`. Outside hub mode the answer is unchanged.
`host.hello` gains `hostKind: "hub"`.

## 7q. Per-project chat history (API 128)

Host API v1 clients (phone/web) can keep one chat history per project. Migration 0074 indexes
`chat_sessions(user_id, project_id, updated_at DESC)` and adds `host_api_project_chat(user_id, project_id,
chat_session_id)`; `project_id` has existed on `chat_sessions` since 0023. A session written before 0074 has
`project_id` NULL and is the **legacy/global** chat (an existing pairing that sends no project keeps its
conversation). The desktop app's local chat store is a different store and is unchanged.

`chat.sessions` and `chat.history` now accept the same optional `projectId` (`[A-Za-z0-9_-]{1,128}`) as the
other chat frames. A Host API list is always scoped: with `projectId` it is that project's sessions; without
one it is the `project_id IS NULL` legacy/global sessions, so one project's chats never appear in another
project's list. `chat.new` creates (and points the project's current phone chat at) a session with that
`project_id`; `chat.send` / `chat.snapshot` / `chat.history.clear` use the current chat of the frame's
project. `chat.history` compares the stored `project_id` with the frame's: a session belonging to another
project answers the error frame's 403 class (`denied`) with a message starting `PROJECT_MISMATCH`, and a
cross-user id stays `not_found`.

On a hub (`LLMIDE_HUB=1`) every project-scoped Host API command must name a project; the gateway answers
`denied` with `PROJECT_REQUIRED` otherwise. An unassigned caller is a viewer on that project (Ask only), as
in API 126. `GET /kb/chat/sessions` accepts an optional `projectId` query (omitted = every chat, unchanged;
an invalid id is 400 `VALIDATION_FAILED`) for a shared server-side list. The web and iOS History views send
the picker's selected project on `chat.sessions`/`chat.history` and clear the previous project's rows when the
picker changes. Tests: `extension/tests/host-api-project-chat.test.mjs`,
`extension/tests/migration-0074-chat-project.test.mjs`, `extension/tests/chat-sessions.test.mjs`,
`web/tests/read-controller.test.mjs`, `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift`.

## 7s. Plan-task assignment (API 130)

Migration 0075 adds `plan_task_assignments` (one current row per task: `task_id` PK, `plan_id`,
`project_id`, `assignee_user_id`, `assigned_by`, `assigned_at`, `updated_at`, all real FKs) and the
append-only `plan_task_assignment_log` (`action` = `assign` | `reassign` | `unassign`, from/to/actor).
`plan_tasks.owner` stays planner-authored TEXT and is never read as an account. A task's project is
`plans.meta.projectId`; a plan without one cannot be assigned (`400 PROJECT_REQUIRED`).

Rules (one home: `kb/plan-assignments.mjs`):

- The assignee must have effective project role `member` or higher — an explicit `project_members`
  row, or a global team owner/admin. An implicit viewer, a project `viewer` row and a global team
  viewer answer `403 NOT_PROJECT_MEMBER` (a team viewer is not lifted by a project row, H1.2).
  Cross-project ids are refused by the same check.
- Assigning another account needs project admin/owner (or a global team admin/owner); otherwise
  `403 ROLE_DENIED`. A project member may self-assign an unassigned task (`userId` omitted or
  `null`) and may release their own task; taking a task from another member answers
  `403 SELF_CLAIM_DENIED`.
- Assigning the current assignee again is idempotent (`changed: false, action: null`).
  Unassign is idempotent (`unassigned: false`).

Routes:

- `GET /kb/plan-task/assignments[?projectId=][&limit=]` → `{ assignments, count }`. Only the
  caller's own rows, and only for projects they still belong to (an explicit project row, or a
  global team owner/admin); `limit` is 1-200 (default 100). Each row carries `taskId`, `planId`,
  `projectId`, `projectName`, `planTitle`, `title`, `status`, `due`, `milestone`, `owner`,
  `assignee { userId, displayName, email }`, `assignedBy` (nullable), `assignedAt`.
- `GET /projects/:id/plan-tasks` → `{ project: { id, name }, tasks }`. Every plan task tagged with
  the project, newest plan first, with `assignee` (`null` when unassigned). Requires project
  membership (`role >= member`); a viewer answers `403 ROLE_DENIED`.
- `POST /kb/plan-task/assign { taskId, userId? }` → `{ assignment, changed, action }`. `userId`
  omitted or `null` means the caller. `action` is `assign`, `reassign`, or `null` when unchanged.
- `POST /kb/plan-task/unassign { taskId }` → `{ unassigned, taskId }`.

Every change writes one `plan_task_assignment_log` row and one `audit_log` row
(`plan.task.assign` / `plan.task.unassign`; detail `{ planId, projectId, fromUserId, toUserId,
reassigned, self }`, never a title or body). Assigning another account also writes one in-app
`task_assigned` activity row (no email, no push). `GET /kb/plan/:id` gains `projectId`; stored plan
tasks gain `assignee` (`{ userId, displayName, email, assignedAt }` or `null`). A re-plan keeps an
assignment only when the task id survives and the plan's project is unchanged.

Contract: `schema/http/planning.schema.json`, `schema/http/projects.schema.json`. Test:
`extension/tests/plan-task-assignments.test.mjs`; UI `ui/screens/settings/tests/team-projects.test.mjs`.
External GitHub/GitLab issue assignees are **not** implemented (they need provider write APIs).

## 8. See also

- [`../explanation/server-internals.md`](../explanation/server-internals.md) — narrative explanation of request flow, shutdown, and background tasks
- [`../explanation/architecture.md`](../explanation/architecture.md) — high-level system architecture

---

## Regeneration checklist

- [x] Every governed symbol/endpoint/table/prompt is present with its exact shape — endpoint presence is checker-verified, and per-endpoint OpenAPI schemas were handler-verified in the 2026-06 fidelity sweep (§3).
- [x] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [x] Spot-check: auth lifecycle, the rate-limit URL→profile mapping, vault crypto, and the body/prompt caps were rebuilt from this page and match source.
- [x] Structured facts link to their extractor-generated reference page (no hand-copied drift).
