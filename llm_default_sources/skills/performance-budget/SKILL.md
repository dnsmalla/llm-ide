---
name: performance-budget
description: Set and enforce production performance budgets — LCP/CLS/INP for web, cold-start and memory for native, API p50/p95/p99, DB query timing, bundle size. Use when the user says "perf budget", "our site is slow", "p95 is too high", "reduce bundle", "LCP regressing", "optimize query", or asks to gate CI on perf thresholds. Ties directly to `backend.observability.metricsEnabled` and `advisor.quality.performance`.
---

# Performance budget

Production performance is measured, gated, and regression-tested — not intuited. This skill turns the `advisor.quality.performance` level into concrete numbers per layer and ties enforcement to the observability config.

## When to use

- Setting initial perf budgets for a new project
- User-visible slowness complaints ("login is slow", "list never loads")
- CI doesn't gate on perf → a release slipped a regression
- Before a major launch — harden budgets, add synthetic monitoring
- Measuring whether a new feature fits inside existing budgets

## The budget table (keyed to `advisor.quality.performance`)

| Metric | `standard` | `pro` (default) | `extreme` |
|--------|-----------|-----------------|-----------|
| **Web — LCP** (p75) | ≤ 2.5s | ≤ 2.0s | ≤ 1.2s |
| **Web — CLS** (p75) | ≤ 0.1 | ≤ 0.1 | ≤ 0.05 |
| **Web — INP** (p75) | ≤ 200ms | ≤ 150ms | ≤ 100ms |
| **Web — JS bundle (initial)** | ≤ 300 KB gz | ≤ 180 KB gz | ≤ 100 KB gz |
| **API — p50 response** | ≤ 150ms | ≤ 80ms | ≤ 30ms |
| **API — p95 response** | ≤ 500ms | ≤ 250ms | ≤ 100ms |
| **API — p99 response** | ≤ 1500ms | ≤ 800ms | ≤ 300ms |
| **DB — p95 query** | ≤ 100ms | ≤ 40ms | ≤ 15ms |
| **iOS — cold launch** | ≤ 3.0s | ≤ 2.0s | ≤ 1.2s |
| **iOS — memory (peak)** | ≤ 250 MB | ≤ 180 MB | ≤ 120 MB |
| **Android — cold launch** | ≤ 3.5s | ≤ 2.5s | ≤ 1.5s |

These are targets at p75/p95 — not averages. Averages hide long tails.

## Measurement stack (wired to existing config)

### Web

- **Real-user metrics (RUM):** ship `web-vitals` (INP/LCP/CLS/TTFB) to a beacon endpoint. Target: p75 across last 7 days per route.
- **Lab checks in CI:** Lighthouse CI against key pages on every PR; fail if LCP regresses > 10%.
- **Bundle analysis:** `next build` output + `@next/bundle-analyzer` in CI; fail if initial JS > budget.

### API

- **`/metrics` scraping** (already generated when `backend.observability.metricsEnabled: true`) — add histogram per route:
  ```ts
  import { Histogram } from "prom-client";
  const h = new Histogram({ name: "http_request_duration_ms", labelNames: ["method", "route", "status"], buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] });
  // in middleware: const end = h.startTimer({ method, route }); … end({ status });
  ```
- **Tracing** — with `observability.tracingEnabled: true`, spans on DB queries expose per-query timing. Review the slowest 10 traces daily.
- **Synthetic** — Grafana k6 or Artillery running the critical auth flow every 5 min.

### DB

- **Postgres `pg_stat_statements`** (requires extension — add `"pg_stat_statements"` to `database.extensions` then `CREATE EXTENSION` at deploy).
- Query rows ordered by `mean_exec_time DESC` every release week; index or rewrite anything > p95 budget.
- Index every FK (declared or not); index every column used in `WHERE` or `ORDER BY`.

### Mobile

- **iOS:** Instruments (Time Profiler, Allocations); MetricKit in TestFlight for real-device data.
- **Android:** Macrobenchmark + Perfetto; Firebase Performance for RUM.

## Steps

