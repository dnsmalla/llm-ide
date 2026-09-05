# GraphKit

Shared, **multi-language** graph engine for turning **code** and **text** into a structured
node/edge graph. Extracted from InfiniteBrain + meet-notes so a single update propagates to
every consumer.

UI-free (no SwiftUI) — consumers supply their own rendering. macOS 13+.

## Implementations

All implementations conform to one **canonical graph schema** — the language-neutral JSON
contract in [`schema/SCHEMA.md`](schema/SCHEMA.md) (validated by `schema/graph.schema.json`,
with shared conformance fixtures in `schema/fixtures/`). A graph produced in one language is
readable in another.

| Language | Location | Status |
|---|---|---|
| Swift (SwiftPM) | repo root (`Sources/GraphKit`) | code→graph, text→graph, cache |
| TypeScript (npm `@dnsmalla/graph-kit`) | [`typescript/`](typescript/) | code→graph (TS/JS, call edges), text→graph, index, schema validation, CLI |

The Swift docs below describe the Swift package; see [`typescript/README.md`](typescript/README.md)
for the TypeScript package and the `graph-kit` CLI.

## What it does

- **Code → graph**: scans a repo (Python/TypeScript/JavaScript/Kotlin via tree-sitter, Swift via regex) and produces files, classes, functions, methods, and `imports`/`contains`/`calls`/`inherits`/`implements` edges with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` confidence.
- **Text → graph**: chunks markdown by heading and links chunks via wiki-links + tags (`MemoryGenerator`).
- **Incremental cache**: content-hash based re-scan (`Fingerprint`, `ScanCache`).

## Install

```swift
.package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.0.0")
```

Then add `"GraphKit"` to your target's dependencies and `import GraphKit`.

## Python dependency (code graph)

The rich code scanner shells out to a bundled Python script that needs tree-sitter
installed on the **system** `python3` (PATH-discovered):

```bash
pip3 install tree-sitter==0.21.3 tree-sitter-languages==1.10.2
```

Without it, scanning gracefully falls back to Python-only stdlib `ast` (TS/JS/Kotlin yield no graph).

## Usage

```swift
import GraphKit

// Code → graph
let scanner = StructureScanner(launcher: SystemProcessLauncher())
let scan = await scanner.scan(repoRoot: repoURL)
let graph = StructureGraphBuilder.build(scan, repoRoot: repoURL)   // -> CGData

// Text → graph
let memory = MemoryGenerator.generate(from: vaultURL)              // -> GeneratedMemory (.graph, .chunks)
```

`CGData` holds `[CGNode]` + `[CGEdge]`. Lay them out and render in your own app.

## Layout / colors

Layout (force-directed simulation) and color palettes are **per-app** — GraphKit ships only
the data model and producers, not presentation.
