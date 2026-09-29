# Refactoring + Doc Optimization Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new built-in loops on the Loop page — **Refactoring** (plan → apply one batch → run the tests) and **Doc Optimization** (index the code → write a generated, code-cited doc tree under `llm-doc/docs/`) — plus doc→code edges in the code graph so the docs steer find-code and the planner.

**Architecture:** Both loops follow the Plan loop's pattern exactly: a `LoopDefaultLoopKey`, stage keys routed by `stageKeyOwner`, `.skill` stages whose prompts are self-sufficient and path-agnostic (they defer to the editable Input/Output fields), deepened by central skills in the `.skills` kit, and a matching `LoopTemplate` for the New Loop wizard. graph-kit learns to read code citations out of markdown and emit `references` edges from the doc page to the cited file or symbol; the server labels them "documented by".

**Tech Stack:** Swift/SwiftUI (mac/), graph-kit (Swift package, submodule), Node ESM (extension/), the `.skills` kit (markdown skills + registry.yaml).

**Spec (decided with the user 2026-09-30):**
- Refactoring: *plan, apply, verify.* Stage 1 writes a refactor plan (professional structure + an AI-friendly setup: CLAUDE.md/AGENTS.md, clear module boundaries, small focused files, consistent naming, an index of entry points). Stage 2 applies ONE batch from that plan and marks it done. Stage 3 runs the project's test command; a failure goes through the loop's existing repair/retry. **Manual only** — `runsOnSchedule` false, never scheduled. Nothing is auto-committed; the run's changes land in the existing Run Changes review.
- Doc Optimization: a **generated tree at `llm-doc/docs/`** (never edits hand-written docs). Every claim about code cites it as a backticked `path/to/file.ext`, `path:line`, or `` `SymbolName` ``, so the graph can link it.
- Graph: **yes, doc→code edges now** (graph-kit + server label). graph-kit changes need the user's push + both pins bumped afterwards — not part of this plan.

## Global Constraints

