// Stage the Node core for bundling (Phase 0 T6 fallback packaging).
//
// Produces desktop/resources/core/ which tauri.conf.json copies into the app:
//   core/node/node            self-contained Node binary (LLMIDE_NODE_BIN)
//   core/root/extension/...   pruned copy of extension/ with production deps
//   core/root/schema/...      schema/models (read via ../../schema from providers/)
//
// The source tree is only read. Dev-only paths (tests, src, dist, docs, live
// DB files) are never copied. Usage:
//   LLMIDE_NODE_BIN=/path/to/official/node node scripts/stage-core.mjs
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { removeSdkBinaryPackages, sdkBinaryAllowed, verifyNoSdkBinary } from './sdk-binary.mjs';
import { isSecretName, makeCopyFilter, verifyStagedCore } from './stage-filter.mjs';

const DESKTOP = resolve(import.meta.dirname, '..');
const REPO = resolve(DESKTOP, '..');
const OUT = join(DESKTOP, 'resources', 'core');
const TARGET = `${process.platform}-${process.arch}`;

const nodeBin = process.env.LLMIDE_NODE_BIN;
if (!nodeBin || !existsSync(nodeBin)) {
  console.error('LLMIDE_NODE_BIN must point at a self-contained node binary (not a Homebrew shim)');
  process.exit(2);
}

// The bundled node must be an official self-contained build. Homebrew node
// links libnode.dylib from its prefix, which does not exist inside the .app.
// Checked before anything under resources/core is removed.
let linked;
try {
  linked = execFileSync('otool', ['-L', nodeBin], { encoding: 'utf8' });
} catch (e) {
  console.error(`cannot run otool -L on ${nodeBin}: ${e.message.split('\n')[0]}`);
  process.exit(2);
}
if (linked.includes('libnode')) {
  console.error(`LLMIDE_NODE_BIN (${nodeBin}) links libnode (Homebrew node build), which is not self-contained.`);
  console.error('Use the official node.org macOS binary, e.g. LLMIDE_NODE_BIN=/path/to/official/node.');
  process.exit(2);
}

// Top-level extension entries that the server never loads at runtime.
const SKIP_TOP = new Set(['node_modules', 'tests', 'src', 'dist', 'docs', 'scripts', 'eslint.config.mjs',
  'tsconfig.json', 'vite.config.ts', 'CLAUDE.md', 'README.md']);
const SKIP_FILE = /(\.db(-wal|-shm|-journal)?|\.log(\.old)?|\.DS_Store)$/;
// Secrets and local agent state must never ship in the app (see stage-filter.mjs, which also
// allowlists what may enter kb/ and verifies the finished stage).

function dirBytes(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    total += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return total;
}

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      visit(p, true);
      if (existsSync(p)) walk(p, visit); // visit may have removed it
    } else {
      visit(p, false);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
const extOut = join(OUT, 'root', 'extension');
mkdirSync(extOut, { recursive: true });
mkdirSync(join(OUT, 'node'), { recursive: true });

// 1. Node binary (ad-hoc signed; stripped to keep the bundle small).
const nodeOut = join(OUT, 'node', 'node');
copyFileSync(nodeBin, nodeOut);
chmodSync(nodeOut, 0o755);
try {
  execFileSync('strip', ['-x', nodeOut], { stdio: 'ignore' });
  execFileSync('codesign', ['-s', '-', '-f', nodeOut], { stdio: 'ignore' });
} catch (e) {
  console.warn(`warning: strip/codesign skipped: ${e.message.split('\n')[0]}`);
}

// 2. Extension source (runtime files only), then production deps.
const copyFilter = makeCopyFilter(join(REPO, 'extension'), { skipFile: SKIP_FILE });
for (const name of readdirSync(join(REPO, 'extension'))) {
  if (SKIP_TOP.has(name) || SKIP_FILE.test(name) || isSecretName(name)) continue;
  cpSync(join(REPO, 'extension', name), join(extOut, name), {
    recursive: true,
    filter: copyFilter,
  });
}
for (const f of ['package.json', 'package-lock.json']) {
  if (!existsSync(join(extOut, f))) copyFileSync(join(REPO, 'extension', f), join(extOut, f));
}
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: extOut, stdio: 'inherit' });
const nmBefore = dirBytes(join(extOut, 'node_modules'));

