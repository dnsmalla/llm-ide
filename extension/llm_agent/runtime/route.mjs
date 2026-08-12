// /code-assist handler logic. Orchestrates the global agent and
// delegates to ask-internal when needed. The thin route file in
// extension/server/ai-routes.mjs just builds the ctx and calls
// `handleCodeAssist`.
//
// All skill state (core skill loading, plugin skill caches, per-user
// views, the catalog) lives in the skills module —
// llm_agent/skills/registry.mjs. This file only orchestrates.

import { runAgentLoop, runNativeAgentLoop } from './loop.mjs';
import { askInternal } from './handlers/ask-internal.mjs';
import { askSubagent } from './handlers/ask-subagent.mjs';
import { handleWebSearch } from './handlers/web-search.mjs';
import { handleFetchUrl } from './handlers/fetch-url.mjs';
import { composeGlobalPrompt } from '../global/compose-prompt.mjs';
import { expandSlashCommand } from '../../plugins/loader.mjs';
import { globalSkills, internalSkills, buildPerUserSkillSet } from '../skills/index.mjs';
import { sanitizePersonaSuffix } from '../../providers/prompt-utils.mjs';
import { renderGraphifyMemory } from '../../graphkit/index.mjs';
import { persistTurnMemory } from './memory-persist.mjs';
import { buildReadableRoots, handleListFiles, handleReadFile } from './handlers/repo-files.mjs';
import { handleFindCode } from './handlers/find-code.mjs';
import { searchKb } from './handlers/search-kb.mjs';
import { handleRunBash } from './handlers/run-bash.mjs';
import { tasks, taskStatusIcon } from './handlers/session-tasks.mjs';
import { redactFence } from './redaction.mjs';
import { logger } from '../../core/logger.mjs';
import { GLOBAL_HANDLER_NAMES } from './global-handlers.mjs';
import { callOpenAI, providerApiKey, customBaseUrl, resolveProvider, resolveCustomProviderDispatch, assertSafeBaseUrlResolved } from '../../providers/providers.mjs';
import { skillsToOpenAITools } from './openai-tools.mjs';
import { classifyCodeAssistMode } from './mode-classify.mjs';
import { personaForMode, restrictsTools, allowedToolNames } from './mode-personas.mjs';
import { classifyTaskType } from './task-skill-routing.mjs';
import { readSkillInstructions } from '../skills/skill-library.mjs';
import { buildMcpConfigForUser } from '../../mcp/mcp-config.mjs';

// Re-exported for the HTTP routes that historically imported these
// from here (server/auth-routes.mjs, routes/agent.mjs import the
// skills module directly now; this re-export keeps any stragglers and
// external integrations working).
export { reloadPlugins, listAllSkills, listInstalledPlugins } from '../skills/index.mjs';

// Per-tier model overrides. The global agent (user-facing chat), the
// internal agent (app-state reasoning), and plugin subagents (leaf
// calls) have different cost/quality profiles — e.g. a cheaper model
// for subagent leaf calls, a stronger one for global synthesis.
// Unset → runClaude's LLMIDE_MODEL default.
const GLOBAL_AGENT_MODEL = process.env.LLMIDE_AGENT_MODEL || undefined;
const INTERNAL_AGENT_MODEL = process.env.LLMIDE_INTERNAL_MODEL || GLOBAL_AGENT_MODEL;
const SUBAGENT_MODEL = process.env.LLMIDE_SUBAGENT_MODEL || GLOBAL_AGENT_MODEL;

// Pre-compose the global prompt body that runAgentLoop will use.
// We pass it as `agentContext.base` so the existing composer in
// loop.mjs picks it up; the rest of the agentContext fields are
// intentionally empty so no app-state leaks into global's prompt.
const globalPromptBase = composeGlobalPrompt();

