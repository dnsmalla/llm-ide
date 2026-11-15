// Full remote shell, gated by an explicit server opt-in (LLMIDE_ALLOW_REMOTE_SHELL=1) and a per-request confirm flag.
// This is the only place a Host API command is interpreted by a shell; everything else uses argv.
import { hostChildEnv, runCapture } from './exec-run.mjs';

export const OUTPUT_MAX = 262_144;
export const DEFAULT_TIMEOUT = 30_000;

export async function shellExec(root, { command, timeoutMs = DEFAULT_TIMEOUT }) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || command.includes('\0')) {
    throw Object.assign(new Error('The command is not valid.'), { code: 'invalid' });
  }
  const timeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT), DEFAULT_TIMEOUT);
  // The shell is opt-in, but it still must not inherit the core's own secrets (JWT/vault/approval keys, provider keys).
  const r = await runCapture('/bin/sh', ['-lc', command], { cwd: root, timeout, maxBytes: OUTPUT_MAX * 4, env: hostChildEnv() });
  return {
    exitCode: typeof r.status === 'number' ? r.status : -1,
    stdout: r.stdout.slice(0, OUTPUT_MAX),
    stderr: r.stderr.slice(0, OUTPUT_MAX),
    truncated: r.overflow || r.stdout.length > OUTPUT_MAX || r.stderr.length > OUTPUT_MAX,
    timedOut: r.timedOut,
  };
}
