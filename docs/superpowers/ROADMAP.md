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
| Extensions catalog P0 to P3 | 2026-10-30, local commits (no push yet): baseline golden file of what every extension consumer loads; catalog item model, restrict-only switch overlay, importer over the three state files, `computeActiveSet` with a fingerprint and a daily counts-only shadow compare; consumers honour the switches behind `LLMIDE_EXT_ACTIVE_SET` (off); provider-adapter turns mount the user's active MCP servers (on by default per the user's decision, `LLMIDE_EXT_ADAPTER=off` kills it). Spec: `docs/spec/extensions-catalog.md`. MCP review findings fixed (`853f130b` overlay fails closed, `9d792d1b` owner-only views, `9b96282a` MCP always asks, workspace cwd, 60k schema budget, process groups, notices). P4 (GitHub install at a pinned commit, per-user, default off, warn-only scan, API 93) committed; installed items now load into turns (P4b: skills, plugins, MCP servers; flag-gated, ask-first MCP; install allowlist defaults to `anthropics/*,modelcontextprotocol/*`); indexes/search, updates with rollback and the Mac screen are next. P5 server half (API 94): updates with diff and per-commit re-consent, one-version rollback, repair against a recorded fingerprint, four cached index adapters (anthropics/skills, official plugin marketplace, MCP reference servers, MCP registry) with search, `GET active|updates`; the Mac Extensions screen and the allowlist Settings UI are next. |
| Provider fixes | DeepSeek: a tool mode with tools off degrades to plain chat with a notice and current model ids count as tool-capable (`27a641a6`); Mac hides unconnected groups, shows "Plain chat (no tools)" with one-click Allow tools and a "tools (assumed)" badge (`400110ed`). |
| Test hang fix | Per-test timeout and suite watchdog for `npm test`, perl-alarm cap on `swift test` (`83be5934`, `d51e4a61`); token-bench fake runs 120 s to 8 s (`4ece15b3`). |
| Master plan | `docs/superpowers/MASTER-PLAN.md` with `scripts/plan-status.mjs` (`93ccd529`); web answers recorded (Q-WEB-1 relay-served phone web view, last, in sync-kit; Q-WEB-3 phone through the Mac for now; Q-WEB-2 relay host decided later). |
| Docs/maps | K0 maps for docs-, graph-, knowledge-, agent-kit; data-lifecycle doc; plans for live-then-archive and agent-kit K1. |

## In progress [me]

| # | Task | State |
|---|---|---|
| P7 | Retire `llm_agent/runtime/`: relocate survivors by owner (memory, modes, tools, plan), delete dead code, zero behaviour change. | 2 commits local (`844b1213`, `ece843c6`); agent finishing gates; then short review, gate, push, rebuild. |
| E4 | Extensions catalog P6 to P9 (Mac screen, allowlist Settings UI, Workspace Trust, rollout); plan `plans/2026-10-31-extensions-catalog.md`. | P4, P4b and the P5 server half done (updates, rollback, repair, indexes, search, active view, API 94); the Mac Extensions screen is built (installed/browse/install, consent, update preview, rollback, repair; real-app check pending); the server half of the allowlist setting (GET/PUT `/auth/me/extensions/allowlist`, operator ceiling) and Workspace Trust (per-user records, `.mcp.json` stdio servers withheld in untrusted folders, API 95, spec 9c/9d) are done; their Mac UI and rollout remain. |
| V1 | Provider settings live-app verification (DeepSeek connection, router and tools switches) [me]. | Pending. |
| B1 | Bench runs once Y1 is given [me, with you]. | Pending Y1. |
| N1 | Night-push job: nightly push of local `main` commits [me]. | Built (`746b94f9`); **you install it**: `scripts/nightly-push.sh --help` lists the three commands (mkdir logs, copy plist to LaunchAgents, `launchctl bootstrap`) and the optional `sudo pmset` wake. |

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