// System prompt for the native tool-calling loop (deepseek/openai/custom).
// Intentionally tool-oriented and fence-free: the skill definitions travel in
// the OpenAI `tools` param, so the prompt must NOT also describe them via the
// <<<TOOL_CALL>>> fence (that caused the model to emit write-tool fences and
// loop). Mirrors how Cursor/IDE agents keep the static prompt minimal for
// caching and let the tools array carry capability.
const NATIVE_SYSTEM_PROMPT = [
  'You are the LLM-IDE Code Assistant. Help the user by calling the provided tools.',
  'To locate code, ALWAYS call find-code first (symbol index + code graph) and read',
  'only the lines it points at — never open with a grep. Use run-bash to run a shell',
  'command, list-files / read-file for the workspace,',
  'search-kb for meetings/notes/issues, web-search / fetch-url for the web,',
  'ask-internal for app state. Call a tool when action is needed; its result comes',
  'back to you automatically. Once you have what you need, answer the user concisely.',
  'Never print a command for the user to copy — call the tool.',
].join(' ');

/**
 * Restricted modes (plan/review/document) must never surface a write-tool
 * pendingTool, even one that leaked through ask-internal's unfiltered
 * nested delegation (see the comment in mode-personas.mjs — that path is
 * NOT filtered to this feature's tool allowlist). This is the actual
 * enforcement point for that guarantee; kept as a small pure function so
 * it's directly unit-testable without driving a real agent-loop call.
 */
export function enforceModeToolRestriction(out, resolvedMode) {
  if (restrictsTools(resolvedMode) && out?.pendingTool) {
    return { ...out, pendingTool: null };
  }
  return out;
}

