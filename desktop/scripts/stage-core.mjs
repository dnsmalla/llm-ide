// Stage the Node core for bundling (Phase 0 T6 fallback packaging).
//
// Produces desktop/resources/core/ which tauri.conf.json copies into the app:
//   core/node/node[.exe]      pinned official Node LTS (node-runtime.mjs; npm/corepack not shipped)
//   core/root/extension/...   pruned copy of extension/ with production deps
//   core/root/schema/...      schema/models + schema/host-api (read via ../../schema from providers/)
//
// The source tree is only read. Dev-only paths (tests, src, dist, docs, live
// DB files) are never copied. Usage:
//   node scripts/stage-core.mjs [--target darwin-arm64|darwin-x64|win32-x64|linux-x64]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { PIN, fetchNodeRuntime, hostTarget, installNode, pinFor } from './node-runtime.mjs';
import { removeSdkBinaryPackages, sdkBinaryAllowed, verifyNoSdkBinary } from './sdk-binary.mjs';
import { isSecretName, makeCopyFilter, verifyStagedCore } from './stage-filter.mjs';
import { SKIP_FILE, SKIP_TOP, sourceHash } from './stage-hash.mjs';

const DESKTOP = resolve(import.meta.dirname, '..');
const REPO = resolve(DESKTOP, '..');
function outDir(argv, fallback) {
  const i = argv.indexOf('--out');
  if (i < 0) return fallback;
  const value = argv[i + 1];
  if (!value || !value.startsWith('/')) throw new Error('--out needs an absolute path');
  return value;
}
const OUT = outDir(process.argv, join(DESKTOP, 'resources', 'core'));
// Pruned production node_modules from the last stage, one entry per target (see step 3).
const DEPS_CACHE = process.env.LLMIDE_STAGE_CACHE || join(DESKTOP, 'resources', '.deps-cache');
// LLMIDE_BUILD_VERBOSE=1 prints the size table and per-step detail; a normal build prints one summary line.
const VERBOSE = process.env.LLMIDE_BUILD_VERBOSE === '1';

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
if (process.env.LLMIDE_STAGE_RELEASE === '1' && sdkBinaryAllowed()) {
  console.error('LLMIDE_STAGE_ALLOW_SDK_BINARY=1 is not allowed with LLMIDE_STAGE_RELEASE=1: releases never ship the SDK claude binary');
  process.exit(2);
}
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
    if (VERBOSE) console.log(`node ${nodeBin.version} (${TARGET}) verified sha256 ${nodeBin.sha256}`);
  } catch (e) {
    console.error(`staging failed: ${e.message}`);
    process.exit(2);
  }
}

// SKIP_TOP / SKIP_FILE live in stage-hash.mjs so the staleness fingerprint uses the very same rules.
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


function depsCacheKey() {
  const hash = createHash('sha256').update(`sdk=${sdkBinaryAllowed()}\0`);
  for (const f of [join(REPO, 'extension', 'package.json'), join(REPO, 'extension', 'package-lock.json'),
    join(DESKTOP, 'scripts', 'stage-core.mjs'), join(DESKTOP, 'scripts', 'sdk-binary.mjs')]) {
    hash.update(readFileSync(f)).update('\0');
  }
  return `${TARGET}-${hash.digest('hex').slice(0, 24)}`;
}

