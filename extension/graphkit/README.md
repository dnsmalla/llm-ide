# GraphKit

The graph + memory module. Five files, all in production use:

| File | Role |
|------|------|
| `paths.mjs` | The one definition of where a repo's generated knowledge lives on disk. **Read this first.** |
| `graph.mjs` | Code-graph queries — `findRelatedCode` (FTS-backed) and `findRelatedSymbols` (symbol graph) |
| `memory.mjs` | Renders a repo's memory into the agent's system prompt (READ half) |
| `memory-writer.mjs` | Persists LLM-curated facts to `chat-memory.md` (WRITE half) |
| `index.mjs` | Public surface — agents and context renderers import from here |

## On-disk layout (canonical)

Everything the app generates for a repo lives under a single container,
`<repo>/system/`, one file per artifact, rewritten in place:

```
system/graph/index.md          repo overview (impact-ranked)
system/graph/graph.json        adjacency list
system/memory/graph-notes.md   cross-links + dependency hubs
system/memory/doc-notes.md     doc sections + module affinity
system/memory/chat-memory.md   LLM-curated durable facts
system/repo.md                 hand-authored project facts
system/faults/  system/q&a/    archived fault reports + saved Q&A
```

The graph half is written by the Mac app (`KnowledgeGraphService`,
`CodeNoteGenerator`); `chat-memory.md` is written here. Both read through
`paths.mjs` — do not re-derive these paths anywhere else.

`graphify-out/` is **not** ours: it belongs to the separate `/graphify` skill.
Memory used to be written into it, so `paths.mjs` still reads that location as a
fallback and the Mac app moves leftovers out of it once.

## Running tests

```bash
cd extension && npm test
```

Memory and graph coverage lives in `extension/tests/` — `project-memory`,
`memory-relevance`, `graphify-memory-*`, `graphkit-rollup`,
`structure-graph-ingest`, `code-sync-expand`.

## History

A Phase 1/2 TypeScript scaffold (`storage/`, `services/`, `types/`, and a
`storage/migrate.ts`) once sat alongside these files, implementing a parallel
memory + graph stack under a `.llm-ide/` root. It was never wired to the server
and was removed in favour of the layout above. Its design docs remain:

- `docs/superpowers/specs/2026-07-07-unified-memory-graph-system-design.md`
- `docs/superpowers/plans/2026-07-07-phase1-storage-layer-types.md`
- `docs/superpowers/plans/2026-07-08-phase2-service-layer.md`

That spec's headline goal — one canonical directory, replacing the three
competing conventions — is what the `system/` layout above delivers. Its other
goals (auto-capture, contradiction detection, stale-fact cleanup) are covered by
`memory-extract.mjs` + `memory-writer.mjs`, which ship and are tested.

One idea from the scaffold has **not** been reimplemented, and is worth
revisiting: `MemoryService.validateFact` verified that file paths cited by a
remembered fact still exist, flagging `file_not_found` when a fact had gone
stale. Nothing here does that today. It needs facts to carry their file
references, which `memory-extract.mjs` does not currently emit.
