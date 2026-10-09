// Jev decision client (jev-ai.pro).
//
// Jev is a hosted DECISION API, not a chat model: given some material
// (`state`) and 1–64 typed questions, it answers each with a calibrated
// probability — `noul` (yes/no), `choice` (pick one of named options) or
// `score` (a level on an ordered scale). This module is the only place that
// speaks its wire format; llm_agent/runtime/decide.mjs decides WHEN to call it
// (the `decisions` tier role) and owns the LLM fallback.
//
//   POST <base>/v1/systemone   Authorization: Bearer <key>
//     { model?, state, questions: { <id>: { type, instructions, criteria? } } }
//   → 200 { model, answers: { <id>: {...} }, usage: { input_tokens, output_tokens } }
//   → 4xx/5xx { error: { code, message } }
//
// Jev is decision-only in PROVIDERS (providers.mjs): every chat/completion
// path refuses it, so this client is never reached through runClaude.

import { getDb } from '../kb/db.mjs';
import { logger } from '../core/logger.mjs';
import { recordUsage } from '../kb/usage.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';
import { jevBaseUrl } from './providers.mjs';

const log = logger.child({ component: 'jev' });

export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);

// Limits from Jev's API contract (questions 1–64, choice options 2–255,
// score levels 2–10), plus local caps that keep a model-built request — the
// `decide` tool's arguments arrive from an LLM — inside sane bounds.
const MAX_QUESTIONS = 64;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 255;
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;
const QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_INSTRUCTIONS_CHARS = 4000;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1000;
// The material Jev evaluates. Serialized length, so an object state is
// bounded the same way as a string one.
export const MAX_STATE_CHARS = 200_000;
// Serialized cap on the whole `questions` map — the same 64k the fence
// validator applies to an `object` argument, enforced HERE so the Agent v2
// path (whose zod schema cannot express a size cap) is bounded too.
export const MAX_QUESTIONS_CHARS = 65_536;
// Jev refuses a request body over 256,000 bytes; stay under it with margin.
// A bigger request never leaves the box (JEV_TOO_LARGE → decide.mjs answers
// on the LLM instead).
export const MAX_JEV_BODY_BYTES = 250_000;
// Keys that would hit Object.prototype setters (or shadow it) on a plain
// object: assigning `__proto__` changes the prototype and the entry silently
// vanishes. Refused as question ids and option names.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_TIMEOUT_MS = 30_000;

function validationError(message) {
  return Object.assign(new Error(message), { code: 'VALIDATION_FAILED', status: 400 });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkDescription(value, where) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError(`${where} must be a string or null`);
  if (value.length > MAX_DESCRIPTION_CHARS) throw validationError(`${where} exceeds ${MAX_DESCRIPTION_CHARS} chars`);
  return value;
}

/**
 * Validate (and copy) a `questions` map against Jev's contract. Returns a new
 * object holding only the fields Jev reads; throws a VALIDATION_FAILED error
 * naming the first problem. Shared by the Jev path and the LLM fallback, so
 * both engines answer exactly the same question shapes.
 */
