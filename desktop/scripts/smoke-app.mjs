// desktop/scripts/smoke-app.mjs
// Launches the PACKAGED app (no repo checkout), waits for the core it spawns on 3456..3459 (a 200 /health that
// echoes a launch nonce), stops the app the way the OS would, and asserts no bundled-node core process survives.
// Memory keychain + a temp data dir, so the runner's keychain and real user data are never touched. No model call.
//   node scripts/smoke-app.mjs <app executable>      (Linux: run under xvfb-run; AppImage: APPIMAGE_EXTRACT_AND_RUN=1)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CORE_PORTS = [3456, 3457, 3458, 3459];
const WIN = process.platform === 'win32';
const START_MS = 120_000;
const STOP_MS = 20_000;

export function isHostCore(status, headers) {
  const n = typeof headers?.get === 'function' ? headers.get('x-llmide-nonce') : headers?.['x-llmide-nonce'];
  return status === 200 && /^[0-9a-f]{64}$/.test(n ?? '');
}

const isCoreCmd = (cmd, nodeMark) => typeof cmd === 'string' && cmd.includes(nodeMark) && cmd.includes('server.mjs');

export function coreProcesses(psText) {
  return psText.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => isCoreCmd(m[2], '/core/node/node ')).map((m) => Number(m[1]));
}

export function coreProcessesWin(json) {
  if (!json.trim()) return [];
  const rows = [JSON.parse(json)].flat();
  return rows.filter((r) => isCoreCmd(r?.CommandLine, '\\core\\node\\node.exe')).map((r) => Number(r.ProcessId));
}

function listCore() {
  if (WIN) {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    return coreProcessesWin(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
  }
  return coreProcesses(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }));
}

async function probe() {
  for (const port of CORE_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
      if (isHostCore(r.status, r.headers)) return port;
    } catch { /* not listening yet */ }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const exe = resolve(process.argv[2] ?? '');
  const data = mkdtempSync(join(tmpdir(), 'llmide-smoke-app-'));
  const log = join(data, 'app.log');
  const env = { ...process.env, LLMIDE_KEYCHAIN_BACKEND: 'memory', LLMIDE_DESKTOP_DATA_DIR: data };
  for (const k of ['LLMIDE_ADOPT_CORE', 'LLMIDE_POC_BUNDLED', 'LLMIDE_REPO_ROOT', 'LLMIDE_NODE_BIN']) delete env[k];
  if (listCore().length) { console.error('FAIL a core process is already running before launch'); process.exit(1); }
  const fd = openSync(log, 'a');
  const app = spawn(exe, [], { env, stdio: ['ignore', fd, fd] });
  let port = null;
  const t0 = Date.now();
  while (Date.now() - t0 < START_MS && port === null && app.exitCode === null) { port = await probe(); if (port === null) await sleep(1000); }
  const fail = (m) => { console.error(`FAIL ${m}\n--- app log ---\n${readFileSync(log, 'utf8').slice(-4000)}`); try { app.kill('SIGKILL'); } catch {} process.exit(1); };
  if (port === null) fail(`no app-spawned core answered /health on ${CORE_PORTS.join('/')} within ${START_MS / 1000}s (app exit ${app.exitCode})`);
  console.log(`OK   core healthy on :${port} after ${Date.now() - t0} ms`);
  const pids = listCore();
  if (!pids.length) fail('core healthy but no bundled-node server.mjs process matched; update coreProcesses() for this layout');
  console.log(`OK   core process(es): ${pids.join(', ')}`);
  // Windows: kill the host alone (no /T); the Job Object (KILL_ON_JOB_CLOSE) must take the core with it.
  if (WIN) execFileSync('taskkill', ['/PID', String(app.pid), '/F'], { stdio: 'ignore' });
  else app.kill('SIGTERM');
  const t1 = Date.now();
  while (Date.now() - t1 < STOP_MS && (listCore().length || (await probe()) !== null)) await sleep(500);
  const left = listCore();
  if (left.length) fail(`core survived the app: ${left.join(', ')}`);
  if ((await probe()) !== null) fail('a core still answers /health after the app stopped');
  console.log(`OK   app stopped, no core left after ${Date.now() - t1} ms`);
}
