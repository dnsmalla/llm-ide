// Read handler: delegates a question to a plugin-defined subagent.
//
// The global agent invokes this with { name, question }. We look up
// the named subagent across the union of subagent maps from every
// plugin the user has enabled, build a restricted handler set
// (intersection of internal's read handlers and the subagent's
// declared `allowed_tools` list), and run a fresh `runAgentLoop`
// with the subagent's body as the system prompt.
//
// Design choices:
// - Subagents are isolated: they don't see the chat history. The
//   global agent must restate any needed context inside `question`.
// - Subagents are read-only by default. Write tools (search-kb is
//   read; future write tools like `update-file` would only be
//   available if the subagent explicitly declares them in
//   `allowed_tools`).
// - If a plugin tries to declare an allowed_tool that doesn't exist,
//   it's silently dropped (no crash, just unavailable).
// - Subagent names are validated by the loader to match
//   /^[a-z][a-z0-9-]{0,40}$/ — safe to interpolate.

import { runAgentLoop } from '../loop.mjs';
import { searchKb } from './search-kb.mjs';
import { redactFence } from '../redaction.mjs';

// Same registry as ask-internal — extend here when new read tools
// become available to subagents.
const ALL_SUBAGENT_TOOLS = {
  'search-kb': searchKb,
};

/**
 * Compose the body the subagent runs with. We don't add the internal
 * agent's _base (fence contract) here directly — instead we rely on
 * the subagent author to either reference the same protocol in their
 * body OR keep their prompts simple enough that no tool calls happen.
 * To make tool calls work without forcing every subagent author to
 * recreate the fence contract, we prepend internalSkills.base when
 * the subagent's allowed_tools list is non-empty.
 */
export async function askSubagent(args, ctx) {
  if (typeof ctx.userId !== 'string' || !ctx.userId) {
    return { error: 'userId is required to invoke a subagent' };
  }

  const { name, question } = args || {};
  if (typeof name !== 'string' || !name) {
    return { error: 'subagent name is required' };
  }
  if (typeof question !== 'string' || !question.trim()) {
    return { error: 'question is required' };
  }

  // Strip triple-backtick fence sentinels from the question to prevent prompt injection.
  const sanitisedQuestion = question.replace(/```/g, '');

  const subagent = ctx.subagents?.get(name);
  if (!subagent) {
    const known = [...(ctx.subagents?.keys() || [])];
    return {
      error: `no subagent named '${name}' is enabled` +
        (known.length ? ` (available: ${known.join(', ')})` : ''),
    };
  }

  // Build the restricted handler map. Default = empty set (subagent
  // has no tools); plugin opts in by listing names in allowed_tools.
  const handlers = {};
  for (const tool of subagent.allowedTools) {
    if (tool in ALL_SUBAGENT_TOOLS) handlers[tool] = ALL_SUBAGENT_TOOLS[tool];
  }
  const hasTools = Object.keys(handlers).length > 0;

  // Skills the subagent sees: nothing by default — pure prompt agent.
  // If allowed_tools were declared, we pass an empty Map; the
  // global/internal skill set is NOT shared because subagents are a
  // separate trust boundary. Tool-call awareness comes from
  // internalSkills.base (the fence contract markdown).
  const baseParts = [subagent.systemPrompt];
  if (hasTools && ctx.internalSkillsBase) baseParts.unshift(ctx.internalSkillsBase);
  const base = baseParts.join('\n\n');

  const result = await runAgentLoop({
    skills: new Map(),         // no skill bodies — body IS the prompt
    userMessage: sanitisedQuestion,
    history: [],               // isolated from global's chat history
    agentContext: {
      base,
      // includeSystemContext intentionally omitted — subagents don't
      // get the app-state block. If a subagent needs project info,
      // pass it inside `question`.
    },
    runClaude: ctx.runClaude,
    kb: ctx.kb,
    userId: ctx.userId,
    handlers,
    maxIterations: subagent.maxIterations,
    // Sub-model routing: a subagent's own frontmatter `model:` wins,
    // then the deployment-wide LLMIDE_SUBAGENT_MODEL, then the
    // runClaude default.  Leaf calls are the natural place to run a
    // cheaper/faster tier.
    model: subagent.model || ctx.defaultModel,
    depth: ctx.depth ?? 1,
    deadlineMs: 90_000,         // tight — subagents are leaf calls
  });

  return {
    // Redact fence sentinels from the sub-loop reply at the source,
    // consistent with ask-internal.  The outer loop also applies
    // redactDeep() to the whole toolResult, but redacting here adds
    // a defense-in-depth layer so no raw sentinel survives even if
    // the outer handler changes.
    answer: redactFence(result.reply || ''),
    pendingTool: result.pendingTool ?? null,
  };
}
