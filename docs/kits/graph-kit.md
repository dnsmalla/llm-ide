# graph-kit

Status: **K0 Map**, written 2026-10-28. No code changed. The layout inventory is §6, the port design §7, the parity and rollout plan §8, and the decisions for the user §9. Corrections to the plan's premises are in §10.

Conventions. `gk/` means `mac/LocalPackages/graph-kit/`. Every other path is relative to the llm-ide root. `path:line` citations were checked on llm-ide `a0dd8473` and graph-kit `b9235dd`. That revision is the submodule gitlink and the `revision:` pin in `mac/Package.swift` (`graphKitDependency`, `:326`), and `.github/workflows/mac-ci.yml:280-287` fails when the two differ. `make graphkit-pin-check` checks all three pins, including `mac/Package.resolved`.

Counts. Line counts are `wc -l` over the listed files. Swift test counts are `grep -c 'func test\|@Test'`. TypeScript and JavaScript test counts are `grep -cE '^\s*(test|it)\('`, which is a source-level count; the runner's own count is given in brackets when it differs. Rust counts are `#[test]` attributes. Run results are from this Mac on 2026-10-28 (arm64, macOS 26.6, Xcode with XCTest, rustc 1.99.1, Node 22.23.1). §11 lists the commands.

## 1. Purpose

graph-kit is the whole graph system in one repository, built as two Swift products with different lifetimes. **GraphCore** holds the model, the JSON contract and the layout engine; the app always links it (`gk/Package.swift:1-24`, products `:28-29`). **GraphKit** holds the producers (scanners, extractors, the memory generator and the merger); the app can drop it (`gk/Package.swift:13`, and the `UNPLUG:` markers in `mac/Package.swift:313,402`). Around the Swift code the repository also holds a TypeScript package and CLI that serves as the graph-engine plugin (`gk/typescript`, `gk/graph-engine.json`), a Rust crate for the OS graph core that runs as WASM in the System page (`gk/rust/os-graph`, `gk/web`), and the canonical schema (`gk/schema`).

The plan's kit row (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md`, kit table, row 3) names the kit as the graph-kit repo, `extension/graphkit/`, `kb/code-graph`, `graph_generation/`, and `Features/CodeGraph`. The key is `code_graph_3d` and the contract group is live-loop-misc. The plan's K1 for this kit is "layout in Rust/WASM, K3 = WebGL view" (plan, Order, item 5).

This map found three things the plan's row does not state:

1. The OS view (the System page) has its source in `gk/web` and is built into the app by `ui/os-view`. The plan places the System page under os-kit (§3 edge G8 and decision Q2).
2. The repository has at least four graph JSON shapes and two layout families (§5 and §6.5). The Rust crate does not contain the Swift layout engine; it contains a different community algorithm and a different layout (§10, P2).
3. The layout engine is not a UI-state-only piece. It is a computation, so the plan's K1-skip rule does not apply and K1 is needed.

## 2. Code on every side

### 2a. graph-kit repository (`gk/`)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Model: node and edge kinds, `CGNode`, `CGEdge`, `CGData` | `gk/Sources/GraphCore/Model/CodeGraphModels.swift` | 210 | `CGNodeKind` has 34 cases (`:4-14`), `CGEdgeKind` 37 (`:99-110`). `CGNode` decodes `kind` through the RawRepresentable enum (`:136`), so an unknown kind fails to decode. Omits a zero `position` on encode (`:149`). |
| Model: canonical envelope | `gk/Sources/GraphCore/Model/GraphDocument.swift` | 70 | `schemaVersion` = 1 (`:10`). Decode rejects a newer version (`:53-59`). |
| Model: scan result and code scan | `gk/Sources/GraphCore/Model/ScanResult.swift` (100), `CodeScan.swift` (56) | 156 | Scanner output types. |
| Model: memory chunks and artifact rendering | `gk/Sources/GraphCore/Model/MemoryChunk.swift` (121), `MemoryArtifactRenderer.swift` (142) | 263 | The "Render" part of GraphCore. There is no separate Render folder. |
| Layout | `gk/Sources/GraphCore/Layout/` (9 files) | 2 038 | §6 inventories every file. |
| Support | `gk/Sources/GraphCore/Support/` (`ProcessLauncher` 108, `Fingerprint` 57, `DocSetFingerprint` 52, `ExcludedDirs` 28, `DocExtensions` 15) | 260 | Hashing, process launch and directory exclusions. |
| Producers: structure | `gk/Sources/GraphKit/Scan/` (`StructureScanner` 193, `FileStructureExtractor` 360, `ImportResolver` 135, `PythonASTExtractor` 158, `RawFileStructure` 53); `gk/Sources/GraphKit/Build/StructureGraphBuilder.swift` 250 | 1 149 | Code to graph. Python extraction shells out to a bundled script (see resources below). |
| Producers: merge | `gk/Sources/GraphKit/Build/GraphMerger.swift` | 155 | Doc to code cross-links. |
| Producers: text | `gk/Sources/GraphKit/Text/MemoryGenerator.swift` (678), `DocCodeLinker.swift` (80) | 758 | Markdown to chunks and doc memory. Deterministic. |
| Producers: cache and utilities | `gk/Sources/GraphKit/Cache/ScanCache.swift` (56), `Utilities/AppJSON.swift` (20), `Utilities/Date+ISO.swift` (12) | 88 | |
| Producers: bundled scripts | `gk/Sources/GraphKit/Resources/code_graph_scan.py` (362), `code_ast_scan.py` (67) | 429 | Copied into the GraphKit bundle (`gk/Package.swift:50-51`). The tree-sitter path needs a system `python3` (`gk/README.md`, "Python dependency"). |
| Lab: layout gate | `gk/Sources/GraphLayoutLab/` (`main.swift` 502, `SyntheticGraph.swift` 203, `SVGWriter.swift` 170, `LegacyLayout.swift` 130) | 1 005 | §6.4. `LegacyLayout.swift` keeps the replaced pipeline (`capDegree`, pie-slice seed, fixed-alpha sim) for `--compare`. |
| Lab: engine gate | `gk/Sources/GraphEngineLab/main.swift` | 468 | Generation invariants and the `EdgeWeight` threshold checks (`:370-382`). |
| XCTest | `gk/Tests/GraphKitTests/` (15 Swift files, 1 141 lines with fixtures) | 1 141 | 81 XCTest functions, all pass. None of them reference a layout type (§6.4). |
| TypeScript package | `gk/typescript/src/` (`cli.ts` 194, `models.ts` 193, `build/graphMerger.ts` 172, `code/tsScanner.ts` 335, `code/lineScanner.ts` 183, `code/scipScanner.ts` 220, `text/memoryGenerator.ts` 700, `text/docCodeLinker.ts` 97, `incremental.ts` 148, `indexGenerator.ts` 112, `skills/skillScanner.ts` 123, `system/types.ts` 288, `exclusions.ts` 17, `index.ts` 26, `system/index.ts` 4) | 2 812 | The CLI commands are `memory`, `update`, `watch`, `code`, `merge`, `index`, `validate` (`cli.ts:184-187`). `system/types.ts` is types only: its builder and orbit code was removed (`gk/rust/README.md`, Status). No layout code. |
| TypeScript tests | `gk/typescript/test/` (10 files) | 1 282 | 70 tests, all pass. Run by graph-kit CI (`gk/.github/workflows/ci.yml:21-34`). |
| CLI bundle | `gk/bin/graph-kit.js` | 486 lines, 3 658 702 bytes | esbuild output, committed. A fresh `esbuild` build of `typescript/src/cli.ts` is byte-identical to it (checked 2026-10-28). |
| Plugin manifest | `gk/graph-engine.json` | 48 | Three commands: `scanCode` (`node bin/graph-kit.js code {repo} --out {out}`, 600 s), `docMemory` (600 s), `merge` (300 s). Doc extensions `md`, `mdx`, `markdown`, `txt`. |
| Rust crate | `gk/rust/os-graph/src/` (`viz.rs` 2 267, `builder.rs` 1 371, `orbit.rs` 1 093, `api.rs` 442, `snapshot.rs` 385, `models.rs` 393, `wasm.rs` 48, `lib.rs` 38) | 6 037 | The OS graph core. Modules: `builder` (categorize, label-propagation communities, cap, activity ring), `orbit` (3D orbit layout), `viz` (VizGraph for the OS view and its parts), `api` (JSON in and out), `wasm` (wasm-bindgen exports). Not the Swift layout (§10, P2). |
| Rust tests | `gk/rust/os-graph/tests/parity.rs` (321), `tests/golden/` (19 system and orbit goldens, 4 `viz/` goldens) | 321 + goldens | 102 unit tests and 2 parity tests pass; 2 golden writers are `#[ignore]`. |
| Rust build | `gk/rust/Cargo.toml`, `gk/rust/os-graph/Cargo.toml` | 12, 24 | Dependencies: `serde`, `serde_json`; optional `wasm-bindgen` 0.2 (locked 0.2.129) and `console_error_panic_hook`. Release profile is size-tuned (`opt-level = "z"`, LTO, `panic = "abort"`, `rust/Cargo.toml:7-13`). |
| WASM build | `gk/scripts/build-os-wasm.sh` (140) | 140 | Writes `web/src/wasm/pkg/` and `web/src/wasm/bytes.ts`. `--check` rebuilds and diffs. Run on 2026-10-28: "generated OS wasm files match a fresh build". |
| Web package | `gk/web/src/` (9 017 lines of TS, TSX and CSS), `gk/web/test/` (4 601), `gk/web/demo/` (550) | 14 168 | The System page (`mountOsView`, `index.ts`). `systemGraph.ts` calls the WASM core (`:18`). `orbit/OrbitView.ts` (1 893) renders a three.js point cloud (`web/package.json`: `three` as a peer, `^0.185.0`). |
| WASM artifact | `gk/web/src/wasm/bytes.ts` | 787 631 bytes (one line) | The module as base64, about 590 KB of WASM. The page runs from `file://` in a WKWebView, so the bytes are embedded (`scripts/build-os-wasm.sh:9-11`). |
| Web tests | `gk/web/test/*.mjs` (5 files) | 4 601 | 310 tests, all pass (`npm test`, `node --test`). Not run by any CI (§2f, D8). |
| Schema | `gk/schema/graph.schema.json` (87), `gk/schema/SCHEMA.md` (111), `gk/schema/fixtures/` (3 files: 14, 37, 55 lines) | 267 + fixtures | Canonical `GraphDocument` contract. Validated by ajv in CI (`gk/.github/workflows/ci.yml:38-49`). |
| Parity script | `gk/scripts/conformance-memory.mjs` | 301 | Runs the Swift and TypeScript doc tracks over one corpus and diffs them. Part of `make graph-gates`. |
| CI | `gk/.github/workflows/ci.yml` | 49 | Three jobs: Swift (macOS 14, `swift build` and `swift test`, `:11-17`), TypeScript (Node 18 and 20, `:21-34`), schema (`:38-49`). No Rust job and no web job. |

### 2b. Mac app (`mac/Sources/LlmIdeMac/`)

