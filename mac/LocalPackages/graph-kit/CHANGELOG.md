# Changelog

All notable changes to GraphKit. The Swift package and the TypeScript package
(`typescript/`) share one canonical graph schema (`schema/SCHEMA.md`); the schema's
`schemaVersion` is versioned independently of the package tags.

## [Unreleased]

### Added
- **Committed single-file CLI bundle** at `bin/graph-kit.js` (esbuild, minified,
  dependencies included — the TypeScript compiler API accounts for most of its
  size). `graph-engine.json` points at it, so the repository is installable as a
  graph-engine plugin with **no install step**: a fresh clone with neither
  `node_modules/` nor `dist/` passes the manifest gate. Regenerate after any
  `typescript/src` change with `cd typescript && npm run bundle`.

### Fixed
- **TypeScript code scanner skipped `.mjs`/`.cjs`.** `tsScanner`'s discovery set
  omitted both extensions while its `language()` mapping already claimed them,
  so any ESM-only tree scanned to **0 nodes**. Import resolution
  (`RESOLVE_EXTS`) had the same gap. Measured on a Node server tree:
  `0 → 65/26/194` nodes for three packages that previously produced nothing;
  TypeScript trees are unchanged.

### Removed
**Breaking (Swift, GraphKit product).** Nine unreferenced public types — no
consumer in this repository called any of them, and none appears in the
`graph-engine.json` command contract. `GraphCore` is untouched.

- **Document → text pipeline**: `InputReader`, `PDFExtractor`, `EPUBExtractor`,
  `TextChunker`, `DocumentScanner`. GraphKit no longer extracts text from PDF or
  EPUB, and no longer depends on PDFKit/Vision.
- **Understand-Anything import**: `UAParser`, `UAStore`, `UAError`.
- **`CodeNoteWriter`**.

Text→graph (`MemoryGenerator`), code→graph (`StructureScanner`,
`StructureGraphBuilder`), the merge (`GraphMerger`) and the cache (`ScanCache`)
are unaffected.

## [1.7.0] - 2026-09-02

One repository, two products. The package now exports **GraphCore** (canonical
model + JSON contract + 2D/3D layout + memory-artifact rendering — everything a
consumer needs to *read and draw* a graph, always linked) alongside **GraphKit**
(the producers — everything that *creates* one, designed to be unpluggable or
supplied by a plugin). Layout, previously a consumer concern, is now part of the
package via GraphCore.

### Added
- **GraphCore product**: `CGData`/`CGNode`/`CGEdge` model, `GraphDocument` JSON
  contract, `MemoryChunk`/`GeneratedMemory`/`ScanResult`/`CodeScan` boundary
  DTOs, the deterministic cluster-aware layout engine (`GraphLayoutEngine`,
  Louvain communities, Barnes-Hut with ground-truth audits, quality metrics),
  `CGSimulation3D`, `MemoryArtifactRenderer` (graph-notes.md / doc-notes.md),
  `DocSetFingerprint`, `DocExtensions`, `EdgeWeight` (semantic edge weighting).
- **GraphMerger** (GraphKit): the code+doc join with doc→code cross-links —
  wikilinks (EXTRACTED), backtick mentions (INFERRED), and **declared
  `related-modules:` affinities (documents/EXTRACTED)**, which previously
  produced no edges at all. Fan-out capped per module, fan-in per file;
  authoring forms `./x`, `x/`, `x/*`, `x/**` normalised.
- **`MemoryGenerator.generate(roots:)`** multi-root walk.
- **Verification gates**: `graph-layout-lab` (layout vs exact N² ground truth,
  Louvain reference values, quality metrics) and `graph-engine-lab`
  (generation invariants) — plain executables so they run on toolchains
  without XCTest.
- TypeScript CLI: `memory` now emits `chunks` + `docCount` alongside the
  canonical document.

### Changed
- **Doc containment is `doc → chunk`, kind `contains`, EXTRACTED** in both
  implementations (was `chunk → doc` as `relatedTo`, which made a document's
  backbone indistinguishable from title-match noise; a real 13-doc folder
  shattered into 209 single-node components). Conformance fixture updated.
- Wikilink doc→code cross-links are `EXTRACTED` (author-asserted), no longer
  `INFERRED`.

### Removed
- `MemoryNotesWriter` — dead since the `.understand-anything/` layout was
  retired; every section it rendered was empty (it queried a node kind and
  metadata keys no producer emits). `MemoryArtifactRenderer` is the live
  replacement.


## [1.6.2] — 2026-08-30

