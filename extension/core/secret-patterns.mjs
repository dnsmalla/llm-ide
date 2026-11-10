// ONE credential-shape list for every secret control in the core (R-036 A6).
//
// It is imported by three consumers that used to keep divergent copies:
//   - core/redact-secrets.mjs      (redaction of surfaced/stored text)
//   - guardrails/rules.mjs         (pre-execution artifact guardrails)
//   - agents/github-pr.mjs         (the Factory Ship pre-push scan)
// Core is L0, so every layer may import this module. A shape added here is
// enforced by all three; a shape must never be removed or narrowed, because
// the pre-push scan is the last gate before code leaves the machine.
//
// Entries carry a human-readable `name` (the block message names the rule, never
// the matched text) and a NON-global regex: `String.prototype.match` is used by
// the guardrails, and a global regex's `lastIndex` would make `.test()` alternate.

export const SECRET_SHAPES = Object.freeze([
  // GitHub: classic (ghp_ PAT, gho_ OAuth, ghu_ user-to-server, ghs_ server-to-server, ghr_ refresh) and the
  // fine-grained github_pat_ shape.
  { name: 'GitHub token', re: /\b(?:gh[oprsu]_[A-Za-z0-9]{36,128}|github_pat_[A-Za-z0-9_]{80,256})\b/ },
  // The fixed 36-char classic shape is what the storage redactor's wrap-safe pass can bound exactly.
  { name: 'GitHub token', re: /\bgh[oprsu]_[A-Za-z0-9]{36}\b/ },
  // GitLab: glpat- PAT, glrt- runner, glcbt- CI job, gldt- deploy, … (the project's own tracker is GitLab-hosted).
  { name: 'GitLab token', re: /\bgl(?:pat|oas|rt|cbt|ptt|ft|imt|agent|soat|dt|ffct)-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe live key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36,128}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // Anthropic / OpenAI before the generic sk- rule, so a specific key is reported under its own name.
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9-]{10,}\b/ },
  { name: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(?!ant-|proj-)[A-Za-z0-9]{20,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  // AWS: long-lived AKIA, temporary ASIA/ABIA/ACCA, and the secret/session values written next to a key name.
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', re: /\baws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { name: 'AWS session token', re: /\baws[_-]?session[_-]?token["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{100,}/i },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // A Slack incoming-webhook URL is a credential in its own right (anyone holding it may post as the app).
  { name: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}/ },
  // scheme://user:password@host — a connection string with inline credentials.
  { name: 'URL with credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i },
  // PEM private key block, whole; a block cut short (truncated log, tool output limit) is redacted to the end of the text.
  { name: 'Private key', re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/ },
  // ssh key material on one line (authorized_keys / id_*.pub shape, and what a private key's public half leaks).
  { name: 'SSH key material', gate: false, re: /\b(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d{3})\s+AAAA[A-Za-z0-9+/]{40,}={0,3}/ },
  // Separator limited to 1-3 chars: an unbounded '+' was catastrophic on inputs like 'api_key:::::::::::'.
  { name: 'Generic API key', gate: false, re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)["'\s:=]{1,3}[A-Za-z0-9_-]{16,}\b/i },
  // A long base64-looking blob right after a key-named field (needs a digit, so a long plain word is not caught).
  { name: 'Generic key field', re: /\b[A-Za-z0-9_-]{0,40}key["']?\s*[:=]\s*["']?(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/i },
  // password: … / token: … in a config or log line.
  { name: 'Generic credential', gate: false, re: /(?:secret|token|password|passwd)["'\s:=]+[A-Za-z0-9/+_-]{20,}/i },
  { name: 'Bearer token', gate: false, re: /Bearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: 'apiKey parameter', gate: false, re: /apiKey=[A-Za-z0-9_-]+/i },
  { name: 'Google OAuth access token', re: /\bya29\.[A-Za-z0-9._-]{20,}/ },
  { name: 'Google OAuth refresh token', re: /\b1\/\/[A-Za-z0-9_-]{20,}/ },
  // Host-signed approval token (v1 legacy, v2 chat-bound) (core/host-approval.mjs).
  { name: 'Host approval token', re: /\bv[12]\.\d{10,15}\.[0-9a-f]{32}\.[0-9a-f]{64}\b/ },
]);

/** A fresh global copy of a shape's regex (redaction replaces every occurrence). */
export function globalSecretPattern(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}
