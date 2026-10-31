# Roadmap: done, running, waiting on you, next, later

Updated 2026-10-31 (written at `e72654c9`; 348 commits since 2026-10-30). This page is a short, readable view. **Item-by-item status lives in [MASTER-PLAN.md](MASTER-PLAN.md)** (checkboxes, evidence, owners; `node scripts/plan-status.mjs` computes its dashboard). This page does not repeat checkbox state: when the two disagree, the master plan wins. Your own to-do list with exact commands is [USER-CHECKLIST.md](USER-CHECKLIST.md).

Current numbers: `SERVER_API_VERSION` 102, migration head 0058 on pushed `main` and 0059 (`google_connectors`) in the local commits; the HTTP contract and generated types are in `schema/`.

## Principles (kept at the top on purpose)

- **Professional quality over speed** (user, 2026-10-29). No safety gate is compressed to hit a date. A phase ships only when its exit gate, its independent review and the full pre-push gate are green.
- **Token-affecting changes ship OFF** until you run the bench and say go (user, 2026-10-30). Paid or subscription bench runs are yours to start.
- **Push only when you say so.** The nightly push job exists (`scripts/nightly-push.sh`) but is not installed. Local `main` is ahead of `origin/main` by 8 commits (see section 2). No branches: work happens on `main`.
- **Delegation applies to the open questions.** You said "do the best, secure, usable for big projects" and I decided. Those answers are marked **delegated, revisit if wrong** below; any of them can be reopened by saying so. They are: relay design choices D1-D5 and D7-D9 (tiered clients, no third-party analytics, upload-only files, per-user accounts); sync-kit S1-S6; ui-kit U1-U6 (provisional); Phase 7 defaults D4-D8 (tree-only to cloud models, stop-only, browser profile, audit retention, first-party mount); Issues token migration into the core vault (W2); Mac Auto Tasks moving to the SDK engine for Claude with multi-engine kept.
- **macOS first and finished, then Windows and Linux.** The Tauri macOS app must reach parity and daily use before the other two OSes get more than CI.
- **Swift feature freeze is in force** (inferred from the 2026-10-31 acceptance of ADR 0018 for Phase 3; you have not contradicted it). Allowed: security fixes, parity work needed for the shared core, and build/release work. The one planned exception is the Live capture helper (Phase 5 question 2).

Legend: **[me]** the agent does it, **[you]** needs you, **[wait]** time-gated on real usage.

## 1. Done and pushed

Pushed state is `origin/main` at `6f51e1e6`.

**Agent store, data placement, live-then-archive**
- `agent.db` (runs, tool events, composition, rollups), Storage hub, Agent history card, retention, usage-ledger shadow with daily compare.
- Rule: DB data under `<project>/system/`, notes under `llm-doc/`. Server `data.db`, `agent.db` and secrets moved to Application Support (verified on the live machine, keep-2 backups, moved-kb tripwire).
- Live-then-archive phases 0-4 and the extension part of 5: rebuildable note index, quit archive with crash recovery, delete-everywhere, sign-out safety. Meeting phases wait for you to record meetings.

**Agent-kit K1, extensions, trust, job runner, command bus**
- K1: SDK-only engine (classic loop and `/code-assist` retired), non-token SDK adoption, `POST /kb/complete`, extension chat as a live v2 client, provider catalog with per-chat router, `llm_agent/runtime/` retired.
- Extensions catalog P0-P5: item model, restrict-only switches, GitHub install at a pinned commit (per user, default off, warn-only scan), installed items load into turns, updates with per-commit consent, rollback, repair, four index adapters, search; Mac screen; per-user install allowlist; Workspace Trust (untrusted folders do not load their `.mcp.json` servers). Spec: `docs/spec/extensions-catalog.md`.
- Core job runner (persisted queue, lane lock, cancel, process-group kill) and the **command bus** (API 100, migration 0058): one closed registry of command kinds with tiers, `/bus` routes, engines, audit, per-user caps, orphan reaping. Spec: `docs/spec/command-bus.md`.
- **Bypass host approval** (API 101): when the Tauri host spawned the core, Bypass needs a host-signed single-use approval token bound to the chat; the bus uses a separate derived host proof.
- Independent security reviews of the MCP adapter, extension install flow, job runner, bus and host proof; all findings fixed and tested.

**Provider settings**
- Four overlapping Settings sections became two: **Providers** (one list) and **Model routing**. Claude-compatible endpoints in Providers (API 99). DeepSeek plain-chat and tool-capability fixes.

