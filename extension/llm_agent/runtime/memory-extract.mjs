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

// Exported for unit testing the prompt-independent parsing/sanitising logic.
export function sanitizeFacts(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const fact = item.trim().replace(/\s+/g, ' ');
    if (fact.length < 4) continue; // junk / empty
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact.slice(0, MAX_FACT_CHARS));
    if (out.length >= MAX_NEW_FACTS) break;
  }
  return out;
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
    '- Output ONLY a JSON array of strings. Empty array [] if nothing qualifies.',
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

// Returns string[] of NEW facts (already sanitised + capped, but NOT yet
// deduped against existing on disk — appendChatMemory does the final dedup).
export async function extractMemories({ userMessage, reply, existingFacts, runClaude, userId }) {
  if (typeof runClaude !== 'function') return [];
  if (!reply || typeof reply !== 'string' || !reply.trim()) return [];
  try {
    const raw = await runClaude(buildPrompt({ userMessage, reply, existingFacts }), {
      userId,
      model: EXTRACT_MODEL,
      maxTokens: 512,
    });
    return sanitizeFacts(tryParseJSON(raw));
  } catch {
    return [];
  }
}
