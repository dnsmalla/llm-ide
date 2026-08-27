# GraphKit Canonical Graph Schema

> **Status:** v1 (stable). This document is the **language-neutral contract** every
> GraphKit implementation (Swift, TypeScript, …) conforms to. The on-disk / on-the-wire
> form is JSON validated by [`graph.schema.json`](./graph.schema.json).

GraphKit turns **code** and **text** into a single typed node/edge graph. The graph is
the same shape regardless of which language produced it, so a Swift app and a TypeScript
tool can read and write each other's graphs.

## Document envelope

A serialized graph is a **GraphDocument**:

```jsonc
{
  "schemaVersion": 1,            // integer; bump on a breaking schema change
  "nodes":  [ /* CGNode */ ],
  "edges":  [ /* CGEdge */ ],
  "layers": [ /* CGLayer */ ],   // optional grouping (Understand-Anything layers)
  "tour":   [ /* CGTourStep */ ] // optional guided-tour steps
}
```

`layers` and `tour` default to `[]`.

## CGNode

```jsonc
{
  "id":       "string",          // stable, unique within the document
  "title":    "string",          // human label
  "kind":     "file",            // one of the CGNodeKind values (below)
  "position": { "x": 0, "y": 0 },// optional layout hint; producers may emit {0,0}
  "metadata": { "k": "v" }       // string→string; producer-defined extra fields
}
```

`position` is a **layout hint only** — it carries no semantic meaning and consumers are
free to recompute layout. It is kept in the schema for app compatibility.

## CGEdge

```jsonc
{
  "fromId":     "string",        // source node id
  "toId":       "string",        // target node id
  "kind":       "contains",      // one of the CGEdgeKind values (below)
  "confidence": "EXTRACTED"      // EXTRACTED | INFERRED | AMBIGUOUS
}
```

### CGEdgeConfidence

| Value | Meaning |
|---|---|
| `EXTRACTED` | Explicitly stated in source — 100% reliable. |
| `INFERRED` | Reasonably deduced (e.g. call sites) — ~80% reliable. |
| `AMBIGUOUS` | Uncertain (dynamic dispatch, reflection) — 50–70% reliable. |

## CGLayer / CGTourStep

```jsonc
// CGLayer
{ "id": "string", "name": "string", "nodeIds": ["string"] }

// CGTourStep
{ "nodeId": "string", "title": "string", "body": "string" }
```

## CGNodeKind (closed enum)

Code: `file`, `symbol`, `module`, `function`, `classType`, `config`, `service`, `table`,
`endpoint`, `pipeline`, `schemaNode`, `resource`, `domain`, `flow`, `step`.
Docs/memory: `docPage`, `memoryDoc`, `memoryChunk`.
Atomic notes: `noteDecision`, `noteTask`, `noteQuestion`, `noteFact`, `noteConcept`,
`notePlaybook`, `noteHypothesis`, `noteEvent`, `noteSource`.
Knowledge: `article`, `entity`, `topic`, `claim`.
Capabilities: `skill`, `agent` (a SKILL.md skill or an agent definition, linked to the
code/docs it relates to so agents can consult the memory index cheaply).
Fallback: `other`.

## CGEdgeKind (closed enum)

Structure: `imports`, `exports`, `contains`, `defines`, `inherits`, `implements`, `calls`,
`references`.
Messaging/middleware: `subscribes`, `publishes`, `middleware`, `routes`.
Data: `readsFrom`, `writesTo`, `transforms`, `validates`, `migrates`, `definesSchema`.
Lifecycle: `dependsOn`, `testedBy`, `configures`, `deploys`, `serves`, `provisions`,
`triggers`, `documents`.
Flow: `containsFlow`, `flowStep`, `crossDomain`.
Knowledge: `relatedTo`, `similarTo`, `cites`, `contradicts`, `buildsOn`, `exemplifies`,
`categorizedUnder`, `authoredBy`.

> **Note (`defines` vs `contains`):** code scanners emit `contains` for file→symbol
> ownership. Consumers that list "symbols defined in a file" should accept **both**
> `defines` and `contains` for a file/module source node.

## Conformance

`schema/fixtures/*.json` are canonical graphs that **every** implementation must accept
(`validate` → no errors) and round-trip (`decode` then `encode` → semantically equal).
Each language binding ships a test that loads these fixtures.

## Versioning

- `schemaVersion` is an integer, currently `1`.
- Additive changes (new optional field, new enum case) do **not** bump it but should be
  noted in `CHANGELOG`.
- Removing/renaming a field or changing a type **bumps** `schemaVersion`; consumers must
  branch on it.