export async function handleCodeAssist({
  message,
  history,
  agentContext,             // arrives from the client; ONLY internal consumes it
  attachmentsText,          // sanitized attachment block (optional)
  skillsText,               // trusted, followable skill-instruction block (optional)
  languageDirective,        // "Respond in <lang>" style line (optional)
  runClaude,
  kb,
  userId,
  onProgress,               // optional: live status callback (SSE → client)
  onChunk,                  // optional: live text-delta callback (SSE → client), fence-loop only
  maxIterations: maxIterationsOverride,  // optional: override for tests
  model,                    // resolved model id (from the client) — routes native vs fence loop
  provider,                 // explicit provider id from the client, if any
  mode: requestedMode,      // NEW — "auto" | "plan" | "review" | "document" | "execute" | undefined
  // Test seam only — defaults to the real classifier. ESM named exports
  // can't be redefined by node:test's mock.method (module namespace
  // properties are non-configurable), and mock.module() needs
  // --experimental-test-module-mocks, which the CI Node (20, see
  // .github/workflows/extension-ci.yml) doesn't support. Mirrors the
  // _runClaude seam mode-classify.mjs already uses for the same reason.
  _classifyMode = classifyCodeAssistMode,
}) {
  // Per-user plugin view. Building it is cheap (Map clone + readdir
  // for each enabled plugin's skills/). Done per request so a user
  // toggling a plugin in Settings is reflected immediately.
  const { skills: userSkills, commands: userCommands, subagents: userSubagents } = buildPerUserSkillSet(userId);

  // Resolve the request's mode. Missing/undefined behaves exactly like
  // "execute" (back-compat with clients that don't send the field yet).
  // "auto" classifies the message; classification failure already falls
  // back to "execute" inside classifyCodeAssistMode itself.
  const resolvedMode = requestedMode === 'auto'
    ? (await _classifyMode(message, { userId })).mode
    : (requestedMode || 'execute');

  // MCP plugins (Claude CLI path only). Restricted modes get none; execute
  // modes get the user's enabled+consented servers as --mcp-config. Subagents
  // and the internal agent never receive MCP (global-agent-only for SP1).
  const mcpConfig = buildMcpConfigForUser(userId, { mode: resolvedMode, restrictsToolsFn: restrictsTools });

  // Slash-command expansion. If the user's message starts with /foo,
  // look it up against the enabled command set and expand the prompt
  // template before the agent runs. The expanded text replaces the
  // original message; we surface a small note in `expandedFrom` so
  // the response renderer can show "(via /foo)" if it wants.
  let effectiveMessage = message;
  let expandedFrom = null;
  if (typeof message === 'string' && message.trim().startsWith('/')) {
    const expansion = expandSlashCommand(message, userCommands);
    if (expansion && expansion.error) {
      return { reply: expansion.error, pendingTool: null };
    }
    if (expansion) {
      effectiveMessage = expansion.prompt;
      expandedFrom = expansion.trigger;
    }
  }

  // The agent path historically only forwarded `message`, dropping the
  // attachment block + language directive that the legacy non-agent
  // path embedded. Restitch them in front of the user message so the
  // global agent sees the same context the user provided.
  // skillsText goes BEFORE attachmentsText: skills are instructions to follow,
  // attachments are data to act on — the agent should read the workflow first,
  // then the material it applies to.
  const composedUserMessage = [
    languageDirective || '',
    skillsText || '',
    attachmentsText || '',
    effectiveMessage || '',
  ].filter((s) => typeof s === 'string' && s.length > 0).join('\n\n');

  // Persona suffix appended to the global agent's system prompt so
  // code-assist answers in the user's configured voice without
  // changing the tool-calling contract (skills + ask-internal +
  // ask-subagent are above it). Empty string when no persona — no
  // token cost for users who haven't customised. Wrapped in
  // try/catch because a stray DB error here shouldn't break the
  // code-assist path; we just lose the persona this request.
  let personaBase = globalPromptBase;
  try {
    if (kb && userId && typeof kb.getAgentPersona === 'function') {
      const persona = kb.getAgentPersona(userId);
      // Sanitize both the name and the suffix before embedding.
      // sanitizePersonaSuffix strips fence tokens (<<<…>>>) and common
      // injection openers; using it on the name too ensures a persona
      // named "<<<TOOL_CALL>>>…" can't forge a write-tool invocation
      // inside the system prompt.  Name is hard-capped at 80 chars;
      // suffix uses the standard PERSONA_SUFFIX_EMBED_MAX (600).
      const name   = sanitizePersonaSuffix((persona?.name   || '').trim()).slice(0, 80);
      const suffix = sanitizePersonaSuffix((persona?.promptSuffix || '').trim());
      if (name || suffix) {
        let prefix = '\n\n---\nPersona\n';
        if (name)   prefix += `You are also known to the user as ${name}; sign off in that voice when natural.\n`;
        if (suffix) prefix += `Voice & focus: ${suffix}\n`;
        personaBase = globalPromptBase + prefix;
      }
    }
  } catch { /* keep the un-persona'd base */ }

  // Repository memory (Graphify): inject the SAME compact, token-capped
  // repo-memory block the internal agent already gets — directly into the
  // GLOBAL agent's base. This is what lets the Code Assistant ground project
  // answers in real, auto-generated memory even when it answers directly
  // instead of delegating to ask-internal (the common case). It is the ONLY
  // app-specific context global receives: active project / issues / meetings /
  // capabilities still stay internal-only, preserving the lean-global split.
  // renderGraphifyMemory is self-gated — it enforces the per-user repo
  // allow-list, applies its own char caps (16 KB total / 2 repos / head-only
  // reads), and returns '' when there are no indexed repos or no userId — so
  // this adds nothing for users without a generated graph. Best-effort: a DB
  // or read error must never break code-assist. The block is run through
  // redactFence first: memory is derived from indexed-repo files (which can
  // include untrusted content — a dependency README, a generated doc), and the
  // global agent is the primary tool-emitter, so a stray `<<<TOOL_CALL>>>` in
  // repo content must not be able to prime a forged tool call from the system
  // prompt. (Same defense the loop applies to user messages / tool results.)
  // Per-request memory overhead, surfaced both in the log and the response
  // `usage` so the cost of the always-on memory block is visible in the app.
  let memoryChars = 0;
  let memoryHasChat = false;
  try {
    const memStats = [];
    const memBlock = renderGraphifyMemory(agentContext, userId, memStats, message);
    if (memBlock) {
      personaBase += `\n\n${redactFence(memBlock)}`;
      memoryChars = memBlock.length;
      memoryHasChat = memBlock.indexOf('chat-memory.md') !== -1;
    }
    // ~4 chars/token is a rough English estimate. hasChatMemory is the share
    // from the chat-capture pipeline (vs graph-derived repo.md/graph-notes/
    // doc-notes), so you can see how much the LLM-extracted half adds. `files`
    // is the per-file breakdown of what actually reached the agent (name,
    // injected chars, whether budget-truncated) so an answer's grounding — and
    // any dropped content — is visible in the logs instead of silent.
    logger.info('memory_context', {
      chars: memoryChars,
      approxTokens: Math.round(memoryChars / 4),
      hasChatMemory: memoryHasChat,
      files: memStats,
      truncatedAny: memStats.some((s) => s.truncated),
    });
  } catch { /* memory is best-effort — keep the base without it */ }

  // Inject session task list so the agent always sees its own task state.
  // Gated on !restrictsTools(resolvedMode) — a restricted mode (plan/
  // review/document) never tracks a multi-step plan itself, but a PRIOR
  // turn in the same session could have left real tasks behind (tasks are
  // keyed only by userId:sessionId, with no mode dimension, and are never
  // cleared on a mode switch) — without this gate, a later restricted-mode
  // turn would inject stale Execute-mode task-list/skill-guidance text into
  // a prompt whose tools have already been stripped to read-only,
  // contradicting that mode's own persona one paragraph later.
  const sessionId = agentContext?.sessionId;
  const sessionTasks = tasks.listTasks(userId, sessionId);
  if (sessionTasks.length > 0 && !restrictsTools(resolvedMode)) {
    const taskLines = sessionTasks.map((t) => `- ${taskStatusIcon(t.status)} (id:${t.id}) ${t.title}`).join('\n');
    personaBase += `\n\n## Your current task list\n${taskLines}\n\nLegend: [ ] pending  [~] in_progress  [x] completed  [-] skipped  [!] failed`;

    // Per-step skill auto-routing (Execute mode, naturally — plan/review/
    // document personas forbid task tracking, and the tool allowlist for
    // those modes excludes task-create/task-update, so sessionTasks is
    // empty for those and this block simply doesn't run). Frozen for the
    // whole HTTP turn, same as the task-list block above — loop.mjs never
    // re-reads task state mid-loop.
    const activeTask = sessionTasks.find((t) => t.status === 'in_progress')
                     || sessionTasks.find((t) => t.status === 'pending');
    if (activeTask) {
      const skillId = classifyTaskType(activeTask.title);
      const instructions = skillId ? readSkillInstructions(skillId, userId) : null;
      if (instructions) {
        personaBase += `\n\n## Guidance for your current task ("${activeTask.title}")\n${instructions.content}`;
      }
    }
  }

  // Mode persona addition — appended after the task-list/skill-routing
  // blocks above so it reads as the most recent, highest-priority
  // instruction. No-op ("") for execute/unrecognised modes.
  const modePersona = personaForMode(resolvedMode);
  if (modePersona) personaBase += `\n\n${modePersona}`;

  // Global handler set: ask-internal (for app-state-aware questions)
  // plus ask-subagent (for plugin-defined named delegates). The
  // ask-subagent handler is registered unconditionally — when no
  // plugin defines a subagent the user's subagent Map is empty and
  // any invocation gets a helpful "unknown subagent" error rather
  // than a tool-not-found.
  // Roots the file tools may read within: the DB-registered (indexed) repos
  // plus the open workspace folder the client sent. Built per request so a
  // project switch / new index is reflected immediately, and so the gate reads
  // the allow-list fresh from the DB rather than trusting the client.
  const readableRoots = buildReadableRoots({ userId, workspaceRoot: agentContext?.workspaceRoot });

  const handlers = {
    'ask-internal': (args, loopCtx) => askInternal(args, {
      agentContext,
      runClaude,
      kb,
      userId,
      // loopCtx.depth is already incremented by the loop engine —
      // forward it verbatim.
      depth: loopCtx?.depth ?? 1,
      // Pass the per-user view; ask-internal already reads
      // ctx.internalSkills.{skills, base}.
      internalSkills: {
        skills: userSkills,
        base: internalSkills.base,
      },
      model: INTERNAL_AGENT_MODEL,
    }),
    'ask-subagent': (args, loopCtx) => askSubagent(args, {
      runClaude,
      kb,
      userId,
      subagents: userSubagents,
      defaultModel: SUBAGENT_MODEL,
      // loopCtx.depth is already incremented by the loop engine —
      // forward it verbatim.
      depth: loopCtx?.depth ?? 1,
      // Subagents that declare allowed_tools need the fence-shape
      // contract; reuse internal's _base.md so authors don't have to
      // duplicate the protocol description.
      internalSkillsBase: internalSkills.base,
    }),
    // Web tools resolve their own backend (Anthropic API key → native
    // web_search/web_fetch, else the `claude` CLI's built-in tools, else
    // SerpAPI/direct fetch). They only need the userId to look up a
    // per-user Anthropic/SerpAPI key.
    'web-search': (args) => handleWebSearch(args, { userId }),
    'fetch-url': (args) => handleFetchUrl(args, { userId }),
    // Read-only repo file access, scoped to the open workspace + the user's
    // indexed repos (built fresh per request from the DB allow-list + the
    // client's workspaceRoot; see buildReadableRoots for the security gate).
    // This is what lets "find the README and review it" work without an attach.
    'list-files': (args) => handleListFiles(args, { roots: readableRoots }),
    'read-file': (args) => handleReadFile(args, { roots: readableRoots }),
    // Index→graph code search. Turns "where is X / what touches X" into ONE
    // call against the symbol index + code graph + FTS, instead of the grep
    // loop the agent used to run (see handlers/find-code.mjs for the cost
    // rationale). Same readable-roots gate as read-file, so every path it
    // hands back is one the agent is allowed to open.
    'find-code': (args) => handleFindCode(args, {
      userId,
      roots: readableRoots,
      // Same root run-bash uses as its cwd, so the `sed -n` follow-up this tool
      // recommends runs against the tree the returned paths are relative to.
      workspaceRoot: agentContext?.workspaceRoot,
    }),
    // KB search: meetings, decisions, action items, sources — the same FTS
    // the internal agent uses, now first-class so "what did we decide about
    // X?" doesn't need an ask-internal round-trip.
    'search-kb': (args) => searchKb(args, { kb, userId }),
    'task-list': () => {
      const sessionId = agentContext?.sessionId;
      return { tasks: tasks.listTasks(userId, sessionId) };
    },
    'task-create': (args) => {
      const sessionId = agentContext?.sessionId;
      return tasks.createTask(userId, sessionId, args.title);
    },
    'task-update': (args) => {
      const sessionId = agentContext?.sessionId;
      return tasks.updateTask(userId, sessionId, args.taskId, {
        status: args.status,
        title: args.title,
      });
    },
    'run-bash': (args) => handleRunBash(args, {
      workspaceRoot: agentContext?.workspaceRoot,
    }),
  };

  // Drift guard: this handlers map and GLOBAL_HANDLER_NAMES (imported from
  // global-handlers.mjs, the single source of truth also used by
  // skills/registry.mjs's startup wiring check) must name exactly the same
  // handlers. Without this, adding a branch here without updating
  // global-handlers.mjs — or vice versa — would ship silently: the startup
  // check only validates skill-files-have-a-handler-NAME, it never
  // cross-checks against what's actually wired up here. Throwing at request
  // time (cheap Set/array comparison, not a perf concern) turns that class
  // of bug into an immediate, loud failure instead of a runtime
  // "no handler for X" surprise deep in a user session.
  const wiredNames = Object.keys(handlers);
  const expectedNames = GLOBAL_HANDLER_NAMES;
  if (wiredNames.length !== expectedNames.length || !expectedNames.every((n) => wiredNames.includes(n))) {
    throw new Error(
      `[llm_agent] global handler drift: route.mjs wires [${wiredNames.sort().join(', ')}] but ` +
      `global-handlers.mjs declares [${[...expectedNames].sort().join(', ')}] — keep both in sync.`,
    );
  }

  // Native tool-calling loop for OpenAI-compatible providers (deepseek/openai/
  // custom) AND user-registered custom:<uuid> providers. They speak the OpenAI
  // function-calling API, so use the proper messages-based loop (Cursor/OpenAI
  // pattern: results fed back as native `tool` messages, natural termination)
  // instead of the text-fence loop, which those models don't follow and which
  // loops when results come back as fences.
  const NATIVE_PROVIDERS = new Set(['deepseek', 'openai', 'custom']);
  const effProvider = (typeof provider === 'string' && provider) || resolveProvider(model);

  // If the caller explicitly selected a non-Anthropic provider (custom, glm,
  // deepseek, custom:<uuid>, …) but supplied no model, fail loudly with an
  // actionable error. Without this guard the request silently fell through to
  // the Anthropic runAgentLoop branch below — because the native branch
  // requires a model (`if (nativeKey && model)`) — so a Custom/GLM user with
  // no model picked saw a confusing "claude is not logged in" instead of the
  // real problem ("pick a model"). The legitimate Anthropic default is
  // unaffected: when no provider is given, resolveProvider maps a bare/absent
  // model to 'anthropic', so effProvider is 'anthropic' and this guard skips.
  if (effProvider !== 'anthropic' && !(typeof model === 'string' && model.trim())) {
    throw new Error(`No model selected for provider "${effProvider}". Choose a model in the Code Assistant before sending.`);
  }

  // Resolve credentials for the native loop. Built-in native providers read
  // their key via the vault/env helpers; a user-registered custom:<uuid>
  // provider resolves through the registry + vault (resolveCustomProviderDispatch
  // throws a surfacable message if it isn't registered / has no key). Without
  // this branch a custom:<uuid> provider was silently dropped — nativeKey was
  // null and the request fell back to the Anthropic runAgentLoop below.
  let customResolved = null; // { apiKey, baseUrl, name } for custom:<uuid>
  let nativeKey = null;
  if (typeof effProvider === 'string' && effProvider.startsWith('custom:')) {
    const r = resolveCustomProviderDispatch(effProvider, userId);
    if (r.error) throw new Error(r.message);
    customResolved = r;
    nativeKey = r.apiKey;
  } else if (NATIVE_PROVIDERS.has(effProvider)) {
    nativeKey = providerApiKey(userId, effProvider);
  }

  // Computed once and shared by both loop branches below: the actual
  // dispatchable skill set for this turn's mode. A restricted mode
  // (plan/review/document) collapses to the explicit read-only allowlist;
  // execute/unrecognised modes get the full per-request skill map
  // unchanged. Previously this filter expression was duplicated between
  // the native loop's `skills:` and the fence loop's `skills:` — and the
  // native loop's `tools:` param used the UNFILTERED map, which meant the
  // model was advertised tools (run-bash, task-create/update/list — all
  // `kind: read`, so `{ readOnly: true }` alone doesn't drop them) that
  // its own dispatch would then reject as "Unknown tool" in restricted
  // modes. Both `skills:` and `tools:` now derive from this single map.
  const activeSkills = restrictsTools(resolvedMode)
    ? new Map([...globalSkills.skills].filter(([name]) => allowedToolNames().has(name)))
    : globalSkills.skills;

  let out;
  if (nativeKey && typeof model === 'string' && model) {
    const nativeBaseUrl = customResolved
      ? customResolved.baseUrl.replace(/\/+$/, '')
      : effProvider === 'custom' ? customBaseUrl(userId)
      : effProvider === 'deepseek' ? 'https://api.deepseek.com' : undefined;
    // SSRF guard once, before the loop. The native loop calls callOpenAI
    // directly (not completeViaApi), so a user-supplied custom base URL must be
    // checked here — this also closes a pre-existing gap for the generic
    // 'custom' provider, whose customBaseUrl() only applies the literal-IP check
    // (not the DNS-resolution check).
    if (nativeBaseUrl) await assertSafeBaseUrlResolved(nativeBaseUrl);
    out = await runNativeAgentLoop({
      systemPrompt: NATIVE_SYSTEM_PROMPT + (modePersona ? `\n\n${modePersona}` : ''),
      userMessage: composedUserMessage,
      history: Array.isArray(history) ? history : [],
      skills: activeSkills,
      // { readOnly: true } still needs to drop kind: write skills from
      // activeSkills for the unrestricted/execute case (activeSkills ===
      // globalSkills.skills there). For restricted modes activeSkills is
      // already allowlist-filtered, so this is a no-op — none of the
      // allowlisted names are kind: write anyway — but keeping the flag
      // is harmless and correct either way.
      tools: skillsToOpenAITools(activeSkills, { readOnly: true }),
      complete: (opts) => callOpenAI({ apiKey: nativeKey, model, baseUrl: nativeBaseUrl, ...opts }),
      userId,
      handlers,
      kb,
      onProgress,
      mcpConfig,
      maxIterations: maxIterationsOverride ?? 50,
      // No deadlineMs: a chat turn is bounded by its call budget and by the
      // user's cancel, not by a clock. See loop.mjs's DEFAULT_DEADLINE_MS.
    });
  } else {
    out = await runAgentLoop({
      skills: activeSkills,
      userMessage: composedUserMessage,
      history: Array.isArray(history) ? history : [],
      // base = global's composed prompt (role + ask-internal skill).
      agentContext: { base: personaBase },
      runClaude,
      kb,
      userId,
      handlers,
      onProgress,
      onChunk,
      model: GLOBAL_AGENT_MODEL,
      mcpConfig,
      maxIterations: maxIterationsOverride ?? 1000,  // global cap raised; see runAgentLoop DEFAULT_MAX_ITERATIONS (10)
      // No deadlineMs. This is the call that produced "reached the 360s
      // deadline — try again": a deep multi-hop turn legitimately outran the
      // cap and the user lost the whole reply. The iteration budget above and
      // the user's cancel bound it now; server.mjs's requestTimeout is disabled
      // to match, so the socket outlives the work instead of cutting it.
    });
  }

  // Belt-and-suspenders: a restricted mode must never surface a write-tool
  // pendingTool, even one that leaked through ask-internal's delegation
  // (its nested sub-loop isn't filtered to the mode's tool allowlist — see
  // the comment in mode-personas.mjs). Nothing executes automatically
  // either way (every pendingTool always requires separate client
  // confirmation), but a "Create issue?" card mid-"prose only" Plan-mode
  // chat would still contradict the mode's own persona text.
  out = enforceModeToolRestriction(out, resolvedMode);

  // Auto project-memory capture. Distill durable, project-specific facts from
  // this turn and merge them into the active repo's chat-memory.md, which
  // renderGraphifyMemory inlines into the prompt on the NEXT request (free
  // recall — no separate retrieval path). Fire-and-forget: it runs after the
  // reply is ready, is never awaited (zero added latency), and persistTurnMemory
  // swallows all of its own errors — the trailing .catch is belt-and-braces.
  if (out && out.reply) {
    void persistTurnMemory({
      agentContext,
      userId,
      userMessage: effectiveMessage,
      reply: out.reply,
      runClaude,
    }).catch(() => {});
  }

  // Surface the per-request memory overhead so the client can show it (and the
  // user can judge whether the always-on memory block is worth its tokens).
  const memoryUsage = { chars: memoryChars, approxTokens: Math.round(memoryChars / 4), hasChatMemory: memoryHasChat };
  // A restricted mode (plan/review/document) can never resolve a pending
  // task — task-create/task-update are excluded from its tool allowlist,
  // and its persona forbids acting on one. Without this gate, a stale task
  // left behind by an EARLIER Execute-mode turn in the same session (tasks
  // have no mode dimension and are never cleared on a mode switch) would
  // report continueNeeded: true forever once the user switches to a
  // restricted mode — the Mac client's auto-continue reflex has no !busy
  // guard against this and would re-fire every ~0.8s+round-trip
  // indefinitely. Mirrors the same gate already applied to the task-list
  // PROMPT injection above; this closes the matching gap in the RESPONSE.
  const continueNeeded = restrictsTools(resolvedMode)
    ? false
    : tasks.hasPendingWork(userId, agentContext?.sessionId);
  const currentTasks = restrictsTools(resolvedMode)
    ? []
    : tasks.listTasks(userId, agentContext?.sessionId);
  return {
    ...out,
    memoryUsage,
    ...(expandedFrom ? { expandedFrom } : {}),
    continueNeeded,
    tasks: currentTasks,
    mode: resolvedMode,
  };
}
