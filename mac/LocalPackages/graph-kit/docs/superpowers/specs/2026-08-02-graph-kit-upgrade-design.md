# graph-kit Upgrade — Design Spec

- **Date:** 2026-08-02
- **Status:** Design (approved for spec; implementation plan to follow)
- **Scope:** Upgrade graph-kit into a general-purpose, language-agnostic **code + doc + data → knowledge graph** engine that emits a maintained, provenance-linked, token-optimized **`llm-doc`**, pluggable into IDEs (llm-ide, Claude Code) via MCP.
- **Owner:** dinsmallade

---

## 1. Context & Motivation

graph-kit currently sits alongside three sibling systems on this machine — `llm-ide`'s `llm-doc/` + SQLite KB (the docs/query hub), the third-party `graphify` skill/CLI, and graph-kit itself (the user's own engine). The goal is to make **graph-kit the single do-everything extraction + graph engine**: take a **code folder** + **data folder** (+ docs) as input, emit a maintained `llm-doc` into an output folder, and plug into the IDE.

This design is grounded in a deep competitive + state-of-the-art gap analysis across four clusters: (1) multi-language code-graph extraction, (2) LLM context engineering / token reduction, (3) code↔doc↔data linking & validation, (4) scale / incremental / query / MCP. Sources are listed in §14.

**Headline finding:** graph-kit is *"schema-rich and producer-poor."* It already owns the hardest 70% — a stable canonical schema with perfectly-chosen-but-unused node/edge kinds, a deterministic no-LLM/no-embedding philosophy, incremental content-hash caching, and real multi-language tree-sitter extraction (Swift side). What it lacks is **producers, per-edge provenance, a serving surface, and a token-optimized emitter.**

---

## 2. Goals

1. **General-purpose, language-agnostic.** Handle Python, Swift/Kotlin (multiplatform), TS/JS, Go, Rust, Java, C#, etc. — not tuned to any one repo's code or data.
2. **Inputs:** `graph-kit llm-doc --code <dir> --data <dir> [--docs <dir>] --out <dir>`.
3. **Output:** a maintained, compact, provenance-linked `llm-doc` (markdown) + the canonical `graph.json`, so an LLM reads the summary instead of all raw sources → **correct, linked, token-reduced.**
4. **Pluggable into IDEs** via an MCP server (no bespoke editor plugin).
5. **Honest by construction** — every edge carries provenance + confidence; deterministic by default, LLM only as opt-in.

## 3. Non-Goals

- **No embeddings / vector store.** graph-kit's value is the precise structural side (the "foundation" Sourcegraph Cody and refactor tools rely on). Adding embeddings would make it a worse Cursor.
- **No LLM by default.** Deterministic graph, ranking, communities, and `llm-doc` stay LLM-free. LLM is an *opt-in* post-pass only (`--summarize`, `--review`). Avoids Understand-Anything's token-hunger and GraphRAG's 20–100× indexing cost.
- **No stack graphs.** Upstream archived 2025-09-09; only 4 languages; does not solve dispatch/generics.
- **No LSP-as-persistent-graph.** Serena/multilspy is live/on-demand and creates no on-disk graph — wrong fit for a batch engine. LSP is at most a future *interactive* precision booster for SCIP gaps (Swift/Go).
- **Defer (Phase 6+):** LSP `didChange` keystroke-fresh updates; stable cross-repo symbol-IDs (SCIP-shaped).

---

## 4. Current State (graph-kit baseline)

