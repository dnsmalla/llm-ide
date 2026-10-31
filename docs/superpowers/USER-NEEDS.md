# User needs: everything only you can do or decide

Created 2026-10-31 by reviewing [MASTER-PLAN](MASTER-PLAN.md) (every `(you)` and `(wait)` line), [ROADMAP](ROADMAP.md) "Waiting on you", [USER-CHECKLIST](USER-CHECKLIST.md), [desktop/RUN-ON-MAC.md](../../desktop/RUN-ON-MAC.md), [docs/mobile/verification.md](../mobile/verification.md), the open-question sections of every plan in `plans/`, the kit maps in `docs/kits/`, and the decisions you recorded in conversation.

Open count: 59 open, 26 done, 85 total

## How to use this file

- This is the one index of needs that are yours, not the agents'. Procedures stay in their own docs; each item links to the exact section instead of copying it.
- Each item: id (`UN-nnn`), one line of what, **Why you** (why an agent cannot do it), **How** (command, steps or link), **Effort** (minutes), **Blocks** (what waits on it), **Status**.
- Tick a box (`- [x]`) when you finish an item. Agents never tick a user item without evidence. When you report a result ("step 4 failed", "all fine"), the agent records it in **Status** and ticks.
- Section A is ordered by value: do the top items first. Section B holds only questions you have not answered; answering "go with your recommendation" is enough. Section C holds answers an agent chose for you under your "do the best, secure" delegation; they are ticked, and any can be reopened by saying so.
- The `Open count` line above is maintained by `node scripts/user-needs.mjs --fix`; `--check` (part of `make docs-check`) fails when it drifts. `node scripts/user-needs.mjs` prints open and done per section.
- Mark changes by date in **Status** so the history stays readable.

## A. Do now (only you can run or look at these)

