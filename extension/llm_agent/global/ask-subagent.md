---
name: ask-subagent
kind: read
schema:
  name:
    type: string
    required: true
    maxLength: 50
    description: subagent slug (lowercase a-z, 0-9, dash)
  question:
    type: string
    required: true
    maxLength: 2000
    description: the question or task to delegate to the subagent
  thread:
    type: string
    required: false
    maxLength: 100
    description: optional thread identifier for multi-turn subagent context
---

# ask-subagent

Delegate to a plugin-defined named subagent. Each subagent has its
own narrow role (defined by the plugin author in `agents/<name>.md`),
its own restricted tool set, and is isolated from the global chat
history.

## When to use

The user asks for something a known subagent specialises in — for
example, the `summarizer` subagent for short summaries, a `triage`
subagent for bug-report classification, etc. The list of available
subagents for this user is shipped with each session: do not invent
names. If no subagent matches the task, fall back to `ask-internal`
or answer directly.

## When NOT to use

- General engineering questions → answer directly.
- Anything about this app's own state (meetings, plans, project
  config) → use `ask-internal` instead.
- A subagent name the user hasn't enabled → don't call; the handler
  will return an error.

## Call shape

<<<TOOL_CALL>>>
{"name": "ask-subagent", "arguments": {"name": "summarizer", "question": "...", "thread": "optional-thread-id"}}
<<<END_TOOL_CALL>>>

`thread` is optional. Omit it for a one-shot isolated call (the default).

## Result shape

{"answer": "<subagent's reply>", "pendingTool": null | {...}}

Errors come back as `{"error": "no subagent named '<name>' is enabled"}`
— relay them to the user verbatim so they know which subagent
identifiers actually exist.

## Subagent semantics

### Subagent context threads (experimental)

Pass a `thread` string to group multiple calls into a shared context
thread. Calls with the same `thread` value are presented to the
subagent as a continuing conversation — it sees prior turns in that
thread and can build on them without you restating context each time.
Omit `thread` (or leave it empty) for a one-shot isolated call; the
subagent has no memory of prior turns and all needed context must be
included in `question`.

- A delegation answers once and does not run tools. A subagent that
  declares `allowed_tools` (it was written to search the KB or call
  `decide`) therefore comes back as `{ ok: false, error:
  "tools_unavailable", partial: <its answer>, message }`: the answer is
  NOT grounded in those tools. Treat `partial` as a draft, or do the
  lookups yourself. A pure-prompt subagent (no tools) returns
  `{ ok: true, answer }`.
