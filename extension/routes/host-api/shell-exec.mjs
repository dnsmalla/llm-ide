// Full remote shell, gated by an explicit server opt-in (LLMIDE_ALLOW_REMOTE_SHELL=1) and a per-request confirm flag.
// This is the only place a Host API command is interpreted by a shell; everything else uses argv.
import { spawnSync } from 'node:child_process';

export const OUTPUT_MAX = 262_144;
export const DEFAULT_TIMEOUT = 30_000;

export function shellExec(root, { command, timeoutMs = DEFAULT_TIMEOUT }) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || command.includes('\0')) {
    throw Object.assign(new Error('The command is not valid.'), { code: 'invalid' });
  }
  const timeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT), DEFAULT_TIMEOUT);
  const r = spawnSync('/bin/sh', ['-lc', command], {
    cwd: root, timeout, maxBuffer: OUTPUT_MAX * 4, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, shell: false,
  });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  return {
    exitCode: typeof r.status === 'number' ? r.status : -1,
    stdout: stdout.slice(0, OUTPUT_MAX),
    stderr: stderr.slice(0, OUTPUT_MAX),
    truncated: stdout.length > OUTPUT_MAX || stderr.length > OUTPUT_MAX,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}
