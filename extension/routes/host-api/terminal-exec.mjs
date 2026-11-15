// Allowlisted, shell-free commands for the remote workspace. This is deliberately NOT a shell: argv is executed with
// spawn (never a shell), metacharacters and path escapes are refused, and only read-only git/inspection plus test
// runners are allowed. Arbitrary shell execution is a separate, separately-approved command (terminal.shell).
//
// Every tool takes a POSITIVE flag allowlist: a flag that can run a program (rg --pre, go test -exec, npm
// --script-shell, cargo --config) or reach secret files (rg --hidden/-u) is simply not in the list.
import { isDeniedPath } from '../../llm_agent/tools/handlers/repo-files.mjs';
import { hostChildEnv, runCapture } from './exec-run.mjs';

export const OUTPUT_MAX = 262_144;
export const DEFAULT_TIMEOUT = 30_000;

const SAFE = /^[A-Za-z0-9_@%+=:,./-]{1,500}$/;
const DENY_ARG = /(^|[\\/])(\.git|\.ssh|\.gnupg|\.aws|\.kube|\.docker)([\\/]|$)/i;
const BAD_ARG = /^(?:-c$|--exec-path(?:=.*)?|--git-dir(?:=.*)?|--work-tree(?:=.*)?|--upload-pack(?:=.*)?|--receive-pack(?:=.*)?|--output(?:=.*)?|--ext-diff(?:=.*)?|--no-index|-o(?:=.*)?)$/;
const GIT_SUB = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files']);
const NPM_SUB = new Set(['test']);
const PYTEST_FLAGS = new Set(['-q', '--quiet']);
// `git branch` may only list: -D/-m/-M/-c/-u/-f/--set-upstream-to all mutate refs or config.
const GIT_BRANCH_FLAGS = new Set(['-a', '-r', '--list', '-v', '-vv', '--all', '--remotes', '--verbose']);

const RG_BOOL = new Set(['-n', '-i', '-S', '-s', '-w', '-F', '-l', '-c', '-v', '-H', '-I', '-N', '--no-heading', '--heading',
  '--line-number', '--files', '--files-with-matches', '--count', '--ignore-case', '--smart-case', '--case-sensitive',
  '--fixed-strings', '--word-regexp', '--invert-match', '--no-messages']);
const RG_NUM = /^-[ABCm]$/;
const GO_BOOL = new Set(['-v', '-short', '-race', '-json']);
const GO_VALUED = /^-(?:run|count|timeout|skip)=[A-Za-z0-9_.,|^$()-]{1,100}$/;
const CARGO_BOOL = new Set(['-q', '--quiet', '--release', '--lib', '--workspace', '--all', '--no-fail-fast']);
const SWIFT_BOOL = new Set(['--parallel', '-q', '--quiet']);
const LS_FLAGS = /^-[1lahRtSF]+$/;
// Globs that keep secret files out of rg's results even when the path is not named: the same set isDeniedPath refuses.
const RG_EXCLUDES = ['!**/.env', '!**/.env.*', '!**/.npmrc', '!**/.netrc', '!**/id_rsa', '!**/id_ed25519', '!**/id_dsa', '!**/.pgpass',
  '!**/.bash_history', '!**/.zsh_history', '!**/*.pem', '!**/*.key', '!**/*.p12', '!**/*.pfx', '!**/*.keystore',
  '!**/.git/**', '!**/.ssh/**', '!**/.aws/**', '!**/.gnupg/**', '!**/.docker/**', '!**/.kube/**'];

const bad = (message) => Object.assign(new Error(message), { code: 'invalid' });
const notAllowedOption = () => bad('That option is not allowed.');

function checkArg(arg) {
  if (typeof arg !== 'string' || !SAFE.test(arg)) throw bad('That command contains an unsupported character.');
  if (arg.startsWith('/') || arg.split(/[\\/]/).includes('..')) throw bad('That path is not allowed.');
  if (DENY_ARG.test(arg)) throw bad('That path is not readable.');
  if (BAD_ARG.test(arg)) throw bad('That option is not allowed.');
}