// 3. Prune node_modules: other-platform prebuilds, sources, docs, sourcemaps.
const nm = join(extOut, 'node_modules');
rmSync(join(nm, '.bin'), { recursive: true, force: true });
rmSync(join(nm, '@rollup'), { recursive: true, force: true }); // vite-only optional dep
const bsPre = join(nm, 'better-sqlite3', 'prebuilds');
if (existsSync(bsPre)) {
  for (const f of readdirSync(bsPre)) if (f !== `${TARGET}.node`) rmSync(join(bsPre, f));
}
for (const d of ['deps', 'src', 'build']) rmSync(join(nm, 'better-sqlite3', d), { recursive: true, force: true });
// `.claude` too: published packages can carry a maintainer's local agent
// settings (thread-stream does), which have no business in the app.
const DROP_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github', '.claude']);
const DROP_FILE = /(\.map|\.d\.ts|\.md|\.markdown|\.ts)$|^(README|CHANGELOG|HISTORY|LICENSE|LICENCE|CONTRIBUTING|AUTHORS)/i;
const dropped = [];
walk(nm, (p, isDir) => {
  const name = basename(p);
  if (isDir) {
    if (DROP_DIRS.has(name) && existsSync(p)) { dropped.push(p); rmSync(p, { recursive: true, force: true }); }
    return;
  }
  if (DROP_FILE.test(name) && !p.includes(`${join('better-sqlite3', 'lib')}`)) {
    if (existsSync(p)) { unlinkSync(p); dropped.push(p); }
  }
});
const nmAfter = dirBytes(nm);

// Phase 0 condition 2: never ship the SDK's platform `claude` binary (see sdk-binary.mjs).
if (sdkBinaryAllowed()) {
  console.warn('warning: LLMIDE_STAGE_ALLOW_SDK_BINARY=1, the SDK claude binary stays in the stage (not for release)');
} else {
  const removedSdk = removeSdkBinaryPackages(nm);
  if (removedSdk.length) console.log(`removed SDK claude binary package(s): ${removedSdk.map((p) => basename(p)).join(', ')}`);
  const leftover = verifyNoSdkBinary(OUT);
  if (leftover.length) {
    console.error(`staging failed: the SDK claude binary must not be bundled:\n  ${leftover.join('\n  ')}`);
    process.exit(1);
  }
}

// Final gate: nothing that must never ship (live DBs, backups, secrets, log files, symlinks
// leaving the tree) may be in the stage, whatever the copy filters did.
{
  const bad = verifyStagedCore(OUT);
  if (bad.length) {
    console.error(`staging failed: the stage contains files that must not ship:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
}

// 4. Schema file read from providers/ as ../../schema/models/...
const schemaOut = join(OUT, 'root', 'schema', 'models');
mkdirSync(schemaOut, { recursive: true });
copyFileSync(join(REPO, 'schema', 'models', 'anthropic-models.json'), join(schemaOut, 'anthropic-models.json'));

const sizes = {
  node_binary: statSync(nodeOut).size,
  extension_src: dirBytes(extOut) - nmAfter,
  node_modules_before_prune: nmBefore,
  node_modules_after_prune: nmAfter,
  schema: dirBytes(join(OUT, 'root', 'schema')),
  core_total: dirBytes(OUT),
};
writeFileSync(join(OUT, 'STAGE.json'), JSON.stringify({ target: TARGET, sizes, generatedBy: 'scripts/stage-core.mjs' }, null, 2));
for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(28)} ${v}`);
console.log(`BENCH ${JSON.stringify({ name: 'bundle_bytes', value: sizes.core_total, unit: 'bytes', part: 'core_stage' })}`);
console.log(`staged ${relative(REPO, OUT)} (dropped ${dropped.length} doc/test/sourcemap entries)`);