export function validateJevQuestions(questions) {
  if (!isPlainObject(questions)) throw validationError('questions must be an object of { <id>: { type, instructions, criteria? } }');
  let size;
  try { size = JSON.stringify(questions).length; } catch { throw validationError('questions must be JSON-serializable'); }
  if (size > MAX_QUESTIONS_CHARS) throw validationError(`questions exceed ${MAX_QUESTIONS_CHARS} chars serialized`);
  const ids = Object.keys(questions);
  if (ids.length < 1 || ids.length > MAX_QUESTIONS) {
    throw validationError(`questions must hold 1–${MAX_QUESTIONS} entries (got ${ids.length})`);
  }
  const out = {};
  for (const id of ids) {
    if (RESERVED_KEYS.has(id)) throw validationError(`question id '${id}' is reserved`);
    if (!QUESTION_ID_RE.test(id)) throw validationError(`question id '${String(id).slice(0, 64)}' must match ${QUESTION_ID_RE}`);
    const q = questions[id];
    if (!isPlainObject(q)) throw validationError(`questions.${id} must be an object`);
    if (!JEV_QUESTION_TYPES.includes(q.type)) {
      throw validationError(`questions.${id}.type must be one of ${JEV_QUESTION_TYPES.join(', ')}`);
    }
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) {
      throw validationError(`questions.${id}.instructions must be a non-empty string`);
    }
    if (q.instructions.length > MAX_INSTRUCTIONS_CHARS) {
      throw validationError(`questions.${id}.instructions exceeds ${MAX_INSTRUCTIONS_CHARS} chars`);
    }
    const entry = { type: q.type, instructions: q.instructions };
    const c = q.criteria;
    if (q.type === 'choice') {
      if (!isPlainObject(c)) throw validationError(`questions.${id}.criteria must be an object of option → description|null`);
      const options = Object.keys(c);
      if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
        throw validationError(`questions.${id}.criteria must name ${MIN_OPTIONS}–${MAX_OPTIONS} options (got ${options.length})`);
      }
      entry.criteria = {};
      for (const opt of options) {
        if (!opt.trim() || opt.length > MAX_LABEL_CHARS) throw validationError(`questions.${id} option names must be 1–${MAX_LABEL_CHARS} chars`);
        if (RESERVED_KEYS.has(opt)) throw validationError(`questions.${id} option name '${opt}' is reserved`);
        entry.criteria[opt] = checkDescription(c[opt], `questions.${id}.criteria['${opt.slice(0, 40)}']`);
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(c) || c.length < MIN_LEVELS || c.length > MAX_LEVELS) {
        throw validationError(`questions.${id}.criteria must be an ordered array of ${MIN_LEVELS}–${MAX_LEVELS} levels`);
      }
      for (const level of c) {
        if (typeof level !== 'string' || !level.trim() || level.length > MAX_DESCRIPTION_CHARS) {
          throw validationError(`questions.${id}.criteria levels must be non-empty strings (≤ ${MAX_DESCRIPTION_CHARS} chars)`);
        }
      }
      entry.criteria = [...c];
    } else if (c !== undefined && c !== null) {
      // noul: optional { true?, false? } descriptions of what each answer means.
      if (!isPlainObject(c) || Object.keys(c).some((k) => k !== 'true' && k !== 'false')) {
        throw validationError(`questions.${id}.criteria for a noul question may only hold 'true' / 'false' descriptions`);
      }
      entry.criteria = {};
      for (const k of Object.keys(c)) entry.criteria[k] = checkDescription(c[k], `questions.${id}.criteria.${k}`);
    }
    out[id] = entry;
  }
  return out;
}

/** Validate the material to evaluate: a non-empty string, object or array within MAX_STATE_CHARS. */
export function validateJevState(state) {
  if (typeof state === 'string') {
    if (!state.trim()) throw validationError('state must not be empty');
    if (state.length > MAX_STATE_CHARS) throw validationError(`state exceeds ${MAX_STATE_CHARS} chars`);
    return state;
  }
  if (state !== null && typeof state === 'object') {
    let size;
    try { size = JSON.stringify(state).length; } catch { throw validationError('state must be JSON-serializable'); }
    if (size > MAX_STATE_CHARS) throw validationError(`state exceeds ${MAX_STATE_CHARS} chars serialized`);
    return state;
  }
  throw validationError('state must be a string, object or array');
}

// Jev's error envelope `{ error: { code, message } }` → one bounded, key-
// redacted line. Never the raw page: an HTML error page or a proxy dump would
// otherwise reach the model (and the chat) verbatim.
async function jevHttpError(res, apiKey) {
  let code = null;
  let message = '';
  try {
    const raw = await res.text();
    try {
      const body = JSON.parse(raw);
      // Jev's error code is a NUMBER today; accept a string too.
      const rawCode = body?.error?.code;
      code = typeof rawCode === 'string' || (typeof rawCode === 'number' && Number.isFinite(rawCode)) ? String(rawCode) : null;
      message = typeof body?.error?.message === 'string' ? body.error.message : '';
    } catch { message = ''; }   // non-JSON (HTML page, proxy text) — not echoed
  } catch { /* unreadable body */ }
  const detail = redactWithKey(message, apiKey).replace(/\s+/g, ' ').trim().slice(0, 300);
  const status = res.status;
  const label = {
    401: 'Jev rejected the API key', 402: 'Jev account has no remaining credit',
    403: 'Jev refused the request', 404: 'Jev model not found', 409: 'Jev request conflict',
    422: 'Jev could not process these questions', 429: 'Jev rate limit reached',
  }[status] || (status >= 500 ? 'Jev server error' : 'Jev request failed');
  const err = new Error(`${label} (HTTP ${status}${code ? ` ${redactWithKey(code, apiKey).slice(0, 60)}` : ''})${detail ? `: ${detail}` : ''}`);
  err.status = status;
  err.code = 'JEV_HTTP_ERROR';
  if (code) err.jevCode = code.slice(0, 60);
  // Auth/billing problems never clear on retry and must not be papered over by
  // a silent LLM fallback — the user has to fix the key.
  err.auth = status === 401 || status === 402 || status === 403;
  err.transient = status === 429 || status >= 500;
  err.reason = status === 429 ? 'jev_rate_limited' : status >= 500 ? 'jev_server_error' : `jev_http_${status}`;
  return err;
}