1. **Pick budgets** — map `advisor.quality.performance` to the table above. Override any row with a project-specific target (e.g. a payment flow with p99 ≤ 200ms).
2. **Wire measurement** — turn on `observability.metricsEnabled`, add the histogram middleware, add `pg_stat_statements`.
3. **Gate in CI:**
   - Lighthouse CI assertion for LCP/CLS
   - Bundle size check against JSON budget file
   - API smoke: spin the server + drizzle-migrate into a scratch DB; run k6 smoke; assert p95 against budget
4. **Alert in prod** — Grafana alerts on the `/metrics` histograms; page on p95 breach sustained for 5 min, not single spikes.
5. **Weekly review** — top-10 slowest routes + top-10 slowest queries; file tickets for anything above budget.

## Common tasks

- **Slow endpoint:** check traces first, then EXPLAIN the top query. 9/10 of the time it's a missing index on a FK (`configure-database` to add).
- **Bundle bloat:** run `analyze`; the usual suspects are moment.js (use date-fns or native Intl), a full icon pack (tree-shake), or a client-only lib pulled into SSR.
- **Cold-start regression (iOS):** link-time → profile main thread between `didFinishLaunching` and first render; almost always a synchronous storage read.
- **DB `EXPLAIN` shows Seq Scan on a FK:** add index, re-run, confirm Index Scan.
- **p95 spikes without p50 moving:** tail latency — contention on a single hot row, or garbage collection. Trace first, don't optimize blindly.

## Guidelines

- **Budgets are thresholds, not goals.** Being under budget is OK; being over is a bug.
- **Measure in prod-shaped conditions.** A local dev machine with a warm cache hides real-world issues. Run perf tests against a prod-like DB with prod-like data volume.
- **Before optimizing, profile.** Micro-optimizations without data waste days; the real win is usually one query, one image, or one blocking script.
- **Cache the right thing.** Per-user caches beat global caches when payloads differ. Cache at the edge (CDN) for public content, not the API.
- **SLOs ≥ budgets.** The budget is the engineering target; the SLO is the customer promise. Keep SLOs looser than budgets so there's headroom.

## Hand-off

- Query-specific optimization → `configure-database` (add index, rewrite entity)
- Middleware-level changes (caching, compression) → `configure-backend`
- Observability wiring the first time → `deploy-prod`

## Output format

1. **Budget table** — derived from `advisor.quality.performance`, with any project-specific overrides called out
2. **Current state** — numbers from `/metrics`, Lighthouse, or traces; one line per metric
3. **Gaps** — which metrics are over budget and by how much
4. **Action items** — prioritized by impact; which metric each addresses
5. **CI gates** — which thresholds are now enforced on every PR
6. **Rule stack** — `.cursorrules → orchestration_policy.mdc → performance-budget/SKILL.md → (configure-database | configure-backend) → AGENT_GUIDE.md`

---

## Ready-to-paste: web-vitals RUM beacon

`apps/web/lib/vitals.ts`:

```ts
import { onCLS, onINP, onLCP, onTTFB } from "web-vitals";

type Metric = { name: string; value: number; id: string; rating: string };

function send(metric: Metric) {
  // Use sendBeacon so the data still goes out after page unload.
  const body = JSON.stringify({
    ...metric,
    href: location.href,
    ua: navigator.userAgent,
    ts: Date.now(),
  });
  const url = `${process.env.NEXT_PUBLIC_API_URL ?? ""}/v1/beacon/vitals`;
  if (navigator.sendBeacon) navigator.sendBeacon(url, body);
  else fetch(url, { body, method: "POST", keepalive: true, headers: { "Content-Type": "application/json" } });
}

export function initVitals() {
  onLCP(send);
  onINP(send);
  onCLS(send);
  onTTFB(send);
}
```

Wire in `apps/web/app/layout.tsx`:

```tsx
"use client";
import { useEffect } from "react";
import { initVitals } from "../lib/vitals";

useEffect(() => { initVitals(); }, []);
```