- [ ] **UN-001** First run of the Tauri desktop app on your Mac.
  - Why you: needs your Mac, a real login and eyes on the screen; no screen has ever been seen in the real app, so every "built" row depends on it.
  - How: `scripts/build-desktop-mac.sh`, open the app, then follow [RUN-ON-MAC.md, First-run checklist](../../desktop/RUN-ON-MAC.md#first-run-checklist) (sign up on the local core, scratch project, Chat, approvals, Trust banner, Explorer, Search, terminal, Source Control, Library, Settings, Extensions, Code Graph, Doc Gen). Report differences with the bug template at the end of that file.
  - Effort: 45 minutes. Blocks: the parity checklist, Phase 3 exit, every Tauri "built, not GUI-verified" row. Status: not run.
- [ ] **UN-002** iPhone device tests: Phone access, tiers and approvals.
  - Why you: needs a real iPhone on the same network as the Mac.
  - How: [verification.md, rows F1 to F18](../mobile/verification.md) (F4 to F7c approval dialogs, F7b custom tasks absent on the phone, F9 template edit refused, F17 lock, kill, revoke, reconnect). Also check that the phone sees archived chats and notes only through the Mac, and background and reconnect behaviour. Record pass or fail per row in that file.
  - Effort: 40 minutes (F18 big-chat run: +20). Blocks: closing the mobile verification rows, the iOS rebuild for F7b. Status: written, no recorded run.
- [ ] **UN-003** Print your Auto Task usage counts.
  - Why you: reads your real database; agents must not read it.
  - How: `node scripts/auto-task-usage.mjs --db "$HOME/Library/Application Support/llm-ide/system/data.db"` and tell the agent the counts. Read-only.
  - Effort: 2 minutes. Blocks: UN-032 (which Auto Tasks are cut or merged). Status: not run.
- [ ] **UN-004** Swift app manual checks (about 30 minutes).
  - Why you: needs the real Mac app and your providers.
  - How: [USER-CHECKLIST section B](USER-CHECKLIST.md#b-manual-app-checks-about-30-minutes): basics, Providers, DeepSeek chat, chat cap chip, Plugin/MCP/LLM-source screens (this also covers the Extensions screen real-app check), the 12-step quit-and-relaunch with `lta.mode` on, and the extension "Mac app not running" state. Safe mode: `defaults write com.llmide.macapp lta.mode shadow`.
  - Effort: 30 minutes. Blocks: turning live-then-archive `lta.mode` on by default, closing Mac K1 work, the Extensions screen check. Status: not run.
- [ ] **UN-005** Gmail with an app password (the easy way).
  - Why you: your Google account and a password only you can create.
  - How: Google Account > Security > 2-Step Verification on > App passwords > create one for "LLM-IDE". In the desktop app: Library > Connectors > Gmail > Easy setup, paste the address and the app password (write-only, stored in the vault). Forward-only: new mail lands as notes.
  - Effort: 10 minutes. Blocks: the real-account test of the Gmail path. Status: not run.
- [ ] **UN-006** Google Calendar through its secret iCal address.
  - Why you: the address is a secret in your calendar settings; no agent may see it.
  - How: Google Calendar on the web > Settings > your calendar > Integrate calendar > "Secret address in iCal format"; copy it; in the desktop app Library > Connectors > Calendar > paste it (write-only; the app never shows it again). Spec: [calendar-ical.md](../spec/calendar-ical.md). Known gap: the Tauri Calendar card is still coded for one feed until it is adapted to the multi-feed routes.
  - Effort: 5 minutes. Blocks: the real-feed test of the iCal connector. Status: not run.
- [ ] **UN-007** Google Drive through Drive for desktop (a local folder).
  - Why you: your Google login and your choice of which folders to sync.
  - How: install Drive for desktop, sign in, choose the folders to mirror, then add that folder as a Library source ("Easy setup" card, Drive). No API, no Cloud project.
  - Effort: 10 minutes. Blocks: the Drive-as-folder real run. Status: not run.
- [ ] **UN-008** Mac autobench with the window frontmost.
  - Why you: a hidden or agent-run window changes the numbers (Phase 3 exit condition).
  - How: run the autobench from [RUN-ON-MAC.md](../../desktop/RUN-ON-MAC.md) and [the Phase 0 report](plans/2026-10-25-tauri-phase0-report.md) with the app window frontmost for the whole run; send the result file. Confirms the 30-second hidden phase.
  - Effort: 10 minutes. Blocks: Phase 3 exit, the ADR 0018 condition. Status: not run.
- [ ] **UN-009** One Windows autobench run.
  - Why you: needs a Windows machine; ADR 0018 pauses the work if it fails, so earlier is cheaper.
  - How: build and run the desktop app on Windows; record graph frame rate (need at least 30 fps), sidecar start and quit, installer size. Steps in [the Phase 3 plan](plans/2026-10-31-tauri-phase3-plan.md) and the Phase 0 report.
  - Effort: 60 minutes. Blocks: Phase 3 exit, any Windows work. Status: not run.
- [ ] **UN-010** Grant Accessibility to measure caption read cadence.
  - Why you: a macOS permission dialog only you can approve.
  - How: System Settings > Privacy & Security > Accessibility > allow the app, then run the cadence measurement in the Phase 0 report. Optional: a Swift cold-start comparison.
  - Effort: 5 minutes. Blocks: Phase 3 exit measurement. Status: not run.
- [ ] **UN-011** Token bench go-ahead, plumbing and cheap sanity run.
  - Why you: runs count against your plan limits and need your `claude` login.
  - How: [USER-CHECKLIST A steps 1 and 2](USER-CHECKLIST.md#a-bench-plan-token-affecting-changes-are-off-until-you-decide): `make token-bench-fake` (free), then `node scripts/token-bench.mjs --only greeting,repo-search,auto-mode --repeat 1`. Tell the agent "go" when the numbers look plausible.
  - Effort: 15 minutes. Blocks: every token-affecting change (X1 lean config, X2 SDK adoption, router defaults, X3), all shipped OFF until then. Status: not run.
- [ ] **UN-012** Token bench baselines.
  - Why you: one real run per model on your account; commit deliberately.
  - How: [USER-CHECKLIST A step 3](USER-CHECKLIST.md#a-bench-plan-token-affecting-changes-are-off-until-you-decide) (fast model, then Sonnet-class). Measure the first run's cost before relying on the estimate.
  - Effort: 60 minutes. Blocks: UN-013, UN-014, P17 token baseline. Status: not run.
- [ ] **UN-013** Token bench noise check.
  - Why you: same account and plan limits.
  - How: USER-CHECKLIST A step 4 (`--repeat 5 --out a.json`, again `--out b.json`, then `--compare`). Expect `no-result` or `flat`.
  - Effort: 40 minutes. Blocks: UN-014. Status: not run.
- [ ] **UN-014** Token bench A/B per switch, router scenarios.
  - Why you: same account; keep a change only if it beats the noise inside the +15% tokens, +30% time, +20% hops gate.
  - How: USER-CHECKLIST A steps 5 and 6; send the `--compare` output or JSON paths.
  - Effort: 30 minutes per switch. Blocks: turning each switch on by default. Status: not run.
- [ ] **UN-015** Second-model bench so a model upgrade is a measured change.
  - Why you: another account or key and your spending choice.
  - How: after UN-012, repeat step 3 with another model id from `schema/models/anthropic-models.json`.
  - Effort: 60 minutes. Blocks: nothing urgent. Status: not run.
- [ ] **UN-016** Manual real-meeting checklist for the Chrome extension.
  - Why you: a real Meet, Teams or Zoom call with captions on.
  - How: the Testing Checklist in [extension/CLAUDE.md](../../extension/CLAUDE.md), before any caption or LLM change merges.
  - Effort: 30 minutes. Blocks: any caption or transcript merge. Status: not run.
- [ ] **UN-017** Optional: create your own Google Cloud OAuth client.
  - Why you: your Google account and a Cloud project; only needed if you want OAuth-based Gmail, Calendar or Drive instead of the easy setups above.
  - How: [Google plan section 7](plans/2026-10-31-google-connectors-plan.md): create a project, enable the Gmail, Calendar and Drive APIs, consent screen in Testing with your accounts as test users, OAuth client of type Desktop app, paste the id and secret into the write-only Advanced field. Expect 7-day refresh-token expiry while in Testing (unverified, check at setup).
  - Effort: 30 minutes. Blocks: any live OAuth Google run (fixtures only until then). Status: not started; optional.
- [ ] **UN-018** Optional: install the nightly push job.
  - Why you: it pushes to your remote; until installed, agents push only when you say.
  - How: `scripts/nightly-push.sh --help` lists the three commands.
  - Effort: 5 minutes. Blocks: nothing. Status: not installed.
- [ ] **UN-019** Clean up stale processes before starting the apps, if any remain.
  - Why you: agents never kill processes.
  - How: list with `ps -axo pid,etime,command | grep -E 'server.mjs|node --test|swift-test' | grep -v grep`; port holders with `lsof -nP -iTCP:3456 -sTCP:LISTEN` and `lsof -nP -iTCP:3457 -sTCP:LISTEN`; then `kill <pid>` for ones you recognise. Do not kill the backend while the Swift app is in use. Details: [test-hangs.md](../how-to/test-hangs.md#stale-leftover-processes). You already did one clean-up (section E); re-check before UN-001 because the Tauri app adopts a 3456 core as "unverified".
  - Effort: 5 minutes. Blocks: a clean UN-001 and UN-004. Status: re-check before the first run.
- [ ] **UN-020** After each push, check CI.
  - Why you: your remote; agents are told not to push.
  - How: `gh run list --limit 5`.
  - Effort: 2 minutes per push. Blocks: knowing a push is green. Status: standing habit.

## B. Decisions still open (unanswered only)

Each has a recommendation and what waiting costs. Reply "go with your recommendation" to take it. Questions you answered in conversation are in section E, and anything decided by the "do the best, secure" delegation is in section C.

- [ ] **UN-030** Google Q-G2 and Q-G3: replace Gmail IMAP OAuth (`mail.google.com`) with the REST read-only connector and revoke the old token; Drive metadata for everything and content only for ticked folders.
  - Source: [Google plan section 12](plans/2026-10-31-google-connectors-plan.md). Recommended: yes to both. If you wait: Gmail keeps the broad scope and Drive OAuth stays unfinished. Blocks: G5 to G7. (Q-G1 is answered, see E.)
- [ ] **UN-031** Issues core Q-I1 to Q-I3: paste GitHub and GitLab tokens once into Settings (write-only), with `gh` and `glab` import as a convenience; Gantt writes only our overlay in v1; allow a bounded, rebuildable per-user issue cache in SQLite, purged on disconnect.
  - Source: [Issues and Gantt plan section 13](plans/2026-10-31-issues-gantt-core-plan.md). Recommended: (a) with (b), overlay only, yes. If you wait: IC0 cannot start, so the Issues and Gantt screens wait.
- [ ] **UN-032** Auto Tasks T1 to T6: remove generateKnowledge, generateDoc, updatePlanStatus after UN-003 shows zero runs; fold the five merges with an alias table; template save, config set and toggle desktop-only; phone starts implement or ship only through desktop approval; `--yolo` not the default for codex and gemini; write tasks on a bare API key only if you need it.
  - Source: [Auto Tasks audit section 8](plans/2026-10-31-auto-tasks-audit.md). Recommended: the answers in the table; confirm T6 (do you need API-key-only write tasks, or is login enough). If you wait: the Node port keeps all 13 tasks. Depends on UN-003.
- [ ] **UN-033** Command bus Q2 to Q6: interim Swift fixes (several shipped); explorer read-only and note create native-only for the phone; delete the dead phone image field; design the headless always-on core but do not build it; allow up to 3 phones per user with one writer.
  - Source: [command bus spec section 11](plans/2026-10-31-command-bus-spec.md). Recommended: yes to all. If you wait: S2 and S6 scope stays fuzzy.
- [ ] **UN-034** Mobile TLS Q1 to Q4: ship TLS before the bus; one release of cleartext fallback; "Reset security identity" as the only rotation; keep `NSAllowsLocalNetworking` for one release.
  - Source: [TLS design section 10](plans/2026-10-31-mobile-tls-pinning-design.md). Recommended: yes to all. If you wait: the cleartext link and open ATS stay.
- [ ] **UN-035** Phase 5 macOS plan: 3D graph outside the macOS exit gate (2D inside, WebGL 3D right after); approve the one Swift addition for the Live capture helper; Windows then Linux order.
  - Source: [Phase 5 plan section 15 items 1 and 2](plans/2026-10-31-tauri-phase5-macos-plan.md). Recommended: yes to all three. If you wait: Live capture and 3D graph work cannot be scheduled.
- [ ] **UN-036** Phase 3 plan: desktop chat store (same file format, use the Mac app's `sessions/` in place with a lock file on macOS); confirm the Swift feature freeze and its exceptions; run the Windows measurement in week 1 of Phase 3 (see UN-009); a deferred row for Source Control hosted actions.
  - Source: [Phase 3 plan section 12](plans/2026-10-31-tauri-phase3-plan.md). Recommended: yes to all. If you wait: the freeze stays "inferred" and the chat store is undecided.
- [ ] **UN-037** Phase 7 desktop control Q3, Q5, Q8, Q9: terminals and shell apps denied in the first release; grant lifetimes 15 minutes default, 4 hours maximum, 5 minutes idle; offer the sign-in handoff `ask_user`; review the shared clause together with the relay and the driver separately.
  - Source: [Phase 7 design section 12.2](plans/2026-10-31-phase7-desktop-control-design.md). Recommended: yes to all. If you wait: nothing is built before the spike; the defaults stay provisional.
- [ ] **UN-038** Relay X1 and X2: no password at the relay (account bound to the desktop's signing key; say so if you want an extra login factor), and book the external security review during R0.
  - Source: [relay design section 13](plans/2026-10-31-relay-design.md). Recommended: yes to both. If you wait: R0 cannot freeze its spec.
- [ ] **UN-039** Relay D6: hosting (small VPS first behind a storage interface, in your preferred region, hardware-key MFA, PWA host as a separate account) versus Cloudflare Workers and R2; plus a company domain and a named account owner.
  - Source: [relay design section 8](plans/2026-10-31-relay-design.md). Decide at the start of R2. Recommended: VPS first. If you wait: nothing until R2.
- [ ] **UN-040** Knowledge-kit open questions: Q2 (agent search of meetings by default), Q5 (retire or fill entities), Q6 (keep ReviewConflicts a section), Q7, Q9 (kit boundaries), Q10, Q11 (notes in a cloud-sync folder), Q12 (N-1 window), Q13 (keyless kit), Q14 (single user). Q1, Q3, Q4, Q8 are answered.
  - Source: [knowledge-kit section 7](../kits/knowledge-kit.md). Recommended: the Leaning column. If you wait: K1 stays unstarted.
- [ ] **UN-041** Q19 (notes without `platform` are invisible in Library) and Q16 (search latency at 50k notes).
  - Source: MASTER-PLAN line "Decisions Q19, Q16". Recommended: show platform-less notes under "Other"; test at 50k notes before deciding. Needs a real-corpus look (UN-004 helps).
- [ ] **UN-042** Ledger step B go or no-go: move budget readers to `usage_calls` after 7 days of zero mismatches, fail closed.
  - Source: MASTER-PLAN X5. Recommended: go once the daily compare shows 7 clean days. If you wait: two sources of truth stay.
- [ ] **UN-043** Tauri feature-off mechanism: build-time tree-shake plus runtime `/health features`.
  - Source: kit plan "Gates added". Recommended: yes, both.
- [ ] **UN-044** Pin the Chrome extension origin instead of accepting every `chrome-extension://*` (ROADMAP Q22).
  - Why you: needs the extension id from your Chrome install. How: open `chrome://extensions`, copy the id, tell the agent. Effort: 2 minutes. Recommended: yes; do it once the id is stable.
- [ ] **UN-045** Flag-off `no-ack` capture retention (up to 50 captures) until the ack protocol is on by default.
  - Source: [extension storage audit](plans/2026-10-31-extension-storage-audit.md). Recommended: accept for now, turn the ack default on after the real-meeting check (UN-016).
- [ ] **UN-046** Status audit decisions: write the missing connector-catalog spec and schedule catalog phase 3 and a real Miro run; close the 51 private-wrapper decode-lab skips before more Mac routes switch.
  - Source: [status audit](plans/2026-10-31-status-audit.md). Recommended: yes to both, in that order.
- [ ] **UN-047** Automation-kit A5 and capture-kit C2: may a repair outside a loop's scope be approved from the phone (recommended: Mac only), and retire `/extract-entities` after UN-040 Q5.
  - Source: [automation-kit section 7](../kits/automation-kit.md), [capture-kit section 7](../kits/capture-kit.md).
- [ ] **UN-048** Docs-kit open items 10 and 11: comment drift fix and whether other kits may name docs-kit data types.
  - Source: [docs-kit section 7](../kits/docs-kit.md). Recommended: data types yes, seams for services.
- [ ] **UN-049** Remaining numbered kit decisions in the ui-kit, work-kit, workspace-kit, os-kit and agent-kit maps that no one has answered.
  - Source: the "Decisions needed" and "Open questions" sections of each kit map in `docs/kits/` (ui-kit U1 to U6 are delegated and provisional, see C). Recommended: go through each file once, answer in one message. Effort: 20 minutes.
- [ ] **UN-050** Swift feature freeze: define the trigger and scope (status audit item d); the inferred freeze is in force until you confirm.
  - Source: Phase 3 plan section 10. Recommended: confirm as inferred.
- [ ] **UN-051** Company API key with per-user caps replaces any shared personal subscription (ADR 0018 decision 5).
  - Why you: your money and your account. Recommended: yes before any team use.
- [ ] **UN-052** Real-corpus checks: platform-less note count, hidden-note semantics, iCloud placeholders (ROADMAP Loose ends).
  - Why you: reads your real notes, which agents must not. How: run the count commands the ROADMAP Loose ends list gives and report numbers only. Effort: 15 minutes.

## C. Delegated decisions (revisit if wrong)

You said "do the best, secure, usable for big projects" and agents decided. Each is ticked; reopen any by saying so.

- [x] **UN-060** Relay design D1 to D5, D7 to D9: tiered clients (PWA read-only plus low-risk queue), fixed read-only ceiling for remote turns, no recovery code in v1, printed revoke code, fixed-schedule heartbeat with 72-hour IP retention, upload-only extension scope, per-user sharing, external review before public exposure. DELEGATED: revisit if wrong. Source: [relay design](plans/2026-10-31-relay-design.md) section 13.
- [x] **UN-061** No third-party analytics in the relay or PWA. DELEGATED: revisit if wrong.
- [x] **UN-062** Sync-kit S1 to S6: keep the native iOS app permanently; freeze new phone surfaces while the relay is unbuilt; extension keeps local-core mode; relay carries a read-and-request subset first; delete PIN pairing at R9; each user enrolls their own devices. DELEGATED: revisit if wrong. Source: [sync-kit section 7](../kits/sync-kit.md).
- [x] **UN-063** ui-kit U1 to U6 (provisional): `tokens.json` the only token source, per-surface generated CSS, component kit at `ui/kit/` at K3, pixel-tolerance parity, graph-kit keeps its own theme with a conformance check, per-platform icons. DELEGATED: revisit if wrong.
- [x] **UN-064** Phase 7 provisional defaults D1 to D10 (one trusted Rust process, local-presence proof, no communicating apps, tree-only to cloud models, audit deletion by approval, optional browser tier deferred, stop-only from native iOS, first-party mount, global budgets, accept OS capture picker). DELEGATED: revisit if wrong. Source: [Phase 7 design section 12.1](plans/2026-10-31-phase7-desktop-control-design.md).
- [x] **UN-065** Issues provider tokens move into the core vault with a one-way Keychain migration (W2). DELEGATED: revisit if wrong.
- [x] **UN-066** Mac Auto Tasks move to the SDK engine for Claude, with multi-engine (codex, gemini, others) kept first-class. DELEGATED (also answered by you 2026-10-31): revisit if wrong.
- [x] **UN-067** Google connectors: bring your own client now, no hosted client until Google confirms the verification cost. DELEGATED: revisit if wrong.
- [x] **UN-068** Mac Swift app stays in maintenance after the Tauri release; phone works through the Mac until the relay (Phase 5 question 6). DELEGATED: revisit if wrong.

## D. Later needs (not now; each has a trigger)

- [ ] **UN-070** Windows and Linux full passes (build, signing, packaging, manual check). Trigger: the macOS Tauri app reaches parity and daily use. Effort: a day per OS.
- [ ] **UN-071** macOS signing and notarisation credentials: Apple Developer ID Application certificate (`.p12`), password, team id, notarisation credentials, a production bundle identifier and product name. Trigger: before the first public desktop release. How: [desktop-signing-decisions.md, What you must provide](../how-to/desktop-signing-decisions.md#what-you-must-provide); add as repository secrets.
- [ ] **UN-072** Windows signing choice (Azure Trusted Signing or an EV certificate) and Linux formats (deb, AppImage). Trigger: when Windows or Linux builds are due. How: same doc, decisions 2 and 3.
- [ ] **UN-073** Updater key pair and where update manifests are hosted. Trigger: first signed release. How: same doc, decision 4.
- [ ] **UN-074** Google verification path for one-click sign-in (cost unknown; Google may require an annual third-party security assessment for restricted Gmail and Drive scopes). Trigger: a stranger must connect Gmail with one click. Effort: a business decision plus weeks.
- [ ] **UN-075** Relay hosting, accounts, domain and the independent external security review of the relay spec and R1, R3, R4 code (gate G-EXT, required before any public exposure). Trigger: R2 start (hosting), spec freeze (review). See UN-038 and UN-039.
- [ ] **UN-076** Record real meetings so the live archive ack and meeting flows can be switched on; meetings are one feature and not a blocker today. Trigger: when you want meeting notes. Unblocks: M1, M2 (7-day shadow soak), M3, L1 legacy duplicate deletion.
- [ ] **UN-077** Headless always-on core decision (design only for now, see UN-033). Trigger: before command-bus S6.
- [ ] **UN-078** Push notifications for the phone. Trigger: after the relay exists.
- [ ] **UN-079** On-device TLS checks (ATS check, legacy cleartext path, packet capture). Trigger: when the TLS slice is built; list in [verification.md](../mobile/verification.md).
- [ ] **UN-080** App Store submission state check (`ios_app/APP_REVIEW_NOTES.md` exists; submission state unverified). Trigger: when you want the iPhone app released.
- [ ] **UN-081** Chrome Web Store listing, review and the publishing step in the extension release. Trigger: when the extension is meant for other people.
- [ ] **UN-082** Retire cleartext `:3006` and PIN pairing once the relay reaches parity. Trigger: relay parity (R9).
- [ ] **UN-083** Delete legacy duplicate rows (destructive: export, backup, rollback drill) and switch the Library read path to `note_index`. Trigger: 7 clean shadow days on real meeting notes (UN-076).
- [ ] **UN-084** Phase 6: one release with both apps, then the Swift app goes to maintenance. Trigger: Tauri macOS parity and daily use.
- [ ] **UN-085** Source Control hosted actions (PRs, issues) need a core route plan. Trigger: after the Issues core.

## E. Done by you (history and recorded answers)

- [x] **UN-090** Cleared the first launch of the Mac app. Status: done by you, before 2026-10-31.
- [x] **UN-091** Turned shadow mode on for live-then-archive (`lta.mode` shadow). Status: done by you.
- [x] **UN-092** Deleted old backups. Status: done by you.
- [x] **UN-093** Killed stale processes (agents never do this). Status: done by you; re-check is UN-019.
- [x] **UN-094** Accepted ADR 0018 for the Phase 3 start, conditional (2026-10-31).
- [x] **UN-095** Mermaid diagrams on demand: yes (a user-initiated, pinned, hash-verified download is fine).
- [x] **UN-096** DOCX export is optional; Markdown Save is the export for now.
- [x] **UN-097** Custom tasks on the phone: not needed (desktop-only).
- [x] **UN-098** macOS first and finished, then Windows and Linux.
- [x] **UN-099** Codex and Gemini stay first-class engines (multi-engine kept).
- [x] **UN-100** Google is for connectors only; choose the easiest setup (Gmail app password, secret iCal address, Drive for desktop); this also answers Google Q-G1 (bring your own client, no hosted client now).
- [x] **UN-101** Meetings are undefined and not a blocker: one feature among many, to be defined when you use it.
- [x] **UN-102** Delegation: "do the best, secure, usable for big projects" for the open design questions (see section C).
- [x] **UN-103** Web app scope: relay-served phone web view built last in sync-kit (Q-WEB-1 = A); phone through the Mac is enough for now (Q-WEB-3).
- [x] **UN-104** Token-affecting changes ship OFF until you run the bench and say go; paid or subscription bench runs happen after the end-to-end build (2026-10-30).
- [x] **UN-105** Professional quality over speed; no gate compressed to hit a date (2026-10-29).
- [x] **UN-106** Knowledge-kit Q1, Q3, Q4 and Q8 answered (2026-10-29): files are the truth, a rebuildable server index, no server copy of meetings.
