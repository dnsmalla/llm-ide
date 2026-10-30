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

/**
 * Run a command to completion in its own group.
 * `signal` (AbortSignal) aborts: SIGTERM to the group, SIGKILL after `graceMs`.
 * Resolves {code, signal, stdout, stderr, aborted}; rejects only if spawn fails.
 * `onSpawn(pid)` lets a caller track the group (the runner kills it on quit).
 */
export function runGrouped(command, args = [], { cwd, env, signal, graceMs = 2000, onSpawn, maxOutput = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', aborted: true }); return; }
    const child = spawn(command, args, { cwd, env, detached: !IS_WIN, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let killTimer = null;
    const cap = (s, d) => (s.length + d.length > maxOutput ? (s + d).slice(0, maxOutput) : s + d);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); });
    const onAbort = () => {
      aborted = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), graceMs);
      killTimer.unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => { clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      // The leader is gone; sweep any survivors of the group.
      killGroup(child.pid, 'SIGKILL');
      resolve({ code, signal: sig, stdout, stderr, aborted });
    });
    if (child.pid) onSpawn?.(child.pid);
  });
}