/** Path-like operands go through the same denylist files.read uses; `rev:path` is checked on each side of the colon. */
function checkOperandPaths(args) {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    for (const part of arg.split(':')) {
      if (part && isDeniedPath(part)) throw bad('That path is not readable.');
    }
  }
}

/** Flags must be in `bool` or match `valued` (`--flag=value` form only); everything else after them is an operand. */
function checkFlags(args, { bool, valued, numeric }) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') throw notAllowedOption();
    if (!arg.startsWith('-')) continue;
    if (bool?.has(arg) || valued?.test(arg)) continue;
    if (numeric?.test(arg) && /^[0-9]{1,4}$/.test(args[i + 1] ?? '')) { i++; continue; }
    throw notAllowedOption();
  }
}

/** Validate one argv, or throw {code:'invalid'}. */
export function checkArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 20) throw bad('Provide a command with at most 20 arguments.');
  argv.forEach(checkArg);
  const [cmd, ...args] = argv;
  if (cmd === 'pwd') { if (args.length) throw bad('pwd takes no arguments.'); return; }
  if (cmd === 'ls') { checkFlags(args, { valued: LS_FLAGS }); checkOperandPaths(args); return; }
  if (cmd === 'rg') { checkFlags(args, { bool: RG_BOOL, numeric: RG_NUM }); checkOperandPaths(args); return; }
  if (cmd === 'git') {
    if (!GIT_SUB.has(args[0])) throw bad('Only git status, diff, log, show, branch, rev-parse and ls-files are allowed.');
    if (args[0] === 'branch' && args.slice(1).some((a) => !GIT_BRANCH_FLAGS.has(a))) throw bad('git branch only lists branches.');
    checkOperandPaths(args.slice(1));
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
    // No extra arguments: `npm test --script-shell=python3` or `-- <args>` would run what the caller names.
    const exact = (args.length === 1 && NPM_SUB.has(args[0])) || (args.length === 2 && args[0] === 'run' && args[1] === 'test');
    if (!exact) throw bad('Only npm test is allowed.');
    return;
  }
  if (cmd === 'cargo') { if (args[0] !== 'test') throw bad('Only cargo test is allowed.'); checkFlags(args.slice(1), { bool: CARGO_BOOL }); return; }
  if (cmd === 'go') { if (args[0] !== 'test') throw bad('Only go test is allowed.'); checkFlags(args.slice(1), { bool: GO_BOOL, valued: GO_VALUED }); return; }
  if (cmd === 'swift') { if (args[0] !== 'test') throw bad('Only swift test is allowed.'); checkFlags(args.slice(1), { bool: SWIFT_BOOL }); return; }
  throw bad('That command is not on the remote allowlist.');
}

export async function terminalExec(root, { argv, timeoutMs = DEFAULT_TIMEOUT }) {
  checkArgv(argv);
  const timeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT), DEFAULT_TIMEOUT);
  const args = argv[0] === 'rg' ? ['--no-config', ...RG_EXCLUDES.flatMap((g) => ['--glob', g]), ...argv.slice(1)] : argv.slice(1);
  const r = await runCapture(argv[0], args, {
    cwd: root, timeout, maxBytes: OUTPUT_MAX * 4,
    env: hostChildEnv({ GIT_PAGER: 'cat', PAGER: 'cat', RIPGREP_CONFIG_PATH: '' }),
  });
  return {
    exitCode: typeof r.status === 'number' ? r.status : null,
    stdout: r.stdout.slice(0, OUTPUT_MAX),
    stderr: r.stderr.slice(0, OUTPUT_MAX),
    truncated: r.overflow || r.stdout.length > OUTPUT_MAX || r.stderr.length > OUTPUT_MAX,
    timedOut: r.timedOut,
  };
}
