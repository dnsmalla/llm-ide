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

## Ready-to-paste: complete dev stack (`docker-compose.yml` at repo root)

```yaml
services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: devpw
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 10
    volumes:
      - dbdata:/var/lib/postgresql/data

  core-api:
    build:
      context: .
      dockerfile: services/core-api/Dockerfile
    depends_on:
      db: { condition: service_healthy }
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgres://app:devpw@db:5432/app
      CORS_ALLOWED_ORIGINS: http://localhost:3000
    ports:
      - "3001:3001"
    restart: unless-stopped

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    depends_on:
      - core-api
    environment:
      NEXT_PUBLIC_API_URL: http://core-api:3001
    ports:
      - "3000:3000"
    restart: unless-stopped

volumes:
  dbdata:
```

Run locally: `docker compose up --build`. Iterate on code with hot reload by swapping the service's `build:` for `volumes: [./services/core-api/src:/app/src:ro]` + `command: npm run dev`.

## Ready-to-paste: server Dockerfile (`services/core-api/Dockerfile`)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY services/core-api/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY services/core-api/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY services/core-api ./
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
USER app
COPY --from=builder --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/docs ./docs
ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3001/ready || exit 1
CMD ["node", "dist/server.js"]
```

## Ready-to-paste: web Dockerfile (`apps/web/Dockerfile` — Next.js standalone)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY apps/web/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY apps/web ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
USER app
ENV NODE_ENV=production
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

(Next.js needs `output: "standalone"` in `next.config.js`.)

## Ready-to-paste: GitHub Actions deploy pipeline (`.github/workflows/deploy.yml`)

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: app, POSTGRES_PASSWORD: devpw, POSTGRES_DB: app }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U app" --health-interval 5s
          --health-timeout 3s --health-retries 10
    env:
      DATABASE_URL: postgres://app:devpw@localhost:5432/app
      NEXT_PUBLIC_API_URL: http://localhost:3001
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }

      - name: Install auto-system core
        run: cd .system-controller/submodules/.auto_system_engine/core && npm ci && npm run build

      - name: Compliance
        run: bash .system-controller/submodules/.auto_system_engine/master.sh compliance

      - name: Install backend + web
        run: |
          (cd services/core-api && npm ci)
          (cd apps/web          && npm ci)

      - name: Migrate (test DB)
        run: |
          psql "$DATABASE_URL" -f services/core-api/db/migrations/000_extensions.sql || true
          (cd services/core-api && npx drizzle-kit migrate)

      - name: Test
        run: |
          (cd services/core-api && npm test)
          (cd apps/web          && npm test)

      - name: Build
        run: |
          (cd services/core-api && npm run build)
          (cd apps/web          && npm run build)

  build-images:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v5
        with:
          context: .
          file: services/core-api/Dockerfile
          tags: ghcr.io/${{ github.repository }}/core-api:${{ github.sha }}
          push: true
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - uses: docker/build-push-action@v5
        with:
          context: .
          file: apps/web/Dockerfile
          tags: ghcr.io/${{ github.repository }}/web:${{ github.sha }}
          push: true
          cache-from: type=gha
          cache-to: type=gha,mode=max

  migrate:
    needs: build-images
    runs-on: ubuntu-latest
    environment: prod-migrations         # requires manual approval
    timeout-minutes: 10
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd services/core-api && npm ci
      - name: Apply extensions (idempotent)
        run: psql "$DATABASE_URL" -f services/core-api/db/migrations/000_extensions.sql || true
      - name: Migrate
        run: cd services/core-api && npx drizzle-kit migrate

  deploy:
    needs: migrate
    runs-on: ubuntu-latest
    environment: prod                    # requires manual approval
    timeout-minutes: 10
    steps:
      # Replace the following with your platform's rollout command.
      # Examples (keep just the one you use):
      #
      #   kubectl set image deployment/core-api core-api=ghcr.io/${{ github.repository }}/core-api:${{ github.sha }}
      #   kubectl rollout status deployment/core-api --timeout=120s
      #
      # OR Fly.io:
      #   flyctl deploy -a core-api --image ghcr.io/${{ github.repository }}/core-api:${{ github.sha }}
      #
      # OR Render / Railway / ECS — set image tag via their CLI.
      - name: Deploy
        run: echo "wire your deploy command here"
```

## Ready-to-paste: Kubernetes deployment (`infra/k8s/core-api.yaml`)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: core-api
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  selector: { matchLabels: { app: core-api } }
  template:
    metadata: { labels: { app: core-api } }
    spec:
      containers:
        - name: core-api
          image: ghcr.io/ORG/REPO/core-api:latest
          ports: [{ containerPort: 3001 }]
          env:
            - { name: NODE_ENV, value: production }
            - { name: PORT, value: "3001" }
            - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: core-api-env, key: DATABASE_URL } } }
            - { name: CORS_ALLOWED_ORIGINS, valueFrom: { secretKeyRef: { name: core-api-env, key: CORS_ALLOWED_ORIGINS } } }
          resources:
            requests: { cpu: "100m", memory: "256Mi" }
            limits:   { cpu: "1",    memory: "512Mi" }
          readinessProbe:
            httpGet: { path: /ready, port: 3001 }
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 15
            periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata: { name: core-api }
spec:
  type: ClusterIP
  selector: { app: core-api }
  ports: [{ port: 3001, targetPort: 3001 }]
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: core-api
  labels: { release: prometheus }
spec:
  selector: { matchLabels: { app: core-api } }
  endpoints:
    - port: "3001"
      path: /metrics
      interval: 15s
```

## Ready-to-paste: OTEL tracing init (wire into `services/core-api/src/server.ts`)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName: "core-api",
  });
  sdk.start();
  process.on("SIGTERM", () => sdk.shutdown().catch(() => {}));
}
```