**Tauri Phase 3 and 5 screens (built and unit-tested; none GUI-verified, see section 3)**
- Chat (typed decoder, reducer, composer with slash menu, mentions and attachments, plan cards, approval and question cards, detached turns that re-attach, history paging, Mac-format chat store with quit archive).
- Explorer (virtualised tree, tabs, Monaco, save conflicts, watcher, git decoration), panel switcher, project search, terminal dock (host consent, scrubbed env, credit-based flow control), local Source Control.
- Library read side and write side (CAS saves, surgical frontmatter, search over `/kb/index/search`), Connections panes (Email, Slack, Box, repositories, connectors) with write-only secrets, source ingest.
- Settings, Extensions screen, Code Graph (vendored wasm layout kernel, strict decoder, sigma/WebGL view). API 96-99 additions supporting them: running-turn re-attach, history cursor, index search.

**Host hardening (Tauri shell)**
- Two review rounds: root-confined fs commands with no-replace creates and verified descriptors, strict git config parser, process-group git timeouts, spawned-core identity by nonce, OS secret store (fail closed), least-privilege capabilities, tightened CSP, single-instance lock, trash seam per OS, bounded recent list and notifications, chat file store rules (delete confirm, 30-day recoverable copy, purge safety). Details: `desktop/PACKAGING.md`.

**Mobile phone-bridge security fixes (Swift, allowed under the freeze)**
- One tier gate in phone dispatch with every wire type classified; phone-started implement, review-merge, Self-Heal apply, template/config/toggle edits need the desktop; queued Loop starts re-validated; `explore_chat` never runs with Bypass; Auto Task run honours its enable flag. Docs corrected; F-rows added to `docs/mobile/verification.md`.

**CI, release, docs, plans**
- `desktop-ci.yml` for macOS, Windows and Linux (written; first GitHub run status is in the CI check), unsigned manual release draft, `scripts/build-desktop-mac.sh` (ad-hoc signed app), one monotonic Mac build number, October changelog.
- Plans and designs: Tauri Phase 3 and Phase 5 plans with the parity checklist, command bus spec, relay design plus its security review (all 25 findings adopted), Phase 7 design rev 2, mobile TLS pinning design, Auto Tasks audit, extension storage audit, status audit, Google connectors plan, Issues and Gantt core plan. Dependency bumps with RUSTSEC fix.

## 2. Running or just landed (local, not pushed)

`git rev-list --count origin/main..main` is 8. These are the local commits:

