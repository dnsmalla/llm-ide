// POST /kb/complete — one prompt in, one text answer out (agent-kit K1, P3).
//
// A plain single-shot completion for callers that never needed an agent: no
// tools, no history loop, no mode, no SSE. The Loop's RegressionRunner (replay
// and same-meaning judge) is the first caller; before this route it borrowed
// /code-assist's tool-less legacy path.
//
// Body:  { prompt, language?, model?, provider?, tier?, framing? }
//   tier 'subagent' picks LLMIDE_SUBAGENT_MODEL when `model` is absent (same
//   resolver /code-assist uses). framing 'code-assist' wraps the prompt exactly
//   as /code-assist's legacy path does (byte-identical model input for a caller
//   migrating off it); absent = the prompt is sent as is.
// Reply: { reply, usage? } where usage is the summed model tokens of the call
//   (omitted when the provider reported none, like /code-assist's v72 fields).
//
// Per user, rate-limited (llmFast bucket, server.mjs), metered in the usage
// ledger under endpoint '/kb/complete', recorded in agent history (source
// 'loop', engine 'complete'). Provider-config refusals use /code-assist's
// envelope (400 PROVIDER_UNAVAILABLE), so a client's retry-without-route logic
// is unchanged.
import { randomUUID } from 'node:crypto';
import { runClaude, resolveLanguage } from '../providers/runtime.mjs';
import { readBody, parseJSON, sanitizeForPrompt, sendJSON, onClientDisconnect } from '../core/utils.mjs';
import { legacyBareCodeAssistPrompt } from '../core/prompt-framing.mjs';
import { resolveTierModel } from '../llm_agent/modes/model-tier.mjs';
import { newTurnTokenTotals, countTurnTokens, turnTokenUsageFields } from '../kb/usage.mjs';
import { beginAgentRun, runTotals } from '../kb/agent-runs.mjs';
import { codeAssistErrorResponse } from '../server/code-assist-errors.mjs';

export const COMPLETE_MAX_PROMPT_CHARS = 100_000;
const COMPLETE_MAX_TOKENS = 2048;
const FRAMINGS = new Set(['code-assist']);

function bad(res, message) {
  sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message } });
  return true;
}

const optString = (v) => (typeof v === 'string' && v.trim() ? v : undefined);

export async function handleCompleteRoutes(req, res, { userId, url, run = runClaude }) {
  if (req.method !== 'POST' || url.split('?')[0] !== '/kb/complete') return false;
  const body = parseJSON(await readBody(req, 1024 * 1024));
  if (!body || typeof body !== 'object') return bad(res, 'Missing body');
  if (typeof body.prompt !== 'string') return bad(res, 'Missing prompt');
  for (const k of ['language', 'model', 'provider', 'tier', 'framing']) {
    if (body[k] != null && typeof body[k] !== 'string') return bad(res, `${k} must be a string`);
  }
  if (body.framing != null && !FRAMINGS.has(body.framing)) return bad(res, 'Unknown framing');
  if (body.prompt.length > COMPLETE_MAX_PROMPT_CHARS) return bad(res, `prompt too long (max ${COMPLETE_MAX_PROMPT_CHARS} characters)`);
  const prompt = sanitizeForPrompt(body.prompt);
  if (!prompt.trim()) return bad(res, 'Prompt is empty after sanitization');

  let text = prompt;
  if (body.framing === 'code-assist') {
    const lang = resolveLanguage(body.language);
    const languageLine = lang.directive
      ? `Always respond in ${lang.name}, even if the user writes in a different language.`
      : 'Answer in the same language the user asks in.';
    text = legacyBareCodeAssistPrompt(languageLine, prompt.slice(0, 20_000));
  }

  const model = resolveTierModel({ model: optString(body.model), tier: body.tier });
  const provider = optString(body.provider);
  const ac = new AbortController();
  onClientDisconnect(req, res, () => ac.abort());
  const agentRun = beginAgentRun(userId, {
    runId: `complete-${randomUUID()}`, source: 'loop', engine: 'complete', provider: provider ?? null, model: model ?? null,
  });
  try {
    const totals = newTurnTokenTotals();
    const out = await countTurnTokens(totals, () => run(text, {
      userId, maxTokens: COMPLETE_MAX_TOKENS, model, provider, signal: ac.signal, endpoint: '/kb/complete',
    }));
    if (ac.signal.aborted) {
      agentRun.finish({ status: 'cancelled' });
      return true;
    }
    const usage = turnTokenUsageFields(totals);
    agentRun.finish({ status: 'ok', ...runTotals(usage) });
    sendJSON(res, 200, { reply: String(out).trim(), ...(usage ? { usage } : {}) });
  } catch (err) {
    process.stderr.write(`[kb/complete] upstream error: ${err?.message || err}\n`);
    agentRun.finish({ status: 'error', errorCode: err?.code || 'RUN_ERROR' });
    const { status, body: errBody } = codeAssistErrorResponse(err);
    sendJSON(res, status, errBody);
  }
  return true;
}