### Changed
- **MemoryGenerator frontmatter parsing is now Yams-free.** A small line
  parser replaces `Yams.load`: agent skill/tool files often carry long
  single-line `description:` values with unquoted colons and nested
  `schema:` mappings, and `Yams.load` can trap (not throw) on non-scalar
  mapping keys — taking down the host process during background graph
  builds. The parser keeps the 1.6.1 metadata surface (`type`/`kind`,
  `tags` in all four spellings, `graph-only`, `related-modules`).
- The body returned after a frontmatter block is trimmed of the closing
  fence's trailing newline, so it always starts at its first content
  character (the two frontmatter tests that pinned this were red in the
  vendored fork this change reconciles; both are green here).
- **Yams is no longer a dependency of the Swift package.**

This reconciles the llm-ide vendored fork (`mac/LocalPackages/graph-kit`)
back upstream: both consumers now share one implementation.

## [1.6.1] — 2026-08-05

### Added
- **update --scip** (TypeScript, code): consume a Sourcegraph SCIP index for precise,
  compiler-derived code graphs (TS/JS, Python, Go, Java/Kotlin, Rust, …).
  New `typescript/src/code/scipScanner.ts`.

### Changed
- **BREAKING:** `scanCode` and `updateMemory` are now `async` (return `Promise`);
  callers must `await` them.

