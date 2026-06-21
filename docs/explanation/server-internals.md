---
title: Server internals
status: stable
---

# Server internals

!!! info "Rebuild-grade detail"
    This page explains *how and why*. For exact contracts (auth lifecycle, error codes, full DDL, vault layout) see [`../spec/api-server.md`](../spec/api-server.md) and [`../spec/knowledge-base.md`](../spec/knowledge-base.md).

A self-hostable, multi-user system that turns meeting recordings into
structured project work and tracks outcomes back into a knowledge base.

## Layers

```text
┌─────────────────────────────────────────────────────────────────┐
│  Chrome side panel  (React 18 + TS)                             │
│  Auth: stores access token in memory; refresh in chrome.storage │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Authorization: Bearer <JWT>
                          │ HTTPS (production) / HTTP (loopback)
┌─────────────────────────▼───────────────────────────────────────┐
│  Node HTTP server (server.mjs)                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Per-request:                                            │    │
│  │   1. CORS check                                         │    │
│  │   2. Request-ID + structured logger child               │    │
│  │   3. authenticate() — verify JWT, attach req.user       │    │
│  │   4. handleAuth()  for /auth/*                          │    │
│  │   5. rate limit per (profile, userId)                   │    │
│  │   6. handleKB()    for /kb/*                            │    │
│  │   7. legacy LLM endpoints (/generate-*, /chat...)       │    │
│  │   8. record metrics + audit                             │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────┬─────────────┬──────────────┬─────────────────────────────┘
       │             │              │
       ▼             ▼              ▼
┌────────────┐ ┌──────────┐ ┌────────────────────┐
│ kb/db.mjs  │ │ agents/  │ │ guardrails/rules.mjs│
│  WAL+FTS5  │ │ planner  │ │ Pure JS rule engine │
│  Tenanted  │ │ codegen  │ │  blocking|warning   │
│  via       │ │ dispatcher│ │  |info severities   │
│  user_id   │ │ ...      │ └────────────────────┘
└────────────┘ └──────────┘
```

## Module layout

`kb/db.mjs` is the public storage façade — every consumer imports
from it as `import * as kb from './db.mjs'`. Internally, db.mjs is a
small re-export shell + the shared helpers (`getDb`, `closeDb`,
`lazyPrepare`, `genId`, `safeJSONStringify`, `safeParseMeta`) +
the cross-cutting `search` / `findContext` / `deleteUserCascade`
that span every domain. Domain-specific CRUD lives in sibling files
under `kb/` and is re-exported through db.mjs:

| Sub-module          | What it owns                                              |
|---------------------|-----------------------------------------------------------|
| `kb/meetings.mjs`   | `ingestMeeting`, `getMeeting`, `listMeetings`, entities, `stats`, `statsAdmin` |
| `kb/sources.mjs`    | `ingestSources`, `deleteSourcesByPrefix` (code/ticket/qa/doc) |
| `kb/plans.mjs`      | `savePlan`, `listPlans`, `updateTask`, `mergeTaskMeta` + task CRUD |
| `kb/personas.mjs`   | Multi-persona registry + Ask-the-Agent history             |
| `kb/feedback.mjs`   | Agent-question verdicts + per-task aggregate stats         |
| `kb/reviews.mjs`    | Phase-6 review queue (dispatch / codegen-apply approvals)  |
| `kb/outcomes.mjs`   | Task outcome polling history + aggregate stats             |
| `kb/user.mjs`       | Repo allow-list, UI prefs, JWT revocation list             |

HTTP routing follows the same pattern: `kb/router.mjs` is the
dispatch shell, with route families lifted out under `kb/routes/`:

| Route module               | URL prefix             |
|----------------------------|------------------------|
| `kb/routes/agent.mjs`      | `/kb/agent/*`          |
| `kb/routes/planning.mjs`   | `/kb/generate-plan`, `/kb/analyze-risks`, `/kb/code-sync`, `/kb/plan/*`, `/kb/plan-task/update`, `/kb/dispatch`, `/kb/generate-code` |
| `kb/routes/live.mjs`       | `/kb/live/*` (incl. SSE stream + per-user concurrency cap) |
| `kb/routes/review.mjs`     | `/kb/review/*`         |

Every sub-module defines its own (identical) `requireUser` rather
than importing one from db.mjs — that's intentional, sub-modules
can't import the helper without creating a circular dependency.
The guard's contract is one line so duplication is cheaper than
the cycle.

## Tenancy

Every owned row carries a `user_id` foreign key.  The tenancy contract:

- **No bare-user functions.**  Every state-mutating helper in `kb/db.mjs`
  takes `userId` as its first parameter and includes it in the `WHERE`
  clause or `INSERT` row.  `requireUser` panics if it's missing.
- **FTS5 is shared but hydration is scoped.**  Cross-tenant FTS hits
  exist in the index, but the `findContext` / `search` paths drop any
  hit whose hydration query (filtered by `user_id`) returns nothing.
- **The router enforces the gate.**  `kb/router.mjs` reads `req.user.id`
  and passes it to every call.  Without it, the router returns 401.
- **Pre-existing data goes to `legacy`.**  The 0002 migration
  back-fills `user_id = 'legacy'` and provisions a corresponding
  disabled user so nothing orphans.

## Identity

