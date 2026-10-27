#!/usr/bin/env node
// Feature matrix (Phase 1 kit gates): every removable Mac feature switched off,
// one row at a time, checked on the server side and (with --mac) on the Mac side.
//
// Rows
//   - one row per excludable key off alone: code_graph_3d, gantt_issues,
//     terminal, doc_gen, mobile_sync, auto_tasks;
//   - closure:file_explorer — file_explorer off, which also turns off
//     code_graph_3d, gantt_issues and doc_gen (mac/Package.swift and
//     config.mjs parseFeatures apply the same closure);
//   - the pair quadrants lite / min / mobile-only (the same selections as the
//     Makefile build-mac-* targets; the Mac side reuses those targets).
//
// Server side, per row (a fresh server on a free port with a temp DB and
// LLMIDE_FEATURES = every key minus the row's off-keys):
//   1. /health `features` equals the closed enabled set computed here;
//   2. /health `endpoints` equals ALL_ENDPOINTS minus the disabled groups'
//      routes; every disabled group owns at least one route;
//   3. every route of a disabled group answers an authenticated request with
//      404 { error: 'feature_disabled', feature: <key> };
//   4. every extension REQUIRED_ENDPOINTS path (src/sidepanel/App.tsx) is in
//      /health `endpoints` — this holds for every row, because no always-on
//      endpoint the extension calls is feature-owned (the extension never
//      needs a feature turned on);
//   5. the live contract test in assert mode (tests/http-contract-live.test.mjs,
//      CONTRACT_EXPECT_DISABLED=1) passes: fixtures of disabled routes expect
//      404 feature_disabled instead of being skipped.
//
// Mac side (--mac only, slow): `swift build` with the row's LLMIDE_FEATURES and
// its own --scratch-path .build-fm-<row>, or `make build-mac-<quadrant>`.
//
// Usage:
//   node scripts/feature-matrix.mjs --all            every row, server side
//   node scripts/feature-matrix.mjs --key doc_gen    one row (also: closure:file_explorer, lite, min, mobile-only)
//   node scripts/feature-matrix.mjs --all --mac      also the Mac builds
// Exit 1 when any row fails; the summary table names what failed.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoster } from './lib/roster.mjs';
import { FEATURE_ROUTE_GROUPS } from '../extension/routes/feature-routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const MAC = path.join(ROOT, 'mac');

// The seven excludable keys (extension/core/config.mjs FEATURE_KEYS minus agent_chat).
const EXCLUDABLE = ['file_explorer', 'code_graph_3d', 'gantt_issues', 'terminal', 'doc_gen', 'mobile_sync', 'auto_tasks'];
const ALL_KEYS = ['agent_chat', ...EXCLUDABLE];
// AppFeature.requiredDependencies (mirrors config.mjs FEATURE_REQUIRES).
const REQUIRES = { code_graph_3d: ['file_explorer'], gantt_issues: ['file_explorer'], doc_gen: ['file_explorer'] };

/** Enabled keys after the closure, given the keys switched off. */
function enabledAfter(off) {
  const enabled = new Set(ALL_KEYS.filter((k) => !off.includes(k)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of [...enabled]) {
      if ((REQUIRES[k] || []).some((dep) => !enabled.has(dep))) { enabled.delete(k); changed = true; }
    }
  }
  return [...enabled].sort();
}

const ROWS = [
  ...['code_graph_3d', 'gantt_issues', 'terminal', 'doc_gen', 'mobile_sync', 'auto_tasks'].map((k) => ({
    id: k, label: `${k} off`, off: [k], mac: { kind: 'swift' },
  })),
  { id: 'closure:file_explorer', label: 'file_explorer off (closure: code_graph_3d, gantt_issues, doc_gen)', off: ['file_explorer'], mac: { kind: 'swift' } },
  { id: 'lite', label: 'build-mac-lite quadrant', off: ['file_explorer', 'code_graph_3d', 'gantt_issues', 'doc_gen', 'terminal'], mac: { kind: 'make', target: 'build-mac-lite' } },
  { id: 'min', label: 'build-mac-min quadrant', off: EXCLUDABLE, mac: { kind: 'make', target: 'build-mac-min' } },
  { id: 'mobile-only', label: 'build-mac-mobile-only quadrant', off: ['file_explorer', 'code_graph_3d', 'gantt_issues', 'doc_gen', 'terminal', 'auto_tasks'], mac: { kind: 'make', target: 'build-mac-mobile-only' } },
].map((row) => {
  const enabled = enabledAfter(row.off);
  const disabled = ALL_KEYS.filter((k) => !enabled.includes(k));
  // The LLMIDE_FEATURES a launcher would pass: every key minus the row's off-keys.
  // Closure dependents are passed too; the server and Package.swift drop them.
  const features = ALL_KEYS.filter((k) => !row.off.includes(k)).join(',');
  return { ...row, enabled, disabled, features };
});

