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
import { personaForMode, PLAN_LIKE_MODES } from '../runtime/mode-personas.mjs';
import { readSkillInstructions, buildPerUserSkillSet, internalSkills } from '../skills/index.mjs';
import { buildReadableRoots } from '../runtime/handlers/repo-files.mjs';
import { redactFence } from '../runtime/redaction.mjs';
import { persistTurnMemory } from '../runtime/memory-persist.mjs';
import { config } from '../../core/config.mjs';
import { sanitizeForPrompt } from '../../core/utils.mjs';
import { selectAttachments, buildSkillsText } from '../../core/prompt-framing.mjs';
import { getDb } from '../../kb/db.mjs';
import { usdCapForModel } from '../../kb/usage.mjs';
import { listSessionMemory, resolveChatSessionId } from '../../kb/session-memory.mjs';
import { getSecret } from '../../server/vault.mjs';
import { runClaude as runClaudeImpl } from '../../providers/runtime.mjs';
import { mapSdkMessage } from './events.mjs';
import { buildLlmIdeServer } from './tools.mjs';
import { registerDecision, abortDecisionsForSession } from './decisions.mjs';

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

// --- Per-user engine homes (spec §6/§11) --------------------------------------
//
// CLAUDE_CONFIG_DIR = <dataDir>/agent-sdk/<userId>/ isolates each tenant's
// SDK transcripts and credentials (settingSources: [] isolates the operator's
// SETTINGS; the config dir isolates everything else the SDK writes). The base
// follows the server's canonical data dir — the DB's directory (core/config:
// <repo>/kb by default, wherever LLMIDE_DB_PATH points) — so engine homes sit
// next to the other per-install runtime data. User ids are server-minted hex
// (users.mjs); the charset guard keeps even a hand-edited id from escaping
// the base via path traversal. Shared by the runner (composes the env every
// turn) and the route's transcript cleanup — one derivation, never two.

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

