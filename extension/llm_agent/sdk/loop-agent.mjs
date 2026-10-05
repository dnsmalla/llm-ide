// The Loop's headless, confined agent run — the engine behind
// POST /kb/loop/agent-run (routes/loop-agent.mjs).
//
// Why this exists: the Mac Loop's skill stages, stage repairs and fault
// repairs used to call POST /code-assist with no agentContext, which takes
// that route's tool-less legacy path (`runClaude` with no tools). No Loop
// repair or skill stage could edit a single file, and the repo root reached
// the model only as prompt text, so a worktree run could not be targeted.
//
// The ruling this module implements: a Loop agent run is NON-INTERACTIVE and
// CONFINED.
//   - File tools only — Read, Glob, Grep, Edit, Write — rooted at the run's
//     git root (the worktree when one is in use). No shell, no network, no
//     subagents, no MCP servers, no plugins, no operator settings.
//   - Nothing ever waits for a human: a tool call the confinement refuses is
//     DENIED, never parked as an approval. The Loop verifies by running its
//     own stages afterwards.
//
// Engine choice — the Agent SDK, not the legacy CLI agent loop. The legacy
// loop (llm_agent/runtime) has no file-edit tool at all (writes go through the
// attach+confirm flow; its only mutating tool is run-bash), so it could only
// ever "edit" through a shell, which the ruling forbids. The SDK has exactly
// the needed surface: a `tools` allowlist that removes everything else from
// the model's context, `cwd`, a `canUseTool` callback, and PreToolUse /
// PostToolUse hooks. Confinement is enforced twice — a PreToolUse hook (runs
// for EVERY tool call, including the reads the SDK auto-allows inside cwd)
// and canUseTool (the permission prompt, which here decides instead of
// asking) — with the same gate as the chat engine's native Edit/Write
// (tools/gates.mjs writePathGate: realpath of the nearest existing ancestor,
// so a symlink pointing out of the repo is refused, plus the secret-path
// denylist).

import fs from 'node:fs';
import path from 'node:path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { handleFindCode, STALE_HINT } from '../runtime/handlers/find-code.mjs';
import { resolveRepoScope } from '../../kb/db.mjs';
import {
  AGENT_SDK_PROVIDER, resolveAgentEngineAuth, resolveAnthropicKey, agentSdkHomeFor, normalizeModelUsage,
} from './engine.mjs';
import { writePathGate } from '../tools/gates.mjs';
import {
  buildTrustedRoots, isDeniedPath, isTooBroadRoot, isWithinRoots,
} from '../runtime/handlers/repo-files.mjs';
import { readSkillInstructions } from '../skills/index.mjs';
import { buildLoopSkillsText } from '../../core/prompt-framing.mjs';
import { neutralizePromptFences } from '../../core/utils.mjs';
import { resolveLanguage } from '../../providers/runtime.mjs';
import { sdkSubprocessEnv } from './subprocess-env.mjs';
import { withToolOutputCap } from './tool-output-cap.mjs';
import { createToolAccounting } from './tool-accounting.mjs';
import { createProgressGuard } from './loop-progress.mjs';

// The only built-ins a Loop run may see. Everything else — Bash, WebFetch,
// WebSearch, Agent/Task, AskUserQuestion, NotebookEdit, Skill, … — is absent
// from the model's context entirely (SDK `tools` is an allowlist).
export const LOOP_AGENT_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
// The ONE MCP tool a Loop run gets: read-only code search over the user's own
// graph, from an in-process server (never a user MCP server). Why: Loop steps
// were ~87% of context tokens (2026-09-26..10-05), and with only Grep/Read the
// agent found code a grep and a whole-file read at a time, each hop re-reading
// the whole context. Same server name as chat, so the model sees the same name.
export const LOOP_FIND_CODE_TOOL = 'mcp__llmide__find-code';
const LOOP_AGENT_TOOL_SET = new Set([...LOOP_AGENT_TOOLS, LOOP_FIND_CODE_TOOL]);
const WRITE_TOOLS = new Set(['Edit', 'Write']);
// Belt to the `tools` braces: removed from context even if a future SDK
// default re-added one. MCP is NOT wildcard-disallowed any more (a deny would
// also hide find-code); every other MCP name is refused by loopToolRefusal,
// and the only server mounted is the one-tool server below.
const LOOP_AGENT_DISALLOWED = Object.freeze([
  'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Agent', 'Task',
  'AskUserQuestion', 'NotebookEdit', 'Skill',
]);

