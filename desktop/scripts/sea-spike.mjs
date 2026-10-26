// Phase 0 T6 spike: bundle extension/server.mjs into one CJS file with esbuild
// and inject it into a copy of the official Node binary as a Single Executable
// Application (SEA). Read-only on the source tree: it works on a copy.
//
// Usage: node scripts/sea-spike.mjs <packRoot> <nodeBin> <outDir>
//   packRoot  dir holding extension/ (pruned, prod node_modules) and schema/
//   nodeBin   official node binary to inject into (not the Homebrew shim)
//   outDir    where the bundle, blob and injected binary are written
//
// The bundle keeps every module's `import.meta.url` pointing at its original
// location under LLMIDE_REPO_ROOT at runtime, so kb/migrations, prompt files
// and schema/models resolve as they do from source. Native and ESM-only
// externals are loaded from disk via createRequire / import() on that root.

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [packRoot, nodeBin, outDir] = process.argv.slice(2).map((p) => resolve(p));
if (!packRoot || !nodeBin || !outDir) {
  console.error('usage: sea-spike.mjs <packRoot> <nodeBin> <outDir>');
  process.exit(2);
}
const requireFromDesktop = createRequire(import.meta.url);
const esbuild = requireFromDesktop('esbuild');

const EXTERNALS = ['better-sqlite3', '@anthropic-ai/claude-agent-sdk', 'zod'];
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Runtime shims injected at the top of the bundle (CJS, runs inside SEA).
const BANNER = `
const __llmideRoot = process.env.LLMIDE_REPO_ROOT || require('path').dirname(process.execPath);
const __llmideRequire = require('module').createRequire(require('path').join(__llmideRoot, 'extension', 'package.json'));
const __llmideMetaUrl = (rel) => require('url').pathToFileURL(require('path').join(__llmideRoot, rel)).href;
`;

const rewriteMeta = {
  name: 'rewrite-import-meta',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
      if (args.path.includes(`${join('node_modules', 'esbuild')}`)) return undefined;
      let src = readFileSync(args.path, 'utf8');
      // Self-test guards (`if (import.meta.url === file://argv[1]) { await main() }`)
      // hold TLA that cjs rejects; they can never be true inside the bundle.
      src = src.replace(/if \(import\.meta\.url === [^\n]*\) \{/g, 'if (false) {');
      const rel = relative(packRoot, args.path).split('\\').join('/');
      src = src.split('import.meta.url').join(`__llmideMetaUrl(${JSON.stringify(rel)})`);
      if (args.path.endsWith(join('extension', 'server.mjs'))) {
        // Top-level await is illegal in a CJS bundle: defer listen() until the
        // feature routes are imported (same ordering as the original).
        const before = 'await initFeatureRoutes(config.features);\n\nserver.listen(PORT, HOST, () => {';
        if (!src.includes(before)) throw new Error('server.mjs TLA site not found; update the spike');
        src = src.replace(before, 'initFeatureRoutes(config.features).then(() => server.listen(PORT, HOST, () => {');
        src = src.replace(/\}\);\s*$/, '}));\n');
      }
      const loader = args.path.endsWith('.ts') ? 'ts' : args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.jsx') ? 'jsx' : args.path.endsWith('.js') || args.path.endsWith('.cjs') ? 'js' : 'js';
      return { contents: src, loader };
    });
  },
};

const externals = {
  name: 'externals',
  setup(build) {
    build.onResolve({ filter: /^(better-sqlite3|zod|@anthropic-ai\/claude-agent-sdk)(\/.*)?$/ }, (a) => ({ path: a.path, external: true }));
  },
};

mkdirSync(outDir, { recursive: true });
const cjsPath = join(outDir, 'server.cjs');
const result = await esbuild.build({
  entryPoints: [join(packRoot, 'extension', 'server.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: cjsPath,
  banner: { js: BANNER },
  plugins: [externals, rewriteMeta],
  logLevel: 'warning',
  write: false,
  sourcemap: false,
  legalComments: 'none',
  nodePaths: [join(packRoot, 'extension', 'node_modules')],
});
let code = result.outputFiles[0].text;
// Externals are resolved from the runtime root, not the bundle location.
let rewrites = 0;
// Every specifier that matches an external (exact name or subpath) is resolved
// from the runtime root instead of the bundle location.
const EXTERNAL_RE = /(require|import)\("((?:better-sqlite3|zod|@anthropic-ai\/claude-agent-sdk)(?:\/[^"]*)?)"\)/g;
code = code.replace(EXTERNAL_RE, (_m, kind, name) => {
  rewrites += 1;
  if (kind === 'require') return `__llmideRequire(${JSON.stringify(name)})`;
  return `import(require('url').pathToFileURL(__llmideRequire.resolve(${JSON.stringify(name)})).href)`;
});
writeFileSync(cjsPath, code);
console.log(`bundle ${cjsPath}: ${code.length} bytes, external rewrites: ${rewrites}`);

// SEA blob.
const seaConfig = join(outDir, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({ main: cjsPath, output: join(outDir, 'sea-prep.blob'), disableExperimentalSEAWarning: true }));
execFileSync(nodeBin, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// Inject into a fresh copy of the node binary.
const exe = join(outDir, 'llmide-core');
rmSync(exe, { force: true });
copyFileSync(nodeBin, exe);
chmodSync(exe, 0o755);
const postject = join(resolve(import.meta.dirname, '..'), 'node_modules', '.bin', 'postject');
execFileSync(postject, [exe, 'NODE_SEA_BLOB', join(outDir, 'sea-prep.blob'), '--sentinel-fuse', SENTINEL, '--macho-segment-name', 'NODE_SEA'], { stdio: 'inherit' });
execFileSync('codesign', ['--remove-signature', exe], { stdio: 'ignore' });
execFileSync('codesign', ['-s', '-', '-f', exe], { stdio: 'inherit' });
console.log(`injected: ${exe}`);
