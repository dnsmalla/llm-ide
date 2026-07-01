// The agent loop engine. Owns the iterate-up-to-N main loop and the
// system-prompt composer. Content (agent prompts, skill markdown, the
// context renderers) lives outside; runtime is mechanism only.

import { parseFence, validateArgs } from './fence.mjs';
import { composeSystemContext } from '../internal/context/compose.mjs';
import { redactFence } from './redaction.mjs';

// Recursively redact fence sentinels from any value that will be
// JSON-embedded into the next-iteration prompt.  Without this, a KB
// snippet or ask-internal answer containing the literal string
// <<<TOOL_CALL>>> would survive JSON.stringify as a parseable sentinel
// and let a crafted meeting title / issue body forge a write-tool call.
function redactDeep(val) {
  if (typeof val === 'string') return redactFence(val);
  if (Array.isArray(val)) return val.map(redactDeep);
  if (val !== null && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = redactDeep(v);
    return out;
  }
  return val;
}

// Deterministic JSON for the read-cache key: object keys are emitted in
// sorted order at every depth, so {a,b} and {b,a} produce the same string
// (arrays keep their order — element position is semantically meaningful).
// validateArgs already happens to reconstruct args in schema order, but
// keying the cache on this makes stability self-contained rather than a
// silent dependency on that distant invariant.
export function stableStringify(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val) ?? 'null';
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(',')}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(val[k])}`).join(',')}}`;
}

// Internal — only the loop dispatches read handlers; nothing imports
// this (was previously exported with no users).
async function runReadHandler(name, args, ctx) {
  const handler = ctx.handlers && ctx.handlers[name];
  if (typeof handler !== 'function') {
    return { error: `no read handler for '${name}'` };
  }
  try {
    return await handler(args, ctx);
  } catch (err) {
    return { error: `read handler '${name}' failed: ${err.message}` };
  }
}

// Default iterations raised from 5 → 10 so multi-step tasks (search
// several KB buckets, synthesise, then draft a reply) can complete in
// one turn without the user having to retry.  The hard deadline below
// is the real safety valve; raising iterations only matters when each
// round-trip is fast (cached read tools, small prompts).
const DEFAULT_MAX_ITERATIONS = 10;
// Hard wall-clock cap per agent loop. Raised to 180 s to accommodate
// deeper multi-hop chains. With nested global→internal the practical
// worst case is now 10 × 2 = 20 LLM calls; 180 s gives ~9 s per call
// on average which is ample for most Claude responses.
const DEFAULT_DEADLINE_MS = 180_000;

// Aggregate cap on skill bodies in one system prompt. Each skill file
// is individually capped at 32 KB by the loader, but a user with many
// enabled plugins could still stack enough of them to crowd out the
// context window. 128 KB ≈ 4 max-size skills; core sets use ~8 KB.
const MAX_TOTAL_SKILL_BYTES = 131_072;

export function buildSystemPrompt({ base, skills, agentContextBlock }) {
  const bodies = [];
  let totalBytes = 0;
  let dropped = 0;
  for (const s of skills.values()) {
    const size = Buffer.byteLength(s.body, 'utf8');
    if (totalBytes + size > MAX_TOTAL_SKILL_BYTES) {
      dropped += 1;
      continue;
    }
    totalBytes += size;
    bodies.push(s.body);
  }
  if (dropped > 0) {
    console.warn(`[llm_agent] system prompt skill budget exceeded — dropped ${dropped} skill(s) beyond ${MAX_TOTAL_SKILL_BYTES} bytes (core skills load first and are unaffected)`);
  }
  const skillBodies = bodies.join('\n\n---\n\n');
  return [
    base,
    agentContextBlock,
    '# Available skills',
    skillBodies,
  ].filter((s) => s && s.length > 0).join('\n\n');
}

function renderHistoryBlock(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const recent = history.slice(-8);
  const lines = ['# Previous conversation'];
  for (const msg of recent) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    // Sanitise fence sentinels in replayed client history so a past
    // assistant or user turn cannot forge a <<<TOOL_RESULT>>> block.
    const content = typeof msg.content === 'string' ? redactFence(msg.content.slice(0, 6000)) : '';
    if (content) lines.push(`${role}: ${content}`);
  }
  return lines.join('\n\n');
}