// Replaces this target's previous entry, so the cache holds at most one node_modules (~60 MB) per target.
function saveDepsCache(src, key) {
  const tmp = join(DEPS_CACHE, `.tmp-${process.pid}`);
  try {
    mkdirSync(DEPS_CACHE, { recursive: true });
    for (const name of readdirSync(DEPS_CACHE)) {
      if (name.startsWith(`${TARGET}-`)) rmSync(join(DEPS_CACHE, name), { recursive: true, force: true });
    }
    cpSync(src, join(tmp, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    renameSync(tmp, join(DEPS_CACHE, key));
  } catch (e) {
    // An unwritable cache only costs the next build its ~30 s; never fail the stage for it.
    console.warn(`warning: deps cache not saved: ${e.message.split('\n')[0]}`);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Drops other-platform prebuilds, sources, docs and sourcemaps; returns how many entries were removed.
function pruneNodeModules(nm) {
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
  let count = 0;
  walk(nm, (p, isDir) => {
    const name = basename(p);
    if (isDir) {
      if (DROP_DIRS.has(name) && existsSync(p)) { count++; rmSync(p, { recursive: true, force: true }); }
      return;
    }
    if (DROP_FILE.test(name) && !p.includes(`${join('better-sqlite3', 'lib')}`)) {
      if (existsSync(p)) { unlinkSync(p); count++; }
    }
  });
  return count;
}

// Taken before anything is copied: build.rs compares it with the current source and refuses a stale stage.
const SOURCE_HASH = sourceHash();
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

// 1b. The GraphKit TypeScript CLI (dist/bin, esbuild-bundled). The Mac's graph scanners are Swift; the
// desktop uses the schema-compatible TS engine to generate the same canonical graph.json.
const gk = join(REPO, 'graph-kit', 'bin', 'graph-kit.js');
if (existsSync(gk)) {
  const gkOut = join(OUT, 'root', 'graph-kit', 'bin');
  mkdirSync(gkOut, { recursive: true });
  copyFileSync(gk, join(gkOut, 'graph-kit.js'));
  if (VERBOSE) console.log(`graph-kit CLI staged (${Math.round(statSync(gk).size / 1024)} KiB)`);
} else if (process.env.LLMIDE_STAGE_RELEASE === '1') {
  // graph-kit/bin/graph-kit.js is committed in the submodule; missing means the checkout was skipped.
  console.error(`graph-kit CLI not found at ${gk}: run \`git submodule update --init graph-kit\``);
  process.exit(2);
} else {
  console.warn(`warning: graph-kit CLI not found at ${gk}; code-graph generation will be unavailable`);
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
// 3. Production node_modules. `npm ci` + prune takes ~30 s and downloads ~500 MB, yet the result depends only on
// the lock files, the target and the prune rules; reuse the last pruned copy when none of those changed.
// LLMIDE_STAGE_NO_CACHE=1 forces a fresh install. The SDK-binary and must-not-ship gates below run either way.
const nm = join(extOut, 'node_modules');
const depsKey = depsCacheKey();
const cachedNm = join(DEPS_CACHE, depsKey, 'node_modules');
let nmBefore = null; // unknown on a cache hit
let dropped = 0;
if (process.env.LLMIDE_STAGE_NO_CACHE !== '1' && existsSync(cachedNm)) {
  cpSync(cachedNm, nm, { recursive: true, verbatimSymlinks: true });
  console.log('node_modules reused (lock files unchanged)');
} else {
  // npm is npm.cmd on Windows, which only runs through a shell. --loglevel=error: the EBADENGINE notices compare
  // engines with the BUILD machine's node, not the pinned node that ships, so they are noise here.
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: extOut, stdio: 'inherit', shell: process.platform === 'win32' });
  nmBefore = dirBytes(nm);
  dropped = pruneNodeModules(nm);
  // Phase 0 condition 2: never ship the SDK's platform `claude` binary (see sdk-binary.mjs).
  if (sdkBinaryAllowed()) {
    console.warn('warning: LLMIDE_STAGE_ALLOW_SDK_BINARY=1, the SDK claude binary stays in the stage (not for release)');
  } else {
    const removedSdk = removeSdkBinaryPackages(nm);
    if (removedSdk.length && VERBOSE) console.log(`removed SDK claude binary package(s): ${removedSdk.map((p) => basename(p)).join(', ')}`);
  }
  saveDepsCache(nm, depsKey);
}

if (!sdkBinaryAllowed()) {
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

// 4b. Host API v1 contract (envelope, command registry, events, fixtures) so the desktop
// host validates frames against the same bytes as the Mac and the conformance gate.
cpSync(join(REPO, 'schema', 'host-api'), join(OUT, 'root', 'schema', 'host-api'), { recursive: true });

const nmFinal = dirBytes(nm); // after the SDK binary package was removed
const sizes = {
  node_binary: statSync(nodeOut).size,
  extension_src: dirBytes(extOut) - nmFinal,
  node_modules_before_prune: nmBefore,
  node_modules_after_prune: nmFinal,
  schema: dirBytes(join(OUT, 'root', 'schema')),
  core_total: dirBytes(OUT),
};
writeFileSync(join(OUT, 'STAGE.json'), JSON.stringify({ target: TARGET, node: nodeInfo, sizes, sourceHash: SOURCE_HASH, generatedBy: 'scripts/stage-core.mjs' }, null, 2));
if (VERBOSE) {
  for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(28)} ${v}`);
  console.log(`BENCH ${JSON.stringify({ name: 'bundle_bytes', value: sizes.core_total, unit: 'bytes', part: 'core_stage' })}`);
  if (dropped) console.log(`dropped ${dropped} doc/test/sourcemap entries`);
}
console.log(`staged ${relative(REPO, OUT)}: node ${nodeInfo.version}, ${(sizes.core_total / 1048576).toFixed(0)} MB`);