`Features/CodeGraph/` holds 25 Swift files and 6 208 lines. Every Swift source that imports `GraphCore` or `GraphKit` is under this folder (`grep -rln 'import GraphCore\|import GraphKit' Sources`). `Core/Project/ProjectGraphFile.swift` mentions GraphCore only in comments (`:6-11`). The test target has 10 files that import either product (§2f).

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Graph screen (2D canvas host) | `Features/CodeGraph/Views/UAGraphView.swift` | 1 907 | Owns layout orchestration: `hydrateFromStore` `:247`, `cacheGraph` `:236`, `recomputeDisplayData` `:299` (edge filter `:305-349`), `adoptLayout` `:1647`, `applyLayout` `:1677`, the layout call `:1696`, `applying` `:1707`, `signals` `:1661`, `settle3DIfNeeded` `:1747`, 3D `CGSimulation3D` call `:1763`. |
| 2D renderer | `Features/CodeGraph/Views/CodeGraphCanvas.swift` | 592 | Takes a `GraphLayout` (`:18-22`). Edge alpha reads `layout.edgeWeight` and falls back to `EdgeWeight.weight(of:)` (`:376-380`). |
| 3D renderer | `Features/CodeGraph/Views/Graph3DView.swift` | 187 | SceneKit `NSViewRepresentable` that draws pre-settled `SIMD3<Float>` positions (`:10-13`). |
| Session cache | `Features/CodeGraph/Views/GraphSessionStore.swift` | 172 | In memory only (`:12-16`). Keyed `repoPath#mode`. Holds at most `maxCachedRepos` = 4 (`:52`). |
| Settings card | `Features/CodeGraph/Views/GraphSettingsSection.swift` | 56 | The only graph card in Settings. Registered by Shell (`Shell/FeatureCatalog.swift:152-156`, under `#if FEATURE_GRAPH`). |
| Helpers and palette | `Views/UAHelpers.swift` (160), `Views/CGPalette.swift` (87), `Models/GraphNodeDisplayPolicy.swift` (39) | 286 | |
| Auto-update | `Features/CodeGraph/Services/GraphAutoUpdater.swift` | 321 | Interval default 15 min (`:80`), floor 5 min (`:82`), recursive FSEvents watcher with debounced regeneration (`:57`, `:142-145`). Publishes to `GraphSessionStore` (`:274`). |
| Generation service | `Features/CodeGraph/Services/KnowledgeGraphService.swift` | 372 | Code and doc graph generation through the engine. |
| Upload | `Features/CodeGraph/Services/CodeGraphUploadService.swift` | 358 | Batches of 1 500 nodes and 4 000 edges (`:45-46`), cap 40 000 nodes (`:50`). Posts to `/kb/ingest-code-graph`. |
| Upload client | `Features/CodeGraph/Services/LlmIdeAPIClient+CodeGraph.swift` | 98 | The only Swift caller of the code-graph route. |
| Loop rescanner | `Features/CodeGraph/Services/LoopGraphRescanner.swift` | 48 | Implements the Core contract `GraphRescanning`. Installed by Shell (`Shell/FeatureCatalog.swift:837-849`). |
| System view export | `Features/CodeGraph/Services/ProjectGraphExport.swift` | 13 | `documentJSON` (`:10`), called from Shell at `FeatureCatalog.swift:319`. |
| Feature module | `Features/CodeGraph/Services/GraphModule.swift` | 27 | `AppModule` conformance (the registry entry). |
| File classification | `Features/CodeGraph/Services/FileClassifier.swift` | 109 | Strips markdown nodes from the code graph (`UAGraphView.swift`, the "md is doc" comment and the `strippingDocNodes` call). |
| Engine protocol | `Features/CodeGraph/Engine/GraphEngine.swift` | 193 | `GraphEngine` (`:16`), `resolveDefault` (`:102`, plugin first, then built-in, `:139-151`). |
| Built-in engine | `Features/CodeGraph/Engine/BuiltinGraphEngine.swift` | 78 | Under `#if GRAPHKIT_BUILTIN` (`:1`). The only file that imports `GraphKit`. |
| Plugin engine | `Features/CodeGraph/Engine/PluginGraphEngine.swift` | 462 | Spawns the manifest commands (`runProducing` `:175`). Timeout clamped to 10 to 3 600 s (`:236`). Merge without a plugin merge command is a plain union (`:123-152`). |
| Plugin locator | `Features/CodeGraph/Engine/GraphEngineLocator.swift` | 210 | Plugin directories (`:30-40`): `LLMIDE_PLUGIN_DIR`, `~/Library/Application Support/llm-ide/plugins`, `LLM IDE/plugins`. Manifest model `:104`. |
| Code notes and graph.json 1.1 | `Features/CodeGraph/Notes/CodeNoteGenerator.swift` (372), `CodeNoteService.swift` (184), `AnalyzePhase.swift` (57), `BatchPlanner.swift` (65), `CodeNoteError.swift` (41) | 719 | Writes `system/graph/index.md`, per-file notes, and `graph.json` v1.1 (`writeGraphJSON` `:247-292`). No positions in this file. |
| Core: repo locator | `Core/Repo/RepoGraphLocator.swift` | 49 | `repoToGraph` and `reposToGraph` (`:39`). Used by AutoTask. |
| Core: rescan contract | `Core/Contracts/GraphRescanning.swift` | 22 | `GraphRescanOutcome` and `rescan(repoRoot:)` (`:20-21`). |
| Core: project graph provider | `Core/Contracts/ProjectGraphProviding.swift` | 39 | `ProjectGraphRegistry` (`:20`), installed by Shell at `FeatureCatalog.swift:314`. |
| Core: wire mirror | `Core/Project/ProjectGraphFile.swift` | 278 | Core-owned Codable mirror of `GraphDocument`. The file's header says Core must not import GraphCore (`:6-11`). v1.1 decode `graph(fromJSON:)` `:164`. |
| System bridge | `Features/System/Services/SystemBridge.swift` | 676 | `projectGraph` native call (`:52-53`), reply `projectGraphReply` (`:372`), encode failure `500 graph_encode_failed` (`:390`). |
| System web view | `Features/System/Views/SystemWebView.swift` | 380 | Provider (`:278-292`) gives the page the cached graph, or `ProjectGraphFile` when none is cached. |
| System host | `Features/System/Views/SystemView.swift` | 34 | Hosts the bundled `os-view` page (`ui/os-view`). |
| Graph section | `Shell/GraphSectionView.swift` | 78 | Switches the Graph section between the System page and the code graph (`:72`). |
| Loop: graph reader | `Features/Loop/Models/GraphIndex.swift` | 60 | Reads `system/graph/graph.json` (`:55`). Own Codable, so Loop does not import CodeGraph (`:2-5`). |
| Loop: graph report and quadrant | `Features/Loop/Models/GraphReport.swift` (242), `CodeQuadrant.swift` (31) | 273 | |
| Loop: graph stage | `Features/Loop/Services/LoopEngineRunner+CodeGraph.swift` | 607 | Snapshot and verify stages. Rescan through `GraphRescanning`; with no rescanner it logs "using the existing graph.json" (`:47-50`). |
| Loop: test map | `Features/Loop/Services/TestMapBuilder.swift` (174), `LoopEngineRunner+TestMap.swift` (447) | 621 | Reads `graph.json` (`TestMapBuilder.swift:22`). |
| Loop: stage kinds | `Features/Loop/Models/LoopStage.swift` (`case codeGraph` `:69`, `graphOp` `:159`), `LoopTemplate.swift:338,372` | | Two built-in "Refactor Graph" stages. |
| AutoTask: knowledge task | `Features/AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift:715-745` | | Skipped when `code_graph_3d` is not compiled (`:726-728`). Resolves the repo through `RepoGraphLocator` (`:731`) and summarises `graph.json` (`:737-743`). |
| Feature key | `Core/FeatureToggles/AppFeature.swift` | | `codeGraph3D = "code_graph_3d"` (`:6`), title `:19`, requires `fileExplorer` (`:31`), excludable list `:64`. |
| Shell wiring | `Shell/FeatureCatalog.swift` | | `#if !FEATURE_GRAPH` removes the feature (`:14-15`). `bootGraph` `:40-66`, environment `:70-76`, the Graph pane `:85-88`, engine cache invalidation `:99-101`, the Settings card `:152-156`, the feature seams `:279`, `ProjectGraphRegistry` install `:314-320`, rescanner `:837-849`. |
| Cache hook | `Core/Platform/FeatureCacheHooks.swift:25`; `Core/Networking/API/LlmIdeAPIClient+Auth.swift:165,184` | | Drops the resolved engine after a plugin is installed or removed. |

### 2c. Server (`extension/`)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Graph memory and retrieval | `extension/graphkit/` (`graph.mjs` 444, `memory.mjs` 544, `memory-writer.mjs` 343, `paths.mjs` 63, `index.mjs` 26, `README.md`) | 1 420 (`.mjs`) | `findRelatedCode` (`graph.mjs:67`), `findGraphContext` (`:79`), `searchCodeIndex` (`:263`), `findRelatedSymbols` (`:429`), `renderGraphifyMemory` (`memory.mjs:501`), chat memory writer (`memory-writer.mjs:203,278`). Layering: L3, may import core, kb and providers (`eslint.config.mjs:149-150`). |
| Code-graph store | `extension/kb/code-graph.mjs` | 540 | `writeCodeGraph` (`:109`), `clearCodeGraph` (`:167`), `deleteScipSources` (`:189`), `expandSymbols` (`:201`), `graphNeighbors` (`:243`), `searchCodeSymbols` (`:339`). Layer kb (L1): no kb module imports graphkit (`eslint.config.mjs:144`). |
| Code-graph route | `extension/routes/code-graph.mjs` | 46 | `POST /kb/ingest-code-graph` (`:21`). 400 validation, 403 `PATH_NOT_APPROVED` for a repo not on the allow-list, 200 result. |
| Structure ingest | `extension/connectors/structure-graph.mjs` | 129 | `MAX_NODES_PER_REQUEST` = 5 000 (`:30`), `ingestStructureGraph` (`:92`). |
| SCIP ingest | `extension/connectors/scip.mjs` (67), `scip-scanner.mjs` (174) | 241 | `indexScip` (`scip.mjs:17`). Behind always-on `POST /kb/ingest-scip` (`routes/router.mjs:503-525`). No client in the repo (§2d). |
| Feature route group | `extension/routes/feature-routes.mjs` | 126 | Group `code_graph_3d`: prefix `/kb/ingest-code-graph`, loader `./code-graph.mjs` (`:27-32`). Header policy (`:1-20`). |
| Agent grounding | `extension/agents/planner.mjs` (163), `agents/code-sync.mjs` (24) | 187 | Planner imports `findGraphContext` (`:9`, used `:147`). Code-sync imports `findRelatedCode` and `findRelatedSymbols` (`:9`) and calls them (`:13-22`). `POST /kb/code-sync` (`routes/planning.mjs:84`). |
| Agent tools | `extension/llm_agent/` (9 files reference `graphkit`, `code-graph` or `scip`) | | `runtime/handlers/find-code.mjs`, `project-memory.mjs`, `repo-files.mjs`, `runtime/route.mjs`, `runtime/memory-extract.mjs`, `runtime/memory-persist.mjs`, `runtime/session-memory-select.mjs`, `sdk/engine.mjs`, `internal/context/compose.mjs`. These are grep matches; the list is not audited line by line. |
| Feature status | `extension/kb/os-state.mjs:33` (kit row `graph-kit`, feature `code_graph_3d`), `:165` (reads `code_graph_meta` freshness) | | The os-kit aggregate reads a graph-kit table directly (§3 edge G9). |
| Migrations | `extension/kb/migrations/0025_scip_code_graph.sql` (`code_graph_nodes`, `code_graph_edges`), `0026_plan_tasks_symbols.sql`, `0027_code_graph_source.sql` (`source` = `scip` or `structure`), `0036_code_graph_meta.sql` (`code_graph_meta`) | | |
| Server version and endpoints | `extension/server.mjs:281` (`SERVER_API_VERSION = 82`), `:317-318` (`ALL_ENDPOINTS` entries for both ingest routes), `:354` (`/kb/code-sync`) | | |
| Plan of server layering | `extension/eslint.config.mjs:144-155` | | The layering table the ESLint ratchet enforces. |

