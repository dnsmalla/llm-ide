---
title: "0011. Use a fenced TOOL_CALL convention over the Claude CLI, not native tool_use"
status: accepted
date: 2026-05-19
---

# 0011. Use a fenced TOOL_CALL convention over the Claude CLI

## Context

The Code Assistant needs to call tools (`search-kb`, `create-gitlab-issue`). The server already shells out to `claude -p` for free-form chat ([ADR 0001](0001-claude-cli-not-api-key.md)). For tool use, two paths exist:

1. **Anthropic API tool_use.** Native, structured, schema-validated. Requires the user to have an Anthropic API key in the vault.
2. **Custom fence convention over `claude -p`.** The agent emits `<<<TOOL_CALL>>>{json}<<<END_TOOL_CALL>>>`; the server parses and dispatches. No API key required.

Not all users keep an API key in the vault — the always-available baseline is the CLI.

## Decision

The Code Assistant uses the fence convention over `claude -p`. The server parses one fence per agent turn, validates the JSON against the skill's schema, and either executes (read tools) or returns `pendingTool` for client confirm (write tools). Malformed output is recovered by feeding the error back as `<<<TOOL_RESULT>>>{"error":"..."}` and looping.

## Consequences

- **Positive:** works for every user who has the Claude CLI authenticated, no API-key bar.
- **Positive:** the skill files are markdown — the same prompt the agent reads is what the engineer reads.
- **Positive:** the parser is small (~60 lines) and self-contained.
- **Negative:** less robust than native tool_use. The agent occasionally produces malformed fences; we mitigate by feeding the error back and retrying, capped at 5 iterations per turn.
- **Negative:** schema validation lives in our code, not in the protocol. A new arg type means editing the validator.
- **Locked in:** see [explanation/agent-tools.md](../explanation/agent-tools.md). Migrating to native tool_use is possible later but would require the API-key path; out of scope for v1.