- Never push any repo (llm-ide, `.skills`, graph-kit). Commits only, on branches: llm-ide `feat/refactor-doc-loops`, `.skills` `feat/refactor-doc-skills`, graph-kit `feat/doc-code-edges`.
- Never stage `.serena/project.yml`; stage the `mac/LocalPackages/graph-kit` and `.skills` gitlinks ONLY in the final integration commit of Task 5.
- Mac tests: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > $TMPDIR/mac-test.log 2>&1` (unsandboxed); assert the XCTest "Executed N tests, with 0 failures" line AND the swift-testing summary — never `| tail` for the exit code. Known flake: `ExplorerTreeStoreWatchTests` FSEvents hang — re-run it alone.
- Extension: `cd extension && npm test` (unsandboxed) and `npm run lint` pass; ESLint boundaries at zero violations.
- `make docs-check` passes when docs change (unsandboxed).
- Stage prompts are PATH-AGNOSTIC: they refer to "the Input" / "the Output path", never a concrete path (the path lives only in `targetPath`/`outputPath`), exactly as `LoopStageDetector.planStages()` does.
- `grep` is aliased to ugrep — use `/usr/bin/grep`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Conventional Commits, one concern per commit.
- Implementers never spawn sub-agents.

---

### Task 1: central skills (`.skills` kit)

**Repo:** `/Users/dinsmallade/llm-ide/.skills` (github dnsmalla/agent-kit). Branch `feat/refactor-doc-skills` off its current HEAD.

**Files:**
- Create: `skills/refactor-planner/SKILL.md`, `skills/refactor-apply/SKILL.md`, `skills/doc-structure-index/SKILL.md`, `skills/doc-writer/SKILL.md`
- Modify: `registry.yaml` (4 entries, copy the shape of the `plan-director` entry), `README.md` (4 table rows beside `plan-director`), `CHANGELOG.md` (one entry), `CATALOG.md` (regenerate with `scripts/gen-catalog.sh`, never hand-edit)

**Model to copy:** `skills/plan-director/SKILL.md` and `skills/plan-structure-index/SKILL.md` (frontmatter `name` + `description` starting "Use when…", sections, the resolve-paths-against-repo-root-then-project-root rule, the Input/Output convention). Each new skill ≤ 120 lines.

**Content contract (each skill must state these rules):**
- `refactor-planner` — Input: the repo (or subtree); Output: a refactor plan file. Surveys structure and writes batches, each with a stable ID (`R1`, `R2`, …), status (`todo`/`done`/`skipped`), the files it touches, the intent, and the risk. Covers: directory layout by responsibility, files > 500 lines to split, duplicated logic, naming consistency, dead code *only when provably unreferenced*, and an AI-preferable setup (a root CLAUDE.md/AGENTS.md describing commands, architecture, invariants; per-area READMEs; entry-point index; module-boundary rules). Batches are small (one concern, ≤ ~10 files), behaviour-preserving, and ordered safest-first. Diff-first: re-running updates statuses and adds new batches, never reorders or renumbers existing ones. Never edits code.
- `refactor-apply` — Input: the refactor plan; Output: the repo. Picks the FIRST `todo` batch only, applies it behaviour-preservingly (moves/renames update every import and reference; no public API change unless the batch says so; no test weakened or deleted), then marks it `done` with a one-line note — or `skipped` with the reason when it cannot be done safely. Never touches more than that batch. Never commits.
- `doc-structure-index` — Input: the repo; Output: the doc index file. Writes the doc tree's `INDEX.md`: the areas of the codebase, for each the doc page that will describe it, and the key files/symbols each page must cover (cited in the citation format below). Diff-first rewrites; ≤ 300 lines.
- `doc-writer` — Input: the doc index; Output: the doc directory. For every page listed in the index, writes or updates it: purpose, how it works (the logic, step by step), key files and functions, invariants, how to change it safely, related pages. **Citation format (the graph reads it):** code is cited only as a backticked repo-relative path (`` `extension/graphkit/graph.mjs` ``), path with line (`` `extension/graphkit/graph.mjs:165` ``), or a backticked bare symbol name (`` `searchCodeIndex` ``); every citation must exist in the code (verify with the `check-citations` / find-code tools when available, else by reading the file). Updates only drifted sections; never deletes a page the index still lists; each page ≤ 250 lines.

- [ ] Step 1: write the 4 skills. Step 2: registry + README + CHANGELOG, then `bash scripts/gen-catalog.sh`. Step 3: `bash scripts/validate.sh` — no NEW errors/warnings beyond the pre-existing registry warnings (record the before/after counts in the report). Step 4: commit `feat(skills): add refactor-planner, refactor-apply, doc-structure-index and doc-writer` (split if validate needs a separate fix).

---

### Task 2: the two default loops (Mac)

**Repo:** llm-ide, branch `feat/refactor-doc-loops`.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopDefinition.swift` (`LoopDefaultLoopKey`: `refactor = "refactor"`, `docs = "docs"`, appended to `all` after `plan`)
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopStageDetector.swift` (`stageKeyOwner`, `defaultStages(forLoop:gitRoot:)`, `defaultLoopName`, `defaultLoopContract`, `unconditionalStageKeys`, new `refactorStages(gitRoot:)` / `docStages()`)
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopTemplate.swift` (templates `refactoring` UUID `1E7B0A00-0000-4000-8000-0000000000AA`, `docOptimization` UUID `…0000000000AB`, added to the built-in list)
- Modify: `mac/Sources/LlmIdeMac/Services/ProjectScaffolder.swift` (add `llm-doc/docs` and `llm-doc/refactor` beside `llm-doc/plans` in both lists)
- Modify: wherever the default loop's `runsOnSchedule` is set on creation, so the Refactoring loop is created with `runsOnSchedule = false` and it is never flipped on by migration
- Test: `mac/Tests/LlmIdeMacTests/LoopDefaultLoopsTests.swift` (extend)
- Docs: `docs/spec/macos-app.md` (or wherever the four default loops are listed — find with `/usr/bin/grep -rn "System Check" docs/`) — add the two loops