// A Loop step is one focused edit, not a chat — but a repair across a few
// files legitimately takes a few dozen tool calls.
const MAX_TURNS = 60;
// The composed Loop message (goal + failure output + instructions) is small;
// this only bounds a pathological one.
export const MAX_LOOP_MESSAGE_CHARS = 200_000;

// Worktree parents the Mac's LoopWorktreeManager creates (sibling layout, and
// the split project layout's `<project>/system/loop-worktrees`).
const WORKTREE_SEGMENTS = new Set(['.llmide-loop-worktrees', 'loop-worktrees']);

/**
 * Validate a client-supplied Loop repo root against what the user may write.
 *
 * Accepted:
 *   1. an existing directory at or below a root on the user's repo
 *      allow-list (`user_repos`, DB-trusted — never the client), or
 *   2. a linked git worktree of such a root, living under a Loop worktree
 *      directory (`.llmide-loop-worktrees/` or `loop-worktrees/`): its `.git`
 *      FILE must point into `<allowed root>/.git/worktrees/<name>`, and that
 *      entry's own `gitdir` back-reference must point at this directory — the
 *      pairing git itself maintains, so a stray `.git` file cannot claim a
 *      repo it does not belong to.
 *
 * Refused: non-string, relative, `..`-laden, missing, not a directory, too
 * broad (/, $HOME, /Users…), or outside both of the above. Symlinks are
 * resolved first, so a link inside an allowed repo that points elsewhere is
 * judged by where it lands.
 *
 * @returns {{ ok: true, root: string } | { ok: false, reason: string }}
 */
export function validateLoopRepoRoot(userId, repoRoot, { trustedRoots = buildTrustedRoots } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) return { ok: false, reason: 'repoRoot is required' };
  if (!path.isAbsolute(repoRoot)) return { ok: false, reason: 'repoRoot must be an absolute path' };
  if (repoRoot.split(/[/\\]/).includes('..')) return { ok: false, reason: 'repoRoot must not contain ".."' };
  let real;
  try { real = fs.realpathSync(repoRoot); } catch { return { ok: false, reason: 'repoRoot does not exist' }; }
  try {
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: 'repoRoot is not a directory' };
  } catch { return { ok: false, reason: 'repoRoot does not exist' }; }
  if (isTooBroadRoot(real)) return { ok: false, reason: 'repoRoot is too broad' };

  let trusted = [];
  try { trusted = trustedRoots(userId) || []; } catch { trusted = []; }
  if (isWithinRoots(real, trusted)) return { ok: true, root: real };
  if (isLoopWorktreeOf(real, trusted)) return { ok: true, root: real };
  return { ok: false, reason: 'repoRoot is not in your repo allow-list' };
}

