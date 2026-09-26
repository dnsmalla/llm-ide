// Checking for, and installing, a newer Claude Agent SDK — driven from the
// Mac app (Settings → Backend → Claude Agent SDK).
//
// The SDK ships often (ten releases in the 11 days after 0.3.272) and each
// bundles its own Claude Code binary, so staying current was a manual
// `npm install` in the checkout. This module:
//   - reports the version the RUNNING server loaded, the one installed on
//     disk (they differ after an update until the backend restarts), and the
//     registry's `latest` (cached);
//   - installs exactly the registry's latest with `npm install --save-exact`
//     (execFile, no shell — the version string is never user input), then
//     proves the new package loads in a separate Node process, and reinstalls
//     the previous version if it does not.
// The caller restarts the backend: an ES module already imported by this
// process cannot be replaced in place.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = '@anthropic-ai/claude-agent-sdk';
// The dist-tags document only: the package's full registry document is
// megabytes (hundreds of versions) for the one field needed here.
const REGISTRY_URL = `https://registry.npmjs.org/-/package/${PKG}/dist-tags`;
const LATEST_CACHE_MS = 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// extension/ — the package this server runs from (llm_agent/sdk/ → ../../).
const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readInstalledVersion(dir = EXTENSION_DIR) {
  try {
    const p = path.join(dir, 'node_modules', ...PKG.split('/'), 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
  } catch { return null; }
}

// What this process imported at startup — read once, before any update can
// change the file on disk.
const RUNNING_VERSION = readInstalledVersion();

function readDeclaredVersion(dir = EXTENSION_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.dependencies?.[PKG] ?? null;
  } catch { return null; }
}

let latestCache = null;

export async function fetchLatestVersion({ force = false, fetchFn = fetch, now = Date.now } = {}) {
  if (!force && latestCache && now() - latestCache.at < LATEST_CACHE_MS) return latestCache;
  const res = await fetchFn(REGISTRY_URL, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
  const data = await res.json();
  const latest = data?.latest;
  if (typeof latest !== 'string' || !SEMVER_RE.test(latest)) throw new Error('npm registry gave no usable latest version');
  latestCache = { at: now(), latest };
  return latestCache;
}

// Numeric x.y.z comparison; a prerelease sorts before its release.
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Remote access widens who can reach this server; an install runs npm on the host. */
export function updateAllowed(env = process.env) {
  if (env.LLMIDE_ALLOW_REMOTE === '1' && env.LLMIDE_ALLOW_SDK_UPDATE !== '1') {
    return { ok: false, reason: 'SDK updates are disabled while remote access (LLMIDE_ALLOW_REMOTE) is on; set LLMIDE_ALLOW_SDK_UPDATE=1 to allow them.' };
  }
  return { ok: true };
}

export async function sdkStatus({ force = false, fetchFn } = {}) {
  const installed = readInstalledVersion();
  const status = {
    package: PKG,
    running: RUNNING_VERSION,
    installed,
    declared: readDeclaredVersion(),
    restartNeeded: Boolean(RUNNING_VERSION && installed && RUNNING_VERSION !== installed),
    latest: null,
    updateAvailable: false,
    updating: Boolean(inFlight),
    canUpdate: updateAllowed().ok,
    error: null,
  };
  try {
    const { latest } = await fetchLatestVersion({ force, fetchFn });
    status.latest = latest;
    status.updateAvailable = Boolean(installed) && compareVersions(latest, installed) > 0;
  } catch (err) {
    status.error = String(err?.message || err).slice(0, 200);
  }
  return status;
}

function npmBin() {
  // The npm that ships beside this node — the one the checkout was installed
  // with — rather than whatever `npm` the server's PATH happens to hold.
  const beside = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

function run(file, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, out: `${stdout || ''}${stderr || ''}`.slice(-4000) });
    });
  });
}

const install = (version, dir) => run(npmBin(), [
  'install', `${PKG}@${version}`, '--save-exact', '--no-audit', '--no-fund',
], { cwd: dir, timeout: INSTALL_TIMEOUT_MS });

// Load the freshly installed package in a NEW process (this one still holds
// the old module) and check the entry points the engine uses exist.
const SMOKE = `import(${JSON.stringify(PKG)}).then((m) => {
  const need = ['query', 'tool', 'createSdkMcpServer'];
  const missing = need.filter((k) => typeof m[k] !== 'function');
  if (missing.length) { console.error('missing exports: ' + missing.join(', ')); process.exit(1); }
}).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });`;

const smoke = (dir) => run(process.execPath, ['--input-type=module', '-e', SMOKE], { cwd: dir, timeout: 60_000 });

let inFlight = null;

/**
 * Install the registry's latest SDK. Resolves (never throws) to
 * { ok, from, to, rolledBack, restartNeeded, log }.
 */
export function updateSdk({ dir = EXTENSION_DIR, fetchFn, installFn = install, smokeFn = smoke } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const from = readInstalledVersion(dir);
    const allowed = updateAllowed();
    if (!allowed.ok) return { ok: false, from, to: from, rolledBack: false, restartNeeded: false, log: allowed.reason };
    let latest;
    try { ({ latest } = await fetchLatestVersion({ force: true, fetchFn })); }
    catch (err) { return { ok: false, from, to: from, rolledBack: false, restartNeeded: false, log: String(err?.message || err) }; }
    if (from && compareVersions(latest, from) <= 0) {
      return { ok: true, from, to: from, rolledBack: false, restartNeeded: false, log: `Already on ${from} (latest ${latest}).` };
    }
    const installed = await installFn(latest, dir);
    const now = readInstalledVersion(dir);
    const check = installed.ok && now === latest ? await smokeFn(dir) : { ok: false, out: '' };
    if (installed.ok && now === latest && check.ok) {
      return { ok: true, from, to: latest, rolledBack: false, restartNeeded: true, log: installed.out };
    }
    // Put the previous version back so the next restart still has a working SDK.
    let rolledBack = false;
    if (from) {
      const back = await installFn(from, dir);
      rolledBack = back.ok && readInstalledVersion(dir) === from;
    }
    const why = !installed.ok ? 'npm install failed' : now !== latest ? `installed ${now}, expected ${latest}` : 'the new SDK failed to load';
    return {
      ok: false, from, to: readInstalledVersion(dir), rolledBack, restartNeeded: false,
      log: `${why}.${rolledBack ? ` Restored ${from}.` : ''}\n${installed.out}\n${check.out}`.trim().slice(-4000),
    };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export function __resetUpdaterForTest() {
  latestCache = null;
  inFlight = null;
}
