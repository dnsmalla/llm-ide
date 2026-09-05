// Pure option composition + the turn runner for the v2 chat engine (the
// Agent-SDK-powered successor of the CLI loop behind the Mac chat).
//
// `buildEngineOptions()` maps a Mac chat request onto Claude Agent SDK
// `query()` options — mode → permissionMode/persona, the read-only tool
// allowlist, skills text, cwd + additional directories, and the
// preset+append system prompt — WITHOUT starting a query. That composition
// is pure and testable with injected readSkill/roots fakes.
//
// `runAgentV2Turn()` (below) is the runner: it owns the query lifecycle,
// the llmide in-process MCP server, key auth, resume, event mapping, and
// the AskUserQuestion approval round-trip (canUseTool bridged to HTTP via
// the decisions registry). It imports the SDK — the only place that may,
// per the isolation rule (modules inside llm_agent/sdk/ only), and the
// exact-pinned SDK version makes that import a reviewed surface.
//
// Framing notes: skill-block text (TRUSTED INSTRUCTIONS header, `## Skill:
// <name>` sections) and attachment caps (30 files / 80k per file / 200k
// total) are shared verbatim with server/ai-routes.mjs's /code-assist via
// core/prompt-framing.mjs (L0) — ai-routes is route layer (L4) and must not
// be imported from here, so the shared definition lives in core instead of
// being hand-copied in two places.
//
// Memory parity with the legacy loop: DB-backed session memory
// (kb/session-memory.mjs) is read into the system prompt here (always-on,
// same framing as legacy) and written back by runAgentV2Turn via
// persistTurnMemory, fire-and-forget, after each turn. Project memory
// (Graphify, graphkit/memory.mjs) is deliberately NOT injected the same
// way — it's exposed as a callable tool (project_memory, ./tools.mjs)
// instead, matching v2's tool-driven design (same reasoning as kb_search):
// the model reaches for grounded project context when it helps, rather than
// paying its token cost on every turn.

import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  personaForMode, PLAN_LIKE_MODES, restrictsTools, allowedToolNames,
} from '../runtime/mode-personas.mjs';
import { pipelineSkillIdFor, buildExecuteBinding } from '../runtime/plan-pipeline.mjs';
import {
  readSkillInstructions, buildPerUserSkillSet, internalSkills, pluginEnabledFor,
  buildUserPluginDelivery,
} from '../skills/index.mjs';
import { composeSystemContext } from '../internal/context/compose.mjs';
import { buildSessionTaskPromptBlock } from '../runtime/task-session-context.mjs';
import { V2_EXECUTE_GUIDANCE } from '../runtime/execute-guidance.mjs';
import { buildReadableRoots, buildTrustedRoots, isTooBroadRoot } from '../runtime/handlers/repo-files.mjs';
import { expandTilde } from '../../graphkit/memory.mjs';
import { redactFence } from '../runtime/redaction.mjs';
import { persistTurnMemory } from '../runtime/memory-persist.mjs';
import { config } from '../../core/config.mjs';
import { sanitizeForPrompt } from '../../core/utils.mjs';
import { selectAttachments, buildSkillsText, buildModeSkillsText } from '../../core/prompt-framing.mjs';
import { getDb } from '../../kb/db.mjs';
import { usdCapForModel } from '../../kb/usage.mjs';
import { nativePluginsEnabled } from '../../kb/user.mjs';
import { listSessionMemory, resolveChatSessionId } from '../../kb/session-memory.mjs';
import { getAgentPersona } from '../../kb/personas.mjs';
import { getSecret, makeSecretReader } from '../../server/vault.mjs';
import { runClaude as runClaudeImpl } from '../../providers/runtime.mjs';
import { resolveCustomProviderDispatch } from '../../providers/providers.mjs';
import { sanitizePersonaSuffix } from '../../providers/prompt-utils.mjs';
import { mapSdkMessage } from './events.mjs';
import { buildLlmIdeServer } from './tools.mjs';
import { registerDecision, abortDecisionsForSession } from './decisions.mjs';
import { get as registryGet, entries as registryEntries } from '../tools/registry.mjs';
import { hasAlwaysAllow, setAlwaysAllow } from '../../kb/tool-approvals.mjs';
import { runBashGate, writePathGate } from '../tools/gates.mjs';
import { effectiveMcpServers } from '../../mcp/mcp-config.mjs';

// The provider id every SDK-engine turn runs on — the usage ledger and the
// route layer meter against this instead of hardcoding the string, so "which
// provider the Agent SDK is" stays linker knowledge.
export const AGENT_SDK_PROVIDER = 'anthropic';

// --- Auth: per-user vault key first, operator env as fallback -------------
// (Moved here from spike-engine.mjs, which re-exports it for compatibility —
// the v2 runner and the spike share one auth ladder.)

