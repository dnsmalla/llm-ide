// Prometheus text-format metrics.  Hand-rolled because:
//   1. The wire format is tiny (https://prometheus.io/docs/instrumenting/exposition_formats/).
//   2. We don't want to lock the deployment to a specific scraper SDK.
//
// Metrics we expose:
//   llmide_uptime_seconds (gauge)
//   llmide_http_requests_total{method, route, status} (counter)
//   llmide_http_request_duration_seconds_bucket{...} (histogram)
//   llmide_kb_records{kind} (gauge)  — pulled from kb stats
//   llmide_audit_events_total (counter)
//   llmide_rate_limit_rejections_total{profile} (counter)
//
// The histogram buckets are tuned for our workload: most KB writes are
// sub-100ms, LLM calls are 1–60s, dispatch is 1–10s.  Skewing toward
// higher values would hide hot-path latency regressions.

const HIST_BUCKETS_SEC = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

class Counter {
  constructor() { this.values = new Map(); }
  inc(labels = {}, n = 1) {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + n);
  }
  *iterate() {
    for (const [k, v] of this.values) yield { labels: parseLabelKey(k), value: v };
  }
}

class Gauge {
  constructor() { this.values = new Map(); }
  set(labels = {}, n = 0) { this.values.set(labelKey(labels), n); }
  *iterate() {
    for (const [k, v] of this.values) yield { labels: parseLabelKey(k), value: v };
  }
}

class Histogram {
  constructor(buckets = HIST_BUCKETS_SEC) {
    this.buckets = buckets;
    this.series = new Map();   // labelKey -> { counts: number[], sum: number, count: number }
  }
  observe(labels = {}, valueSec) {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += valueSec;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (valueSec <= this.buckets[i]) s.counts[i] += 1;
    }
  }
  *iterate() {
    for (const [k, s] of this.series) {
      yield { labels: parseLabelKey(k), counts: s.counts, sum: s.sum, count: s.count };
    }
  }
}

function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join('|');
}

function parseLabelKey(key) {
  if (!key) return {};
  const out = {};
  for (const seg of key.split('|')) {
    const idx = seg.indexOf('=');
    if (idx === -1) continue;
    out[seg.slice(0, idx)] = seg.slice(idx + 1);
  }
  return out;
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function fmtLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',') + '}';
}

// --- Public registry ----------------------------------------------------

const registry = {
  startedAt: Date.now(),
  httpRequests:    new Counter(),
  httpDuration:    new Histogram(),
  rateLimitDenies: new Counter(),
  auditEvents:     new Counter(),
  kbRecords:       new Gauge(),
};

export function recordHttpRequest({ method, route, status, durationMs }) {
  const labels = { method, route: normalizeRoute(route), status: String(status) };
  registry.httpRequests.inc(labels);
  registry.httpDuration.observe({ route: labels.route }, durationMs / 1000);
}

export function recordRateLimitDeny(profile) {
  registry.rateLimitDenies.inc({ profile });
}

export function setKbGauge(kind, value) {
  registry.kbRecords.set({ kind }, Number(value) || 0);
}

// Collapse high-cardinality URLs ('/kb/plan/abc-123') into a stable
// route label ('/kb/plan/:id').  Without this the metric series would
// explode per-id and break cardinality.
// Allowlist of route prefixes the server actually serves. Any path that
// doesn't start with one of these entries is collapsed to 'other' to
// prevent a client flooding unrecognised paths from creating unbounded
// Prometheus label cardinality (a DoS vector).
const KNOWN_ROUTE_PREFIXES = new Set([
  '/kb/', '/admin/', '/auth/', '/generate', '/chat', '/code-assist',
  '/plugins/', '/metrics', '/health', '/export/', '/live/',
]);

function isKnownRoute(url) {
  if (!url) return false;
  for (const prefix of KNOWN_ROUTE_PREFIXES) {
    if (url === prefix.replace(/\/$/, '') || url.startsWith(prefix)) return true;
  }
  return false;
}

