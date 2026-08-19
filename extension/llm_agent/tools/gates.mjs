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
const AUTO_SAFE_PATTERNS = [
  /^git\s+(status|diff|log)\b/,
  /^ls\b/,
  /^cat\b/,
  /^(grep|rg)\b/,
  /^find\b.*(-type\s+f|-name)/, // read-only find flags only
  /^(npm|node|swift)\s+test\b/,
  /^node\s+--test\b/,
];

export function runBashGate(command) {
  const cmd = typeof command === 'string' ? command : '';
  if (BLOCKED_PATTERNS.some((re) => re.test(cmd))) return 'blocked';
  if (AUTO_SAFE_PATTERNS.some((re) => re.test(cmd.trim()))) return 'auto';
  return 'prompt';
}

export function autoGate() {
  return 'auto';
}
