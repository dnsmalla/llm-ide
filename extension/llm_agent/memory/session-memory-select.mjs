// Which of a chat's session facts to put in front of the model.
//
// The plain cap (kb/session-memory.mjs capSessionMemory) keeps the NEWEST
// facts that fit. Recency matters — the latest decision and the phase the
// work is in are almost always newest — but on a long chat it silently drops
// an older fact that is exactly what this message is about ("go back to the
// schema we agreed on"). So: the newest few always, then the rest of the
// budget by relevance to the message (graphkit/memory.mjs's IDF scorer, the
// one project memory already uses), returned in their original order so the
// block still reads as the conversation learned it.

import { scoreFactsByRelevance } from '../../graphkit/memory.mjs';
import { capSessionMemory } from '../../kb/session-memory.mjs';

const ALWAYS_NEWEST = 10;
const MAX_FACTS = 40;
const MAX_CHARS = 8_000;

const cost = (fact) => fact.length + 3; // "- " + newline, as rendered

export function selectSessionMemory(facts, userMessage = '', { maxFacts = MAX_FACTS, maxChars = MAX_CHARS } = {}) {
  const all = (Array.isArray(facts) ? facts : []).filter((f) => typeof f === 'string' && f.length > 0);
  if (all.length === 0) return [];
  const capped = capSessionMemory(all, { maxFacts, maxChars });
  // Everything fits — nothing to choose.
  if (capped.length === all.length) return all;

  const keep = new Set();
  let chars = 0;
  const take = (i) => {
    if (keep.has(i) || keep.size >= maxFacts) return false;
    if (chars + cost(all[i]) > maxChars && keep.size > 0) return false;
    keep.add(i);
    chars += cost(all[i]);
    return true;
  };
  for (let i = all.length - 1; i >= 0 && keep.size < Math.min(ALWAYS_NEWEST, maxFacts); i -= 1) {
    if (!take(i)) break;
  }
  for (const { index, score } of scoreFactsByRelevance(all, { userMessage })) {
    if (score <= 0) break;
    take(index);
  }
  // Leftover budget: newest-first, as the plain cap would have spent it.
  for (let i = all.length - 1; i >= 0; i -= 1) take(i);
  return [...keep].sort((a, b) => a - b).map((i) => all[i]);
}