export function resolveAnthropicKey(userId) {
  if (userId) {
    try {
      const key = getSecret(getDb(), userId, 'claude.apiKey');
      if (key) return { key, source: 'vault' };
    } catch {
      // Vault miss/unavailable — fall through to the environment.
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: 'env' };
  return { key: null, source: 'none' };
}

// --- Provider → SDK auth (Anthropic-compatible gateways) ---------------------
//
// The Agent SDK speaks the Anthropic Messages API and nothing else, so the
// engine can run a non-Anthropic model ONLY through a provider that exposes an
// Anthropic-format endpoint (Z.AI GLM `…/api/anthropic`, DeepSeek
// `…/anthropic`, Ollama `:11434`). Such a provider is a user-registered
// `custom:<uuid>` whose registry entry carries `anthropicBaseURL`; the SDK's
// CLI subprocess is pointed at it through ANTHROPIC_BASE_URL — the same
// LLM-gateway env contract the `claude` CLI documents, which is why "normal
// Claude can use GLM" and this engine now can too. Every other provider id
// (openai/google/…, or a custom provider with no Anthropic door) is refused
// HERE, before anything spawns: the Mac only sends a v2 turn for a provider
// it believes the engine can run, so a silent fallback would be a lie.
//
// Returns `{ provider, key, source, baseUrl }`. `baseUrl` null = first-party
// Anthropic (the runner's auth ladder then decides keyed vs ambient). A
// gateway turn ALWAYS carries a key — a gateway has no ambient login to fall
// back to (Ollama simply accepts any non-empty token).
export function resolveAgentEngineAuth(provider, userId, { resolveCustom = resolveCustomProviderDispatch } = {}) {
  if (!provider || provider === AGENT_SDK_PROVIDER) {
    return { provider: AGENT_SDK_PROVIDER, ...resolveAnthropicKey(userId), baseUrl: null };
  }
  if (typeof provider === 'string' && provider.startsWith('custom:')) {
    const resolved = resolveCustom(provider, userId);
    if (resolved.error) {
      const err = new Error(resolved.message);
      err.code = 'PROVIDER_UNAVAILABLE';
      throw err;
    }
    if (!resolved.anthropicBaseUrl) {
      const err = new Error(
        `${resolved.name} has no Anthropic-compatible endpoint configured, so the Agent engine cannot run it. `
        + 'Add one in Settings → Custom Providers (e.g. https://api.z.ai/api/anthropic), or pick Claude.',
      );
      err.code = 'PROVIDER_NOT_AGENT_CAPABLE';
      throw err;
    }
    return { provider, key: resolved.apiKey, source: 'vault', baseUrl: resolved.anthropicBaseUrl };
  }
  const err = new Error(
    `The Agent engine runs on Anthropic-compatible providers only; "${provider}" is not one.`,
  );
  err.code = 'PROVIDER_NOT_AGENT_CAPABLE';
  throw err;
}

// --- Per-user engine homes (spec §6/§11) --------------------------------------
//
// CLAUDE_CONFIG_DIR = <dataDir>/agent-sdk/<userId>/ isolates each tenant's
// SDK transcripts and credentials (settingSources: [] isolates the operator's
// SETTINGS; the config dir isolates everything else the SDK writes). Applied
// to KEYED turns only: an ambient-auth turn relies on the operator's
// `claude login`, which lives under the operator's default config dir, so
// redirecting it would leave the subprocess "Not logged in". The base
// follows the server's canonical data dir — the DB's directory (core/config:
// <repo>/kb by default, wherever LLMIDE_DB_PATH points) — so engine homes sit
// next to the other per-install runtime data. User ids are server-minted hex
// (users.mjs); the charset guard keeps even a hand-edited id from escaping
// the base via path traversal. Shared by the runner (composes the env every
// keyed turn) and the route's transcript cleanup — one derivation, never two.

const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

export function agentSdkHomeFor(userId) {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return null;
  return path.join(path.dirname(config.dbPath), 'agent-sdk', userId);
}

// --- Attachment caps + skills text --------------------------------------------
// Both now live in core/prompt-framing.mjs, shared verbatim with ai-routes'
// /code-assist (L3 cannot import the L4 route module, so the shared
// definition sits in core instead of being hand-copied in two places).
// `capAttachments` name kept locally as a thin alias so call sites below
// read the same as before the extraction.
const capAttachments = selectAttachments;

// Attachments are DATA: each wrapped in a <<<BEGIN>>>…<<<END>>> fence (the
// content itself is already fence-stripped by sanitizeForPrompt, so a
// hostile file cannot close its fence early and inject instructions).
function buildAttachmentsText(files) {
  if (!files.length) return '';
  let text = `# Attached files (${files.length})\n`;
  for (const f of files) {
    text += `\n## ${f.path}\n<<<BEGIN>>>\n${f.content}\n<<<END>>>\n`;
  }
  return `${text}\n`;
}

// --- The composition ---------------------------------------------------------

// The v2 tool allowlist. `allowedTools` means exactly ONE thing to the SDK
// (sdk.d.ts): "List of tool names that are auto-allowed without prompting for
// permission. These tools will execute automatically without asking the user
// for approval." — i.e. a name listed here NEVER reaches `canUseTool`.
//
// So this list carries the Claude Code read-only built-ins plus every
// `kind: 'read'` registry tool, and DELIBERATELY EXCLUDES every `kind: 'act'`
// tool (run-bash / task-create / task-update). Listing an act tool here would
// pre-approve it and silently bypass the safety gate in `canUseTool` below —
// which is the whole point of the gate. Act tools are still MOUNTED (see
// sdk/tools.mjs, which mounts all registry entries) and still callable; they
// just fall through to `canUseTool`, where the blocked/auto/prompt gate runs.
//
// The mcp names are DERIVED from llm_agent/tools/registry.mjs rather than
// hand-listed: a hand-maintained fourth copy of the tool-name list already
// went stale once on this branch (task-list was omitted). Adding a `kind:
// 'read'` entry to the registry now auto-allows it here with no edit; adding a
// `kind: 'act'` entry correctly routes it through the gate with no edit.
//
// No Bash/Write/Edit built-ins — a v2 chat turn is read-and-answer; writes
// keep their own approval flow. ask-internal/ask-subagent are read-only
// delegation tools already gated to safe sub-loops in the legacy engine —
// allowing them here is intentional parity, not new write capability.
const V2_BUILTIN_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const MCP_PREFIX = 'mcp__llmide__';
const V2_ALLOWED_TOOLS = [
  ...V2_BUILTIN_ALLOWED_TOOLS,
  ...registryEntries().filter((e) => e.kind === 'read').map((e) => `${MCP_PREFIX}${e.name}`),
];
// Every llmide tool the MCP server mounts, act tools included — the universe
// a restricted mode has to subtract from (see v2ToolPolicyForMode).
const V2_ALL_MCP_TOOLS = registryEntries().map((e) => `${MCP_PREFIX}${e.name}`);

const RUN_BASH_MCP = `${MCP_PREFIX}run-bash`;
// Native write/shell tools a restricted mode must remove from model context
// entirely (canUseTool re-checks as the belt; this is the braces). Single
// source of truth for both the array form (v2ToolPolicyForMode's
// disallowedTools spread) and the Set form (canUseTool's membership check
// below) — previously canUseTool re-literaled its own Set every single call
// (final whole-branch review, I6).
const NATIVE_GATED_TOOLS = ['Edit', 'Write', 'Bash'];
const NATIVE_GATED = new Set(NATIVE_GATED_TOOLS);

/**
 * The (allowedTools, disallowedTools) pair for `mode`.
 *
 * Every mode disallows mcp__llmide__run-bash — native Bash (canUseTool-gated,
 * Task 3) replaces it on v2, and offering both would double-gate one shell.
 *
 * Unrestricted modes get the full auto-allow list (minus run-bash).
 *
 * A restricted mode (plan/assist_plan/review/document — `restrictsTools`)
 * gets its llmide tools narrowed to `allowedToolNames(mode)`, exactly the set
 * the LEGACY engine's dispatch is filtered to, so both engines expose the same
 * roster for the same mode. Additionally, it disallows the native Edit/Write/Bash
 * tools from the model's context entirely. `disallowedTools` carries the actual
 * enforcement: per sdk.d.ts it removes a tool "from the model's context" so it
 * "cannot be used, even if it would otherwise be allowed" — dropping a name from
 * `allowedTools` alone would only demote it to a `canUseTool` consult, which
 * would happily allow an 'auto'-tier run-bash in Plan mode.
 */
export function v2ToolPolicyForMode(mode) {
  if (!restrictsTools(mode)) {
    // run-bash is v2-retired in every mode: native Bash (canUseTool-gated)
    // replaces it, and offering both would be two shells with one gate.
    return { allowedTools: [...V2_ALLOWED_TOOLS], disallowedTools: [RUN_BASH_MCP] };
  }
  const permitted = allowedToolNames(mode);
  const keep = (n) => !n.startsWith(MCP_PREFIX) || permitted.has(n.slice(MCP_PREFIX.length));
  const disallowed = new Set([
    ...V2_ALL_MCP_TOOLS.filter((n) => !keep(n)),
    RUN_BASH_MCP,
    ...NATIVE_GATED_TOOLS,
  ]);
  return { allowedTools: V2_ALLOWED_TOOLS.filter(keep), disallowedTools: [...disallowed] };
}

// The in-process llmide server owns this name; a user server answering to it
// would REPLACE llm-ide's own tool surface for the turn.
const RESERVED_MCP_NAME = 'llmide';

/**
 * The user's own MCP servers for one turn, in SDK `mcpServers` shape, plus the
 * tool specs that pre-approve them.
 *
 * Until now the v2 engine mounted only the in-process `llmide` server, so a
 * user who had consented to (say) Linear got its tools on the legacy CLI path
 * and silently nothing here. Policy is deliberately identical to
 * buildMcpConfigForUser: enabled AND consented, and NOTHING in a restricted
 * mode (plan/review/document) — a mode that narrows llm-ide's own tools must
 * not hand over an unbounded third-party surface instead.
 *
 * Pre-approval uses the SDK's server-level spec (`mcp__<server>`) because the
 * tool names of a server are unknowable before connecting — and without it
 * every call would land in canUseTool, which denies anything it doesn't
 * recognize (DENY_UNKNOWN_TOOL).
 */
export function buildUserMcpServers(userId, mode, {
  restrictsToolsFn = restrictsTools,
  readSecret,
  pluginEnabled,
} = {}) {
  const empty = { servers: {}, allowedTools: [] };
  const requestedMode = typeof mode === 'string' && mode ? mode : 'execute';
  if (typeof restrictsToolsFn === 'function' && restrictsToolsFn(requestedMode)) return empty;
  let effective;
  try {
    effective = effectiveMcpServers(userId, {
      readSecret: readSecret || makeSecretReader(getDb(), userId),
      pluginEnabled: pluginEnabled || pluginEnabledFor(userId),
    });
  } catch (err) {
    // A turn must not die because the MCP registry is unreadable — the user
    // loses their MCP tools for this turn, not the reply.
    console.warn('[agent-v2] user MCP unavailable:', err?.message || err);
    return empty;
  }
  const servers = {};
  for (const [id, cfg] of Object.entries(effective)) {
    if (id === RESERVED_MCP_NAME) {
      console.warn(`[agent-v2] MCP server '${id}' shadows llm-ide's own tool server — not mounted`);
      continue;
    }
    servers[id] = cfg;
  }
  return { servers, allowedTools: Object.keys(servers).map((id) => `mcp__${id}`) };
}

const MAX_PROMPT_CHARS = 20_000;

/**
 * Compose SDK query options from a Mac chat request. Pure except for the
 * three injected side-effecting lookups (readSkill, roots, sessionMemory —
 * all overridable via the second argument for tests). Returns
 * `{ queryOptions, prompt, meta }`; does NOT start a query.
 *
 *   queryOptions.model              — present only when a non-empty string
 *   queryOptions.permissionMode     — 'plan' for plan-like modes (with
 *                                     planModeInstructions = the mode
 *                                     persona), else 'default'
 *   queryOptions.systemPrompt       — preset claude_code + append (language
 *                                     directive, mode persona, skill blocks,
 *                                     session-memory facts, fenced
 *                                     attachments). Project memory (Graphify)
 *                                     is deliberately NOT here — it's a v2
 *                                     TOOL (project_memory, tools.mjs), not
 *                                     always-on injection; see that module.
 *   prompt                          — the user message, sanitized, 20k cap
 *   meta                            — { mode, model, truncatedPaths } for the
 *                                     runner (session bookkeeping + notices)
 */
export function buildEngineOptions(
  { userId, mode, model, language, message, skills, agentContext, attachments, planExecute } = {},
  {
    readSkill = readSkillInstructions,
    roots = buildReadableRoots,
    sessionMemory = listSessionMemory,
    getPersona = getAgentPersona,
    // Injected for the same reason `readSkill` is: composition must stay
    // testable without a plugin directory on disk. Only used to decide
    // inline vs subagent-driven execution (plan-pipeline.mjs).
    getSubagents = (uid) => buildPerUserSkillSet(uid).subagents,
  } = {},
) {
  const resolvedMode = typeof mode === 'string' && mode ? mode : 'execute';
  const planLike = PLAN_LIKE_MODES.has(resolvedMode);

  // The planning pipeline's stage skill for this turn — the same resolution
  // the legacy engine runs (runtime/route.mjs), so a plan started on one
  // engine reads identically on the other. See runtime/plan-pipeline.mjs.
  let hasSubagents = false;
  try { hasSubagents = (getSubagents(userId)?.size ?? 0) > 0; }
  catch { /* no plugin view (tests, fresh install) — inline execution */ }
  const pipelineSkillId = pipelineSkillIdFor({ mode: resolvedMode, planExecute, hasSubagents });
  const { text: pipelineSkillsText, names: pipelineSkillNames } = pipelineSkillId
    ? buildModeSkillsText([pipelineSkillId], userId, readSkill)
    : { text: '', names: [] };

  const persona = planExecute && pipelineSkillNames.length
    ? buildExecuteBinding({ skillName: pipelineSkillNames[0], hasSubagents })
    : personaForMode(resolvedMode, { skillName: pipelineSkillNames[0] });
  const { allowedTools, disallowedTools } = v2ToolPolicyForMode(resolvedMode);

  // The wire convention is home-relative roots ("~/proj" — what the Mac
  // sends); every READ handler expands them (graphkit/memory's expandTilde,
  // the same one repo-files imports), and the SDK's cwd must too: Node
  // spawn does not expand "~", so a literal
  // tilde cwd is ENOENT and the SDK misreports it as a native-binary/libc
  // launch failure. Expanding here also lets the additionalDirectories
  // filter below actually match the (already-expanded) roots() output.
  const rawWorkspaceRoot = typeof agentContext?.workspaceRoot === 'string' ? agentContext.workspaceRoot : '';
  // path.resolve so a literal ".." spelling can't dodge the breadth
  // check — isTooBroadRoot compares normalized paths (review R1).
  const workspaceRoot = rawWorkspaceRoot ? path.resolve(expandTilde(rawWorkspaceRoot)) : '';
  // All validated readable roots (DB repo allow-list ∪ the validated
  // workspace root). The SDK already grants cwd, so additionalDirectories
  // is the roots result minus cwd — indexed repos and any other roots.
  const allRoots = roots({ userId, workspaceRoot: workspaceRoot || undefined });
  const additionalDirectories = (Array.isArray(allRoots) ? allRoots : [])
    .filter((dir) => dir !== workspaceRoot);

  const { files, truncatedPaths } = capAttachments(attachments);

  const appendParts = [];
  if (typeof language === 'string' && language) appendParts.push(`Always respond in ${language}.`);
  // Ground the agent in the app — active project, indexed repos, recent
  // issues, app capabilities: the same System context the legacy loop
  // injects (composeSystemContext in loop.mjs), minus the Graphify memory
  // block, which v2 exposes as the callable project_memory tool instead.
  // Without this the agent doesn't know the chat is bound to a GitLab
  // project or what "Auto Tasks" means here, and answers like vanilla
  // Claude Code (checks git, reaches for harness cron tools).
  appendParts.push(composeSystemContext(agentContext, userId, message, { memory: false }));
  if (persona) appendParts.push(persona);
  if (resolvedMode === 'execute') appendParts.push(V2_EXECUTE_GUIDANCE);
  const taskBlock = buildSessionTaskPromptBlock(userId, agentContext, resolvedMode);
  if (taskBlock) appendParts.push(taskBlock.trimStart());
  // User's own custom persona (kb/personas.mjs) — distinct from the MODE
  // persona above. Mirrors the legacy loop's exact framing/sanitization
  // (llm_agent/runtime/route.mjs) so a persona reads identically across
  // engines. Best-effort: a stray DB error here shouldn't break a v2 turn,
  // and users with no persona set pay zero extra token cost.
  try {
    const activePersona = userId ? getPersona(userId) : null;
    const name = sanitizePersonaSuffix((activePersona?.name || '').trim()).slice(0, 80);
    const suffix = sanitizePersonaSuffix((activePersona?.promptSuffix || '').trim());
    if (name || suffix) {
      let block = '\n\n---\nPersona\n';
      if (name) block += `You are also known to the user as ${name}; sign off in that voice when natural.\n`;
      if (suffix) block += `Voice & focus: ${suffix}\n`;
      appendParts.push(block.trim());
    }
  } catch { /* persona lookup is best-effort — same as legacy's try/catch */ }
  // Pipeline skill first: it is the mode's process, and a user-invoked
  // skill applies WITHIN that process (same order as the legacy engine's
  // composedUserMessage).
  if (pipelineSkillsText) appendParts.push(pipelineSkillsText);
  const skillsText = buildSkillsText(skills, userId, readSkill);
  if (skillsText) appendParts.push(skillsText);
  // Session memory (kb/session-memory.mjs): facts extracted from THIS chat's
  // own prior turns — a real DB-backed record, not the SDK's own resumed-
  // session continuity (which only covers turn text, not distilled facts,
  // and disappears if the SDK session is ever unresumable/reset). Mirrors
  // the legacy loop's exact framing (llm_agent/runtime/route.mjs) so recall
  // reads identically across engines. redactFence for the same reason
  // legacy applies it: the facts are extracted from prior user/assistant
  // turns, which can carry untrusted text.
  try {
    const chatSessionId = resolveChatSessionId(agentContext);
    if (chatSessionId && userId) {
      const sessionFacts = sessionMemory(userId, chatSessionId);
      if (Array.isArray(sessionFacts) && sessionFacts.length > 0) {
        const block = `## This session's memory\n${sessionFacts.map((f) => `- ${f}`).join('\n')}`;
        appendParts.push(redactFence(block));
      }
    }
  } catch { /* memory is best-effort — keep the base without it */ }
  const attachmentsText = buildAttachmentsText(files);
  if (attachmentsText) appendParts.push(attachmentsText);

  const queryOptions = {
    // Live token + tool-args deltas — the stream a chat UI needs.
    includePartialMessages: true,
    // Full isolation from the operator's own Claude config (same policy as
    // the CLI fallback's --setting-sources ''). Credentials are not
    // settings — ambient auth still works through the subprocess.
    settingSources: [],
    ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
    additionalDirectories,
    permissionMode: planLike ? 'plan' : 'default',
    ...(planLike ? { planModeInstructions: persona } : {}),
    // Fresh arrays per call — V2_ALLOWED_TOOLS is a shared constant and must
    // never be handed to a caller that could mutate it. In a restricted mode
    // (plan/review/document) the llmide act tools are BOTH un-auto-allowed and
    // hard-disallowed, matching legacy's dispatch filter for the same mode.
    allowedTools,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendParts.join('\n\n') },
    ...(typeof model === 'string' && model ? { model } : {}),
  };

  return {
    queryOptions,
    prompt: sanitizeForPrompt(message).slice(0, MAX_PROMPT_CHARS),
    meta: {
      mode: resolvedMode,
      model: typeof model === 'string' && model ? model : null,
      truncatedPaths,
    },
  };
}

