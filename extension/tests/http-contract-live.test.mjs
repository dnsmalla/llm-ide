// Live HTTP contract: replays schema/http fixtures against a real server and
// validates the LIVE response against the endpoint's declared schema for that
// status. The static gate (scripts/conformance-http.mjs) checks the fixtures;
// this test checks that the server still answers the way the schema says, so a
// server change that breaks the contract fails `npm test`.
//
// What runs: extension/server.mjs on a free loopback port, a temp DB, the
// stub Claude CLI (tests/fixtures/stub-claude-cli.mjs, no model call), and no
// network beyond 127.0.0.1. The server is killed in `after`, even on failure.
//
// Users: the server rate-limits per user (LLM and write buckets) and per IP
// (sign-up allows 3 a minute). So each replayed fixture gets its own user,
// seeded into the temp DB before the server starts, with a token minted by the
// server's own signAccessToken. Nothing is registered over HTTP except the
// register fixtures themselves.
//
// Coverage: the share of (method, path, status) pairs that have a fixture and
// were replayed live with a passing response. Asserted at >= 60 %. The last
// test prints the skip table with reasons, and the known drifts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, loadJson, listJson, makeSchemaWalker, validateNode } from '../../scripts/lib/conformance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SCHEMA_DIR = join(ROOT, 'schema/http');
const FIXTURE_DIR = join(SCHEMA_DIR, 'fixtures');
const SERVER = join(ROOT, 'extension/server.mjs');
const STUB_CLI = join(HERE, 'fixtures/stub-claude-cli.mjs');
const COVERAGE_TARGET = 0.6;
const BOOT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PASSWORD = 'example-password';

// ---------------------------------------------------------------- schemas and fixtures

const failLoad = (msg) => { throw new Error(msg); };
const common = loadJson(join(SCHEMA_DIR, '_common.schema.json'), '_common.schema.json', failLoad);
const endpoints = new Map(); // "<METHOD> <path>" -> { spec, walker }
for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json') && !f.startsWith('_')).sort()) {
  const doc = readJson(join(SCHEMA_DIR, file));
  const walker = makeSchemaWalker(doc, { externals: { _common: common } });
  for (const [key, spec] of Object.entries(doc.endpoints ?? {})) endpoints.set(key, { spec, walker });
}

const fixtures = [];
for (const group of readdirSync(FIXTURE_DIR).sort()) {
  for (const name of listJson(join(FIXTURE_DIR, group))) {
    fixtures.push({ ...readJson(join(FIXTURE_DIR, group, name)), file: `${group}/${name}` });
  }
}
// Register first: the login fixture logs in as the user the register fixture creates.
fixtures.sort((a, b) => (a.endpoint === 'POST /auth/register' ? 0 : 1) - (b.endpoint === 'POST /auth/register' ? 0 : 1));

const pairOf = (ep, status) => `${ep} ${status}`;
const withFixturePairs = new Set(fixtures.map((fx) => pairOf(fx.endpoint, fx.status)));
const declaredPairs = new Set();
for (const [key, { spec }] of endpoints) for (const s of Object.keys(spec.responses ?? {})) declaredPairs.add(pairOf(key, s));

// ---------------------------------------------------------------- skip table

