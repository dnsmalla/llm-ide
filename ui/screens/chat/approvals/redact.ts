// Secret redaction for text the approval UI shows. Port of extension/core/redact-secrets.mjs SECRET_PATTERNS
// (the Mac's SecretRedactor mirrors the same set); tests/approvals-redact.test.mjs runs the .mjs original over
// shared fixtures so the two cannot drift. This module only ever ADDS patterns (below), never drops one.

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[oprsu]_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  /\bgl(?:pat|oas|rt|cbt|ptt|ft|imt|agent|soat|dt|ffct)-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /apiKey=[A-Za-z0-9_-]+/gi,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
];

/** UI-only additions: private key blocks and `NAME=value` assignments of obviously secret names in a command line. */
const UI_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi,
];

export const REDACTION_MARKER = "[REDACTED]";

/** Replaces every recognised secret shape with `[REDACTED]`. */
export function redactSecrets(input: string): string {
  let s = input;
  for (const re of SECRET_PATTERNS) s = s.replace(re, REDACTION_MARKER);
  for (const re of UI_PATTERNS) s = s.replace(re, (_m, name?: string) => (typeof name === "string" ? `${name}=${REDACTION_MARKER}` : REDACTION_MARKER));
  return s;
}

/** True when the text still carries a secret shape (used to block secrets typed into a question answer). */
export function looksSecret(input: string): boolean {
  return redactSecrets(input) !== input;
}

const SECRET_KEY = /pass(?:word|wd)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie/i;

/** Deep copy for display: values under a secret-looking key are replaced; strings are redacted; depth and breadth are bounded. */
export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (v === null || typeof v !== "object") return v;
  if (depth >= 6) return "[nested value omitted]";
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (++n > 100) break;
    out[k] = SECRET_KEY.test(k) && typeof val === "string" ? REDACTION_MARKER : redactValue(val, depth + 1);
  }
  return out;
}
