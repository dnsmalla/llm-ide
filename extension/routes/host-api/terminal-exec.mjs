// Allowlisted, shell-free commands for the remote workspace. This is deliberately NOT a shell: argv is executed with
// execFile/spawnSync, metacharacters and path escapes are refused, and only read-only git/inspection plus test runners
// are allowed. Arbitrary shell execution is a later, separately-approved phase.
import { spawnSync } from 'node:child_process';

export const OUTPUT_MAX = 262_144;
export const DEFAULT_TIMEOUT = 30_000;

const SAFE = /^[A-Za-z0-9_@%+=:,./-]{1,500}$/;
const DENY_ARG = /(^|[\\/])(\.git|\.ssh|\.gnupg|\.aws|\.kube|\.docker)([\\/]|$)/i;
const BAD_ARG = /^(?:-c$|--exec-path|--git-dir|--work-tree|--upload-pack|--receive-pack|--output|--ext-diff|--no-index|-o)$/;
const GIT_SUB = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files']);
const NPM_SUB = new Set(['test']);
const PYTEST_FLAGS = new Set(['-q', '--quiet']);

const bad = (message) => Object.assign(new Error(message), { code: 'invalid' });

function checkArg(arg) {
  if (typeof arg !== 'string' || !SAFE.test(arg)) throw bad('That command contains an unsupported character.');
  if (arg.startsWith('/') || arg.split(/[\\/]/).includes('..')) throw bad('That path is not allowed.');
  if (DENY_ARG.test(arg)) throw bad('That path is not readable.');
  if (BAD_ARG.test(arg)) throw bad('That option is not allowed.');
}

/** Validate one argv, or throw {code:'invalid'}. */
export function checkArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 20) throw bad('Provide a command with at most 20 arguments.');
  argv.forEach(checkArg);
  const [cmd, ...args] = argv;
  if (cmd === 'pwd') { if (args.length) throw bad('pwd takes no arguments.'); return; }
  if (cmd === 'ls' || cmd === 'rg') return;
  if (cmd === 'git') {
    if (!GIT_SUB.has(args[0])) throw bad('Only git status, diff, log, show, branch, rev-parse and ls-files are allowed.');
    return;
  }
  if (cmd === 'pytest') {
    if (args.some((a) => !PYTEST_FLAGS.has(a))) throw bad('pytest only accepts -q.');
    return;
  }
  if (cmd === 'python3') {
    if (args[0] !== '-m' || args[1] !== 'pytest' || args.slice(2).some((a) => !PYTEST_FLAGS.has(a))) throw bad('Only python3 -m pytest is allowed.');
    return;
  }
  if (cmd === 'npm') {
    if (!NPM_SUB.has(args[0]) && !(args[0] === 'run' && args[1] === 'test')) throw bad('Only npm test is allowed.');
    return;
  }
  if (cmd === 'cargo' || cmd === 'go') { if (args[0] !== 'test') throw bad(`Only ${cmd} test is allowed.`); return; }
  if (cmd === 'swift') { if (args[0] !== 'test') throw bad('Only swift test is allowed.'); return; }
  throw bad('That command is not on the remote allowlist.');
}

export function terminalExec(root, { argv, timeoutMs = DEFAULT_TIMEOUT }) {
  checkArgv(argv);
  const timeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT), DEFAULT_TIMEOUT);
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: root, timeout, maxBuffer: OUTPUT_MAX * 4, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' }, shell: false,
  });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  const truncated = stdout.length > OUTPUT_MAX || stderr.length > OUTPUT_MAX;
  return {
    exitCode: typeof r.status === 'number' ? r.status : null,
    stdout: stdout.slice(0, OUTPUT_MAX),
    stderr: stderr.slice(0, OUTPUT_MAX),
    truncated,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}
