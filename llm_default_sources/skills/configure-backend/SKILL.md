---
name: configure-backend
description: >-
  Configure backend: server port, API prefix, CORS, rate limits, logging,
  observability, scrypt cost. Trigger on: "allow origin X", "raise rate limit",
  "tighten limit on /v1/auth", "enable tracing", "change log level", "increase
  scrypt N", "add OTLP endpoint", or edits to the backend: block in system.yaml.
  Do NOT hand-edit services/core-api/src/config/env.ts or
  src/middleware/rateLimit.ts.
---

# Configure backend

`system.yaml → backend:` is the single source of truth for server-wide policy: port, API prefix, CORS, rate limits, logging, observability, password hashing cost. Three files under `services/core-api/src/` are generated from it and will be clobbered on regeneration:

| File | Driven by |
|------|-----------|
| `src/config/env.ts` | `backend.port`, `backend.apiPrefix`, `backend.cors`, `backend.logging`, `database.urlEnvVar` |
| `src/middleware/rateLimit.ts` | `backend.rateLimits.default` + `byRoute[]` |
| `src/routes/auth.ts` | `backend.passwordHash.*` (scrypt cost) + `auth.*` |

## When to use

- "Open CORS to our staging origin"
- "Cut the default rate limit in half"
- "Lock /v1/auth to 10 req/min"
- "Turn on metrics" / "enable OTEL tracing"
- "Redact Stripe-Signature from logs"
- "Bump scrypt N to 32768 for prod"
- "Server is running on wrong port"

## The config surface

```yaml
backend:
  port: 3001
  apiPrefix: "/v1"                # mirrors auth.apiPrefix's parent; routes resolve as {apiPrefix}{auth.apiPrefix}/…
  cors:
    allowedOrigins: []            # static list, e.g. ["https://app.example.com"]
    allowedOriginsEnv: "CORS_ALLOWED_ORIGINS"  # optional: comma-separated at runtime overrides static list
    credentials: true
    maxAge: 86400
  rateLimits:
    default: { windowMs: 60000, max: 120 }
    byRoute:
      - { path: "/v1/auth", windowMs: 60000, max: 20 }   # prefix match; lower caps for auth
  logging:
    level: "info"                 # debug | info | warn | error
    redactHeaders: ["authorization", "cookie", "x-api-key"]
  observability:
    metricsEnabled: true
    metricsPath: "/metrics"
    tracingEnabled: false
    tracingEnvVar: "OTEL_EXPORTER_OTLP_ENDPOINT"
  passwordHash:
    algorithm: "scrypt"           # scrypt | bcrypt | argon2id (only scrypt is wired today)
    scryptN: 16384                # ≥8192; bump for prod (memory cost)
    scryptR: 8
    scryptP: 1
    scryptKeyLen: 64
    scryptSaltBytes: 16
```

## Steps

1. **Edit `system.yaml`** — change `backend.*`.
2. **Regenerate** — `./master.sh generate:templates` (rewrites env.ts, rateLimit.ts, routes/auth.ts).
3. **Restart the server** — env.ts changes take effect on next boot.
4. **Verify compliance** — `./master.sh compliance` will still pass unless you've broken a Layer-4 invariant (e.g. dropped a required openapi route).

## Common tasks

- **Add a prod origin:** append to `cors.allowedOrigins`. For multi-env, set `cors.allowedOriginsEnv: "CORS_ORIGINS"` and pass the value at runtime (`CORS_ORIGINS="https://a.com,https://b.com"`).
- **Lower auth rate limit:** append `{ path: "/v1/auth/login", windowMs: 60000, max: 5 }` to `rateLimits.byRoute`. The matcher is prefix-based — more specific paths should come first.
- **Enable tracing:** set `observability.tracingEnabled: true`. The generated env.ts exposes the OTEL endpoint env var; you still need to wire an OTEL SDK in the server entry (not yet templated).
- **Harden scrypt for prod:** raise `scryptN` to 32768 or 65536. Memory cost scales with N — measure before shipping.
- **Raise log level:** `logging.level: "warn"` reduces noise; `redactHeaders` lets you add auth-custom headers (e.g. `x-session-token`).

## Guidelines

- **Keep `backend.apiPrefix` aligned with `auth.apiPrefix`.** If you change one, update `docs/openapi.yaml` and any reverse-proxy configs in the same PR.
- **Rate-limit buckets are in-memory** in the default template. For multi-instance deployments, swap to Redis-backed buckets *after* declaring the policy here — the policy should still be config-driven.
- **Don't bypass CORS in code.** If a request is failing CORS, fix the config, not the middleware.
- **Scrypt knobs affect every login/register.** A 4× memory bump roughly doubles login latency; benchmark on target hardware before pushing to prod.

