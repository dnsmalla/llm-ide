---
title: "0001. Use the Claude CLI shell-out instead of accepting an API key"
status: superseded
date: 2026-05-18
superseded-by: "0015"
---

# 0001. Use the Claude CLI shell-out instead of accepting an API key

> **Superseded (2026-06-25) by [ADR-0015](0015-multi-provider-vaulted-api-keys.md).**
> The "neither accepts nor stores an API key / no HTTP API client / do not
> replace `claude -p` with direct API calls" decision below no longer holds:
> the server now accepts **optional** per-user API keys via the encrypted
> vault and routes to provider HTTP clients, with the Claude CLI retained as
> the no-key fallback. The local-first, CLI-as-default intent still stands.
> See ADR-0015 and [`invariants.md`](../explanation/invariants.md#local-server-extensionservermjs)
> for the current rules. The original decision is preserved below as the record.

## Context

The server needs an LLM to generate notes, plans, code, and meeting-agent questions. Two options were considered:

1. Accept an Anthropic API key from the user, stored in the credential vault, and call the HTTP API directly.
2. Shell out to the Claude CLI (`claude -p`) which uses the user's existing CLI login.

The product target is local-first, low-friction installs. Most early users are engineers who already have the Claude CLI authenticated.

## Decision

Shell out to `claude -p`. The server neither accepts nor stores an Anthropic API key. The `runClaude()` helper uses `execFile('claude', ['-p', prompt])`. No HTTP API client is shipped.

## Consequences

- **Positive:** one login for the user; no key in the vault; no key in environment variables; nothing to exfiltrate.
- **Positive:** model selection follows whatever the user has configured in their CLI.
- **Negative:** concurrency is limited to what the CLI tolerates locally; no native batching.
- **Negative:** prompt size is capped (~500 k chars) by what the CLI accepts comfortably.
- **Negative:** the CLI must be installed and authenticated; first-run UX has to handle that gap.
- **Locked in:** see [invariants — local server](../explanation/invariants.md#local-server-extensionservermjs). Do NOT replace `claude -p` with direct API calls.
