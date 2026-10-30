# Roadmap: done, waiting on you, now, next, later

Updated 2026-10-30. Principle (user, 2026-10-29): **professional quality over speed.** No safety gate is compressed to hit a date. A phase ships only when its exit gate, its independent review and the full pre-push gate are green. User decision (2026-10-30): **paid / subscription bench runs happen after the end-to-end build; every token-affecting change ships OFF by default until then.**

Legend: **[me]** the agent does it, **[you]** needs the user, **[wait]** time-gated (real data must accumulate).

## Done and pushed (main, `01952e9f` plus Phase 7 local)

| Area | What shipped |
|---|---|
| Agent store | `agent.db` (runs, tool events, composition, activity, rollups), Storage hub, Settings "Agent history" card, Clear/Compact, retention; usage-ledger shadow (`usage_calls`) with daily compare. |
| Data placement | Rule: DB data in `<project>/system/`, notes in `llm-doc/`; Loop JSON + notes index moved; graph/memory/faults under the project `system/`; Doc Gen default `llm-doc/generated/`. |
| Server data move | `data.db`/`agent.db`/secrets moved to Application Support (verified on the live machine), keep-2 backups, moved-kb tripwire (guard runs before any file is created). |
| Live-then-archive | Phases 0-4 + extension part of 5: note index (rebuildable), chunked reconcile, shadow compare, quit archive with crash recovery, delete-everywhere, sign-out safety, extension draft release. |
| Agent-kit K1 | P0 bench readiness; P2 non-token SDK adoption (retry/rate-limit/permission/refusal/thinking notices, MCP status, sandbox, fallback model opt-in) + SDK ledger triage; P3 `POST /kb/complete`; P4 extension chat = live v2 client, `/chat` 410; Track Q Mac half (plugin/MCP/LLM-source UI in sealed `Features/Extensions`); P6 provider catalog (Vercel AI SDK adapter, pinned fetch, per-user keys, security-reviewed); P6b session router (per-chat provider/model, billable token cap, handoff, learned limits, compression off); P6 second half (DeepSeek/catalog models in chat, classic engine deleted, `/code-assist` 410, legacy key migration, tools opt-in). |
| Loose ends closed | `lta.mode` Settings control, incomplete-archive list, Clear older-than-N-days, run recording for dispatch/review/auto-task, shadow numbers in `/kb/storage`, `.env.example`. |
| Provider settings | 2026-10-30: four overlapping sections (Model Providers, Custom Providers, Provider catalog, Tiers & Roles) became two: **Providers** (one list, every connection once, type label, key, Test, models and tools, enable, remove, Add, Move to catalog) and **Model routing** (tiers, roles, fallback, router/cap/tools switches). No store or vault migration; server connect gained `enabled` and `copyKeyFrom`. |
| Docs/maps | K0 maps for docs-, graph-, knowledge-, agent-kit; data-lifecycle doc; plans for live-then-archive and agent-kit K1. |

## In progress [me]

| # | Task | State |
|---|---|---|
| P7 | Retire `llm_agent/runtime/`: relocate survivors by owner (memory, modes, tools, plan), delete dead code, zero behaviour change. | 2 commits local (`844b1213`, `ece843c6`); agent finishing gates; then short review, gate, push, rebuild. |

## Waiting on you [you]

| # | Item | Why it matters |
|---|---|---|
| Y1 | **Bench go-ahead.** Run on your `claude` CLI login (no per-token billing, counts against plan limits). I will hand you a combined bench plan with exact commands: Haiku v4 baseline, Sonnet-class baseline, noise check, then A/B pairs for each lean change. | Unblocks all token savings (below). |
| Y2 | **Manual app checks:** 12-step quit-and-relaunch run with `lta.mode=on`; moved plugin/MCP screens; Settings → Providers and Model routing (DeepSeek connection, "Turn on the session router", "Allow tools on provider models"); chat header cap control. | Real-app verification nothing else can give. |
| Y3 | Decisions: **Q19** (notes without `platform` are invisible in Library), **Q16** (search latency at 50k notes), knowledge-kit Q1-Q14 (unanswered ones, esp. Q6 ReviewConflicts, Q9 plan-table boundaries, Q12-Q13), ledger **step B** go/no-go. | Block knowledge-kit K1 and the ledger cutover. |
| Y4 | Meetings are not in use: all meeting work waits until you record meetings (see Later M1-M3). | Time-gated by your usage. |

