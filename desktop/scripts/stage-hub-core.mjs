// Build the Linux x64 hub bundle from the desktop's already-staged core.
//
// The bundle is the same pinned Node 22 + production deps the desktop ships, so the hub needs no
// Node, npm or compiler. Usage:
//   node desktop/scripts/stage-hub-core.mjs [--out <absolute dir>] [--version <x.y.z>]
// Output: <out>/llmide-core-<version>-linux-x64.tar.gz + .sha256 + VERSION + SHA256SUMS
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..');
const REPO = resolve(DESKTOP, '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : fallback;
};
const out = resolve(arg('--out', join(DESKTOP, 'dist', 'hub')));
if (!out.startsWith('/')) { console.error('--out must be absolute'); process.exit(2); }
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const version = arg('--version', pkg.version || '0.0.0');
const stage = join(tmpdir(), `llmide-hub-stage-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
try {
  const core = join(stage, 'core');
  mkdirSync(core, { recursive: true });
  execFileSync(process.execPath, [join(HERE, 'stage-core.mjs'), '--target', 'linux-x64', '--out', core], { cwd: REPO, stdio: 'inherit' });
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
  const tar = join(out, `llmide-core-${version}-linux-x64.tar.gz`);
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-czf', tar, '-C', stage, '.'], { stdio: 'inherit' });
  const sha = createHash('sha256').update(readFileSync(tar)).digest('hex');
  writeFileSync(`${tar}.sha256`, `${sha}  ${basename(tar)}\n`);
  writeFileSync(join(out, 'SHA256SUMS'), `${sha}  ${basename(tar)}\n`);
  writeFileSync(join(out, 'VERSION'), `${version}\n`);
  console.log(tar);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