Server endpoint: add to `services/core-api/src/routes/beacon.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "http";
import { vitalsHistogram } from "../middleware/metrics";

export async function handleVitals(req: IncomingMessage & { body?: any }, res: ServerResponse) {
  const m = req.body ?? {};
  if (m?.name && typeof m.value === "number") {
    vitalsHistogram.observe({ metric: m.name, rating: m.rating ?? "unknown" }, m.value);
  }
  res.statusCode = 204; res.end();
}
```

## Ready-to-paste: API histogram + vitals histogram (middleware/metrics.ts)

```ts
import client from "prom-client";

client.collectDefaultMetrics();

export const httpDuration = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP response time in ms",
  labelNames: ["method", "route", "status"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

export const vitalsHistogram = new client.Histogram({
  name: "web_vitals",
  help: "Real-user web vitals (LCP, INP, CLS, TTFB)",
  labelNames: ["metric", "rating"] as const,
  buckets: [50, 100, 200, 400, 800, 1500, 2500, 4000, 8000],
});

export async function handleMetrics(_req: any, res: any) {
  res.setHeader("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
}
```

## Ready-to-paste: Lighthouse CI assertion (`.lighthouserc.json`)

```json
{
  "ci": {
    "collect": {
      "numberOfRuns": 3,
      "url": ["http://localhost:3000", "http://localhost:3000/login", "http://localhost:3000/feed"]
    },
    "assert": {
      "assertions": {
        "categories:performance":  ["error", { "minScore": 0.90 }],
        "largest-contentful-paint": ["error", { "maxNumericValue": 2000 }],
        "cumulative-layout-shift":  ["error", { "maxNumericValue": 0.10 }],
        "total-blocking-time":      ["error", { "maxNumericValue": 200 }],
        "resource-summary:script:size": ["error", { "maxNumericValue": 184320 }]
      }
    },
    "upload": { "target": "temporary-public-storage" }
  }
}
```

CI step:
```yaml
      - name: Lighthouse CI
        run: |
          npm i -D @lhci/cli
          (cd apps/web && npm run build && npm start &) && sleep 8
          npx lhci autorun
```

## Ready-to-paste: `pg_stat_statements` setup + top-10 query

`extensions: ["pg_stat_statements"]` in `database:` then add to `postgresql.conf`:

```
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = all
```

Enable (one-time):
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Weekly review query (run in prod `psql`):

```sql
SELECT
  substr(query, 1, 120) AS query,
  calls,
  round(total_exec_time::numeric, 2) AS total_ms,
  round(mean_exec_time::numeric, 2)  AS mean_ms,
  round(stddev_exec_time::numeric, 2) AS stddev_ms,
  rows
FROM pg_stat_statements
WHERE query NOT ILIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

Any row above your `DB p95` budget gets an index review (`EXPLAIN (ANALYZE, BUFFERS) <query>`) or a rewrite.

## Ready-to-paste: Prometheus alert rule (when breach sustained)

`infra/monitoring/rules.yaml`:

```yaml
groups:
  - name: core-api.rules
    rules:
      - alert: ApiP95Breach
        expr: |
          histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket[5m])) by (le, route)) > 250
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "p95 > 250ms for {{ $labels.route }}"
          runbook: "https://docs.example.com/runbooks/api-p95"
```

## Ready-to-paste: k6 smoke test (`perf/smoke.js`)

```js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 10,
  duration: "30s",
  thresholds: {
    http_req_duration: ["p(95)<250"],   // fails job if exceeded
    http_req_failed:   ["rate<0.01"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3001";

export default function () {
  const login = http.post(`${BASE}/v1/auth/login`, JSON.stringify({
    email: "smoke@example.com",
    password: "SmokeTest123!",
  }), { headers: { "Content-Type": "application/json" } });
  check(login, { "login 200": r => r.status === 200 });

  const token = login.json("data.accessToken");
  const posts = http.get(`${BASE}/v1/posts`, { headers: { Authorization: `Bearer ${token}` } });
  check(posts, { "posts 200": r => r.status === 200 });

  sleep(1);
}
```

Run: `k6 run perf/smoke.js`. Wire to CI as a canary after deploy.