## Next (build, all token-affecting parts OFF until Y1)

| # | Task | Gate |
|---|---|---|
| X1 | **Lean SDK configuration (P1, L1-L12):** compact prompt with an exploration cap, drop Bash from modes that do not need it (execute mode; `ask` is already read-only on v2), settings audit (git instructions, attachments), cache-TTL experiment, compaction window, our own per-turn calls (memory-extract, mode classifier), tool-search re-measure. | Bench A/B per item (15% tokens / 30% time). |
| X2 | **Token-affecting SDK adoption (P2 top-15 remainder):** `sessionStore`, Haiku search sub-agent via `options.agents` (also restores plugin sub-agent tools), `Task*` tools, `skills`, `options.agent` (enables `snapshot:true`), `resumeSessionAt`, plan-mode tools. | Bench each. |
| X3 | **Ended-chat continuation (live-then-archive Phase 5 / agent-kit P5):** per-chat summary on a cheap model + last 4-6 turns, fresh SDK session, warm-chat resume only; improves the P6b handoff (today a simple extract). | Bench + review. |
| X4 | Track Q server half: move the 37 plugin/MCP/LLM-source routes out of `server/auth-routes.mjs` into their own route module (pure move, contract-proved). | **Done** (`routes/extension-routes.mjs`; contract gates unchanged, route-table test). |
| X5 | Ledger step B (agent store Stage 2): budget readers to `usage_calls` after 7 days of zero mismatches; **fail closed** to the ledger. | Your go/no-go (Y3). |
| X6 | Router polish: switch history in the Agents hub (graph-kit page), shadow metrics on the Storage page (graph-kit), per-chat cheaper fallback at the cap. | graph-kit repo + pin bump. |
| X7 | Provider pinning for tracker-host connectors (`connectors/issues.mjs`, `agents/dispatcher.mjs`, `agents/outcome-providers.mjs`) — now pinned through `server/tracker-fetch.mjs`, allowlist entries removed. | **Done** (security review still welcome). |

## Later

**Meetings (user, 2026-10-29): not in use.** Shadow mode costs nothing without meeting notes.

| # | Task | Notes |
|---|---|---|
| M1 | Live-then-archive Phase 5 Mac side: ack with server `lines`/`hash`, dedupe a re-sent capture by session id; meeting-attached chat (`meetingId`, no undo). | When meetings are used. |
| M2 | 7-day shadow soak on real meeting notes (topK overlap, countDelta 0). | Needs meeting notes. |
| M3 | Live-then-archive Phase 3: read-path switch to `note_index`. | After M2. |
| L1 | Live-then-archive Phase 6: delete legacy duplicate rows (destructive; export-before-delete, backup, rollback drill). | After M2 + M3. |
| L2 | Knowledge-kit K1 (files stay the truth, server keeps a rebuildable index). | After Y3 answers. |
| L3 | Docs-kit K2-K4. | Release cadence. |
| L4 | Other kits in plan order: work, workspace, capture, automation (job runner first), sync. | Kit-by-kit plan. |
| L5 | Graph layout in Rust/WASM (spike: 16% faster, shared kernel). | Revisit with the Tauri work. |
| L6 | Tauri desktop + relay (ADR 0018). | PoC gate. |

## Loose ends

- Pin the extension origin (CORS accepts every `chrome-extension://*`; Q22). Quit-time delay on macOS logout (Q21); `llmide://` launch from Chrome (Q11).
- Real-corpus checks fixtures cannot give: platform-less note count, hidden-note semantics, iCloud placeholders.
- Flaky under full-gate load (pass alone): `index-routes.http` 1 MB body test (EPIPE), `loop-contract-lab` environment-inspector probes, `ExplorerTreeStoreWatchTests` (hardened). Harden, don't re-run.
- Two Macs on one account can flap note-index keys (detected, not prevented).
- Plugin sub-agent tools are unavailable until X2 (`ask-subagent` answers once, marked `tools_unavailable`; `ask-internal` stub).
- The `/health` storage field and API-version decisions for additive changes follow the API 92 line.

## Quality gates that never get skipped

Independent Sonnet review for data-, money- and security-touching code; `make regression`; contract gates; feature-boundary gate; markdownlint before every push; old-format fixtures for every migration (N-1 readable, rollback tested); real-data checks before any destructive switch; nothing deleted without a verified copy; token-affecting changes only after a bench A/B.
