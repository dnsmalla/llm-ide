// Smoke test for the STAGED core (desktop/resources/core), started the way the Tauri host
// starts it: cleared + allowlisted environment, per-launch nonce, the two secrets, data dir
// under a temp folder, own process group (Job Object semantics on Windows are approximated
// with taskkill /T). No model or network call is made. Checks:
//   1. /health answers 200 and echoes the nonce as `x-llmide-nonce`
//   2. the DB is created under the data dir (never the repo kb)
//   3. the `claude` probe the host uses runs and prints its marker (found or missing both pass)
//   4. SIGTERM to the group stops the core, and NO process of the tree survives
// Usage: node scripts/smoke-core.mjs     (run stage-core.mjs first; host target only)
//        LLMIDE_CORE_DIR=<.../Contents/Resources/core> node scripts/smoke-core.mjs   (a copy inside a built app)
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const DESKTOP = resolve(import.meta.dirname, '..');
// LLMIDE_CORE_DIR points the smoke test at another copy of the staged core (the build script uses the one
// inside the finished .app); default is the stage directory.
const CORE = process.env.LLMIDE_CORE_DIR ? resolve(process.env.LLMIDE_CORE_DIR) : join(DESKTOP, 'resources', 'core');
const WIN = process.platform === 'win32';
const NODE = join(CORE, 'node', WIN ? 'node.exe' : 'node');
const EXT = join(CORE, 'root', 'extension');

// Mirror of src-tauri/src/core_env.rs ALLOWED (exact names); keep in step.
const ALLOWED = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE',
  'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'LLMIDE_CLAUDE_PATH', 'LLMIDE_FEATURES']);
const allowed = (k) => ALLOWED.has(WIN ? k.toUpperCase() : k) || (!WIN && k.startsWith('LC_'));

const fail = (msg) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`OK   ${msg}`);

if (!existsSync(NODE)) { console.error(`staged node missing: ${NODE} (run scripts/stage-core.mjs)`); process.exit(1); }

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    s.on('error', rej);
  });
}

function hostEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v && allowed(k)) env[k] = v;
  const sys = WIN ? [] : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  env.PATH = [...new Set([...(process.env.PATH || '').split(delimiter), ...sys, join(CORE, 'node')])].join(delimiter);
  return { ...env, ...extra };
}

/** pids whose process group is `pgid` (unix). */
function groupMembers(pgid) {
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p);
  } catch { return []; }
}
const winAlive = (pid) => execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = mkdtempSync(join(tmpdir(), 'llmide-smoke-'));
const coreDir = join(data, 'core');
mkdirSync(coreDir, { recursive: true, mode: 0o700 }); // the host creates it (private_dir) before the spawn
const nonce = randomBytes(32).toString('hex');
const port = await freePort();
const pre = { jwt: randomBytes(32).toString('hex'), vault: randomBytes(32).toString('hex') };

const child = spawn(NODE, [join(EXT, 'server.mjs')], {
  cwd: EXT,
  env: hostEnv({
    LLMIDE_PORT: String(port), LLMIDE_DATA_DIR: coreDir, LLMIDE_DB_PATH: join(coreDir, 'data.db'),
    LLMIDE_CORE_NONCE: nonce, LLMIDE_JWT_SECRET: pre.jwt, LLMIDE_VAULT_KEY: pre.vault,
    LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BACKUP_INTERVAL_HOURS: '0',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: !WIN, // own process group, like the host (setsid-less process_group(0))
  windowsHide: true,
});
const pid = child.pid;
let tail = '';
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { tail = (tail + d).slice(-4000); });
let exited = false;
child.on('exit', () => { exited = true; });

async function stopTree() {
  if (WIN) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } return; }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 60 && groupMembers(pid).length; i++) await sleep(50);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* none left */ }
}

try {
  const t0 = Date.now();
  let res = null;
  while (Date.now() - t0 < 30_000 && !exited) {
    try { res = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'manual', signal: AbortSignal.timeout(500) }); if (res.status === 200) break; } catch { /* not up yet */ }
    res = null;
    await sleep(50);
  }
  if (!res) {
    fail(`no /health on :${port} after ${Date.now() - t0} ms${exited ? ' (core exited)' : ''}\n${tail}`);
  } else {
    ok(`/health 200 in ${Date.now() - t0} ms`);
    const got = res.headers.get('x-llmide-nonce');
    if (got === nonce) ok('nonce echoed on /health'); else fail(`nonce header was ${got === null ? 'absent' : 'different'}`);
    await res.arrayBuffer();
    if (existsSync(join(coreDir, 'data.db'))) ok('DB created under the data dir'); else fail('no data.db under the data dir');
  }

  // The probe the host runs to tell the user whether `claude` is installed (same module, same env).
  const probeJs = "import { resolveClaudeExecutable, CLAUDE_INSTALL_MESSAGE } from './providers/claude-path.mjs';"
    + "const r = resolveClaudeExecutable({ purpose: 'sdk' });"
    + "process.stdout.write('\\nLLMIDE_CLAUDE_PROBE ' + JSON.stringify({ found: Boolean(r.path), source: r.source, message: CLAUDE_INSTALL_MESSAGE }) + '\\n');";
  try {
    const out = execFileSync(NODE, ['--input-type=module', '-e', probeJs], {
      cwd: EXT, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: hostEnv({ LLMIDE_DATA_DIR: coreDir, LLMIDE_DB_PATH: join(coreDir, 'data.db') }), windowsHide: true,
    });
    const line = out.split('\n').find((l) => l.startsWith('LLMIDE_CLAUDE_PROBE '));
    if (!line) fail('claude probe printed no marker');
    else { const j = JSON.parse(line.slice('LLMIDE_CLAUDE_PROBE '.length)); ok(`claude probe: ${j.found ? `found (${j.source})` : 'missing (notice would be shown)'}`); }
  } catch (e) { fail(`claude probe failed: ${String(e.message).split('\n')[0]}`); }

  // Stop, then prove nothing of the tree is left.
  const members = WIN ? [pid] : groupMembers(pid);
  await stopTree();
  await sleep(300);
  const left = WIN ? (winAlive(pid) ? [pid] : []) : groupMembers(pid);
  if (left.length === 0) ok(`stopped; none of ${members.length} tree process(es) survived`); else fail(`orphans after stop: ${left.join(', ')}`);
  if (!WIN) {
    try { process.kill(pid, 0); fail('leader still alive'); } catch { ok('leader gone'); }
  }
} finally {
  await stopTree();
  rmSync(data, { recursive: true, force: true });
}
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