- **Doc Gen and Visual** (Tauri): request model, sources, run state machine, screen with templates and history, hostile-output tests, shell section, parity rows (`9b2fa3f6`, `392a70ed`, `46dae4df`, `885e6fe6`). Built and unit-tested, not GUI-verified.
- **Google connectors, server side** (another agent, in progress at the time of writing): G1 OAuth core with PKCE and loopback flow (`87c98768`, migration 0059), G2 Gmail over REST with a `historyId` cursor (`43d721ab`), G3 and G4 Calendar and Drive as Pattern A connectors (`e72654c9`). Still open in the plan: G5 routes and sync-state storage, G6 Library screen and setup guide, G7 scheduled sync, G0 (your answers to Q-G1 to Q-G3; the plan's recommendations are being followed meanwhile). I could not verify which of G5-G7 have landed beyond the commits above; check `git log -- extension/connectors/google extension/routes`.
- `995e0b8f` CI: desktop workflow uses the shared token-drift check.
- Nothing is running as a background job that I know of. Re-check `ps` for leftover test or server processes before you start the app (section 3).

## 3. Waiting on YOU

| # | Item | Notes |
|---|---|---|
| Y1 | **Real-app first run** of the Tauri app: follow the checklist in `desktop/RUN-ON-MAC.md` (build with `scripts/build-desktop-mac.sh`, sign up on the local core, open a scratch project, try Chat, Explorer, terminal, Library, Settings, Extensions, Code Graph, Doc Gen). Report differences with its bug template. | No screen has ever been seen in the real app; every "built" row depends on this. |
| Y2 | **Device tests**: `docs/mobile/verification.md` F-rows (tier gating, approvals) and, once the TLS slice is built, the on-device TLS items (ATS check, legacy path, packet capture). | Needs an iPhone on the same network. |
| Y3 | **Phase 3 exit conditions**: Mac autobench with the window frontmost (confirms 30 s hidden phase), one Windows run (graph at least 30 fps, sidecar start and quit, installer size), Accessibility grant for caption cadence. | A failed Windows run pauses work (ADR 0018 condition). |
| Y4 | **Bench go-ahead and runs** (`USER-CHECKLIST.md` section A: baselines, noise check, A/B per switch). | Unblocks every token-saving change in section 4. |
| Y5 | Run `node scripts/auto-task-usage.mjs --db "$HOME/Library/Application Support/llm-ide/system/data.db"` and tell me the counts. Read-only. | Decides which Auto Tasks get cut or merged (audit: 5 keep, 5 merge, 3 remove). |
| Y6 | **Create a Google Cloud OAuth client** (desktop type, your own project, test users = your accounts, consent screen in Testing): checklist is in the Google plan section 7 and the setup guide that G6 will add. Needed for any live Google run. | Without it only fixtures run. Expect 7-day refresh-token expiry while the app is in Testing. |
| Y7 | Manual checks from `USER-CHECKLIST.md` section B for the Swift app (12-step quit/relaunch with `lta.mode=on`, Providers and Model routing, chat cap chip). | Gates turning `lta.mode` on by default. |
| Y8 | Optional: install the nightly push job (`scripts/nightly-push.sh --help` lists the three commands). Until then I push only when you say. | |
| Y9 | Stale processes: if the Swift app or any server holds port 3456 or 3457, quit it from the app (I never kill processes). | The Tauri app adopts a 3456 core as "unverified". |

**Decisions still open** (only the unanswered ones; each with my recommendation; answering "go with your recommendation" is enough):

- **Q-G1 to Q-G3 (Google):** bring-your-own client now; replace Gmail IMAP OAuth with the REST connector and revoke the old token; Drive metadata for everything and content only for ticked folders.
- **Q-I1 to Q-I3 (Issues core):** paste tokens once into Settings (write-only); Gantt write-back overlay only in v1; allow a bounded, rebuildable per-user issue cache in SQLite with purge on disconnect.
- **Command bus Q2 to Q6:** ship the interim Swift fixes (several already shipped); explorer read-only and note create native-only for the phone; delete the dead phone image field; design the headless always-on core but do not build it; allow up to 3 phones per user with one writer.
- **Mobile TLS Q1 to Q4:** ship TLS before the bus, one release of cleartext fallback, "Reset security identity" as the only rotation, keep `NSAllowsLocalNetworking` for one release.
- **Phase 5 questions:** 3D graph outside the macOS exit gate (2D inside, WebGL 3D right after); approve the one Swift addition for the Live capture helper; Windows/Linux order; when you will record real meetings.
- **Mermaid runtime** (bundled, isolated frame; Visual shows source until a pinned runtime is vendored), **DOCX route and host save dialog** (core `/generate-docx` plus a native Save As so the webview never gets a write path), **custom-task approval** (custom tasks stay desktop-approved; phone may only enqueue a saved custom task's id): I recommend yes to all three. I could not confirm in the plans whether you answered these; treat as open.
- **Relay D6** (host: VPS first behind a storage interface) is decided at the start of R2; **X1** (no password at the relay; account bound to the desktop's signing key) and **X2** (book the external review during R0) need your nod.
- Older: Q19 (notes without `platform`), Q16 (search latency at 50k notes), knowledge-kit Q1-Q14 (esp. Q6, Q9, Q12-Q13), ledger step B go/no-go, Tauri feature-off mechanism.

## 4. Next (ordered)

1. **Issues and Gantt core** [me]: IC0 (needs Q-I answers) then IC1-IC6 in the order given in `plans/2026-10-31-issues-gantt-core-plan.md`; then the Issues and Gantt screens.
2. **DOCX and secret-scan routes** [me]: the core routes Doc Gen's export and scan need (parity "blocked-by" items).
3. **Google slices G5-G7** [me] (routes and sync state, Library screen and setup guide, scheduled sync); then optional MCP adapter G8 only if Workspace MCP leaves preview.
4. **Live capture macOS helper** [me]: after Phase 7 spike 1; the one allowed Swift addition.
5. **Loop and Auto Tasks core slices** [me, after Y5 evidence]: six job kinds replace the 13 Auto Tasks (`review`, `sources.update`, `issues.from_notes`, `issues.implement`, `loop.run`, `custom.run`).
6. **Command bus S2, S4, S5** [me]: S2 interim phone fixes and flags, S4 phone client on the job API, S5 remaining kinds; S6 later.
7. **Mobile TLS with SPKI pinning** [me]: design done; build, then your on-device test (Y2).
8. **Relay R0-R9** [me]: R0 spec freeze and external review booking (G-EXT), then gated phases; no relay code before R0 and the review gate.
9. **Phase 7 spikes** [me]: the 13 research spikes (P7.pre) and an independent re-review before any desktop-control code.
10. **K1 and K2 kits** [me]: knowledge-kit K1 (needs Q answers), docs-kit K2-K4, other kits in plan order.
11. **Bench-gated token work** [me, after Y4]: X1 lean SDK configuration, X2 token-affecting SDK adoption, X3 ended-chat continuation. Each ships OFF, then flips in its own reviewed commit on measured deltas (gate: +15% tokens, +30% time, +20% hops).
12. Smaller: ledger step B (your go), router polish (graph-kit repo and pin bump), Phase 3 GUI-verification fixes from Y1 first, before new screens.

## 5. Later

- **Windows and Linux** builds, runs and parity (CI exists, not yet seen green on GitHub; WebKitGTK graph check not done).
- **Tauri signing, notarisation, Authenticode, signed updater** and the update channel.
- **Relay deployment** and external review; **phone PWA** (built last, in sync-kit; Q-WEB-1 answered, hosting later).
- Meetings: live-then-archive Phase 5 Mac side, 7-day shadow soak, read-path switch, legacy duplicate-row deletion. All wait for you to record meetings.
- Swift retirement (per-kit K4) only after one release with both apps and a parity checklist.

## 6. Loose ends and known gaps

- **GUI is unverified everywhere** in the Tauri app and on Windows and Linux; unit tests, fixtures and contract gates are green, which is not the same thing.
- **Parity checklist "blocked-by" items** (top ten in `plans/2026-10-31-tauri-parity-checklist.md`) include DOCX export, Mermaid runtime, 3D graph, Live capture, Issues/Gantt, Loop/Auto Tasks screens, signing, and the route gaps they need; read the file for the current list.
- **Flaky-test hygiene**: tests that fail only under full-gate load (`index-routes.http` body test, `loop-contract-lab` probes, `ExplorerTreeStoreWatchTests`) are hardened, not re-run; a clock-shift detector and a no-time-bomb rule now guard against date-dependent tests.
- **graph-kit**: the working tree shows a modified submodule pointer. Moving the pin needs `make graphkit-bump`, which **pushes graph-kit**; needs your go. The graph-kit `theme.css` light `textMuted` contrast fix (WCAG AA, `2449d41b`) is on the llm-ide side only; check the graph-kit copy when you bump.
- **Sparkle**: first signed update through the real feed has never been run.
- Pin the extension origin (CORS accepts every `chrome-extension://*`, Q22); quit delay on macOS logout (Q21); `llmide://` from Chrome (Q11).
- Real-corpus checks fixtures cannot give: platform-less notes, hidden-note semantics, iCloud placeholders.
- Two Macs on one account can flap note-index keys (detected, not prevented).
- Plugin sub-agent tools stay unavailable until X2.
- Google rules (CASA for local apps, 7-day expiry, scope tiers) come from third-party summaries; verify in your own Cloud console.
- Spec pages for API 100 and 101 are current; the spec index may lag the API 102 line; `make docs-check` is the guard.
- The relay and Phase 7 per-OS statements not covered by the Phase 0 probe are general knowledge, not verified against vendor docs or a run.

## 7. Quality gates that never get skipped

- **Independent review** (a different model, no sub-agents) for data-, money- and security-touching code; **independent review is mandatory for anything security-touching**, including host commands, the bus, trust, approval and any new connector.
- **Failing test first** for every bug fix and every security fix; hostile-input fixtures for every parser.
- `make regression` (full gate) before every push; contract gates; feature-boundary gate; markdownlint and `make docs-check`; `node scripts/plan-status.mjs --check`.
- **CI check after every push** (`gh run list`), and a red run is fixed before new work.
- Old-format fixtures for every migration (N-1 readable, rollback tested); real-data checks before any destructive switch; nothing deleted without a verified copy.
- Token-affecting changes only after a bench A/B; defaults flip in their own reviewed commit.
- Never `--no-verify`; never push without your word; no agent kills your processes.
