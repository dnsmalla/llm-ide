// Auto memory extraction. After a Code Assistant turn, distill two things
// from ONE model call:
//
//  - PROJECT facts: 0–N DURABLE, project-specific facts worth recalling in
//    future sessions, deduped against what's already remembered. Persisted
//    by memory-writer.mjs into chat-memory.md and recalled by
//    graphkit/memory.mjs (legacy) / the project_memory tool (Agent engine).
//  - SESSION facts: what THIS conversation has established that its own next
//    turn needs — the decision the user just made, the option they picked,
//    the goal and constraints they stated, which phase the work is in, what
//    is still open. Persisted to kb/session-memory.mjs and injected as "This
//    session's memory"; deleted with the chat.
//
// The two buckets exist because one criterion cannot serve both. The
// project prompt is (rightly) biased toward returning nothing — "will this
// still be true next week?" — and for a year session memory was filled only
// with what passed THAT bar, so the facts a session actually runs on were
// rejected as transient and the table sat empty (last write 2026-08-30, then
// two weeks of chats with none).
//
// Design constraints:
//  - Cheap: one short, capped LLM call on a summarize-tier model.
//  - Best-effort: any failure (LLM error, bad JSON) yields [] — never throws,
//    never blocks the user's reply (the caller runs this fire-and-forget).
//  - Conservative: the prompt is biased toward returning NOTHING. We only want
//    stable facts ("uses pnpm workspaces", "deploys via X"), not transient
//    chatter ("fix this typo", "what does foo do").

import { tryParseJSON } from '../../providers/runtime.mjs';
import { fastModelFor } from '../../kb/usage.mjs';
import { factKey, factIndex } from '../../graphkit/memory-writer.mjs';
import { rankFactsByRelevance } from '../../graphkit/memory.mjs';

// Fast tier by default: extraction is a 512-token classification-style call
// that runs fire-and-forget after EVERY turn — on the CLI path it measured
// minutes on the server's default model, pure overhead for a task the
// chain's smallest model handles. Chain-derived (kb/usage.mjs), never a
// hard-coded literal; env overrides keep working.
export const EXTRACT_MODEL = process.env.LLMIDE_SUMMARIZE_MODEL
  || process.env.LLMIDE_MODEL
  || fastModelFor('anthropic');
const MAX_NEW_FACTS = 5;
// Session facts per turn. More than project facts: a turn that settles a
// design can legitimately fix several decisions at once.
const MAX_SESSION_FACTS = 6;
const MAX_FACT_CHARS = 280;
// Keep the inputs bounded so a huge turn can't blow the extractor's budget.
const MAX_INPUT_CHARS = 6_000;
// How many already-known facts the model is shown.
//
// Was 60. This call runs after EVERY substantive turn, so this list is a
// per-turn tax that grows as the project learns: measured at ~2.1K input
// tokens with an empty memory, ~3.4K at 20 facts and ~6.1K at 60 — the
// extractor's cost tripling purely because it had learned more. 20 keeps the
// list bounded, and pairing it with relevance ranking (below) makes the
// smaller list BETTER targeted than the larger blind one was: the facts most
// likely to be revised by this turn are the ones now shown.
//
// The cost of showing fewer is bounded. The model may only supersede facts it
// was shown, so a fact outside the 20 cannot be retired this turn — but it
// also cannot be duplicated, because `appendChatMemory` upserts by factIndex
// against the FULL on-disk list regardless of what was shown.
const MAX_EXISTING_LISTED = 20;

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

// A fact's stable subject id: what makes "the same fact with a new value" an
// UPDATE rather than a second, contradictory row (see `factIndex` in
// graphkit/memory-writer.mjs). Kebab-case, bounded, and stripped of anything
// that would break the `[category|id]` tag it's stored in.
const MAX_KEY_CHARS = 48;
function normalizeKey(k) {
  if (typeof k !== 'string') return '';
  return k.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // also removes `|` and `]`, which would corrupt the tag
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY_CHARS)
    .replace(/-+$/, '');
}