function buildIterationPrompt({ systemPrompt, history, userMessage, prevOutput, toolResult, toolError }) {
  const historyBlock = renderHistoryBlock(history);
  const blocks = [systemPrompt];
  if (historyBlock) blocks.push(historyBlock);
  // Redact fence sentinels from the user message — it is repeated in
  // prevOutput on subsequent iterations and must not be parseable as a
  // tool call if it happens to contain the <<<TOOL_CALL>>> sentinel.
  blocks.push(`# User\n${redactFence(userMessage || '')}`);
  if (prevOutput) {
    blocks.push(`# Assistant (previous turn — your own output)\n${prevOutput}`);
  }
  if (toolResult !== undefined) {
    // Redact fence sentinels before embedding — a KB snippet or nested
    // agent answer containing <<<TOOL_CALL>>> would otherwise survive
    // JSON.stringify as a parseable sentinel and forge a tool invocation.
    blocks.push(`<<<TOOL_RESULT>>>\n${JSON.stringify(redactDeep(toolResult))}\n<<<END_TOOL_RESULT>>>`);
  } else if (toolError !== undefined) {
    blocks.push(`<<<TOOL_RESULT>>>\n${JSON.stringify({ error: redactFence(String(toolError)) })}\n<<<END_TOOL_RESULT>>>`);
  }
  blocks.push('Assistant:');
  return blocks.join('\n\n');
}

// Hard cap on user message length — a multi-MB message would bloat every
// iteration's prompt and could be used to exhaust Claude token budgets.
const MAX_USER_MESSAGE_BYTES = 500_000; // 500 KB

// Maximum agent-loop nesting: global (0) → internal/subagent (1) → one
// more level of delegation (2). Today's handler wiring tops out at
// depth 1, but the guard makes "a future handler registers a nested
// agent that can call back" a bounded mistake instead of unbounded
// recursion burning tokens until the deadline.
const MAX_LOOP_DEPTH = 2;

