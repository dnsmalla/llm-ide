// The llmide in-process MCP server — mounts every registry entry
// (llm_agent/tools/registry.mjs) as an SDK tool. This file is the ONLY
// module that converts the registry's plain-JSON schema (shared with the
// legacy .md frontmatter) into zod — see zodSchemaFor. Per-entry logic lives
// in runtime/handlers/*.mjs via the registry; this file adds no domain logic.
//
// buildLlmIdeServer(userId, agentContext, currentMessage, { renderMemory, ... })
// returns the McpSdkServerConfigWithInstance the SDK query() `mcpServers`
// option consumes: tools run in the engine's own process (no subprocess, no
// wire), and each handler closes over the calling user so every read stays
// tenant-scoped. `readableRoots`/`kb` are built here (matching how route.mjs
// builds the same two values for the legacy engine) and threaded into every
// mounted tool's shared ctx.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as kb from '../../kb/db.mjs';
import { entries, abortedResult, signalFor } from '../tools/registry.mjs';
import { globalSkills } from '../skills/index.mjs';
import { buildReadableRoots } from '../runtime/handlers/repo-files.mjs';
import { resolveChatSessionId } from '../../kb/session-memory.mjs';
import { logger } from '../../core/logger.mjs';

// The .md frontmatter param types this compiler understands. An unrecognized
// type used to fall through to `z.string()` silently — a skill declaring e.g.
// `type: boolean` would mount with a wrong-but-plausible schema and only fail
// at call time, deep inside a handler. Fail loudly at mount instead.
function zodFor(paramDef, key) {
  let z_;
  switch (paramDef.type) {
    case 'string': z_ = z.string(); break;
    case 'number': z_ = z.number(); break;
    case 'boolean': z_ = z.boolean(); break;
    case 'string[]': z_ = z.array(z.string()); break;
    // A plain JSON object (decide's `questions`); its inner shape — and its
    // serialized-size cap — are the HANDLER's to enforce (zod `.max` would not
    // mean size for a record). decide's does: providers/jev.mjs
    // validateJevQuestions (MAX_QUESTIONS_CHARS), run before any model call.
    // A future object-typed tool must cap its own input the same way.
    case 'object': z_ = z.record(z.string(), z.unknown()); break;
    default:
      throw new Error(`unsupported schema type "${paramDef.type}" for param "${key}" — llm_agent/sdk/tools.mjs must learn it before a skill can declare it`);
  }
  if (Array.isArray(paramDef.enum)) {
    z_ = z.enum(paramDef.enum);
  } else if (paramDef.type === 'string' || paramDef.type === 'string[]') {
    // Length caps declared in the .md frontmatter (e.g. run-bash's 2000-char
    // command cap) were dropped entirely before — documented but unenforced on
    // v2, so a mounted tool accepted input the legacy validator rejected.
    // `.min`/`.max` mean LENGTH for strings and arrays (never for numbers,
    // where they'd mean value bounds — hence the type guard); an enum carries
    // its own domain, so it's left alone.
    if (Number.isFinite(paramDef.maxLength)) z_ = z_.max(paramDef.maxLength);
    if (Number.isFinite(paramDef.minLength)) z_ = z_.min(paramDef.minLength);
  }
  if (paramDef.description) z_ = z_.describe(paramDef.description);
  if (!paramDef.required) z_ = z_.optional();
  if (paramDef.default !== undefined) z_ = z_.default(paramDef.default);
  return z_;
}

function zodSchemaFor(schema) {
  const shape = {};
  for (const [key, def] of Object.entries(schema || {})) shape[key] = zodFor(def, key);
  return shape;
}

// Test-only seam: the compiler is module-private (no domain logic belongs to
// callers), but its throw-on-unknown-type contract needs direct coverage that
// doesn't depend on shipping a deliberately-broken skill file.
export const __zodSchemaForTest = zodSchemaFor;

function metaFor(entry) {
  const skill = globalSkills.skills.get(entry.name);
  if (skill) return { description: v2Description(skill.description || entry.name), schema: skill.schema || {} };
  return entry.inlineMeta || { description: entry.name, schema: {} };
}

// The tool docs are shared with the legacy engine (and synced from the
// central kit), where `ask-internal` is the way to reach app state. v2 does
// not mount it (V2_NATIVE_DUPLICATES), so a description pointing there would
// send the model to a tool that is not in its list; name the ones it has.
function v2Description(text) {
  return String(text).replace(/`ask-internal`/g, '`search-kb` or `project_memory`');
}