### 2d. Contract and wire

| Contract | Where | What it covers | Evidence |
|---|---|---|---|
| Canonical `GraphDocument` v1 | `gk/schema/graph.schema.json`, `gk/schema/SCHEMA.md`; Swift `GraphDocument.swift`; TypeScript `typescript/src/models.ts` | Envelope with `schemaVersion`, `nodes`, `edges`, `layers`, `tour` | Schema fixtures validated in CI (`gk/.github/workflows/ci.yml:38-49`). |
| Kind sets | Swift `CodeGraphModels.swift:4-14, 99-110`; TypeScript `models.ts:11-27` | 34 node kinds and 37 edge kinds | Compared on 2026-10-28: the Swift and TypeScript sets are identical (34 and 37). |
| `graph.json` v1.1 | Writer `CodeNoteGenerator.swift:247-292`; readers `Features/Loop/Models/GraphIndex.swift:55`, `TestMapBuilder.swift:22`, `AutoCodeUpdateService+PipelineTasks.swift:737`, `ProjectGraphFile.swift:164` | Per-file adjacency (`files[]` with `imports`, `usedBy`, `types`, `functions`, `role`), `calls[]`, `summary`. Version string `"1.1"`. Readers accept 1.0 (`GraphIndex.swift:4-5`). | No schema file for it under `schema/` (D10). |
| Rust VizGraph and OrbitLayout | `gk/rust/os-graph/src/viz.rs:62-68` (`VizGraph`), `orbit.rs:55-61` (`OrbitLayout`); TypeScript `gk/typescript/src/system/types.ts:248-288` | The OS view's graph and layout. Not a `GraphDocument`. | Goldens: `tests/golden/*.json` (19) and `tests/golden/viz/*.json` (4). |
| Rust `CGNode`, `CGEdge` | `gk/rust/os-graph/src/models.rs:32-70` | Lenient: `kind` is a free string, `title` optional, `metadata` a map. | Accepts any kind; Swift rejects an unknown one (D11). |
| Engine plugin manifest | `gk/graph-engine.json`; Swift `GraphEngineLocator.swift:104-140` | `schemaVersion` 1, three commands with placeholders (`{repo}`, `{out}`, `{code}`, `{doc}`, `{chunks}`, `{root}`) | `GraphEngineLocator.swift:173` validates. |
| Engine protocol | `Features/CodeGraph/Engine/GraphEngine.swift:16-58` | `scanCode`, `scanCodeWithCitations`, `generateDocMemory` (roots or files), `merge`, `docSetFingerprint` | Swift only; the plugin engine implements it through subprocesses. |
| HTTP: `POST /kb/ingest-code-graph` | Route `routes/code-graph.mjs:21`; group `live-loop-misc` in `schema/http/live-loop-misc.schema.json` (row describes the code-graph upload, `:2`) | Body `repoPath`, `graph` (GraphDocument-like), `replace`, `commitSha`, `generatedAt`. | 5 fixtures: `schema/http/fixtures/live-loop-misc/post-kb-ingest-code-graph-{200,400,401,403,404}.json`. `schema/http/INVENTORY.md:44,124`. Client `LlmIdeAPIClient+CodeGraph.swift`. TypeScript type `extension/src/lib/api-types.ts:3483-3488`. |
| HTTP: `POST /kb/ingest-scip` | `routes/router.mjs:503-525`; `schema/http/INVENTORY.md:55,123` | SCIP index path | No Mac or extension caller ("tests only"). 3 fixtures in `schema/http/fixtures/kb-sources/`. |
| HTTP: `POST /kb/code-sync` | `routes/planning.mjs:84`; `INVENTORY.md:59,160` | Grounds plan tasks in files and symbols | "tests only" caller. 5 fixtures in `schema/http/fixtures/planning/`. |
| Native bridge: `projectGraph` | `Features/System/Services/SystemBridge.swift:52-53,366-391`; `ui/os-view/src/bridge.ts` (header contract) | The cached project graph as canonical `GraphDocument` JSON, or `200 null` | `ProjectGraphDocument` (`ProjectGraphFile.swift:12-64`) mirrors the shape without importing GraphCore. |
| Layout output | `GraphLayout`, `GraphLayoutEngine.swift:57-91` | In-process value. Not a wire format. Not persisted (§5). | |

Relations. `GraphDocument` and `CGData` are the same content with a version envelope (`GraphDocument.swift:18-41`). `graph.json` 1.1 is a different shape (per-file, no edges list) and is converted to a `ProjectGraphDocument` only for the System page (`ProjectGraphFile.swift:164`). `VizGraph` is a summary model built by Rust, not a graph. Three JSON shapes therefore carry "the code graph" to three consumers, and none of them converts to the layout's input (`CGData`) except the canonical one.

### 2e. Feature key `code_graph_3d`

What the key removes, and what it does not.

| Surface | With `code_graph_3d` off | Evidence |
|---|---|---|
| Key definition and closure | Requires `file_explorer` (`AppFeature.swift:31`). Turning `file_explorer` off drops the key too (`mac/Package.swift:30`). | `mac/Package.swift:25,30-32`; `scripts/feature-matrix.mjs:66,69` |
| Compile of the Graph folder | `Features/CodeGraph` is excluded from `libExcludes` and the FEATURE_GRAPH define is not set (`mac/Package.swift:48-51`). The test files are excluded (`:52-61`). GraphCore and GraphKit are not linked (`:311-313`). | `mac/Package.swift` |
| Sealed feature | CodeGraph is one of the 15 sealed features (`mac/Scripts/feature-map.txt:27`). `feature-gates` passes on 2026-10-28. | `make feature-gates` |
| Graph section and Graph pane | Not compiled. Shell returns an identity environment and an empty pane (`FeatureCatalog.swift:69-76`, `:85-88`). | `FeatureCatalog.swift` |
| Server ingest route | `POST /kb/ingest-code-graph` answers 404 `feature_disabled` (`routes/feature-routes.mjs:27-32`). | Contract row in §2d. |
| Server graph modules | Still loaded. `graphkit` is always loaded for the planner (`feature-routes.mjs:28`). Find-code, project memory and code-sync keep working without the key. | `feature-routes.mjs:28`; `agents/planner.mjs:9` |
| AutoTask knowledge task | Skipped with a message (`AutoCodeUpdateService+PipelineTasks.swift:726-728`). | |
| Loop graph stages | **Not removed.** Loop is excluded only with `auto_tasks` (`mac/Package.swift:126`). With the key off, Loop reads an existing `graph.json` and logs that it could not rescan (`LoopEngineRunner+CodeGraph.swift:47-50`). | |
| System page | **Not removed.** The System page's project graph uses the Core provider when it is installed (`FeatureCatalog.swift:314`) and otherwise falls back to `ProjectGraphFile` (`SystemWebView.swift:290-291`). The Rust OS view does not depend on the key. | |
| Settings card | Not compiled (`FeatureCatalog.swift:152-156`). | |

### 2f. Tests and gates

Run on 2026-10-28 on this Mac, with the sandbox disabled for Swift and Cargo.

| Gate or suite | Command | Scope | Count | Result |
|---|---|---|---|---|
| Layout gate | `make graph-gates` (runs `swift run -c release graph-layout-lab`) | Louvain reference values, Barnes-Hut against exact N², six layout scenes against invariants | 22 `check(` call sites in `GraphLayoutLab/main.swift` | PASS |
| Engine gate | same target (`graph-engine-lab`) | MemoryGenerator, DocSetFingerprint, GraphMerger, citations, edge-weight thresholds | 43 `check(` call sites; 49 ✔ lines printed | PASS |
| Parity of the doc track | same target (`conformance-memory.mjs`) | Swift and TypeScript doc track and merge over one corpus | 26 nodes, 16 edges; merged 39 nodes, 41 edges; all identical | PASS |
| Layout gate timing | (inside the run above) | Wall time for `make graph-gates` with a warm release build | 10.2 s wall; the layout lab's own cases are in §6.4 | |
| graph-kit package | `cd gk && swift test` | `GraphKitTests` | 81 XCTest, 0 failures, 14.9 s wall | PASS |
| Mac, graph-related suites | `LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter 'CodeGraph\|KnowledgeGraph\|GraphAutoUpdater\|GraphReport\|GraphIndex\|CodeNote\|TestMapBuilder\|LoopGraphRescanner\|LoopStageCodeGraph\|GraphDocumentWire\|IssuesGanttGraphFixes\|SystemBridge\|LoopEngineRunnerTests\|ShellStateGraph'` | Union of the filter (includes some non-graph suites) | 355 tests, 0 failures, 20 s test time | PASS |
| Mac, dedicated graph suites | (grep, not a run) | `CodeGraphUploadServiceTests` 25, `KnowledgeGraphServiceTests` 21, `GraphReportTests` 12, `GraphAutoUpdaterRepoResolutionTests` 9, `KnowledgeGraphEndToEndTests` 6, `LoopStageCodeGraphKindTests` 6, `CodeGraphCitationUploadTests` 4, `LoopGraphRescannerTests` 4, `CodeNotePruneTests` 3, `CodeNoteGeneratorKindsTests` 3, `CodeNoteGeneratorCallsTests` 3, `GraphIndexCallsTests` 2, `CodeNoteServiceSupersedeTests` 2 | 100 | Not run separately |
| Mac, layout coverage | (grep) | Layout functions referenced by any XCTest | 1 test file (`GraphAutoUpdaterRepoResolutionTests.swift:100,134-135`): a topology build and a determinism check | |
| Extension, graph subset | `node --test` on 29 files (`code-graph-*`, `scip-*`, `graphify-memory-*`, `find-code*`, `feature-routes`, `feature-matrix`, `kb-router-code-graph`, `kb-router-scip`, `graphkit-rollup`, `os-state`, `retrieval-golden`, `memory-roundtrip-e2e` and others) | Server graph and memory paths | 290 `test(`/`it(` lines; runner 293 tests | 293 pass, 0 fail (13.9 s) |
| Rust crate | `cd gk/rust && rustup run stable cargo test --release` | Unit tests and golden parity | 102 unit, 2 parity pass; 2 ignored writers | PASS. Not run by any CI (D8). |
| Rust WASM reproducibility | `gk/scripts/build-os-wasm.sh --check` | Committed `.wasm` and glue equal a fresh build with the local rustc | | "match a fresh build" |
| Web package | `cd gk/web && npm test` | System page core, WASM wrapper, orbit controls, code nodes | 310 tests (node runner), 0 fail (1.8 s) | PASS. Not run by any CI (D8). |
| TypeScript package | `cd gk/typescript && npm test` | Scanners, merger, memory generator, CLI SCIP e2e | 70 tests (runner), 0 fail | PASS. Run by graph-kit CI. |
| System page bundle | `make os-view-check` | The committed System page bundle equals a fresh build | | "os-view-check: ok" |
| Feature boundaries | `make feature-gates` | Sealed features, Core as leaf, Shell names | | PASS (no violations) |

