// Push the current branch to its already-configured upstream. No force, no remote/ref arguments, no prompt.
import { hostChildEnv, runCapture } from './exec-run.mjs';

export const PUSH_TIMEOUT = 60_000;
const BUFFER = 1 << 20;

export async function gitPush(root) {
  // hostChildEnv: git runs hooks (pre-push) and credential helpers, neither may see the core's secrets.
  const r = await runCapture('git', ['--no-optional-locks', '-C', root, 'push'], { timeout: PUSH_TIMEOUT, maxBytes: BUFFER, env: hostChildEnv() });
  if (r.error || r.timedOut || r.overflow || r.status !== 0) {
    const text = `${r.stdout}${r.stderr}`.trim();
    const message = r.timedOut ? 'git push timed out.' : (text.split('\n').filter(Boolean).slice(-1)[0] || 'git push failed.');
    throw Object.assign(new Error(message), { code: 'push_failed' });
  }
  const text = r.stdout.trim();
  return { ok: true, output: text.length > 500 ? text.slice(-500) : text };
}