// Registry entries the v2 engine does NOT mount, because an SDK built-in in
// V2_BUILTIN_TOOLS (sdk/engine.mjs) already does the same job. Each mounted
// tool's description + schema rides in the prompt on every turn, so a
// duplicate is pure overhead — and two tools for one job also make the model
// pick between them. The legacy engine has no built-ins and keeps all of
// these via the registry.
//
// - list-files / read-file → Glob / Read. Same reach: the SDK's cwd +
//   additionalDirectories are built from the same readable roots
//   (buildReadableRoots) these handlers check against.
// - web-search / fetch-url → WebSearch / WebFetch. The handlers themselves
//   call Anthropic's web_search / web_fetch (or the claude CLI's built-ins)
//   one level down. Skipped only on FIRST-PARTY turns: a gateway turn
//   (Anthropic-compatible custom provider, e.g. GLM) sends the built-ins to a
//   backend that may not implement Anthropic's server-side web tools, while
//   the handlers still reach Anthropic on the user's own key/login.
//
// - ask-internal → nothing to delegate. It runs a nested agent loop whose
//   only tool is search-kb, grounded in the system context plus the Graphify
//   project memory — for the LEGACY global agent, which has neither. A v2
//   turn has the system context in its own prompt and search-kb,
//   project_memory and find-code as its own tools, so the delegation was a
//   whole extra loop of model calls (up to 10, uncached, ~40k chars of memory
//   each) for an answer the turn could get directly.
//
// find-code is NOT a duplicate: it searches the symbol index + code graph,
// which Grep cannot.
const V2_NATIVE_DUPLICATES = new Set(['list-files', 'read-file', 'ask-internal']);
const V2_NATIVE_WEB_DUPLICATES = new Set(['web-search', 'fetch-url']);

// Tools that can do nothing in some turns, and whose definitions would still
// ride in every call's prompt there (measured 2026-10-07 via getContextUsage:
// ask-subagent ≈ 503 tokens, check-citations ≈ 235):
// - ask-subagent delegates to a plugin-defined subagent — none installed, no
//   use.
// - check-citations checks a plan or answer about to be presented; an
//   execute turn changes code instead.
// `undefined` (an older caller that does not say) keeps the tool mounted.
function usefulThisTurn(name, { mode, hasSubagents }) {
  if (name === 'ask-subagent') return hasSubagents !== false;
  if (name === 'check-citations') return mode !== 'execute';
  return true;
}

/** The registry entries mounted on a v2 turn (see V2_NATIVE_DUPLICATES and usefulThisTurn). */
export function v2MountedEntries({ gateway = false, mode, hasSubagents } = {}) {
  return entries().filter((e) => !V2_NATIVE_DUPLICATES.has(e.name)
    && (gateway || !V2_NATIVE_WEB_DUPLICATES.has(e.name))
    && usefulThisTurn(e.name, { mode, hasSubagents }));
}

