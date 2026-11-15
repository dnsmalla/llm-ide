// Async, bounded child runner shared by the Host API exec commands (terminal.exec, terminal.shell, git.*).
//
// Why not spawnSync: a 60 s push or a 30 s test run froze the whole core event loop (every chat, every other
// phone). Why detached: a timeout must kill the child's whole process group, otherwise `sh -c "sleep 999 & ..."`
// or a test runner's workers outlive the kill and keep running on the desktop.
import { spawn } from 'node:child_process';
import { scrubbedChildEnv } from '../../core/child-env.mjs';

/** Child environment: the server's own secrets (LLMIDE_*, provider keys) never reach a remote-driven process. */
export const hostChildEnv = (extra = {}) => scrubbedChildEnv({ GIT_TERMINAL_PROMPT: '0', ...extra });

function killTree(child) {
  if (process.platform === 'win32') { try { child.kill('SIGKILL'); } catch { /* already gone */ } return; }
  const sweep = () => {
    try { process.kill(-child.pid, 'SIGKILL'); return true; } catch { return false; }
  };
  if (!sweep()) { try { child.kill('SIGKILL'); } catch { /* already gone */ } return; }
  // A process forked at the instant of the first signal can miss it; sweep again until the group is empty (ESRCH).
  let tries = 0;
  const again = setInterval(() => { if (!sweep() || ++tries >= 10) clearInterval(again); }, 100);
  again.unref();
}

/**
 * @returns {Promise<{status:number|null, stdout:string, stderr:string, timedOut:boolean, overflow:boolean, error:Error|null}>}
 *   Never rejects: spawn failures come back as `error`.
 */
export function runCapture(cmd, args, { cwd, timeout, env, maxBytes = 1 << 20, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? hostChildEnv(), shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve({ status: null, stdout: '', stderr: '', timedOut: false, overflow: false, error }); return; }
    const out = []; const err = [];
    let outLen = 0; let errLen = 0;
    let timedOut = false; let overflow = false; let spawnError = null; let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, overflow, error: spawnError });
    };
    // After a kill, 'close' can be held off indefinitely by a setsid'd grandchild that inherited the pipes (the group
    // kill cannot reach it). Resolve on 'exit' plus a short grace instead and drop the pipes so nothing hangs.
    const GRACE_MS = 250;
    const abort = () => {
      killTree(child);
      child.once('exit', (code) => {
        const t = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, GRACE_MS);
        t.unref();
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode); }, GRACE_MS).unref();
      }
    };
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    child.stdout.on('data', (chunk) => {
      outLen += chunk.length;
      if (outLen > maxBytes) { if (!overflow) { overflow = true; abort(); } return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errLen += chunk.length;
      if (errLen > maxBytes) { if (!overflow) { overflow = true; abort(); } return; }
      err.push(chunk);
    });
    child.on('error', (error) => { spawnError = error; finish(null); });
    child.on('close', (code) => finish(code));
  });
}
