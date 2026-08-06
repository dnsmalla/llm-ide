# Graph-Memory Freshness Signal — Design

**Status:** approved design (2026-06-24)
**Goal:** Stop the agent from silently grounding on stale or absent repository memory. Surface, in the injected prompt, (a) how old each repo's Graphify memory is, and (b) an explicit marker when an indexed repo has no memory at all — so the agent can weigh or caveat its answers instead of treating missing/old memory as fact.

This is sub-project 1 of the "code-graph grounding" decomposition. Sub-project 2 (graph **language coverage** — Go/Rust/Java + Swift import edges) is a separate spec/plan, not covered here.

---

## 1. Background

The Mac app's `KnowledgeGraphService.writeMemoryArtifact` is the **only** writer of `<repo>/graphify-out/memory/{repo.md,graph-notes.md,doc-notes.md}`. The extension only **reads** those files (allow-listed) and injects them into the global agent prompt via `renderGraphifyMemory(agentContext, userId)` in `extension/graphkit/memory.mjs`.

Two silent gaps result:
- **Stale:** when the Mac app is closed (or the repo changed since the last regen), the files on disk are out of date and the agent gets no indication of their age. (When the app is *open*, `GraphAutoUpdater` keeps them fresh on a timer + FSEvents, so freshness is only at risk while it's closed.)
- **Absent:** for an indexed repo with no `graphify-out/memory/`, `renderGraphifyMemory` returns `''` — the agent simply gets no memory block and can't tell "this repo is small/empty" from "the graph was never generated."

The extension **cannot** regenerate memory (generation is the Swift app's GraphKit). So the fix is a **passive, agent-facing signal**, computed entirely extension-side from data already on hand (file mtime). **Facts only — no "stale" verdict, no threshold, no git** (per the brainstorming decision: an inaccurate stale flag is worse than reporting the age and letting the agent judge).

---

## 2. Scope

- **In:** `extension/graphkit/memory.mjs` only — a relative-age helper plus two changes inside `repoMemoryBlock` / `renderGraphifyMemory`. Tests extend the existing `graphify-memory-*.test.mjs` suite.
- **Out:** Mac changes; artifact format changes (no written timestamp); git; thresholds; any "stale" boolean; UI; new endpoints. Sub-project 2 (language coverage).

---

## 3. Behavior

### 3.1 Age on present memory
`repoMemoryBlock` currently reads `repo.md`/`graph-notes.md`/`doc-notes.md` via `safeRead` (which `statSync`s each, then discards the stat). Compute the **newest mtime** across those three files and fold a relative-age phrase into the existing block header:

- Before: `## <name> — memory`
- After:  `## <name> — memory (updated ~3 days ago)`

If no mtime is obtainable (stat fails / no files), omit the `(updated …)` clause — never throw.

### 3.2 Explicit absence marker
`repoMemoryBlock` returns `null` today in two distinct situations that must stay distinct:
1. **Tenancy / path-gate failure** (path has `..`, not absolute, or not in the user's allow-list — current `return null` at the guards): **stays silent** (`null`). This is a security boundary, not "no memory."
2. **Allow-gate passed but no readable memory** (`parts.length === 0` after the reads): instead of `null`, return an **absence-marker block**:
   ```
   ## <name> — memory
   _No code-graph memory generated for this repo yet._
   ```

So the agent sees an explicit "not generated" note for repos it's expected to know, while non-allowed/invalid repos contribute nothing.

### 3.3 Boundaries that stay `''` (no false signal — unchanged)
`renderGraphifyMemory` returns `''` exactly as today when: `indexedRepos` is missing/empty, `userId` is falsy, the allow-list build throws, or `allowedRoots` is empty. The absence marker fires **only** for a repo that passes the allow-gate but lacks memory — i.e. where memory was expected. (Consequence: if every candidate repo is allow-gated out, the result is still `''`; if at least one allowed repo has no memory, the section renders with just the marker.)

---

## 4. Components

### 4.1 `relativeAge(mtimeMs, nowMs = Date.now())` → string  *(new, exported)*
Pure function. Returns:
- `just now` for < 60 s, or for any `mtimeMs` in the future / clock-skewed (`nowMs - mtimeMs < 0` clamps to `just now`);
- `~N minutes ago` for < 60 min;
- `~N hours ago` for < 24 h;
- `~N days ago` otherwise.

Exported so it's unit-tested directly; `nowMs` is a parameter for deterministic tests.

### 4.2 `newestMtimeMs(paths)` → number | null  *(new, internal helper)*
`statSync`s each path, returns the max `mtimeMs`, or `null` if none stat successfully. Best-effort: wrapped so it never throws. Called by `repoMemoryBlock` with the three memory-file paths.

### 4.3 `repoMemoryBlock(repo, budget, allowedRoots)`  *(modified)*
- After computing `memDir` and reading parts: if `parts.length > 0`, build the header with the age clause from `newestMtimeMs([repo.md, graph-notes.md, doc-notes.md])`.
- If `parts.length === 0` (but the allow-gate passed), return the §3.2 absence-marker block instead of `null`.
- The pre-existing path/tenancy `return null` guards are unchanged (stay silent).

### 4.4 `renderGraphifyMemory(agentContext, userId)`  *(unchanged logic)*
No change to its loop, caps (`MAX_REPOS`, `TOTAL_CHARS`), or the `''` boundaries — it just now receives marker blocks for allowed-but-empty repos and age-annotated headers for present ones. The `# Repository memory (Graphify)` wrapper and the downstream `redactFence` wrapping in `route.mjs` are unchanged.

---

## 5. Data flow
agent request → `composeGlobalPrompt` → `renderGraphifyMemory(agentContext, userId)` → per allowed repo: read allow-listed files (unchanged read + SSRF/allow-root guards) **and** their mtimes → render block (age header **or** absence marker) → joined section → injected (still `redactFence`-wrapped). No new I/O beyond `statSync` on files already opened.

---

## 6. Error handling
- Age computation is best-effort: any `statSync`/mtime failure → omit the age clause, still render the block. Never throws into the prompt build (mirrors the existing best-effort posture and the `safeRead` try/catch).
- The tenancy/path guards are untouched — no new path is read, no allow-list relaxation.
- `relativeAge` never throws on bad input (non-finite / future → `just now`).

---

## 7. Testing  *(node `--test`, extends `extension/tests/graphify-memory-*.test.mjs`)*
1. **Present memory shows age:** create `graphify-out/memory/repo.md` for an allow-listed repo, set its mtime via `fs.utimesSync` to `now − 3 days`; assert the rendered header contains `updated ~3 days ago` (or `~3 day`).
2. **Absent memory shows marker:** allow-listed repo with **no** `graphify-out/memory/` → rendered output contains `No code-graph memory generated for this repo yet.` under that repo's header.
3. **Silent boundaries unchanged (regression guards):** no `indexedRepos` → `''`; falsy `userId` → `''`; repo **not** in the allow-list → no marker, no block for it.
4. **`relativeAge` unit cases:** `just now` (< 60 s and a future mtime), `~N minutes ago`, `~N hours ago`, `~N days ago` — all with an injected fixed `nowMs`.

---

## 8. Build / CI
Extension-only — pushes cleanly through the node gate (`make test`). No migration, no endpoint, no rate-limit, no Mac change → `make docs-check` is unaffected. One implementation plan, ~2–3 small TDD tasks.

---

## 9. Out of scope / future
- A written `generatedAt`/source-fingerprint in the artifact (would enable a *true* stale verdict, but needs a Mac-side change — revisit only if facts-only proves insufficient).
- Git-aware staleness; a Mac UI "regenerate" affordance; auto-regen poke.
- Sub-project 2: graph language coverage (Go/Rust/Java) + Swift import edges.
