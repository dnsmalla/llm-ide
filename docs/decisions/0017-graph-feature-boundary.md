---
title: "0017. Remove the graph feature by build exclusion, not by plugin extraction"
status: accepted
date: 2026-09-06
---

# ADR 0017: Remove the graph feature by build exclusion, not by plugin extraction

**Status:** Accepted
**Date:** 2026-09-06

## Context

Not every user needs the knowledge graph: an engineer does, a non-engineer does
not. That raised a proposal to move all graph code into the `graph-kit` package,
leave only a thin plugin linker in the Mac app, and drop the plugin for users who
do not need graphs.

Measurement showed the goal was already met by a different mechanism. Building
with every feature except `code_graph_3d` (debug, `swift build`, symbols counted
with `nm -U`):

| Build | Size | `GraphCore`/`GraphKit`/`MemoryGenerator`/`KnowledgeGraphService` symbols |
|---|---|---|
| Full | 85.8 MB | 5868 |
| All features except graph | 80.7 MB | **0** |
| Chat only (`build-mac-min`) | 51.5 MB | 0 |

`mac/Package.swift` excludes the whole `Graph/` source folder and drops both the
`GraphCore` and `GraphKit` product dependencies when the feature is off, so the
code is absent at compile time rather than dead-stripped. Plugin extraction
cannot improve on zero symbols.

A second, genuinely open goal was mixed into the same request: reusing the graph
pipeline from **other systems**. That one is unmet, and it is what `graph-kit`
work should serve.

## Decision

**Removing the graph feature for a user is a build-time concern, served by
`LLMIDE_FEATURES`.** Do not restructure the app to achieve it.

**Extracting production logic into `graph-kit` is a reuse concern**, justified
only by other systems consuming the engine as a plugin — not by binary size in
this app.

Three things named "memory" are kept distinct, because they have different
owners:

| Concept | What it is | Owner |
|---|---|---|
| **InfiniteBrain / doc memory** | Chunks `.md`/`.txt` into graph nodes | Engine (`MemoryGenerator`, Swift + TypeScript) |
| **Repo memory artifacts** | `system/memory/graph-notes.md`, `doc-notes.md` | `GraphCore` renders, the app writes — a cross-component **format contract**, read by `extension/graphkit/` |
| **Agent / fault memory** | `system/faults/`, `system/q&a/`, `chat-memory.md` | App (`Services/Memory/`) — unrelated to graphs, survives graph exclusion |

Artifact rendering stays in `GraphCore` rather than moving into the pluggable
engine: every implementation that writes those files must agree on their shape,
and the app must still render and explain an artifact already on disk when **no
engine is installed**.

The app keeps what is app policy, not graph production: the SwiftUI views, the
`GraphEngine` protocol and its plugin harness (`PluginGraphEngine`,
`GraphEngineLocator`), scheduling (`GraphAutoUpdater`), and path/layout
decisions (`ProjectLayout`).

## Consequences

- Shipping a graph-free app needs no code motion. The open problem is
  **distribution** — `Apply & Rebuild` requires a source checkout and a Swift
  toolchain, so it is not eligible on a normal user's machine; a graph-free
  variant has to be a release artifact or an install-time choice.
- The `graph-kit` TypeScript plugin is **not yet a replacement** for the built-in
  engine. It cannot merge (no doc→code cross-links — `PluginGraphEngine` falls
  back to a plain union and logs the reduction), and it scans TypeScript and
  JavaScript only, returning 0 nodes for Swift, Kotlin, and Python.
- The built-in Swift engine stays as the fallback. Deleting it would leave a
  machine with no Node, or no plugin installed, unable to generate graphs at all.
- Of the 5522 LOC under `mac/Sources/LlmIdeMac/Graph/`, 2700 is SwiftUI and 809
  is the plugin harness — neither can live in a Node plugin. `BuiltinGraphEngine`
  is already only 70 LOC, so little would actually move.
- Sizes above are debug builds; release stripping will change them. The
  **0 symbols** result does not depend on optimisation — it is source exclusion.

## Related

- [ADR 0008](0008-append-only-migrations.md) — the same "one contract, many
  implementations" reasoning applied to schema
- `extension/graph_generation/README.md` — the engine contract and how a plugin
  supplies one
