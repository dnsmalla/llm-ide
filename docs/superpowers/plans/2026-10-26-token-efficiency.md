# Plan: token efficiency (north-star track)

**Date:** 2026-10-26
**Branch:** `feat/phase1-core-contract` for the plan; each item gets its own branch
**Objective:** fast and few tokens (user's main goal). Runs alongside Phase 1;
every item is measured by the token bench (Phase 1 P17) before and after.

## Where the tokens go

Usage ledger 2026-10-01 → 26, billable-weighted (cache read 0.1×, write 1.25×):
v2 chat ≈ **34 350 / turn** with ~125 k cached context re-read per turn;
classic ≈ 19 300 / turn (13.7 k setup re-written every turn); background
≈ 3 100 / call.

Estimated split of the ~125 k per v2 turn (from `engine.mjs` /
`compact-system-prompt.mjs`, not yet measured): fixed prefix (preset system
prompt, tool schemas, llmide + user MCP tools, memory append) **~30–50 k**;
transcript (history + tool results, up to the 160 k compaction window)
**~75–95 k**. The prefix is already cache-stable (per-turn context lives in
the `<<<LLMIDE_CONTEXT>>>` user fence since 2026-09-26). **The transcript —
mostly tool output — and the number of hops are the levers.**

Already evaluated and rejected (2026-09): deferring llmide tool schemas —
net ≤ ~1.2 k saved, plus a ToolSearch round trip on first use, and tool
search is off on non-first-party base URLs. Not repeated here.

## Ranked items

| # | Item | Adopted from | Expected effect | Effort | Where |
|---|---|---|---|---|---|
| 0 | **Measure the split** — log per v2 turn the token size of system prompt, tool schemas, memory append, transcript and tool results (from the SDK request) into the ledger's `turn_composition` table (migration 0040 already exists) | — | turns every estimate below into a number | S | `llm_agent/sdk/engine.mjs`, `kb/turn-composition.mjs` |
| 1 | **Token bench** (Phase 1 P17): fixed scenarios, fails on > 15 % regression | — | prevents silent growth | S | `scripts/token-bench.mjs` |
| 2 | **Keep tool output out of the transcript**: clear stale tool results in batches (keep the newest ~3, clear when results exceed ~30 k), deterministic so the cache prefix stays valid between clears | Claude API context editing | transcript 75–95 k → est. 30–50 k; v2 turn est. −30–45 % | M | `engine.mjs` (SDK context management / hook) |
| 3 | **Search subagent on Haiku**: exploration (read/grep/glob) runs in a subagent that returns a short summary; the main thread never holds the raw files | Amp, Claude Code subagents | −10–50 k per research turn, faster | M | engine subagent definition + `server/tier-routing.mjs` |
| 4 | **Ranked repo map from the code graph** (~1–2 k, session-stable) in the append block, so the model needs fewer exploratory hops | Aider repo map | fewer hops × every per-hop re-read | M | `extension/graphkit/` render, `engine.mjs` append; never prune edges — rank and budget |
| 5 | **Compaction window 160 k → ~100 k** with a rolling summary | Claude Code compaction | caps worst-case re-read on long chats | S | `AUTOCOMPACT_DEFAULT_STANDARD_CONTEXT` |
| 6 | **Compact system prompt, with an exploration cap** (it saved ~5.5 k/hop but made read-only search 55 % worse without a hop bound) | — | −5.5 k per hop in modes where it holds | S | `compact-system-prompt.mjs`, per mode |
| 7 | **Diff/patch edits + cheap apply** (Haiku or deterministic), full rewrite only as fallback | Cursor apply, Aider | output tokens and latency on large files | M | `agents/codegen-apply` |
| 8 | **Hybrid retrieval: FTS5 + embeddings** | Cursor semantic search | fewer iterations on conceptual questions | L | `extension/kb/` + migration |
| 9 | **Classic path cache-stable** (13.7 k written every turn → read) | — | classic 19 k → ~8 k; lower priority now that new chats default to v2 | S–M | `/code-assist` prompt assembly |
| 10 | **Lazy project memory / skills list** (fetch via tool when needed) | — | stops prefix growth as memory grows | S | `engine.mjs` append |

Order: 0 → 1 → 2 → 5 → 3 → 4 → 6 → 7 → 9 → 10 → 8. Each item ships only if
the bench shows the saving and no scenario gets worse on quality
(same scenario answers judged by a fixed rubric).

## Sources

Research summary 2026-10-26 (Claude Code tool search and compaction, Claude
API context editing, Cursor semantic search and instant apply, Aider repo
map, Amp subagents); vendor figures are self-reported and treated as
upper bounds.