function isLoopWorktreeOf(real, trusted) {
  if (!trusted.length) return false;
  if (!real.split(path.sep).some((s) => WORKTREE_SEGMENTS.has(s))) return false;
  const dotGit = path.join(real, '.git');
  let gitFile;
  try {
    if (!fs.lstatSync(dotGit).isFile()) return false;
    gitFile = fs.readFileSync(dotGit, 'utf8');
  } catch { return false; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
  if (!m) return false;
  const entry = path.isAbsolute(m[1]) ? m[1] : path.resolve(real, m[1]);
  // The entry must be `<trusted>/.git/worktrees/<name>` — exactly one level
  // under a trusted repo's worktrees directory.
  const worktreesDirs = trusted.map((t) => path.join(t, '.git', 'worktrees'));
  let entryReal;
  try { entryReal = fs.realpathSync(entry); } catch { return false; }
  const parentOk = worktreesDirs.some((dir) => {
    let dirReal;
    try { dirReal = fs.realpathSync(dir); } catch { return false; }
    return samePath(path.dirname(entryReal), dirReal);
  });
  if (!parentOk) return false;
  // Git's back-reference: <entry>/gitdir names this worktree's `.git` file.
  let back;
  try { back = fs.readFileSync(path.join(entryReal, 'gitdir'), 'utf8').trim(); } catch { return false; }
  if (!back) return false;
  const backAbs = path.isAbsolute(back) ? back : path.resolve(entryReal, back);
  let backReal;
  try { backReal = fs.realpathSync(backAbs); } catch { return false; }
  return samePath(backReal, fs.realpathSync(dotGit));
}

// A project's notes directory. In the split project layout it sits at
// `<project>/llm-doc` while the run's git root is `<project>/code/<repo>` (or
// a Loop worktree under `<project>/system/loop-worktrees/`), so a Plan/Docs
// skill stage confined to the git root alone could not read or write a plan.
export const MAX_LOOP_EXTRA_ROOTS = 4;
const EXTRA_ROOT_NAME = 'llm-doc';
const EXTRA_ROOT_MAX_DEPTH = 3;

/**
 * Validate the extra roots a Loop run may also read and edit. Each must be an
 * existing directory named `llm-doc` whose parent is an LLM-IDE project
 * (`system/project.json` exists) AND whose parent is `repoRoot` itself or an
 * ancestor of it at most 3 levels up. Symlinks are resolved first.
 * `repoRoot` must already be the validated (real) root.
 *
 * @returns {{ ok: true, roots: string[] } | { ok: false, reason: string }}
 */
export function validateLoopExtraRoots(extraRoots, repoRoot) {
  if (extraRoots == null) return { ok: true, roots: [] };
  if (!Array.isArray(extraRoots)) return { ok: false, reason: 'extraRoots must be an array of absolute paths' };
  if (extraRoots.length > MAX_LOOP_EXTRA_ROOTS) {
    return { ok: false, reason: `extraRoots may name at most ${MAX_LOOP_EXTRA_ROOTS} directories` };
  }
  const roots = [];
  for (const raw of extraRoots) {
    const label = String(raw);
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.split(/[/\\]/).includes('..')) {
      return { ok: false, reason: `extra root ${label} must be an absolute path without ".."` };
    }
    let real;
    try { real = fs.realpathSync(raw); } catch { return { ok: false, reason: `extra root ${label} does not exist` }; }
    try {
      if (!fs.statSync(real).isDirectory()) return { ok: false, reason: `extra root ${label} is not a directory` };
    } catch { return { ok: false, reason: `extra root ${label} does not exist` }; }
    if (path.basename(real) !== EXTRA_ROOT_NAME) {
      return { ok: false, reason: `extra root ${label} is not a project ${EXTRA_ROOT_NAME} directory` };
    }
    const project = path.dirname(real);
    if (!fs.existsSync(path.join(project, 'system', 'project.json'))) {
      return { ok: false, reason: `extra root ${label} is not inside an LLM-IDE project` };
    }
    const rel = path.relative(project, repoRoot);
    const depth = rel === '' ? 0 : rel.split(path.sep).length;
    if (rel.startsWith('..') || path.isAbsolute(rel) || depth > EXTRA_ROOT_MAX_DEPTH) {
      return { ok: false, reason: `extra root ${label} does not belong to the project of ${repoRoot}` };
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return { ok: true, roots };
}

function samePath(a, b) {
  const ci = process.platform === 'darwin' || process.platform === 'win32';
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Glob patterns are resolved against `path` (or cwd); an absolute or
// `..`-climbing pattern would reach past it.
function patternEscapes(pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  if (pattern.startsWith('/') || pattern.startsWith('~') || /^[A-Za-z]:[\\/]/.test(pattern)) return true;
  return pattern.split(/[/\\]/).includes('..');
}

// One level of `{a,b}` alternation — enough to see `*.{pem,key}`.
function expandBraces(token) {
  const m = /\{([^{}]*)\}/.exec(token);
  if (!m) return [token];
  return m[1].split(',').map((alt) => token.slice(0, m.index) + alt + token.slice(m.index + m[0].length));
}

/**
 * True when a Glob pattern / Grep `glob` names a secret path the Loop may
 * never read — the same denylist Read/Edit/Write apply (repo-files.mjs
 * isDeniedPath): `.env*`, `*.pem`/`.key`/…, `id_rsa`, `.ssh/`, `.git/`, ….
 * Negated tokens (`!…`) exclude files, so they never count.
 */
export function patternTargetsSecret(pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  for (const token of pattern.split(/[\s,]+(?![^{]*\})/).filter(Boolean)) {
    if (token.startsWith('!')) continue;
    for (const alt of expandBraces(token)) {
      // Drop glob metacharacters so `.env*` reads as `.env`, `*.p[e]m` as `.pem`.
      const literal = alt.replace(/[*?[\]{}]/g, '');
      if (literal && isDeniedPath(path.join(path.sep, literal))) return true;
    }
  }
  return false;
}

// `[pP][eE][mM]` — ripgrep globs are case-sensitive, the denylist is not.
const anyCase = (s) => s.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/**
 * Negative globs Grep always carries in a Loop run, so a content search can
 * never print a secret file's lines (the denylist in rg --glob form). The CLI
 * splits Grep's `glob` on whitespace/commas into one `--glob` each, and a
 * later negation wins in ripgrep.
 */
export const LOOP_GREP_SECRET_EXCLUSIONS = Object.freeze([
  ...['.env', '.env.*', '.npmrc', '.netrc', '.pgpass', '.bash_history', '.zsh_history',
    'id_rsa', 'id_ed25519', 'id_dsa'].map((b) => `!**/${anyCase(b)}`),
  ...['.pem', '.key', '.p12', '.pfx', '.keystore'].map((e) => `!**/*${anyCase(e)}`),
  ...['.git', '.ssh', '.aws', '.gnupg', '.docker', '.kube'].map((d) => `!**/${anyCase(d)}/**`),
]);

/** Grep's input with the secret exclusions appended to its `glob`. */
export function withSecretExclusions(input) {
  const own = typeof input?.glob === 'string' ? input.glob.trim() : '';
  return { ...(input || {}), glob: [own, ...LOOP_GREP_SECRET_EXCLUSIONS].filter(Boolean).join(' ') };
}

/**
 * Why `toolName(input)` may not run in a run confined to `roots` (the repo
 * root first, then any accepted extra roots; a single string is accepted),
 * or null when it may. The single confinement rule both the PreToolUse hook
 * and canUseTool apply.
 */
export function loopToolRefusal(toolName, input, roots) {
  const allowed = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  const where = allowed.join(', ');
  if (!LOOP_AGENT_TOOL_SET.has(toolName)) {
    return `${toolName} is not available in a Loop run (file tools only: ${LOOP_AGENT_TOOLS.join(', ')}, plus ${LOOP_FIND_CODE_TOOL}).`;
  }
  // Read-only and path-free: it returns names and repo-relative paths, and
  // every follow-up Read is judged by the rules below.
  if (toolName === LOOP_FIND_CODE_TOOL) return null;
  const inside = (p) => writePathGate(p, allowed) !== 'blocked';
  if (toolName === 'Read' || WRITE_TOOLS.has(toolName)) {
    if (!inside(input?.file_path)) {
      return `${toolName} refused: ${String(input?.file_path ?? '(no path)')} is outside the Loop's repository ${where} (or is a protected secret path).`;
    }
    return null;
  }
  // Glob / Grep: an explicit search root must stay inside (and not be a
  // secret path), and the file pattern must neither climb out nor name a
  // secret file.
  if (input?.path != null && input.path !== '' && !inside(input.path)) {
    return `${toolName} refused: ${String(input.path)} is outside the Loop's repository ${where} (or is a protected secret path).`;
  }
  const pattern = toolName === 'Glob' ? input?.pattern : input?.glob;
  if (patternEscapes(pattern)) {
    return `${toolName} refused: the pattern ${String(pattern)} reaches outside the Loop's repository.`;
  }
  if (patternTargetsSecret(pattern)) {
    return `${toolName} refused: the pattern ${String(pattern)} targets a protected secret path.`;
  }
  return null;
}

// The absolute (real) path of `filePath` when it lies inside one of the extra
// roots, else null.
function extraRootPath(extraRoots, filePath) {
  if (!extraRoots.length || typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  let resolved = path.normalize(filePath);
  try { resolved = fs.realpathSync(resolved); } catch { /* judge the spelling */ }
  return extraRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep)) ? resolved : null;
}

function repoRelative(root, filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(root, filePath);
  let resolved = abs;
  try { resolved = fs.realpathSync(abs); } catch { /* deleted/renamed — judge the spelling */ }
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * The repo whose code graph a Loop run should search. A Loop worktree has no
 * graph of its own — the graph is keyed by the repo it was cut from — so a
 * worktree (its `.git` FILE points at `<repo>/.git/worktrees/<name>`) maps to
 * `<repo>`; anything else maps to itself. Only narrows which of the user's
 * own graphs are searched; it never widens what may be read.
 */
export function graphScopeRoot(root) {
  try {
    const dotGit = path.join(root, '.git');
    if (!fs.lstatSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return root;
    const entry = fs.realpathSync(path.isAbsolute(m[1]) ? m[1] : path.resolve(root, m[1]));
    const worktrees = path.dirname(entry);
    const gitDir = path.dirname(worktrees);
    if (path.basename(worktrees) !== 'worktrees' || path.basename(gitDir) !== '.git') return root;
    return path.dirname(gitDir);
  } catch {
    return root;
  }
}

// find-code's own hints name read-file / run-bash and "ask the user" — none of
// which a headless Loop run has — so following one would cost a refused hop.
const LOOP_HINT_FOUND = 'Read only the lines you need (Read with offset/limit); paths are relative to your working directory.';
const LOOP_HINT_EMPTY = 'No usable match in the code index — fall back to Grep/Glob.';

/**
 * find-code for a Loop run: chat's handler, Loop-scoped, with Loop hints.
 *
 * Unlike chat, a repo with no graph gets "no match" instead of chat's unscoped
 * fallback across every graphed repo: an unattended edit run told
 * `src/server.ts:120` from ANOTHER repo would edit the wrong lines whenever the
 * same relative path exists here, and nobody is watching to catch it.
 */
export function loopFindCode(args, { userId, roots, scopeRoot }) {
  let scoped = null;
  try { scoped = resolveRepoScope(userId, { workspaceRoot: scopeRoot }); } catch { scoped = null; }
  if (!scoped) {
    const query = typeof args?.query === 'string' ? args.query.trim().slice(0, 256) : '';
    return { query, symbols: [], related: [], files: [], hint: LOOP_HINT_EMPTY };
  }
  const out = handleFindCode(args, { userId, roots, workspaceRoot: roots?.[0] || '', scopeRoot });
  if (!out || out.error) return out;
  const found = out.symbols.length > 0 || out.related.length > 0 || out.files.length > 0;
  return { ...out, hint: `${found ? LOOP_HINT_FOUND : LOOP_HINT_EMPTY}${out.staleGraph ? ` ${STALE_HINT}` : ''}` };
}

function loopCodeSearchServer(userId, roots) {
  const scopeRoot = graphScopeRoot(roots[0]);
  return createSdkMcpServer({
    name: 'llmide',
    version: '0.2.0',
    tools: [tool(
      'find-code',
      'Search the project\'s code index and graph for a symbol, file, or feature — returns definition sites '
        + 'with file:line, related code (callers, callees, importers), and full-text hits. Use this before any Grep.',
      {
        query: z.string().max(256).describe('A symbol name, filename, feature, or error string to locate.'),
        limit: z.number().optional().describe('Max results per section (1-20, default 8).'),
        hops: z.number().optional().describe('Graph hops from each match (0-2, default 1).'),
      },
      async (args) => ({
        content: [{ type: 'text', text: JSON.stringify(loopFindCode(args, { userId, roots, scopeRoot })) }],
      }),
      { annotations: { readOnlyHint: true }, alwaysLoad: true },
    )],
  });
}

function headlessSystemAppend(root, extraRoots, languageLine, skillsText) {
  const extra = extraRoots.length
    ? `- You may also read and edit the project's notes directory${extraRoots.length > 1 ? 'ies' : ''} `
      + `${extraRoots.join(', ')} (plans, docs and the refactor plan live there) — use absolute paths for it.`
    : '';
  return [
    'You are running HEADLESS as one step of an automated verify-and-repair Loop in LLM-IDE. '
      + 'Nobody is watching this run and nobody can answer a question.',
    `- Work only inside the repository at ${root} (your working directory)${extraRoots.length ? ' and the directories below' : ''}. `
      + 'Every path you read, search or edit must stay inside them; anything else is refused.',
    extra,
    '- You have file tools only: Read, Glob, Grep, Edit, Write, plus mcp__llmide__find-code. There is no '
      + 'shell, no network and no way to run builds or tests — the Loop runs its own stages afterwards to '
      + 'verify your change. Do not claim you ran or verified anything.',
    '- To locate code, your FIRST search is mcp__llmide__find-code (definitions, callers and importers with '
      + 'file:line in one call); then Read only the lines it points at. Use Grep/Glob when it finds nothing, '
      + 'or for a literal string, comment or config value. Every tool result is re-read on each later step: '
      + 'make independent calls in ONE response.',
    '- Do not ask for permission or wait for input: make the change the request describes, or say in '
      + 'your reply why you could not.',
    '- End with a short plain summary of what you changed (which files, and why).',
    languageLine,
    skillsText,
  ].filter(Boolean).join('\n\n');
}

// A tool_result's content is a string or an array of content blocks; only the
// text blocks count toward its size.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

// Feeds the raw SDK stream into the same accounting the chat route uses
// (tool-accounting.mjs), translated into its event shape. Read from the stream,
// not the hooks: a call the hook or canUseTool denies never reaches
// PostToolUse, but it still cost a round trip and shows up as an error result.
// Known gaps: a call cut off before its result arrives is not counted, and if
// a subagent tool is ever enabled here its nested calls (parent_tool_use_id)
// would count as this step's.
function observeToolBlocks(accounting, msg) {
  const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : [];
  for (const b of blocks) {
    if (msg.type === 'assistant' && b?.type === 'tool_use') {
      accounting.observe({ type: 'tool_use_start', id: b.id, name: b.name });
    } else if (msg.type === 'user' && b?.type === 'tool_result') {
      accounting.observe({
        type: 'tool_result', toolUseId: b.tool_use_id, text: toolResultText(b.content), isError: b.is_error === true,
      });
    }
  }
}

// The injectable factory contract (prompt, options) — same shape as the chat
// engine's, so tests drive this runner with the same kind of fake.
const sdkQueryFactory = (prompt, options) => query({ prompt, options });

/**
 * Run one headless, confined agent step.
 *
 * `root` must already be validated (validateLoopRepoRoot) — this function
 * trusts it as the confinement root. Throws on engine failure; an abort
 * (timeout / client gone) surfaces as the SDK's abort error, and the caller
 * reads its own controller to tell which. A thrown error carries
 * `partialUsage` ({ usage, byModel, model }) — what the SDK reported before
 * the run was cut off — so the caller can still meter it.
 *
 * @returns {Promise<{ reply: string, changedPaths: string[], changedExtraPaths: string[],
 *   createdPaths: string[], usage: object,
 *   resolvedSkills: string[], unresolvedSkills: string[], truncatedSkills: string[],
 *   ran: boolean, resultSubtype: string|null, denied: Array<{toolName: string, reason: string}>,
 *   model: string|null, byModel: object[],
 *   toolEvents: Array<{tool: string, resultChars: number, truncated: boolean, isError: boolean}> }>}
 */
export async function runLoopAgent(
  {
    message, skills, root, extraRoots = [], userId, language, model, abortController, allowAmbientAuth = false,
    queryFactory = sdkQueryFactory,
  } = {},
  { readSkill = readSkillInstructions } = {},
) {
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  // `extraRoots` must already be validated (validateLoopExtraRoots).
  const roots = [root, ...(Array.isArray(extraRoots) ? extraRoots : [])];
  const { text: skillsText, resolved, unresolved, truncated } = buildLoopSkillsText(skills, userId, readSkill);
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, numTurns: 0, durationMs: 0,
  };
  const base = {
    resolvedSkills: resolved, unresolvedSkills: unresolved, truncatedSkills: truncated,
  };
  // A requested skill that is not installed means the step cannot do what it
  // was configured to do. Running the agent anyway would make edits nobody
  // asked for under the name of a skill that never ran — so nothing runs.
  if (unresolved.length > 0) {
    return {
      reply: '', changedPaths: [], changedExtraPaths: [], createdPaths: [], usage, ...base, ran: false, resultSubtype: null, denied: [],
      model: null, byModel: [], toolEvents: [],
    };
  }

  const auth = resolveAgentEngineAuth(AGENT_SDK_PROVIDER, userId);
  const { key } = auth;
  if (!key && !allowAmbientAuth) {
    throw Object.assign(
      new Error('No Anthropic API key available (set vault claude.apiKey or ANTHROPIC_API_KEY)'),
      { code: 'NO_KEY' },
    );
  }
  // Same per-user engine home rule as the chat engine (engine.mjs): only a
  // first-party-keyed user is redirected; ambient auth needs the operator's
  // default config dir to stay logged in.
  const sdkHome = resolveAnthropicKey(userId).key ? agentSdkHomeFor(userId) : null;
  if (sdkHome) {
    try { fs.mkdirSync(sdkHome, { recursive: true }); } catch { /* best-effort, as in engine.mjs */ }
  }

  const lang = resolveLanguage(language);
  const languageLine = lang.directive
    ? `Always write your reply in ${lang.name}.`
    : '';

  const changed = new Set();
  const changedExtra = new Set();
  // Files a Write CREATED (absent when the call was allowed). The Mac's guard
  // may delete a violating path it cannot restore from HEAD only when it is
  // one of these — never a file that existed before the edit.
  const pendingCreate = new Set();
  const created = new Set();
  const absOf = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p));
  const denied = [];
  const refuse = (toolName, reason) => {
    if (denied.length < 50) denied.push({ toolName, reason });
  };
  // No-progress stop (loop-progress.mjs). The step gets its OWN controller so
  // stopping it is told apart from the caller's timeout / disconnect, which
  // is forwarded into it.
  const progress = createProgressGuard();
  const stepAc = new AbortController();
  if (abortController?.signal) {
    if (abortController.signal.aborted) stepAc.abort();
    else abortController.signal.addEventListener('abort', () => stepAc.abort(), { once: true });
  }
  let noProgressReason = null;
  const stopForNoProgress = (reason) => {
    if (!reason || noProgressReason) return;
    noProgressReason = reason;
    stepAc.abort();
  };

  const preToolUse = async (input) => {
    const reason = loopToolRefusal(input?.tool_name, input?.tool_input, roots);
    // Refused calls never count as repeats (only on the error streak).
    const verdict = reason ? { action: 'ok' } : progress.onCall(input?.tool_name, input?.tool_input);
    if (verdict.action !== 'ok') {
      if (verdict.action === 'stop') stopForNoProgress(verdict.reason);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: verdict.action === 'stop' ? `Stopped: ${verdict.reason}.` : verdict.message,
        },
      };
    }
    if (!reason) {
      const fp = input?.tool_input?.file_path;
      if (input?.tool_name === 'Write' && typeof fp === 'string' && fp && !fs.existsSync(absOf(fp))) {
        pendingCreate.add(absOf(fp));
      }
      if (input?.tool_name !== 'Grep') return {};
      // A content search must never print a secret file's lines, even one
      // .gitignore does not hide: force the denylist in as negative globs.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'allow',
          updatedInput: withSecretExclusions(input?.tool_input),
        },
      };
    }
    refuse(input?.tool_name, reason);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
      },
    };
  };
  const postToolUse = async (input) => {
    if (WRITE_TOOLS.has(input?.tool_name)) {
      progress.onWrite();
      const rel = repoRelative(root, input?.tool_input?.file_path);
      if (rel) {
        changed.add(rel);
        const fp = input?.tool_input?.file_path;
        if (input?.tool_name === 'Write' && pendingCreate.has(absOf(fp))) created.add(rel);
      } else {
        const abs = extraRootPath(roots.slice(1), input?.tool_input?.file_path);
        if (abs) changedExtra.add(abs);
      }
    }
    return {};
  };
  // Decides instead of asking: never parks, never prompts.
  const canUseTool = async (toolName, input) => {
    const reason = loopToolRefusal(toolName, input, roots);
    if (reason) {
      refuse(toolName, reason);
      return { behavior: 'deny', message: reason };
    }
    return { behavior: 'allow', updatedInput: toolName === 'Grep' ? withSecretExclusions(input) : input };
  };

  const safeMessage = neutralizePromptFences(String(message ?? '')).slice(0, MAX_LOOP_MESSAGE_CHARS);
  const q = queryFactory(safeMessage, {
    cwd: root,
    additionalDirectories: roots.slice(1),
    // No operator settings, no user MCP, no plugins, no claude.ai connectors —
    // only the in-process, read-only code-search server.
    settingSources: [],
    mcpServers: { llmide: loopCodeSearchServer(userId, roots) },
    // ONLY the server above: settingSources [] alone does not drop .mcp.json /
    // user-scope / plugin servers, and `mcp__*` can no longer be denied
    // wholesale (it would hide find-code too).
    strictMcpConfig: true,
    tools: [...LOOP_AGENT_TOOLS],
    // Nothing is pre-approved: every call the SDK would ask about reaches
    // canUseTool, which applies the confinement rule.
    allowedTools: [],
    disallowedTools: [...LOOP_AGENT_DISALLOWED],
    permissionMode: 'default',
    canUseTool,
    // + the native-tool output cap (tool-output-cap.mjs) — a no-op for this
    // file-tools-only agent today (it caps Bash/Grep), kept so a future shell
    // or search tool here is capped like the chat engine's.
    hooks: withToolOutputCap({
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [postToolUse] }],
    }),
    systemPrompt: {
      type: 'preset', preset: 'claude_code',
      append: headlessSystemAppend(root, roots.slice(1), languageLine, skillsText),
      snapshot: false,
    },
    maxTurns: MAX_TURNS,
    // A one-shot step: nothing resumes it, so nothing is written to disk.
    persistSession: false,
    ...(typeof model === 'string' && model ? { model } : {}),
    env: {
      ...sdkSubprocessEnv(),
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      ...(key ? { ANTHROPIC_API_KEY: key, ...(sdkHome ? { CLAUDE_CONFIG_DIR: sdkHome } : {}) } : {}),
    },
    abortController: stepAc,
  });

  let reply = '';
  let lastAssistantText = '';
  let resultSubtype = null;
  let resolvedModel = null;
  let byModel = [];
  let sawResult = false;
  // Per-API-call usage from assistant messages, keyed by message id (one API
  // response can arrive split across several assistant messages carrying the
  // same usage). Only consulted when no `result` arrives — a timeout or an
  // abort — so a cut-off run is still metered for what it spent.
  const streamed = new Map();
  const toolAccounting = createToolAccounting();
  const applyRows = (rows) => {
    byModel = rows;
    usage.inputTokens = 0; usage.outputTokens = 0; usage.cacheReadTokens = 0; usage.cacheCreationTokens = 0;
    for (const row of rows) {
      usage.inputTokens += row.inputTokens;
      usage.outputTokens += row.outputTokens;
      usage.cacheReadTokens += row.cacheReadTokens;
      usage.cacheCreationTokens += row.cacheCreationTokens;
    }
  };
  const streamedRows = () => {
    const perModel = new Map();
    for (const { model: m, u } of streamed.values()) {
      const key = m || resolvedModel || model || 'unknown';
      const row = perModel.get(key) ?? {
        model: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      };
      row.inputTokens += Number(u.input_tokens) || 0;
      row.outputTokens += Number(u.output_tokens) || 0;
      row.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
      row.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
      perModel.set(key, row);
    }
    return [...perModel.values()];
  };
  try {
    for await (const msg of q) {
      observeToolBlocks(toolAccounting, msg);
      if (msg?.type === 'user') {
        for (const b of Array.isArray(msg?.message?.content) ? msg.message.content : []) {
          if (b?.type === 'tool_result') stopForNoProgress(progress.onResult(b.is_error === true));
        }
      }
      if (msg?.type === 'system' && msg?.subtype === 'init' && typeof msg.model === 'string') {
        resolvedModel = msg.model;
      } else if (msg?.type === 'assistant') {
        const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : [];
        const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('');
        if (text.trim()) lastAssistantText = text;
        const u = msg?.message?.usage;
        if (u && typeof u === 'object') {
          streamed.set(msg.message.id ?? `anon-${streamed.size}`, { model: msg.message.model, u });
        }
      } else if (msg?.type === 'result') {
        sawResult = true;
        resultSubtype = msg.subtype ?? null;
        if (typeof msg.result === 'string' && msg.result.trim()) reply = msg.result;
        // A fresh, unpersisted session: the result's running totals ARE this
        // run's totals (no resume baseline to subtract — see engine.mjs).
        applyRows(normalizeModelUsage(msg.modelUsage));
        usage.costUsd = Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : 0;
        usage.numTurns = Number.isFinite(msg.num_turns) ? msg.num_turns : 0;
        usage.durationMs = Number.isFinite(msg.duration_ms) ? msg.duration_ms : 0;
      }
    }
  } catch (err) {
    // Timeout / abort / engine failure: hand the caller what was spent so far.
    if (!sawResult) applyRows(streamedRows());
    // Our own no-progress stop (and not the caller's timeout/disconnect) is a
    // finished step, not an engine failure.
    if (noProgressReason && !abortController?.signal?.aborted) return finish();
    if (err && typeof err === 'object') {
      err.partialUsage = {
        usage: { ...usage }, byModel,
        model: resolvedModel ?? (typeof model === 'string' && model ? model : null),
        toolEvents: toolAccounting.events(),
      };
    }
    throw err;
  }
  if (!sawResult) applyRows(streamedRows());
  return finish();

  function finish() {
    const stoppedNote = noProgressReason
      ? `[LLM-IDE stopped this step: ${noProgressReason} — no progress, so further turns would only cost tokens.]`
      : '';
    return {
      reply: [(reply || lastAssistantText).trim(), stoppedNote].filter(Boolean).join('\n\n'),
      changedPaths: [...changed].sort(),
      changedExtraPaths: [...changedExtra].sort(),
      createdPaths: [...created].sort(),
      usage,
      ...base,
      ran: true,
      resultSubtype,
      denied,
      model: resolvedModel ?? (typeof model === 'string' && model ? model : null),
      byModel,
      toolEvents: toolAccounting.events(),
      // Never over the caller's own timeout / disconnect, which the route names.
      ...(noProgressReason && !abortController?.signal?.aborted
        ? { resultSubtype: 'no_progress', noProgressReason } : {}),
    };
  }
}
