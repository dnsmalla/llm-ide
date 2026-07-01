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
| Route handlers | `extension/server/auth-routes.mjs`, `extension/server/ai-routes.mjs`, `extension/server/export-routes.mjs` |
| KB router | `extension/kb/router.mjs` (mounted under `/kb`) |
| Rate limiting | `extension/server/rate-limit.mjs` |
| Observability | `extension/server/audit.mjs`, `extension/server/metrics.mjs` |
| User / token store | `extension/server/users.mjs`, `extension/server/vault.mjs` |
| Control-plane helpers | `extension/server/control-plane.mjs` |
| Shared core | `extension/core/config.mjs`, `extension/core/errors.mjs`, `extension/core/logger.mjs`, `extension/core/utils.mjs` |

`extension/core/env-compat.mjs` aliases legacy `MEETNOTES_*` env vars to `LLMIDE_*` before any config is read (`server.mjs:2`).

---

## 2. Request pipeline

Every inbound HTTP request passes through these stages **in order** (`extension/server.mjs:185–529`):

1. **CORS headers set** (`server.mjs:186`) — `setCORS()` runs unconditionally before any other logic. Never echoes `*`; see [§7 Limits & guards](#7-limits--guards).
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

`SERVER_API_VERSION = 18` (`server.mjs:34`). Clients compare this value against the `apiVersion` field returned in `GET /` and `GET /health`. If the client's expected version exceeds the server's, the client surfaces "restart the server to pick up new endpoints." The `ENDPOINTS` array (`server.mjs:35–103`) is also returned in both responses so clients can detect missing capabilities by name.

### Server timeouts

| Parameter | Value | Source |
|---|---|---|
| `server.requestTimeout` | 300 000 ms (5 min) | `server.mjs:629` |
| `server.headersTimeout` | 65 000 ms | `server.mjs:630` |
| `server.keepAliveTimeout` | 60 000 ms | `server.mjs:631` |

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

See [§4 Auth + token lifecycle](#4-auth--token-lifecycle) for auth endpoint contracts and [§5 Error codes](#5-error-codes) for the full error-code table.

---

## 4. Auth + token lifecycle (rebuild-grade)

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

Defined in `extension/server/auth.mjs:20–28`:

```
GET  /
GET  /health
GET  /launch-app   (and /launch-app?…)
POST /auth/register
POST /auth/login
POST /auth/refresh
GET  /auth/well-known
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

- `UPSTREAM_ERROR`: No factory in `errors.mjs`. The code is emitted in **two places** via raw `sendJSON` (bypassing `AppError`/`sendError`):
  - `extension/kb/router.mjs:571` — catch-all for unexpected errors in the `/kb/summarize` handler
  - `extension/kb/router.mjs:828` — catch-all for unexpected errors in the `/kb/conflict-questions` handler

  In both cases the response is written directly via `sendJSON(res, 500, { error: { code: 'UPSTREAM_ERROR', … } })`, not through `sendError`. This means the `overview.md` description ("Claude CLI, GitHub, or another upstream failed") is partially accurate — these two handlers use it as a generic upstream-failure fallback — but it is not a first-class `AppError` code and has no factory.

  Additionally, `extension/src/lib/config.ts:439` constructs a client-side `ServerError` with code `'UPSTREAM_ERROR'` for non-OK HTTP responses from the server, but this is client-side only and not emitted by the server.

**Conclusion for implementers:** Clients that switch on error codes will only ever receive `UPSTREAM_ERROR` from `/kb/summarize` and `/kb/conflict-questions` (HTTP 500). `GUARDRAIL_FAILED` is never returned by the current server.

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
| `llm` | 3 | 1/30 s | `/code-assist`, `/kb/generate-plan`, `/kb/analyze-risks`, `/kb/generate-code`, `/kb/summarize`, `/kb/conflict-questions` |
| `llmFast` | 6 | 1/5 s | `/generate-notes`, `/chat`, `/kb/agent/ask`, `/generate-questions`, `/extract-entities`, `/generate-docx`, `/generate-doc`, `/kb/providers/verify`, `/kb/providers/models` |
| `dispatch` | 4 | 1/10 s | `/kb/dispatch`, `/kb/notify/slack`, `/kb/email/test`, `/kb/email/fetch`, `/kb/slack/test`, `/kb/slack/fetch` |
| `outcomePoll` | 6 | 1/30 s | `/kb/outcomes/refresh` |
| `kbWrite` | 30 | 5/s | `/kb/ingest`, `/kb/connect-*`, `/kb/review/*`, `/kb/plan-task/*`, `/kb/issue-schedule*`, `/kb/usage/limits`, `/kb/usage/record`, `/kb/email/seen`, `/kb/slack/seen`, `POST /kb/activity`, `POST /kb/activity/seen` |
| `liveAppend` | 30 | 5/s | `/kb/live/:id/append` (applied inside `kb/routes/live.mjs:62`) |
| `kbExport` | 5 | 1/10 s | `GET /kb/export-all` |
| `authPublic` | 10 | 1/s | `/auth/login`, `/auth/refresh`, password-reset confirm/request |
| `authRegister` | 3 | 1/60 s | `/auth/register` |

Profile **definitions** (capacity + refill) are in `rate-limit.mjs:59–129`. The **URL→profile mapping** above is authoritative in `rateLimitProfile()` (`server.mjs:107–151`) — `rateLimitProfile()` returns the *first* match, so each URL has exactly one profile. The three `auth*`/`liveAppend` profiles are **not** dispatched by `rateLimitProfile()`; they are applied inside their own handlers (`server/auth-routes.mjs` for `authPublic`/`authRegister`, `kb/routes/live.mjs` for `liveAppend`). This mapping is drift-guarded by `docs/_scripts/check_rate_limit_mapping.py`.

### Bucket persistence

Bucket state is saved to `rate_limit_buckets` in SQLite on auth-GC intervals and graceful shutdown (`saveBuckets`, `rate-limit.mjs:151`). On startup it is restored (`loadBuckets`, `rate-limit.mjs:179`), with tokens refilled for elapsed time since save. Rows older than `STALE_MS = 24 h` are pruned (`rate-limit.mjs:143`, `:184`). In memory, the live bucket Map is capped at `MAX_BUCKETS = 50_000` (`rate-limit.mjs:20`); when full, the oldest bucket is evicted before inserting a new one (`rate-limit.mjs:31`) so an attacker spraying distinct scopes cannot grow the map without bound.

---

## 7. Limits & guards

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

## 8. See also

- [`../explanation/server-internals.md`](../explanation/server-internals.md) — narrative explanation of request flow, shutdown, and background tasks
- [`../explanation/architecture.md`](../explanation/architecture.md) — high-level system architecture

---

## Regeneration checklist

- [x] Every governed symbol/endpoint/table/prompt is present with its exact shape — endpoint presence is checker-verified, and per-endpoint OpenAPI schemas were handler-verified in the 2026-06 fidelity sweep (§3).
- [x] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [x] Spot-check: auth lifecycle, the rate-limit URL→profile mapping, vault crypto, and the body/prompt caps were rebuilt from this page and match source.
- [x] Structured facts link to their extractor-generated reference page (no hand-copied drift).
