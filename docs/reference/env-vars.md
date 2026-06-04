---
title: Environment variables
source: extension/core/config.mjs
---

# Environment variables

Single source of truth for every `process.env` read the server makes.
Use this page when:

- Setting up a fresh production install
- Auditing a deployment for missing required vars
- Looking up the default + valid range of a tuning knob
- Tracking down "why is X behaving differently here?"

## Production setup checklist

These vars **must** be set before the server starts in `NODE_ENV=production`:

| Var | Why required | Generate with |
|---|---|---|
| `LLMIDE_JWT_SECRET` | Signs access + refresh tokens. ≥32 chars. Rotation: [how-to/rotate-jwt-secret](../how-to/rotate-jwt-secret.md). | `openssl rand -base64 48` |
| `LLMIDE_VAULT_KEY` | Master key for per-user encrypted credential vault. ≥32 chars. Rotation: [runbooks/rotate-vault-key](../runbooks/rotate-vault-key.md). | `openssl rand -base64 48` |
| `NODE_ENV` | Distinguishes dev (auto-generates secrets) from prod (refuses to start without them). | set to `production` |

Without `LLMIDE_JWT_SECRET` + `LLMIDE_VAULT_KEY`, the server
will refuse to start with:

> `LLMIDE_JWT_SECRET and LLMIDE_VAULT_KEY must be set in production.`

In `NODE_ENV=development`, both auto-generate into
`kb/.dev-secrets.json` (gitignored). Convenient for local work but
**never use the dev fallback in a customer-facing install** — a
restart re-generates the secrets and invalidates every JWT in flight.

## Should-set-for-production

Strongly recommended for any deployment that's not your laptop:

| Var | Why | Typical value |
|---|---|---|
| `LLMIDE_DB_PATH` | Default puts the DB inside the repo dir, which a `git pull --force` can destroy. Pick a path on a fast SSD outside the working tree. | `/var/lib/llmide/data.db` |
| `LLMIDE_HOST` | Default `127.0.0.1` blocks remote access. Override only if you intentionally want LAN reach (rare). | `127.0.0.1` |
| `LLMIDE_DISABLE_REGISTRATION` | Closes `/auth/register` so attackers can't create accounts. Set after the operator has registered their own user. | `1` |
| `LLMIDE_LOG_JSON` | Force JSON-per-line logs even when stdout looks like a TTY (e.g. systemd-journal). | `1` |
| `LLMIDE_LOG_LEVEL` | Drop `debug` and `trace` in prod to reduce log volume. | `info` |

## Security-sensitive (handle with care)

| Var | Effect |
|---|---|
| `LLMIDE_BCRYPT_COST` | Bcrypt rounds for password hashing. Lower = faster login but easier offline crack. Range: 10-14, default 12. **Don't go below 10.** Server refuses to start outside that range. |
| `LLMIDE_TRUST_PROXY` | When `1`, the server honors `X-Forwarded-For` for rate-limit/audit IPs. Only enable if a trusted reverse proxy fronts the server — otherwise clients can spoof their source IP. |
| `LLMIDE_CORS_ORIGINS` | Comma-separated additions to the always-accepted `chrome-extension://*` + `localhost` + `127.0.0.1` allowlist. Use to whitelist a specific browser extension ID in production. |
| `LLMIDE_ACCESS_TTL_SEC` | Access token lifetime. Shorter = better, but more refresh churn. Default `900` (15 min). |
| `LLMIDE_REFRESH_TTL_SEC` | Refresh token lifetime. Determines "stay signed in for N days". Default `2592000` (30 days). |

## Tuning knobs

| Var | Effect | Default |
|---|---|---|
| `LLMIDE_PORT` | Listen port. Mac client + extension are hard-coded to 3456; changing requires coordinated client updates. | `3456` |
| `LLMIDE_BODY_LIMIT_MB` | Cap on JSON request bodies. `/auth/me/plugins/install` has its own 5 MB cap independent of this. | `2` |
| `LLMIDE_JWT_ISSUER` | `iss` claim in minted JWTs. Cosmetic unless verifying tokens externally. | `llmide` |

## Complete table

Below is the full list extracted from
[`extension/core/config.mjs`](../../extension/core/config.mjs). The
preceding sections curate the same variables with operator-facing
context; this table is the unannotated canonical reference.

To regenerate the auto-generator's output after touching
`core/config.mjs`:

```bash
python3 docs/_scripts/extract_env_vars.py
```

<!-- maintained alongside extension/core/config.mjs -->

| Name | Type | Default |
|---|---|---|
| `LLMIDE_ACCESS_TTL_SEC` | int | `900` (15 min) |
| `LLMIDE_BCRYPT_COST` | int | `12` |
| `LLMIDE_BODY_LIMIT_MB` | int | `2` |
| `LLMIDE_CORS_ORIGINS` | str | _(empty)_ |
| `LLMIDE_DB_PATH` | str | `<repo>/kb/data.db` |
| `LLMIDE_DISABLE_REGISTRATION` | bool | `false` |
| `LLMIDE_HOST` | str | `127.0.0.1` |
| `LLMIDE_JWT_ISSUER` | str | `llmide` |
| `LLMIDE_JWT_SECRET` | str | _(required in prod)_ |
| `LLMIDE_LOG_JSON` | bool | `true` in prod / `false` in dev |
| `LLMIDE_LOG_LEVEL` | str | `info` in prod / `debug` in dev |
| `LLMIDE_PORT` | int | `3456` |
| `LLMIDE_REFRESH_TTL_SEC` | int | `2592000` (30 days) |
| `LLMIDE_TRUST_PROXY` | bool | `false` |
| `LLMIDE_VAULT_KEY` | str | _(required in prod)_ |
| `NODE_ENV` | str | `development` |

## Worked examples

### Minimal production systemd unit

```ini
[Service]
EnvironmentFile=/etc/llmide/env.secret
Environment=NODE_ENV=production
Environment=LLMIDE_DB_PATH=/var/lib/llmide/data.db
Environment=LLMIDE_DISABLE_REGISTRATION=1
Environment=LLMIDE_LOG_JSON=1
ExecStart=/usr/bin/node /opt/llmide/extension/server.mjs
Restart=on-failure
RestartSec=5s
```

Where `/etc/llmide/env.secret` (chmod 600, root-only) contains:

```
LLMIDE_JWT_SECRET=<48-char output of `openssl rand -base64 48`>
LLMIDE_VAULT_KEY=<48-char output of `openssl rand -base64 48`>
```

### Mac launchd plist

Similar shape. Put the two secrets in `EnvironmentVariables`, set
`NODE_ENV=production`, and rely on Keychain Access for storage of the
plist itself (don't world-read it).

### Local dev

`NODE_ENV=development` (or unset) + no env vars at all. The server
writes `kb/.dev-secrets.json` on first boot and reuses it across
restarts. Safe for laptop work; never copy that file to a production
host.

## Why no `.env` file support?

Deliberate. `.env` files leak into commits, container images, and
crash dumps unless you're rigorous. Production secrets belong in your
secret manager (systemd `EnvironmentFile`, launchd, AWS Secrets
Manager, etc.) — that's what those tools are for. Local dev gets the
auto-generated `kb/.dev-secrets.json` which is gitignored.

## See also

- [Server boot failure modes](../runbooks/server-wont-start.md) —
  when the env vars are wrong, you see one of the messages there.
- [Vault key rotation](../runbooks/rotate-vault-key.md) — how to
  change `LLMIDE_VAULT_KEY` without breaking existing secrets.
- [JWT secret rotation](../how-to/rotate-jwt-secret.md).
