// Commit selected paths from the remote workspace. Normal git hooks run: a failing hook fails the commit and leaves the
// working tree intact. No push, amend, reset or checkout lives here.
import path from 'node:path';
import { isDeniedPath } from '../../llm_agent/tools/handlers/repo-files.mjs';
import { hostChildEnv, runCapture } from './exec-run.mjs';

const TIMEOUT = 30_000;
const BUFFER = 1 << 20;

const err = (message, code) => Object.assign(new Error(message), { code });

function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || path.isAbsolute(rel)) throw err('The path is not valid.', 'invalid');
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some((p) => p === '..' || p === '')) throw err('The path is not valid.', 'invalid');
  // Pathspec magic (`:(top)`, `:!x`), `.` and globs would stage far more than the one file the client named,
  // including files files.write refuses.
  if (rel.startsWith(':') || parts.some((p) => p === '.') || /[*?[\]{}]/.test(rel)) throw err('The path is not valid.', 'invalid');
  if (isDeniedPath(rel)) throw err('That path cannot be committed.', 'invalid');
  return parts.join('/');
}

// Rejects with the git output attached (stdout/stderr) on a non-zero exit, like execFileSync did.
async function git(root, args, timeout = TIMEOUT) {
  // hostChildEnv: commit hooks run repo-supplied code and must not see the core's secrets.
  const r = await runCapture('git', ['--no-optional-locks', '-C', root, ...args], { timeout, maxBytes: BUFFER, env: hostChildEnv() });
  if (r.error || r.timedOut || r.overflow || r.status !== 0) throw Object.assign(new Error('git failed'), { stdout: r.stdout, stderr: r.stderr });
  return r.stdout;
}

export async function gitCommit(root, { message, paths }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 200 || message.includes('\0')) throw err('The commit message is not valid.', 'invalid');
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw err('Choose at least one file and at most 100.', 'invalid');
  const files = paths.map(safeRel);
  try { await git(root, ['add', '-A', '--', ...files]); }
  catch { throw err('git could not stage those files.', 'git_failed'); }
  let out;
  try { out = await git(root, ['commit', '-m', message, '--', ...files]); }
  catch (e) {
    const text = `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
    if (/nothing to commit|no changes added|nothing added to commit/i.test(text)) throw err('There is nothing to commit in those files.', 'nothing_to_commit');
    throw err('git could not commit: ' + (text.trim().split('\n')[0] || 'git failed'), 'git_failed');
  }
  let commit = '';
  try { commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim(); } catch { /* commit exists even if rev-parse failed */ }
  const summary = out.trim().split('\n').find((line) => line.trim()) ?? `Committed ${files.length} file(s).`;
  return { commit, summary };
}
