// Stage the Node core for bundling (Phase 0 T6 fallback packaging).
//
// Produces desktop/resources/core/ which tauri.conf.json copies into the app:
//   core/node/node[.exe]      pinned official Node LTS (node-runtime.mjs; npm/corepack not shipped)
//   core/root/extension/...   pruned copy of extension/ with production deps
//   core/root/schema/...      schema/models (read via ../../schema from providers/)
//
// The source tree is only read. Dev-only paths (tests, src, dist, docs, live
// DB files) are never copied. Usage:
//   node scripts/stage-core.mjs [--target darwin-arm64|darwin-x64|win32-x64|linux-x64]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { PIN, fetchNodeRuntime, hostTarget, installNode, pinFor } from './node-runtime.mjs';
import { removeSdkBinaryPackages, sdkBinaryAllowed, verifyNoSdkBinary } from './sdk-binary.mjs';
import { isSecretName, makeCopyFilter, verifyStagedCore } from './stage-filter.mjs';

const DESKTOP = resolve(import.meta.dirname, '..');
const REPO = resolve(DESKTOP, '..');
const OUT = join(DESKTOP, 'resources', 'core');

// --target <platform>-<arch> (Node process names: darwin-arm64, darwin-x64, win32-x64, linux-x64);
// default is the machine running this script.
const targetArg = process.argv.indexOf('--target');
const TARGET = targetArg > 0 ? process.argv[targetArg + 1] : hostTarget();
const CROSS = TARGET !== hostTarget();
try { pinFor(TARGET); } catch (e) { console.error(e.message); process.exit(2); }

// The node that ships: by default the pinned, SHA-256-verified official Node LTS for TARGET
// (node-runtime.mjs). LLMIDE_NODE_BIN is an offline/dev escape hatch for the host target only
// (never for a release: LLMIDE_STAGE_RELEASE=1 refuses it). Checked before anything under
// resources/core is removed.
let nodeBin = process.env.LLMIDE_NODE_BIN;
let nodeInfo = { version: 'local', sha256: null };
if (nodeBin) {
  if (process.env.LLMIDE_STAGE_RELEASE === '1') {
    console.error('LLMIDE_NODE_BIN is not allowed with LLMIDE_STAGE_RELEASE=1: releases use the pinned official Node');
    process.exit(2);
  }
  if (CROSS) {
    console.error(`LLMIDE_NODE_BIN cannot be used to stage a different target (${TARGET} on ${hostTarget()})`);
    process.exit(2);
  }
  if (!existsSync(nodeBin)) {
    console.error(`LLMIDE_NODE_BIN does not exist: ${nodeBin}`);
    process.exit(2);
  }
  console.warn(`warning: using LLMIDE_NODE_BIN (${nodeBin}), not the pinned Node ${PIN.version}; not for release`);
  // Homebrew node links libnode.dylib from its prefix, which does not exist inside the .app.
  if (process.platform === 'darwin') {
    let linked;
    try {
      linked = execFileSync('otool', ['-L', nodeBin], { encoding: 'utf8' });
    } catch (e) {
      console.error(`cannot run otool -L on ${nodeBin}: ${e.message.split('\n')[0]}`);
      process.exit(2);
    }
    if (linked.includes('libnode')) {
      console.error(`LLMIDE_NODE_BIN (${nodeBin}) links libnode (Homebrew node build), which is not self-contained.`);
      console.error('Unset it to use the pinned official Node, or point it at the official node.org binary.');
      process.exit(2);
    }
  }
  nodeBin = { node: nodeBin, license: null };
} else {
  try {
    nodeBin = await fetchNodeRuntime(TARGET);
    nodeInfo = { version: nodeBin.version, sha256: nodeBin.sha256 };
    console.log(`node ${nodeBin.version} (${TARGET}) verified sha256 ${nodeBin.sha256}`);
  } catch (e) {
    console.error(`staging failed: ${e.message}`);
    process.exit(2);
  }
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

// 1. Node binary. macOS: stripped and ad-hoc re-signed (the official signature is invalid
// after strip); done only for a darwin target staged on a darwin host (needs strip/codesign).
const nodeOut = installNode(nodeBin, OUT, TARGET);
if (TARGET.startsWith('darwin-') && process.platform === 'darwin') {
  try {
    execFileSync('strip', ['-x', nodeOut], { stdio: 'ignore' });
    execFileSync('codesign', ['-s', '-', '-f', nodeOut], { stdio: 'ignore' });
  } catch (e) {
    console.warn(`warning: strip/codesign skipped: ${e.message.split('\n')[0]}`);
  }
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
// npm is npm.cmd on Windows, which only runs through a shell.
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: extOut, stdio: 'inherit', shell: process.platform === 'win32' });
const nmBefore = dirBytes(join(extOut, 'node_modules'));

// 3. Prune node_modules: other-platform prebuilds, sources, docs, sourcemaps.
const nm = join(extOut, 'node_modules');
rmSync(join(nm, '.bin'), { recursive: true, force: true });
rmSync(join(nm, '@rollup'), { recursive: true, force: true }); // vite-only optional dep
const bsPre = join(nm, 'better-sqlite3', 'prebuilds');
if (existsSync(bsPre)) {
  // better-sqlite3 13 ships N-API prebuilds for every target inside the package (named
  // <platform>-<arch>.node, same as TARGET), so no ABI match with the bundled node is needed.
  for (const f of readdirSync(bsPre)) if (f !== `${TARGET}.node`) rmSync(join(bsPre, f));
}
if (!existsSync(join(bsPre, `${TARGET}.node`))) {
  console.error(`staging failed: better-sqlite3 has no prebuild for ${TARGET} (${bsPre})`);
  process.exit(1);
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

const nmFinal = dirBytes(nm); // after the SDK binary package was removed
const sizes = {
  node_binary: statSync(nodeOut).size,
  extension_src: dirBytes(extOut) - nmFinal,
  node_modules_before_prune: nmBefore,
  node_modules_after_prune: nmFinal,
  schema: dirBytes(join(OUT, 'root', 'schema')),
  core_total: dirBytes(OUT),
};
writeFileSync(join(OUT, 'STAGE.json'), JSON.stringify({ target: TARGET, node: nodeInfo, sizes, generatedBy: 'scripts/stage-core.mjs' }, null, 2));
for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(28)} ${v}`);
console.log(`BENCH ${JSON.stringify({ name: 'bundle_bytes', value: sizes.core_total, unit: 'bytes', part: 'core_stage' })}`);
console.log(`staged ${relative(REPO, OUT)} (dropped ${dropped.length} doc/test/sourcemap entries)`);
