// Auto project-memory extraction. After a Code Assistant turn, distill 0–N
// DURABLE, project-specific facts worth recalling in future sessions, deduped
// against what's already remembered. Persisted by memory-writer.mjs into
// chat-memory.md and recalled for free by graphkit/memory.mjs next request.
//
// Design constraints:
//  - Cheap: one short, capped LLM call on a summarize-tier model.
//  - Best-effort: any failure (LLM error, bad JSON) yields [] — never throws,
//    never blocks the user's reply (the caller runs this fire-and-forget).
//  - Conservative: the prompt is biased toward returning NOTHING. We only want
//    stable facts ("uses pnpm workspaces", "deploys via X"), not transient
//    chatter ("fix this typo", "what does foo do").

import { tryParseJSON } from '../../agents/runtime.mjs';
import { factKey } from '../../graphkit/memory-writer.mjs';

const EXTRACT_MODEL = process.env.LLMIDE_SUMMARIZE_MODEL || process.env.LLMIDE_MODEL || undefined;
const MAX_NEW_FACTS = 5;
const MAX_FACT_CHARS = 280;
// Keep the inputs bounded so a huge turn can't blow the extractor's budget.
const MAX_INPUT_CHARS = 6_000;
const MAX_EXISTING_LISTED = 60;

function clip(s, n) {
  s = typeof s === 'string' ? s : '';
  return s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s;
}

// Categories a durable fact can carry. Tagged inline as `[category] fact` so
// the agent can weigh facts by kind; anything outside this set is dropped to an
// untagged fact rather than inventing a category.
const FACT_CATEGORIES = new Set(['convention', 'architecture', 'tooling', 'command', 'preference']);
function normalizeCategory(c) {
  const k = typeof c === 'string' ? c.trim().toLowerCase() : '';
  return FACT_CATEGORIES.has(k) ? k : '';
}

// Exported for unit testing the prompt-independent parsing/sanitising logic.
// Accepts either plain strings (legacy) or `{ category, fact }` objects and
// emits `[category] fact` strings (untagged when the category is missing or
// unknown). Dedup is by the fact TEXT so the same fact can't slip in twice
// under different categories.
export function sanitizeFacts(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    let rawFact;
    let rawCat;
    if (typeof item === 'string') {
      rawFact = item;
    } else if (item && typeof item === 'object' && typeof item.fact === 'string') {
      rawFact = item.fact;
      rawCat = item.category;
    } else {
      continue;
    }
    const fact = rawFact.trim().replace(/\s+/g, ' ').slice(0, MAX_FACT_CHARS);
    if (fact.length < 4) continue; // junk / empty
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cat = normalizeCategory(rawCat);
    out.push(cat ? `[${cat}] ${fact}` : fact);
    if (out.length >= MAX_NEW_FACTS) break;
  }
  return out;
}

