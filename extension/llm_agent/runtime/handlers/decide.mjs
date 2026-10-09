// Read handler: the agent's `decide` tool — a calibrated yes/no, pick-one or
// score decision about given material (llm_agent/global/decide.md).
//
// All the work is in ../decide.mjs (engine choice, Jev call, LLM fallback,
// normalization); this only adapts it to the tool contract: arguments in,
// `{ engine, model, answers, fallback? }` or `{ error }` out. Errors are the
// core's own bounded, key-redacted messages — never a raw provider page.

import { decide } from '../decide.mjs';

// Error codes whose message is written for the user/model and safe verbatim.
const SAFE_MESSAGE_CODES = new Set([
  'VALIDATION_FAILED', 'JEV_HTTP_ERROR', 'JEV_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'DECIDE_FAILED',
]);

export async function handleDecide(args, { userId, signal, _decide = decide } = {}) {
  if (signal?.aborted) return { error: 'Cancelled — the user stopped this turn.' };
  if (typeof userId !== 'string' || !userId) return { error: 'userId is required to make a decision' };
  try {
    return await _decide({ userId, state: args?.state, questions: args?.questions, signal });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return { error: 'Cancelled — the user stopped this turn.' };
    const message = String(err?.message || err).slice(0, 400);
    if (SAFE_MESSAGE_CODES.has(err?.code)) return { error: message };
    return { error: `Decision failed: ${message.slice(0, 200)}` };
  }
}
