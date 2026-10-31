// Spawn a child in its OWN process group and kill the whole group on abort.
// A plain child.kill() leaves grandchildren (a test runner's workers, a shell's
// pipeline) running; killing -pid reaches them all. POSIX only: on win32 the
// group kill is unavailable and we fall back to killing the child itself.
import { spawn } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/** Signal a whole group (or the child alone on win32). Never throws. */
export function killGroup(pid, signal = 'SIGTERM') {
  if (!pid) return false;
  try { process.kill(IS_WIN ? pid : -pid, signal); return true; } catch { return false; }
}

/** True while at least one process is still a member of the group (signal 0 sends nothing). */
export function groupAlive(pid) {
  if (!pid || IS_WIN) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// What a child gets when the caller names no env: enough to run tools, none of the server's own secrets
// (LLMIDE_*, API keys, tokens). A caller that needs more passes `env` explicitly; it is used AS GIVEN, never merged
// with process.env.
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'SystemRoot', 'ComSpec', 'PATHEXT'];
export function sanitizedEnv(source = process.env) {
  const out = {};
  for (const k of SAFE_ENV_KEYS) if (typeof source[k] === 'string') out[k] = source[k];
  return out;
}

/**
 * Run a command to completion in its own group.
 * `signal` (AbortSignal) aborts: SIGTERM to the group, SIGKILL after `graceMs`.
 * Resolves {code, signal, stdout, stderr, aborted}; rejects only if spawn fails.
 * `onSpawn(pid)` lets a caller track the group (the runner kills it on quit); `onExit(pid)` tells it the leader is
 * gone so it stops tracking (a pid number can be reused by an unrelated process once the group is empty).
 * `env` is used as given; with none, a sanitized default (no inherited secrets).
 */
export function runGrouped(command, args = [], { cwd, env, signal, graceMs = 2000, onSpawn, onExit, maxOutput = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', aborted: true }); return; }
    const child = spawn(command, args, { cwd, env: env && typeof env === 'object' ? env : sanitizedEnv(), detached: !IS_WIN, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let killTimer = null;
    let closed = false;
    const cap = (s, d) => (s.length + d.length > maxOutput ? (s + d).slice(0, maxOutput) : s + d);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); });
    const onAbort = () => {
      aborted = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => { if (!closed) killGroup(child.pid, 'SIGKILL'); }, graceMs);
      killTimer.unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => { clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', (code, sig) => {
      closed = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      // The leader is gone. Sweep survivors ONLY while the group still has live members: once it is empty the
      // number may belong to an unrelated process, and killing -pid would hit it.
      if (groupAlive(child.pid)) killGroup(child.pid, 'SIGKILL');
      if (child.pid) onExit?.(child.pid);
      resolve({ code, signal: sig, stdout, stderr, aborted });
    });
    if (child.pid) onSpawn?.(child.pid);
  });
}