## 3. Cross-kit edges

Legend. **C** is a contract (a Core seam, an HTTP route or a file format). **D** is a direct type or module reference. **✗** breaks the K0 rule (edges go through Core contracts or HTTP). Server in-process imports that follow the ESLint table are legal (docs-kit decision 9).

| # | From to To | Mechanism | Status | Evidence |
|---|---|---|---|---|
| G1 | CodeGraph to Core (repo locator, rescan, project provider, cache hook) | C (Core types) | ok | `Core/Repo/RepoGraphLocator.swift`, `Core/Contracts/GraphRescanning.swift`, `Core/Contracts/ProjectGraphProviding.swift` |
| G2 | Core to CodeGraph | none | ok. `ProjectGraphFile` mirrors the wire shape without importing GraphCore (`:6-11`). | `Core/Project/ProjectGraphFile.swift:6-11` |
| G3 | Shell to CodeGraph | D (names the types under `#if FEATURE_GRAPH`) | legal. Shell names every feature. | `Shell/FeatureCatalog.swift:40-66, 152-156, 314-320, 837-849` |
| G4 | Loop to the `graph.json` file | C (file format, own Codable) | ok | `Features/Loop/Models/GraphIndex.swift:2-5, 55` |
| G5 | Loop to the rescanner | C (`GraphRescanning`) | ok | `Features/Loop/Services/LoopRunService.swift:61`, `LoopRunnerProvider.swift:17` |
| G6 | AutoTask to repo locator and to `graph.json` | C (Core) and file | ok | `AutoCodeUpdateService+PipelineTasks.swift:726-743` |
| G7 | System page to the project graph | C (`ProjectGraphRegistry`, `ProjectGraphFile`) | ok | `Features/System/Views/SystemWebView.swift:278-292` |
| G8 | System page source (`ui/os-view`) to graph-kit `web/src` | D (source alias at build time) | **✗ under K0**: the os-kit page imports graph-kit's source across a repository boundary | `ui/os-view/vite.config.ts:15-16,40`; `ui/os-view/src/main.tsx:2` |
| G9 | os-kit server (`kb/os-state.mjs`) to the code-graph table | D (SQL read of a graph-kit table, no route) | **✗ under K0** | `extension/kb/os-state.mjs:33,165` |
| G10 | Settings to CodeGraph | C (`SettingsSectionRegistry`, registered by Shell) | ok | `Shell/FeatureCatalog.swift:152-156` |
| G11 | Chat, Explorer, Issues, Live, Library to CodeGraph | none | ok. Grep finds no references outside the folder except the comments in `Core/Memory/GraphMemoryState.swift:7,30`. | |
| G12 | Server agents and tools to `graphkit` | D (in-process import, server layering) | legal (ESLint table, `eslint.config.mjs:144-155`) | `agents/planner.mjs:9`, `agents/code-sync.mjs:9`, `llm_agent/` (9 files) |
| G13 | Server `kb` to `graphkit` | none | ok. The ESLint table forbids it; no `kb` module imports `graphkit` (the one match, `kb/session-memory.mjs:3,75`, is a comment). | `eslint.config.mjs:144` |
| G14 | Extension (Chrome) to the code graph | C (HTTP) | ok. Only the API types reference the route (`extension/src/lib/api-types.ts:3483-3488`). | |
| G15 | Plugin engine to the app | C (manifest and JSON file) | ok | `gk/graph-engine.json`, `PluginGraphEngine.swift:175-240` |
| G16 | graph-kit `web` OS view to the `OsHost` implementation | C (interface implemented by the host) | ok | `ui/os-view/src/hosts.ts`, `gk/web/src/host.ts` |

**Cycles.** None found. The Swift feature graph has no edge into CodeGraph except from Shell (G3). The server has no kb to graphkit edge (G13). The web side has a build-time cycle of source only: `gk/web` is consumed by `ui/os-view`, and the host interface is implemented in `ui/os-view` (G8, G16). That is not a runtime cycle, but it is a repository-level coupling that the K0 rule should fix (decision Q2).

**Repository coupling for pins.** graph-kit is a separate repository, and it stays one (user decision, 2026-10-28), so that other consumers can reuse it. A change lands in graph-kit first. Then `make graphkit-bump` pushes it and moves the three pins: the submodule gitlink, the `revision:` in `mac/Package.swift`, and the entry in `mac/Package.resolved`. `mac-ci.yml:280-287` enforces that the gitlink and the `revision:` match, and `make graphkit-pin-check` enforces all three and, with `ONLINE=1`, that the pinned commit exists on the remote. The System page additionally needs `ui/os-view` rebuilt and its bundle committed (`make os-view`, checked by `os-view-check`; the bump does both). The steps are in [`docs/how-to/graph-kit-workflow.md`](../how-to/graph-kit-workflow.md).

## 4. Delegated vs owned

Rule (plan): does the piece get better on its own when the model or SDK improves? If yes, it is delegated (a thin adapter). If it is project control or data the model cannot know, it is owned.

| Piece | Label | Reason |
|---|---|---|
| Code parsing (tree-sitter script, `FileStructureExtractor`, `tsScanner`, SCIP indexers) | Delegated to the parser | Parsers improve in their own projects. We keep the adapter and the mapping. |
| Mapping from parser output to the canonical kinds and edges (`StructureGraphBuilder`, `scip.mjs`, `tsScanner.ts`) | Owned | The contract is ours; it must not change with a parser release. |
| Doc memory chunking and wiki-link, mention and related-modules linking (`MemoryGenerator`, `GraphMerger`, `DocCodeLinker`) | Owned | Deterministic rules under a cross-language conformance gate (`conformance-memory.mjs`). A model would make them nondeterministic. |
| **Layout kernel**: `GraphTopology`, `CommunityDetection`, `ForceDirectedLayout`, `SpatialTree`, `LayoutQuality`, `GraphLayoutEngine` (§6) | Owned | The picture is product behaviour. No model or SDK release makes a force layout better; the algorithm is fixed math with tuned constants. Determinism is a stated requirement (`GraphLayoutEngine.swift:101-103`). |
| `EdgeWeight` table and thresholds (`EdgeWeight.swift:27-112`) | Owned | Policy: which relations count as structure. Changes need a product decision, not a model upgrade. |
| `CGSimulation3D` (`CGSimulation3D.swift`) | Owned, but a retire candidate (§9 Q4) | Duplicates the 2D engine's job in 3D with different constants. |
| OS view orbit layout and label propagation (`rust/os-graph`) | Owned, retire candidate for the community part (§10, D7) | Replaces nothing a model does; a second community algorithm. |
| Chat memory extraction (`llm_agent/runtime/memory-extract.mjs`, "one short, capped LLM call on a summarize-tier model") | Delegated (the extraction) | Model work. Storage format and dedup (`memory-writer.mjs`) are owned. |
| Plugin engines (`graph-engine.json` implementations) | Delegated implementation, owned contract | An external engine can be replaced by a plugin; the contract (`GraphDocument`, manifest) is ours. |
| On-disk graph artefacts (`system/graph/`, `system/memory/`, `graph.json` 1.1) | Owned | Persistence and N-1 readability (§5). |
| Server SQLite code-graph tables and queries (`kb/code-graph.mjs`) | Owned | Tenancy (`user_id`, repo scope), freshness, and the allow-list. |
| Upload batching and cap (`CodeGraphUploadService.swift:45-50`) | Owned | Transport limits of our server. |
| Repo allow-list 403 (`routes/code-graph.mjs:30-31`) | Owned | Permission. |
| SwiftUI views (`Features/CodeGraph/Views/`, 3 161 lines) | Owned UI | Replaced at K3 (WebGL view, §8). |
| Three.js OS view (`gk/web/src/orbit/`) | Owned UI | Already the K3 renderer for the OS view. |
| SceneKit 3D view (`Graph3DView.swift`) | Owned UI | Candidate for removal once the WebGL view covers it (§9 Q4). |

## 5. State and data (feeds K1a)

Paths are relative to a repository root (`<repo>`) unless stated.

| State | Path and key | Format and version | Writer | Reader | Persisted | N-1 readable |
|---|---|---|---|---|---|---|
| Code graph, file level | `<repo>/system/graph/graph.json` | JSON, `version` `"1.1"` (`CodeNoteGenerator.swift:260,278`) | `CodeNoteGenerator.writeGraphJSON` (`:247-292`) | `GraphIndex.swift:55`; `TestMapBuilder.swift:22`; `PipelineTasks.swift:737`; `ProjectGraphFile.swift:164` | Yes | 1.0 and 1.1 readable (`GraphIndex.swift:4-5`) |
| Code notes | `<repo>/system/graph/index.md`, `<repo>/system/graph/<path>.md` | Markdown | `CodeNoteGenerator` | `paths.mjs:51-52` (server reads `index.md`) | Yes | n/a |
| Memory notes | `<repo>/system/memory/graph-notes.md`, `doc-notes.md`, `chat-memory.md` | Markdown (`paths.mjs:8-15`) | App generation; `memory-writer.mjs` (chat) | `memory.mjs` `renderGraphifyMemory` (`:501`) | Yes | Legacy `graphify-out/memory/` is read when the canonical file is absent (`paths.mjs:46-48`) |
| Positioned graph (session cache) | In memory: `GraphSessionStore`, keyed `repoPath#mode`, at most 4 repos | Swift `CGData` with `positions` | `UAGraphView.cacheGraph` (`:236`) | `hydrateFromStore` (`:247`) | No (process lifetime) | n/a |
| Layout signals and positions | Not stored. `GraphLayout` is recomputed on each layout or recovered by `signals` on hydrate (`GraphLayoutEngine.swift:192-200`) | In-process struct | `GraphLayoutEngine` | `CodeGraphCanvas`, `UAGraphView` | No | n/a |
| Plugin engine output | Temporary workspace `graph.json` (`PluginGraphEngine.swift:183`) | `GraphDocument` v1 | Plugin command | `PluginGraphEngine` decode | Temporary | Decode rejects a newer `schemaVersion` (`GraphDocument.swift:53-59`) |
| Plugin manifests | `~/Library/Application Support/llm-ide/plugins/<plugin>/graph-engine.json` (or `LLMIDE_PLUGIN_DIR`) | JSON `schemaVersion` 1 | Installer | `GraphEngineLocator.swift:30-73` | Yes | |
| Canonical graph on the native bridge | `ProjectGraphRegistry` bytes to `SystemBridge` (`SystemBridge.swift:366-391`) | `GraphDocument` v1 JSON | Feature provider (`FeatureCatalog.swift:314-320`) | os-view page | No | Capped at `ProjectGraphCap` before send (`SystemBridge.swift:383`) |
| Server code graph | SQLite `code_graph_nodes`, `code_graph_edges` (`0025`, `source` column from `0027`), `code_graph_meta` (`0036`) | Rows scoped by `user_id` and `repo_id` | `kb/code-graph.mjs:109` (`writeCodeGraph`) | `kb/code-graph.mjs:201-395`; planner; code-sync; `kb/os-state.mjs:165` | Yes | Migration tests exist (`extension/tests/code-graph-migration.test.mjs`) |
| SCIP import | Input file at a client path (`scipPath`) | SCIP index (protobuf-derived JSON) | Client | `connectors/scip.mjs:17` | Rows only | Tests only |
| Upload batches | HTTP body, not stored by the app | `{repoPath, graph, replace, commitSha, generatedAt}` | `CodeGraphUploadService` (`:129`) | `routes/code-graph.mjs:21-44` | Server rows | `replace` on the first batch only |
| Memory artefacts | Inside `GraphDocument` as `memoryDoc` and `memoryChunk` nodes | `MemoryChunk` (`MemoryChunk.swift`) | `MemoryGenerator` | `MemoryArtifactRenderer` | With the graph | |
| Rust OS-view outputs | Not stored; the WASM bytes are committed in `gk/web/src/wasm/bytes.ts` | `SystemGraph`, `OrbitLayout` JSON | Rust core | `systemGraph.ts` | No | |