- **Access token** — HS256 JWT, 15 min default, signed with
  `LLMIDE_JWT_SECRET`.  Claims: `iss`, `sub` (userId), `role`,
  `typ='access'`, `iat`, `exp`.  Issuer is verified, alg is locked
  to HS256, and signature compare is constant-time.
- **Refresh token** — opaque random base64url string, hashed
  (sha256) before storage.  Rotates on every `/auth/refresh`; old
  token is revoked atomically with the new one's issuance.
- **Bcrypt cost 12** by default; configurable.  Login does
  `compareSync` even for unknown emails (against a sentinel hash) so
  response time can't reveal account existence.

## Credential vault

- `user_secrets(user_id, secret_key, ciphertext)` — `ciphertext` is
  `version_byte || iv(12) || aes-256-gcm(plaintext) || tag(16)`.
- **Per-user data key** = `HKDF-SHA256(masterKey, salt=userId,
  info='llmide-vault-v1', length=32)`.  An attacker who reads the
  DB can't decrypt without the master key, and a leak of one user's
  rows doesn't help against another.
- Allow-listed keys: `github.token`, `backlog.apiKey`,
  `linear.apiKey`, `slack.webhookUrl`.

## Audit log

- `audit_log(user_id, request_id, ip, user_agent, action, resource,
  outcome, detail, created_at)`.
- Recorded for: register, login (success and failure), password
  change, secret set/delete, logout, plus the high-blast-radius KB
  actions (review approve/reject audit coverage is a planned follow-up).
- `detail` is JSON with credentials redacted by key name (`token`,
  `apiKey`, `password`, `webhookUrl`, etc.).

## Rate limiting

- Token-bucket per `(profile, scope)`.  Profiles tuned for the
  workload (LLM heavy / fast, dispatch, outcome poll, KB write,
  `authPublic`).
- Scope is the `userId` for authenticated routes, the remote IP for
  unauthenticated ones.  This means a single user can't burst past
  their quota across machines, and a credential-stuffing attacker
  can't slip past the login limit by rotating accounts.
- 429 responses carry a `Retry-After` header.

## Migrations

- `kb/migrations/NNNN_<name>.sql`.  Sorted by version, applied inside
  a transaction with their checksum recorded.
- Editing an already-applied migration throws and refuses to start in
  `NODE_ENV=production`; in dev/test it logs a checksum-mismatch warning
  and continues. Production fail-fast is intentional — schema drift
  between deployed instances must be resolved with a new migration.
- No "down" migrations.  Disaster recovery == backup restore.

## Database

- SQLite with WAL, `synchronous=NORMAL`, `busy_timeout=5000`,
  `wal_autocheckpoint=1000`, `mmap_size=64MB`, `temp_store=MEMORY`.
- Single writer at a time (better-sqlite3 is synchronous).  WAL gives
  concurrent readers.
- Graceful shutdown calls `wal_checkpoint(TRUNCATE)` before close so
  the main DB file is flush after SIGTERM.

## Observability

- **Logs**: structured JSON-per-line in production
  (`LLMIDE_LOG_JSON=1`), pretty in dev TTY.  Every log line
  includes `requestId` so a single user action can be traced through
  the agent layer and external API calls.
- **Metrics**: Prometheus text format at `GET /metrics`.  Counters
  for HTTP requests, rate-limit denies, audit events; gauges for KB
  record counts; histogram for HTTP latency.
- **Health**: `GET /health` returns status, API version, schema
  version, uptime, endpoint capability list, and dependency checks.
  Public — needed by liveness probes and the extension's stale-server
  detection.

## Threat model

| Adversary | Defense |
|---|---|
| Drive-by request from another tab/extension | CORS allowlist + JWT auth |
| Stolen access token | TTL 15 min; refresh rotation detects reuse |
| Stolen refresh token (one-time) | Rotation revokes the old; reuse fails |
| DB read leak (backup, snapshot) | Vault encrypted with separate master key |
| Tenant A reading tenant B | `user_id` scoping on every query; FTS hydration drops cross-tenant rows |
| Brute-force login | bcrypt cost 12; per-IP rate limit 10/sec |
| Account enumeration via timing | Constant-time bcrypt compare for unknown emails |
| Credential-leak via logs | `redact` strips keys named `token`/`apiKey`/`password`/etc. |
| Path traversal in code apply | Guardrails + allowlist + safeJoin (3 layers) |
| Prompt injection in transcript | `<<<BEGIN>>>…<<<END>>>` delimiters + sanitizers |
| Server-side request forgery | Slack webhook URL parsed, host pinned to `hooks.slack.com` |
| Replay of expired token | `exp` validated against wall clock with 2s skew |
| `alg=none` JWT impersonation | Header check rejects anything but `HS256` |

## What's deferred

- **OIDC / SSO** — would replace the email/password flow with an
  OAuth2 authorization code flow against an IdP.  Schema supports it
  (drop the password column dependency).
- **Postgres backend** — current SQLite design is fine to ~50
  concurrent users.  Past that, swap `kb/db.mjs` for a
  pg-backed implementation; the public API stays the same.
- **RBAC beyond role=admin/user** — would add team membership and
  resource-level grants.  Schema reserves `role` for this.
- **Background outcome poller** — currently client-driven (no
  credentials persisted server-side without an explicit user store).
  For autonomous polling, use vault-stored creds and a cron loop.
- **Real-time collaboration** — WebSocket layer for live plan
  updates between multiple sessions on the same plan.
- **Email + push notifications** — out of scope for the current
  Slack-only delivery channel.
