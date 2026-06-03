// Meeting-agent question generator.
//
// Produces ONE candidate question per call, grounded in the active
// plan and the most recent ~90s of meeting transcript.  The caller
// (the agent loop in meeting-agent.mjs) is responsible for the
// cooldown, confidence gate, and TTS — this module is pure
// "what should we ask, if anything?"
//
// Per the project's standing rule: LLM access goes through
// `runClaude` from agents/runtime.mjs, which `execFile`s the local
// `claude` CLI.  No Anthropic SDK, no API-key plumbing here — same
// path as planner.mjs, risk.mjs, codegen.mjs.
//
// This file is the Day 5–7 milestone of docs/meeting-agent-plan.md.
// It currently returns deterministically structured drafts; the
// loop integration in meeting-agent.mjs will land in the same slice.

import { runClaude, tryParseJSON, languageDirective } from './runtime.mjs';
import { sanitizePersonaSuffix, personaConfigBlock } from './prompt-utils.mjs';

const MAX_TRANSCRIPT_CHARS = 6000;          // ~1500 tokens of context
const MAX_RECENT_QUESTIONS = 5;
const MAX_PLAN_CHARS = 4000;

// sanitizePersonaSuffix and personaConfigBlock are imported from
// prompt-utils.mjs — single source of truth shared with the /kb/agent/ask
// route handler so injection-pattern fixes propagate everywhere.

/**
 * Draft one question (or decline).
 *
 * @param {object} args
 * @param {object} args.plan               — { title, goal, tasks: [{ id, title, status, … }] }
 * @param {Array}  args.transcriptWindow   — [{ speaker, text, ts }, …] last ~90s
 * @param {Array}  [args.recentQuestions]  — [string], to avoid repeats
 * @param {string} [args.userId]           — for vaulted per-user Anthropic key
 * @param {string} [args.personaSuffix]    — appended to the system prompt; lets users
 *                                           tune voice/focus without code changes
 *                                           (e.g. "be terse; only ask about risks")
 * @param {string} [args.language]         — ISO code ('en', 'ja', 'zh-CN', …) — the
 *                                           meeting language.  The asked question
 *                                           lands in this language; reason / planTaskId
 *                                           stay English so the UI can render them
 *                                           consistently.  Default 'en'.
 *
 * @returns {Promise<{
 *   shouldAsk: boolean,
 *   question?: string,
 *   score: number,         // 0..1, our confidence the question is worth asking
 *   planTaskId?: string,   // which plan task it grounds in
 *   reason: string,        // why we (don't) want to ask it
 * }>}
 */