**What this means for K1a.** Layout output is never persisted (the cache is in memory, and `graph.json` 1.1 has no position field; `CodeNoteGenerator.swift:247-278`). A layout port therefore has no data migration. The contract to keep is `GraphDocument` v1, which is unchanged by a layout route if positions stay optional (`CodeGraphModels.swift:149`). The rollback path is the preference: old apps keep the Swift path, and new servers answer old clients unchanged (the route is additive, §8.3).

The state that does need N-1 care is the file-level `graph.json` 1.1 and the SQLite tables. Neither is touched by a layout port.

## 6. Layout engine inventory

### 6.1 Pipeline

`GraphLayoutEngine.layout(data, options)` (`GraphLayoutEngine.swift:108-190`):

1. `GraphTopology(data, minWeight:)` (`GraphTopology.swift:55-150`). Keeps the first occurrence of each node id. Drops self-loops (`:89`). Keeps edges whose `EdgeWeight.weight(of:)` is at least `minWeight` (default 0.30, `EdgeWeight.swift:112`). Collapses parallel pairs into one link with weight `min(1, peak + 0.15 × others)` (`:135`). Builds sorted neighbour lists (`:146`).
2. `topology.pageRank()` (`GraphTopology.swift:158-190`). Damping 0.85, 40 iterations, dangling mass spread uniformly, result normalised so the peak is 1.0.
3. `CommunityDetection.louvain(topology, resolution:)` (`CommunityDetection.swift:55-99`). Hierarchical edges (`contains`, `containsFlow`) count 1.6 times in the community phase (`:68`). Up to 10 levels; up to 20 sweeps per level (`:114`); a move needs a gain above the best by more than 1e-12 (`:136`); candidate communities are sorted (`:132`).
4. `groups` sorted largest first (`CommunityDetection.swift:200-207`).
5. Radius `minR + (maxR − minR) × sqrt(PageRank)` and mass `1 + sqrt(weightedDegree)` (`GraphLayoutEngine.swift:122-131`).
6. `clusterAnchors`: one anchor per cluster, packed along a golden-angle spiral with a grid for overlap tests, largest first (`GraphLayoutEngine.swift:288-381`).
7. `seedPositions`: phyllotaxis (sunflower) around each anchor (`:391-412`).
8. `ForceDirectedLayout.run` (`ForceDirectedLayout.swift:71-192`): geometric cooling of `alpha` to `alphaMin`; Barnes-Hut repulsion through `SpatialTree`; degree-normalised springs with a damped inter-community pull; cluster gravity to the anchor; velocity clamp of 60 per tick; collision passes from `alpha < 0.35`; four final collision passes.
9. Package outputs. `edgeWeight` is stored in both orientations (`GraphLayoutEngine.swift:170-171`). `LayoutQuality.measure` runs when `measureQuality` is true (`:174-177`), which is the default (`:21`).

`signals(of:)` (`GraphLayoutEngine.swift:203-261`) runs steps 1 to 5 and the quality measure, and reuses cached positions. It is the path used when a positioned graph is restored.

`applying(_:to:)` (`:266-274`) writes the positions back into a `CGData`.

Options and tiers (`GraphLayoutOptions`, `GraphLayoutEngine.swift:5-47`):

| Nodes | Iterations | Min and max radius | Source |
|---|---|---|---|
| under 200 | 400 | 5 and 26 | `:30-31` |
| under 800 | 320 | 5 and 26 | `:32-33` |
| under 2 500 | 240 | 5 and 22 | `:34-36` |
| under 8 000 | 170 | 4 and 18 | `:37-40` |
| 8 000 and above | 120 | 3 and 14 | `:41-44` |

Other defaults: `minWeight` 0.30, `clusterResolution` 1.0, `clusterSpacing` 1.28, `measureQuality` true (`:9-21`).

### 6.2 File inventory

Every file in `gk/Sources/GraphCore/Layout/`. Sizes are `wc -l`. Algorithm facts are from the cited lines.

| File (lines) | Public API | Inputs and outputs | Algorithm, constants and numerics | Complexity |
|---|---|---|---|---|
| `GraphLayoutEngine.swift` (427) | `GraphLayoutOptions` (`:5-48`), `GraphLayout` (`:57-91`), `GraphLayoutEngine.layout` (`:108`), `signals` (`:203`), `applying` (`:266`), `edgeKey` (`:83`) | `CGData` to `GraphLayout` (positions as `CGPoint`, community, importance, radius, degree, inDegree, edgeWeight, bounds, quality) | Steps in §6.1. All arithmetic in `Double` (`CGFloat` is `Double` on 64-bit Apple). Constants: spiral stride `max(radius × 0.55, 18)` (`:347`), spiral step cap 60 000 (`:349`), cluster area `/0.62` packing slack (`:300`), golden angle 2.399963229728653 (`:303`). | Topology and PageRank O(E); Louvain O(E × sweeps × levels); anchors O(groups × probes) with a grid; forces O(iterations × (n log n + E)). |
| `ForceDirectedLayout.swift` (270) | Internal `Config` (`:30-61`), `run` (`:71`), `gridIndex` (`:259`) | Topology, seeds, radii, masses, anchors, community to settled positions | Config: iterations 300, theta 0.9, velocityDecay 0.6, repulsion −190, linkSpacing 46, collisionPasses 2, clusterGravity 0.16, interCommunityScale 0.3, alphaMin 0.001 (`:33-60`). Decay `alphaDecay = 1 − alphaMin^(1/iterations)` (`:112`). Link distance `rim + 46 × (1.65 − weight)` (`:99`). Velocity clamp 60 (`:169`). Coincident separation by a fixed angle `((i × 2654435761 + j) mod 360)` (`:234`). | Per tick O(n log n) repulsion and O(E) springs. |
| `CommunityDetection.swift` (235) | `louvain` (`:55`), `groups` (`:200`), `modularity` (`:212`) | Topology to dense community ids (ordered by lowest member) | Louvain with resolution. Level struct `:23-46`. Local moving `:103-152`, aggregation `:158-182`, renumbering `:188-196`. Modularity is Newman's, roughly −0.5 to 1. | O(E × sweeps × levels). |
| `GraphTopology.swift` (226) | `struct GraphTopology` (`:17`), `init` (`:55`), `pageRank` (`:158`), `components` (`:199`), `componentGroups` (`:219`) | `CGData` and minimum weight to index-space links, degree, weighted degree, in-degree, neighbours | Parallel-edge collapse (`:133-141`). PageRank power iteration with dangling redistribution (`:165-189`). PageRank iterates links in input order (`:180-183`), so floating-point sums depend on the edge order. | O(n + E) per call; PageRank O(40 × E). |
| `SpatialTree.swift` (251) | `struct SpatialTree` (`:23`), `rebuild` (`:60`), `repulsion(on:…)` (`:179`) | Positions and masses to a repulsion delta | Barnes-Hut quadtree in a flat array. Max depth 20, leaf capacity 1 (`:48-53`). Root padded 1.02 (`:71`). Mass floor 1e-4 (`:87`, `:219`). Softening +0.5 in the distance (`:218`). Opening test `size² < θ² × d²` (`:240`). Coincident pairs get an angle from the ordered pair and an opposite sign (`:205-216`). | O(n log n) per tick, expected. |
| `SpatialTreeAudit.swift` (121) | `audit()` (`:30`), `cellIntegrity` (`:55`), `exactRepulsion` (`:95`) | Test-only helpers for the tree | Exact O(n²) sum for comparison. | Test use only. |
| `LayoutQuality.swift` (278) | `struct Report` (`:21-59`), `measure` (`:62`) | Positions, radii, topology, community to a report (ring, overlap, edge CV, modularity, separation, components, largest share, crossing rate) | Radial concentration in 25 bins (`:90-113`). Overlap by grid (`:128-161`). Edge length CV (`:163-177`). Cluster separation as mean nearest-centroid distance over mean spread (`:179-228`). Crossing rate on a fixed stride sample capped at 40 000 (`:231-262`). | O(n + E) plus the sampled pairs. |
| `EdgeWeight.swift` (128) | `enum EdgeWeight`: `base` (`:27-73`), `multiplier` (`:78-84`), `weight` (`:92`), `defaultMinWeight` (`:112`), `isHierarchical` (`:117`); `Double.clamped` (`:122`) | `CGEdge` to weight in [0, 1] | Base table for 37 kinds (contains 1.00 down to similarTo 0.20). Confidence multiplier: EXTRACTED 1.0, INFERRED 0.75, AMBIGUOUS 0.45. Default threshold 0.30. | O(1). |
| `CGSimulation3D.swift` (102) | `final class CGSimulation3D`: `init(data:)` (`:20`), `settle` (`:41`), `positions` (`:52`) | `CGData` to `[String: SIMD3<Float>]` | Fibonacci-sphere start, radius `max(80, 12 √n)` (`:26-33`). Constants: alpha 0.05, kRepulsion 1 500, kAttraction 0.07, rest 90, damping 0.88, maxV 250, centring 0.03 (`:62-67`). Early stop after tick 30 when max speed is below 0.4 (`:45-47`). **Float**. | O(n²) per tick (`:81-91`). |

Notes on the table:

- `CGSimulation3D.swift:4-7` says it "carries over the exact tuning validated for the 2D sim". Its constants and its algorithm (no Barnes-Hut, no communities, no collisions) are different from `ForceDirectedLayout.swift:30-61` (D5).
- `GraphLayoutEngine.swift` also contains the `clusterAnchors` and `seedPositions` helpers (`:288-412`), which are private. They are part of the port even though they are not in a separate file.
- No file in the folder uses `Float` except `CGSimulation3D`. No file uses random numbers, time, threads or `Dispatch`. The only `Dictionary` and `Set` uses are lookups or counts, not iteration that affects output (`GraphLayoutEngine.swift:227`, `LayoutQuality.swift:139`, `GraphTopology.swift:70`). The sorts all use total orders with an explicit tie-break (`CommunityDetection.swift:206`, `GraphTopology.swift:224`).

### 6.3 Callers in the Mac app

