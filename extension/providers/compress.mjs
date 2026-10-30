// Optional prompt compression for adapter turns (K1 Phase 6b, plan 14.6). OFF unless
// LLMIDE_ROUTER=on and LLMIDE_ROUTER_COMPRESS=on (core/router-flags.mjs); bench-gated before it is ever a default.
//
// Where it applies: turns on a catalog provider (providers/adapter), whose prompt WE build. Never the Claude
// SDK path (the SDK owns that transcript) and not the handoff builder's output (already short).
//
// Three transforms, all lossy by design and all reported by length only (nothing is stored or logged):
//   a. dedupe: an identical tool call (same tool, same arguments) made twice in one turn returns a one-line
//      stub the second time, and identical long history messages collapse to a stub;
//   b. tool-output filtering: a tool result over `maxToolChars` keeps its head and tail;
//   c. stale-context trimming: messages older than the last `keepTurns` user turns keep head and tail only.
// JSON compaction is out of scope (it would change bytes a model may quote). Redaction runs FIRST.

import { createHash } from 'node:crypto';
import { redactSecrets } from '../core/redact-secrets.mjs';

export const MAX_TOOL_CHARS = 6000;
export const STALE_KEEP_TURNS = 6;
export const STALE_MAX_CHARS = 2000;
const DEDUPE_MIN_CHARS = 400;   // below this a stub is not worth the lost clarity

/** Keep the head and the tail of `text`, saying how much was cut. Short text is returned as is. */
export function headTail(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.7);
  const tail = Math.max(0, max - head);
  return `${s.slice(0, head)}\n...[${s.length - head - tail} characters omitted]...\n${tail ? s.slice(-tail) : ''}`;
}

const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Compress a chat history for an adapter turn. Pure; returns a new array and a count of what changed.
 * @param {Array<{role: string, content: string}>} messages oldest first
 * @returns {{ messages: Array<{role: string, content: string}>, trimmed: number, deduped: number, savedChars: number }}
 */
export function compressHistory(messages, { keepTurns = STALE_KEEP_TURNS, maxChars = STALE_MAX_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Number.isSafeInteger(keepTurns) && keepTurns >= 0 ? keepTurns : STALE_KEEP_TURNS;
  // The index where the protected window begins: the start of the last `keep` user turns.
  let seenUsers = 0;
  let windowStart = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user') { seenUsers += 1; if (seenUsers === keep) { windowStart = i; break; } }
    if (i === 0) windowStart = 0;
  }
  if (keep === 0) windowStart = list.length;
  const seen = new Map();
  let trimmed = 0;
  let deduped = 0;
  let saved = 0;
  const out = list.map((m, i) => {
    if (!m || typeof m.content !== 'string') return m;
    const safe = redactSecrets(m.content);
    if (i >= windowStart) return safe === m.content ? m : { ...m, content: safe };
    if (safe.length >= DEDUPE_MIN_CHARS) {
      const h = digest(safe);
      if (seen.has(h)) {
        deduped += 1; saved += safe.length;
        return { ...m, content: `(identical to an earlier ${seen.get(h)} message, omitted)` };
      }
      seen.set(h, m.role);
    }
    if (safe.length > maxChars) {
      const t = headTail(safe, maxChars);
      trimmed += 1; saved += safe.length - t.length;
      return { ...m, content: t };
    }
    return safe === m.content ? m : { ...m, content: safe };
  });
  return { messages: out, trimmed, deduped, savedChars: saved };
}

/**
 * Tools whose output may be capped or stubbed. A tool that returns FILE CONTENT (read-file) or something the model
 * must hold exactly (a loaded skill, citation checks, the task list, decisions) is never head/tailed or stubbed:
 * cutting the middle of a file the model is editing against is worse than the tokens saved. Those outputs are
 * still redacted. Everything not listed here is treated that way (the safe default for a new tool).
 */
export const COMPRESSIBLE_TOOLS = Object.freeze(new Set([
  'web-search', 'fetch-url', 'run-bash', 'search-kb', 'find-code', 'code-relations', 'list-files', 'ask-subagent', 'ask-internal',
]));
/** A repeated identical call is stubbed only while its first full result is still this recent (chars of other tool output since). */
export const DEDUPE_WINDOW_CHARS = 24_000;

/** Redact a tool result of any shape. Unchanged results are returned as they came; a changed object stays an object. */
function redactResult(out) {
  if (typeof out === 'string') return redactSecrets(out);
  let text;
  try { text = JSON.stringify(out ?? null); } catch { return out; }
  const safe = redactSecrets(text);
  if (safe === text) return out;
  try { return JSON.parse(safe); } catch { return safe; }
}

/**
 * Wrap adapter tools so each execute() result is ALWAYS redacted, and, for COMPRESSIBLE_TOOLS only, capped and
 * deduped within ONE turn. The wrapper keeps names, descriptions and parameters, so the library and the gate see
 * the same tools.
 * @param {Array<{name: string, execute: Function}>} tools
 * @returns {Array} new tool objects; the originals are not touched
 */
export function wrapToolsForCompression(tools, { maxChars = MAX_TOOL_CHARS, window = DEDUPE_WINDOW_CHARS } = {}) {
  const seen = new Map();   // call key -> { hash, since }: per call of this function = per turn
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    ...t,
    execute: async (input, ctx) => {
      const out = await t.execute(input, ctx);
      // An error result is never replaced by a stub or cut: the model must see that the call failed (redacted only).
      if (out && typeof out === 'object' && out.error) return redactResult(out);
      const safeOut = redactResult(out);
      if (!COMPRESSIBLE_TOOLS.has(t.name)) return safeOut;
      const text = typeof safeOut === 'string' ? safeOut : JSON.stringify(safeOut ?? null);
      const key = `${t.name}:${digest(JSON.stringify(input ?? null))}`;
      const h = digest(text);
      const prior = seen.get(key);
      // Same tool, same arguments AND same content, and the earlier full result is still in recent context.
      if (prior && prior.hash === h && prior.since < window && text.length >= DEDUPE_MIN_CHARS) {
        return `(same output as your earlier ${t.name} call with these arguments)`;
      }
      const result = text.length > maxChars ? headTail(text, maxChars) : safeOut;
      const shown = typeof result === 'string' ? result.length : text.length;
      for (const v of seen.values()) v.since += shown;
      seen.set(key, { hash: h, since: 0 });
      return result;
    },
  }));
}
