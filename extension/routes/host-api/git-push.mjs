// Push the current branch to its already-configured upstream. No force, no remote/ref arguments, no prompt.
import { execFileSync } from 'node:child_process';

export const PUSH_TIMEOUT = 60_000;
const BUFFER = 1 << 20;

export function gitPush(root) {
  const git = (args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', timeout: PUSH_TIMEOUT, maxBuffer: BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  let out;
  try { out = git(['push']); }
  catch (e) {
    const text = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim();
    throw Object.assign(new Error(text.split('\n').filter(Boolean).slice(-1)[0] || 'git push failed.'), { code: 'push_failed' });
  }
  const text = out.trim();
  return { ok: true, output: text.length > 500 ? text.slice(-500) : text };
}