- **Schema (v1, stable):** `GraphDocument{schemaVersion,nodes,edges,layers,tour}`; `CGNode{id,title,kind,position?,metadata:string-map}`; `CGEdge{fromId,toId,kind,confidence}`; confidence ∈ {`EXTRACTED`,`INFERRED`,`AMBIGUOUS`}; **34 node kinds, 37 edge kinds** — including predefined-but-unused data/doc kinds (`config`,`table`,`endpoint`,`schemaNode`,`noteDecision`,`noteFact`; `definesSchema`,`readsFrom`,`writesTo`,`validates`,`migrates`,`configures`,`documents`,`contradicts`).
- **Provenance** lives only in `node.metadata` (`fileURL`,`source_file`,`line` like `"L42"`/`"L3-L17"`). **Nothing on edges; no first-class `Location` type.**
- **Swift impl (canonical per README):** tree-sitter (Python/TS/JS/Kotlin) via a bundled Python script + regex (Swift); code→structure (imports/symbols/calls/inherits/implements); cross-file call resolution is **name-based** → tagged `INFERRED`/`AMBIGUOUS`. Richer doc extraction (PDF/EPUB/OCR). **No CLI, no incremental text engine, no schema validator.**
- **TypeScript impl (the only CLI, `graph-kit`):** code→graph **only for TS/JS** via the TypeScript compiler API. Owns the CLI (`memory`/`code`/`update`/`watch`/`index`/`validate`), zod schema validation, the incremental `update`/`watch` engine with content-hash `cache.json`, and self-gitignored `.graphkit/` output. **Multi-language gap lives here.**
- **Emitters (NOT LLM-summarized):** `generateIndex`/`index.md` (TS), `MemoryNotesWriter`/`graph-notes.md` (Swift), `CodeNoteWriter`/`.code-notes/` (Swift, **legacy non-canonical** `graph.json` — gotcha).
- **External-input template:** `UAParser.parse(data:repoRoot:)` imports Understand-Anything's `knowledge-graph.json` (private `RawX:Decodable` + enum-string mappers + metadata provenance). This is the pattern to copy for every new producer.
- **No MCP server, no graph-DB sink, no git-diff impact analysis, no docstring extraction, no data track, no integrity/reviewer stage, no query/retrieval layer, no community detection.**

---

## 5. Gap Analysis vs State of the Art (condensed)

### 5.1 Multi-language extraction
- **SCIP** (Sourcegraph Code Intelligence Protocol) is the de-facto standard; LSIF is deprecated; stack graphs are archived. SCIP carries precise def↔ref edges (`Occurrence`+roles), `is_implementation` (dynamic dispatch), `is_type_definition` (generics), per-symbol documentation/signature, and per-occurrence `file:range`. ~8× smaller / 3× faster than LSIF. Maintained indexers exist for TS/JS, Python, Go, Java/Kotlin/Scala, Rust, Ruby, C/C++, C#, +community Dart/PHP. **No Swift.**
- SCIP indexers are **not LSP clients** — they embed compilers (javac plugin, TS TypeChecker, pyright internals, rust-analyzer `scip` subcommand). graph-kit just reads `.scip` blobs: an offline, reproducible, CI-cacheable artifact.
- **`tags.scm`** (GitHub tree-sitter tag queries) is the cheap unifier for symbol extraction across ~20 languages **including Swift**; `ast-grep` is a mature structural-search alternative. Both leave cross-file resolution as name-based (honest `INFERRED`/`AMBIGUOUS`).
- **Serena/multilspy** rides real LSP servers (40+ langs) but is **live on-demand, no persistent graph** — defer.

### 5.2 LLM context / token reduction
- **Aider repo map** is the closest analog and validates graph-kit's thesis: deterministic tree-sitter graph → **personalized PageRank** → **token-budget packing** → signature rendering. graph-kit has the graph; it's missing rank+pack+render.
- **Microsoft GraphRAG** proves the value of **Leiden community detection + hierarchical summaries**, but its LLM-heavy indexing (4–6 calls/chunk; 20–100× embeddings cost) breaks graph-kit's no-LLM identity. **Borrow the *structure* (communities, local/global views), not the LLM summarization.**
- **Repomix** flattens everything (unranked); **Cursor/Cody/Greptile** are embeddings-first (deliberately avoided). Cody's lesson: *the precise code graph is the foundation; embeddings alone are insufficient.*
- Token economics place graph-kit in the "Aider / cheap" row — low build cost, low query cost. The `llm-doc` is the per-query compression.

