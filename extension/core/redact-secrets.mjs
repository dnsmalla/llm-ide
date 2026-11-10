// Single source of truth for secret/token redaction in surfaced text.
//
// Provider APIs and CLIs sometimes echo a credential back into an error body
// (e.g. "Bad credentials for ghp_…", "invalid x-api-key: sk-ant-…"). Before any
// such text reaches a client error envelope, a log shipper, the audit log, or a
// screenshot, run it through `redactSecrets` so the credential can't leak.
//
// This module exists because the same pattern set was previously copy-pasted —
// with subtly different regexes — across outcome-watcher.mjs, runtime.mjs, and
// the audit log. A divergent-copy security control is one that eventually
// leaks; keep the patterns here and import them everywhere.

import { SECRET_SHAPES, globalSecretPattern } from './secret-patterns.mjs';

// The shared shape list (core/secret-patterns.mjs), as global regexes: redaction replaces every occurrence.
export { SECRET_SHAPES };
export const SECRET_PATTERNS = SECRET_SHAPES.map(({ re }) => globalSecretPattern(re));

const MARKER = '[REDACTED]';

// Invisible characters an attacker can embed inside a token to defeat a
// pattern match. Unicode category Cf (format) is the whole family - ZWSP,
// ZWNJ, ZWJ, word-joiner, BOM, and also SOFT HYPHEN U+00AD and the bidi
// controls, which a hand-written list of five missed. A property escape also
// sidesteps no-misleading-character-class (no invisible literals, no ZWJ in
// a class). guardrails/rules.mjs re-exports ZERO_WIDTH_RE so the two evasion
// passes cannot drift.
export const ZERO_WIDTH_RE = /\p{Cf}+/gu;
// Single-character probes for the index-mapped passes below. The whitespace
// view also drops non-spacing marks (Mn: combining accents, variation
// selectors), so an accented letter inside a fixed-length token is still that
// token, and the blank-rendering letters no property covers: Hangul fillers
// U+115F, U+1160, U+3164, U+FFA0 (category Lo), the braille blank U+2800, NUL.
const BLANK_LETTERS = '\u0000\u115F\u1160\u2800\u3164\uFFA0';
const ZERO_WIDTH_CHAR_RE = /^\p{Cf}$/u;
const SEPARATOR_CHAR_RE = new RegExp('^(?:\\s|\\p{Cf}|\\p{Mn}|[' + BLANK_LETTERS + '])$', 'u');
const SEPARATOR_RUN_RE = new RegExp('(?:\\s|\\p{Cf}|\\p{Mn}|[' + BLANK_LETTERS + '])+', 'gu');

// The stored-text pattern set. `apiKey=<anything>` is right for an error body
// (a query string echoed back) but wrong for prose that will be persisted:
// "set apiKey=true in config" is documentation, not a credential. For storage
// the value has to look like one.
const STORAGE_PATTERNS = SECRET_PATTERNS.map((re) => (
  re.source === 'apiKey=[A-Za-z0-9_-]+' ? /apiKey=[A-Za-z0-9_-]{16,}/gi : re
));

// Non-global twins for `.test()`: a global regex carries lastIndex between
// calls, so `re.test()` on one would silently alternate true/false.
const PROBE_PATTERNS = STORAGE_PATTERNS.map((re) => new RegExp(re.source, re.flags.replace('g', '')));

/**
 * Replace every recognized secret shape in `input` with `[REDACTED]`.
 * Non-string input is coerced to a string first (so this is safe on Error
 * objects, numbers, etc.). Length is NOT capped here — callers that need a
 * bound (audit field limits, error-message slices) apply their own.
 */
export function redactSecrets(input) {
  let s = typeof input === 'string' ? input : String(input);
  for (const re of SECRET_PATTERNS) s = s.replace(re, MARKER);
  return s;
}

/**
 * True if `input` still contains a secret shape in any of three views: as
 * written, with zero-width characters removed, or with all whitespace and
 * zero-width characters removed (a token wrapped across lines or laced with
 * invisible separators). Pure and stateless.
 */