// --- The turn runner ----------------------------------------------------------

// The injectable factory contract is positional (prompt, options); this
// default adapts the real SDK query() (one params object) to that shape so
// the live path (no queryFactory passed) and the test fakes are interchangeable.
const sdkQueryFactory = (prompt, options) => query({ prompt, options });

const MAX_TURNS = 40;

// --- Turn budget (spec §7: "maxBudgetUsd from the user's model-limits
// config when set") ------------------------------------------------------------
//
// What the model-limits system ACTUALLY stores (kb/usage.mjs + migration
// 0019): per-(user, provider, model) rows in `model_limits` with
// limit_value (an integer COUNT), unit ∈ {'runs','tokens'}, window_kind ∈
// {'daily','monthly'}, threshold_pct. Those are windowed usage caps — never
// USD — and no pricing table exists anywhere in the install, so converting a
// runs/tokens cap into dollars would mean inventing an exchange rate that
// silently rots as prices change. This resolver deliberately does NOT do
// that; it resolves a budget only from a usd-unit row (usdCapForModel —
// setLimits currently rejects that unit, so no such row can exist via the
// API yet; the read path is wired so the moment the limits system grows a
// USD unit, v2 turns pick it up with no engine change). Until then every v2
// turn runs uncapped, with the per-model caps still enforced AFTER the fact
// by the usage ledger: every result is metered via recordUsage in the route,
// so resolveModel's window caps and auto-fallback keep working unchanged.
export function resolveMaxBudgetUsd(userId, model, { usdCap = usdCapForModel, provider = AGENT_SDK_PROVIDER } = {}) {
  // `provider` is the id the turn actually runs on: first-party Anthropic by
  // default, or an Anthropic-compatible `custom:<uuid>` (whose limits chain is
  // empty today, so usdCapForModel answers null and the turn runs uncapped).
  return usdCap(getDb(), userId, provider, typeof model === 'string' && model ? model : null);
}

