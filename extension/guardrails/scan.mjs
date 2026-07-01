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
  // Match against three representations to defeat evasion (mirrors rules.mjs
  // findMatches):
  //   wsCollapsed — whitespace stripped: catches line-wrapped secrets
  //   zwCollapsed — zero-width chars stripped only (U+200B ZWSP, U+200C ZWNJ,
  //                 U+200D ZWJ, U+2060 word-joiner, U+FEFF BOM/ZWNBSP).
  //                 \s does NOT match these in JS, so stripping them separately
  //                 preserves surrounding spaces and keeps \b word-boundaries
  //                 intact for the secret patterns.
  const wsCollapsed = text.replace(/\s+/g, '');
  const zwCollapsed = text.replace(/[​‌‍⁠﻿]+/g, '');
  for (const re of SECRET_PATTERNS) {
    if (re.test(text) || re.test(wsCollapsed) || re.test(zwCollapsed)) return true;
  }
  return false;
}