// Only 2xx fixtures are skipped by most rules. Error fixtures (400, 401, 404)
// fail before any external or model call, so they are replayed even on
// endpoints whose success path is skipped.
const SKIP_RULES = [
  {
    why: 'rate limit (429): needs a bucket exhausted by earlier calls',
    when: (fx) => fx.status === 429,
  },
  {
    why: 'upstream failure (5xx): needs a failing dependency injected',
    when: (fx) => fx.status >= 500,
  },
  {
    why: 'streaming or live engine: agent v2 SSE, agent SDK, Loop run, live stream, System view stream',
    when: (fx) => fx.status < 300 && /^(POST \/agent\/v2|POST \/agent-sdk|POST \/kb\/loop\/agent-run|GET \/kb\/live\/:id\/stream|GET \/kb\/os\/stream|POST \/kb\/agent\/(ask|dispatch|stop|feedback))/.test(fx.endpoint),
  },
  {
    why: 'external service: OAuth provider, email/Slack/Box/MCP/git host, plugin marketplace',
    when: (fx) => fx.status < 300 && /\/(google|slack|box|email|mcp-connector|connect-git|connect-github-issues|connect-qa|connect-tickets-json|ingest-scip|ingest-code-graph|install-skills|notify)\b|\/marketplace|\/updates|\/(import|refresh|update)$|\/auth\/me\/(connectors|llm-sources|mcp-plugins)\/(add|update|resync)|\/auth\/me\/plugins\/(install|reload)|\/auth\/me\/codex-plugins|\/auth\/me\/claude-plugins|\/kb\/ingest$/.test(fx.endpoint),
  },
  {
    why: 'needs a row seeded through another route (a :id or body id that must exist)',
    when: (fx) => fx.status < 300 && (/:id|:name/.test(fx.endpoint) || /^(PUT \/kb\/agent\/personas\/active|POST \/kb\/code-sync|POST \/kb\/plan\/save|POST \/kb\/review\/|POST \/kb\/summarize|POST \/kb\/generate-code|POST \/kb\/generate-plan|POST \/kb\/analyze-risks|POST \/kb\/conflict-questions|POST \/kb\/dispatch|POST \/kb\/providers\/verify)/.test(fx.endpoint)),
  },
  {
    why: 'handler parses structured JSON from the model; the canned stub replies in plain text',
    when: (fx) => fx.status === 200 && (fx.endpoint === 'POST /extract-entities' || fx.endpoint === 'POST /generate-docx'),
  },
  {
    why: 'feature-gated 404: needs LLMIDE_FEATURES with the owning feature turned off',
    when: (fx) => fx.status === 404 && /feature_disabled/.test(JSON.stringify(fx.response)),
  },
  {
    why: 'registration closed by config (this server runs with registration open)',
    when: (fx) => fx.endpoint === 'POST /auth/register' && fx.status === 403,
  },
  {
    why: 'needs a pending decision owned by another user (code-assist)',
    when: (fx) => fx.endpoint === 'POST /code-assist/decision' && (fx.status === 200 || fx.status === 403),
  },
  {
    why: 'needs a pending review row seeded through the review flow',
    when: (fx) => /^POST \/kb\/review\/(approve|reject)$/.test(fx.endpoint) && [200, 409, 422].includes(fx.status),
  },
  {
    why: 'needs an installed plugin with a managed source (seeded)',
    when: (fx) => fx.status === 400 && /\/resync$/.test(fx.endpoint),
  },
  {
    why: 'needs consent granted by an earlier call (MCP plugin toggle)',
    when: (fx) => fx.status < 300 && fx.endpoint === 'POST /auth/me/mcp-plugins/toggle',
  },
  {
    why: 'fixture path must exist on the server host (project install-skills)',
    when: (fx) => fx.status === 400 && fx.endpoint === 'POST /kb/project/install-skills',
  },
  {
    why: 'needs a live refresh token from an earlier login (refresh rotates it)',
    when: (fx) => fx.status < 300 && fx.endpoint === 'POST /auth/refresh',
  },
  {
    why: 'needs the reset token mailed to the user (time- and mail-bound)',
    when: (fx) => fx.status < 300 && /^POST \/auth\/reset-(confirm|request)$/.test(fx.endpoint),
  },
];

function skipReason(fx) {
  for (const rule of SKIP_RULES) if (rule.when(fx)) return rule.why;
  return null;
}

// Replayed fixtures that the live server does not yet answer as their schema
// says. Each is a finding, reported here and asserted to still reproduce, so a
// fix (or a changed schema) makes the test fail until this entry is removed.
// Server code is not changed by this test.
const KNOWN_DRIFT = new Map([]);

// ---------------------------------------------------------------- server

let child;
let baseUrl;
let tmpDir;
let serverLog = '';
const tokenFor = new Map(); // fixture -> access token (unique user per fixture)

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

// Env for the server child: inherited vars minus the LLMIDE_ and ANTHROPIC_ prefixes, plus this test's own.
function childEnv(port, secrets) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(LLMIDE_|ANTHROPIC_)/.test(k) || k === 'NODE_TEST_CONTEXT' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return {
    ...env,
    LLMIDE_HOST: '127.0.0.1',
    LLMIDE_PORT: String(port),
    LLMIDE_DB_PATH: join(tmpDir, 'kb.db'),
    LLMIDE_ENGINE_PREWARM: '0',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    LLMIDE_JWT_SECRET: secrets.jwt,
    LLMIDE_VAULT_KEY: secrets.vault,
    LLMIDE_BCRYPT_COST: '10',
    LLMIDE_ANTHROPIC_CLI: STUB_CLI,
  };
}

/**
 * Seed one active user per replayed non-401 fixture into the temp DB, through
 * the server's own schema and token signer. Must run before the server starts
 * (the DB is single-writer). Returns nothing; fills `tokenFor`.
 */
async function seedUsers(toReplay, secrets) {
  // Config reads these at import time; set them before importing the server modules.
  process.env.LLMIDE_DB_PATH = join(tmpDir, 'kb.db');
  process.env.LLMIDE_JWT_SECRET = secrets.jwt;
  process.env.LLMIDE_VAULT_KEY = secrets.vault;
  process.env.LLMIDE_BCRYPT_COST = '10';
  const { default: bcrypt } = await import('bcryptjs');
  const { getDb, closeDb } = await import('../kb/db.mjs');
  const { signAccessToken } = await import('../server/jwt.mjs');
  const db = getDb();
  try {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    const insert = db.prepare('INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)');
    const seed = (email) => {
      const id = randomBytes(8).toString('hex');
      insert.run(id, email, 'Contract', hash, 'user');
      return signAccessToken({ userId: id, role: 'user' });
    };
    db.transaction(() => {
      toReplay.forEach((fx, i) => { if (fx.status !== 401) tokenFor.set(fx, seed(`contract-${i}@example.com`)); });
    })();
  } finally {
    closeDb();
  }
}

