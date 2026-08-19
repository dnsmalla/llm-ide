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
  /^(npm|node|swift)\s+test\b/,
  /^node\s+--test\b/,
];

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

export function runBashGate(command) {
  const cmd = typeof command === 'string' ? command : '';
  // Blocklist first, unconditionally — a blocked command stays blocked
  // regardless of anything below (spec §7).
  if (BLOCKED_PATTERNS.some((re) => re.test(cmd))) return 'blocked';
  // Compound/expanding commands are never auto-safe. Checked BEFORE the
  // allowlist so a matching prefix cannot smuggle a tail past it.
  if (SHELL_CONTROL_RE.test(cmd)) return 'prompt';
  if (AUTO_SAFE_PATTERNS.some((re) => re.test(cmd.trim()))) return 'auto';
  return 'prompt';
}

export function autoGate() {
  return 'auto';
}