export function buildLlmIdeServer(userId, agentContext, currentMessage, {
  renderMemory, runClaude, userSkills, userSubagents, internalSkills,
  // True on an Anthropic-compatible gateway turn — keeps the llmide web tools
  // mounted (see V2_NATIVE_WEB_DUPLICATES).
  gateway = false,
  // The turn's resolved mode — see usefulThisTurn. Omitted = mount everything.
  mode,
  // The TURN's cancellation (runAgentV2Turn's `abortController.signal`).
  // The SDK's own abortController only kills the CLI SUBPROCESS — every tool
  // mounted here runs in the SERVER process, so without this signal a Stop
  // left `ask-subagent`/`ask-internal` making model calls (burning quota) and
  // `run-bash` holding a process group long after the user cancelled.
  signal,
} = {}) {
  const readableRoots = buildReadableRoots({ userId, workspaceRoot: agentContext?.workspaceRoot });
  const toolCtx = {
    userId, agentContext, currentMessage, renderMemory, kb, readableRoots,
    runClaude, userSkills, userSubagents, internalSkills, signal,
    // Same resolver the legacy loop uses (kb/session-memory.mjs) — a chat's
    // task-create/task-update/task-list calls must key onto the SAME
    // session id across both engines, not a raw agentContext.sessionId.
    sessionId: resolveChatSessionId(agentContext),
  };
  // Every registry entry except the native duplicates mounts, read AND act —
  // canUseTool (sdk/engine.mjs) is what actually restricts act tools
  // (always-allow → gate → allow/deny/prompt), not this mount list.
  const hasSubagents = userSubagents ? (userSubagents.size ?? Object.keys(userSubagents).length) > 0 : undefined;
  const sdkTools = v2MountedEntries({ gateway, mode, hasSubagents }).map((entry) => {
    const meta = metaFor(entry);
    return tool(
      entry.name,
      meta.description,
      zodSchemaFor(meta.schema),
      async (args) => {
        // Refuse to START once the turn is cancelled. The SDK kills its CLI
        // subprocess on abort, but a tool call already handed to this
        // in-process server would otherwise run to completion — an
        // `ask-subagent` delegation is a full nested agent loop, so that is
        // real model spend after the user pressed Stop.
        const startedAt = Date.now();
        const aborted = abortedResult(toolCtx);
        let result;
        let outcome = 'ok';
        try {
          result = aborted ?? await Promise.resolve(entry.execute(args, toolCtx));
          // `aborted` is checked first because abortedResult returns an
          // {error} shape: judging by the result alone would report the user's
          // own Stop as a tool malfunction.
          if (aborted) outcome = 'aborted';
          else if (result && result.error) outcome = 'error';
        } catch (err) {
          // `aborted` above only catches a Stop that lands BEFORE the call
          // starts. A long-running call — e.g. `ask-internal`, which threads
          // `signal` into a nested runAgentLoop/runClaude — can be stopped
          // MID-EXECUTION: the nested call rejects with an AbortError, which
          // lands here as a thrown error indistinguishable from a genuine
          // tool malfunction unless we check for it. That is the exact
          // misclassification the comment above (on the pre-call `aborted`
          // check) already warns about, just reached by a different door: a
          // rejected promise instead of a returned {error} shape. Check the
          // turn's own signal first (authoritative — it is what the tool
          // itself observed), and the error's name as a fallback for a
          // library that surfaces the abort without threading the shared
          // signal all the way through.
          outcome = (signalFor(toolCtx)?.aborted || err?.name === 'AbortError') ? 'aborted' : 'error';
          throw err;
        } finally {
          // Telemetry parity with the legacy loop's dispatch point
          // (runtime/loop.mjs, same `skill_invoked` event, tagged by engine so
          // one grep of kb/server.log covers both). v2 emitted nothing, so on
          // the DEFAULT engine there was no way to answer "is the model
          // actually calling this tool" — which is the only honest way to
          // judge a change to tool descriptions, the thing selection depends
          // on.
          //
          // NEVER add args or results here. They carry file contents, shell
          // commands, KB prose and whatever the user typed; a line in
          // server.log is not the place for any of it. `ms`/`outcome` are what
          // the legacy line lacks and what makes a slow or silently-failing
          // tool visible.
          //
          // `audit`, not `info`: the file sink is warn+, so an info line only
          // ever reaches stdout, which the Mac app swallows into an in-memory
          // buffer. logger.audit exists for exactly this class of event (its
          // own docstring cites project_memory making the same mistake) — a
          // line whose whole purpose is to answer "did this actually happen?"
          // after the fact. Costs rotation budget, hence the tiny payload.
          logger.audit('skill_invoked', {
            skill: entry.name,
            kind: entry.kind,
            engine: 'v2',
            userId,
            sessionId: toolCtx.sessionId,
            ms: Date.now() - startedAt,
            outcome,
          });
        }
        // A result that is only `{ text }` goes out as that text: JSON-
        // escaping a prose block (newlines → \n, quotes → \") made it longer
        // and harder to read, and it stays in the transcript. Structured
        // results keep their JSON.
        const onlyText = result && typeof result === 'object' && !Array.isArray(result)
          && typeof result.text === 'string' && Object.keys(result).length === 1;
        return { content: [{ type: 'text', text: onlyText ? result.text : JSON.stringify(result) }] };
      },
      // readOnlyHint must tell the TRUTH per entry: MCP hosts use it to decide
      // whether a call needs approval at all, so hardcoding `true` for
      // run-bash/task-create/task-update actively undercut the gate whose
      // whole job is to require approval for exactly those.
      { annotations: { readOnlyHint: entry.kind === 'read' }, alwaysLoad: true },
    );
  });

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.2.0',
    instructions: 'LLM-IDE domain tools — see each tool\'s description.',
    tools: sdkTools,
  });
}