## Output format

1. **Diff of `system.yaml`** — only the `backend.*` fields that changed
2. **Regeneration log** — `./master.sh generate:templates`
3. **Impact note** — which files are going to change at next boot (env.ts, rateLimit.ts, routes/auth.ts) and whether the server needs a restart
4. **Rule stack** — `.cursorrules → orchestration_policy.mdc → configure-backend/SKILL.md → AGENT_GUIDE.md`

---

## Ready-to-paste: production `backend:` block

```yaml
backend:
  port: 3001
  apiPrefix: "/v1"
  cors:
    allowedOrigins: []                                # static list; typically empty in prod
    allowedOriginsEnv: "CORS_ALLOWED_ORIGINS"         # runtime list, e.g. "https://app.x.com,https://admin.x.com"
    credentials: true
    maxAge: 86400
  rateLimits:
    default:
      windowMs: 60000                                 # 1m
      max: 300                                        # generous for authenticated users
    byRoute:                                          # prefix match; more specific entries first
      - { path: "/v1/auth/login",    windowMs: 60000, max: 5 }
      - { path: "/v1/auth/register", windowMs: 60000, max: 3 }
      - { path: "/v1/auth/forgot-password", windowMs: 3600000, max: 3 }   # 3/hour — avoid enumeration floods
      - { path: "/v1/auth",          windowMs: 60000, max: 20 }
  logging:
    level: "info"
    redactHeaders:
      - "authorization"
      - "cookie"
      - "x-api-key"
      - "stripe-signature"
      - "x-webhook-secret"
  observability:
    metricsEnabled: true
    metricsPath: "/metrics"
    tracingEnabled: true
    tracingEnvVar: "OTEL_EXPORTER_OTLP_ENDPOINT"
  passwordHash:
    algorithm: "scrypt"
    scryptN: 32768                                    # prod-grade memory cost (~150 ms/login)
    scryptR: 8
    scryptP: 1
    scryptKeyLen: 64
    scryptSaltBytes: 16
```

## Ready-to-paste: CORS + request-id + access-log middleware

`services/core-api/src/middleware/cors.ts` (wire into `server.ts` before all other routes):

```ts
import type { IncomingMessage, ServerResponse } from "http";
import { loadEnv } from "../config/env";

const env = loadEnv();

export function cors(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const origin = req.headers.origin ?? "";
  const allowed = env.corsAllowedOrigins.length === 0 || env.corsAllowedOrigins.includes(origin);
  if (allowed && origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  next();
}
```

`services/core-api/src/middleware/requestId.ts`:

```ts
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

export function requestId(req: IncomingMessage & { id?: string }, res: ServerResponse, next: () => void) {
  const id = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
```

`services/core-api/src/middleware/accessLog.ts` (honours `backend.logging.redactHeaders`):

```ts
import type { IncomingMessage, ServerResponse } from "http";

const REDACT = new Set({{BACKEND_REDACT_HEADERS_JSON}});  // not yet templated — paste from config

export function accessLog(req: IncomingMessage & { id?: string }, res: ServerResponse, next: () => void) {
  const start = Date.now();
  res.on("finish", () => {
    const durMs = Date.now() - start;
    const line = {
      ts: new Date().toISOString(),
      level: "info",
      id: req.id,
      m: req.method,
      p: new URL(req.url ?? "/", "http://x").pathname,
      s: res.statusCode,
      d: durMs,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  });
  next();
}
```

## Ready-to-paste: Prometheus histogram middleware (exposes `/metrics`)

`services/core-api/src/middleware/metrics.ts`:

```ts
import client from "prom-client";
import type { IncomingMessage, ServerResponse } from "http";

client.collectDefaultMetrics();                                           // process + event-loop metrics

export const httpDuration = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP response time in ms",
  labelNames: ["method", "route", "status"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export function metricsMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const end = httpDuration.startTimer({ method: req.method ?? "GET", route: pathname });
  res.on("finish", () => end({ status: String(res.statusCode) }));
  next();
}

export async function handleMetrics(_: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
}
```

Wire in `server.ts`:
```ts
import { metricsMiddleware, handleMetrics } from "./middleware/metrics";
// chain: cors → requestId → accessLog → metricsMiddleware → rateLimit → routes
// expose GET /metrics → handleMetrics (outside rate limit)
```