function transientError(message, reason) {
  return Object.assign(new Error(message), { code: 'JEV_UNAVAILABLE', transient: true, auth: false, reason });
}

/**
 * Ask Jev the given questions about `state`. Returns `{ model, answers, usage }`
 * (`usage` = `{ inputTokens, outputTokens }`). Throws:
 *   - VALIDATION_FAILED (`status: 400`) on a bad `state` / `questions`, before any request;
 *   - JEV_HTTP_ERROR with `status`, `auth`, `transient`, `reason` on a non-200;
 *   - JEV_UNAVAILABLE (`transient: true`) on a timeout, network error or a
 *     malformed 200;
 *   - JEV_TOO_LARGE (`transient: true`, reason 'jev_too_large') when the body
 *     would exceed MAX_JEV_BODY_BYTES — nothing is sent;
 *   - a plain Error (SSRF guard) for an unsafe JEV_AI_BASE_URL;
 *   - the caller's AbortError when `signal` fires.
 * Usage is recorded in the ledger (provider 'jev', endpoint 'decide'), which
 * also feeds the current turn's token totals (kb/usage.mjs countTurnTokens).
 */
export async function jevDecide({ apiKey, model, state, questions, signal, userId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) throw Object.assign(new Error('No Jev API key configured. Add one in Settings → Model Providers.'), { code: 'PROVIDER_UNAVAILABLE', auth: true });
  const body = {
    model: typeof model === 'string' && model.trim() ? model.trim() : JEV_DEFAULT_MODEL,
    state: validateJevState(state),
    questions: validateJevQuestions(questions),
  };
  // Resolved BEFORE the request: a bad JEV_AI_BASE_URL is a config error the
  // operator must see, not a "network" failure that silently falls back.
  const url = `${jevBaseUrl()}/v1/systemone`;
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, 'utf8') > MAX_JEV_BODY_BYTES) {
    throw Object.assign(new Error(`The decision request is larger than Jev accepts (${MAX_JEV_BODY_BYTES} bytes)`),
      { code: 'JEV_TOO_LARGE', transient: true, auth: false, reason: 'jev_too_large' });
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: payload,
      // The key rides in Authorization — never follow a 3xx with it.
      redirect: 'error',
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) throw err;                       // the caller stopped — not a Jev failure
    if (timeout.aborted) throw transientError(`Jev did not answer within ${Math.round(timeoutMs / 1000)} s`, 'jev_timeout');
    throw transientError(`Could not reach Jev: ${redactWithKey(String(err?.message || err), apiKey).slice(0, 200)}`, 'jev_network');
  }
  if (!res.ok) throw await jevHttpError(res, apiKey);
  let data;
  try { data = await res.json(); } catch { data = null; }
  const usage = {
    inputTokens: data?.usage?.input_tokens ?? null,
    outputTokens: data?.usage?.output_tokens ?? null,
  };
  const ranModel = typeof data?.model === 'string' && data.model ? data.model.slice(0, 128) : body.model;
  // Best-effort metering — a ledger write must never fail the decision.
  // Recorded BEFORE the answers check: a malformed 200 may still be billed.
  try {
    recordUsage(getDb(), {
      userId, provider: 'jev', model: ranModel, source: 'api', endpoint: 'decide',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    });
  } catch { /* ignore */ }
  if (!isPlainObject(data?.answers)) throw transientError('Jev returned a response without answers', 'jev_bad_response');
  // Only the asked ids — an unexpected extra key is dropped, not forwarded.
  const answers = {};
  for (const id of Object.keys(body.questions)) {
    if (Object.hasOwn(data.answers, id) && isPlainObject(data.answers[id])) answers[id] = data.answers[id];
  }
  log.info('jev_decide', { model: ranModel, questions: Object.keys(body.questions).length, answered: Object.keys(answers).length });
  return { model: ranModel, answers, usage };
}
