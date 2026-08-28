---
name: deploy-prod
description: Ship a generated auto-system app to production. Use when the user says "deploy", "push to prod", "Dockerize this", "set up CI/CD", "run migrations on prod", "we're going live", "rollback", or asks about env vars, image builds, or release sequencing. Covers the path from a `compliance`-clean repo to a running server with live migrations and observability.
---

# Deploy to production

Auto-system generates a compliance-clean app; it does **not** yet ship the prod plumbing (Dockerfile, CI, migration runner, observability wiring). This skill closes that gap with production-standard patterns keyed to the existing config blocks.

## When to use

- First production cut of a generated project
- "Our CI is broken" / "We need a deploy pipeline"
- "Run the migration on prod" (never run `drizzle-kit push` against prod)
- "We need to roll back the last release"
- Standing up staging / canary environments

## Pre-flight — compliance must be green

```
./master.sh compliance   # exit 0
./master.sh status       # exit 0
```

If either fails, fix before proceeding. Deploying with unresolved drift (e.g. client/server auth policy mismatch from 4C) is how outages start.

## The four shippable artifacts

| Artifact | Where | Source of truth |
|----------|-------|-----------------|
| Server image | `services/core-api/Dockerfile` | Dockerfile in repo + `backend.port` |
| Web image (or static bundle) | `apps/web/Dockerfile` or `apps/web/out/` | Dockerfile + Next build output |
| Migration runner | one-off job, not the server | `database.migrationsPath` + drizzle-kit |
| Client (iOS/Android) binary | platform-specific | Xcode / Gradle |

## Server Dockerfile (template)

```dockerfile
# services/core-api/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY services/core-api/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY services/core-api ./

FROM node:20-alpine
WORKDIR /app
# drop privileges
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app
COPY --from=builder --chown=app:app /app .
ENV NODE_ENV=production
EXPOSE {{backend.port}}
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:{{backend.port}}/ready || exit 1
CMD ["node", "dist/server.js"]
```

**Rules:**
- Never run as root in the final image.
- Health-check against `/ready`, not `/health` — `/health` is process-liveness, `/ready` is "can accept traffic" (has DB, has warmed caches).
- Pin Node version (not `node:latest`).
- Multi-stage to keep dev deps out of prod.

## Env vars — derived from system.yaml

Required at boot (names come from config):

| Env | Source | Example |
|-----|--------|---------|
| `PORT` | `backend.port` | `3001` |
| `NODE_ENV` | — | `production` |
| `{database.urlEnvVar}` | `database.urlEnvVar` | `DATABASE_URL=postgres://…` |
| `{backend.cors.allowedOriginsEnv}` | optional | `CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com` |
| `{backend.observability.tracingEnvVar}` | when `tracingEnabled: true` | `OTEL_EXPORTER_OTLP_ENDPOINT=…` |
| Auth secrets (JWT / session) | not yet in schema — add as Layer-5 | `SESSION_SECRET=$(openssl rand -hex 32)` |

Keep secrets in a secret manager (AWS SM / Vault / Doppler), not env files checked into the image or the repo.

## CI pipeline (GitHub Actions shape)

```yaml
name: deploy
on:
  push: { branches: [main] }
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - name: Install core
        run: npm ci --prefix .system-controller/submodules/.auto_system_engine/core
      - name: Compliance
        run: .system-controller/submodules/.auto_system_engine/master.sh compliance
      - name: Build core-api
        run: npm ci --prefix services/core-api && npm run build --prefix services/core-api
      - name: Build web
        run: npm ci --prefix apps/web && npm run build --prefix apps/web
      - name: Test
        run: |
          npm test --prefix services/core-api
          npm test --prefix apps/web
      - name: Build image
        run: docker build -t $REGISTRY/core-api:${{ github.sha }} -f services/core-api/Dockerfile .

  migrate:
    needs: build-test
    runs-on: ubuntu-latest
    # Manual gate — never auto-migrate without review
    environment: prod-migrations
    steps:
      - run: npx drizzle-kit generate:pg
      - run: psql "$DATABASE_URL" -f services/core-api/db/migrations/000_extensions.sql
      - run: npx drizzle-kit migrate

  deploy:
    needs: migrate
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - run: docker push $REGISTRY/core-api:${{ github.sha }}
      - run: kubectl set image deployment/core-api core-api=$REGISTRY/core-api:${{ github.sha }}
      - run: kubectl rollout status deployment/core-api --timeout=120s
```

## Migration discipline

**Never** run schema migrations from the web app pod at boot. Always a **dedicated job** that runs *before* the app deploy:

1. `drizzle-kit generate:pg` (build: diffs schema.ts against DB state, emits SQL)
2. Review the generated SQL diff in PR — destructive migrations (DROP COLUMN, RENAME, type change) need explicit approval
3. `drizzle-kit migrate` in a gated CI job
4. Deploy the app code only after migrations succeed

**Expand-contract for breaking changes:**
1. Add the new column/table (expand) — deploy; old code still works
2. Deploy code that writes to both (dual-write) — deploy; rollback-safe
3. Backfill data
4. Deploy code that reads from new only — deploy; removes the fallback
5. Drop the old column (contract) — separate PR after confirming no reads

Skipping expand-contract means a rollback leaves the DB in a shape the rolled-back code can't read.

## Rollback

```
kubectl rollout undo deployment/core-api
```

**Gotchas:**
- Rolling back app code when the migration already ran destructive changes = broken. That's why expand-contract exists.
- Feature flags beat rollbacks for most issues. If a bug is user-facing but not data-corrupting, flip the flag in config rather than redeploying.

## Observability

`backend.observability.metricsEnabled: true` exposes `/metrics` — wire Prometheus scrape:
```
scrape_configs:
  - job_name: core-api
    metrics_path: /metrics
    static_configs: [{ targets: ["core-api:3001"] }]
```

Tracing with `tracingEnabled: true` needs the OTEL SDK initialized in `server.ts` — not yet templated (Layer-5 candidate). Until then, add to the server entry:
```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) new NodeSDK({ /* … */ }).start();
```

## Common tasks

- **First deploy:** provision DB → set secrets → run migration job → push image → point traffic.
- **Zero-downtime deploy:** rolling update + readiness probe on `/ready` + surge count ≥ 1 replica.
- **Staging env:** duplicate the pipeline with `environment: staging`, separate `DATABASE_URL`, separate `CORS_ALLOWED_ORIGINS`.
- **Canary:** route 5% of traffic to `core-api:${sha}` via service-mesh header or Ingress weight; monitor error rate + p95 for 10 min; promote or rollback.

## Guidelines

- **Every deploy runs compliance first.** Mechanism: CI fails if `master.sh compliance` exits non-zero. Don't disable it; fix the drift.
- **Secrets never in env files.** Mount from the secret manager.
- **One image, many envs.** Config varies by env var; don't bake staging vs prod differences into the Dockerfile.
- **Pin every dependency.** Lockfiles in CI; image SHAs in registry; commit SHAs in the deploy.
- **Never push directly to prod.** Even for hotfixes, PR + CI + gated deploy.

## Hand-off

- CORS / rate-limit / logging tweaks → `configure-backend`
- Breaking migration planning → `configure-database`
- Perf targets to enforce in canary → `performance-budget`
- Security review of the deploy pipeline → `/security-review` (built-in)

## Output format

1. **Compliance + status** — confirm both green before proceeding
2. **Dockerfile changes** — if any
3. **CI changes** — pipeline steps added/modified
4. **Migration plan** — which SQL files, expand-contract stages
5. **Rollback plan** — one sentence: what command, what this restores
6. **Observability wiring** — what scrape/tracing target is now active
7. **Rule stack** — `.cursorrules → orchestration_policy.mdc → deploy-prod/SKILL.md → AGENT_GUIDE.md → SECURITY_BASELINE.md`

---

## Deployment artifacts: copy them, do not retype them

The engine does NOT generate deployment config — `./master.sh deploy` runs the
project's own scripts — so these are genuinely yours to own. They still should
not sit in this file: copy them and edit the copy.

```bash
cp -R skills/deploy-prod/templates/. .   # then edit for your host
```

| template | lands at |
|---|---|
| `templates/.github/workflows/deploy.yml` | `.github/workflows/deploy.yml` (125 lines) |
| `templates/apps/web/Dockerfile` | `apps/web/Dockerfile` (22 lines) |
| `templates/docker-compose.yml` | `docker-compose.yml` (47 lines) |
| `templates/infra/k8s/core-api.yaml` | `infra/k8s/core-api.yaml` (53 lines) |
| `templates/services/core-api/Dockerfile` | `services/core-api/Dockerfile` (26 lines) |
| `templates/services/core-api/src/otel.ts` | `services/core-api/src/otel.ts` (15 lines) |

**Do not `Read` them to reproduce them.** Copy, then read only the one you
must edit. Every value that varies by host (registry, domain, secrets) is an
env var or a clearly marked placeholder inside the file.