// Native tools outside the gated roster (and any unknown tool) stay denied —
// a deny with a reason reads better to the model than a silent hang.
const DENY_UNKNOWN_TOOL = 'This tool is not enabled in the LLM-IDE chat engine.';
const DENY_NO_ANSWER = 'The user did not answer the question.';

// Cap for every string carried in approval_request.args — the payload is a
// UI preview, not the transport for the edit itself (the SDK already holds
// the real input).
const APPROVAL_ARG_CAP = 20_000;

/** Structured approval-card payload for a native tool, capped per field. */
export function approvalArgsFor(toolName, input) {
  let truncated = false;
  const cut = (s) => {
    const str = typeof s === 'string' ? s : '';
    if (str.length > APPROVAL_ARG_CAP) { truncated = true; return str.slice(0, APPROVAL_ARG_CAP); }
    return str;
  };
  if (toolName === 'Bash') {
    const args = { command: cut(input?.command) };
    return truncated ? { ...args, truncated } : args;
  }
  if (toolName === 'Edit') {
    // replaceAll is a boolean flag, not a string field — never run through
    // cut(). Included unconditionally (not gated behind `truncated`) so the
    // approval card can always tell a single replacement from a global one
    // (final whole-branch review, I4).
    const args = {
      filePath: cut(input?.file_path), oldString: cut(input?.old_string), newString: cut(input?.new_string),
      replaceAll: input?.replace_all === true,
    };
    return truncated ? { ...args, truncated } : args;
  }
  if (toolName === 'Write') {
    const content = typeof input?.content === 'string' ? input.content : '';
    // exists tells the approval card whether this Write would overwrite a
    // file already on disk vs. create a new one — included unconditionally
    // (final whole-branch review, I5).
    const args = {
      filePath: cut(input?.file_path), contentPreview: cut(content), totalChars: content.length,
      exists: typeof input?.file_path === 'string' && fs.existsSync(input.file_path),
    };
    return truncated ? { ...args, truncated } : args;
  }
  return null;
}

