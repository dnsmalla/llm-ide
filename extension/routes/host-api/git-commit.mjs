// Commit selected paths from the remote workspace. Normal git hooks run: a failing hook fails the commit and leaves the
// working tree intact. No push, amend, reset or checkout lives here.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const TIMEOUT = 30_000;
const BUFFER = 1 << 20;

const err = (message, code) => Object.assign(new Error(message), { code });

function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || path.isAbsolute(rel)) throw err('The path is not valid.', 'invalid');
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some((p) => p === '..' || p === '')) throw err('The path is not valid.', 'invalid');
  return parts.join('/');
}

function git(root, args, timeout = TIMEOUT) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', timeout, maxBuffer: BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function gitCommit(root, { message, paths }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 200 || message.includes('\0')) throw err('The commit message is not valid.', 'invalid');
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw err('Choose at least one file and at most 100.', 'invalid');
  const files = paths.map(safeRel);
  try { git(root, ['add', '-A', '--', ...files]); }
  catch { throw err('git could not stage those files.', 'git_failed'); }
  let out;
  try { out = git(root, ['commit', '-m', message, '--', ...files]); }
  catch (e) {
    const text = `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
    if (/nothing to commit|no changes added|nothing added to commit/i.test(text)) throw err('There is nothing to commit in those files.', 'nothing_to_commit');
    throw err('git could not commit: ' + (text.trim().split('\n')[0] || 'git failed'), 'git_failed');
  }
  let commit = '';
  try { commit = git(root, ['rev-parse', '--short', 'HEAD']).trim(); } catch { /* commit exists even if rev-parse failed */ }
  const summary = out.trim().split('\n').find((line) => line.trim()) ?? `Committed ${files.length} file(s).`;
  return { commit, summary };
}