// ---------------------------------------------------------------- helpers

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function http(base, method, p, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(new URL(p, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

function requiredEndpoints() {
  const src = readFileSync(path.join(EXT, 'src/sidepanel/App.tsx'), 'utf8');
  const block = src.match(/const REQUIRED_ENDPOINTS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('REQUIRED_ENDPOINTS not found in App.tsx');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Feature key whose route group owns this path (matrix-side mapping), or null. */
function groupOf(routePath) {
  for (const [key, group] of Object.entries(FEATURE_ROUTE_GROUPS)) {
    if (group.prefixes.some((pre) => routePath.startsWith(pre))) return key;
  }
  return null;
}

// ---------------------------------------------------------------- server side

/** Boot one server for the row; returns { base, child, output, stop }. */
async function bootServer(row) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `llmide-fm-${row.id.replace(/[^a-z0-9]/gi, '_')}-`));
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'),
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0',
    LLMIDE_FEATURES: row.features,
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot: ${output.slice(-800)}`);
    try { if ((await http(base, 'GET', '/health')).status === 200) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not answer /health: ${output.slice(-800)}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, child, output: () => output, stop };
}

async function bearer(base) {
  const email = `fm-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = 'example-password';
  const reg = await http(base, 'POST', '/auth/register', { body: { email, password, displayName: 'Feature Matrix' } });
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}: ${reg.text.slice(0, 200)}`);
  const login = await http(base, 'POST', '/auth/login', { body: { email, password } });
  if (login.status !== 200 || !login.json?.accessToken) throw new Error(`login answered ${login.status}`);
  return login.json.accessToken;
}

/** Server-side checks for one row. Returns { ok, problems[] }. */
async function serverChecks(row) {
  const problems = [];
  const srv = await bootServer(row);
  try {
    const health = (await http(srv.base, 'GET', '/health')).json;
    const features = [...(health.features ?? ALL_KEYS)].sort();
    if (JSON.stringify(features) !== JSON.stringify(row.enabled)) {
      problems.push(`/health features ${JSON.stringify(features)} != expected ${JSON.stringify(row.enabled)}`);
    }
    const serverSrc = readFileSync(path.join(EXT, 'server.mjs'), 'utf8');
    const routes = parseRoster(serverSrc).map((r) => r.path);
    const disabledGroups = row.disabled.filter((k) => FEATURE_ROUTE_GROUPS[k]);
    const disabledRoutes = new Map(); // route -> feature key
    for (const key of disabledGroups) {
      const owned = routes.filter((r) => groupOf(r) === key);
      if (owned.length === 0) problems.push(`group ${key} owns no route in ALL_ENDPOINTS (prefix drift?)`);
      for (const r of owned) disabledRoutes.set(r, key);
    }
    const advertised = health.endpoints ?? [];
    const expectAdvertised = routes.filter((r) => !disabledRoutes.has(r));
    if (JSON.stringify(advertised) !== JSON.stringify(expectAdvertised)) {
      const extra = advertised.filter((r) => disabledRoutes.has(r));
      const missing = expectAdvertised.filter((r) => !advertised.includes(r));
      if (extra.length) problems.push(`/health endpoints still advertise disabled routes: ${extra.join(', ')}`);
      if (missing.length) problems.push(`/health endpoints miss enabled routes: ${missing.join(', ')}`);
      if (!extra.length && !missing.length) problems.push('/health endpoints order differs from ALL_ENDPOINTS');
    }
    const token = await bearer(srv.base);
    for (const [r, key] of disabledRoutes) {
      const res = await http(srv.base, 'POST', r, { token, body: {} });
      const want = { error: 'feature_disabled', feature: key };
      if (res.status !== 404 || JSON.stringify(res.json) !== JSON.stringify(want)) {
        problems.push(`POST ${r} answered ${res.status} ${res.text.slice(0, 120)}, want 404 ${JSON.stringify(want)}`);
      }
    }
    const missingRequired = requiredEndpoints().filter((e) => !advertised.includes(e));
    if (missingRequired.length) problems.push(`extension REQUIRED_ENDPOINTS not advertised: ${missingRequired.join(', ')}`);
    if (health.features == null && row.disabled.length) problems.push('/health features is null (all) but the row disables keys');
  } catch (err) {
    problems.push(`server check threw: ${err.message}`);
  } finally {
    await srv.stop();
  }
  return { ok: problems.length === 0, problems };
}

/** The live contract test in assert mode, against a server booted with the row's features. */
function liveContract(row) {
  const res = spawnSync(process.execPath, ['--test', 'tests/http-contract-live.test.mjs'], {
    cwd: EXT,
    env: { ...process.env, CONTRACT_EXPECT_DISABLED: '1', CONTRACT_FEATURES: row.features },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const pass = /^# pass (\d+)/m.exec(out)?.[1] ?? '?';
  const fail = /^# fail (\d+)/m.exec(out)?.[1] ?? '?';
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const ok = res.status === 0 && fail === '0';
  return { ok, detail: `${pass} pass / ${fail} fail`, problems: failed.slice(0, 5) };
}

// ---------------------------------------------------------------- Mac side

function macBuild(row) {
  const started = Date.now();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', LLMIDE_FEATURES: row.features };
  let res;
  if (row.mac.kind === 'make') {
    res = spawnSync('make', [row.mac.target], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } else {
    const scratch = `.build-fm-${row.id.replace(/[^a-z0-9]/gi, '_')}`;
    res = spawnSync('swift', ['build', '--manifest-cache', 'none', '--scratch-path', scratch], {
      cwd: MAC, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const ok = res.status === 0;
  const logPath = path.join(os.tmpdir(), `feature-matrix-${row.id.replace(/[^a-z0-9]/gi, '_')}.log`);
  writeFileSync(logPath, out);
  const errors = out.split('\n').filter((l) => /error:/.test(l)).slice(0, 3);
  return { ok, secs, problems: ok ? [] : [...errors, `full log: ${logPath}`] };
}

// ---------------------------------------------------------------- driver

function parseArgs(argv) {
  const args = { keys: [], all: false, mac: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--mac') args.mac = true;
    else if (a === '--key') args.keys.push(argv[++i]);
    else if (a === '-h' || a === '--help') { args.help = true; }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function select(args) {
  if (args.keys.length === 0) return ROWS;
  return args.keys.map((k) => {
    const id = k === 'file_explorer' ? 'closure:file_explorer' : k;
    const row = ROWS.find((r) => r.id === id);
    if (!row) throw new Error(`unknown row ${k}; rows: ${ROWS.map((r) => r.id).join(', ')}`);
    return row;
  });
}

function table(results) {
  const rows = results.map((r) => [
    r.row.id,
    r.row.disabled.join(',') || '-',
    r.server.ok ? 'ok' : `FAIL (${r.server.problems.length})`,
    r.live ? (r.live.ok ? `ok (${r.live.detail})` : `FAIL (${r.live.detail})`) : '-',
    r.mac ? (r.mac.ok ? `ok ${r.mac.secs}s` : `FAIL ${r.mac.secs}s`) : '-',
  ]);
  const head = ['row', 'disabled', 'server', 'live contract', 'mac build'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(width[i])).join('  ');
  return [line(head), line(width.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/feature-matrix.mjs [--all | --key <row>] [--mac]');
    return 0;
  }
  const rows = select(args);
  const results = [];
  for (const row of rows) {
    console.log(`\n== ${row.id}: ${row.label} (LLMIDE_FEATURES=${row.features})`);
    const server = await serverChecks(row);
    for (const p of server.problems) console.log(`  server: ${p}`);
    const live = liveContract(row);
    console.log(`  live contract (assert mode): ${live.ok ? 'ok' : 'FAIL'} ${live.detail}`);
    for (const p of live.problems) console.log(`    ${p}`);
    const mac = args.mac ? macBuild(row) : null;
    if (mac) console.log(`  mac build: ${mac.ok ? 'ok' : 'FAIL'} in ${mac.secs}s`);
    if (mac) for (const p of mac.problems) console.log(`    ${p}`);
    results.push({ row, server, live, mac });
  }
  console.log(`\n${table(results)}`);
  const failed = results.filter((r) => !r.server.ok || !r.live.ok || (r.mac && !r.mac.ok));
  console.log(failed.length
    ? `\nfeature-matrix: ${failed.length} of ${results.length} row(s) FAILED: ${failed.map((r) => r.row.id).join(', ')}`
    : `\nfeature-matrix: all ${results.length} row(s) ok${args.mac ? ' (server + mac)' : ' (server; --mac not run)'}`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(`feature-matrix: ${err.stack || err.message}`);
  process.exitCode = 2;
});