### Fixed
- `StructureScanner.fallbackList` and `FileStructureExtractor.fallbackEnumerate`
  (the non-git fallback file listers, used whenever a project has no `.git`) were
  each missing `graphify-out` and `system` from their skip-directory list — present
  only in `MemoryGenerator.excludedDocDirs`, a third near-identical copy. On a
  non-git project, this meant every re-scan re-discovered the indexer's own
  previous `system/graph/` output as new input and mirrored it one level deeper —
  unbounded self-referential nesting (confirmed in the field at 22 levels deep,
  644 files), which then floods every consumer of repo-memory context (e.g. the
  LLM-IDE Code Assistant's injected prompt) without bound. Consolidated all three
  copies into one shared `ExcludedDirs.names`.

## [1.6.0] — 2026-07-02

### Added
- **`DocCodeLinker`** (Swift, text): resolves backtick-quoted doc mentions (e.g.
  `` `kb/db.mjs` ``, `` `backupTo` ``) against a caller-supplied code-symbol
  inventory, producing scored doc→code link candidates. Replaces wikilink-only
  doc→code linking, which real-world docs essentially never use.
- **`graphOnly` / `relatedModules` on `MemoryChunk`** (Swift, text): populated from
  new `graph-only` / `related-modules` YAML frontmatter keys, letting a downstream
  consumer route a doc into the graph without also surfacing it as agent-facing
  memory, and declare which code modules a doc is about.

### Fixed
- **Re-export lines now captured as import edges** (Swift, scan):
  `FileStructureExtractor.importSpecifier` previously only recognized `import`,
  `require`, and dynamic `import()` — files using `export { X } from './m'`,
  `export * from './m'`, `export type { X } from './m'`, or a multi-line block's
  closing `} from './m';` had those dependency edges silently dropped, leaving
  re-export-heavy files with incomplete graphs.
- **Fence-aware markdown parsing** (Swift, text): headings, `#hashtags`, and
  `[[wikilinks]]` inside fenced code blocks (```` ``` ````/`~~~`) are no longer
  misread as real document content; the fallback title-match linker now ignores
  fenced content too. Chunk bodies still preserve fences for display.
- **Edge-noise reduction in doc-graph cross-chunk linking** (Swift, text): the
  title-match fallback now requires 2+ word tokens, so a single-word title like
  "Config" no longer whole-word-matches large swaths of a corpus; tags spread
  across more than 12 chunks are now skipped entirely as too generic to be a
  relatedness signal (previously truncated to an arbitrary clique of 6 regardless
  of how generic the tag was).

## [1.5.4] — 2026-06-29

### Fixed
- **Python imports now resolve against source roots** (Swift): `ImportResolver`
  matched dotted modules only relative to the repo root, so projects laid out
  under a source root on `sys.path` (e.g. `app/backend/`) had essentially every
  intra-repo Python import dropped — `from schema.user import X` looked for
  `schema/user.py` at the repo root instead of `app/backend/schema/user.py`.
  Resolution now walks the importing file's directory and every ancestor up to
  the repo root (deepest first, closest match wins), so source-root-relative and
  sibling imports both resolve while stdlib/third-party correctly stay unlinked.
  On a 2,049-file Python repo this took the code graph from 15 edges to 6,527.
  +4 tests.

## [1.5.3] — 2026-06-24

### Fixed
- **Generated-knowledge dirs excluded from the doc walker** (Swift): the text
  walker (`MemoryGenerator.collectDocs`) now skips `system`, `graphify-out`,
  `.code-notes`, `.understand-anything`, and the usual vendor/build dirs. It was
  indexing the indexer's *own* regenerated markdown (per-file code notes and
  duplicate `repo.md`/`index.md` summaries), which double-counted content and
  flooded the doc graph with duplicate nodes — e.g. a 175-doc project produced
  904 nodes / 19k edges, dropping to 32 real docs / 298 nodes once skipped.

## [1.5.1] — 2026-06-12

### Fixed
- **Vendor/build dirs excluded from the text walker** (TypeScript): node_modules,
  dist, .build and friends no longer leak into text graphs; one shared exclusion
  set now serves both the code and text walkers.

### Changed
- TypeScript `package.json` version re-synced with git tags (was stuck at 1.1.0).
- Added a root `LICENSE` file (MIT) matching the package metadata.

## [1.5.0] — 2026-06-05

### Added
- **Code → graph call edges** (TypeScript scanner): `scanCode` now emits `calls` edges
  (symbol → symbol) from function/method/arrow-const bodies, resolved by name — unique
  match → `INFERRED`, ambiguous → `AMBIGUOUS`, no in-repo match → dropped. Completes
  code-graph parity with the Swift scanner. +1 test (23 total).

## [1.4.0] — 2026-06-05

### Added
- **TypeScript code → graph scanner** (`scanCode`, `graph-kit code <dir>`, `update --code <dir>`):
  TS/JS via the TypeScript compiler API — file/symbol nodes (functions, classes, methods,
  interfaces, arrow-function consts) with `contains` / `imports` (resolved relative imports) /
  `inherits` / `implements` edges. Deterministic output. `mergeGraphs` unions a code graph
  into the memory index. (`typescript` promoted to a runtime dependency.)

## [1.3.0] — 2026-06-05 — multi-language platform

### Added
- **Canonical schema** (`schema/SCHEMA.md` + `schema/graph.schema.json`, `schemaVersion: 1`):
  the language-neutral node/edge contract every implementation conforms to, plus shared
  conformance fixtures under `schema/fixtures/`.
- **Swift**: `CGNode`/`CGEdge`/`CGData`/`CGNodeKind`/`CGEdgeKind`/`CGEdgeConfidence`/`UALayer`/
  `UATourStep` are now `Codable`; new `GraphDocument` envelope (`schemaVersion` + payload) with
  canonical (sorted-key) JSON encode/decode and a future-version guard. 4 new conformance tests
  (42 total).
- **TypeScript package** (`typescript/`, `@dnsmalla/graph-kit`): the canonical model + zod
  validation, a faithful port of the text→graph `MemoryGenerator`, a markdown index generator,
  and a `graph-kit` CLI (`memory` / `index` / `validate`). 11 tests incl. cross-language
  fixture conformance against `schema/fixtures/`.

### Fixed
- **Swift**: `MemoryNotesWriter.childSymbols` now accepts both `defines` and `contains`
  edges, so a code-scan graph (which emits `contains`) renders symbols instead of an empty
  index.
- README SwiftPM install URL corrected (`graph-kit.git`, was `GraphKit.git`).

### Added — memory engine (TypeScript)
- **Incremental, idempotent index generation** (`updateMemory` + `graph-kit update`): a
  content-hash manifest re-chunks only changed files and reuses cached chunks for the rest;
  a no-op run produces byte-identical output. Reports added/updated/unchanged/removed.
- **Background regeneration**: `graph-kit watch <dir>` (debounced) for live updates; `update`
  is hook-friendly (git post-commit / file watcher) for detached background runs.
- **Local-only artifacts**: writes `graph.json` + `index.md` + `cache.json` to a `.graphkit/`
  dir that **self-gitignores** (`*`) — generated memory never gets committed or pushed.
- **Skill + agent linking**: new canonical node kinds `skill` + `agent` (Swift + TS + JSON
  Schema); `scanSkills`/`scanAgents` turn `SKILL.md` + agent definitions into nodes, and
  `mergeCapabilities` links them to the docs/code that reference them. `update --skills <dir>
  --agents <dir>` folds them into the index so agents can consult memory at low token cost.

### Notes / next
- TypeScript **code → graph** scanner (TS/JS via the TypeScript compiler API) is the next
  milestone, then consuming the engine from auto-system (as a submodule) to generate its
  index — without moving its memory into GraphKit.

## [1.1.0] — 2026-06-03
- Added the document-extraction layer (`Extract/`: PDF + Vision OCR, EPUB, chunking). macOS 13+.
  Fixed two TextChunker bugs. 38 tests.

## [1.0.1] — 2026-06-03
- Fixed a force-unwrap in `CodeNoteWriter`.

## [1.0.0] — 2026-06-03
- Initial extraction of the shared code→graph + text→graph engine from InfiniteBrain + meet-notes.