export function hasSecretShape(input) {
  const s = typeof input === 'string' ? input : String(input ?? '');
  if (!s) return false;
  const views = [s, s.replace(ZERO_WIDTH_RE, ''), s.replace(SEPARATOR_RUN_RE, '')];
  return PROBE_PATTERNS.some((re) => views.some((v) => re.test(v)));
}

// Removing WHITESPACE glues the next word onto a token ("ghp_…aaaaAlice"),
// which kills the trailing `\b` and, for an open-ended body ({10,}), lets a
// greedy match swallow the words that follow. So the whitespace view is
// limited to shapes whose body length is FIXED — the match cannot run past
// the token — with the `\b` anchors dropped so the glued neighbour does not
// hide it. Open-ended shapes wrapped across a line are caught by the plain
// view as far as their minimum length reaches (see redactSecretsForStorage).
// (No pattern puts `\b` inside a character class — there it would mean
// backspace and this strip would corrupt it; keep it that way.)
const WRAP_SAFE_PATTERNS = STORAGE_PATTERNS
  .filter((re) => /\{\d+\}/.test(re.source) && !/\{\d+,\}/.test(re.source))
  .map((re) => new RegExp(re.source.replace(/\\b/g, ''), re.flags));

// Match `patterns` against `s` with every `sepRe` character removed, and
// return the spans in ORIGINAL coordinates (separators included) — so a
// legitimate zero-width joiner elsewhere (a family emoji, Indic/Persian ZWNJ)
// is never touched. `sepRe` null = match the text as written.
function collectSpans(s, sepRe, patterns) {
  const map = [];
  let compact = '';
  for (let i = 0; i < s.length; i += 1) {
    if (sepRe && sepRe.test(s[i])) continue;
    map.push(i);
    compact += s[i];
  }
  const spans = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(compact)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      spans.push([map[m.index], map[m.index + m[0].length - 1] + 1]);
    }
  }
  return spans;
}

function applySpans(s, spans) {
  if (spans.length === 0) return s;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let out = s;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [start, end] = merged[i];
    out = out.slice(0, start) + MARKER + out.slice(end);
  }
  return out;
}

/**
 * Redaction for text that will be PERSISTED and later re-surfaced (FTS
 * search, prompt grounding, the KB UI). Spans are collected on the ORIGINAL
 * text from three views and replaced in one pass, so a token that is only
 * partly visible in one view is still removed whole:
 *   - as written                       (every shape, exact `\b` anchors)
 *   - zero-width characters removed    (every shape; whitespace is kept, so
 *                                       word boundaries still hold)
 *   - whitespace removed               (fixed-length shapes only, see
 *                                       WRAP_SAFE_PATTERNS)
 * Known limit: an OPEN-ENDED shape wrapped across a line (sk-ant-…, xox…) is
 * redacted only as far as its minimum length reaches; the tail past the wrap
 * survives. Nothing outside a matched span is ever altered.
 */
export function redactSecretsForStorage(input) {
  const s = typeof input === 'string' ? input : String(input ?? '');
  if (!s) return s;
  return applySpans(s, [
    ...collectSpans(s, null, STORAGE_PATTERNS),
    ...collectSpans(s, ZERO_WIDTH_CHAR_RE, STORAGE_PATTERNS),
    ...collectSpans(s, SEPARATOR_CHAR_RE, WRAP_SAFE_PATTERNS),
  ]);
}

/**
 * Redact a known in-flight credential plus every recognized secret shape.
 * First masks the exact `key` (catches any shape — even a custom-provider key
 * the shared patterns don't recognize), then runs the shared pattern set so
 * other tokens the provider echoes back are scrubbed too. Use this at every
 * site that surfaces a provider/API error body, so the key-aware redaction
 * isn't re-implemented (and allowed to drift) per call site.
 */
export function redactWithKey(input, key) {
  let s = typeof input === 'string' ? input : String(input ?? '');
  if (key && key.length >= 8) s = s.split(key).join(MARKER);
  return redactSecrets(s);
}
