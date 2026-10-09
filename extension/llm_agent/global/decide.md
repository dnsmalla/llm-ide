---
name: decide
kind: read
description: Make a calibrated yes/no, pick-one or score decision about material you already have (a diff, files, test output) and get back probabilities and confidence instead of a guess.
schema:
  state:
    type: string
    required: true
    maxLength: 200000
    description: the material to judge, verbatim (diff, file excerpts, test output, ticket text) — the decision sees ONLY this
  questions:
    type: object
    required: true
    maxLength: 65536
    description: '{ "<id>": { "type": "noul"|"choice"|"score", "instructions": "...", "criteria"?: ... } } — 1 to 64 questions'
---

# decide

Get a calibrated decision about given material: a yes/no probability, one
option picked from a fixed list, or a level on an ordered scale — each with
probabilities and a confidence you can act on.

## When to use

You need a JUDGEMENT about material you already hold, and how sure the answer
is matters to what you do next. For example:

- "Is this diff safe to apply without review?" → `noul`
- "Which of these files is most relevant to the bug?" → `choice`
- "How severe is this test failure?" → `score`
- "Does this reply answer the user's question?" → `noul`

Several related questions about the same material go in ONE call (up to 64).

## When NOT to use

- To look something up → `search-kb`, `find-code`, `web-search`.
- To write, explain or summarize → answer directly.
- When there is nothing to judge yet — gather the material first.

## Questions

Each question id (letters, digits, `_ . -`) maps to:

- `noul` — yes/no. Optional `criteria`: `{"true": "what yes means", "false": "what no means"}`.
- `choice` — `criteria` is an object of 2–255 options, `option → description or null`.
- `score` — `criteria` is an ordered array of 2–10 level descriptions, lowest first.

`instructions` (required) says what to decide.

## Call shape

<<<TOOL_CALL>>>
{"name": "decide", "arguments": {"state": "<the diff>", "questions": {"safe": {"type": "noul", "instructions": "Is this diff safe to apply without human review?"}, "risk": {"type": "score", "instructions": "Rate the blast radius.", "criteria": ["none", "one module", "cross-module", "data loss possible"]}}}}
<<<END_TOOL_CALL>>>

## Result shape

{"engine": "jev"|"llm", "model": "...", "answers": {
  "safe": {"type": "noul", "noul": 0.93},
  "pick": {"type": "choice", "choice": "a.swift", "probabilities": {"a.swift": 0.8, "b.swift": 0.2}, "confidence": 0.8},
  "risk": {"type": "score", "score": 1, "legend": ["none", "one module", "cross-module", "data loss possible"], "probabilities": {"0": 0.1, "1": 0.7, "2": 0.15, "3": 0.05}, "confidence": 0.7}
}, "fallback"?: "<reason>"}

- `noul` is the probability the answer is YES (0..1); 0.5 means undecided.
- For `score`, `score` is the 0-based level index, `legend` is the full level
  list (so `legend[score]` is the chosen level's text) and `probabilities` are
  keyed by level index.
- The shape is the same whichever engine answered.
- `engine` says what answered: Jev (when the user's Decisions role points at
  a Jev tier) or the configured LLM; `fallback` appears whenever the Decisions
  role is on Jev but the LLM answered instead — `jev_rate_limited`,
  `jev_server_error`, `jev_timeout`, `jev_network`, `jev_bad_response`,
  `jev_too_large`, `jev_unavailable` (this call failed on Jev), `jev_route_failed`
  (Jev is cooling down after a recent failure), `jev_no_key` (no Jev key
  stored), `jev_unusable` (the Jev tier cannot run for another reason).
  Mention it to the user when the decision matters.
- An answer of `{"type": ..., "error": "..."}` means that one question got no
  valid answer — do not treat it as a no. When NO question got one, the call
  returns `{"error": ...}` instead (either engine).

Treat a low probability or confidence as "unsure", not as the opposite answer;
say so to the user rather than acting on it.

## Subagents

A plugin subagent can call `decide` when its frontmatter grants it:
`allowed_tools: [decide]` (alongside any others, e.g. `[search-kb, decide]`).