export async function runAgentLoop({
  skills, userMessage, history, agentContext, runClaude, kb, userId, handlers,
  maxIterations, deadlineMs, model, maxTokens, depth = 0, onProgress,
}) {
  // onProgress is an optional best-effort callback used to surface live
  // status to the client (the macOS Code Assistant turns these into a status
  // line instead of a frozen "Thinking…"). Never let a progress callback
  // throw into the loop.
  const emit = (event) => { try { onProgress?.(event); } catch { /* ignore */ } };
  if (typeof userMessage === 'string' && userMessage.length > MAX_USER_MESSAGE_BYTES) {
    throw new Error(`userMessage exceeds ${MAX_USER_MESSAGE_BYTES} byte limit`);
  }
  if (depth > MAX_LOOP_DEPTH) {
    throw new Error(`agent loop nesting exceeds depth ${MAX_LOOP_DEPTH}`);
  }
  const cap = Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : DEFAULT_MAX_ITERATIONS;
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEFAULT_DEADLINE_MS;
  const startTs = Date.now();
  const base = agentContext && agentContext.base !== undefined ? agentContext.base : '';
  // System context (active project, indexed repos, recent issues, recent
  // meetings, app capabilities) is heavy and only the internal agent
  // needs it. The global agent must NOT see it — gated behind an
  // explicit flag set by ask-internal.
  const contextBlock = agentContext && agentContext.includeSystemContext === true
    ? composeSystemContext(agentContext, userId)
    : '';
  const systemPrompt = buildSystemPrompt({
    base,
    skills,
    agentContextBlock: contextBlock,
  });

  // Per-invocation read-tool result cache.  Key = "<toolName>:<stable-json-args>".
  // When the agent calls the same read tool with the same arguments more than
  // once in a single turn we return the cached result instantly instead of
  // re-executing — avoids duplicate KB queries, duplicate API fetches, etc.
  // Write tools are never cached (they have side effects by definition).
  const MAX_CACHE_SIZE = 100;
  const readCache = new Map();
  let cacheHits = 0;

  let prevOutput;
  let toolResult;
  let toolError;
  let preToolText = '';

  // Return the standard graceful "ran out of time" reply. Shared by the
  // between-iteration check and the in-flight abort path so both look
  // identical to the client.
  const deadlineReply = (iters) => {
    const elapsed = Math.round((Date.now() - startTs) / 1000);
    return {
      reply: (preToolText.trim() + `\n\n_(reached the ${elapsed}s deadline — try again)_`),
      pendingTool: null, iterations: iters, cacheHits,
    };
  };

  for (let i = 0; i < cap; i++) {
    const remaining = deadline - (Date.now() - startTs);
    if (remaining <= 0) return deadlineReply(i);
    // First pass = "thinking"; later passes mean we're folding a tool result
    // back in = "writing the answer".
    emit({ phase: i === 0 ? 'thinking' : 'writing', iteration: i + 1 });
    const prompt = buildIterationPrompt({
      systemPrompt, history, userMessage, prevOutput, toolResult, toolError,
    });
    toolResult = undefined;
    toolError = undefined;

    // Pass userId so the HTTP path uses the user's own Anthropic key
    // when available, rather than silently falling back to the operator
    // key for every agent loop call.  `model` lets callers route this
    // loop to a specific (sub-)model — global, internal, and plugin
    // subagents can each run on a different tier; undefined falls
    // through to runClaude's LLMIDE_MODEL default.
    // Bound the in-flight call to the remaining wall-clock budget. The
    // between-iteration check above only catches overruns *between* calls;
    // without this a single slow runClaude could blow past the deadline.
    // The signal fires at the deadline; runClaude funnels it through as an
    // abort, which we turn into the same graceful deadline reply.
    const callSignal = AbortSignal.timeout(remaining);
    let out;
    try {
      out = await runClaude(prompt, {
        userId,
        model,
        maxTokens: (Number.isFinite(maxTokens) && maxTokens > 0) ? maxTokens : 2048,
        signal: callSignal,
      });
    } catch (err) {
      if (callSignal.aborted) return deadlineReply(i);
      throw err;
    }
    prevOutput = out;
    const { text, fence, parseError } = parseFence(out);
    preToolText += text;

    if (!fence) {
      if (parseError) {
        toolError = parseError;
        continue;
      }
      return { reply: preToolText.trim() || text.trim(), pendingTool: null, iterations: i + 1, cacheHits };
    }

    const skill = skills.get(fence.name);
    if (!skill) {
      toolError = `Unknown tool: ${fence.name}`;
      continue;
    }

    const validation = validateArgs(skill.schema, fence.arguments);
    if (validation.error) {
      toolError = validation.error;
      continue;
    }

    if (skill.kind === 'write') {
      return {
        reply: preToolText.trim(),
        pendingTool: { name: fence.name, arguments: validation.value },
      };
    }

    // read tool — check cache first, then execute
    emit({ phase: 'tool', tool: skill.name, iteration: i + 1 });
    let result;
    const cacheKey = `${skill.name}:${stableStringify(validation.value)}`;
    if (readCache.has(cacheKey)) {
      result = readCache.get(cacheKey);
      cacheHits += 1;
    } else {
      // ctx.depth is the depth any sub-loop spawned by this handler must
      // run at. The +1 happens HERE — the single enforcement point — so
      // handler authors forward ctx.depth verbatim and can't forget the
      // increment (forgetting it would silently disable the nesting cap).
      result = await runReadHandler(skill.name, validation.value, { userId, kb, handlers, depth: depth + 1 });
      if (!result.error) {
        if (readCache.size >= MAX_CACHE_SIZE) {
          readCache.delete(readCache.keys().next().value);
        }
        readCache.set(cacheKey, result); // only cache successes
      }
    }
    if (result.error) {
      toolError = result.error;
      continue;
    }
    // If a read handler surfaces a pendingTool (e.g. ask-internal
    // delegating to internal which emitted a write fence), propagate
    // it up unchanged. The client expects the same wire shape whether
    // the write came from the active agent or a nested one.
    if (result.pendingTool) {
      return {
        reply: preToolText.trim(),
        pendingTool: result.pendingTool,
        iterations: i + 1,
        cacheHits,
      };
    }
    toolResult = result;
  }

  const capMsg = `\n\n_(reached the ${cap}-call tool iteration limit — try again)_`;
  return { reply: (preToolText.trim() + capMsg), pendingTool: null, iterations: cap, cacheHits };
}
