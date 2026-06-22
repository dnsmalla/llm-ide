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

// Common credential shapes. Anchored with \b where the prefix is fixed-length
// so we don't over-match; left open ({10,}/{20,}) where the body length varies.
export const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9]{36}\b/g,                 // GitHub personal access token (classic)
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,         // GitHub fine-grained PAT
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,          // Slack token
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,              // Google API key
  /\bAKIA[0-9A-Z]{16}\b/g,                    // AWS access key id
  /\bsk-ant-[A-Za-z0-9-]{10,}\b/g,            // Anthropic API key
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,           // Authorization: Bearer <jwt/opaque>
  /apiKey=[A-Za-z0-9_-]+/gi,                  // apiKey=<value> in query strings
];

const MARKER = '[REDACTED]';

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
