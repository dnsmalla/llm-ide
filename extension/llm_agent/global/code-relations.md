---
name: code-relations
kind: read
description: Exact structural answers from the code graph for ONE symbol — who calls it (callers), what it calls (callees), or what is affected if it changes (impact — callers, references, subclasses and importers of its file), by hop. Use after find-code has told you the symbol's exact name.
schema:
  symbol:
    type: string
    required: true
    maxLength: 256
    description: The exact symbol name (function, method or class), e.g. "handleFindCode". Not a search phrase — use find-code for that.
  relation:
    type: string
    required: true
    description: One of "callers", "callees", "impact".
  depth:
    type: number
    required: false
    description: Hops to follow (1-3, default 1). 2 shows callers' callers; use it for a refactor's blast radius.
  path:
    type: string
    required: false
    description: Repo-relative file of the symbol, to pick one when several symbols share the name (the result is marked ambiguous when that happens).
---

# code-relations

Answers the structural questions about one symbol from the project's **code
graph**, exactly and by distance:

- `callers` — who calls it (hop 1 = direct callers, hop 2 = their callers…)
- `callees` — what it calls
- `impact` — everything that depends on it: callers, references, implementers
  and subclasses, plus every file importing the file it lives in. Also lists
  `affectedFiles` — the files a change to it has to be checked against.

## When to use

After `find-code` has located the symbol, when the question is about its
relationships: "what breaks if I change X", "who uses X", "is X dead code",
"what does X depend on". It replaces a grep for the name, which misses callers
that alias it and drowns in unrelated matches.

Call edges are INFERRED from names (marked `confidence`), so a result can be
missing an edge. An empty `callers`/`impact` is evidence, not proof — confirm
with a grep before deleting anything.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "code-relations", "arguments": {"symbol": "handleFindCode", "relation": "impact", "depth": 2}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{
  "symbol": [{ "name": "handleFindCode", "kind": "function", "path": "extension/llm_agent/runtime/handlers/find-code.mjs", "line": 182 }],
  "relation": "impact",
  "depth": 2,
  "results": [
    { "name": "registry.mjs", "kind": "file", "path": "extension/llm_agent/tools/registry.mjs", "line": 0, "relation": "imported by", "hop": 1 }
  ],
  "affectedFiles": ["extension/llm_agent/tools/registry.mjs"],
  "hint": "…"
}
```
