// Lightweight secret-detection helpers factored out of rules.mjs so they
// can be imported without pulling in the full guardrail engine (which has
// no side effects but is larger and generates a full findings report).
//
// Intended callers: ai-routes.mjs (pre-ingest guard), any future ingestion
// pipeline step that needs a quick "does this look like it contains a
// secret?" answer without wanting the structured findings array.
//
// Secret patterns are imported from rules.mjs (single source of truth)
// to prevent the two lists drifting out of sync.
import { SECRET_PATTERNS as _namedPatterns } from './rules.mjs';

// scan.mjs callers only need the regex objects, not the { name, re } shape.
const SECRET_PATTERNS = _namedPatterns.map((p) => p.re);

/**
 * Returns `true` if `text` contains anything shaped like a secret token.
 * Used as a guard before persisting LLM-generated content to the KB.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function scanForSecrets(text) {
  if (typeof text !== 'string' || !text) return false;
  // Match against both raw text and whitespace-collapsed variant to
  // catch line-wrapped tokens (same technique as rules.mjs findMatches).
  const collapsed = text.replace(/\s+/g, '');
  for (const re of SECRET_PATTERNS) {
    if (re.test(text) || re.test(collapsed)) return true;
  }
  return false;
}