### 5.3 Code↔doc↔data linking & validation
- **~70% of the gaps need NO schema change** — they reuse graph-kit's predefined kinds.
- **Inline docs:** tree-sitter `@doc` captures / griffe (Python) / TypeDoc (TS) / SymbolKit `.symbolgraph` (Swift) / Dokka (JVM) → `noteFact`/`docPage` + `documents`. SCIP carries per-symbol docs natively.
- **Rationale-as-nodes** (graph-kit's strongest differentiator — *no incumbent*): `# WHY:`/`# NOTE:`/ADR (MADR) → `noteDecision`/`noteFact`.
- **Data track:** DBML/Atlas → `table`/`schemaNode`/`definesSchema`/`migrates`; Prisma; `terraform graph` DOT → `config`/`configures`; protobuf `FileDescriptorSet`; pandera on CSV/fixtures. All existing kinds.
- **Drift detection:** delegate deterministic checks (rustdoc/Sphinx/pydocLint/eslint-plugin-jsdoc/lychee) → `contradicts`. **Enum/value-set drift** (code enum vs doc table vs config, linked by `sameAs`) = graph-kit's unique feature.
- **Provenance is the single most important correctness property** — node-only provenance cannot catch a plausible-but-wrong *edge* (the dominant LLM failure mode). Every production code-intel system (SCIP/LSIF) stores location **per-occurrence = per-edge**.

### 5.4 Scale / incremental / query / MCP
- graph-kit's incremental content-hash spine is already SOTA-grade. Add `git diff-index` as an alt trigger; port `watch` to Swift.
- **Git-diff change-impact / blast-radius** is the convergent killer feature (Understand-Anything `/understand-diff`, `code-impact-mcp`, `code-graph-mcp`): reverse-BFS from changed symbols → affected callers/tests/docs/config, with PASS/WARN/BLOCK risk score.
- **MCP server** is the integration surface (Sourcegraph MCP + Serena + code-graph-mcp as blueprints). "Beyond RAG" consensus: wrapping a graph in MCP gives an LLM structural awareness vector-RAG cannot.
- **One canonical graph → many decoupled sinks** (HTML, Obsidian, optional FalkorDB over Neo4j, MCP, IDE).

---

## 6. The Keystone Decision: SCIP as the Spine

**Make SCIP ingestion graph-kit's new spine for code identity, references, and doc binding.** One protobuf reader buys ~10 compiler-grade languages with *real* cross-file resolution that replaces graph-kit's name-matching, plus dynamic-dispatch and generics upgraded from `AMBIGUOUS` → `EXTRACTED`, plus per-edge `file:range` provenance — all as an offline, reproducible, CI-cacheable artifact.

- **Primary spine:** `scip-ingest` adapter. `Occurrence(role=Definition)` → def node; non-def occurrences → `EXTRACTED` ref edges; `Relationship.is_implementation` → `implements` (resolves dispatch); `is_type_definition` → generics. Run indexers in sandboxed executors (Sourcegraph's pattern) so graph-kit stays toolchain-free; only the `.scip` blob crosses the boundary.
- **Universal fallback:** `tags.scm` for languages SCIP doesn't cover — notably **Swift** (sourcekit-lsp emits no SCIP). Swift cross-file edges stay `INFERRED`/`AMBIGUOUS` — the *correct* label.
- **This dissolves the Swift/TS two-engine split** into one unified extractor.
- **Rejected alternatives:** stack graphs (archived, 4 langs, no dispatch/generics); porting Swift tree-sitter to the TS CLI (a Swift `tags.scm` is one file); chasing graphify's "40+ languages" headline (marketing inflation, same name-matching ceiling — copy its *discipline*, the unique-candidate rule, not its breadth).

**Honest limits that stay `AMBIGUOUS` forever** (any approach): runtime dynamic dispatch (JS `obj[f()]`, Python monkeypatch/reflection), proc macros / C preprocessor, dynamic imports with non-constant specifiers. Label honestly; don't pretend.

---

## 7. Target Architecture

```
 EXTRACT (unified)                BUILD (honest)               SERVE (pluggable)
 ────────────────                 ──────────────               ────────────────
 SCIP ingest ─┐                                              • llm-doc emitter (Aider-style rank+pack)
 tags.scm ────┼─► canonical GraphDocument  ─►                  • MCP server (stdio → HTTP)
 doc/data     │   + per-edge provenance       graph-reviewer   • impact analyzer (git-diff blast radius)
 producers ───┘   + first-class Location      (3-tier,always-on) • sinks: Obsidian, FalkorDB(opt), HTML
   (config/SQL/OpenAPI/protobuf/HCL/               ↑
    ADR/docstrings/fixtures)                       │
                                   every edge: {kind, confidence, source_span, extracted_by, run_id}
```

**Contract:**
```bash
graph-kit llm-doc --code <dir> --data <dir> [--docs <dir>] --out <dir>
# → <out>/{graph.json, llm-doc.md, index.md, cache.json}   (self-gitignored)
```

---

## 8. Workstreams

### WS-1 — Unified multi-language extraction *(M)*
SCIP ingest adapter + `tags.scm` fallback; retire/demote the bespoke TS-compiler and Python-scanner paths. Closes the language gap and the two-engine split in one move. Borrow graphify's **unique-candidate rule** for the fallback resolver (resolve only when exactly one global match exists; else `AMBIGUOUS`).

### WS-2 — Provenance-honest schema *(L — the one big change)*
Move provenance from node-metadata **onto edges** + a first-class `Location{file,startLine,startCol,endLine}` type, plus `extracted_by` (extractor+version) and `run_id`. Keep `EXTRACTED`/`INFERRED`/`AMBIGUOUS` *alongside* the locator (confidence-*how* and provenance-*where* are orthogonal). Payoff: surgical invalidation on file move/reline; the only basis on which a reviewer can challenge a *specific* edge; matches every production code-intel system. Property-graph edge properties make it storage-free.

### WS-3 — `llm-doc` emitter (token-reduction engine) *(S–M each)*
graph-kit is ~80% of an Aider-class repo map. Build: **personalized PageRank** (seed = entrypoints / user-named files / recently-changed) → **token-budget packing** (`tiktoken`/`gpt-tokenizer`, tiers 1k/2k/4k/8k) → **AST signature rendering** (bodies elided). Add **Leiden** community detection for a free structural "global view," and **ego-graph/k-hop local mode**. Three deterministic modes:
- `map` — personalized PageRank over whole graph, packed to budget (default `llm-doc`).
- `local` — ego-graph around `--seed`, ranked, packed ("I'm editing X").
- `community` — Leiden TOC + per-community top symbols (onboarding/architecture).

Optional `--summarize-communities` LLM post-pass (calls an external summarizer; keeps core no-LLM).

### WS-4 — Serving + impact analysis *(M each)*
- **MCP server** (~8 tools): `get_symbols_overview`, `find_references`, `get_subgraph`, `impact_analysis`, `explain` (returns the precomputed `llm-doc` for a symbol), `search_code`, `get_call_graph`, `refresh`. Resources: `graph://repo/<sha>`, `llm-doc://<symbol>`, `impact://diff/<base>..<head>`. Ship **stdio first** (zero-config for Claude Code), then HTTP/SSE.
- **Git-diff impact analyzer:** `git diff-index` → changed symbols → reverse-BFS over reverse edges (callers/importers/inheritors/config-refs/doc-refs) → classify downstream by type (code/test/doc/config) → score + **PASS/WARN/BLOCK**. Expose as both CLI (`graph-kit impact --base main --head HEAD`) and the MCP `impact_analysis` tool. Phase 2: upgrade file-level → symbol-level changes via a GumTree/Difftastic-style structural diff.

### WS-5 — Doc/data/validation producers *(S–M each)*
- **Inline-doc producer** (griffe/TypeDoc/SymbolKit/Dokka + tree-sitter `@doc` fallback) → `noteFact` + `documents`.
- **Rationale producer** (`# WHY:`/`# NOTE:` + MADR/Nygard ADRs + Conventional-Commit/Lore trailers) → `noteDecision`/`noteFact`. *No incumbent does this at symbol level.*
- **Data producers** (DBML/Atlas, Prisma, `terraform graph`, protobuf, pandera) → existing `table`/`schemaNode`/`config`/`endpoint` kinds.
- **3-tier `graph-reviewer`:** (1) schema-constrained extraction (SHACL/PG-Schema shapes — reject non-conforming edges *before write*); (2) deterministic referential integrity, always-on (every edge endpoint resolves; dangling refs become legal `AMBIGUOUS` states, SCIP `ForwardDefinition` model — never silent drops); (3) opt-in LLM semantic judge (KGValidator-style ternary). **Trust no upstream extraction** — re-tag imported (UA/GraphRAG) edges as `INFERRED`, never `EXTRACTED`.

---

## 9. Schema Strategy (deliberately staged)

- **Phase 0 — no change.** All WS-5 producers emit existing kinds.
- **Phase 1 — additive edge kinds:** `references` (symbol-level, distinct from `documents`), `hyperlink` (URL/anchor, distinct from `references`), `sameAs`/`closeMatch` (SKOS cross-format identity), `justifiedBy`/`supersedes`/`constrains` (rationale vocabulary). Needed for cross-format reconciliation and distinct drift signals.
- **Phase 2 — the one structural change:** per-edge provenance + first-class `Location` type (WS-2). Bump `schemaVersion` to 2.

---

## 10. Phased Roadmap

| Milestone | Scope | Outcome |
|---|---|---|
| **M0** | SCIP ingest adapter + `tags.scm` fallback; unify extractors; `--data`/`--code`/`--out` contract | ~10 languages gain compiler-grade resolution; two-engine split gone |
| **M1** | Data + doc + rationale producers (existing kinds); deterministic `graph-reviewer` | Real code↔doc↔**data** graph with integrity |
| **M2** | `llm-doc` emitter (PageRank + budget pack + signatures + Leiden + ego-graph) | The token-reduction deliverable: compact, linked summaries |
| **M3** | MCP server (stdio) + git-diff impact analyzer | Plugs into Claude Code / llm-ide; blast-radius on every change |
| **M4** | Schema Phase 1 (`sameAs` etc.) + cross-format reconciliation + enum/value-set drift | graph-kit's unique differentiator ships |
| **M5** | Schema Phase 2 (per-edge provenance + `Location`); LLM `--summarize` opt-in; optional FalkorDB sink; Swift-feature parity | Production-grade honesty + optional richness |

**First implementation plan scope: M0–M3.** M4–M5 = follow-on spec.

---

## 11. IDE Integration

The **MCP server is the integration** — no bespoke IDE plugin required. llm-ide (and Claude Code, Cursor, VS Code) consume it directly over stdio. llm-ide additionally shells out to the `graph-kit` CLI to build/refresh and ingests `llm-doc.md` + `graph.json` into its existing SQLite KB (the docs/query hub). graph-kit stays language/runtime-agnostic (TS CLI now; Swift in-process later via SwiftPM linkage once the contract is stable).

---

## 12. Risks & Trade-offs

- **SCIP indexer availability per language.** Mitigation: `tags.scm` fallback; Swift explicitly stays `INFERRED`. Run indexers in sandboxed executors to keep graph-kit toolchain-free.
- **Per-edge provenance is a wide-reaching schema change (Phase 2).** Mitigation: stage it last; property-graph edge properties make storage free; only write/read paths change.
- **Honest `AMBIGUOUS` edges look like "incompleteness."** Mitigation: frame as correctness (every system that claims full static dispatch resolution is lying about runtime cases).
- **Scope creep.** Mitigation: explicit non-goals (§3); first plan capped at M0–M3.
- **Adoption of LLM opt-in features.** Keep core deterministic so the engine is useful with zero LLM cost; LLM features are pure upside.

---

## 13. Open Questions

1. Confirm **SCIP-as-spine** is acceptable (per-language indexers run as external subprocesses; graph-kit reads `.scip` blobs). — *Load-bearing decision.*
2. First implementation-plan scope = **M0–M3** (defer M4–M5 to a follow-on spec)?
3. Does graph-kit's `schemaVersion` bump policy (additive enums allowed without bump) extend cleanly to the Phase-2 edge-provenance change, or does that mandate v2? — *Assume v2; confirm during M5.*
4. Output sink for `--out`: reuse `.graphkit/` (TS) vs a caller-specified path (llm-ide's KB ingest)? — *Default caller-specified `--out`; `.graphkit/` as fallback.*

---

## 14. Sources (load-bearing)

**SCIP / code intelligence:** [scip-code.org](https://scip-code.org/), [announcing SCIP](https://sourcegraph.com/blog/announcing-scip), [scip.proto](https://github.com/sourcegraph/scip), [cross-repo nav](https://sourcegraph.com/blog/cross-repository-code-navigation), [LSIF (deprecated)](https://lsif.dev/).
**Stack graphs (rejected):** [github/stack-graphs (archived 2025-09-09)](https://github.com/github/stack-graphs), [paper arXiv:2211.01224](https://arxiv.org/abs/2211.01224).
**tree-sitter extraction:** [tree-sitter code-nav / tags.scm](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html), [ast-grep](https://astgrep.com).
**LSP / Serena (deferred):** [oraios/serena](https://github.com/oraios/serena), [microsoft/multilspy](https://github.com/microsoft/multilspy).
**Context / token reduction:** [Aider repo map](https://aider.chat/docs/repomap.html), [Aider PageRank](https://anishgandhi.com/aider-pagerank-codebase-ranking/), [Meetsmore ImportFlood](https://engineering.meetsmore.com/entry/2024/12/24/042333), [GraphRAG arXiv:2404.16130](https://arxiv.org/abs/2404.16130), [GraphRAG cost cliff](https://medium.com/graph-praxis/the-graphrag-cost-cliff-how-33-000-became-33-in-eighteen-months-be1b0fbe37e4), [Repomix](https://github.com/yamadashy/repomix), [Sourcegraph Cody](https://sourcegraph.com/blog/anatomy-of-a-coding-assistant).
**Doc/data/validation:** [griffe](https://mkdocstrings.github.io/griffe/), [TypeDoc](https://typedoc.org/), [Swift SymbolKit](https://swiftlang.github.io/swift-docc-symbolkit/), [MADR](https://github.com/adr/madr), [pydoclint](https://github.com/jsh9/pydoclint), [SHACL](https://www.w3.org/TR/shacl/), [Atlas](https://github.com/ariga/atlas), [DBML](https://dbml.dbdiagram.io/docs/), [`terraform graph`](https://developer.hashicorp.com/terraform/cli/commands/graph), [pandera](https://pandera.readthedocs.io/), [CASCADE (doc drift) arXiv:2604.19400](https://arxiv.org/abs/2604.19400), [KGValidator arXiv:2404.15923](https://arxiv.org/abs/2404.15923).
**Provenance / identity:** [W3C PROV-O](https://www.w3.org/TR/prov-o/), [RDF-star](https://www.w3.org/2021/12/rdf-star.html), [SKOS](https://www.w3.org/TR/skos-reference/), [Pujara & Getoor 2016](https://linqs.org/assets/resources/pujara-starai16.pdf), [Talisman — Where Provenance Ends](https://jessicatalman.substack.com/p/where-provenance-ends-knowledge-decays).
**Scale / serving / MCP:** [code-graph-mcp](https://github.com/sdsrss/code-graph-mcp), [code-impact-mcp](https://github.com/vk0dev/code-impact-mcp), [Sourcegraph MCP](https://sourcegraph.com/mcp), [GumTree](https://github.com/GumTreeDiff/gumtree), [Difftastic](https://difftastic.wilfred.me.uk/tree_diffing.html), [FalkorDB vs Neo4j](https://www.falkordb.com/blog/best-database-for-knowledge-graphs-falkordb-neo4j/), [MCP spec](https://modelcontextprotocol.io/), [Beyond RAG (MCP-native KGs)](https://medium.com/data-science-collective/beyond-rag-how-mcp-native-knowledge-graphs-unlock-full-codebase-structural-awareness-ba5a260cb063).
