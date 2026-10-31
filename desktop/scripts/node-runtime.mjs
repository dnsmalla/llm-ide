// The Node runtime that ships inside the desktop app: an OFFICIAL Node.js LTS binary,
// pinned by version and SHA-256 (node-pin.json), downloaded from nodejs.org and
// verified twice, fail closed:
//   1. the archive's SHA-256 must equal the value pinned in this repo, and
//   2. it must equal the line for that file in nodejs.org's SHASUMS256.txt for the pinned
//      version (a pin edited without checking, or a swapped mirror, both fail).
// Only the `node` executable and node's LICENSE are taken from the archive: npm, npx,
// corepack, headers and docs never reach the app. Homebrew/distro node is never used
// (it links shared libraries that do not exist inside an app).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PIN = JSON.parse(readFileSync(join(import.meta.dirname, 'node-pin.json'), 'utf8'));
export const DIST_BASE = process.env.LLMIDE_NODE_DIST_BASE || 'https://nodejs.org/dist';

export const hostTarget = () => `${process.platform}-${process.arch}`;
export const isWindowsTarget = (target) => target.startsWith('win32-');
export const nodeFileName = (target) => (isWindowsTarget(target) ? 'node.exe' : 'node');

/** Pin entry for a `<platform>-<arch>` target (Node's process names), or a thrown error. */
export function pinFor(target, pin = PIN) {
  const t = pin.targets[target];
  if (!t) throw new Error(`no pinned Node runtime for target "${target}" (have: ${Object.keys(pin.targets).join(', ')})`);
  return t;
}

/** The sha256 recorded for `file` in a SHASUMS256.txt body, or null. */
export function shasumFor(shasumsText, file) {
  for (const line of String(shasumsText).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === file) return m[1];
  }
  return null;
}

/** Throws unless `actual` equals the pinned hash AND the published hash. */
export function verifyHashes({ file, actual, pinned, published }) {
  if (actual !== pinned) throw new Error(`${file}: sha256 ${actual} does not match the pinned ${pinned} (refusing)`);
  if (!published) throw new Error(`${file}: not listed in SHASUMS256.txt for v${PIN.version} (refusing)`);
  if (published !== pinned) throw new Error(`${file}: pinned sha256 ${pinned} differs from nodejs.org's ${published}; fix node-pin.json (refusing)`);
}

export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, dest);
}

/**
 * Downloads (cached by verified hash) and unpacks the pinned runtime for `target`.
 * Returns `{ node, license, version, sha256 }`: paths to the extracted executable and
 * LICENSE, in a fresh directory under `cacheDir`.
 */
export async function fetchNodeRuntime(target, { cacheDir } = {}) {
  const entry = pinFor(target);
  const cache = resolve(cacheDir || process.env.LLMIDE_NODE_CACHE || join(tmpdir(), 'llmide-node-cache'));
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, entry.file);
  const base = `${DIST_BASE}/v${PIN.version}`;

  const shasums = await (async () => {
    const r = await fetch(`${base}/SHASUMS256.txt`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`cannot fetch SHASUMS256.txt (HTTP ${r.status}); refusing to stage an unverified node`);
    return r.text();
  })();

  if (!existsSync(archive)) await download(`${base}/${entry.file}`, archive);
  let actual = await sha256File(archive);
  if (actual !== entry.sha256) {
    // A corrupt or tampered cache entry: delete it once and re-download before giving up.
    rmSync(archive, { force: true });
    await download(`${base}/${entry.file}`, archive);
    actual = await sha256File(archive);
  }
  try {
    verifyHashes({ file: entry.file, actual, pinned: entry.sha256, published: shasumFor(shasums, entry.file) });
  } catch (e) {
    rmSync(archive, { force: true });
    throw e;
  }

  // Extract into its own new empty directory; scripts run from elsewhere (never from inside it).
  const out = join(cache, `unpacked-${target}-${PIN.version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const top = entry.file.replace(/\.(tar\.gz|zip)$/, '');
  if (isWindowsTarget(target)) {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', archive, out], { stdio: 'inherit' });
    } else {
      execFileSync('unzip', ['-q', archive, `${top}/node.exe`, `${top}/LICENSE`, '-d', out], { stdio: 'inherit' });
    }
    return { node: join(out, top, 'node.exe'), license: join(out, top, 'LICENSE'), version: PIN.version, sha256: actual };
  }
  execFileSync('tar', ['-xzf', archive, '-C', out, `${top}/bin/node`, `${top}/LICENSE`], { stdio: 'inherit' });
  return { node: join(out, top, 'bin', 'node'), license: join(out, top, 'LICENSE'), version: PIN.version, sha256: actual };
}

/** Copies the runtime into `<coreDir>/node/` (executable bit set). Returns the staged node path. */
export function installNode(runtime, coreDir, target) {
  const dir = join(coreDir, 'node');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, nodeFileName(target));
  copyFileSync(runtime.node, out);
  if (!isWindowsTarget(target)) chmodSync(out, 0o755);
  if (runtime.license && existsSync(runtime.license)) copyFileSync(runtime.license, join(dir, 'LICENSE-node.txt'));
  return out;
}
