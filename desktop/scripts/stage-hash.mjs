// Fingerprint of everything stage-core.mjs copies from the source tree, so a stale desktop/resources/core can be
// detected. stage-core.mjs writes it into STAGE.json (`sourceHash`); build.rs recomputes it with
//   node scripts/stage-hash.mjs
// and fails a release build when the two differ (a bare `tauri build` would otherwise bundle whatever the last
// stage left behind).
//
// Tracked files only (git ls-files): untracked scratch files are never copied meaningfully, and the hash must not
// depend on a developer's local clutter. The working-tree CONTENT is hashed, so an uncommitted edit counts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { KB_ALLOWED_EXT, isSecretName } from './stage-filter.mjs';

// Top-level extension entries that the server never loads at runtime (shared with stage-core.mjs).
export const SKIP_TOP = new Set(['node_modules', 'tests', 'src', 'dist', 'docs', 'scripts', 'eslint.config.mjs',
  'tsconfig.json', 'vite.config.ts', 'CLAUDE.md', 'README.md']);
export const SKIP_FILE = /(\.db(-wal|-shm|-journal)?|\.log(\.old)?|\.DS_Store)$/;

const REPO = resolve(import.meta.dirname, '..', '..');

/** True when stage-core.mjs would copy this repo-relative extension path. */
export function isStaged(relPath) {
  const parts = relPath.split('/');
  if (parts[0] !== 'extension' || parts.length < 2) return false;
  const top = parts[1];
  if (SKIP_TOP.has(top) || SKIP_FILE.test(top)) return false;
  if (parts.slice(1).some((p) => isSecretName(p) || SKIP_FILE.test(p))) return false;
  if (top === 'kb' && parts.length > 2 && !KB_ALLOWED_EXT.test(parts[parts.length - 1])) return false;
  return true;
}

export function sourceHash(repo = REPO) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'extension', 'schema/models/anthropic-models.json', 'schema/host-api'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const files = listed.filter((p) => !p.startsWith('extension/') || isStaged(p));
  // The graph-kit CLI is a submodule artifact, not tracked by this repo; hash it when it exists.
  const gk = 'graph-kit/bin/graph-kit.js';
  if (existsSync(join(repo, gk))) files.push(gk);
  const outer = createHash('sha256');
  for (const rel of [...new Set(files)].sort()) {
    const abs = join(repo, ...rel.split('/'));
    const inner = existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : 'missing';
    outer.update(`${rel.split(sep).join('/')}\0${inner}\n`);
  }
  return outer.digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.stdout.write(sourceHash());
}