/**
 * Run one v2 chat turn against the Agent SDK and stream its wire events.
 *
 * Composes options via buildEngineOptions, mounts the llmide in-process MCP
 * server, resolves auth (vault key → env → operator ambient when
 * allowAmbientAuth), and iterates the query: every SDK message is mapped
 * (mapSdkMessage) onto `onEvent`, `msg.session_id` is captured as the live
 * SDK session, and usage/cost totals accumulate across the stream.
 *
 * The approval bridge: `canUseTool` parks an AskUserQuestion in the
 * decisions registry (requestId), emits `approval_request`, and blocks until
 * the HTTP decision route answers (allow with the client's answers verbatim)
 * or the registry expires/aborts (deny with a no-answer message). The SDK's
 * per-call abort signal AND the turn-level `signal` both abort the session's
 * parked decisions, so an aborted turn denies a pending approval immediately
 * instead of lingering to the registry's 300 s timeout. Any other tool is
 * denied read-only-style.
 *
 * Throws `Error{code:'SESSION_UNRESUMABLE'}` when `resumeSdkSessionId` was
 * set and the iteration fails with a /session|conversation|resume/i error —
 * the route layer's cue to restart from a fresh session.
 *
 * On a successful iteration, fires persistTurnMemory fire-and-forget with the
 * turn's accumulated delta text as `reply` — the same auto-capture the
 * legacy loop runs, writing BOTH the project's chat-memory.md and the
 * DB-backed session_memory row set from one extraction pass.
 *
 * Returns `{ result, usageTotals }`: the mapped result event (or null) and
 * summed { inputTokens, outputTokens, cacheReadTokens, costUsd, numTurns,
 * durationMs }.
 */