| Entry point | Caller (path:line) | Thread | Typical and largest graph | How often | Does the UI wait? |
|---|---|---|---|---|---|
| `GraphLayoutEngine.layout` | `UAGraphView.swift:1696`, from `applyLayout` `:1677`, which is called from: code generate `:534`, hydrate of a raw graph `:280`, data mode `:1500`, all mode `:1607` | `Task.detached(priority: .userInitiated)` (`:1695`) | Not capped before layout. Code path passes the whole stripped graph (`:534`). Largest measured here: 8 100 nodes (lab). The upload cap is 40 000 nodes (`CodeGraphUploadService.swift:50`). Canvas comment: code graph canvas up to 8 000 × 5 600 (`UAGraphView.swift:272`). Doc graph about 700 000 edges at average degree 124 before weighting (`:305-307`). | Per generate, per rescan (watcher and timer), and per navigation when the store holds a raw graph (`:247-293`) | Yes: `status = .running` (spinner). The run cannot be cancelled mid-way; `Task.isCancelled` is checked only after it (`:1697`). |
| `GraphLayoutEngine.signals` | `UAGraphView.swift:1661`, from `adoptLayout` `:1647` (called at `:262`, `:606`, `:1451`) | Detached | Same as above | On every hydrate of a positioned graph | No spinner; the map is applied when it arrives (`:1663-1666`) |
| `GraphLayoutEngine.applying` | `UAGraphView.swift:1707` | Detached | | Once per layout | |
| `LayoutQuality` (through `quality`) | Logged at `UAGraphView.swift:~1716-1722` | Main actor, after the run | | Once per layout | No |
| `CGSimulation3D` | `UAGraphView.swift:1763-1768`; iterations by size at `:1754-1758` (`< 300`: 220; `< 700`: 180; `< 1 200`: 150; else 120) | Detached | Same sizes | Once per mode and node set, when 3D is first shown (`:1243`, `:1749`) | Only the 3D view waits |
| `EdgeWeight.defaultMinWeight`, `EdgeWeight.weight(of:)` | `UAGraphView.swift:347`; `CodeGraphCanvas.swift:379` | Main | Per edge, per recompute | On each display recompute | No |
| Tests | `Tests/LlmIdeMacTests/GraphAutoUpdaterRepoResolutionTests.swift:100` (`GraphTopology`), `:134-135` (`layout` twice and compare) | | | | |

### 6.4 Behaviour pinned by tests and labs

Pinned by `gk/Sources/GraphLayoutLab/main.swift` (the only layout gate). The lab is an executable because the toolchain used to lack XCTest; the Swift package's own XCTest suite has no layout test (0 of 15 files, §2f).

| Pin | Where | Tolerance or bound | Ground truth |
|---|---|---|---|
| Louvain cluster count and modularity for 7 graphs | `main.swift:190-204` (values), `:216-222` (checks) | Q within 0.002; count exact | Published values: two K5 (Q 0.5000, 2 clusters), two K5 plus bridge (0.4524, 2), Zachary karate club (0.4188, 4), ring of 8 K4 (0.7321, 8). Path of 40 (5 clusters, no Q pinned), K12 (1), 20 isolated (20). |
| Louvain ids dense and rerun identical | `main.swift:224-228` | exact | Self-consistency |
| Barnes-Hut structure: every point stored once, root mass conserved, cell budget `4(n + 20) + 1`, centre-of-mass integrity | `main.swift:260-275`, `:298-300` | mass 1e-6, centre 1e-6 | Built from the tree itself |
| θ = 0 equals exact N² | `main.swift:291` | relative L1 < 1e-9 | `SpatialTree.exactRepulsion` |
| θ = 0.9 within tolerance | `main.swift:316` | relative L1 < 6% | Exact sum. Measured: scattered500 0.96%, grid256 0.22% (lab output). |
| Coincident points repel | `main.swift:338-339` | non-zero force | Regression for the old zero-force bug |
| Every node placed; positions finite | `main.swift:411-415` | exact | |
| Determinism of a re-run | `main.swift:419-424` (tolerance `:422`) | 0.001 per coordinate | Tolerance is loose; the algorithm is deterministic, so this should be exact |
| Not a ring | `main.swift:427` | radial concentration < 0.20 | Measured 0.067 to 0.102 |
| Nodes not overlapping | `main.swift:431` | overlap ratio < 0.02 | Measured 0.000 in all cases |
| Graph stays connected (owned cases only) | `main.swift:436` | largest component share > 0.55 | The fragmented case is reported, not failed (same block, `:436-444`) |
| Clusters are real (code cases) | `main.swift:446-449` | modularity > 0.30 | Measured 0.655 to 0.720 on the code cases |
| Clusters separated | `main.swift:455-458` | separation > 1.0 | Measured 2.35 to 3.30 on the code cases |

Measured on this Mac, release build, from the gate run on 2026-10-28 (`GraphLayoutEngine.layout`, which includes quality measurement):

| Case | Nodes | Edges | Clusters | Time |
|---|---|---|---|---|
| code/small | 288 | 463 | 18 | 0.05 s |
| docs/noisy | 540 | 7 253 | 36 | 0.12 s |
| code/medium | 1 568 | 2 587 | 33 | 0.32 s |
| all/merged | 2 108 | 9 975 | 42 | 0.40 s |
| fragmented/900 | 3 600 | 2 700 | 900 | 0.63 s |
| code/large | 8 100 | 13 139 | 57 | 1.11 s |

The real repository graphs were not measured. The search for a real `graph.json` on this machine (repository and Application Support, time-limited) found none, so the sizes above are the lab's synthetic graphs. A K1 spike needs a real graph (`--json <graph.json>` is supported by the lab, `main.swift:70-102`).

The engine gate (`gk/Sources/GraphEngineLab/main.swift`) pins the weight table: documents/EXTRACTED clears the layout threshold, references/INFERRED clears it, relatedTo stays below it at any confidence, and a title-match weighs 0.108 (`:370-382`). These are the only numeric checks on `EdgeWeight`; the Swift XCTest suite does not check weights except in `GraphAutoUpdaterRepoResolutionTests.swift:115-118`.

### 6.5 Two layout families in the repository

| Aspect | Mac Graph view (Swift) | System page (Rust, WASM) |
|---|---|---|
| Community detection | Louvain with hierarchical boost (`CommunityDetection.swift:68`) | Label propagation, `label_propagate` (`gk/rust/os-graph/src/builder.rs:254`), ids by size rank |
| Node importance | PageRank (`GraphTopology.swift:158`) | None; degree-based size |
| 2D or 3D layout | 2D force layout (`ForceDirectedLayout`) and, separately, a 3D force sim (`CGSimulation3D`) | 3D orbit layout (`gk/rust/os-graph/src/orbit.rs:145`): deterministic, mulberry32 seed, golden-spiral community centres, relaxation |
| Caps | None before layout | Core nodes capped at 4 000 (`gk/web/src/systemGraph.ts:36`) |
| Seed | Golden-angle anchors and phyllotaxis (`GraphLayoutEngine.swift:288-412`) | Fixed `LAYOUT_SEED = 1` (`systemGraph.ts:39`) |
| Tests | Labs only (§6.4) | 102 unit tests, goldens, parity to 1e-9 (`gk/rust/README.md`, Status) |
| Renderer | CoreGraphics canvas and SceneKit | three.js (WebGL) |

The project's code graph therefore has two cluster definitions on two screens. A K1 port that does not also decide this produces a third (D7, decision Q3).

### 6.6 Risks for a port

| Risk | Evidence | Consequence |
|---|---|---|
| Transcendental functions differ between engines | Measured on this Mac, 200 000 samples in ±1 000 (`sin` and `cos`): Swift `-O` matches C `libm` on all samples. Native Rust matches C `libm` on all samples. Node's `Math.sin` and `Math.cos` (V8's own implementation) differ from C `libm` on 9 068 of 200 000 `sin` values and 8 942 of 200 000 `cos` values (about 4.5% each; 17 276 sample lines differ in at least one). | A native Rust port on macOS can be bit-identical to Swift if the operations and order match. A WASM build uses Rust's own `libm` inside the module, which was not measured here; it is expected to differ like V8 does. Position-level parity across that boundary is not bit-exact. |
| Chaos in the force loop | The loop runs 120 to 400 ticks with branches on overlap and on `alpha < 0.35` (`ForceDirectedLayout.swift:185`). A one-ulp difference can change a branch. | Final positions can differ by a lot even when every per-tick formula is right. Parity must be checked on metrics and discrete outputs, not on coordinates (§8.1). |
| Floating-point operation order | Sums in `pageRank` run in edge order (`GraphTopology.swift:180-183`); `louvain` sums in node order. | A port must keep the input order, which the binary contract must preserve. |
| Contraction into fused multiply-add | Not measured. | Verify in the spike that Swift `-O` and the Rust build do not fuse. A bit-compare test on the force loop answers it. |
| Hash of cell keys | `cellKey` uses wrapping multiplication and xor on `Int64` (`GraphLayoutEngine.swift:319`, `ForceDirectedLayout.swift:221-222`). | The port must use wrapping arithmetic. It affects only bucketing, not results, provided the bucket test is exact. |
| `Int64(Double)` traps on NaN | Guarded (`ForceDirectedLayout.swift:259-263`). | Rust `as i64` saturates; keep the guard. |
| Sort stability | Swift `sorted` is not stable; comparators are total (`CommunityDetection.swift:206`). | Rust `sort_by` with the same total comparator gives the same order. |
| No cancellation inside a run | `Task.isCancelled` is checked only after `layout` returns (`UAGraphView.swift:1697`). | A worker or a WASM call cannot be stopped mid-run without terminating it; the port can add a real cancel. |
| Two floating-point types | `CGSimulation3D` is `Float` (`CGSimulation3D.swift:13`); the rest is `Double`. | Port the 2D engine in `Double`. Port `CGSimulation3D` only with the decision in §9 Q4. |

## 7. Port design

### 7.1 Sizes and latency

The canonical JSON costs about 88 bytes per node and 91 bytes per edge (measured on the Rust golden `synthetic_2000_cap500`: 176 906 bytes for 2 000 nodes; 473 077 bytes for 5 176 edges). Real graphs carry longer metadata, so these are lower bounds.

| Graph | Canonical JSON in (estimate) | Compact binary in | Compact binary out | Note |
|---|---|---|---|---|
| 5 000 nodes, 15 000 edges | about 1.8 MB | 0.3 MB | 0.3 MB | Under the 8 MB default body limit (`core/config.mjs:223`). |
| 50 000 nodes, 150 000 edges | about 18 MB | 2.7 MB | 3 MB | **Over the 8 MB limit**; 413 at `core/utils.mjs:42`. |

Compact binary input is 18 bytes per edge: source and target as `u32`, weight as `f64`, kind and confidence as `u8`. Output is 36 bytes per node (x, y, radius as `f64`, community and two counts as `u32`) plus 8 bytes per kept link for edge weights in input order. The binary does not carry node titles; ids stay in Swift, which maps indices back.

Latency. The lab times are in §6.4. Extrapolated from them (not measured):

- 5 000 nodes: about 0.5 to 0.8 s in Swift.
- 50 000 nodes: about 7 to 9 s in Swift, from the 8 100-node measurement scaled roughly by n log n.

The lab's `code/large` case (8 100 nodes) is well below the largest graph the uploader is allowed to send (40 000 nodes, `CodeGraphUploadService.swift:50`), so the 50 000 figure is a planning number, not a measurement.

### 7.2 Options

The options differ in where the kernel runs. The rest of the Mac app is unchanged in every option: Swift keeps the UI and the model.

**Option A. Rust compiled to WASM, run in the Node sidecar in a worker thread, behind `POST /kb/graph/layout`.**