function normalizeRoute(url) {
  if (typeof url !== 'string') return 'unknown';
  // Order matters — more specific patterns first so /kb/live/:id/stream
  // collapses before the generic /kb/live/:id catches it.
  const clean = url
    .replace(/\?.*$/, '')
    .replace(/\/kb\/live\/[^/]+\/stream$/, '/kb/live/:id/stream')
    .replace(/\/kb\/live\/[^/]+\/append$/, '/kb/live/:id/append')
    .replace(/\/kb\/live\/[^/]+\/finalize$/, '/kb/live/:id/finalize')
    .replace(/\/kb\/live\/[^/]+$/, '/kb/live/:id')
    .replace(/\/kb\/plan\/[^/]+/, '/kb/plan/:id')
    .replace(/\/kb\/plan-task\/[^/]+/, '/kb/plan-task/:id')
    .replace(/\/kb\/meeting\/[^/]+/, '/kb/meeting/:id')
    .replace(/\/kb\/entity\/[^/]+/, '/kb/entity/:id')
    .replace(/\/kb\/review\/get\/[^/]+/, '/kb/review/get/:id')
    .replace(/\/kb\/review\/approve\/[^/]+/, '/kb/review/approve/:id')
    .replace(/\/kb\/review\/reject\/[^/]+/, '/kb/review/reject/:id')
    .replace(/\/kb\/review\/delete\/[^/]+/, '/kb/review/delete/:id')
    .replace(/\/kb\/outcomes\/task\/[^/]+/, '/kb/outcomes/task/:id')
    .replace(/\/kb\/agent\/feedback\/by-task\/[^/]+/, '/kb/agent/feedback/by-task/:id')
    .replace(/\/kb\/agent\/runs\/[^/]+/, '/kb/agent/runs/:id');
  // Collapse any route not matching a known prefix to 'other' so clients
  // cannot inflate metric cardinality by sending arbitrary paths.
  return isKnownRoute(clean) ? clean : 'other';
}

export function renderPrometheus() {
  const lines = [];
  const uptimeSec = (Date.now() - registry.startedAt) / 1000;

  lines.push('# HELP llmide_uptime_seconds Server uptime in seconds.');
  lines.push('# TYPE llmide_uptime_seconds gauge');
  lines.push(`llmide_uptime_seconds ${uptimeSec.toFixed(3)}`);

  lines.push('# HELP llmide_http_requests_total Total HTTP requests.');
  lines.push('# TYPE llmide_http_requests_total counter');
  for (const { labels, value } of registry.httpRequests.iterate()) {
    lines.push(`llmide_http_requests_total${fmtLabels(labels)} ${value}`);
  }

  lines.push('# HELP llmide_http_request_duration_seconds HTTP request latency.');
  lines.push('# TYPE llmide_http_request_duration_seconds histogram');
  for (const { labels, counts, sum, count } of registry.httpDuration.iterate()) {
    for (let i = 0; i < HIST_BUCKETS_SEC.length; i += 1) {
      const labelsBucket = { ...labels, le: String(HIST_BUCKETS_SEC[i]) };
      lines.push(`llmide_http_request_duration_seconds_bucket${fmtLabels(labelsBucket)} ${counts[i]}`);
    }
    const labelsInf = { ...labels, le: '+Inf' };
    lines.push(`llmide_http_request_duration_seconds_bucket${fmtLabels(labelsInf)} ${count}`);
    lines.push(`llmide_http_request_duration_seconds_sum${fmtLabels(labels)} ${sum.toFixed(3)}`);
    lines.push(`llmide_http_request_duration_seconds_count${fmtLabels(labels)} ${count}`);
  }

  lines.push('# HELP llmide_rate_limit_rejections_total Requests rejected by rate limiter.');
  lines.push('# TYPE llmide_rate_limit_rejections_total counter');
  for (const { labels, value } of registry.rateLimitDenies.iterate()) {
    lines.push(`llmide_rate_limit_rejections_total${fmtLabels(labels)} ${value}`);
  }

  lines.push('# HELP llmide_audit_events_total Audit log rows written.');
  lines.push('# TYPE llmide_audit_events_total counter');
  for (const { value } of registry.auditEvents.iterate()) {
    lines.push(`llmide_audit_events_total ${value}`);
  }

  lines.push('# HELP llmide_kb_records Knowledge base record counts by kind.');
  lines.push('# TYPE llmide_kb_records gauge');
  for (const { labels, value } of registry.kbRecords.iterate()) {
    lines.push(`llmide_kb_records${fmtLabels(labels)} ${value}`);
  }

  return lines.join('\n') + '\n';
}

export function _resetForTests() {
  registry.startedAt = Date.now();
  registry.httpRequests = new Counter();
  registry.httpDuration = new Histogram();
  registry.rateLimitDenies = new Counter();
  registry.auditEvents = new Counter();
  registry.kbRecords = new Gauge();
}