// The v2 tool allowlist: Claude Code read-only built-ins plus every
// registry-mounted `read`-kind llmide tool, named explicitly (Task 4 —
// llm_agent/tools/registry.mjs is the single source of truth for the mounted
// set; this list mirrors its `kind: 'read'` entries so an SDK permission
// check has real names to match against instead of a wildcard). No Bash/
// Write/Edit — a v2 chat turn is read-and-answer; writes keep their own
// approval flow. ask-internal/ask-subagent are read-only delegation tools
// already gated to safe sub-loops in the legacy engine — mounting them here
// is intentional parity, not new write capability. Mode restriction beyond
// this (save-plan for plan-like modes) is the permissionMode/persona pair
// below, not a different list: SDK plan mode already denies write tools
// while allowing read-only research.
const V2_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__llmide__ask-internal', 'mcp__llmide__ask-subagent',
  'mcp__llmide__web-search', 'mcp__llmide__fetch-url',
  'mcp__llmide__list-files', 'mcp__llmide__read-file', 'mcp__llmide__find-code',
  'mcp__llmide__search-kb', 'mcp__llmide__project_memory',
];

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
  { userId, mode, model, language, message, skills, agentContext, attachments } = {},
  { readSkill = readSkillInstructions, roots = buildReadableRoots, sessionMemory = listSessionMemory } = {},
) {
  const resolvedMode = typeof mode === 'string' && mode ? mode : 'execute';
  const persona = personaForMode(resolvedMode);
  const planLike = PLAN_LIKE_MODES.has(resolvedMode);

  const workspaceRoot = typeof agentContext?.workspaceRoot === 'string' ? agentContext.workspaceRoot : '';
  // All validated readable roots (DB repo allow-list ∪ the validated
  // workspace root). The SDK already grants cwd, so additionalDirectories
  // is the roots result minus cwd — indexed repos and any other roots.
  const allRoots = roots({ userId, workspaceRoot: workspaceRoot || undefined });
  const additionalDirectories = (Array.isArray(allRoots) ? allRoots : [])
    .filter((dir) => dir !== workspaceRoot);

  const { files, truncatedPaths } = capAttachments(attachments);

  const appendParts = [];
  if (typeof language === 'string' && language) appendParts.push(`Always respond in ${language}.`);
  if (persona) appendParts.push(persona);
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
    // Fresh array per call — V2_ALLOWED_TOOLS is a shared constant and must
    // never be handed to a caller that could mutate it.
    allowedTools: [...V2_ALLOWED_TOOLS],
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
export function resolveMaxBudgetUsd(userId, model, { usdCap = usdCapForModel } = {}) {
  return usdCap(getDb(), userId, 'anthropic', typeof model === 'string' && model ? model : null);
}

// v2 is read-and-answer: write/shell tools are not wired yet, so a deny with
// an instruction to re-plan reads better to the model than a silent hang.
const DENY_NEXT_RELEASE = 'Writes and shell commands arrive in the next engine release; re-plan using read-only tools.';
const DENY_NO_ANSWER = 'The user did not answer the question.';

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
  const workspaceRoot = typeof agentContext?.workspaceRoot === 'string' ? agentContext.workspaceRoot : '';
  if (!workspaceRoot) throw new Error('workspaceRoot is required');

  // Same auth ladder as the spike: per-user vault key → operator ambient
  // auth. Ambient is opt-in so hermetic tests can assert the no-key error.
  const { key } = resolveAnthropicKey(userId);
  if (!key && !allowAmbientAuth) {
    throw new Error('No Anthropic API key available (set vault claude.apiKey or ANTHROPIC_API_KEY)');
  }

  // Per-user engine home (spec §6): EVERY v2 turn — keyed or ambient — runs
  // with its own CLAUDE_CONFIG_DIR so transcripts and credentials never cross
  // tenants. Created up front (best-effort): the CLI would create it too, but
  // if it ever fell back to ~/.claude on a missing dir, isolation would be
  // silently gone — an empty dir is cheap insurance.
  const sdkHome = agentSdkHomeFor(userId);
  if (sdkHome) {
    try { fs.mkdirSync(sdkHome, { recursive: true }); } catch { /* SDK may still create it; best-effort */ }
  }

  const resume = typeof resumeSdkSessionId === 'string' && resumeSdkSessionId ? resumeSdkSessionId : null;
  // The SDK session this turn belongs to: the resumed id up front, then
  // whatever the stream reports (the init message carries it first).
  let currentSdkSessionId = resume;

  const canUseTool = async (toolName, input, callOpts) => {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'deny', message: DENY_NEXT_RELEASE };
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
    { userId, mode, model, language, message, skills, agentContext, attachments },
    { readSkill, roots, sessionMemory },
  );

  // Spec §7 — when the user's limits config yields a usable USD cap for the
  // model, cap this query's spend (the SDK stops with an error_max_budget_usd
  // result). Only the REQUESTED model is consulted: an unspecified model is
  // resolved by the SDK itself at init, after composition — capping against a
  // guess would cap the wrong budget. See resolveMaxBudgetUsd for exactly
  // what the limits system stores and why runs/tokens caps don't map here.
  const maxBudgetUsd = resolveBudget(userId, model);

  // Per-user plugin view (spec parity with the legacy loop's route.mjs):
  // cheap enough to build per turn so a user toggling a plugin in Settings
  // is reflected immediately. userSkills/userSubagents feed ask-internal/
  // ask-subagent (llm_agent/tools/registry.mjs); internalSkills.base is the
  // fence-contract markdown both handlers prepend — same shape route.mjs
  // passes into buildDispatch (`{ base: internalSkills.base }`), not the raw
  // module export.
  const { skills: userSkills, subagents: userSubagents } = buildPerUserSkillSet(userId);

  const q = queryFactory(prompt, {
    ...queryOptions,
    mcpServers: {
      llmide: buildLlmIdeServer(userId, agentContext, message, {
        runClaude,
        userSkills,
        userSubagents,
        internalSkills: { base: internalSkills.base },
      }),
    },
    canUseTool,
    maxTurns: MAX_TURNS,
    ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
    // `env` REPLACES the subprocess environment — always spread process.env.
    // The key (when one resolved) and the per-user engine home ride along in
    // the SAME composed env; an ambient-auth turn sets no key but still gets
    // its tenant-isolated CLAUDE_CONFIG_DIR.
    ...(key || sdkHome
      ? {
          env: {
            ...process.env,
            ...(key ? { ANTHROPIC_API_KEY: key } : {}),
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
