// Build the Linux x64 hub bundle from the desktop's already-staged core.
//
// The bundle is the same pinned Node 22 + production deps the desktop ships, so the hub needs no
// Node, npm or compiler. Usage:
//   node desktop/scripts/stage-hub-core.mjs [--out <absolute dir>] [--version <x.y.z>]
// Output: <out>/llmide-core-<version>-linux-x64.tar.gz + .sha256 + VERSION + SHA256SUMS
// The default <out> is desktop/hub-dist (not desktop/dist, which every web build empties).
// With --compat-sqlite <absolute file>: the same bundle with the glibc 2.28 better-sqlite3 module in place
// of the prebuild, named llmide-core-<version>-linux-x64-compat.tar.gz (+ .sha256 only; see sqlite-compat.mjs).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, devNull } from 'node:os';
import { compatBundleName, readCompatModule } from './sqlite-compat.mjs';
import { resolveHubOut } from './hub-out.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..');
const REPO = resolve(DESKTOP, '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : fallback;
};
// Probes with an empty archive so the answer is about this tar binary, not about the host OS.
function tarAcceptsNoXattrs() {
  try {
    execFileSync('tar', ['--no-xattrs', '-cf', devNull, '--files-from', devNull], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Default output is outside Vite's dist folder (see hub-out.mjs).
const out = resolve(resolveHubOut(args, DESKTOP));
if (!out.startsWith('/')) { console.error('--out must be absolute'); process.exit(2); }
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const version = arg('--version', pkg.version || '0.0.0');

// The module is checked against its sibling .sha256 before any staging work, so a bad file fails in seconds.
const compatIndex = args.indexOf('--compat-sqlite');
const compatFile = compatIndex >= 0 ? args[compatIndex + 1] : null;
if (compatIndex >= 0 && (!compatFile || !isAbsolute(compatFile))) {
  console.error('--compat-sqlite needs an absolute file path');
  process.exit(2);
}
let compatBytes = null;
if (compatFile) {
  try {
    compatBytes = readCompatModule(compatFile);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const stage = join(tmpdir(), `llmide-hub-stage-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
try {
  const core = join(stage, 'core');
  mkdirSync(core, { recursive: true });
  execFileSync(process.execPath, [join(HERE, 'stage-core.mjs'), '--target', 'linux-x64', '--out', core], { cwd: REPO, stdio: 'inherit' });
  if (compatBytes) {
    // Replaces the linux-x64 prebuild that stage-core keeps; the path is the one stage-core writes and checks.
    const prebuild = join(core, 'root', 'extension', 'node_modules', 'better-sqlite3', 'prebuilds', 'linux-x64.node');
    if (!existsSync(prebuild)) throw new Error(`staging failed: no better-sqlite3 prebuild to replace at ${prebuild}`);
    writeFileSync(prebuild, compatBytes);
  }
  // The hub's on-demand backup service runs this script from the staged extension.
  for (const f of ['backup.mjs', 'restore-backup.mjs']) {
    const src = join(REPO, 'extension', 'scripts', f);
    if (existsSync(src)) {
      const dst = join(stage, 'core', 'root', 'extension', 'scripts');
      mkdirSync(dst, { recursive: true });
      cpSync(src, join(dst, f));
    }
  }
  // Optional PWA served at /app/ by the hub's nginx.
  if (existsSync(join(REPO, 'web', 'dist'))) cpSync(join(REPO, 'web', 'dist'), join(stage, 'core', 'root', 'web'), { recursive: true });
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
  const tar = join(out, compatBytes ? compatBundleName(version) : `llmide-core-${version}-linux-x64.tar.gz`);
  mkdirSync(out, { recursive: true });
  // macOS tar writes ._* AppleDouble files and xattr headers unless told not to; GNU tar on the server
  // then warns and the core finds the junk files. --no-xattrs is probed, not assumed: GNU tar builds may lack it.
  const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
  const xattrFlags = tarAcceptsNoXattrs() ? ['--no-xattrs'] : [];
  // The tarball and its checksum are built under temporary names and renamed into place only when both
  // exist: an interrupted run must not leave a bundle under the name the app prefers (the -compat one).
  const partial = join(out, `.${basename(tar)}.partial-${process.pid}`);
  const partialSha = `${partial}.sha256`;
  try {
    execFileSync('tar', [...xattrFlags, '-czf', partial, '-C', stage, '.'], { stdio: 'inherit', env: tarEnv });
    const sha = createHash('sha256').update(readFileSync(partial)).digest('hex');
    writeFileSync(partialSha, `${sha}  ${basename(tar)}\n`);
    renameSync(partialSha, `${tar}.sha256`);
    renameSync(partial, tar);
    // The compat run writes only its own checksum: SHA256SUMS and VERSION here would describe the hub bundle
    // and overwrite it when both are staged into the same --out directory.
    if (!compatBytes) {
      writeFileSync(join(out, 'SHA256SUMS'), `${sha}  ${basename(tar)}\n`);
      writeFileSync(join(out, 'VERSION'), `${version}\n`);
    }
  } catch (err) {
    rmSync(partial, { force: true });
    rmSync(partialSha, { force: true });
    throw err;
  }
  console.log(tar);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