- Mac change: `GraphLayoutEngine.layout` gets a remote implementation behind the preference `graphLayoutUseRust`. The Swift implementation stays for one release. The request is `application/octet-stream` (compact binary, §7.1).
- Server change: a new route in the `code_graph_3d` group (same closure as `/kb/ingest-code-graph`), a worker thread (`worker_threads`) so the event loop is not blocked, `readBody` with an explicit limit (`core/utils.mjs:14` already takes one), `ALL_ENDPOINTS` and `SERVER_API_VERSION` bumped (`server.mjs:281`), contract fixtures, and a WASM build with the `build-os-wasm.sh` pattern (committed bytes, `--check`).
- Size: one more WASM module (estimate 0.3 to 0.6 MB, compared with 0.59 MB today).
- Latency: loopback HTTP and a binary copy (milliseconds), plus compute in WASM. WASM is typically slower than native code. The ratio is not measured.
- Build and CI: no Rust in the Swift build. CI reads the committed bytes. The `--check` step needs the same rustc as the one recorded (`build-os-wasm.sh:22-25`).
- Risk: the Graph view gets a new dependency on the sidecar. It needs a fallback to Swift on error, timeout or no server. A long layout must not hold the sidecar's event loop.
- Parity: metric-level, not bit-exact (§6.6).
- Removal: the preference and the route are deleted; the Swift path is already there.
- Reuse: the same WASM can run in the System page and in a Node sidecar for the Tauri desktop (ADR 0018).

**Option B. Rust compiled to a static library, linked into the Mac app through a binary target.**

- Mac change: `GraphLayoutEngine.layout` calls a C function (flat arrays in and out, no uniffi). The call is synchronous and runs on the existing detached task.
- Build: `cargo build --release` for `aarch64-apple-darwin` and `x86_64-apple-darwin`, `lipo` or an XCFramework, shipped as a `binaryTarget` in graph-kit (a committed binary or a release asset with a checksum). The graph-kit pin and the checksum both change on each release.
- CI: `mac-ci` (macOS 15) would consume the committed artefact. graph-kit's own CI already builds the crate and checks the WASM glue (`--glue-only`); byte-for-byte equality is not reproducible across hosts, so a rebuild-and-diff of the bytes belongs on the platform that built them.
- Signing and notarisation: the code is inside the app binary; no separate signature. Reduced builds: the binary sits in GraphCore's dependency, which is linked only when `code_graph_3d` is on (`mac/Package.swift:311-313`), so the closure is preserved.
- Size: an estimate of 0.5 to 1.5 MB per architecture; the universal binary doubles it.
- Latency: best of the three (native code, no copy beyond the arrays).
- Parity: **bit-exact is plausible**. Native Rust and Swift agree on `sin` and `cos` bit for bit on this machine (§6.6). The operation order must still match.
- Risk: a Rust build on every developer machine that touches graph-kit, binary artefacts in git (history growth), and a second pin (the binary checksum). For one consumer on the Mac this is the heaviest option.
- Removal: delete the binary target. Reversible in one commit.

**Option C. Rust compiled to WASM, run inside JavaScriptCore on the Mac (`JSContext` on a serial background queue).**

- Mac change: a small JS host that instantiates the embedded module (the pattern in `gk/web/src/wasm/bytes.ts`) and passes typed arrays. The Swift side wraps it like option A's client, without a sidecar.
- Feasibility: the system JavaScriptCore reports `WebAssembly.validate` as true (checked with the `jsc` helper on macOS 26.6). Instantiation inside `JSContext` on the minimum deployment target (macOS 13 in `gk/Package.swift:26`) is not checked.
- Latency: WASM speed plus one copy in and one out per call. No cancellation inside the call; a context can be discarded.
- Build and CI: same as option A, minus the sidecar. The bytes are committed.
- Parity: same as A.
- Risk: `JSContext` is not thread-safe, so one context per queue. Memory and a second JavaScript engine in the app. Unverified on macOS 13 to 15.
- Removal: delete the host and the preference.

**Option D. Keep Swift. Share the algorithm specification and golden fixtures, not the runtime.**

- Mac change: none.
- What is built: a specification of the pipeline (§6.1) and the constants (§6.2), a Swift executable that exports golden fixtures (topology, PageRank, communities, radii, anchors, seeds, metrics) for named graphs, and optionally the Rust crate for the System page and the Tauri desktop, tested against the same fixtures.
- Latency and parity: unchanged for the Mac. Two implementations exist if the Rust crate is built; the goldens keep them aligned on discrete outputs and on metrics.
- Risk: drift, unless the goldens run in CI.
- Removal: trivial. Nothing to remove.

### 7.3 Recommendation

**Recommended: option A, decided by a spike, with option D as the fallback.** Two sentences on why and one on the condition.

Why A. It is the pattern the repository already uses for the OS view (the Rust crate, committed WASM, `--check`), so it adds no new toolchain to the Swift build or to CI. It is the smallest change that puts the kernel where the System page and the Node sidecar can both use it. It is removable: a preference and a route. It does not touch the UI, which is what the plan requires.

Why not B for the Mac alone. B is the only option that can be bit-identical with the Swift engine, but the Mac has no measured performance problem for this kernel (1.11 s at 8 100 nodes, a spinner, no reported slowness in the repository), and B makes the Swift build depend on Rust for one consumer. B is the better answer only if the Tauri desktop must link the kernel natively, in which case the same crate is built for both.

Why D is the honest answer if the goal is only the Mac. If the user's goal is the Mac alone, keep Swift (option D), use the goldens to keep the System page's Rust code honest, and do not port the Mac path. The Rust port buys one implementation shared by the server, the web and the desktop. It does not buy Mac speed.

Condition. The spike (§8.2, task 0) must measure: (a) WASM-in-worker latency at 8 000 and 50 000 nodes against the budget in §8.3; (b) parity drift on the lab graphs; (c) the JSContext question (option C) on the minimum macOS version. If (a) fails the budget, choose D for the Mac.

Caveat that applies to A and C. Their positions differ from Swift's at the last-bit level and, after the force loop, possibly visibly. This is acceptable because no positions are persisted (§5), the picture is only required to be stable within one engine (`GraphLayoutEngine.swift:101-103`), and the change happens once, at a release boundary, behind the preference. The user should accept it knowingly (§9 Q5).

### 7.4 Effort

The plan's sizing for graph-kit is 3 to 4 tasks for K0 to K2 and 3 to 4 for K3 and K4 (plan, Size table). The layout alone is 2 038 Swift lines, of which 1 300 to 1 400 are the 2D pipeline. A line-count estimate gives 1 to 2 tasks; the parity and gate work dominates and gives the number below.

