---
title: Cross-cutting — spec
status: draft
---

# Cross-cutting — spec

This page is the connective layer over the four subsystem specs: it gathers the security model, configuration, build/deploy entry points, observability, and system-wide invariants that span every subsystem in one navigable place, linking to the authoritative per-unit pages rather than restating their detail.

---

## §1 Scope

Cross-cutting concerns are properties that cannot be owned by a single subsystem:

| Concern | What it governs |
|---|---|
| **Security model** | Threat model, network isolation, identity, vault, prompt injection, rate limiting, audit |
| **Configuration & environment** | Env vars, secrets, feature flags, per-environment defaults |
| **Build, run & deploy** | CLI scripts, toolchain requirements, native modules, systemd |
| **Observability** | Structured logging, Prometheus metrics, health probe |
| **System-wide invariants** | Per-row tenancy, stale-server detection, migration protocol, single-writer SQLite |

Each section below states the cross-cutting shape and links to the spec or reference page that carries the full contract.

---

## §2 Security model (hard constraints)

### Threat model

Source: [`../explanation/security-model.md`](../explanation/security-model.md).

**In scope:** transcript exfiltration, credential theft from the vault, prompt injection from meeting content, denial of service against the local server, cross-site attack against the loopback API, accidental destructive operations in dispatched code changes.

**Out of scope:** physical access to the user's machine, malicious browser extensions installed by the user, compromise of the user's Claude CLI authentication.

### Security controls

