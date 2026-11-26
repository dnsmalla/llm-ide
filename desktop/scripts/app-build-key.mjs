// Fingerprint of everything `tauri build` reads, so scripts/build-desktop-mac.sh can skip the ~140 s frontend +
// release-Rust step when nothing changed since the last successful build. Prints the key when run as a script:
//   node scripts/app-build-key.mjs
//
// WHY a content key and not mtimes: git checkouts and rebases touch mtimes without changing content, and cargo/vite
// already do their own incremental work; this only answers "is the whole input identical to the last good build".
//
// extension/ is excluded from the outer-repo listing because the core reaches the app only through desktop/resources/core,
// and STAGE.json (which carries stage-hash.mjs's sourceHash of what was staged) represents it. Its package files are
// added explicitly since they pick the dependencies that get staged. docs, ios_app, web, mac and .github are never read.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const EXCLUDED_TOP = new Set(['docs', 'ios_app', 'web', '.github', 'extension', 'mac']);
const OUTER_PATHSPEC = ['.', ...[...EXCLUDED_TOP].map((dir) => `:(exclude)${dir}`)];
const EXTRA_FILES = ['extension/package.json', 'extension/package-lock.json'];
const REPO = resolve(import.meta.dirname, '..', '..');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

function nulList(text) {
  return text.split('\0').filter(Boolean);
}

function fileHash(root, rel) {
  const abs = join(root, ...rel.split('/'));
  // Deleted files hash as 'missing' so a deletion changes the key like an edit does.
  return existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : 'missing';
}

/** Hash path + content of every given path, sorted so the result does not depend on git's output order. */
function hashFiles(root, paths, update) {
  for (const rel of [...new Set(paths)].sort()) update(`file\0${rel}\0${fileHash(root, rel)}\n`);
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function isCheckout(dir) {
  return existsSync(join(dir, '.git'));
}

export function appBuildKey({ repo = REPO, env = process.env } = {}) {
  const key = createHash('sha256');
  const add = (text) => key.update(text);

  // Committed blobs are cheap (ids only); uncommitted and untracked content is hashed on top of them.
  // ls-tree has no pathspec magic, so the exclusions are applied here.
  const tree = nulList(git(repo, ['ls-tree', '-r', '-z', 'HEAD'])).filter((line) => {
    const path = line.slice(line.indexOf('\t') + 1);
    return !EXCLUDED_TOP.has(path.split('/')[0]);
  });
  add(`tree\n${tree.join('\n')}\n`);
  const changed = nulList(git(repo, ['diff', 'HEAD', '--name-only', '-z', '--', ...OUTER_PATHSPEC]));
  const untracked = nulList(git(repo, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...OUTER_PATHSPEC]));
  hashFiles(repo, [...changed, ...untracked, ...EXTRA_FILES], add);

  // vite aliases graph-kit/web/src, so that submodule's commit and local edits matter.
  const gk = join(repo, 'graph-kit');
  if (isCheckout(gk)) {
    add(`graph-kit\0${git(gk, ['rev-parse', 'HEAD']).trim()}\n`);
    const gkChanged = nulList(git(gk, ['diff', 'HEAD', '--name-only', '-z', '--', 'web']));
    const gkUntracked = nulList(git(gk, ['ls-files', '-o', '--exclude-standard', '-z', '--', 'web']));
    hashFiles(gk, [...gkChanged, ...gkUntracked], (text) => add(`gk-${text}`));
  } else {
    add('no-graph-kit\n');
  }

  // Staging must have run first: without STAGE.json the key would not describe the bundled core.
  const stage = join(repo, 'desktop', 'resources', 'core', 'STAGE.json');
  if (!existsSync(stage)) {
    throw new Error(`${stage} is missing: stage the core (desktop/scripts/stage-core.mjs) before computing the app build key`);
  }
  add(`stage\0${readFileSync(stage, 'utf8')}\n`);

  add(`env\0${env.LLMIDE_BUILD_FEATURES ?? ''}\0${env.LLMIDE_INCLUDE_SPIKE ?? ''}\n`);
  // A toolchain change recompiles everything, so it must invalidate the stamp too.
  add(`tools\0${process.version}\0${tryRun('rustc', ['-V']) ?? 'no-rustc'}\0${process.platform}\0${process.arch}\n`);
  return key.digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.stdout.write(`${appBuildKey()}\n`);
  } catch (err) {
    process.stderr.write(`app-build-key: ${err.message}\n`);
    process.exit(1);
  }
}
