// Read handler: delegates a question to a plugin-defined subagent.
//
// The global agent invokes this with { name, question }. We look up
// the named subagent across the union of subagent maps from every
// plugin the user has enabled, build a restricted handler set
// (intersection of internal's read handlers and the subagent's
// declared `allowed_tools` list), and answer ONE completion with the subagent's body as the system
// prompt. The nested tool loop it used to run (the classic fence loop) was removed in agent-kit K1
// P6 T6.8: a subagent's `allowed_tools` are NOT executed any more, the result says so, and the model
// that called this tool decides what to do with a tool-less answer. The native replacement is the SDK's
// `options.agents` (plan item A5, bench-gated).
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

import { resolveProvider } from '../../../providers/providers.mjs';

// The read tools a subagent could be granted when the nested loop existed.
const GRANTABLE_TOOLS = new Set(['search-kb', 'decide']);

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
  // Same reason as ask-internal: dispatching a subagent starts a nested agent
  // loop in this process, which the v2 engine's abortController (it kills only
  // the CLI subprocess) cannot stop. Never start one for a stopped turn.
  if (ctx.signal?.aborted) {
    return { error: 'Cancelled — the user stopped this turn.', pendingTool: null };
  }
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

  // Declared tools are not run (see the header); the answer says which were skipped.
  // Only tools that could ever be granted count (an unknown name was always dropped silently).
  const skippedTools = Array.isArray(subagent.allowedTools) ? subagent.allowedTools.filter((t) => GRANTABLE_TOOLS.has(t)) : [];

  const base = subagent.systemPrompt;

  // Tier routing. Precedence: the subagent's own frontmatter `model:` (an
  // author's explicit pick, provider inferred from the id as before) → its
  // `tier:` → the user's `features.subagents` tier → today's default. The
  // resolvers come from the caller bound to this user and return null for an
  // unset or unusable tier, so each step falls through instead of failing.
  let route = null;
  let routeTier = null;
  if (!subagent.model) {
    if (subagent.tier && typeof ctx.resolveTier === 'function') {
      route = ctx.resolveTier(subagent.tier);
      if (route) routeTier = subagent.tier;
    }
    if (!route && typeof ctx.resolveFeatureRoute === 'function') {
      route = ctx.resolveFeatureRoute('subagents');
      // The feature route names its tier when the caller knows it (registry.mjs).
      if (route) routeTier = typeof route.tier === 'string' ? route.tier : null;
    }
  }
  const requestedModel = subagent.model || route?.model || ctx.defaultModel;

  // runClaude's `onModel` reports what actually answered — the routed model,
  // or the default after a routeFallback — so the `meta` the client shows
  // ("provider · model") never names a model that did not run. Once it has
  // reported, the requested model is never used again (a fallback to an
  // undefined default must not read as the route). A runClaude that never
  // reports (test stubs, older wrappers) leaves the requested model standing.
  // `ran` is the LAST hop's report: a multi-hop subagent loop overwrites it.
  let ran = null;
  const runClaude = typeof ctx.runClaude === 'function'
    ? (prompt, opts = {}) => ctx.runClaude(prompt, {
      ...opts,
      onModel: (m, info) => {
        ran = {
          model: (typeof info?.model === 'string' && info.model) || (typeof m === 'string' && m) || null,
          provider: (typeof info?.provider === 'string' && info.provider) || null,
        };
        try { opts.onModel?.(m, info); } catch { /* reporting only */ }
      },
    })
    : ctx.runClaude;
  const startedAt = Date.now();

  const workspaceLine = ctx.agentContext?.workspaceRoot ? `\n\nThe workspace root is ${ctx.agentContext.workspaceRoot}.` : '';
  const prompt = `${base}${workspaceLine}\n\n# Question\n${sanitisedQuestion}`;
  let reply = '';
  try {
    reply = await runClaude(prompt, {
      model: requestedModel,
      // A routed hop that cannot run retries once on today's default model.
      ...(route ? { provider: route.provider, routeFallback: { model: ctx.defaultModel } } : {}),
      signal: ctx.signal,
      maxTokens: 4096,
    });
  } catch (err) {
    return { error: `subagent '${name}' failed: ${String(err?.message || err).slice(0, 300)}`, pendingTool: null };
  }

  const meta = subagentMeta({ name, route, routeTier, requestedModel, ran, ms: Date.now() - startedAt });
  const text = String(reply || '').trim();
  // A subagent that declares allowed_tools was written to look things up and act. This delegation cannot run
  // them, so its one-shot answer is ungrounded: return a clear non-success marker with the answer under
  // `partial`, never a plausible success. The calling model decides what to do with it.
  if (skippedTools.length) {
    return {
      // First on purpose: the client sees the tool_result text cut at 20k chars.
      meta,
      ok: false,
      error: 'tools_unavailable',
      message: `Subagent '${name}' declares tools (${skippedTools.join(', ')}) that this delegation cannot run, so its answer below is NOT grounded in them. Treat it as a draft, or do the lookups yourself.`,
      partial: text,
      pendingTool: null,
    };
  }
  return { meta, ok: true, answer: text, pendingTool: null };
}

/**
 * The `meta` block of a subagent result: `{ subagent, provider, model, tier?, ms }`.
 * `ran` is runClaude's last `onModel` report (`{ provider, model }`, either
 * may be null) or null when it never reported — only then does the requested
 * model stand in. A reported null model reads "default" (the deployment's).
 * `tier` only when the routed provider + model are what ran — after a
 * routeFallback the call answered on the default, which belongs to no tier.
 */
export function subagentMeta({ name, route, routeTier, requestedModel, ran, ms }) {
  const model = ran ? (ran.model || 'default') : (requestedModel || null);
  const routedModelRan = Boolean(route) && model === route.model;
  const provider = ran?.provider
    || (routedModelRan ? route.provider : null)
    || (model && model !== 'default' ? resolveProvider(model) : null);
  const ranOnRoute = routedModelRan && provider === route.provider;
  const meta = { subagent: name, provider, model };
  if (ranOnRoute && routeTier) meta.tier = routeTier;
  meta.ms = ms;
  return meta;
}
