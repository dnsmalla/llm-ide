// Read-only git for the remote workspace. Every call is execFile, never a shell; the project root is supplied by the
// gateway from scopedProjectRoot, and a path is always passed after `--`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const DIFF_MAX = 262_144;
const TIMEOUT = 5_000;
const BUFFER = 1 << 20;

const git = (root, args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
  encoding: 'utf8', timeout: TIMEOUT, maxBuffer: BUFFER,
});

function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || path.isAbsolute(rel)) throw Object.assign(new Error('The path is not valid.'), { code: 'invalid' });
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some((p) => p === '..' || p === '')) throw Object.assign(new Error('The path is not valid.'), { code: 'invalid' });
  return parts.join('/');
}

/** Branch, ahead/behind and porcelain-v1 entries. A non-repo or a git failure is a `git_failed` code. */
export function gitStatus(root) {
  let branch = 'HEAD';
  try { branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'HEAD'; } catch { /* unborn or detached */ }
  let ahead = 0; let behind = 0;
  try {
    const counts = git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).trim().split(/\s+/).map(Number);
    behind = counts[0] ?? 0; ahead = counts[1] ?? 0;
  } catch { /* no upstream */ }
  let raw;
  try { raw = git(root, ['status', '--porcelain=v1', '-z']); }
  catch { throw Object.assign(new Error('git status failed.'), { code: 'git_failed' }); }
  const tokens = raw.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0]; const y = rec[1];
    const file = rec.slice(3);
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const from = renamed && tokens[i + 1] ? tokens[++i] : null;
    entries.push({ path: file, x, y, status: x === '?' && y === '?' ? '??' : `${x}${y}`.trim() || 'M', ...(from ? { from } : {}) });
  }
  return { branch, ahead, behind, clean: entries.length === 0, entries };
}

/** Unified diff for the project or one path, capped. `staged` reads the index. */
export function gitDiff(root, { path: rel, staged = false } = {}) {
  const args = ['diff', '--no-ext-diff', '--no-color', ...(staged ? ['--cached'] : []), '--unified=3'];
  if (rel !== undefined && rel !== null && rel !== '') args.push('--', safeRel(rel));
  let patch;
  try { patch = git(root, args); }
  catch { throw Object.assign(new Error('git diff failed.'), { code: 'git_failed' }); }
  const truncated = Buffer.byteLength(patch, 'utf8') > DIFF_MAX;
  return { patch: truncated ? patch.slice(0, DIFF_MAX) : patch, truncated };
}
