// The agent loop engine. Owns the iterate-up-to-N main loop and the
// system-prompt composer. Content (agent prompts, skill markdown, the
// context renderers) lives outside; runtime is mechanism only.

import { parseFence, validateArgs } from './fence.mjs';
import { composeSystemContext } from '../internal/context/compose.mjs';
import { redactFence } from './redaction.mjs';
import { logger } from '../../core/logger.mjs';
import { config } from '../../core/config.mjs';

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
// Hard wall-clock cap per agent loop. Raised to 360 s so a legitimate
// long chat reply isn't cut off before the 5-minute mark. With nested
// global→internal the practical worst case is now 10 × 2 = 20 LLM
// calls; 360 s gives ~18 s per call on average, ample for most Claude
// responses. Callers pass their own deadlineMs explicitly (route.mjs,
// ask-internal.mjs, ask-subagent.mjs) — this is only a defensive
// fallback.
const DEFAULT_DEADLINE_MS = 360_000;

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

// Per-turn label overhead ("User: " / "Assistant: " + the blank line joining
// blocks). Counted so the packing below can't overshoot its char budget by the
// framing it adds around each turn.
const TURN_OVERHEAD_CHARS = 14;

// Pick the turns to replay under a CHAR budget, newest-first, and always keep
// the first user turn — the original request. That anchor is the whole point:
// a tool-using task appends two turns per step (synthetic result + reply), so
// a fixed turn-count window silently evicted the user's actual ask partway
// through a long task and the agent started answering the last tool result
// instead of the question.
//
// Returns `{ turns, omitted, gapAt }` with each turn already clipped AND
// fence-redacted (replayed client content must never be parseable as a
// `<<<TOOL_RESULT>>>` block). `gapAt` is the index in `turns` that dropped
// turns sat BEFORE — 1 when the anchor was kept (the gap falls after it), 0
// when it wasn't (everything dropped is older than what's left) — or null when
// nothing was dropped. Callers use it to place the "N turns omitted" note;
// getting it wrong claims the gap is somewhere it isn't. Pure — exported for
// unit tests.
export function selectHistoryTurns(history, {
  budget = config.history.maxChars,
  perTurnChars = config.history.perTurnChars,
  sanitize = redactFence,
} = {}) {
  const clip = (s) => (s.length > perTurnChars
    ? `${s.slice(0, perTurnChars)}\n…(turn clipped)`
    : s);
  const all = (Array.isArray(history) ? history : [])
    .map((m) => ({
      role: m?.role === 'user' ? 'user' : m?.role === 'assistant' ? 'assistant' : null,
      content: typeof m?.content === 'string' ? sanitize(clip(m.content)) : '',
    }))
    .filter((t) => t.role && t.content);
  if (all.length === 0 || budget <= 0) {
    return { turns: [], omitted: all.length, gapAt: all.length > 0 ? 0 : null };
  }

  const cost = (t) => t.content.length + TURN_OVERHEAD_CHARS;
  // Reserve the anchor's cost BEFORE packing the tail, so a long tail can
  // never be what pushes the original request out.
  const anchorIdx = all.findIndex((t) => t.role === 'user');
  const anchor = anchorIdx >= 0 && cost(all[anchorIdx]) <= budget ? all[anchorIdx] : null;
  let remaining = budget - (anchor ? cost(anchor) : 0);

  // Newest-first walk back toward (but not including) the anchor.
  const tail = [];
  const stopAt = anchor ? anchorIdx : -1;
  for (let i = all.length - 1; i > stopAt; i--) {
    const c = cost(all[i]);
    if (c > remaining) break;
    remaining -= c;
    tail.push(all[i]);
  }
  tail.reverse();
  const turns = anchor ? [anchor, ...tail] : tail;
  const omitted = all.length - turns.length;
  return { turns, omitted, gapAt: omitted > 0 ? (anchor ? 1 : 0) : null };
}