**Stages (names, keys, paths exact):**

Refactoring loop (`LoopDefaultLoopKey.refactor`, display name "Refactoring"), gated on `gitRoot != nil`:
1. `Refactor Plan` — `.skill`, `skillId: "skills/refactor-planner"`, `targetPath: "."`, `outputPath: "llm-doc/refactor/REFACTOR.md"`, `defaultKey: "refactor-plan"`, prompt: self-sufficient version of the refactor-planner contract above, path-agnostic.
2. `Refactor Apply` — `.skill`, `skillId: "skills/refactor-apply"`, `targetPath: "llm-doc/refactor/REFACTOR.md"`, `outputPath: "."`, `defaultKey: "refactor-apply"`, prompt: the refactor-apply contract, path-agnostic.
3. `Test` — `.shellCommand`, the detected test command (`detectTestCommand(gitRoot:)`), `defaultKey: "refactor-test"`, `detectedCommand` set.
**When no test command is detected, stages 2 and 3 are omitted** (the loop is plan-only): code is never edited without a verify stage.

Doc Optimization loop (`LoopDefaultLoopKey.docs`, display name "Doc Optimization"), gated on `gitRoot != nil`:
1. `Doc Index` — `.skill`, `skillId: "skills/doc-structure-index"`, `targetPath: "."`, `outputPath: "llm-doc/docs/INDEX.md"`, `defaultKey: "doc-index"`.
2. `Doc Writer` — `.skill`, `skillId: "skills/doc-writer"`, `targetPath: "llm-doc/docs/INDEX.md"`, `outputPath: "llm-doc/docs"`, `defaultKey: "doc-writer"`, prompt includes the citation format verbatim.

`unconditionalStageKeys` gains `refactor-plan`, `refactor-apply`, `doc-index`, `doc-writer` (read its doc comment and `LoopEngineConfig.shouldPersist` first — the rule is "a detector stage that would be created on every tree must not by itself make a bare tree persist its config"; `refactor-test` is detector-conditional and stays out).

Contracts (`defaultLoopContract`):
- refactor: goal "Move the codebase toward a professional, AI-friendly structure one safe, behaviour-preserving batch at a time.", acceptance "The refactor plan exists with every batch marked todo/done/skipped, the applied batch changed no behaviour, and the test command still passes."
- docs: goal "Keep a generated, code-cited doc tree that explains what the code does and why, so people, agents and the code graph are pointed at the right code.", acceptance "llm-doc/docs/INDEX.md lists every area, every listed page exists within 250 lines, and every code citation resolves to a real file or symbol."

- [ ] Step 1: failing tests in `LoopDefaultLoopsTests` — both loops created for a git root with/without a detected test command (refactor loop is plan-only without one), stage keys/paths/skillIds exact, owners routed by `stageKeyOwner`, refactor `runsOnSchedule == false`, loop-scoped ensure adds them to an existing project store without touching other loops, idempotent, bare tree does not persist a config (shouldPersist), templates present with the new UUIDs. Step 2: implement. Step 3: full Mac test run per Global Constraints + `make regression`'s feature-boundary gate (`bash mac/Scripts/feature-boundaries.sh`). Step 4: docs + `make docs-check`. Step 5: commits (`feat(mac): add the Refactoring and Doc Optimization default loops`, `docs: …`).

---

### Task 3: doc→code edges (graph-kit)

**Repo:** `/Users/dinsmallade/llm-ide/mac/LocalPackages/graph-kit`, branch `feat/doc-code-edges` off local `main` (3e430ef). graph-kit's own `swift test` target is broken on main (missing GraphCore imports) — gate with the lab executables and a probe instead; if a lab has a fixture mechanism, add a fixture there.

