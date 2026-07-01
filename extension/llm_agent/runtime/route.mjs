// /code-assist handler logic. Orchestrates the global agent and
// delegates to ask-internal when needed. The thin route file in
// extension/server/ai-routes.mjs just builds the ctx and calls
// `handleCodeAssist`.
//
// All skill state (core skill loading, plugin skill caches, per-user
// views, the catalog) lives in the skills module —
// llm_agent/skills/registry.mjs. This file only orchestrates.

import { runAgentLoop } from './loop.mjs';
import { askInternal } from './handlers/ask-internal.mjs';
import { askSubagent } from './handlers/ask-subagent.mjs';
import { handleWebSearch } from './handlers/web-search.mjs';
import { handleFetchUrl } from './handlers/fetch-url.mjs';
import { composeGlobalPrompt } from '../global/compose-prompt.mjs';
import { expandSlashCommand } from '../../plugins/loader.mjs';
import { globalSkills, internalSkills, buildPerUserSkillSet } from '../skills/index.mjs';
import { sanitizePersonaSuffix } from '../../agents/prompt-utils.mjs';
import { renderGraphifyMemory } from '../../graphkit/index.mjs';
import { persistTurnMemory } from './memory-persist.mjs';
import { buildReadableRoots, handleListFiles, handleReadFile } from './handlers/repo-files.mjs';
import { redactFence } from './redaction.mjs';
import { logger } from '../../core/logger.mjs';

// Re-exported for the HTTP routes that historically imported these
// from here (server/auth-routes.mjs, kb/routes/agent.mjs import the
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
}) {
  // Per-user plugin view. Building it is cheap (Map clone + readdir
  // for each enabled plugin's skills/). Done per request so a user
  // toggling a plugin in Settings is reflected immediately.
  const { skills: userSkills, commands: userCommands, subagents: userSubagents } = buildPerUserSkillSet(userId);

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
    const memBlock = renderGraphifyMemory(agentContext, userId, memStats);
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
  };

  const out = await runAgentLoop({
    skills: globalSkills.skills,
    userMessage: composedUserMessage,
    history: Array.isArray(history) ? history : [],
    // base = global's composed prompt (role + ask-internal skill).
    // The rest of agentContext is intentionally empty so the loop's
    // composeSystemContext produces only (none configured) sections,
    // which then collapse to "## Active project\n- (none
    // configured)\n## Indexed code repositories ...\n- (none indexed)".
    //
    // The agent's prompt instructs it not to look at those — but in
    // practice global doesn't need to see them either. They cost ~120
    // tokens; tolerable for the architectural cleanliness of using
    // the same composer for both agents.
    agentContext: { base: personaBase },
    runClaude,
    kb,
    userId,
    handlers,
    onProgress,
    model: GLOBAL_AGENT_MODEL,
    maxIterations: 3,         // global cap is tighter; see runAgentLoop DEFAULT_MAX_ITERATIONS (10)
    // Long-form writing / refactoring asks routinely take 60-90s per
    // Claude call; with a single internal delegation that's two calls
    // back-to-back. 3 minutes covers the realistic worst case while
    // still bounding a truly stuck loop.
    deadlineMs: 180_000,
  });

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
  return { ...out, memoryUsage, ...(expandedFrom ? { expandedFrom } : {}) };
}