function renderHistoryBlock(history, budget) {
  const { turns, omitted, gapAt } = selectHistoryTurns(history, { budget });
  if (turns.length === 0) return '';
  const body = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`);
  // Make the gap explicit rather than letting the model assume two adjacent
  // turns were consecutive. Spliced at `gapAt` so the note sits where the
  // missing turns actually were — including at the very end, when the anchor
  // was kept but nothing after it fit.
  if (gapAt !== null) {
    body.splice(gapAt, 0, `_(${omitted} earlier turn(s) omitted to fit the context budget)_`);
  }
  return ['# Previous conversation', ...body].join('\n\n');
}

function buildIterationPrompt({ systemPrompt, history, userMessage, prevOutput, toolResult, toolError }) {
  // History gets whatever the rest of the prompt leaves under the global
  // budget, capped by config.history.maxChars. Sized here (not inside
  // renderHistoryBlock) because this is the only place that knows how big the
  // system prompt and user message actually are — which is what makes "replay
  // as much as fits" safe: runClaude THROWS above 500 000 chars, so history
  // must yield to the parts of the prompt that can't be dropped.
  const fixedChars = (systemPrompt?.length || 0) + (userMessage?.length || 0)
    + (prevOutput?.length || 0);
  const historyBudget = Math.max(
    0,
    Math.min(config.history.maxChars, config.history.promptBudgetChars - fixedChars),
  );
  const historyBlock = renderHistoryBlock(history, historyBudget);
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

const TOOL_CALL_FENCE_MARKER = '<<<TOOL_CALL>>>';

/**
 * Wraps a caller's `onChunk` with a "sniff the first bytes" filter so live
 * streaming only reaches the client for a real natural-language answer, never
 * for a `<<<TOOL_CALL>>>` fence directive (which is never user-facing text).
 * Since a single agent-loop iteration's output isn't known to be "the final
 * answer" vs. "a tool call" until it's fully parsed, this decides as early as
 * possible from the stream itself: once enough characters have arrived to
 * either match or rule out the fence marker, either start forwarding live
 * (flushing whatever was buffered so far) or suppress silently for the rest
 * of this call.
 *
 * `flushIfUndecided(fullText)` is a safety net for a response SHORTER than
 * the fence marker itself (15 chars) that therefore never resolved live —
 * call it only after `parseFence` has confirmed the full response has no
 * fence, so it's safe to flush in bulk (this only ever fires for genuinely
 * short answers, where "streamed at the very end" vs. "streamed live" is an
 * imperceptible difference to the user).
 */
function makeSniffingChunkHandler(outerOnChunk) {
  let buffer = '';
  let decided = null; // null = undecided, true = forwarding live, false = suppressed (a fence)
  const onChunk = (delta) => {
    if (decided === true) { outerOnChunk(delta); return; }
    if (decided === false) return;
    buffer += delta;
    if (buffer.length >= TOOL_CALL_FENCE_MARKER.length) {
      if (buffer.startsWith(TOOL_CALL_FENCE_MARKER)) {
        decided = false;
      } else {
        decided = true;
        outerOnChunk(buffer);
      }
    }
  };
  const flushIfUndecided = (fullText) => {
    if (decided === null) outerOnChunk(fullText);
  };
  return { onChunk, flushIfUndecided };
}

export async function runAgentLoop({
  skills, userMessage, history, agentContext, runClaude, kb, userId, handlers,
  maxIterations, deadlineMs, model, maxTokens, depth = 0, onProgress, onChunk,
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
  // `userMessage` is forwarded so the repo-memory renderer can rank curated
  // chat-memory facts against THIS question rather than falling back to
  // newest-first — the same relevance selection route.mjs already gets for the
  // global agent. For internal that message is global's restated question,
  // which is exactly the right relevance signal.
  const contextBlock = agentContext && agentContext.includeSystemContext === true
    ? composeSystemContext(agentContext, userId, userMessage)
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
    const sniff = typeof onChunk === 'function' ? makeSniffingChunkHandler(onChunk) : null;
    try {
      out = await runClaude(prompt, {
        userId,
        model,
        maxTokens: (Number.isFinite(maxTokens) && maxTokens > 0) ? maxTokens : 2048,
        signal: callSignal,
        ...(sniff ? { onChunk: sniff.onChunk } : {}),
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
      if (sniff) sniff.flushIfUndecided(text.trim() || out);
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

    // Skill-invocation telemetry (single dispatch point, covers read + write).
    // Selection is entirely model/description-driven with no ranking, so this
    // persistent record is the only way to measure offline which skills
    // actually trigger, how often, and for whom — the data needed to spot a
    // skill that mis-triggers or never fires. One line per dispatch.
    logger.info('skill_invoked', { skill: skill.name, kind: skill.kind, userId, iteration: i + 1 });

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

/**
 * Native tool-calling agent loop for OpenAI-compatible providers
 * (deepseek/openai/custom) — the Cursor/OpenAI pattern: maintain a real
 * messages array, feed tool results back as native `{role:'tool',
 * tool_call_id}` messages, and terminate naturally when the model returns no
 * tool_calls. This is the correct shape for providers that speak the OpenAI
 * function-calling API; the fence-based `runAgentLoop` above stays the path for
 * anthropic/CLI/google.
 *
 * `complete({messages, tools, maxTokens, signal})` is injected — in production
 * it's callOpenAI bound to the resolved key/model/baseUrl; in tests it's a mock.
 * Returns the same shape as runAgentLoop: { reply, pendingTool, iterations,
 * cacheHits }. Write tools surface as `pendingTool` for the client (one per
 * turn), exactly as the fence loop does.
 */
export async function runNativeAgentLoop({
  systemPrompt, userMessage, history, skills, tools, complete,
  userId, handlers, kb, maxIterations, deadlineMs, depth = 0, onProgress,
}) {
  const emit = (event) => { try { onProgress?.(event); } catch { /* ignore */ } };
  if (depth > MAX_LOOP_DEPTH) throw new Error(`agent loop nesting exceeds depth ${MAX_LOOP_DEPTH}`);
  const cap = Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : DEFAULT_MAX_ITERATIONS;
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEFAULT_DEADLINE_MS;
  const startTs = Date.now();

  // Seed the conversation: system + prior turns (so multi-turn follow-ups keep
  // context) + the current user turn. Shares the fence loop's char-budget
  // window (selectHistoryTurns), including its anchor-on-the-original-request
  // rule and its redactFence sanitising of replayed client content.
  const historyBudget = Math.max(
    0,
    Math.min(
      config.history.maxChars,
      config.history.promptBudgetChars
        - (systemPrompt?.length || 0) - (userMessage?.length || 0),
    ),
  );
  const { turns: replayed, omitted } = selectHistoryTurns(history, { budget: historyBudget });
  // The omission note is appended to the SYSTEM message rather than inserted as
  // a second one: several OpenAI-compatible providers only accept `system` as
  // the leading message, and a mid-conversation one is either rejected or
  // silently reordered. Position isn't lost — the note says these are *earlier*
  // turns, and the anchor-first ordering below makes that unambiguous.
  const messages = [{
    role: 'system',
    content: omitted > 0
      ? `${systemPrompt}\n\n(${omitted} earlier conversation turn(s) were omitted to fit the context budget.)`
      : systemPrompt,
  }];
  for (const turn of replayed) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: userMessage });

  for (let i = 0; i < cap; i++) {
    const remaining = deadline - (Date.now() - startTs);
    if (remaining <= 0) return { reply: '_(agent timed out)_', pendingTool: null, iterations: i, cacheHits: 0 };
    emit({ phase: i === 0 ? 'thinking' : 'writing', iteration: i + 1 });

    let resp;
    try {
      resp = await complete({
        messages,
        tools,
        maxTokens: 2048,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return { reply: '_(agent timed out)_', pendingTool: null, iterations: i, cacheHits: 0 };
      }
      throw err;
    }
    const { text, toolCalls } = resp;

    // No tool calls → the model produced its user-facing answer. Natural
    // termination — no artificial iteration cap needed for well-behaved models.
    if (!Array.isArray(toolCalls) || !toolCalls.length) {
      return { reply: (text || '').trim(), pendingTool: null, iterations: i + 1, cacheHits: 0 };
    }

    // Append the assistant turn (with its tool_calls) per the OpenAI contract —
    // the API requires every tool_call to be answered by a tool message below.
    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc, idx) => ({
        id: tc.id || `call_${i}_${idx}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      })),
    });

    // Execute each tool call and feed results back as native tool messages.
    for (const [idx, tc] of toolCalls.entries()) {
      const callId = tc.id || `call_${i}_${idx}`;
      const skill = skills.get(tc.name);
      if (!skill) {
        messages.push({ role: 'tool', tool_call_id: callId, name: tc.name, content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }) });
        continue;
      }
      const validation = validateArgs(skill.schema, tc.arguments || {});
      if (validation.error) {
        messages.push({ role: 'tool', tool_call_id: callId, name: tc.name, content: JSON.stringify({ error: validation.error }) });
        continue;
      }
      logger.info('skill_invoked', { skill: skill.name, kind: skill.kind, userId, iteration: i + 1 });
      if (skill.kind === 'write') {
        // One write per turn — surface for client confirmation (pendingTool).
        return { reply: (text || '').trim(), pendingTool: { name: tc.name, arguments: validation.value }, iterations: i + 1, cacheHits: 0 };
      }
      emit({ phase: 'tool', tool: skill.name, iteration: i + 1 });
      let result;
      try {
        result = await handlers[skill.name](validation.value, { userId, kb, handlers, depth: depth + 1 });
      } catch (err) {
        result = { error: `Tool ${skill.name} threw: ${err.message}` };
      }
      if (result?.pendingTool) {
        return { reply: (text || '').trim(), pendingTool: result.pendingTool, iterations: i + 1, cacheHits: 0 };
      }
      messages.push({ role: 'tool', tool_call_id: callId, name: skill.name, content: JSON.stringify(redactDeep(result)) });
    }
  }

  return { reply: '_(reached the tool iteration limit — try again)_', pendingTool: null, iterations: cap, cacheHits: 0 };
}