// Superseded entries are only trusted when they match an existing fact by
// factKey (the writer's own normalization) — the model may only retire facts
// it was SHOWN, never invent one. Returns the canonical stored text so the
// writer's removal matches exactly. Exported for unit testing.
export function sanitizeSuperseded(parsed, existingFacts) {
  if (!Array.isArray(parsed)) return [];
  const byKey = new Map((Array.isArray(existingFacts) ? existingFacts : [])
    .map((f) => [factKey(f), f]));
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const key = factKey(item);
    const canonical = byKey.get(key);
    if (!canonical || seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

// Acknowledgment / pleasantry phrases the user sends to close a turn — these
// never carry a durable project fact. Ordered longest-first so multi-word
// phrases match before their single-word prefixes when stripped from the front.
const ACK_PHRASES = [
  'thank you', 'that works', 'sounds good', 'makes sense', 'looks good',
  'got it', 'will do', 'thanks', 'thank', 'thx', 'ty', 'okay', 'ok',
  'great', 'perfect', 'nice', 'cool', 'awesome', 'lgtm', 'yep', 'yes',
  'nope', 'no', 'done', 'works', 'understood', 'good', 'fine', 'sure', 'k',
];
// `^(phrase)\b[\s!.,]*` — a leading ack phrase plus trailing separators.
const ACK_LEAD_RE = new RegExp(`^(?:${ACK_PHRASES.join('|')})\\b[\\s!.,]*`, 'i');

// True when the whole (short) message is nothing but chained ack phrases —
// "thanks", "ok great, that works!", "perfect thank you". Strips leading acks
// repeatedly; if nothing but separators remain, it was pure acknowledgment.
function isPureAck(msg) {
  if (msg.length === 0 || msg.length > 40) return false;   // length cap guards pathological input
  let rest = msg;
  for (let i = 0; i < 6; i++) {                             // bounded: at most a few chained acks
    const next = rest.replace(ACK_LEAD_RE, '');
    if (next === rest) break;                              // nothing stripped this round
    rest = next;
  }
  return /^[\s!.,]*$/.test(rest);                          // only separators left → pure ack
}

// Cheap, local pre-filter run BEFORE the extraction model call. Returns false
// when a turn cannot plausibly contain a new durable fact, so the caller can
// skip the (paid, every-turn) LLM call. Conservative by design — when unsure,
// return true and let the model decide. A substantive short statement like
// "we use pnpm workspaces" is NOT an ack and still goes through.
export function isWorthExtracting({ userMessage, reply }) {
  // No assistant reply → nothing was produced to extract from (mirrors the
  // existing guard, folded in so the gate is the single decision point).
  if (!reply || typeof reply !== 'string' || !reply.trim()) return false;
  const um = typeof userMessage === 'string' ? userMessage.trim() : '';
  if (isPureAck(um.toLowerCase())) return false;
  return true;
}

function buildPrompt({ userMessage, reply, existingFacts }) {
  const existing = (Array.isArray(existingFacts) ? existingFacts : [])
    .slice(0, MAX_EXISTING_LISTED)
    .map((f) => `- ${f}`)
    .join('\n') || '(none yet)';
  return [
    'You maintain a long-term memory of DURABLE facts about a software project,',
    'used to ground a coding assistant in future sessions.',
    '',
    'From the exchange below, extract only NEW, durable, project-specific facts',
    'worth remembering long-term — e.g. conventions, architecture decisions,',
    'tooling, deploy/test commands, stable user preferences for THIS project.',
    '',
    'Rules:',
    '- Exclude anything already in ALREADY KNOWN (do not restate or rephrase it).',
    '- Exclude transient/one-off details, the specific question, code dumps,',
    '  and anything that will not still be true next week.',
    `- Return at most ${MAX_NEW_FACTS} facts. Prefer returning fewer, or none.`,
    '- Each fact: one concise sentence, self-contained.',
    '- Classify each fact with a category, exactly one of:',
    '  convention | architecture | tooling | command | preference.',
    '- If the exchange shows an ALREADY KNOWN fact is now WRONG or outdated',
    '  (replaced tool, changed convention, reversed decision), list that fact',
    '  VERBATIM (exactly as written above) in "superseded" — and put the',
    '  replacement, if any, in "facts".',
    '- Output ONLY JSON: {"facts": [{"category": "<category>", "fact":',
    '  "<one concise sentence>"}], "superseded": ["<verbatim known fact>"]}.',
    '  Use empty arrays when nothing qualifies.',
    '',
    'ALREADY KNOWN:',
    existing,
    '',
    'USER MESSAGE:',
    clip(userMessage, MAX_INPUT_CHARS),
    '',
    'ASSISTANT REPLY:',
    clip(reply, MAX_INPUT_CHARS),
    '',
    'JSON array of new durable facts:',
  ].join('\n');
}

// Returns { facts, superseded }: facts are NEW facts (sanitised + capped, NOT
// yet deduped against disk — appendChatMemory does that); superseded are
// EXISTING facts the model marked outdated, canonicalised via factKey.
export async function extractMemories({ userMessage, reply, existingFacts, runClaude, userId, meta }) {
  const empty = { facts: [], superseded: [] };
  if (typeof runClaude !== 'function') return empty;
  // Local pre-filter: skip the paid summarize-tier call on turns that can't
  // carry a durable fact (empty reply, pure acknowledgments). This runs on
  // EVERY turn, so gating the no-value ones is the single biggest token win.
  if (!isWorthExtracting({ userMessage, reply })) {
    if (meta && typeof meta === 'object') { meta.approxTokens = 0; meta.skipped = true; }
    return empty;
  }
  try {
    const prompt = buildPrompt({ userMessage, reply, existingFacts });
    const raw = await runClaude(prompt, {
      userId,
      model: EXTRACT_MODEL,
      maxTokens: 512,
    });
    // Optional observability sink: rough token cost of THIS extraction call
    // (prompt + response, ~4 chars/token — the same estimate the memory_context
    // log uses), so the caller can surface what fact-capture spends per turn.
    if (meta && typeof meta === 'object') {
      meta.approxTokens = Math.round((prompt.length + (typeof raw === 'string' ? raw.length : 0)) / 4);
    }
    const parsed = tryParseJSON(raw);
    // New shape: {facts: [...], superseded: [...]}. Legacy shape (bare array
    // of facts) still parses — models occasionally regress to it.
    const factsArr = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.facts) ? parsed.facts : []);
    const supersededArr = (!Array.isArray(parsed) && parsed && Array.isArray(parsed.superseded))
      ? parsed.superseded : [];
    return {
      facts: sanitizeFacts(factsArr),
      superseded: sanitizeSuperseded(supersededArr, existingFacts),
    };
  } catch {
    return empty;
  }
}
