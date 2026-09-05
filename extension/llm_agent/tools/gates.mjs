import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { isDeniedPath, isTooBroadRoot, isWithinRoots } from '../runtime/handlers/repo-files.mjs';

//
// Safety classification for 'act'-kind registry entries (tools/registry.mjs),
// consulted identically by both engines (spec §7). Three tiers:
//   'blocked' — never runs, not overridable by always-allow (kb/tool-approvals.mjs)
//   'auto'    — runs immediately, no prompt
//   'prompt'  — parks an approval via sdk/decisions.mjs on both engines
//
// BLOCKED_PATTERNS moved here verbatim from the old run-bash.mjs (same
// regexes, same behavior) — it now also gates whether always-allow can ever
// apply, which run-bash.mjs alone couldn't express.
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/,
  /\bsudo\b/,
  /\bsu\s+-/,
  /\bmkfs\b/,
  />\s*\/dev\/(s?d[a-z]|nvme)/,
  /\bdd\s+.*of=\/dev\//,
];

// Conservative, read-only-flavored prefixes. Unmatched commands fall through
// to 'prompt' — never silently 'auto' just because nothing matched.
//
// CRITICAL: these are PREFIX matches against an UNPARSED string that is
// eventually handed to `/bin/sh -c`. A prefix says nothing about the rest of
// the string, so `git status && rm -rf ~/projects` would match `^git\s+status`
// and run its destructive tail unattended. SHELL_CONTROL_RE below is the
// structural fix — see runBashGate.
const AUTO_SAFE_PATTERNS = [
  /^git\s+(status|diff|log)\b/,
  /^ls\b/,
  /^cat\b/,
  /^(grep|rg)\b/,
];

// Test runners look read-only but execute the repo's OWN code — whatever
// `scripts.test` or the test files say. In a repo the user merely opened
// (cloned to look at, handed over in a ticket) that is unprompted arbitrary
// code execution. So these reach 'auto' only when the command runs inside a
// DB-trusted indexed repo the user deliberately registered (`trustedRoots`,
// from repo-files.mjs buildTrustedRoots) — never the open workspace on its
// own, and never without a resolved cwd. Deviation from the registry design
// spec §7, which listed them as unconditionally auto-safe (2026-09-05 audit).
const TEST_RUNNER_PATTERNS = [
  /^(npm|node|swift)\s+test\b/,
  /^node\s+--test\b/,
];

function runsInTrustedRepo(cwd, trustedRoots) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  return isWithinRoots(cwd, trustedRoots);
}

