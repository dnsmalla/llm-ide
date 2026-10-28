// Rollup property test (plan R1): for any sequence of inserts and rollups,
// for every (user, day, source, provider, model) the raw sum plus the rollup
// sum equals the total of everything inserted. Seeded, so a failure replays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const agent = await import('../kb/agent-db.mjs');
const store = await import('../kb/agent-store.mjs');

// mulberry32: a small seeded PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS_USERS = ['u1', 'u2', 'u3'];
const SOURCES = ['chat', 'loop', 'meeting'];
const PROVIDERS = ['anthropic', null];
const MODELS = ['m1', 'm2', null];
const STATUSES = ['ok', 'ok', 'error', 'cancelled', 'aborted', 'running'];
const DAY_MS = 86400000;

function run(seed, rows) {
  const random = rng(seed);
  const pick = (xs) => xs[Math.floor(random() * xs.length)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-prop-${seed}-`));
  const file = path.join(dir, 'agent.db');
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  const db = agent.openAgentDb({ file });
  assert.ok(db);
  const now = new Date(2026, 9, 28, 12, 0, 0);
  const addTo = (m, k, v) => { m.set(k, (m.get(k) ?? 0) + v); };
  const keyOf = (u, d, s, p, m) => `${u}|${d}|${s}|${p ?? ''}|${m ?? ''}`;
  const insert = db.prepare(`INSERT INTO agent_runs (run_id, user_id, day, source, provider, model, status, started_at,
      duration_ms, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', ?, ?, ?, ?, ?, ?)`);
  let id = 0;
  const totals = new Map(); // key#field -> total of everything inserted
  for (let step = 0; step < rows; step += 1) {
    const u = pick(KEYS_USERS);
    const days = Math.floor(random() * 120); // up to ~4 months back
    const d = agent.localDayBefore(now, days);
    const s = pick(SOURCES);
    const p = pick(PROVIDERS);
    const m = pick(MODELS);
    const st = pick(STATUSES);
    const v = {
      runs: 1,
      duration_ms: Math.floor(random() * 1000),
      tool_calls: Math.floor(random() * 5),
      input_tokens: Math.floor(random() * 500),
      output_tokens: Math.floor(random() * 200),
      cache_read_tokens: Math.floor(random() * 50),
      cache_creation_tokens: Math.floor(random() * 30),
    };
    insert.run(`r${id += 1}`, u, d, s, p, m, st, v.duration_ms, v.tool_calls, v.input_tokens,
      v.output_tokens, v.cache_read_tokens, v.cache_creation_tokens);
    for (const f of Object.keys(v)) addTo(totals, `${keyOf(u, d, s, p, m)}#${f}`, v[f]);
    // Roll up at random moments with random retention and a random clock.
    if (random() < 0.08) {
      const later = new Date(now.getTime() + Math.floor(random() * 90) * DAY_MS);
      for (const user of KEYS_USERS) {
        store.rollupOlderThan(user, 7 + Math.floor(random() * 60), { db, now: later });
      }
    }
  }
  // Final check, after one more rollup pass at the real clock.
  for (const user of KEYS_USERS) store.rollupOlderThan(user, 30, { db, now });
  for (const user of KEYS_USERS) store.rollupOlderThan(user, 30, { db, now }); // idempotent

  // Raw + daily, per key, against what was inserted.
  const got = new Map();
  const rawRows = db.prepare(`SELECT user_id, day, source, COALESCE(provider,'') AS p, COALESCE(model,'') AS m,
      COUNT(*) AS runs, SUM(duration_ms) AS duration_ms, SUM(tool_calls) AS tool_calls,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens
    FROM agent_runs GROUP BY user_id, day, source, p, m`).all();
  const dailyRows = db.prepare('SELECT * FROM agent_daily').all();
  for (const r of [...rawRows, ...dailyRows]) {
    const k = keyOf(r.user_id, r.day, r.source, r.provider ?? r.p, r.model ?? r.m);
    for (const f of ['runs', 'duration_ms', 'tool_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      addTo(got, `${k}#${f}`, Number(r[f]) || 0);
    }
  }
  for (const [k, v] of totals) assert.equal(got.get(k) ?? 0, v, `mismatch at ${k}`);
  for (const [k, v] of got) assert.equal(totals.get(k) ?? 0, v, `extra at ${k}`);
  agent.closeAgentDb();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('property: raw + rollup sums equal the inserted totals (10k rows, seed 1)', () => {
  run(1, 10000);
});

test('property: the same holds for a second seed with frequent rollups (seed 2)', () => {
  run(2, 10000);
});