| Control | Shape | Authoritative detail |
|---|---|---|
| **Network isolation** | Binds `127.0.0.1` by default; CORS allowlist echoes origin only for `chrome-extension://`, `localhost`, `127.0.0.1`, `[::1]` — never `*`; non-loopback binding requires `LLMIDE_ALLOW_REMOTE=1` | [`api-server.md` §7](api-server.md#7-limits--guards) |
| **Identity** | JWT HS256, bcrypt cost 12, opaque refresh tokens (SHA-256 stored, never plaintext), per-refresh rotation, clock skew ±2 s (`jwt.mjs:14`) | [`api-server.md` §4](api-server.md#4-auth--token-lifecycle-rebuild-grade) |
| **Vault** | AES-256-GCM + HKDF-SHA256, 11 allow-listed keys (`vault.mjs:110–137`): `github.token`, `backlog.apiKey`, `linear.apiKey`, `slack.webhookUrl`, `slack.botToken`, `email.imapPassword`, `claude.apiKey`, `openai.apiKey`, `google.apiKey`, `custom.apiKey`, `custom.baseUrl` | [`knowledge-base.md` §6](knowledge-base.md#6-vault-crypto) |
| **Guardrails** | Secret/PII/destructive scanners in `extension/guardrails/rules.mjs`; applied at submit and again at approval | [`../reference/guardrail-rules.md`](../reference/guardrail-rules.md) |
| **Prompt injection** | Tool-result fences (`<<<TOOL_RESULT>>>`/`<<<END_TOOL_RESULT>>>` wrapping each result; forged `<<<TOOL_CALL>>>` blocks rejected) + ZWJ redaction of any `<<<`/`>>>` markers in embedded external text (`redaction.mjs:16–18`); server-side `sanitizeForPrompt()` (`extension/core/utils.mjs:72–76`) strips fence markers and hard-caps at 500 000 chars | [`agent-runtime.md` §3](agent-runtime.md#3-fence-protocol) |
| **Rate limiting** | Token-bucket per `(profile, scope)`; 9 profiles | [`api-server.md` §6](api-server.md#6-rate-limit-profiles) + [`../reference/rate-limit-profiles.md`](../reference/rate-limit-profiles.md) |
| **Audit log** | `audit_log(user_id, request_id, ip, ua, action, resource, outcome, detail, created_at)`; credential-pattern fields redacted before write | [`../explanation/security-model.md`](../explanation/security-model.md#audit-log) |

### DoS caps (verified in source)

| Cap | Value | Source |
|---|---|---|
| Request body | **8 MB** default (`config.bodyLimitMB`) | `extension/core/config.mjs:121` |
| Prompt length | **500 000 chars** hard cap | `extension/core/utils.mjs:76` |

`config.mjs:121`: `bodyLimitMB: envInt('LLMIDE_BODY_LIMIT_MB', 8)`

`utils.mjs:76`: `return text.replace(PROMPT_FENCE_RE, '').slice(0, 500_000);`

The authoritative body-limit value is **8 MB** at `config.mjs:121`; the `security-model.md` explanation page agrees (8 MB). Do not reintroduce the historical 2 MB figure.

---

## §3 Configuration & environment

Canonical tables: [`../reference/env-vars.md`](../reference/env-vars.md) (full env-var reference, extractor-generated) and [`../reference/configuration.md`](../reference/configuration.md) (runtime config object shape).

### Production-required variables

These three must be set explicitly; the server exits at startup if they are absent in `NODE_ENV=production`:

| Variable | Purpose |
|---|---|
| `LLMIDE_JWT_SECRET` | Signs access + refresh tokens (HS256). Minimum 32 chars. |
| `LLMIDE_VAULT_KEY` | Master key for HKDF per-user vault key derivation. Minimum 32 chars. |
| `NODE_ENV=production` | Disables dev-secret auto-generation; enables prod defaults (JSON logs, `info` level). |

Source: `extension/core/config.mjs:65–84`.

### Dev auto-generated secrets

When `NODE_ENV` is not `production` and either `LLMIDE_JWT_SECRET` or `LLMIDE_VAULT_KEY` is absent, the server auto-generates both and persists them to a `.dev-secrets.json` file under the runtime `kb/` data directory (path built in `config.mjs:49–63`). That file is created lazily at first boot, so it does not exist in a fresh checkout; it is also listed in `.gitignore` and must **never** be used in production.

### Loopback override

`LLMIDE_ALLOW_REMOTE=1` is required to bind a non-loopback address. Without it, a non-loopback `LLMIDE_HOST` causes `process.exit(1)` at startup (`server.mjs:721–735`).

Do not restate the full env-var table here — consult [`../reference/env-vars.md`](../reference/env-vars.md).

---

## §4 Build, run & deploy

Full CLI reference: [`../reference/cli-scripts.md`](../reference/cli-scripts.md) (`setup.sh`, `run.sh`, and supporting scripts).

### Makefile targets

`Makefile` defines the following targets (verified at `Makefile:5–86`):

| Target | What it does | Line |
|---|---|---|
| `build` | `cd extension && npm run build` | 14 |
| `test` | `cd extension && npm test` | 11 |
| `lint` | `cd extension && npm run lint && npm run format:check` | 6 |
| `format` | `cd extension && npm run format && npm run lint:fix` | 9 |
| `test-mac` | `cd mac && swift build && swift test` | 27 |
| `regression` | Alias for `test-mac`; intended as pre-upgrade gate | 34 |
| `hooks` | `git config core.hooksPath .githooks` — enables pre-push hook | 40 |
| `docs-deps` | Creates `.venv-docs` and installs `docs-requirements.txt` | 52 |
| `docs-serve` | `mkdocs serve -a 127.0.0.1:8000` | 57 |
| `docs-build` | `mkdocs build --strict` | 60 |
| `docs-lint` | markdownlint-cli2 + lychee link check + frontmatter check | 63 |
| `docs-refresh-reference` | Runs all extractor scripts to regenerate reference pages | 73 |
| `docs-check` | `pytest docs/_scripts/` + the API-coverage, rate-limit-mapping, spec-citation, and spec-value drift guards | 81 |

### Runtime requirements

- **Server:** Node.js **≥ 20** (`extension/package.json:7–9`, `engines.node: ">=20.0.0"`).
- **`better-sqlite3`** is a **native module** compiled against the running Node ABI. It must be compiled against the exact Node version in use — do not `npm install` locally if the Node ABI differs from the target environment. Route dependency bumps through CI where the native build is verified (`extension/package.json:29`).

### Client builds

- macOS desktop app: [`../how-to/build-the-macos-app.md`](../how-to/build-the-macos-app.md)
- Production (extension zip + server bundle): [`../how-to/ship-production-build.md`](../how-to/ship-production-build.md)

### Production systemd

Environment variable wiring for a `systemd` `EnvironmentFile` deployment: [`../reference/env-vars.md`](../reference/env-vars.md).

---

## §5 Observability

### Structured logging

Source: `extension/core/config.mjs:141–142`, `extension/core/logger.mjs`.

| Flag | Effect |
|---|---|
| `LLMIDE_LOG_JSON` | `true`/`1` → newline-delimited JSON; default `true` in production, pretty-print in dev TTY (`logger.mjs:13`) |
| `LLMIDE_LOG_LEVEL` | `debug` / `info` / `warn` / `error`; default `debug` in dev, `info` in prod (`config.mjs:141`) |

Every request generates a `requestId` (read from `X-Request-ID` or generated fresh at `server.mjs:194–199`). It is threaded through the per-request child logger as `req.log` and appears in every log line emitted during that request (`logger.mjs:35`).

### Prometheus metrics

`GET /metrics` — requires **admin JWT** (`server.mjs:493–509`, `auth.test.mjs:140–141`). Returns Prometheus text format. Served by `extension/server/metrics.mjs` (`renderPrometheus`). Metrics include HTTP request counts, rate-limit deny counts, KB gauge, and server uptime (`llmide_uptime_seconds`, `metrics.mjs:171–173`).

### Health probe

`GET /health` (also `GET /`) — **unauthenticated**, public (`server.mjs:275`, `auth.mjs:22`). Response shape (from `extension/server/control-plane.mjs:1–21`):

```json
{
  "status": "ok" | "degraded",
  "apiVersion": <number>,
  "schemaVersion": <number>,
  "uptimeSec": <number>,
  "endpoints": [...],
  "checks": { "db": bool, "claude": bool, "claudeError": "..." }
}
```

`status` is `"degraded"` if either the DB or Claude CLI probe is unhealthy. Operators needing verbose detail should authenticate and use `GET /metrics` or `GET /auth/me/audit`.

For narrative context on request flow and background tasks: [`../explanation/server-internals.md`](../explanation/server-internals.md).

---

## §6 Cross-subsystem invariants

Full invariant catalogue: [`../explanation/invariants.md`](../explanation/invariants.md).

The following invariants cross subsystem boundaries and are restated here as system-wide MUSTs:

### Per-row user_id tenancy

Every owned row in the database carries a `user_id` foreign key. Every state-mutating helper in `kb/db.mjs` takes `userId` as its first parameter; the KB router reads `req.user.id` and threads it through every call. A missing or invalid user returns 401 before any data access.

Detail: [`knowledge-base.md` §4](knowledge-base.md#4-tenancy-contract).

### Stale-server detection

`SERVER_API_VERSION = 18` (`server.mjs:34`). Both `GET /` and `GET /health` return this value as `apiVersion`. Clients compare against their expected version; a mismatch surfaces "restart the server" rather than a raw 404. The `endpoints` array is also returned so clients can detect missing capabilities by name.

Detail: [`api-server.md` §2](api-server.md#2-request-pipeline) (API version and stale-server detection).

### Append-only migrations

Migrations are numbered files applied exactly once and recorded in the `schema_migrations` table. The head migration is `0021` (`0021_user_settings.sql`). Migrations are never edited after they land; schema changes always add a new migration file.

Source: `extension/kb/migrations.mjs:8`, `migrations.mjs:43`.

### Single-writer SQLite

The server opens one SQLite connection per process (WAL mode). There is no connection pool; concurrent requests share the single `better-sqlite3` handle. A second server process binding the same `LLMIDE_DB_PATH` would corrupt the WAL.

Detail: [`knowledge-base.md`](knowledge-base.md) (§1 source files, db.mjs).

---

## §7 See also + regen checklist

- [`../explanation/security-model.md`](../explanation/security-model.md) — threat model, audit log, known limitations (plugin trust boundary)
- [`../explanation/architecture.md`](../explanation/architecture.md) — high-level system architecture
- [`../explanation/invariants.md`](../explanation/invariants.md) — full engineering invariants catalogue
- [`../explanation/server-internals.md`](../explanation/server-internals.md) — narrative request flow, shutdown, background tasks

Subsystem specs: [`api-server.md`](api-server.md) · [`knowledge-base.md`](knowledge-base.md) · [`agent-runtime.md`](agent-runtime.md) · [`chrome-extension.md`](chrome-extension.md) · [`macos-app.md`](macos-app.md)

Reference pages: [`../reference/env-vars.md`](../reference/env-vars.md) · [`../reference/configuration.md`](../reference/configuration.md) · [`../reference/guardrail-rules.md`](../reference/guardrail-rules.md) · [`../reference/rate-limit-profiles.md`](../reference/rate-limit-profiles.md) · [`../reference/cli-scripts.md`](../reference/cli-scripts.md)

## Regeneration checklist

- [x] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [x] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [x] Spot-check: the security controls, the prod-required env vars, and the build/deploy entry points were rebuilt from this page and match source.
- [x] Structured facts link to their extractor-generated reference page (no hand-copied drift).
