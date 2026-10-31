// `git` run inside a registered project for a bus task. The repository's own config and attributes are NOT trusted:
// a cloned repo can set `core.fsmonitor`, a textconv driver, `diff.external` or `core.hooksPath` and have `git status`,
// `git diff` or `git show` execute a program the moment we look at it. So every call here
//   - overrides those settings on the command line (a `-c` beats the repo config),
//   - passes --no-ext-diff and --no-textconv wherever a diff is produced,
//   - ignores the user's and the system's git config (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, GIT_CONFIG_NOSYSTEM=1),
//   - never prompts, never takes optional locks, never pages,
//   - runs in the directory the caller already resolved with realpath and checked (callers pass that, never the raw path).
// Still read-only by construction: only ls-files, diff --check, show and status are used.
import { minimalCliEnv } from '../../providers/providers.mjs';

export const GIT_HARDENING_ARGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.allow=never',
  '-c', 'diff.external=',
  '-c', 'core.pager=cat',
  '--no-optional-locks',
]);

export const gitEnv = () => minimalCliEnv({
  GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '',
});

/** argv for `git <args>` with the hardening prefix; diff-producing subcommands also get --no-ext-diff --no-textconv. */
export function gitArgv(args) {
  const [sub, ...rest] = args;
  const diffy = sub === 'show' || sub === 'diff' || sub === 'log';
  return [...GIT_HARDENING_ARGS, sub, ...(diffy ? ['--no-ext-diff', '--no-textconv'] : []), ...rest];
}

/** `spawn` is the runner's grouped spawn. Returns `{ code, stdout }`; throws whatever spawn throws. */
export function runGit(spawn, cwd, args) {
  return spawn('git', gitArgv(args), { cwd, env: gitEnv() });
}