**Files:** `Sources/GraphKit/Scan/FileStructureExtractor.swift` (collect citations from markdown lines), `Sources/GraphKit/Scan/…ScanResult` (carry them per file, e.g. `citations: [String: [Citation]]` with `text`, `line`), `Sources/GraphKit/Build/StructureGraphBuilder.swift` (emit edges), `Sources/GraphKit/Cache/ScanCache.swift` (`currentVersion` "2" → "3", since cached scans lack citations).

**Rules:**
- Extract from markdown only: backticked spans and `[text](target)` link targets. Ignore fenced code blocks (``` … ```).
- A span is a **path citation** when, after stripping a trailing `:N` or `:N-M`, it contains `/` or ends in a known source extension, is relative (no scheme, no leading `/` or `~`), and resolves — relative to the repo root, then relative to the doc's own directory — to a scanned file. Edge: `file:<doc path>` → `file:<target>`, kind `references`, confidence `EXTRACTED`.
- A span is a **symbol citation** when it matches `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$`, is ≥ 4 chars, and resolves to EXACTLY ONE symbol node by name (or `Parent.name` for a method). Ambiguous or unknown names emit nothing. Edge: doc file node → symbol node, kind `references`, confidence `INFERRED`.
- Dedupe edges per (doc, target). No self-edges. No edge from a doc to another doc unless it is a path citation (links between pages are fine).
- [ ] Step 1: implement. Step 2: `swift build` and every lab gate green (`swift run -c release graph-layout-lab --compare`, `swift run graph-engine-lab` — whatever the package defines; list them from Package.swift). Step 3: probe on the llm-ide repo with the scratch probe (`/private/tmp/claude-501/-Users-dinsmallade-llm-ide/8dd20535-657b-4b2b-9c13-1f00997d1a6e/scratchpad/probe`, rsync graph-kit into `scratchpad/gk` first, `swift build -c release`, run `probe /Users/dinsmallade/llm-ide "" $S/llmide-graph.json`) and report the count of doc→file and doc→symbol `references` edges plus 5 sample edges from `CLAUDE.md` / `docs/`. Step 4: commit `feat: link markdown code citations to the code they cite`.

---

### Task 4: "documented by" in find-code (server)

**Repo:** llm-ide, branch `feat/refactor-doc-loops`.

**Files:** `extension/graphkit/graph.mjs` (relation label), `extension/tests/find-code.test.mjs` or a new `extension/tests/find-code-doc-edges.test.mjs`.

- When a stage-2 neighbour is reached over a `references` edge whose OTHER end is a doc node (`kind` `docPage`, or source_file ending `.md`), label it `documented by` (doc → the seed) / `documents` (seed is the doc), instead of the generic `referenced by` / `references`. Keep `(inferred)` suffix behaviour for INFERRED edges.
- Confirm `connectors/structure-graph.mjs` `normalizeEdge` keeps `references` edges and their confidence (it keeps any kind — verify, don't change).
- [ ] Step 1: failing test with a fixture graph (a symbol, a doc page node, a `references` edge doc→symbol, INFERRED): `searchCodeIndex` on the symbol returns the doc in `related` with relation `documented by (inferred)`. Step 2: implement. Step 3: targeted tests, full `npm test`, lint. Step 4: commit `feat(server): label doc-to-code edges as documented by`.

---

### Task 5: integration

- [ ] In llm-ide on `feat/refactor-doc-loops`: point the `.skills` submodule gitlink at Task 1's commit and the graph-kit gitlink at Task 3's commit (`git add .skills mac/LocalPackages/graph-kit` only). Do NOT change `mac/Package.swift`'s graph-kit `revision:` (it must reference a pushed commit; the user pushes graph-kit and bumps it). Commit `chore: point .skills and graph-kit at the refactor/doc loop commits`.
- [ ] Re-run the benchmark (`cd extension && node scripts/retrieval-bench.mjs --graph <graph JSON from Task 3's probe> --repo /Users/dinsmallade/llm-ide`) and report hit@3 vs 7/10 — the new edges must not regress it.