export async function runAgentV2Turn(
  {
    message, userId, mode, model, language, skills, agentContext, attachments,
    planExecute,
    // Provider id the client resolved for this turn: absent/`anthropic` for
    // first-party Claude, or an Anthropic-compatible `custom:<uuid>`. Anything
    // else is refused by resolveAgentEngineAuth before the SDK spawns.
    provider = AGENT_SDK_PROVIDER,
    resumeSdkSessionId, onEvent, signal, allowAmbientAuth = false,
    queryFactory = sdkQueryFactory,
  } = {},
  {
    readSkill = readSkillInstructions, roots = buildReadableRoots, resolveBudget = resolveMaxBudgetUsd,
    sessionMemory = listSessionMemory, persistMemory = persistTurnMemory, runClaude = runClaudeImpl,
  } = {},
) {
  // Without a workspace the SDK would inherit the server process's cwd —
  // a v2 turn is always rooted in the request's workspace or not run at all.
  // Expanded ("~/…" is the wire convention) and existence-checked up front:
  // a stale/nonexistent root would otherwise surface as the SDK's misleading
  // "native binary failed to launch (libc)" spawn error instead of naming
  // the actual problem.
  const rawWorkspaceRoot = typeof agentContext?.workspaceRoot === 'string' ? agentContext.workspaceRoot : '';
  // path.resolve so a literal ".." spelling can't dodge the breadth
  // check — isTooBroadRoot compares normalized paths (review R1).
  const workspaceRoot = rawWorkspaceRoot ? path.resolve(expandTilde(rawWorkspaceRoot)) : '';
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  let rootStat = null;
  try { rootStat = fs.statSync(workspaceRoot); } catch { /* handled below */ }
  if (!rootStat) {
    throw new Error(`workspaceRoot does not exist: ${workspaceRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`workspaceRoot is not a directory: ${workspaceRoot}`);
  }
  // statSync passing is not the same as the root being USABLE as a cwd. On
  // macOS a TCC-protected folder (~/Desktop, ~/Documents, ~/Downloads, iCloud
  // Drive) stats fine but denies opendir/chdir to a process whose responsible
  // app has no folder grant — and the Node server is spawned by the Mac app,
  // which inherits the app's TCC identity, not the user's shell. The SDK
  // spawns the CLI with cwd=workspaceRoot, so that denial surfaces as a
  // spawn EPERM/EACCES the SDK misreports as a native-binary/libc launch
  // failure. Probe the directory here so the user gets the real cause.
  try {
    fs.opendirSync(workspaceRoot).closeSync();
  } catch (err) {
    const code = err?.code;
    if (code === 'EPERM' || code === 'EACCES') {
      throw new Error(
        `workspaceRoot is not readable (${code}): ${workspaceRoot}. `
        + 'On macOS this is usually a privacy (TCC) denial — grant the LLM-IDE app '
        + 'access to that folder in System Settings › Privacy & Security › Files and Folders '
        + '(or Full Disk Access), or move the project outside ~/Desktop, ~/Documents, '
        + '~/Downloads and iCloud Drive.',
      );
    }
    throw new Error(`workspaceRoot is not readable (${code ?? 'unknown'}): ${workspaceRoot}`);
  }
  // The SDK grants read access to cwd, so it must clear the same breadth bar
  // buildReadableRoots applies — "~" as a workspace would silently grant the
  // whole home directory.
  if (isTooBroadRoot(workspaceRoot)) {
    throw new Error(`workspaceRoot is too broad: ${workspaceRoot}`);
  }

  // Provider → auth. First-party Anthropic keeps the spike's ladder: per-user
  // vault key → operator ambient auth (ambient is opt-in so hermetic tests can
  // assert the no-key error). An Anthropic-compatible custom provider resolves
  // to its own key + base URL — or throws here, before anything spawns.
  const auth = resolveAgentEngineAuth(provider, userId);
  const { key, baseUrl: gatewayBaseUrl } = auth;
  if (!key && !allowAmbientAuth) {
    throw new Error('No Anthropic API key available (set vault claude.apiKey or ANTHROPIC_API_KEY)');
  }

  // Per-user engine home (spec §6): a user with a FIRST-PARTY key (vault
  // claude.apiKey / ANTHROPIC_API_KEY) runs every v2 turn under their own
  // CLAUDE_CONFIG_DIR so transcripts and credentials never cross tenants;
  // an ambient-auth user skips the override — the operator's login lives
  // under the default config dir, and redirecting it breaks their auth (see
  // the env composition below).
  //
  // The home is a property of the USER's Claude auth, not of the turn: a
  // gateway turn (Anthropic-compatible custom provider, always keyed with the
  // provider's own token) lives wherever that user's Claude turns live. The
  // SDK transcript can only be resumed from the home it was written in, so
  // deciding per turn ("keyed → per-user home") made an ambient user's chat
  // change homes on every Claude ↔ GLM switch: resume missed, the client's
  // fresh-session retry started over, and the route's fresh-turn cleanup
  // deleted the old transcript — the conversation's memory was gone for good.
  // One home per user keeps Claude and gateway turns on one transcript (the
  // SDK resumes across model changes). The gateway token rides in env, which
  // the CLI honors ahead of any login stored in the home — the same premise
  // as running `claude` against a gateway on a logged-in machine.
  //
  // Created up front (best-effort): the CLI would create it too, but if it
  // ever fell back to ~/.claude on a missing dir, isolation would be silently
  // gone — an empty dir is cheap insurance.
  const firstPartyKeyed = gatewayBaseUrl ? Boolean(resolveAnthropicKey(userId).key) : Boolean(key);
  const sdkHome = firstPartyKeyed ? agentSdkHomeFor(userId) : null;
  if (sdkHome) {
    try { fs.mkdirSync(sdkHome, { recursive: true }); } catch { /* SDK may still create it; best-effort */ }
  }

  const resume = typeof resumeSdkSessionId === 'string' && resumeSdkSessionId ? resumeSdkSessionId : null;
  // The SDK session this turn belongs to: the resumed id up front, then
  // whatever the stream reports (the init message carries it first).
  let currentSdkSessionId = resume;

  // Roots native Edit/Write may target — assigned right after
  // buildEngineOptions computes additionalDirectories; the canUseTool
  // closure reads it at call time, which is always after that assignment.
  let allowedWriteRoots = [];

  // Park one ToolApproval and await the human decision — the shared tail of
  // the act-tool branch and (Task 3) the native Edit/Write/Bash branch.
  // `args` is the structured payload the Mac renders as a diff; older
  // clients ignore it and keep reading argsSummary.
  const awaitToolApproval = async ({ toolName, argsSummary, args = null, input, callSignal }) => {
    const sessionId = currentSdkSessionId;
    const { requestId, promise } = registerDecision({ sdkSessionId: sessionId, userId, kind: 'ToolApproval' });
    const onAbort = () => { abortDecisionsForSession(sessionId); };
    const signals = [callSignal, signal].filter(Boolean);
    for (const s of signals) {
      if (s.aborted) onAbort();
      else s.addEventListener('abort', onAbort, { once: true });
    }
    const detach = () => { for (const s of signals) s.removeEventListener('abort', onAbort); };
    try {
      onEvent?.({ type: 'approval_request', requestId, kind: 'ToolApproval', toolName, argsSummary, ...(args ? { args } : {}) });
      const outcome = await promise;
      onEvent?.({ type: 'approval_resolved', requestId, outcome: outcome.action });
      if (outcome.action === 'always-allow') {
        setAlwaysAllow(userId, toolName);
        return { behavior: 'allow', updatedInput: input };
      }
      if (outcome.action === 'allow') return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: DENY_NO_ANSWER };
    } finally {
      detach();
    }
  };

  // DB-trusted indexed repos, resolved once per turn: the only places a test
  // runner may execute unprompted (tools/gates.mjs TEST_RUNNER_PATTERNS).
  const trustedRoots = buildTrustedRoots(userId);
  const canUseTool = async (toolName, input, callOpts) => {
    const registryName = toolName.startsWith('mcp__llmide__') ? toolName.slice('mcp__llmide__'.length) : null;
    const entry = registryName ? registryGet(registryName) : null;
    if (toolName !== 'AskUserQuestion' && !(entry && entry.kind === 'act') && !NATIVE_GATED.has(toolName)) {
      return { behavior: 'deny', message: DENY_UNKNOWN_TOOL };
    }
    if (NATIVE_GATED.has(toolName)) {
      const requestedMode = typeof mode === 'string' && mode ? mode : 'execute';
      if (restrictsTools(requestedMode)) {
        return { behavior: 'deny', message: `${toolName} is not available in ${requestedMode} mode.` };
      }
      if (toolName === 'Bash') {
        // The SDK runs native Bash in cwd=workspaceRoot (buildEngineOptions),
        // so relative path tokens are judged against that directory.
        const decision = runBashGate(input?.command, workspaceRoot, { trustedRoots });
        if (decision === 'blocked') return { behavior: 'deny', message: 'Command blocked for safety.' };
        if (decision === 'auto' || hasAlwaysAllow(userId, 'Bash')) {
          return { behavior: 'allow', updatedInput: input };
        }
        return awaitToolApproval({
          toolName: 'Bash', argsSummary: String(input?.command ?? ''),
          args: approvalArgsFor('Bash', input), input, callSignal: callOpts?.signal,
        });
      }
      // Edit / Write — containment first; a 'blocked' path is final.
      if (writePathGate(input?.file_path, allowedWriteRoots) === 'blocked') {
        return { behavior: 'deny', message: `${toolName} refused: the target must stay inside the project workspace.` };
      }
      if (hasAlwaysAllow(userId, toolName)) return { behavior: 'allow', updatedInput: input };
      return awaitToolApproval({
        toolName, argsSummary: String(input?.file_path ?? ''),
        args: approvalArgsFor(toolName, input), input, callSignal: callOpts?.signal,
      });
    }
    if (entry && entry.kind === 'act') {
      // Mode restriction, belt-and-braces with buildEngineOptions'
      // disallowedTools: a restricted mode (plan/review/document) exposes the
      // same roster the legacy engine's dispatch is filtered to, and an act
      // tool outside that roster is refused here even if it somehow reached
      // the model. Without this, dropping run-bash from `allowedTools` would
      // merely demote it to a canUseTool consult that the 'auto' tier allows.
      const requestedMode = typeof mode === 'string' && mode ? mode : 'execute';
      if (restrictsTools(requestedMode) && !allowedToolNames(requestedMode).has(entry.name)) {
        return { behavior: 'deny', message: `${entry.name} is not available in ${requestedMode} mode.` };
      }
      // The gate runs FIRST and unconditionally — 'blocked' is a hard safety
      // rail: a blocked command stays blocked even if the tool was
      // always-allowed, so hasAlwaysAllow must never be consulted before
      // it. Doing so would let a user who once always-allowed e.g. run-bash
      // bypass the blocklist entirely for every later command under that
      // same tool name. always-allow only ever shortcuts the PROMPT tier
      // (below) — skipping the interactive approval, never the gate itself.
      const decision = entry.gate(input);
      if (decision === 'blocked') return { behavior: 'deny', message: 'Command blocked for safety.' };
      if (decision === 'auto') return { behavior: 'allow', updatedInput: input };
      // decision === 'prompt' — always-allow (kb/tool-approvals.mjs) skips
      // straight to auto-run here, exactly as it would after a live
      // 'always-allow' answer below; a fresh 'prompt' decision genuinely
      // blocks on a human when no such row exists.
      if (hasAlwaysAllow(userId, entry.name)) return { behavior: 'allow', updatedInput: input };
      // Genuinely block on a human decision, parked
      // the same way an AskUserQuestion is (requestId, approval_request/
      // approval_resolved events, abort-on-disconnect).
      return awaitToolApproval({
        toolName: entry.name,
        argsSummary: JSON.stringify(input),
        input,
        callSignal: callOpts?.signal,
      });
    }
    // Park the decision; the SDK await below may legitimately block for
    // minutes while a human decides on the other side of the SSE stream.
    // Snapshot the session id the entry is parked under — the abort paths
    // below must target that same session even if the stream reports a new
    // one before the human answers.
    const sessionId = currentSdkSessionId;
    const { requestId, promise } = registerDecision({ sdkSessionId: sessionId, userId, questions: input.questions });
    // An aborted turn denies the parked approval NOW, not at the registry's
    // 300 s timeout: the SDK hands canUseTool a per-call abort signal
    // (CanUseTool in sdk.d.ts), and the turn-level signal covers callers
    // that pass none. Session granularity is deliberate — one question at a
    // time per turn. Listeners come off the moment the decision settles
    // either way: the turn signal outlives any single question, so leaving
    // them armed would accumulate one listener per asked question.
    const onAbort = () => { abortDecisionsForSession(sessionId); };
    const signals = [callOpts?.signal, signal].filter(Boolean);
    for (const s of signals) {
      if (s.aborted) onAbort(); // already dead — a listener would never fire
      else s.addEventListener('abort', onAbort, { once: true });
    }
    const detach = () => { for (const s of signals) s.removeEventListener('abort', onAbort); };
    try {
      // A throwing onEvent must not strand the parked entry — its timer (and
      // the eventual settle's approval_resolved) would outlive the turn — so
      // un-park it before the throw escapes to the SDK.
      try {
        onEvent?.({ type: 'approval_request', requestId, kind: 'AskUserQuestion', questions: input.questions });
      } catch (err) {
        onAbort();
        throw err;
      }
      const outcome = await promise;
      onEvent?.({ type: 'approval_resolved', requestId, outcome: outcome.action });
      if (outcome.action === 'answer') {
        // SDK ≥2.1.207 rejects allow without updatedInput; answers pass
        // through verbatim (multi-select arrives comma-joined from the client).
        return { behavior: 'allow', updatedInput: { questions: input.questions, answers: outcome.answers } };
      }
      return { behavior: 'deny', message: DENY_NO_ANSWER };
    } finally {
      detach();
    }
  };

  const { queryOptions, prompt } = buildEngineOptions(
    { userId, mode, model, language, message, skills, agentContext, attachments, planExecute },
    { readSkill, roots, sessionMemory },
  );
  // Same validated roots the READ path uses (buildReadableRoots / `roots`) —
  // NOT the raw workspaceRoot string. A raw client-supplied workspaceRoot
  // (e.g. the user's home directory) has not been through isTooBroadRoot or
  // the `..`/non-absolute checks the read path applies, so building this set
  // from workspaceRoot directly would let native Edit/Write treat an
  // over-broad root as valid containment even though list-files/read-file
  // would refuse it outright (final whole-branch review, C1).
  allowedWriteRoots = roots({ userId, workspaceRoot: workspaceRoot || undefined });

  // Spec §7 — when the user's limits config yields a usable USD cap for the
  // model, cap this query's spend (the SDK stops with an error_max_budget_usd
  // result). Only the REQUESTED model is consulted: an unspecified model is
  // resolved by the SDK itself at init, after composition — capping against a
  // guess would cap the wrong budget. See resolveMaxBudgetUsd for exactly
  // what the limits system stores and why runs/tokens caps don't map here.
  const maxBudgetUsd = resolveBudget(userId, model, { provider: auth.provider });

  // Per-user plugin view (spec parity with the legacy loop's route.mjs):
  // cheap enough to build per turn so a user toggling a plugin in Settings
  // is reflected immediately. userSkills/userSubagents feed ask-internal/
  // ask-subagent (llm_agent/tools/registry.mjs); internalSkills.base is the
  // fence-contract markdown both handlers prepend — same shape route.mjs
  // passes into buildDispatch (`{ base: internalSkills.base }`), not the raw
  // module export.
  const { skills: userSkills, subagents: userSubagents } = buildPerUserSkillSet(userId);

  // The user's consented MCP servers ride alongside the in-process llmide
  // server, with their server-level specs appended to the allowlist composed
  // by buildEngineOptions.
  const userMcp = buildUserMcpServers(userId, mode);
  // How this user's enabled plugins reach the SDK. By default a Claude-format
  // package is handed over whole (`plugins`) so the SDK loads it and runs its
  // hooks with full fidelity; the `nativePlugins` pref turns that off and falls
  // back to llm-ide translating the plugin's `command` hooks itself. Either
  // way hook trust gates execution and nothing runs twice — see
  // buildUserPluginDelivery. Hook commands run in the turn's workspace so a
  // plugin script sees the repo the user is actually working in.
  const pluginDelivery = buildUserPluginDelivery(userId, {
    nativeEnabled: nativePluginsEnabled(userId),
    cwd: queryOptions.cwd,
    onNote: (note) => console.warn(note),
  });
  const q = queryFactory(prompt, {
    ...queryOptions,
    ...(userMcp.allowedTools.length
      ? { allowedTools: [...(queryOptions.allowedTools || []), ...userMcp.allowedTools] }
      : {}),
    ...(pluginDelivery.sdkPlugins.length ? { plugins: pluginDelivery.sdkPlugins } : {}),
    ...(Object.keys(pluginDelivery.hooks).length ? { hooks: pluginDelivery.hooks } : {}),
    mcpServers: {
      llmide: buildLlmIdeServer(userId, agentContext, message, {
        runClaude,
        userSkills,
        userSubagents,
        internalSkills: { base: internalSkills.base },
      }),
      ...userMcp.servers,
    },
    canUseTool,
    maxTurns: MAX_TURNS,
    ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
    // `env` REPLACES the subprocess environment — always spread process.env.
    // The key (when one resolved) and the per-user engine home ride along in
    // the SAME composed env. The engine home rides ONLY for users with a
    // first-party key (see sdkHome above): an ambient-auth user depends on
    // the operator's `claude login`, whose credentials/onboarding state live
    // under the operator's DEFAULT config dir — redirecting CLAUDE_CONFIG_DIR
    // to the (empty) per-user home makes the subprocess "Not logged in" and
    // fails every ambient turn. Tenant isolation of transcripts is therefore
    // a property of first-party-keyed users; ambient users all run as the
    // operator anyway (their gateway turns included — the gateway token is
    // in env, the home only holds transcripts), so there is no cross-tenant
    // credential exposure to isolate against. Two accepted consequences:
    // ambient turns can discover operator-level agents/skills/plugins/MCP
    // config from the default config dir (settingSources: [] only isolates
    // SETTINGS), and all ambient tenants' transcripts share that dir — the
    // same exposure class as the filesystem itself, which this never
    // sandboxed. A user who later adds or removes their vault key changes
    // homes and their next resume misses — SESSION_UNRESUMABLE, which the
    // client recovers from with a fresh-session retry.
    ...(key
      ? {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: key,
            // Gateway turn (Anthropic-compatible custom provider): aim the
            // SDK's CLI at the provider's Anthropic door. The key rides in
            // BOTH shapes because gateways differ — Z.AI and Ollama document
            // ANTHROPIC_AUTH_TOKEN (Authorization: Bearer), DeepSeek documents
            // ANTHROPIC_API_KEY (x-api-key). First-party turns leave whatever
            // ANTHROPIC_BASE_URL the operator's process.env carries untouched,
            // exactly as before.
            ...(gatewayBaseUrl ? { ANTHROPIC_BASE_URL: gatewayBaseUrl, ANTHROPIC_AUTH_TOKEN: key } : {}),
            ...(sdkHome ? { CLAUDE_CONFIG_DIR: sdkHome } : {}),
          },
        }
      : {}),
    ...(resume ? { resume } : {}),
    ...(signal ? { signal } : {}),
  });

  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };
  let result = null;
  let replyText = '';
  try {
    for await (const msg of q) {
      if (msg?.session_id) currentSdkSessionId = msg.session_id;
      for (const ev of mapSdkMessage(msg)) {
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          replyText += ev.text;
        } else if (ev.type === 'usage') {
          usageTotals.inputTokens += ev.inputTokens;
          usageTotals.outputTokens += ev.outputTokens;
          usageTotals.cacheReadTokens += ev.cacheReadTokens;
        } else if (ev.type === 'result') {
          result = ev;
          usageTotals.costUsd += ev.costUsd ?? 0;
          usageTotals.numTurns += ev.numTurns ?? 0;
          usageTotals.durationMs += ev.durationMs ?? 0;
        }
        onEvent?.(ev);
      }
    }
  } catch (err) {
    // A resume the SDK cannot honor (session pruned / cleared) is
    // recoverable at the route layer: drop the mapping and start fresh.
    if (resume && /session|conversation|resume/i.test(String(err?.message ?? ''))) {
      throw Object.assign(new Error(err?.message ?? String(err)), { code: 'SESSION_UNRESUMABLE' });
    }
    // The SDK reports EVERY spawn-time failure of an existing CLI binary as a
    // libc/musl mismatch (errorClass 'executable_launch_failed'), which on
    // macOS is never the real cause: the arm64 binary is fine and the actual
    // errno — attached to the error as `code` — is almost always a cwd
    // problem (EPERM/EACCES on a TCC-protected workspace, ENOENT/ENOTDIR on a
    // stale one). Restate it with the errno and the cwd so the message points
    // at something the user can act on instead of at their libc.
    if (err?.errorClass === 'executable_launch_failed') {
      throw new Error(
        `Claude Code failed to launch (${err?.code ?? 'unknown'}) with cwd ${workspaceRoot}. `
        + 'The binary itself is fine; a spawn error at this point is a working-directory problem — '
        + 'on macOS usually a privacy (TCC) denial on that folder for the app that spawned the server. '
        + `Original SDK message: ${err?.message ?? String(err)}`,
      );
    }
    throw err;
  }
  // Auto project/session-memory capture — the v2 parity for the legacy
  // loop's persistTurnMemory call (llm_agent/runtime/route.mjs): distills
  // durable facts from this turn and writes them to BOTH the project's
  // chat-memory.md (read back next turn via the project_memory tool) and
  // the DB-backed per-session copy (kb/session-memory.mjs, read back above)
  // from ONE extraction pass. Fire-and-forget — never awaited, so it adds no
  // latency to the turn — and persistTurnMemory swallows all of its own
  // errors; the trailing catch is belt-and-braces.
  if (replyText) {
    void persistMemory({ agentContext, userId, userMessage: message, reply: replyText, runClaude }).catch(() => {});
  }
  return { result, usageTotals };
}