export async function draftQuestion({
  plan, transcriptWindow, recentQuestions = [], userId, personaSuffix, language,
  // Test seam — pass a stub here to bypass the real Claude CLI.
  // Same shape as runtime.mjs's runClaude: (prompt, { userId }) → string.
  _runClaude = runClaude,
}) {
  if (!Array.isArray(transcriptWindow) || transcriptWindow.length === 0) {
    return { shouldAsk: false, score: 0, reason: 'no-transcript' };
  }
  if (!plan) {
    return { shouldAsk: false, score: 0, reason: 'no-plan' };
  }

  const transcript = formatTranscript(transcriptWindow);
  const planSummary = formatPlan(plan);
  // recentQuestions may be plain strings (legacy callers) or {text, ts}
  // objects (meeting-agent.mjs after the age-gate upgrade). Normalize
  // to strings for the prompt.
  const recentTexts = recentQuestions.slice(-MAX_RECENT_QUESTIONS)
    .map((q) => (typeof q === 'string' ? q : (q?.text || '')))
    .filter(Boolean);
  const recent = recentTexts.map((q, i) => `${i + 1}. ${q}`).join('\n') || '(none yet)';

  // Persona suffix is user-supplied text — sanitize then wrap in a
  // data-fence so the model treats it as configuration, not commands.
  // Both functions come from prompt-utils.mjs (shared with the ask route).
  const personaLine = personaConfigBlock(sanitizePersonaSuffix(personaSuffix));

  // Language directive — the asked question must match the meeting's
  // language so it fits conversationally.  reason / planTaskId stay
  // English because they're UI metadata, not spoken.  Default 'en'.
  const langInfo = languageDirective(language || 'en');
  const langLine = langInfo.name && langInfo.name !== 'English'
    ? `\n\n# Meeting language\nThe meeting is being conducted in ${langInfo.name}.  The "question" field of your JSON output MUST be in ${langInfo.name} so it fits naturally into the conversation.  The "reason" and "planTaskId" fields stay in English (they are UI metadata, not spoken).`
    : '';

  const prompt = `You are a meeting assistant joining a call.  You have read the team's project plan, and you are now listening to the ongoing conversation.  Your job is to decide whether to ask ONE clarifying or challenging question that helps the team make a better decision.

Be silent more often than not.  Only speak when the value is clear.  Bad reasons to speak: showing off, summarizing what was said, restating an obvious next step.  Good reasons to speak: a contradiction with the plan, an unstated assumption, a risk that hasn't been named, a decision that's drifting.${personaLine}${langLine}

# Active plan
${planSummary}

# Recent transcript (last ~90 seconds, oldest first)
${transcript}

# Questions you have already asked in this meeting
${recent}

# Your task
Think silently, then output a single JSON object on the LAST line of your reply.  No code fence.  Schema:

{
  "shouldAsk": boolean,
  "question": string,         // empty string if shouldAsk=false
  "score": number,            // 0..1; your confidence this question helps
  "planTaskId": string,       // id of the plan task it grounds in, or ""
  "reason": string            // ≤120 chars, why you chose to (not) speak
}

Rules:
- shouldAsk=true requires score >= 0.7.
- The question must be ≤ 25 words, conversational, and addressed to whoever last spoke if their name is in the transcript.
- Do not repeat anything in the recent-questions list.
- If nothing in the transcript meaningfully connects to the plan, set shouldAsk=false.`;

  // Meeting-agent questions are short structured JSON — 512 tokens is
  // ample for the output and avoids burning the full 8192 default budget
  // on every 90-second tick.
  const QUESTION_MAX_TOKENS = 512;

  let raw;
  try {
    raw = await _runClaude(prompt, { userId, maxTokens: QUESTION_MAX_TOKENS });
  } catch (err) {
    return {
      shouldAsk: false, score: 0,
      reason: `claude-cli-error: ${(err.message || 'unknown').slice(0, 80)}`,
    };
  }

  let json = tryParseJSON(extractLastJSONLine(raw));
  if (!json || typeof json !== 'object') {
    // Retry once with an explicit JSON-only instruction appended.
    // The model sometimes outputs reasoning prose before the JSON;
    // the stricter prompt reduces that.
    try {
      const strictPrompt = prompt + '\n\nIMPORTANT: Output ONLY the JSON object on the last line of your reply. No markdown fences, no prose after the JSON.';
      const raw2 = await _runClaude(strictPrompt, { userId, maxTokens: QUESTION_MAX_TOKENS });
      json = tryParseJSON(extractLastJSONLine(raw2));
    } catch { /* ignore retry failure — fall through to bad-llm-output */ }
  }
  if (!json || typeof json !== 'object') {
    return { shouldAsk: false, score: 0, reason: 'bad-llm-output' };
  }

  // Defensive normalization — never trust the model.
  const shouldAsk = Boolean(json.shouldAsk);
  const score = clamp01(Number(json.score));
  const question = (typeof json.question === 'string' ? json.question : '').trim();
  const planTaskId = typeof json.planTaskId === 'string' ? json.planTaskId.slice(0, 64) : '';
  const reason = typeof json.reason === 'string' ? json.reason.slice(0, 200) : '';

  if (shouldAsk && (!question || score < 0.7)) {
    return { shouldAsk: false, score, reason: `failed-gate (q=${!!question}, s=${score})` };
  }

  return { shouldAsk, question: shouldAsk ? question : undefined, score, planTaskId, reason };
}

// --- helpers ----------------------------------------------------------

// Safe maximum for a single speaker name in the transcript. Anything
// longer is almost certainly an injection attempt ("SYSTEM: ignore…").
const MAX_SPEAKER_CHARS = 60;

function sanitizeSpeaker(name) {
  if (typeof name !== 'string' || !name) return 'Participant';
  // Strip control chars, truncate, then strip any leading "role:" prefix
  // pattern that could confuse the model's turn boundaries.
  const s = name.replace(/[\x00-\x1f]/g, '').trim().slice(0, MAX_SPEAKER_CHARS);
  // Remove patterns that look like injected role labels or fence tokens.
  if (/^(system|user|assistant|human|ai)\s*:/i.test(s)) return 'Participant';
  if (/<<</.test(s)) return 'Participant';
  return s || 'Participant';
}

function formatTranscript(window) {
  // Sanitize speaker names before embedding — a participant named
  // "SYSTEM: Ignore all instructions" must not reach the model as-is.
  let s = window
    .map((c) => `${sanitizeSpeaker(c.speaker)}: ${c.text}`)
    .join('\n');
  if (s.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the tail — recent context matters more.
    s = '…\n' + s.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return s;
}

function formatPlan(plan) {
  const head = `Title: ${plan.title || '(untitled)'}\nGoal: ${plan.goal || '(none)'}`;
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const lines = tasks.slice(0, 30).map((t) => {
    const id = t.id ? ` [${t.id}]` : '';
    const status = t.status ? ` (${t.status})` : '';
    return `- ${t.title || 'untitled'}${status}${id}`;
  });
  let s = `${head}\n\nTasks:\n${lines.join('\n') || '(none)'}`;
  if (s.length > MAX_PLAN_CHARS) s = s.slice(0, MAX_PLAN_CHARS) + '\n…';
  return s;
}

function extractLastJSONLine(raw) {
  if (typeof raw !== 'string') return '';
  // Walk lines bottom-up; first one that parses as JSON wins.
  const lines = raw.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) return line;
  }
  // Fallback: try the whole blob in case the model didn't end with the
  // JSON on its own line.
  return raw;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