| Task | Content | Estimate |
|---|---|---|
| T0 | Spike: WASM-in-worker latency at 8k and 50k; parity drift on lab graphs; JSContext feasibility; FMA check; real-graph timing (needs a real graph.json) | 1 |
| T1 | Golden exporter (Swift executable) and fixture set (lab graphs, a real graph, karate, ring of cliques) | 1 |
| T2 | Rust crate skeleton; topology, EdgeWeight table, PageRank; goldens | 1 |
| T3 | Louvain and modularity; the seven published reference values as Rust tests | 1 |
| T4 | SpatialTree, its audit, exact-sum tests (port the lab's `auditSpatialTree` 1:1) | 1 |
| T5a | Force layout, anchors and seeds, overlap resolution | 1 |
| T5b | `LayoutQuality` and the band tests (port the lab's invariant checks) | 1 |
| T6 | Node route in a worker thread, binary contract, WASM build and `--check`, contract fixtures (200, 400, 404, 413, 500) | 1 to 2 |
| T7 | Swift client, preference, fallback on error and on timeout, lab extended to run both engines | 1 |
| K2 | Feature-matrix row for `code_graph_3d` covers the new route (`scripts/feature-matrix.mjs`) | 0.5 |
| K3 | 3D decision and the WebGL view, if the Tauri or System page replaces `CGSimulation3D` | 2 to 3 |
| K4 | Retire the Swift layout after one release | 1 |

K1 alone is 8 to 10 tasks. The plan's figure for the whole of K0 to K2 is 3 to 4. The plan under-sizes this kit's K1 by about 2 to 3 times.

## 8. Parity strategy and rollout

### 8.1 Golden fixtures and tolerances

Golden fixtures come from the Swift engine, produced by a Swift executable in graph-kit (T1). Each fixture stores one named graph and the output of each stage. The Rust side compares against them.

| Stage | Output | Compared as | Tolerance |
|---|---|---|---|
| Topology | Links (source, target, weight, hierarchical), degree, weighted degree, in-degree, neighbours | Exact for integers and order; weight within 1e-12 | Exact order: input-edge order |
| PageRank | Normalised importance | Within 1e-9 | Same operation order required |
| Communities (Louvain) | Community id per node; count | **Exact** | Published values (§6.4) as the first checks |
| Components, groups | Component ids, group order | Exact | |
| Radii and masses | Per node | Within 1e-9 | |
| Anchors and seeds | Centre and per-node seed | Within 1e-9 | Deterministic geometry; expected to match exactly on native Rust |
| Final positions (force loop) | Per node | **Not compared exactly.** Bands only, plus a divergence report (below). | |
| Quality metrics | The `Report` fields | Within 1e-9 for modularity and component counts; bands for the rest | Lab thresholds (§6.4) |
| Final positions, small graphs only | For n ≤ 50 | Within 1e-6, reported, not gating | Shows how far chaos carries |

Bands for positions are the lab's invariants, unchanged: not a ring (radial concentration under 0.20), overlap under 0.02, largest component above 0.55 where owned, cluster separation above 1.0, modularity above 0.30 for code graphs. The divergence report prints the largest coordinate difference and the number of nodes whose cluster or overlap status changes. It gates nothing; it sets the bar for the next review.

The existing ground truth is reused, not replaced: the Louvain reference values, the exact-N² comparison and its thresholds, the EdgeWeight numbers (`GraphEngineLab/main.swift:370-382`), and the doc-track conformance (`conformance-memory.mjs`).

### 8.2 Order of porting

1. Topology, EdgeWeight and PageRank. Exact or near-exact, needed by every stage, and it lets the `signals` path move first.
2. Louvain. Discrete outputs with published values; the strongest test of the port.
3. SpatialTree and its audit, then LayoutQuality. Both are checked against exact sums and bands.
4. The force loop with anchors and seeds. The hard part; expect the band tests and the divergence report to take most of the time.
5. The orchestration (`layout`, `signals`) and the route, then the Swift client.
6. `CGSimulation3D`: decide (§9 Q4) before porting it. Port last, or retire.

### 8.3 Rollout (K1a and K1b style)

- **K1a (data).** No migration: layout output is not persisted (§5). Nothing in `graph.json` 1.1 or in SQLite changes. `GraphDocument` v1 is unchanged; positions remain optional.
- **K1b (runtime).** The route is additive. The preference `graphLayoutUseRust` defaults to off in the release that ships the route, on in the next, and the Swift path is removed only at K4, after one release with both. On any error, timeout or missing server, the Mac uses the Swift path and logs it. `SERVER_API_VERSION` is bumped (`server.mjs:281`), and the route's contract fixtures cover 200, 400, 404 `feature_disabled`, 413 and 500.
- **Latency budget (proposed, to re-set after T0).** At 8 000 nodes: p95 compute at most 1.5 times the Swift time measured on the same machine, and HTTP overhead under 50 ms. At 50 000 nodes: a target of 15 s, re-set after the spike.
- **Rollback.** Turn the preference off. The Swift code is still there. The route can stay.
- **N-1.** An old app keeps the Swift engine and never calls the route. A new server answers old clients unchanged. A new app against an old server (the skew window) falls back on the 404 or the missing route.
- **Feature matrix.** The route belongs to `code_graph_3d`. The reduced builds (`make build-mac-lite`, `build-mac-min`) do not link GraphCore's layout in the first place; the server rows must answer `feature_disabled` (`scripts/feature-matrix.mjs`).

### 8.4 Gates to add

- A graph-kit CI job for `rust/` (`cargo test --release`, clippy, the WASM `--check` when rustc matches) and for `web/` (`npm test`). Neither runs today (D8).
- A golden-fixture job in graph-kit CI that regenerates the Swift goldens on macOS and diffs them.
- `make graph-gates` extended with the Rust-versus-Swift divergence report (non-gating) and the band checks (gating).
- An llm-ide contract fixture check for the new route in `contract-ci`.

## 9. Decisions and open questions

None of these is approved. Each has a recommendation.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | How does the Mac get the Rust kernel, if at all? | A (WASM in the sidecar), B (static library), C (WASM in JavaScriptCore), D (keep Swift, goldens only) | A, decided by the T0 spike; D if the spike misses the budget. Do not choose B for the Mac alone (§7.3). |
| Q2 | Where does the OS view live? | Keep `gk/web` as the source and `ui/os-view` as the host (today), move the page into os-kit, or merge | Decide in os-kit's K0. Until then, record G8 as a known cross-repo coupling and keep `os-view-check` as the gate. |
| Q3 | One community algorithm or two? | Keep Louvain (Mac) and label propagation (System page); or port Louvain to Rust and switch the System page | Switch the System page to Louvain after the port, with a golden that shows the change. Two clusterings for one project is a defect, not a choice (D7). |
| Q4 | `CGSimulation3D` (Swift 3D) and the WebGL view | Port it; retire it for the System page's orbit view; retire it in favour of a WebGL force view in K3 | Retire it in K3. Keep it until the WebGL view matches it. Do not port it in K1. |
| Q5 | Parity bar: bit-identical picture or metric-level? | Bit-identical (only B can deliver it on the Mac); metric-level (A, C, D) | Metric-level, with a one-time, announced change of picture at the release boundary. No positions are persisted, so no user data changes. |
| Q6 | Request format for a layout route | JSON (about 18 MB at 50 000 nodes; over the limit); compact binary `application/octet-stream` with a route limit | Compact binary with an explicit route limit (`readBody` already accepts one, `core/utils.mjs:14`). |
| Q7 | Where is `EdgeWeight` defined? | Swift only (today); a Rust copy; a shared table in `gk/schema/` with generated constants | A shared table in `gk/schema/` with a generator and a drift check, the same pattern as `scripts/gen-design-tokens.mjs`. A copy in each language drifts. |
| Q8 | Swift decode of unknown kinds | Fail (today, `CodeGraphModels.swift:136`); map to `.other` (as `CGNodeKind.from` does for vault types) | Map to `.other`, like the Rust side accepts. Kind sets are equal today (34 and 37), so this is for the future. |
| Q9 | Quality metrics on every layout | Keep (today); compute on request only | Compute on request, or sample for large graphs. The metrics cost part of every layout and are logged once. |
| Q10 | Pins and release | Keep the revision-and-submodule pair (today); tag graph-kit releases | Tag releases once K1 lands; the two pins are otherwise a manual step each time. |
| Q11 | Which feature key owns the new route? | `code_graph_3d` (same closure as ingest); a new layout key | `code_graph_3d`. A new key adds a row to the feature matrix for no user-visible gain. |

**Q10 resolved (2026-10-28).** llm-ide keeps pinning revisions, not tags. A pinned revision is reproducible and cannot move under a build, and the revision is the unit that the three-pin check and `make graphkit-bump` act on. Tags are for external consumers of graph-kit (the TypeScript plugin and other packages). `make graphkit-bump TAG=X.Y.Z YES=1` cuts one on the bumped commit, after the build passes, and llm-ide's pin line records it in a `// graph-kit X.Y.Z` note. The manual dance that prompted the question is now one command.

## 10. Drift, gaps, and corrections to the plan's premises

### 10a. Drift and gaps found (with evidence)

| # | Finding | Evidence |
|---|---|---|
| D1 | The graph-kit README says layout is per-app and GraphKit ships "only the data model and producers". Layout is in GraphCore. | `gk/README.md:65-67`; `gk/Sources/GraphCore/Layout/` |
| D2 | The engine contract README says the TypeScript CLI has no `merge` command, so plugin doc-to-code links are missing. The command exists and is in the manifest. | `extension/graph_generation/README.md:138-146`; `gk/typescript/src/cli.ts:137-159, 184`; `gk/graph-engine.json` |
| D3 | `system/graph/graph.json` is listed as a generated artefact of the repository adjacency list. No server code reads it, and `paths.mjs` defines no helper for it. The server reads only `index.md`. | `extension/graphkit/paths.mjs:8, 51-52`; `extension/graphkit/README.md:20`; no `graph.json` read in `extension/` (grep) |
| D4 | `ProjectGraphFile.swift` names a test `GraphDocumentWireTests` that does not exist. The wire shape is covered by `SystemBridgeNativeTests`. | `Core/Project/ProjectGraphFile.swift:11`; `Tests/LlmIdeMacTests/SystemBridgeNativeTests.swift` (29 references) |
| D5 | `CGSimulation3D` says it "carries over the exact tuning validated for the 2D sim". Its constants and algorithm differ, and no test pins it. | `GraphCore/Layout/CGSimulation3D.swift:4-7, 62-67` vs `ForceDirectedLayout.swift:30-61` |
| D6 | Comments refer to `GraphPrune.capDegree`, which no longer exists. | `UAGraphView.swift:305, 526`; `EdgeWeight.swift:9-17` (comments only; `grep -rn GraphPrune` finds no code) |
| D7 | Two cluster algorithms for one project: Louvain on the Graph view and label propagation on the System page. | §6.5 |
| D8 | **Resolved 2026-10-28.** graph-kit's own CI (`ci.yml`) now also runs the Rust crate (tests and both clippy runs), the web page (type-check and 310 tests) and a WASM *glue* reproducibility check (`build-os-wasm.sh --check --strict --glue-only`). The wasm *bytes* are not reproducible across hosts (the same rustc and wasm-bindgen give different code on Linux x86_64 and macOS aarch64; measured), so CI validates them by behaviour and the full byte check stays local. The Swift job, red before this work, now builds on `macos-15`. llm-ide's `contract-ci` still runs `os-view-check`, and `make graphkit-pin-check` guards the three pins. | `gk/.github/workflows/ci.yml`; `gk/scripts/build-os-wasm.sh`; `.github/workflows/contract-ci.yml:46-58`; `Makefile` |
| D9 | No XCTest covers the layout engine. The only layout checks are the executables in `make graph-gates`, which run in `mac-ci.yml:309`. | §2f; `gk/Tests/GraphKitTests/` (0 references to layout types) |
| D10 | `graph.json` 1.1 has no schema under `schema/`. Its writer is Swift code; its readers are Swift code. | `schema/` contents; `CodeNoteGenerator.swift:247-292` |
| D11 | Strict decode on the Swift side and lenient decode on the Rust side. An unknown kind fails in Swift and passes in Rust. The kind sets are equal today. | `CodeGraphModels.swift:136`; `gk/rust/os-graph/src/models.rs:32-47` |
| D12 | Quality is measured on every layout by default and logged. The cost is part of every layout time. | `GraphLayoutEngine.swift:21, 174-177`; `UAGraphView.swift:~1716` |
| D13 | Two caps for the same graph: the System page caps core nodes at 4 000 (`systemGraph.ts:36`); the Mac layout has no cap (`UAGraphView.swift:534`). | §6.3 |
| D14 | The Mac `ProjectGraphFile.swift` header says "Core must not import GraphCore". Verified: it imports Foundation only. | `Core/Project/ProjectGraphFile.swift:1, 6-11` (positive finding) |
| D15 | The CLI bundle is in sync with `typescript/src` (byte-identical rebuild). | `gk/bin/graph-kit.js` (positive finding) |

### 10b. Corrections to the plan's premises

| # | Premise | Finding |
|---|---|---|
| P1 | "Settings graph-engine plugin card" (task brief) | There is no such card. Settings has one graph card, `GraphSettingsSection` (`FeatureCatalog.swift:152-156`). Engines are installed through Library → Plugins; the message in `UAGraphView.swift:1673` says so. |
| P2 | "The Rust crate `rust/os-graph` already does the OS graph layout; the layout engines are Swift-only" | Partly right. The crate has an orbit layout and label propagation (`orbit.rs:1-5`, `builder.rs:254`). It does not have Louvain, PageRank, the force layout, the spatial tree or the quality metrics. K1 is a new port, not an extension of existing Rust. |
| P3 | "The graph-kit row: K1 = layout in Rust/WASM" | Consistent with §7. But a WASM build of the OS view already runs in the app (System page), so the toolchain and the build pattern already exist; the new work is the algorithm and the Node route. |
| P4 | "K1 rule: tests port before Swift tests are deleted" | For layout, the tests are the labs, not XCTest (D9). The rule applies to the labs: port their checks before deleting `LegacyLayout` or the layout code. |
| P5 | "K1-skip rule for UI-state-only kits" | Does not apply. The layout is computation. |
| P6 | Plan sizing: graph-kit K0 to K2 is 3 to 4 tasks | K1 alone is 8 to 10 (§7.4). |

## 11. Verification log

Commands run on 2026-10-28, with outcomes. The Swift and Cargo runs used the sandbox disabled, as the task requested for Swift.

| Command | Outcome |
|---|---|
| `make graph-gates` (warm build) | graph-layout-lab PASS; graph-engine-lab PASS; conformance-memory PASS (identical doc track and merge). 10.2 s wall. |
| `cd gk && swift test` | 81 tests, 0 failures, 14.9 s wall |
| `LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter '…'` in `mac/` | 355 tests, 0 failures, 20 s test time |
| `cd gk/rust && rustup run stable cargo test --release` | 102 unit and 2 parity tests pass; 2 ignored |
| `cd gk/web && npm test` | 310 pass, 0 fail, 1.8 s |
| `cd gk/typescript && npm test` | 70 pass, 0 fail |
| `node --test` on 29 extension graph test files | 293 pass, 0 fail, 13.9 s |
| `make feature-gates` | PASS |
| `make os-view-check` | "os-view-check: ok" |
| `bash gk/scripts/build-os-wasm.sh --check` | "generated OS wasm files match a fresh build" |
| `esbuild` rebuild of `gk/typescript/src/cli.ts` compared with `gk/bin/graph-kit.js` | byte-identical |
| libm comparison (200 000 samples of `sin` and `cos`, same inputs) | Swift `-O` vs C: 0 differing. Rust native vs C: 0 differing. Node `Math` vs C: 9 068 of 200 000 `sin` and 8 942 of 200 000 `cos` values differ (about 4.5% each). |
| Canonical JSON size per node and edge (golden `synthetic_2000_cap500`) | 88.5 bytes per node; 91.4 bytes per edge |
| Kind sets, Swift vs TypeScript | 34 node kinds and 37 edge kinds, identical |

Not run: `make feature-matrix` (needs servers per row), `make contract-gates`, `make regression` (the whole gate), and the full Mac `swift test`. The filtered Mac run covers the graph-related suites, not the whole app.

No files were changed except `docs/kits/graph-kit.md` and `docs/kits/README.md`.