// Exported for unit testing the prompt-independent parsing/sanitising logic.
// Accepts plain strings (legacy) or `{ category, key, fact }` objects and emits
// tagged strings: `[category|key] fact`, degrading to `[category] fact` or a
// bare fact as the pieces go missing.
//
// Dedup within one batch is by the fact's INDEX — its `key` when it has one,
// else its text — so a model that emits the same subject twice in one response
// yields one fact (the last wins, matching the writer's upsert), rather than two
// rows that then fight each other.
export function sanitizeFacts(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const slotByIndex = new Map();
  for (const item of parsed) {
    let rawFact;
    let rawCat;
    let rawKey;
    if (typeof item === 'string') {
      rawFact = item;
    } else if (item && typeof item === 'object' && typeof item.fact === 'string') {
      rawFact = item.fact;
      rawCat = item.category;
      rawKey = item.key;
    } else {
      continue;
    }
    const cat = normalizeCategory(rawCat);
    const key = normalizeKey(rawKey);
    const tag = key ? (cat ? `${cat}|${key}` : `|${key}`) : cat;
    // Budget the tag INSIDE MAX_FACT_CHARS. The writer caps whole stored lines
    // at the same number, so slicing only the fact text and then prepending
    // `[category|key] ` produced a line the writer would clip — and a clipped
    // stored line never equals the incoming one, so every later turn saw a
    // phantom "update" and rewrote the file.
    const framing = tag ? tag.length + 3 : 0;   // "[" + "]" + " "
    const fact = rawFact.trim().replace(/\s+/g, ' ')
      .slice(0, Math.max(0, MAX_FACT_CHARS - framing));
    if (fact.length < 4) continue; // junk / empty
    const rendered = tag ? `[${tag}] ${fact}` : fact;
    // Index the RENDERED line through the writer's own rule, so the extractor
    // and the store can never disagree about what counts as the same fact.
    const index = factIndex(rendered);
    const slot = slotByIndex.get(index);
    if (slot !== undefined) {
      out[slot] = rendered;          // same subject twice in one batch → last wins
      continue;
    }
    if (out.length >= MAX_NEW_FACTS) continue;
    slotByIndex.set(index, out.length);
    out.push(rendered);
  }
  return out;
}

// Superseded entries are only trusted when they match a fact in the list
// PASSED IN by factKey (the writer's own normalization) — the model may only
// retire facts it was SHOWN, never invent one. Callers MUST pass the same
// slice of facts that was actually rendered into the prompt (buildPrompt caps
// at MAX_EXISTING_LISTED), not the full on-disk list, or a claim could match
// a fact the model never saw. Returns the canonical stored text so the
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