// Any shell metacharacter/control syntax that lets one command string carry a
// SECOND command (or expand into one, or redirect into a file): `;` `&&` `||`
// `|` `&`, newline, backtick, `$(`, `>`/`>>`, `<`. `&&`/`||`/`>>` are covered
// by their single-character forms. A command containing ANY of these is not a
// single auto-safe invocation any more — it is a compound program whose tail
// the auto-safe prefix never inspected — so it can never qualify for the
// 'auto' tier, no matter how safe its first word looks. This is the structural
// fix for the bug class the Task 5 `find ... -delete` bypass was one instance
// of (that fix removed one pattern; this addresses the cause).
const SHELL_CONTROL_RE = /[;&|`<>\n\r]|\$\(/;

// Expansion syntax — `$` (parameter substitution), `*` `?` `[` (globs), `{`
// (brace expansion) — makes the shell open a path we never inspected, so
// `cat ~/.a*/credentials` or `cat $HOME/.aws/x` would slip past the
// sensitive-path check below while reading the same file. Only UNQUOTED
// occurrences expand (`$` also inside double quotes), which is what keeps
// `grep -rn "handler[0-9]*" src` on the auto tier: regex metacharacters inside
// quotes are literal to /bin/sh. An unterminated quote is unparseable and
// therefore not auto-safe.
function hasUnquotedExpansion(cmd) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '$') return true;
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if ('*?[{'.includes(ch)) return true;
  }
  return inSingle || inDouble;
}

// The shell strips quotes (and, on POSIX, backslash escapes) before it opens a
// file, so the gate compares the string the shell will: `~/".aws"/x` and
// `~/.a\ws/x` are both `~/.aws/x`. On win32 `\` is the separator and is kept.
function shellLiteral(token) {
  const unquoted = token.replace(/['"]/g, '');
  return process.platform === 'win32' ? unquoted : unquoted.replace(/\\/g, '');
}

// A path under $HOME whose first segment is a dotdir/dotfile (~/.config,
// ~/.zshrc, ~/.claude) or ~/Library holds credentials for tools the denylist
// does not know by name (gh hosts.yml, gcloud, Keychains, app tokens), and a
// recursive grep rooted there reads them all. Case-insensitive like the
// denylist.
function isHomePrivateArea(abs) {
  const rel = path.relative(homedir().toLowerCase(), abs.toLowerCase());
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return first.startsWith('.') || first === 'library';
}

// Sensitive = on the denylist, OR a root broad enough that a recursive
// `grep -r` / `rg` / `ls -R` would walk INTO one (`~`, `/`, anything
// isTooBroadRoot rejects — the trailing separator is trimmed first so
// `~//` cannot dodge the `=== home` compare), OR a private area of $HOME.
function isSensitiveAbsolute(abs) {
  const norm = path.normalize(abs).replace(/[\\/]+$/, '') || path.sep;
  return isDeniedPath(norm) || isTooBroadRoot(norm) || isHomePrivateArea(norm);
}

function hasDotDot(p) {
  return p.split(/[\\/]/).includes('..');
}

// True when the cwd or any token of a (quote-free, expansion-free) command
// names a sensitive path. Relative tokens are resolved against `cwd` when the
// caller knows it (both engines do), so `cat ../package.json` in a monorepo
// stays auto while `grep -r AKIA ..` from ~/proj resolves to ~ and prompts.
// Without a cwd, `..` climbs out of somewhere we cannot see and prompts.
// `~name` is another user's home, which we cannot resolve either.
//
// Known limit: this is a string check. A symlink inside the workspace that
// points at ~/.aws/credentials is invisible here; the read-file tool's
// realpath containment is the layer that catches that, not the bash gate.
function namesSensitivePath(cmd, cwd) {
  let root = null;
  if (typeof cwd === 'string' && cwd) {
    // A relative cwd cannot be rooted here (the registry gate has no ctx), and
    // `{cwd: ".config/gh"}` relocates every token into a directory we never
    // saw — same rule as `~name`: unresolvable means prompt. Callers that
    // know the workspace resolve first and pass an absolute cwd.
    if (!path.isAbsolute(cwd)) return true;
    if (isSensitiveAbsolute(cwd)) return true;
    root = cwd;
  }
  return cmd.split(/\s+/).some((token) => {
    const bare = shellLiteral(token);
    if (!bare) return false;
    if (isDeniedPath(bare)) return true;
    if (bare.startsWith('~')) {
      if (!bare.startsWith('~/')) return true;
      return isSensitiveAbsolute(path.join(homedir(), bare.slice(2)));
    }
    if (path.isAbsolute(bare)) return isSensitiveAbsolute(bare);
    if (root) return isSensitiveAbsolute(path.resolve(root, bare));
    return hasDotDot(bare);
  });
}

/**
 * Classify a bash command for the approval ladder.
 *
 * @param {string} command  The raw string that will reach `/bin/sh -c`.
 * @param {string} [cwd]    The directory the command will run in, when the
 *   caller knows it (the SDK's cwd on v2; the resolved run-bash cwd on
 *   legacy). Relative path tokens are judged against it; omit it and `..`
 *   tokens fall back to 'prompt'.
 * @param {object} [opts]
 * @param {string[]} [opts.trustedRoots]  Canonical DB-trusted repo roots
 *   (buildTrustedRoots). Test runners are auto only when `cwd` is inside one.
 * @returns {'blocked'|'auto'|'prompt'}
 */
export function runBashGate(command, cwd, { trustedRoots } = {}) {
  const cmd = typeof command === 'string' ? command : '';
  // Blocklist first, unconditionally — a blocked command stays blocked
  // regardless of anything below (spec §7).
  if (BLOCKED_PATTERNS.some((re) => re.test(cmd))) return 'blocked';
  // Compound/expanding commands are never auto-safe. Checked BEFORE the
  // allowlist so a matching prefix cannot smuggle a tail past it.
  if (SHELL_CONTROL_RE.test(cmd)) return 'prompt';
  const trimmed = cmd.trim();
  const isTestRunner = TEST_RUNNER_PATTERNS.some((re) => re.test(trimmed));
  if (!isTestRunner && !AUTO_SAFE_PATTERNS.some((re) => re.test(trimmed))) return 'prompt';
  if (isTestRunner && !runsInTrustedRepo(cwd, trustedRoots)) return 'prompt';
  // An auto-safe prefix says nothing about WHICH file it reads. Refuse the
  // auto tier when the command could expand into a path we never saw, or
  // names a sensitive path / over-broad root outright, so
  // `cat ~/.aws/credentials` cannot run unattended. 'prompt', not 'blocked':
  // token parsing of a shell string is heuristic, and a false positive must
  // stay approvable by the user.
  if (hasUnquotedExpansion(cmd) || namesSensitivePath(cmd, cwd)) return 'prompt';
  return 'auto';
}

export function autoGate() {
  return 'auto';
}

/**
 * Containment gate for native Edit/Write targets on the v2 engine.
 *
 * 'prompt'  — the target resolves inside one of `roots` (the approval ladder
 *             continues: always-allow, then a parked ToolApproval).
 * 'blocked' — everything else. Like a blocked bash command, this tier is
 *             never promptable and never always-allowable: symlink and `..`
 *             escapes must not be one careless click away.
 *
 * The file itself may not exist yet (Write creates files), so containment is
 * checked on the nearest EXISTING ancestor's realpath plus the remaining
 * lexical suffix — a symlink anywhere in the existing part cannot escape.
 */
export function writePathGate(filePath, roots) {
  if (typeof filePath !== 'string' || !filePath) return 'blocked';
  if (!Array.isArray(roots) || roots.length === 0) return 'blocked';
  const primary = roots[0];
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(primary, filePath);
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return 'blocked';
    existing = parent;
  }
  let resolved;
  try {
    const real = fs.realpathSync(existing);
    const suffix = path.relative(existing, abs);
    resolved = suffix ? path.join(real, suffix) : real;
  } catch {
    return 'blocked';
  }
  // A sensitive-path hit is final regardless of containment — the same
  // denylist the read path applies (repo-files.mjs's isDeniedPath), so an
  // approved (or always-allowed) Write/Edit can't reach .git/hooks, .env,
  // private keys, etc. just because they happen to sit inside an allowed
  // root (final whole-branch review, I1).
  if (isDeniedPath(resolved)) return 'blocked';
  const inside = (root) => {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { return false; }
    return resolved === realRoot || resolved.startsWith(realRoot + path.sep);
  };
  return roots.some(inside) ? 'prompt' : 'blocked';
}
