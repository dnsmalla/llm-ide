---
title: "0015. Multi-provider routing with optional vaulted API keys; CLI as fallback"
status: accepted
date: 2026-06-25
supersedes: "0001 (the no-API-key clause)"
---

# 0015. Multi-provider routing with optional vaulted API keys; CLI as fallback

## Context

[ADR-0001](0001-claude-cli-not-api-key.md) decided the server would shell out
to `claude -p` and "neither accepts nor stores an Anthropic API key." That held
while every user had the Claude CLI logged in. Two forcing functions broke it:

1. **Multi-user billing.** When several users share one install, the operator's
   single CLI login bills every user's generation to one account. Each user
   needs to bring their own credential so spend is attributed correctly.
2. **Provider choice.** Users asked to run the same agent prompts against
   OpenAI / Google / OpenAI-compatible endpoints, which have no CLI shell-out
   equivalent and require a direct HTTP client.

The code already evolved to meet these needs (`agents/providers.mjs` multi-
provider router, `resolveClaudeCall` in `agents/runtime.mjs`, the
`*.apiKey` entries in `server/vault.mjs`), but ADR-0001 and
`explanation/architecture.md` still asserted the original "no key" rule — a
contradiction with the shipped behaviour and with `explanation/invariants.md`.
This ADR records the decision the code reflects.

## Decision

The server accepts **optional, per-user API keys**, stored only in the
encrypted vault (`server/vault.mjs`, AES-256-GCM): `claude.apiKey`,
`openai.apiKey`, `google.apiKey`, `custom.apiKey` / `custom.baseUrl`.

- `runClaude()` **prefers** the user's vaulted `claude.apiKey` (injected as
  `ANTHROPIC_API_KEY` per call) and routes non-Claude models to their provider
  over a direct HTTP client (`completeViaApi`).
- When a user has **no** stored key, generation falls back to the operator's
  logged-in `claude`/`codex`/`gemini` CLI ("subscription mode"), exactly as
  ADR-0001 described. The CLI path remains a first-class, always-supported
  baseline — it is not removed.
- A key is **never** accepted as a request parameter, stored in plaintext,
  logged, or echoed in errors; a user-scoped key never silently falls back to
  the operator CLI on failure (that would misattribute spend).

This supersedes only the "neither accepts nor stores an API key / no HTTP API
client is shipped / do not replace `claude -p` with direct API calls" clause of
ADR-0001. The local-first, low-friction, CLI-as-default intent of ADR-0001 is
retained.

## Consequences

- **Positive:** correct per-user billing in multi-user installs; provider
  choice beyond Anthropic; the docs now match the code and `invariants.md`.
- **Positive:** zero-config single-user installs are unchanged — no key needed,
  CLI login still "just works."
- **Negative:** larger trust surface — the server now holds decryptable
  provider credentials, so the vault key-custody and SSRF guards
  (`assertSafeBaseUrl` for `custom.baseUrl`) are load-bearing.
- **Negative:** two code paths to keep working (HTTP and CLI); `resolveClaudeCall`
  is the single place that defines the lookup + fallback order.
- **Neutral:** the ~500 k-char prompt cap and local concurrency limits from
  ADR-0001 still apply to the CLI path; the HTTP path has its own provider
  limits.