// Session facts are plain sentences — no category/key: they are not upserted
// by subject the way project facts are, they are appended and later deleted
// wholesale with the chat. Same hygiene as sanitizeFacts (trim, collapse
// whitespace, cap length, drop junk, dedupe by factIndex, cap the count).
// Exported for unit testing.
export function sanitizeSessionFacts(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const fact = item.trim().replace(/\s+/g, ' ').slice(0, MAX_FACT_CHARS);
    if (fact.length < 4) continue;
    const index = factIndex(fact);
    if (seen.has(index)) continue;
    if (out.length >= MAX_SESSION_FACTS) break;
    seen.add(index);
    out.push(fact);
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

/**
 * The already-known facts to show this turn: the most relevant
 * `MAX_EXISTING_LISTED`, ranked against the user's message with the same
 * scorer the prompt-injection path uses (graphkit/memory.mjs).
 *
 * One selection, computed once. It used to be made twice — `buildPrompt`
 * sliced for the prompt and `extractMemories` sliced again for
 * `sanitizeSuperseded` — with a comment warning that the two MUST agree or a
 * superseded claim could be validated against a fact the model was never
 * shown. Two call sites that must agree is a bug waiting for an edit; now
 * there is one.
 */
function selectExistingForPrompt(existingFacts, userMessage) {
  const all = Array.isArray(existingFacts) ? existingFacts : [];
  if (all.length <= MAX_EXISTING_LISTED) return all;
  return rankFactsByRelevance(all, { userMessage }).slice(0, MAX_EXISTING_LISTED);
}

function buildPrompt({ userMessage, reply, existingFacts }) {
  const existing = (Array.isArray(existingFacts) ? existingFacts : [])
    .map((f) => `- ${f}`)
    .join('\n') || '(none yet)';
  return [
    'You maintain two memories for a coding assistant:',
    '  1. PROJECT memory — DURABLE facts about the software project, recalled',
    '     in every future session.',
    '  2. SESSION memory — what THIS conversation has established, recalled',
    '     only by later turns of this same chat, then forgotten with it.',
    '',
    'From the exchange below, extract into "facts" only NEW, durable,',
    'project-specific facts worth remembering long-term — e.g. conventions,',
    'architecture decisions, tooling, deploy/test commands, stable user',
    'preferences for THIS project.',
    '',
    'Extract into "session" what the NEXT turn of this chat needs to continue',
    'correctly and that is NOT a durable project fact: a decision the user just',
    'made, an option they chose, a goal or constraint they stated for this',
    'task, the phase the work is in, what is still open. One sentence each,',
    'present tense, self-contained ("User chose the phased approach over a',
    'single sweep", "Plan title is Dead Code Removal; design is saved, plan',
    `not yet written"). At most ${MAX_SESSION_FACTS}; empty when the turn`,
    'settled nothing — a question asked and not yet answered settles nothing.',
    '',
    'Rules:',
    '- Exclude anything already in ALREADY KNOWN (do not restate or rephrase it).',
    '- Exclude transient/one-off details, the specific question, code dumps,',
    '  and anything that will not still be true next week.',
    `- Return at most ${MAX_NEW_FACTS} facts. Prefer returning fewer, or none.`,
    '- Each fact: one concise sentence, self-contained.',
    '- Classify each fact with a category, exactly one of:',
    '  convention | architecture | tooling | command | preference.',
    '- Give each fact a "key": a short kebab-case id for its SUBJECT that stays',
    '  the same even when the subject\'s value changes (e.g. "server-port",',
    '  "package-manager", "test-command"). Do NOT put the value in the key.',
    '- If a fact you return REVISES something in ALREADY KNOWN, reuse that',
    '  entry\'s existing key exactly (keys are shown as [category|key]) — the',
    '  new text then REPLACES the stored one instead of contradicting it.',
    '- If the exchange shows an ALREADY KNOWN fact is now WRONG or outdated and',
    '  has no replacement (removed tool, abandoned convention), list that fact',
    '  VERBATIM (exactly as written above) in "superseded".',
    '- Output ONLY JSON: {"facts": [{"category": "<category>", "key":',
    '  "<kebab-case-subject>", "fact": "<one concise sentence>"}],',
    '  "session": ["<one sentence>"],',
    '  "superseded": ["<verbatim known fact>"]}.',
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
    'JSON:',
  ].join('\n');
}

// Returns { facts, sessionFacts, superseded }: facts are NEW project facts
// (sanitised + capped, NOT yet deduped against disk — appendChatMemory does
// that); sessionFacts are this conversation's state sentences
// (sanitizeSessionFacts); superseded are EXISTING project facts the model
// marked outdated, canonicalised via factKey.
// `model` (optional) lets the caller extract on the TURN's own provider
// fast tier — a codex/OpenAI chat must not force an Anthropic call.
export async function extractMemories({ userMessage, reply, existingFacts, runClaude, userId, meta, model }) {
  const empty = { facts: [], sessionFacts: [], superseded: [] };
  if (typeof runClaude !== 'function') return empty;
  // Local pre-filter: skip the paid summarize-tier call on turns that can't
  // carry a durable fact (empty reply, pure acknowledgments). This runs on
  // EVERY turn, so gating the no-value ones is the single biggest token win.
  if (!isWorthExtracting({ userMessage, reply })) {
    if (meta && typeof meta === 'object') { meta.approxTokens = 0; meta.skipped = true; }
    return empty;
  }
  // The facts the model is actually shown — and therefore the only ones it
  // may retire. `sanitizeSuperseded` is validated against this exact list, so
  // the "only retire what it was shown" guarantee holds by construction
  // rather than by two slices happening to match.
  const shownFacts = selectExistingForPrompt(existingFacts, userMessage);
  try {
    const prompt = buildPrompt({ userMessage, reply, existingFacts: shownFacts });
    const raw = await runClaude(prompt, {
      userId,
      model: model || EXTRACT_MODEL,
      // Two buckets now ride in one response; 512 clipped the JSON when a
      // design-settling turn filled both, and a clipped response parses as
      // nothing — every fact of that turn lost, not just the last one.
      maxTokens: 768,
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
    const sessionArr = (!Array.isArray(parsed) && parsed && Array.isArray(parsed.session))
      ? parsed.session : [];
    return {
      facts: sanitizeFacts(factsArr),
      sessionFacts: sanitizeSessionFacts(sessionArr),
      superseded: sanitizeSuperseded(supersededArr, shownFacts),
    };
  } catch {
    return empty;
  }
}