async function request(method, path, { token, body, query } = {}) {
  const url = new URL(path, baseUrl);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed;
  if (text !== '') {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, text, body: parsed };
}

before(async () => {
  chmodSync(STUB_CLI, 0o755);
  tmpDir = mkdtempSync(join(tmpdir(), 'llmide-http-contract-'));
  const secrets = { jwt: randomBytes(48).toString('base64url'), vault: randomBytes(48).toString('base64url') };
  await seedUsers(fixtures.filter((fx) => !skipReason(fx)), secrets);

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, 'extension'),
    env: childEnv(port, secrets),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${serverLog}`);
    try {
      const h = await request('GET', '/health');
      if (h.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not answer /health within ${BOOT_TIMEOUT_MS} ms:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(killTimer);
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- validation of a live response

/** Problems in one live response against the declared response for its status. */
function responseProblems(ep, fx, res) {
  const rs = ep.spec.responses[String(res.status)];
  const name = `${fx.endpoint} ${res.status} (${fx.file})`;
  if (!rs) return [`${name}: status ${res.status} is not declared`];
  if (rs['x-unspecified'] !== undefined || rs['x-content'] === 'binary' || rs['x-content'] === 'sse') return [];
  if (rs['x-content'] === 'none') return res.text === '' ? [] : [`${name}: expected no body, got ${res.text.slice(0, 80)}`];
  // A text body is checked on the raw bytes: an NDJSON stream of one line parses as JSON.
  if (rs['x-content'] === 'text') return typeof res.text === 'string' && rs.type === 'string' ? [] : [`${name}: expected a text body`];
  const label = `the ${res.status} response schema of "${fx.endpoint}"`;
  if (Array.isArray(rs.oneOf)) {
    const results = rs.oneOf.map((v) => validateNode(ep.walker, v, res.body, { name, label }));
    if (results.some((r) => r.problems.length === 0)) return [];
    return results.flatMap((r) => r.problems);
  }
  return validateNode(ep.walker, rs, res.body, { name, label }).problems;
}

/** Path with :params replaced by the fixture's own params. */
function pathFor(fx, pathTpl) {
  return pathTpl.replace(/:([A-Za-z0-9_]+)/g, (_, n) => {
    const v = fx.request?.params?.[n];
    if (v === undefined) throw new Error(`${fx.file}: no request.params.${n} for ${fx.endpoint}`);
    return encodeURIComponent(String(v));
  });
}

// ---------------------------------------------------------------- per-fixture tests

const replayed = new Set();     // pairs replayed with a passing live response
const skipped = [];             // { file, endpoint, status, reason }
const drifting = [];            // { file, reason, message } known drifts that still reproduce

for (const fx of fixtures) {
  const reason = skipReason(fx);
  if (reason) {
    skipped.push({ file: fx.file, endpoint: fx.endpoint, status: fx.status, reason });
    continue;
  }
  const [method, pathTpl] = fx.endpoint.split(' ');
  const ep = endpoints.get(fx.endpoint);
  test(`${fx.endpoint} -> ${fx.status} (${fx.file})`, async () => {
    assert.ok(ep, `${fx.endpoint} is not declared`);
    const path = pathFor(fx, pathTpl);
    const token = fx.status === 401 ? undefined : tokenFor.get(fx);
    const res = await request(method, path, { token, body: fx.request?.body, query: fx.request?.query });
    const problems = [];
    if (res.status !== fx.status) problems.push(`answered ${res.status}, fixture says ${fx.status}: ${res.text.slice(0, 200)}`);
    else problems.push(...responseProblems(ep, fx, res));
    if (KNOWN_DRIFT.has(fx.file)) {
      const expected = KNOWN_DRIFT.get(fx.file);
      assert.ok(problems.length > 0, `${fx.file} is listed as known drift (${expected}) but now matches its schema; remove it from KNOWN_DRIFT`);
      drifting.push({ file: fx.file, reason: expected, message: problems[0] });
      return;
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    replayed.add(pairOf(fx.endpoint, fx.status));
  });
}

test('coverage: replayed (method, path, status) pairs with a fixture', () => {
  const pct = replayed.size / withFixturePairs.size;
  const byReason = new Map();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const lines = [
    `live contract: ${replayed.size}/${withFixturePairs.size} pairs with a fixture replayed (${(100 * pct).toFixed(1)}%); `
      + `${declaredPairs.size} pairs declared; ${fixtures.length} fixtures, ${fixtures.length - skipped.length} replayed, ${skipped.length} skipped`,
    'skipped fixtures by reason:',
    ...[...byReason].sort((a, b) => b[1] - a[1]).map(([why, n]) => `  ${String(n).padStart(4)}  ${why}`),
    `known drift still reproducing: ${drifting.length}`,
    ...drifting.map((d) => `  ${d.file}: ${d.reason}`),
  ];
  console.log(lines.join('\n'));
  assert.ok(
    pct >= COVERAGE_TARGET,
    `replayed ${replayed.size}/${withFixturePairs.size} (${(100 * pct).toFixed(1)}%), target ${100 * COVERAGE_TARGET}%`,
  );
});
